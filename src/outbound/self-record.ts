/**
 * dsh-napcat-bridge: 出站消息自记录 (Outbound Self Record)
 *
 * 出站消息不依赖 NapCat 的 `reportSelfMessage` 上报：只要 OneBot 应答成功且返回
 * message_id，就立即把这条自身消息写入本地 messages 表（self = 1）。
 * 发送失败或无有效 message_id 时不落库，避免写入无法寻址的幽灵记录。
 *
 * 附件事实统一来自 `src/attachment/`：发送方可通过 `attachments` 旁路携带
 * face_id / 情绪 / 本地真实格式；未携带时从消息段推导。
 */

import {
  describeMessage,
  inferDominantType as inferTypeFromSegments,
  resolveLocalMediaPath,
  toMessageMediaFields,
  type MessageDescription,
  type MessageMediaFields,
} from '../attachment/classify.js';
import { normalizeOutboundSegments } from '../attachment/outbound.js';
import {
  deserializeAttachments,
  serializeAttachments,
} from '../attachment/store.js';
import type { AttachmentDescriptor } from '../attachment/types.js';
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

export { normalizeOutboundSegments, resolveLocalMediaPath };

/** 出站消息是否携带需要异步补全元数据的媒体段 */
export function hasOutboundMedia(segments: Array<Record<string, any>>): boolean {
  return segments.some((seg) =>
    ['image', 'file', 'record', 'video', 'forward'].includes(String(seg?.type || ''))
  );
}

/** 从出站消息段提取媒体元数据（payload 版本）。 */
export function extractOutboundMediaMeta(
  segments: Array<Record<string, any>>
): OutboundMediaMeta {
  const description = describeMessage(segments, {
    origin: 'outbound',
    isGroup: false,
  });
  const fields = toMessageMediaFields(description);
  return {
    file_id: fields.file_id,
    busid: fields.busid,
    local_path: fields.local_path,
  };
}

/** 推导出站消息主导类型（与入站落库口径共用同一规则）。 */
export function inferOutboundMessageType(
  segments: Array<Record<string, any>>,
  isGroup: boolean
): string {
  return inferTypeFromSegments(segments, { isGroup });
}

/**
 * 把旁路描述符中的本地事实回填到消息段，供统一渲染读取。
 * 只补 local / face / summary / unavailable，不改变发送给 NapCat 的原始 payload。
 */
function applyDescriptorsToSegments(
  segments: Array<Record<string, any>>,
  descriptors: AttachmentDescriptor[]
): Array<Record<string, any>> {
  if (descriptors.length === 0) return segments;

  const queue = [...descriptors];
  return segments.map((seg) => {
    if (!['image', 'file', 'record', 'video', 'forward'].includes(String(seg?.type || ''))) {
      return seg;
    }
    const descriptor = queue.shift();
    if (!descriptor) return seg;

    const data: Record<string, any> = { ...(seg.data || {}) };
    if (descriptor.local?.path) {
      data.local_path = descriptor.local.path;
      if (descriptor.local.format) data.local_format = descriptor.local.format;
      if (descriptor.local.md5) data.md5 = descriptor.local.md5;
      if (descriptor.local.fingerprint) data.fingerprint = descriptor.local.fingerprint;
    }
    if (descriptor.face) data.face = descriptor.face;
    if (descriptor.summary) data.summary = descriptor.summary;
    if (descriptor.unavailable) data.dl_failed = true;
    if (descriptor.fileName && !data.file_name) data.file_name = descriptor.fileName;
    if (descriptor.remote?.fileId) data.file_id = descriptor.remote.fileId;
    if (descriptor.remote?.url) data.url = descriptor.remote.url;
    if (descriptor.remote?.busid !== undefined) data.busid = descriptor.remote.busid;

    return { ...seg, data };
  });
}

function describeOutbound(
  segments: Array<Record<string, any>>,
  isGroup: boolean,
  provided?: AttachmentDescriptor[]
): MessageDescription {
  const derived = describeMessage(segments, { origin: 'outbound', isGroup });
  if (provided && provided.length > 0) {
    return { type: derived.type, attachments: provided };
  }
  return derived;
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
  const description = describeOutbound(segments, isGroup, event.attachments);

  const parsed = parseNormalizedContent(
    {
      message: applyDescriptorsToSegments(segments, description.attachments),
      message_type: isGroup ? 'group' : 'private',
    } as any,
    {
      getFaceByMd5: options.getFaceByMd5,
    }
  );

  if (!parsed.content || parsed.content.trim() === '') return null;

  const media: MessageMediaFields = toMessageMediaFields(description);

  return {
    msg_id: event.msgId,
    peer: event.peer,
    user_id: options.botQQ,
    sender_name: options.senderName,
    time: event.time,
    type: media.type,
    content: parsed.content,
    raw: JSON.stringify(segments),
    file_id: media.file_id,
    busid: media.busid,
    local_path: media.local_path,
    fingerprint: media.fingerprint,
    recalled: 0,
    self: 1,
    reply_to: parsed.replyId ?? null,
    attachments: serializeAttachments(description.attachments),
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

/** 合并远端事实：只补 remote，不触碰 local / face / kind / origin。 */
function mergeRemote(
  existing: AttachmentDescriptor,
  fetched: AttachmentDescriptor | undefined
): AttachmentDescriptor {
  if (!fetched?.remote) return existing;
  const remote = {
    ...(existing.remote || {}),
    ...(fetched.remote.fileId ? { fileId: fetched.remote.fileId } : {}),
    ...(fetched.remote.busid !== undefined ? { busid: fetched.remote.busid } : {}),
    ...(fetched.remote.url ? { url: fetched.remote.url } : {}),
    ...(fetched.remote.forwardId ? { forwardId: fetched.remote.forwardId } : {}),
  };
  return { ...existing, remote };
}

/**
 * 异步回查 get_msg 补全出站媒体元数据（file_id / busid / raw / attachments.remote）。
 *
 * - 仅对含媒体段的消息触发；
 * - 5s 超时，任何失败只记 debug；
 * - 只补 remote；local_path 仅在 payload 版本缺失时兜底；
 * - 绝不覆盖发送方旁路携带的 local / face / kind。
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
  if (!hasOutboundMedia(payloadSegments)) return;

  try {
    const res = await gateway.getMsg(record.msg_id, 5000);
    if (res?.status !== 'ok' && res?.retcode !== 0) return;

    const fetched = (res as any)?.data;
    const segments: Array<Record<string, any>> = Array.isArray(fetched?.message)
      ? fetched.message.filter((s: any) => s && typeof s === 'object')
      : [];
    if (segments.length === 0) return;

    const isGroup = record.peer.startsWith('group_') || record.peer.startsWith('qq-group-');
    const fetchedDescription = describeMessage(segments, { origin: 'outbound', isGroup });
    const media = toMessageMediaFields(fetchedDescription);

    const patch: {
      file_id?: string | null;
      busid?: number | null;
      local_path?: string | null;
      raw?: string;
      attachments?: string | null;
    } = { raw: JSON.stringify(segments) };

    if (media.file_id && media.file_id !== record.file_id) patch.file_id = media.file_id;
    if (media.busid !== null && media.busid !== record.busid) patch.busid = media.busid;
    // payload 解析出的本地路径最可靠（就是发送源文件），仅在缺失时用回查结果兜底
    if (!record.local_path && media.local_path) patch.local_path = media.local_path;

    const existingAttachments = deserializeAttachments(record.attachments);
    const baseAttachments =
      existingAttachments.length > 0
        ? existingAttachments
        : describeMessage(payloadSegments, { origin: 'outbound', isGroup }).attachments;

    if (baseAttachments.length > 0) {
      const merged = baseAttachments.map((descriptor, index) =>
        mergeRemote(descriptor, fetchedDescription.attachments[index])
      );
      patch.attachments = serializeAttachments(merged);
    }

    db.updateMessageMedia(record.msg_id, patch);
  } catch (err: any) {
    logger?.debug?.(
      `[Plugin] 出站媒体元数据回查失败 (msg_id: ${record.msg_id}):`,
      err?.message || err
    );
  }
}
