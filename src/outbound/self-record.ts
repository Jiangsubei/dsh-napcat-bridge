/**
 * dsh-napcat-bridge: 出站消息自记录 (Outbound Self Record)
 *
 * 出站消息不依赖 NapCat 的 `reportSelfMessage` 上报：只要 OneBot 应答成功且返回
 * message_id，就立即把这条自身消息写入本地 messages 表（self = 1）。
 * 发送失败或无有效 message_id 时不落库，避免写入无法寻址的幽灵记录。
 */

import { parseNormalizedContent } from '../gateway/wakeup.js';
import type { MessageRecord } from '../types/index.js';
import type { OutboundSentEvent } from '../gateway/server.js';

export interface SelfRecordDeps {
  db: {
    saveMessageIfNotExists(record: MessageRecord): boolean;
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

  return {
    msg_id: event.msgId,
    peer: event.peer,
    user_id: options.botQQ,
    sender_name: options.senderName,
    time: event.time,
    type: inferOutboundMessageType(segments, isGroup),
    content: parsed.content,
    raw: JSON.stringify(segments),
    file_id: null,
    busid: null,
    local_path: null,
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
