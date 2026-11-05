/**
 * 附件描述符的序列化与存量回填。
 *
 * - `messages.attachments` 存精简描述符 JSON（不含原始段，raw 已保存）；
 * - 存量记录在一次性迁移中尽量回填：优先从 raw 消息段解析，raw 不可用时
 *   再用结构化列（type / file_id / busid / local_path）保守合成；
 * - 确实无法回填的记录保持 NULL，绝不编造事实；
 * - 任意非法 JSON 一律回退空数组，绝不抛错阻断历史读取。
 */

import { describeSegments, isRemoteMediaId } from './classify.js';
import type { AttachmentDescriptor, AttachmentKind, AttachmentOrigin } from './types.js';

const VALID_KINDS = new Set<AttachmentKind>([
  'image',
  'sticker',
  'file',
  'group_file',
  'record',
  'video',
  'forward',
]);

const VALID_ORIGINS = new Set<AttachmentOrigin>(['inbound', 'outbound']);

/** 可回填的落库主导类型（text / reply / at 等非附件类型不在其中）。 */
export function isAttachmentKind(value: unknown): value is AttachmentKind {
  return typeof value === 'string' && VALID_KINDS.has(value as AttachmentKind);
}

/** 递归剥离 undefined；数组中的 undefined 置为 null 以保持下标。 */
function compact(value: any): any {
  if (Array.isArray(value)) {
    return value.map((item) => (item === undefined ? null : compact(item)));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, any> = {};
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue;
      out[key] = compact(item);
    }
    return out;
  }
  return value;
}

/** 序列化描述符数组；空数组返回 null（DB 列保持 NULL）。 */
export function serializeAttachments(
  descriptors: ReadonlyArray<AttachmentDescriptor>
): string | null {
  if (!Array.isArray(descriptors) || descriptors.length === 0) return null;
  return JSON.stringify(compact(descriptors));
}

/** 反序列化描述符数组；非法输入返回空数组。 */
export function deserializeAttachments(
  value: string | null | undefined
): AttachmentDescriptor[] {
  if (typeof value !== 'string' || value.trim() === '') return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is AttachmentDescriptor =>
        Boolean(item) &&
        typeof item === 'object' &&
        VALID_KINDS.has(item.kind) &&
        VALID_ORIGINS.has(item.origin)
    );
  } catch {
    return [];
  }
}

/** 从 raw 消息段解析描述符（用于 `attachments` 列缺失的旧记录）。 */
export function descriptorsFromRaw(
  raw: string | null | undefined,
  ctx: { origin: AttachmentOrigin; isGroup: boolean }
): AttachmentDescriptor[] {
  if (typeof raw !== 'string' || raw.trim() === '') return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return describeSegments(parsed, ctx);
  } catch {
    return [];
  }
}

export interface AttachmentBackfillRow {
  peer: string;
  /** 0/1；存量记录可能为数字或布尔 */
  self?: number | boolean | null;
  type?: string | null;
  content?: string | null;
  raw?: string | null;
  file_id?: string | null;
  busid?: number | null;
  local_path?: string | null;
}

function nonEmpty(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function fileNameFromContent(content?: string | null): string | undefined {
  if (!content) return undefined;

  const group = content.match(/^\[群文件:(.+?)(?:\s*\(ID:[^)]*\))?\]$/);
  if (group?.[1]) {
    const name = group[1].trim();
    if (name) return name;
  }

  const file = content.match(/^\[文件:(.+?)(?:\s+已保存:.*|\s*\(入站落盘失败\))?\]$/);
  if (file?.[1]) {
    const name = file[1].trim();
    if (name) return name;
  }

  return undefined;
}

function baseName(filePath: string): string | undefined {
  const parts = filePath.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || undefined;
}

/**
 * 为一条存量记录生成可回填的描述符 JSON。
 *
 * 回填顺序：
 * 1. raw 能解析出至少一个附件描述符 → 直接使用（信息最全，含 face）；
 * 2. raw 不可用 → 用结构化列保守合成（仅在确有 file_id / busid / local_path 时）；
 * 3. 两者都拿不到事实 → 返回 null，DB 列保持 NULL。
 */
export function backfillAttachmentJson(row: AttachmentBackfillRow): string | null {
  const isGroup = row.peer.startsWith('group_') || row.peer.startsWith('qq-group-');
  const origin: AttachmentOrigin = row.self ? 'outbound' : 'inbound';

  const fromRaw = descriptorsFromRaw(row.raw, { origin, isGroup });
  if (fromRaw.length > 0) return serializeAttachments(fromRaw);

  if (!isAttachmentKind(row.type)) return null;

  const kind = row.type;
  const localPath = nonEmpty(row.local_path);
  const rawFileId = nonEmpty(row.file_id);
  const fileId = rawFileId && isRemoteMediaId(rawFileId) ? rawFileId : undefined;
  const busidValue = row.busid !== undefined && row.busid !== null ? Number(row.busid) : undefined;
  const busid = busidValue !== undefined && Number.isFinite(busidValue) ? busidValue : undefined;

  // 没有任何可确认事实时保持 NULL，绝不凭空生成空描述符
  if (!localPath && !fileId && busid === undefined) return null;

  const descriptor: AttachmentDescriptor = { kind, origin };
  if (localPath) descriptor.local = { path: localPath };

  if (kind === 'forward') {
    if (fileId) descriptor.remote = { forwardId: fileId };
  } else if (fileId || busid !== undefined) {
    descriptor.remote = {
      ...(fileId ? { fileId } : {}),
      ...(busid !== undefined ? { busid } : {}),
    };
  }

  if (kind === 'file' || kind === 'group_file') {
    const fileName = fileNameFromContent(row.content) || (localPath ? baseName(localPath) : undefined);
    if (fileName) descriptor.fileName = fileName;
  }

  return serializeAttachments([descriptor]);
}
