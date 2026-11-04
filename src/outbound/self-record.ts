/**
 * dsh-napcat-bridge: 出站消息自记录 (Outbound Self Record)
 *
 * 出站消息不依赖 NapCat 的 `reportSelfMessage` 上报：只要 OneBot 应答成功且返回
 * message_id，就立即把这条自身消息写入本地 messages 表（self = 1）。
 * 发送失败或无有效 message_id 时不落库，避免写入无法寻址的幽灵记录。
 */

import { fileURLToPath } from 'node:url';
import { parseNormalizedContent } from '../gateway/wakeup.js';
import type { MessageRecord } from '../types/index.js';
import type { OutboundSentEvent, NapCatGatewayServer } from '../gateway/server.js';

export interface SelfRecordDeps {
  db: {
    saveMessageIfNotExists(record: MessageRecord): boolean;
    updateMessageMedia?(msgId: number, patch: Record<string, any>): void;
  };
  botQQ: string;
  senderName: string;
  getFaceByMd5?: (md5: string) => any;
  logger?: {
    debug?: (...args: any[]) => void;
    warn?: (...args: any[]) => void;
  };
}

export interface BuildSelfRecordOptions {
  botQQ: string;
  senderName: string;
  getFaceByMd5?: (md5: string) => any;
}

export interface OutboundMediaMeta {
  file_id: string | null;
  busid: number | null;
  local_path: string | null;
}

/** 出站消息是否携带需要异步补全元数据的媒体段 */
export function hasOutboundMedia(segments: Array<Record<string, any>>): boolean {
  return segments.some((seg) =>
    ['image', 'file', 'record', 'video', 'forward'].includes(String(seg?.type || ''))
  );
}

/** 把 file:// URI 或本地绝对路径解析为可读的 OS 路径；URL/base64/相对路径返回 null。 */
export function resolveLocalMediaPath(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw) return null;

  if (raw.startsWith('file://')) {
    try {
      return fileURLToPath(raw);
    } catch {
      return null;
    }
  }
  if (/^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith('/')) {
    return raw;
  }
  return null;
}

/** 判断值是否像 OneBot 媒体标识（而非本地路径/URL/base64） */
function looksLikeMediaId(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const v = value.trim();
  if (!v) return false;
  if (/^(file:|https?:|data:|base64:)/i.test(v)) return false;
  if (/^[a-zA-Z]:[\\/]/.test(v) || v.startsWith('/')) return false;
  return true;
}

/**
 * 从出站消息段提取媒体元数据（payload 版本）：
 * - 图片/表情/语音/视频：OneBot 无独立 file_id，`data.file` 是 NapCat 侧文件标识时才采用；
 * - 文件：优先 `data.file_id`；
 * - local_path 只接受 file:// 或本地绝对路径，URL/base64 不落为本地路径。
 */
export function extractOutboundMediaMeta(
  segments: Array<Record<string, any>>
): OutboundMediaMeta {
  const meta: OutboundMediaMeta = { file_id: null, busid: null, local_path: null };

  for (const seg of segments) {
    const type = String(seg?.type || '');
    const data = (seg.data || {}) as any;

    if (type === 'image' || type === 'record' || type === 'video') {
      if (!meta.file_id) {
        meta.file_id = data.file_id || (looksLikeMediaId(data.file) ? data.file : null);
      }
      if (!meta.local_path) meta.local_path = resolveLocalMediaPath(data.local_path || data.file);
    } else if (type === 'file') {
      if (!meta.file_id) {
        meta.file_id = data.file_id || (looksLikeMediaId(data.file) ? data.file : null);
      }
      if (!meta.local_path) meta.local_path = resolveLocalMediaPath(data.local_path || data.file);
      if (meta.busid === null && data.busid !== undefined && data.busid !== null) {
        meta.busid = Number(data.busid);
      }
    } else if (type === 'forward') {
      if (!meta.file_id) meta.file_id = data.id || data.forward_id || null;
    }
  }

  for (const key of Object.keys(meta) as Array<keyof OutboundMediaMeta>) {
    if (meta[key] === undefined) meta[key] = null;
  }
  return meta;
}

/** 把出站 payload（纯文本或 OneBot 消息段数组）归一化为消息段数组。 */
export function normalizeOutboundSegments(message: unknown): Array<Record<string, any>> {
  if (typeof message === 'string') {
    return message.trim() !== '' ? [{ type: 'text', data: { text: message } }] : [];
  }
  if (Array.isArray(message)) {
    return message.filter(
      (seg): seg is Record<string, any> => Boolean(seg) && typeof seg === 'object'
    );
  }
  return [];
}

/**
 * 推导出站消息的 dominant type，与入站落库口径保持一致
 * （首个有意义的非文本段决定类型）。
 */
export function inferOutboundMessageType(
  segments: Array<Record<string, any>>,
  isGroup: boolean
): string {
  let type = 'text';

  for (const seg of segments) {
    const segType = seg.type;
    const data = (seg.data || {}) as any;

    if (segType === 'image') {
      const isSticker = data.sub_type === 1 || Boolean(data.emoji_package_id);
      if (type === 'text') type = isSticker ? 'sticker' : 'image';
    } else if (segType === 'file') {
      if (type === 'text') type = isGroup ? 'group_file' : 'file';
    } else if (
      segType === 'record' ||
      segType === 'video' ||
      segType === 'forward' ||
      segType === 'json' ||
      segType === 'xml' ||
      segType === 'reply' ||
      segType === 'at' ||
      segType === 'poke' ||
      segType === 'shake'
    ) {
      if (type === 'text') type = segType;
    }
  }

  return type;
}

/**
 * 由出站发送事件构造 self = 1 的消息记录。
 * 无有效内容时返回 null（不落库）。
 */
export function buildSelfMessageRecord(
  event: OutboundSentEvent,
  options: BuildSelfRecordOptions
): MessageRecord | null {
  const segments = normalizeOutboundSegments(event.message);
  if (segments.length === 0) return null;

  const isGroup = event.peer.startsWith('group_') || event.peer.startsWith('qq-group-');

  const parsed = parseNormalizedContent(
    { message: segments, message_type: isGroup ? 'group' : 'private' } as any,
    {
      getFaceByMd5: options.getFaceByMd5,
    }
  );

  if (!parsed.content || parsed.content.trim() === '') return null;

  const media = extractOutboundMediaMeta(segments);

  return {
    msg_id: event.msgId,
    peer: event.peer,
    user_id: options.botQQ,
    sender_name: options.senderName,
    time: event.time,
    type: inferOutboundMessageType(segments, isGroup),
    content: parsed.content,
    raw: JSON.stringify(segments),
    file_id: media.file_id,
    busid: media.busid,
    local_path: media.local_path,
    fingerprint: null,
    recalled: 0,
    self: 1,
    reply_to: parsed.replyId ?? null,
  };
}

/**
 * 出站发送成功后的落库入口。
 * 使用 saveMessageIfNotExists 保证与可能的 `message_sent` 上报幂等。
 */
export function recordOutboundSelfMessage(
  event: OutboundSentEvent,
  deps: SelfRecordDeps
): MessageRecord | null {
  const record = buildSelfMessageRecord(event, {
    botQQ: deps.botQQ,
    senderName: deps.senderName,
    getFaceByMd5: deps.getFaceByMd5,
  });

  if (!record) return null;

  try {
    const inserted = deps.db.saveMessageIfNotExists(record);
    if (inserted) {
      deps.logger?.debug?.(
        `[Plugin] 出站消息已落库 (peer: ${record.peer}, msg_id: ${record.msg_id})`
      );
    }
    return record;
  } catch (err) {
    deps.logger?.warn?.('[Plugin] 出站消息落库失败:', err);
    return null;
  }
}

/**
 * 异步回查 get_msg 补全出站媒体元数据（file_id / busid / raw）。
 *
 * 发送 Action 只返回 message_id，SnowLuma/NapCat 的 get_msg 会返回完整消息对象
 * （含图片/文件的 NapCat 侧标识与媒体信息）。本函数尽力而为：
 * - 仅对含媒体段的消息触发；
 * - 5s 超时，任何失败只记 debug，绝不覆盖 payload 版本已落库的 local_path；
 * - 只在拿到新值时更新，绝不把已有值清空。
 */
export async function enrichOutboundMediaRecord(
  gateway: Pick<NapCatGatewayServer, 'getMsg'>,
  db: SelfRecordDeps['db'],
  record: MessageRecord,
  logger?: SelfRecordDeps['logger']
): Promise<void> {
  if (!db.updateMessageMedia) return;

  let payloadSegments: Array<Record<string, any>> = [];
  try {
    payloadSegments = normalizeOutboundSegments(JSON.parse(record.raw || '[]'));
  } catch {
    payloadSegments = [];
  }
  const hasMedia = hasOutboundMedia(payloadSegments);
  if (!hasMedia) return;

  try {
    const res = await gateway.getMsg(record.msg_id, 5000);
    if (res?.status !== 'ok' && res?.retcode !== 0) return;

    const fetched = (res as any)?.data;
    const segments: Array<Record<string, any>> = Array.isArray(fetched?.message)
      ? fetched.message.filter((s: any) => s && typeof s === 'object')
      : [];
    if (segments.length === 0) return;

    const media = extractOutboundMediaMeta(segments);
    const patch: {
      file_id?: string | null;
      busid?: number | null;
      local_path?: string | null;
      raw?: string;
    } = { raw: JSON.stringify(segments) };

    if (media.file_id && media.file_id !== record.file_id) patch.file_id = media.file_id;
    if (media.busid !== null && media.busid !== record.busid) patch.busid = media.busid;
    // payload 解析出的本地路径最可靠（就是发送源文件），仅在缺失时用回查结果兜底
    if (!record.local_path && media.local_path) patch.local_path = media.local_path;

    db.updateMessageMedia(record.msg_id, patch);
  } catch (err: any) {
    logger?.debug?.(
      `[Plugin] 出站媒体元数据回查失败 (msg_id: ${record.msg_id}):`,
      err?.message || err
    );
  }
}
