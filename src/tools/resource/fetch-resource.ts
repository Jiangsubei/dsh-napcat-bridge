/**
 * dsh-napcat-bridge: 抓取文件/资源工具 (fetch_chat_resource)
 */

import * as fs from 'node:fs';
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools';
import type {
  FetchChatResourceParams,
  FetchChatResourceResult,
  FetchResourceItem,
  FetchChatResourceItemResult,
  MessageRecord,
} from '../../types/index.js';
import { deserializeAttachments } from '../../attachment/store.js';
import { windowsPathToWsl } from '../file-source.js';
import { downloadPrivateFile } from '../private-file.js';
import { resolveGroupFileReference } from '../group-file-resolve.js';
import {
  type ToolExecutionContext,
  type ContextSource,
  getGlobalToolContext,
  resolveToolContext,
  normalizePeer,
} from '../common/context.js';
import { toLosslessJson } from '../../utils/lossless-json.js';

export type {
  FetchChatResourceParams,
  FetchChatResourceResult,
  FetchResourceItem,
  FetchChatResourceItemResult,
};

/**
 * 飞行中下载任务去重 Map：相同 file_id 在拉取期间共享同一个 Promise，
 * 彻底防止并发击穿、重复拉取与文件覆盖竞争。
 */
export const inFlightDownloads = new Map<string, Promise<FetchChatResourceItemResult>>();

/**
 * 内部单文件下载执行单元
 */
export async function fetchSingleChatResourceItem(
  item: FetchResourceItem,
  ctx: ToolExecutionContext
): Promise<FetchChatResourceItemResult> {
  const fileId = (item.file_id || '').trim();
  if (!fileId) {
    return { file_id: '', success: false, error: '缺少有效的 file_id' };
  }

  // 1. 飞行中去重 (Single-Flight)：已有相同 fileId 在下载中，直接复用 Promise
  const ongoing = inFlightDownloads.get(fileId);
  if (ongoing) {
    return ongoing;
  }

  const downloadPromise = (async (): Promise<FetchChatResourceItemResult> => {
    // 2. IS-F1: 上下文与数据库记录获取
    const sessionPeer = ctx.peer || '';
    const inGroupContext =
      (ctx.groupId !== undefined && ctx.groupId !== null && String(ctx.groupId).trim() !== '') ||
      sessionPeer.startsWith('group_') ||
      sessionPeer.startsWith('qq-group-');

    let dbRecord: MessageRecord | null = null;
    if (ctx.db) {
      try {
        dbRecord = ctx.db.getByFileId(fileId) ?? null;
      } catch {}
    }

    // 3. 一级静态去重: 查数据库
    if (dbRecord?.local_path && fs.existsSync(dbRecord.local_path)) {
      return {
        file_id: fileId,
        file_name: item.file_name,
        busid: item.busid,
        success: true,
        local_path: dbRecord.local_path,
      };
    }

    const hasBusid = item.busid !== undefined && item.busid !== null;
    const isSlashGroupFile = fileId.startsWith('/');
    const isGroupFileSystemFile = isSlashGroupFile || dbRecord?.type === 'group_file' || (inGroupContext && hasBusid);

    // 4. 群内聊天流富媒体/视频按需拉取（无 busid，且非斜杠路径的群文件系统文件）
    if (inGroupContext && !isGroupFileSystemFile) {
      if (!ctx.mediaManager) {
        return {
          file_id: fileId,
          file_name: item.file_name,
          busid: item.busid,
          success: false,
          error: '下载失败: 媒体存储服务不可用，无法落盘',
        };
      }

      const hasGroupId = ctx.groupId !== undefined && ctx.groupId !== null && String(ctx.groupId).trim() !== '';
      const sessionId = sessionPeer || (hasGroupId ? `group_${ctx.groupId}` : undefined);
      const saveOpts = {
        fileId,
        type: 'files' as const,
        filename: item.file_name,
        ...(sessionId ? { sessionId } : {}),
      };

      // 4.1 优先使用库中 attachments 提取的原始直链
      let directUrl: string | null = null;
      if (dbRecord?.attachments) {
        try {
          const descriptors = deserializeAttachments(dbRecord.attachments);
          const matched = descriptors.find((d) => d.remote?.fileId === fileId || d.kind === 'video');
          if (matched?.remote?.url && /^https?:\/\//i.test(matched.remote.url)) {
            directUrl = matched.remote.url;
          }
        } catch {}
      }

      if (directUrl) {
        try {
          const saved = await ctx.mediaManager.downloadAndSave(directUrl, saveOpts);
          if (saved?.localPath) {
            return {
              file_id: fileId,
              file_name: item.file_name,
              busid: item.busid,
              success: true,
              local_path: saved.localPath,
            };
          }
        } catch {}
      }

      // 4.2 直链不存在或已过期，回退调用 gateway.getFile(fileId) 动态刷新
      if (!ctx.gateway) {
        return {
          file_id: fileId,
          file_name: item.file_name,
          busid: item.busid,
          success: false,
          error: directUrl
            ? '直链下载失败且 NapCat/网关未连接，无法刷新下载直链'
            : '下载失败: NapCat 未连接 (gateway 不可用)，无法获取媒体资源',
        };
      }

      try {
        const res = await ctx.gateway.getFile(fileId);
        const info = [res?.wording, res?.message].filter(Boolean).join(' ');

        // SnowLuma 兼容垫片：检测到 image/voice cache 限制错误
        if (info && /image\/voice cache/i.test(info)) {
          return {
            file_id: fileId,
            file_name: item.file_name,
            busid: item.busid,
            success: false,
            error: `下载失败: 视频直链不存在或已过期，且当前协议端 (SnowLuma) 的 get_file 仅支持图片和语音缓存 (image/voice cache)，无法刷新历史视频直链 (file_id: ${fileId})`,
          };
        }

        const data = (res?.data || {}) as any;
        const refreshedUrl = typeof data.url === 'string' && /^https?:\/\//i.test(data.url) ? data.url.trim() : null;
        let localCandidate: string | null = null;
        if (typeof data.file === 'string' && data.file.trim() !== '') {
          localCandidate = data.file.trim();
        } else if (typeof data.url === 'string' && (data.url.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(data.url))) {
          localCandidate = data.url.trim();
        }

        if (refreshedUrl) {
          const saved = await ctx.mediaManager.downloadAndSave(refreshedUrl, {
            ...saveOpts,
            filename: item.file_name || data.file_name,
          });
          return {
            file_id: fileId,
            file_name: item.file_name || data.file_name,
            busid: item.busid,
            success: true,
            local_path: saved.localPath,
          };
        }

        if (localCandidate) {
          let wslPath: string | null = localCandidate;
          if (!localCandidate.startsWith('/')) {
            if (process.platform === 'win32' && fs.existsSync(localCandidate)) {
              wslPath = localCandidate;
            } else {
              wslPath = windowsPathToWsl(localCandidate);
            }
          }
          if (wslPath && fs.existsSync(wslPath)) {
            const saved = await ctx.mediaManager.downloadAndSave(wslPath, {
              ...saveOpts,
              filename: item.file_name || data.file_name,
            });
            return {
              file_id: fileId,
              file_name: item.file_name || data.file_name,
              busid: item.busid,
              success: true,
              local_path: saved.localPath,
            };
          }
        }

        return {
          file_id: fileId,
          file_name: item.file_name,
          busid: item.busid,
          success: false,
          error: `下载失败: get_file 未返回有效可用的下载直链或本地文件 (file_id: ${fileId})${info ? ` — 协议端: ${info}` : ''}`,
        };
      } catch (err: any) {
        return {
          file_id: fileId,
          file_name: item.file_name,
          busid: item.busid,
          success: false,
          error: `下载失败: 协议端 get_file 异常: ${err?.message || '未知错误'}`,
        };
      }
    }

    // 5. 群文件: get_group_file_url({groupid, fileid, busid}) → data.url → 真实落盘
    if (isGroupFileSystemFile) {
      if (item.busid === undefined || item.busid === null) {
        return {
          file_id: fileId,
          file_name: item.file_name,
          busid: item.busid,
          success: false,
          error: '下载群文件缺少 busid (需同时提供 file_id 与 busid)',
        };
      }
      if (!ctx.gateway) {
        return {
          file_id: fileId,
          file_name: item.file_name,
          busid: item.busid,
          success: false,
          error: `下载失败: NapCat 未连接 (gateway 不可用)，无法获取群文件下载地址 (file_id: ${fileId})`,
        };
      }
      if (!ctx.mediaManager) {
        return {
          file_id: fileId,
          file_name: item.file_name,
          busid: item.busid,
          success: false,
          error: '下载失败: 媒体存储服务不可用，无法落盘',
        };
      }
      if (!ctx.groupId) {
        return {
          file_id: fileId,
          file_name: item.file_name,
          busid: item.busid,
          success: false,
          error: `下载失败: 缺少群组上下文 (groupId)，无法定位群文件所属群聊 (file_id: ${fileId})`,
        };
      }
      try {
        let targetFileId = fileId;
        let targetBusid = item.busid;
        let res = await ctx.gateway.getGroupFileUrl(ctx.groupId, targetFileId, targetBusid);
        let fileUrl = res.data?.url;

        // SnowLuma 兼容垫片：仅当原始请求失败时解析一次可用 file_id。
        if (!fileUrl) {
          let resolved: Awaited<ReturnType<typeof resolveGroupFileReference>> = null;
          try {
            resolved = await resolveGroupFileReference({
              gateway: ctx.gateway,
              db: ctx.db,
              groupId: ctx.groupId,
              fileId,
              busid: item.busid,
              ...(item.file_name !== undefined ? { fileName: item.file_name } : {}),
            });
          } catch {}
          if (resolved && resolved.fileId !== targetFileId) {
            targetFileId = resolved.fileId;
            targetBusid = resolved.busid ?? targetBusid;
            res = await ctx.gateway.getGroupFileUrl(ctx.groupId, targetFileId, targetBusid);
            fileUrl = res.data?.url;
          }
        }

        if (!fileUrl) {
          const apiInfo = [res.wording, res.message].filter(Boolean).join(' ');
          return {
            file_id: fileId,
            file_name: item.file_name,
            busid: item.busid,
            success: false,
            error: `下载失败: NapCat 未返回群文件下载 URL (file_id: ${fileId})${apiInfo ? ` — NapCat: ${apiInfo}` : ''}`,
          };
        }
        // IS-F2: 落盘带 sessionId=peer → files/<peer>/；peer 缺失时回退 group_<groupId>
        const hasGroupId = ctx.groupId !== undefined && ctx.groupId !== null && String(ctx.groupId).trim() !== '';
        const sessionId = sessionPeer || (hasGroupId ? `group_${ctx.groupId}` : undefined);
        const saved = await ctx.mediaManager.downloadAndSave(fileUrl, {
          fileId,
          type: 'files',
          filename: item.file_name,
          ...(sessionId ? { sessionId } : {}),
        });
        return {
          file_id: fileId,
          file_name: item.file_name,
          busid: item.busid,
          success: true,
          local_path: saved.localPath,
        };
      } catch (err: any) {
        return {
          file_id: fileId,
          file_name: item.file_name,
          busid: item.busid,
          success: false,
          error: `下载群文件失败: ${err?.message || '未知错误'}`,
        };
      }
    }

    // 6. 非群文件（私聊 file_id 资源）
    if (!ctx.gateway) {
      return {
        file_id: fileId,
        file_name: item.file_name,
        busid: item.busid,
        success: false,
        error: '资源获取失败: NapCat 未连接，无法拉取远程资源',
      };
    }
    if (!ctx.mediaManager) {
      return {
        file_id: fileId,
        file_name: item.file_name,
        busid: item.busid,
        success: false,
        error: '下载失败: 媒体存储服务不可用，无法落盘',
      };
    }
    const dl = await downloadPrivateFile({
      fileId,
      peer: sessionPeer || undefined,
      busid: item.busid ?? null,
      filename: item.file_name,
      gateway: ctx.gateway,
      mediaManager: ctx.mediaManager,
    });
    if (dl.ok && dl.localPath) {
      return {
        file_id: fileId,
        file_name: item.file_name,
        busid: item.busid,
        success: true,
        local_path: dl.localPath,
      };
    }
    return {
      file_id: fileId,
      file_name: item.file_name,
      busid: item.busid,
      success: false,
      error: dl.error || '下载失败: 未知原因',
    };
  })();

  inFlightDownloads.set(fileId, downloadPromise);
  try {
    return await downloadPromise;
  } finally {
    inFlightDownloads.delete(fileId);
  }
}

export async function fetchChatResource(
  params: FetchChatResourceParams,
  context?: ToolExecutionContext
): Promise<FetchChatResourceResult> {
  const ctx = { ...getGlobalToolContext(), ...context };

  const hasFilesArray = Array.isArray(params?.files) && params.files.length > 0;
  const hasSingleFileId = typeof params?.file_id === 'string' && params.file_id.trim() !== '';

  if (!hasFilesArray && !hasSingleFileId) {
    return { success: false, error: '你需要指定 file_id 或 files 列表' };
  }

  // 1. 归一化输入列表
  const isSingleMode = !hasFilesArray && hasSingleFileId;
  const targetItems: FetchResourceItem[] = isSingleMode
    ? [{ file_id: params.file_id!.trim(), busid: params.busid, file_name: params.file_name }]
    : params.files!;

  // 2. 依次拉取 (受控调度，杜绝并发网络流控与内存风暴)
  const results: FetchChatResourceItemResult[] = [];
  for (const item of targetItems) {
    const itemRes = await fetchSingleChatResourceItem(item, ctx);
    results.push(itemRes);
  }

  const downloadedCount = results.filter((r) => r.success).length;
  const total = results.length;

  // 3. 结果组装与完全向后兼容
  if (isSingleMode) {
    const single = results[0];
    if (single.success) {
      return {
        success: true,
        local_path: single.local_path,
        total: 1,
        downloaded_count: 1,
        results,
      };
    }
    return {
      success: false,
      error: single.error || '下载失败',
      total: 1,
      downloaded_count: 0,
      results,
    };
  }

  // 批量模式：部分成功判定 (Partial Success)
  const isOverallSuccess = downloadedCount > 0;
  const firstSuccessPath = results.find((r) => r.success)?.local_path;

  return {
    success: isOverallSuccess,
    ...(firstSuccessPath ? { local_path: firstSuccessPath } : {}),
    ...(isOverallSuccess ? {} : { error: `批量下载失败: ${results.map((r) => r.error).filter(Boolean).join('; ')}` }),
    total,
    downloaded_count: downloadedCount,
    results,
  };
}

export function createFetchChatResourceTool(context?: ContextSource): ToolDefinition {
  return defineTool({
    name: 'fetch_chat_resource',
    description:
      '根据资源 file_id（群文件需附带 busid）将外部文件或富媒体拉取到本地磁盘。用于需要深入阅读、分析聊天中的文档、音视频或图片内容时；下载完成后返回本地物理路径（local_path），供后续文件或图片读取工具消费。如需深入阅读多个文件，请在单次调用中使用 files 参数批量传入，切勿在单轮内并发多次调用本工具。',
    parameters: {
      file_id: { type: 'string', description: '单个资源 ID (单文件模式填写)' },
      busid: { type: 'number', description: '群文件专用 busid (群文件必填)' },
      file_name: { type: 'string', description: '保存文件名建议' },
      files: {
        type: 'array',
        description: '批量拉取文件列表 (多文件模式一次性传入，包含 file_id、busid 与可选 file_name)',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            file_id: { type: 'string', required: true, description: '资源 ID' },
            busid: { type: 'number', description: '群文件专用 busid' },
            file_name: { type: 'string', description: '保存文件名建议' },
          },
        },
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => {
        const res = value as any;
        if (Array.isArray(res?.results) && res.results.length > 1) {
          const lines = [`批量下载结果 (${res.downloaded_count || 0}/${res.total || 0}):`];
          for (const item of res.results) {
            lines.push(
              item.success
                ? `  • ${item.file_name || item.file_id}: 就绪 (${item.local_path})`
                : `  • ${item.file_name || item.file_id}: 失败 (${item.error || '未知错误'})`
            );
          }
          return [{ type: 'text', text: lines.join('\n') }];
        }
        return [
          {
            type: 'text',
            text: res?.success
              ? `资源已就绪: ${res?.local_path}`
              : `资源抓取失败: ${res?.error || '未知原因'}`,
          },
        ];
      },
    },
    async execute(args, exec) {
      const session = (exec.agent as any)?.session;
      const rawPeer = session?.id || '';
      const peer = normalizePeer(rawPeer);
      const groupId =
        peer.startsWith('qq-group-') || peer.startsWith('group_')
          ? peer.replace(/^(qq-group-|group_)/, '').split('-')[0]
          : undefined;
      const resolved = resolveToolContext(context);
      const res = (await fetchChatResource(args, {
        ...resolved,
        db: resolved.db,
        gateway: resolved.gateway,
        mediaManager: resolved.mediaManager,
        sender: resolved.sender,
        peer,
        groupId,
      })) as any;
      if (res && res.success === false) {
        throw new Error(res.error || 'fetch_chat_resource 失败');
      }
      return toLosslessJson(res);
    },
  });
}
