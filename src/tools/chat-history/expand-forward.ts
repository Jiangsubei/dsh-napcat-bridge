/**
 * dsh-napcat-bridge: 展开合并转发工具 (expand_forward_message)
 */

import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools';
import type {
  ExpandForwardMessageParams,
  ExpandForwardMessageResult,
  ForwardNode,
} from '../../types/index.js';
import {
  type ToolExecutionContext,
  type ContextSource,
  getGlobalToolContext,
  resolveToolContext,
  normalizePeer,
} from '../common/context.js';
import { toLosslessJson } from '../../utils/lossless-json.js';

export type { ExpandForwardMessageParams, ExpandForwardMessageResult, ForwardNode };

/**
 * 单次展开允许下载的内层图片上限：转发记录可能含几十上百个节点，
 * 逐张下载会拖垮整次工具调用；超出上限的段保留原始 url 不阻断。
 */
const MAX_FORWARD_IMAGE_DOWNLOADS = 10;

/** 归一化节点 content 为 OneBot 消息段数组；非 JSON 数组形态（纯文本等）返回 null */
export function normalizeForwardSegments(content: unknown): any[] | null {
  if (Array.isArray(content)) return content;
  if (typeof content !== 'string') return null;
  const trimmed = content.trim();
  if (!trimmed.startsWith('[')) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** 仅接受可作为下载源的 http(s) url（QQ 上报的 data.file 常是伪后缀文件名，不可当下载源） */
export function isDirectMediaUrl(url: unknown): url is string {
  return typeof url === 'string' && /^https?:\/\//i.test(url);
}

/** 从 url 显式后缀推断扩展名（QQ 的 data.file 常被无脑命名为 MD5.jpg，只有 url 才可信） */
export function inferForwardUrlExt(url: string): string | undefined {
  const clean = url.split('?')[0].split('#')[0];
  const match = /\.([a-zA-Z0-9]+)$/.exec(clean);
  return match ? match[1].toLowerCase() : undefined;
}

/**
 * FC-1: 逐段尽力而为地把转发内层图片下载落盘。
 * 单张失败不阻断整次展开（失败的段保留原样，模型仍看得到 url），
 * 缺 mediaManager / url 非 http(s) / 超上限 一律跳过而非报错。
 */
async function materializeForwardImages(
  segments: any[],
  ctx: ToolExecutionContext
): Promise<{ downloaded: number; skipped: number; failed: number }> {
  let downloaded = 0;
  let skipped = 0;
  let failed = 0;

  for (const seg of segments) {
    if (!seg || seg.type !== 'image') continue;
    const data = seg.data && typeof seg.data === 'object' ? seg.data : null;
    if (!data || data.local_path) continue;

    if (!ctx.mediaManager || !isDirectMediaUrl(data.url) || downloaded >= MAX_FORWARD_IMAGE_DOWNLOADS) {
      skipped++;
      continue;
    }

    const url = data.url;
    const fileId = data.file || data.file_id || undefined;
    const isSticker = data.sub_type === 1 || Boolean(data.emoji_package_id);
    const urlExt = inferForwardUrlExt(url);
    try {
      const saved = await ctx.mediaManager.downloadAndSave(url, {
        type: isSticker ? 'sticker' : 'image',
        sessionId: ctx.peer || 'common',
        ...(fileId ? { fileId } : {}),
        ...(urlExt ? { ext: urlExt } : {}),
      });
      data.local_path = saved.localPath;
      downloaded++;
    } catch {
      failed++;
    }
  }

  return { downloaded, skipped, failed };
}

/**
 * 6.3 展开合并转发工具 (expand_forward_message)
 * 根据 forward_id 调 NapCat get_forward_msg 展开合并转发消息内容。
 */
export async function expandForwardMessage(
  params: ExpandForwardMessageParams,
  context?: ToolExecutionContext
): Promise<ExpandForwardMessageResult> {
  const ctx = { ...getGlobalToolContext(), ...context };

  if (!params || !params.forward_id || typeof params.forward_id !== 'string' || params.forward_id.trim() === '') {
    return { success: false, error: '你需要指定 forward_id' };
  }

  const forwardId = params.forward_id.trim();

  if (ctx.gateway) {
    try {
      const res = await ctx.gateway.getForwardMsg(forwardId);
      const rawMessages = Array.isArray(res.data?.messages)
        ? res.data.messages
        : Array.isArray(res.data)
        ? res.data
        : [];

      const messages: ForwardNode[] = [];
      let imagesDownloaded = 0;

      for (const msg of rawMessages) {
        const rawSegments = typeof msg.content === 'string' ? msg.content : msg.message;
        const rawContent =
          typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.message || '');
        const segments = normalizeForwardSegments(rawSegments);
        let content = rawContent;

        if (segments && segments.some((seg: any) => seg && seg.type === 'image')) {
          const media = await materializeForwardImages(segments, ctx);
          imagesDownloaded += media.downloaded;
          // 仅当确有图片落盘时回写段内容；无落盘则保持既有输出形态，避免无谓改动
          if (media.downloaded > 0) {
            content = JSON.stringify(segments);
          }
        }

        messages.push({
          sender_name: msg.sender?.nickname || msg.sender_name || '未知发送者',
          user_id: String(msg.sender?.user_id || msg.user_id || ''),
          time: (msg.time || 0) < 10000000000 ? (msg.time || 0) * 1000 : msg.time || 0,
          content,
        });
      }

      return {
        success: true,
        messages,
        ...(imagesDownloaded > 0 ? { images_downloaded: imagesDownloaded } : {}),
      };
    } catch (err: any) {
      return { success: false, error: `展开合并转发失败: ${err?.message || '未知错误'}` };
    }
  }

  return { success: false, error: '展开合并转发失败: NapCat 未连接 (gateway 不可用)，无法获取合并转发内容' };
}

export function createExpandForwardMessageTool(context?: ContextSource): ToolDefinition {
  return defineTool({
    name: 'expand_forward_message',
    description:
      '展开聊天记录合并转发（多条消息聚合卡片）的内部真实对话。用于会话中用户分享合并转发记录并要求查看、总结或评价其中内容时；返回层级消息列表，内层图片会自动缓存并附带本地路径。',
    parameters: {
      forward_id: { type: 'string', required: true, description: '合并转发 ID (必填)' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [
        {
          type: 'text',
          text: (value as any).success
            ? JSON.stringify((value as any).messages, null, 2)
            : `展开合并转发失败: ${(value as any).error}`,
        },
      ],
    },
    async execute(args, exec) {
      const session = (exec.agent as any)?.session;
      const peer = normalizePeer(session?.id || '');
      const resolved = resolveToolContext(context);
      const res = (await expandForwardMessage(args, {
        ...resolved,
        gateway: resolved.gateway,
        mediaManager: resolved.mediaManager,
        ...(peer ? { peer } : {}),
      })) as any;
      if (res && res.success === false) {
        throw new Error(res.error || 'expand_forward_message 失败');
      }
      return toLosslessJson(res);
    },
  });
}
