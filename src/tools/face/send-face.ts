/**
 * dsh-napcat-bridge: 发送表情包工具 (send_face)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { SendFaceParams, SendFaceResult } from '../../types/index.js';
import { DEFAULT_FACE_STORE_DIR } from '../../constants/index.js';
import { resolveDshPath } from '../../utils/path.js';
import { buildOutboundFaceAttachment } from '../../attachment/outbound.js';
import {
  type ToolExecutionContext,
  type ContextSource,
  getGlobalToolContext,
  resolveToolContext,
  normalizePeer,
} from '../common/context.js';
import { toLosslessJson } from '../../utils/lossless-json.js';

export type { SendFaceParams, SendFaceResult };

/**
 * 6.10 发送表情包工具 (send_face)
 * 凭 face_id 构造带有 sub_type=1 的 image 消息段，并通过共享串行队列出站。
 */
export async function sendFace(
  params: SendFaceParams,
  context?: ToolExecutionContext
): Promise<SendFaceResult> {
  const ctx = { ...getGlobalToolContext(), ...context };
  if (!params || !params.face_id || typeof params.face_id !== 'string' || !params.face_id.trim()) {
    return { success: false, error: '缺少 face_id 参数' };
  }
  if (!ctx.db) {
    return { success: false, error: '数据库不可用' };
  }

  const faceId = params.face_id.trim();
  const face = ctx.db.getFaceById(faceId);
  if (!face) {
    return { success: false, error: `表情 ID "${faceId}" 不存在或已被删除` };
  }
  if (!face.enabled) {
    return { success: false, error: `表情 ID "${faceId}" 已禁用，不可发送` };
  }
  if (!ctx.gateway) {
    return { success: false, error: '网关未连接，无法发送表情' };
  }

  const rawPath = face.file_path;
  let localPath = path.isAbsolute(rawPath)
    ? rawPath
    : resolveDshPath(ctx.dshHome, rawPath, DEFAULT_FACE_STORE_DIR);

  // 物理文件存在性校验与自动自愈回退
  if (!fs.existsSync(localPath)) {
    const canonicalDir = resolveDshPath(ctx.dshHome, ctx.faceDir, DEFAULT_FACE_STORE_DIR);
    const canonicalPath = path.resolve(canonicalDir, `${face.md5}.${face.format}`);
    if (fs.existsSync(canonicalPath)) {
      localPath = canonicalPath;
      ctx.db.updateFaceFilePath(face.id, canonicalPath);
    } else {
      // 检查是否落入工作区或 profiles 目录
      const dshHome = ctx.dshHome || process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '', '.dsh');
      const candidates = [
        path.resolve(process.cwd(), rawPath),
        path.join(dshHome, 'profiles', 'desktop', '.dsh', 'napcat', 'faces', `${face.md5}.${face.format}`),
        path.join(dshHome, 'profiles', 'desktop', rawPath),
      ];
      for (const cand of candidates) {
        if (cand && fs.existsSync(cand)) {
          try {
            fs.mkdirSync(canonicalDir, { recursive: true });
            fs.copyFileSync(cand, canonicalPath);
            localPath = canonicalPath;
            ctx.db.updateFaceFilePath(face.id, canonicalPath);
            break;
          } catch {}
        }
      }
    }
  }

  if (!fs.existsSync(localPath)) {
    return { success: false, error: `表情包本地文件不存在: ${localPath}` };
  }

  const sessionPeer = ctx.peer || '';
  const inGroup =
    (ctx.groupId !== undefined && ctx.groupId !== null && String(ctx.groupId).trim() !== '') ||
    sessionPeer.startsWith('group_') ||
    sessionPeer.startsWith('qq-group-');

  const normalizedPath = localPath.replace(/\\/g, '/');
  const fileUri = normalizedPath.startsWith('file:///')
    ? normalizedPath
    : `file:///${normalizedPath.replace(/^\/+/, '')}`;
  const subType = ctx.faceSubType ?? 1;

  const segments = [
    {
      type: 'image',
      data: {
        file: fileUri,
        sub_type: subType,
      },
    },
  ];
  const attachments = [buildOutboundFaceAttachment(face, localPath, subType)];

  const doSend = async (): Promise<SendFaceResult> => {
    try {
      let res: any;
      if (inGroup) {
        const groupId = String(ctx.groupId || sessionPeer.replace(/^(qq-group-|group_)/, '').split('-')[0]);
        res = await ctx.gateway!.sendGroupMsg(groupId, segments as any, attachments);
      } else {
        const userId = sessionPeer.replace(/^(qq-user-|user_)/, '').split('-')[0];
        res = await ctx.gateway!.sendPrivateMsg(userId, segments as any, attachments);
      }

      if (res && (res.status === 'failed' || (typeof res.retcode === 'number' && res.retcode !== 0))) {
        return {
          success: false,
          error: res.wording || res.message || `NapCat 发送表情失败 (retcode: ${res.retcode})`,
        };
      }

      // 发送成功后累加使用频次与刷新时间
      ctx.db!.recordFaceUsage(face.id);
      const messageId = res?.data?.message_id;
      const sendRes: SendFaceResult = {
        success: true,
      };
      if (typeof messageId === 'number') {
        sendRes.message_id = messageId;
      }
      return toLosslessJson(sendRes);
    } catch (err: any) {
      return toLosslessJson({
        success: false,
        error: `发送表情异常: ${err?.message || '未知错误'}`,
      });
    }
  };

  if (ctx.sender) {
    return ctx.sender.enqueue(sessionPeer || 'common', doSend);
  }
  return doSend();
}

export function createSendFaceTool(context?: ContextSource): ToolDefinition {
  return defineTool({
    name: 'send_face',
    description:
      '根据表情 ID 将一张本地表情包作为独立表情消息发送到聊天中。用于聊天中需要精准表达情绪、接梗斗图时；表情 ID 可直接从系统上下文中的本地表情库存清单中选取，亦可来自 list_faces 检索结果。业务图片产物请使用 send_file。',
    parameters: {
      face_id: {
        type: 'string',
        required: true,
        description: '要发送的目标表情 ID (必填，可直接从上下文表情库清单获取或通过 list_faces 检索)',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => {
        const v = value as any;
        return [
          {
            type: 'text',
            text: v?.success ? `已成功发送表情包 (message_id: ${v.message_id})` : `发送表情包失败: ${v?.error}`,
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
      const cfg = typeof (resolved as any).config === 'function'
        ? (resolved as any).config()
        : ((resolved as any).config || {});
      const res = await sendFace(args, {
        ...resolved,
        db: resolved.db,
        gateway: resolved.gateway,
        sender: resolved.sender,
        peer,
        groupId,
        dshHome: resolved.dshHome,
        faceDir: resolveDshPath(resolved.dshHome, cfg.face_store_dir, DEFAULT_FACE_STORE_DIR),
        faceSubType: cfg.face_sub_type,
      });
      return toLosslessJson(res) as any;
    },
  });
}
