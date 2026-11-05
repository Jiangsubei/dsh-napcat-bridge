/**
 * 附件分类与段内事实提取（唯一判定入口）。
 *
 * 入站 / 出站 / 离线同步 / 自记录都必须走这里，禁止各自再写一套
 * `sub_type` / `emoji_package_id` / `file_id` 推导。
 */

import { fileURLToPath } from 'node:url';
import type {
  AttachmentDescriptor,
  AttachmentFaceMeta,
  AttachmentKind,
  AttachmentLocalMeta,
  AttachmentOrigin,
  AttachmentRemoteMeta,
} from './types.js';

export interface SegmentContext {
  isGroup: boolean;
}

export interface DescribeContext extends SegmentContext {
  origin: AttachmentOrigin;
}

export interface MessageDescription {
  /** 与既有落库口径一致的主导类型。 */
  type: string;
  /** 按消息段顺序排列的附件描述符。 */
  attachments: AttachmentDescriptor[];
}

export interface MessageMediaFields {
  type: string;
  file_id: string | null;
  busid: number | null;
  local_path: string | null;
  fingerprint: string | null;
}

const NON_LOCAL_SCHEME = /^(file:|https?:|data:|base64:)/i;

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** 图片段是否为表情包（既有落库口径）。 */
export function isStickerSegment(data: any): boolean {
  return Boolean(data && (data.sub_type === 1 || data.emoji_package_id));
}

/**
 * 是否像 OneBot / NapCat 的远端媒体标识（而非本地路径、URL、base64）。
 * 注意：`file:///` 是本地路径，不能当作远端 file_id。
 */
export function isRemoteMediaId(value: unknown): value is string {
  const v = nonEmptyString(value);
  if (!v) return false;
  if (NON_LOCAL_SCHEME.test(v)) return false;
  if (/^[a-zA-Z]:[\\/]/.test(v) || v.startsWith('/') || v.startsWith('\\\\')) return false;
  return true;
}

/**
 * 把 file:// URI 或本地绝对路径解析为可读 OS 路径。
 * URL / base64 / 相对路径一律返回 null，绝不伪造本地路径。
 */
export function resolveLocalMediaPath(value: unknown): string | null {
  const raw = nonEmptyString(value);
  if (!raw) return null;

  if (/^file:\/\//i.test(raw)) {
    try {
      return fileURLToPath(raw);
    } catch {
      // Windows 上 file:///tmp/a.png 这类无盘符 URI 会让 fileURLToPath 抛错，
      // 退回取 URL pathname，至少保留可读的绝对路径而不丢附件事实。
      try {
        const pathname = decodeURIComponent(new URL(raw).pathname);
        return pathname.startsWith('/') ? pathname : null;
      } catch {
        return null;
      }
    }
  }
  if (/^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith('/') || raw.startsWith('\\\\')) {
    return raw;
  }
  // WSL 路径（NapCat 侧常见）：/mnt/c/... 已由 startsWith('/') 覆盖。
  return null;
}

function isHttpUrl(value: unknown): value is string {
  return typeof value === 'string' && /^https?:\/\//i.test(value.trim());
}

function baseName(filePath: string): string {
  const parts = filePath.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || filePath;
}

function fileNameFromHttpUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    const last = parsed.pathname.split('/').filter(Boolean).pop();
    if (!last) return undefined;
    return decodeURIComponent(last);
  } catch {
    return undefined;
  }
}

/** 统一的文件名推导：本地路径取 basename，URL 取 pathname 尾段，远端伪名原样。 */
export function resolveAttachmentFileName(data: any): string | undefined {
  const explicit = nonEmptyString(data?.file_name) || nonEmptyString(data?.name);
  if (explicit) return explicit;

  const file = nonEmptyString(data?.file);
  if (file) {
    const local = resolveLocalMediaPath(file);
    if (local) return baseName(local);
    if (isHttpUrl(file)) return fileNameFromHttpUrl(file);
    if (!/^(base64:|data:)/i.test(file)) return file;
  }

  return nonEmptyString(data?.file_id);
}

/** 唯一的附件 kind 判定。 */
export function classifySegment(
  seg: Record<string, any> | null | undefined,
  ctx: SegmentContext
): AttachmentKind | null {
  if (!seg || typeof seg !== 'object') return null;
  const data = seg.data || {};

  switch (seg.type) {
    case 'image':
      return isStickerSegment(data) ? 'sticker' : 'image';
    case 'file':
      return ctx.isGroup ? 'group_file' : 'file';
    case 'record':
      return 'record';
    case 'video':
      return 'video';
    case 'forward':
      return 'forward';
    default:
      return null;
  }
}

function buildFace(data: any): AttachmentFaceMeta | undefined {
  const id = nonEmptyString(data?.face?.id);
  if (!id) return undefined;
  const mood = nonEmptyString(data.face.mood);
  const tags =
    Array.isArray(data.face.tags) && data.face.tags.length > 0
      ? data.face.tags.map((tag: unknown) => String(tag))
      : undefined;
  return {
    id,
    ...(mood ? { mood } : {}),
    ...(tags ? { tags } : {}),
  };
}

function buildRemote(kind: AttachmentKind, data: any): AttachmentRemoteMeta | undefined {
  const remote: AttachmentRemoteMeta = {};

  if (kind === 'forward') {
    const forwardId = nonEmptyString(data.id) || nonEmptyString(data.forward_id);
    if (forwardId) remote.forwardId = forwardId;
  } else {
    const explicitId = nonEmptyString(data.file_id);
    if (explicitId) {
      remote.fileId = explicitId;
    } else if (kind !== 'file' && kind !== 'group_file' && isRemoteMediaId(data.file)) {
      // 文件段的 data.file 通常是「文件名」而非远端 ID（如 report.pdf），
      // 只有 image/record/video 等才可用 data.file 作为远端标识。
      remote.fileId = String(data.file).trim();
    }

    if (data.busid !== undefined && data.busid !== null && Number.isFinite(Number(data.busid))) {
      remote.busid = Number(data.busid);
    }

    const url = nonEmptyString(data.url) || (isHttpUrl(data.file) ? String(data.file).trim() : undefined);
    if (url) remote.url = url;
  }

  return Object.keys(remote).length > 0 ? remote : undefined;
}

function buildLocal(data: any): AttachmentLocalMeta | undefined {
  const pathValue = resolveLocalMediaPath(data?.local_path) || resolveLocalMediaPath(data?.file);
  if (!pathValue) return undefined;

  const format = nonEmptyString(data?.local_format);
  const md5 = nonEmptyString(data?.md5);
  const fingerprint = nonEmptyString(data?.fingerprint);
  const sizeValue = data?.file_size ?? data?.size;
  const size =
    sizeValue !== undefined && sizeValue !== null && Number.isFinite(Number(sizeValue))
      ? Number(sizeValue)
      : undefined;

  return {
    path: pathValue,
    ...(format ? { format } : {}),
    ...(size !== undefined ? { size } : {}),
    ...(md5 ? { md5 } : {}),
    ...(fingerprint ? { fingerprint } : {}),
  };
}

/** 从单个消息段提取附件描述符；非附件段返回 null。 */
export function describeSegment(
  seg: Record<string, any> | null | undefined,
  ctx: DescribeContext
): AttachmentDescriptor | null {
  const kind = classifySegment(seg, ctx);
  if (!kind) return null;

  const data = seg!.data || {};
  const remote = buildRemote(kind, data);
  const local = buildLocal(data);
  const face = buildFace(data);
  const fileName = resolveAttachmentFileName(data);
  const summary = nonEmptyString(data.summary);
  const unavailable = data.dl_failed
    ? 'inbound_failed'
    : nonEmptyString(data.unavailable_reason) || nonEmptyString(data.unavailable);

  return {
    kind,
    origin: ctx.origin,
    ...(remote ? { remote } : {}),
    ...(local ? { local } : {}),
    ...(face ? { face } : {}),
    ...(fileName ? { fileName } : {}),
    ...(summary ? { summary } : {}),
    ...(unavailable ? { unavailable } : {}),
  };
}

/** 按消息段顺序提取全部附件描述符。 */
export function describeSegments(
  segments: ReadonlyArray<Record<string, any>>,
  ctx: DescribeContext
): AttachmentDescriptor[] {
  const descriptors: AttachmentDescriptor[] = [];
  for (const seg of segments) {
    const descriptor = describeSegment(seg, ctx);
    if (descriptor) descriptors.push(descriptor);
  }
  return descriptors;
}

/**
 * 推导消息主导类型，保持既有落库口径：
 * 首个有意义的非文本段决定类型；file / forward / record / video / poke / shake /
 * json / xml 无条件覆盖，reply / at / image 仅在仍为 text 时生效。
 */
export function inferDominantType(
  segments: ReadonlyArray<Record<string, any>>,
  ctx: SegmentContext
): string {
  let type = 'text';

  for (const seg of segments) {
    if (!seg || typeof seg !== 'object') continue;
    const data = seg.data || {};

    switch (seg.type) {
      case 'image':
        if (type === 'text') type = isStickerSegment(data) ? 'sticker' : 'image';
        break;
      case 'file':
        type = ctx.isGroup ? 'group_file' : 'file';
        break;
      case 'forward':
        type = 'forward';
        break;
      case 'record':
        type = 'record';
        break;
      case 'video':
        type = 'video';
        break;
      case 'poke':
        type = 'poke';
        break;
      case 'shake':
        type = 'shake';
        break;
      case 'json':
      case 'xml':
        type = seg.type;
        break;
      case 'reply':
        if (type === 'text') type = 'reply';
        break;
      case 'at':
        if (type === 'text') type = 'at';
        break;
      default:
        break;
    }
  }

  return type;
}

/** 一次性得到主导类型与附件描述符。 */
export function describeMessage(
  segments: ReadonlyArray<Record<string, any>>,
  ctx: DescribeContext
): MessageDescription {
  return {
    type: inferDominantType(segments, ctx),
    attachments: describeSegments(segments, ctx),
  };
}

/** 描述符 → messages 表的媒体字段（file_id / busid / local_path / fingerprint）。 */
export function toMessageMediaFields(description: MessageDescription): MessageMediaFields {
  const firstRemote = description.attachments.find((item) => item.remote?.fileId)?.remote;
  const firstBusid = description.attachments.find((item) => item.remote?.busid !== undefined)?.remote;
  const firstLocal = description.attachments.find((item) => item.local?.path)?.local;

  return {
    type: description.type,
    file_id: firstRemote?.fileId ?? null,
    busid: firstBusid?.busid ?? null,
    local_path: firstLocal?.path ?? null,
    fingerprint: firstLocal?.fingerprint ?? null,
  };
}
