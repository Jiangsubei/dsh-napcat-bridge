/**
 * SnowLuma 群文件 file_id 兼容垫片
 *
 * 背景：SnowLuma 的 group_upload notice 事件落库为 32 位 hex file_id，而它的
 * get_group_file_url 只接受消息段里的 /uuid 形态；直接拿 notice file_id 请求会报
 * `文件 file_id 错误`。本模块只在原始请求失败后触发，按以下顺序换回可用引用：
 *   1. 本地消息库中同一次上传的消息段兄弟记录（零额外协议端请求）；
 *   2. 群根目录 / 子目录文件列表按文件名（与大小、上传时间）匹配。
 *
 * NapCat 主路径（首次请求即成功）不会调用本模块，保证既有业务零回归。
 */

import type { MessageRecord } from '../types/index.js';

export interface GroupFileResolverGateway {
  getGroupRootFiles(
    groupId: number | string,
    timeoutMs?: number
  ): Promise<{ status?: string; retcode?: number; data?: { files?: any[]; folders?: any[] } }>;
  getGroupFilesByFolder(
    groupId: number | string,
    folderId: string,
    timeoutMs?: number
  ): Promise<{ status?: string; retcode?: number; data?: { files?: any[]; folders?: any[] } }>;
}

export interface GroupFileResolverDb {
  getByFileId?(fileId: string): MessageRecord | null;
  findGroupFileSibling?(peer: string, fileName: string, time: number, size?: number): MessageRecord | null;
}

export interface ResolveGroupFileOptions {
  gateway: GroupFileResolverGateway;
  db?: GroupFileResolverDb | null;
  groupId: number | string;
  fileId: string;
  fileName?: string;
  time?: number;
  size?: number;
  busid?: number;
}

export interface ResolvedGroupFileReference {
  fileId: string;
  busid?: number;
}

interface GroupFileSnapshot {
  files: any[];
  folders: any[];
}

/** 群目录快照缓存 TTL：根目录拉取在真机上约 3.7s / 81KB，必须避免重复拉取 */
const CACHE_TTL_MS = 60_000;
/** 子目录递归上限，避免异常数据导致无限展开 */
const MAX_FOLDER_DEPTH = 3;
const MAX_FOLDER_COUNT = 30;

const snapshotCache = new Map<string, { at: number; promise: Promise<GroupFileSnapshot> }>();

/** 清空目录快照缓存（测试隔离与配置变更时调用） */
export function clearGroupFileResolverCache(): void {
  snapshotCache.clear();
}

function normalizeName(value: unknown): string {
  return value === undefined || value === null ? '' : String(value).trim();
}

function positiveNumber(value: unknown): number | undefined {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : undefined;
}

function parseGroupFileRecordInfo(record: MessageRecord | null | undefined): {
  fileName: string;
  size?: number;
} {
  if (!record) return { fileName: '' };
  let fileName = '';
  let size: number | undefined = undefined;

  if (record.raw) {
    try {
      const parsed = JSON.parse(record.raw);
      const nodes = Array.isArray(parsed) ? parsed : [parsed];
      for (const node of nodes) {
        const file = node?.file ?? (node?.type === 'file' ? node?.data : null);
        if (!file) continue;
        if (!fileName) {
          fileName = normalizeName(file.name ?? file.file_name ?? file.file);
        }
        if (size === undefined) {
          const rawSize = typeof file.size === 'number' ? file.size : Number(file.file_size);
          if (Number.isFinite(rawSize) && rawSize >= 0) size = rawSize;
        }
        if (fileName && size !== undefined) break;
      }
    } catch {}
  }

  if (!fileName && record.content) {
    const match = record.content.match(/^\[群文件:(.+?)\s*\(ID:/);
    fileName = match && match[1] ? match[1].trim() : '';
  }

  return { fileName, size };
}

function getCachedSnapshot(
  key: string,
  loader: () => Promise<GroupFileSnapshot>
): Promise<GroupFileSnapshot> {
  const cached = snapshotCache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.promise;
  }

  const promise = loader().catch((err) => {
    snapshotCache.delete(key);
    throw err;
  });
  snapshotCache.set(key, { at: Date.now(), promise });
  return promise;
}

function loadSnapshot(
  gateway: GroupFileResolverGateway,
  groupId: number | string,
  folderId?: string
): Promise<GroupFileSnapshot> {
  if (!folderId) {
    return getCachedSnapshot(`group:${groupId}:root`, async () => {
      const res = await gateway.getGroupRootFiles(groupId);
      return { files: res?.data?.files ?? [], folders: res?.data?.folders ?? [] };
    });
  }

  return getCachedSnapshot(`group:${groupId}:folder:${folderId}`, async () => {
    const res = await gateway.getGroupFilesByFolder(groupId, folderId);
    return { files: res?.data?.files ?? [], folders: res?.data?.folders ?? [] };
  });
}

function uploadTimeMs(file: any): number | undefined {
  const value = Number(file?.upload_time);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  // OneBot 群文件 upload_time 为秒级时间戳
  return value > 1e12 ? value : value * 1000;
}

function matchSnapshotFile(
  snapshot: GroupFileSnapshot,
  fileName: string,
  size?: number,
  anchorTime?: number
): any | null {
  const target = normalizeName(fileName);
  if (!target) return null;

  let best: any | null = null;
  let bestScore = Number.POSITIVE_INFINITY;

  for (const file of snapshot.files ?? []) {
    const candidateName = normalizeName(file?.file_name ?? file?.name);
    if (candidateName !== target) continue;

    if (size !== undefined) {
      const candidateSize = Number(file?.file_size ?? file?.size);
      if (Number.isFinite(candidateSize) && candidateSize !== size) continue;
    }

    let score = 0;
    if (anchorTime !== undefined) {
      const uploadedAt = uploadTimeMs(file);
      if (uploadedAt !== undefined) score = Math.abs(uploadedAt - anchorTime);
    }

    if (score < bestScore) {
      best = file;
      bestScore = score;
    }
  }

  return best;
}

function toResolvedReference(
  file: any,
  fallbackFileId: string,
  fallbackBusid?: number
): ResolvedGroupFileReference | null {
  const fileId = normalizeName(file?.file_id ?? file?.id);
  if (!fileId || fileId === fallbackFileId) return null;

  const busid = positiveNumber(file?.busid) ?? fallbackBusid;
  return busid !== undefined ? { fileId, busid } : { fileId };
}

async function searchFolders(
  gateway: GroupFileResolverGateway,
  groupId: number | string,
  snapshot: GroupFileSnapshot,
  fileName: string,
  size: number | undefined,
  anchorTime: number | undefined,
  depth: number,
  visited: Set<string>
): Promise<any | null> {
  if (depth > MAX_FOLDER_DEPTH || visited.size >= MAX_FOLDER_COUNT) return null;

  for (const folder of snapshot.folders ?? []) {
    const folderId = normalizeName(folder?.folder_id ?? folder?.id);
    if (!folderId || visited.has(folderId)) continue;
    visited.add(folderId);
    if (visited.size > MAX_FOLDER_COUNT) break;

    try {
      const child = await loadSnapshot(gateway, groupId, folderId);
      const matched = matchSnapshotFile(child, fileName, size, anchorTime);
      if (matched) return matched;

      const nested = await searchFolders(
        gateway,
        groupId,
        child,
        fileName,
        size,
        anchorTime,
        depth + 1,
        visited
      );
      if (nested) return nested;
    } catch {
      // 单个子目录拉取失败不阻断其他目录与最终报错透传
    }
  }

  return null;
}

/**
 * 将不可用的群文件 file_id 解析为协议端可接受的引用。
 * 返回 null 表示无法解析，调用方应保留原始请求的报错。
 */
export async function resolveGroupFileReference(
  options: ResolveGroupFileOptions
): Promise<ResolvedGroupFileReference | null> {
  const { gateway, db, groupId, fileId } = options;
  if (!gateway || !fileId) return null;

  let record: MessageRecord | null | undefined = null;
  if (db?.getByFileId) {
    try {
      record = db.getByFileId(fileId);
    } catch {}
  }

  const recordInfo = parseGroupFileRecordInfo(record);
  const fileName = normalizeName(options.fileName) || recordInfo.fileName;
  const size = options.size ?? recordInfo.size;
  const anchorTime = options.time ?? (record ? Number(record.time) : undefined);

  // 1. 本地兄弟记录优先：SnowLuma 同一次上传的消息段 /uuid 常在库中
  if (record?.peer && fileName && db?.findGroupFileSibling) {
    try {
      const sibling = db.findGroupFileSibling(
        record.peer,
        fileName,
        Number.isFinite(anchorTime) ? Number(anchorTime) : Date.now(),
        size
      );
      const siblingId = normalizeName(sibling?.file_id);
      if (sibling && siblingId && siblingId !== fileId) {
        const busid = positiveNumber(sibling.busid) ?? positiveNumber(record.busid);
        return busid !== undefined ? { fileId: siblingId, busid } : { fileId: siblingId };
      }
    } catch {}
  }

  // 2. 群目录兜底：根目录优先，未命中再递归子目录
  if (!fileName || groupId === undefined || groupId === null || String(groupId).trim() === '') {
    return null;
  }

  let root: GroupFileSnapshot;
  try {
    root = await loadSnapshot(gateway, groupId);
  } catch {
    return null;
  }

  const fallbackBusid = positiveNumber(record?.busid) ?? positiveNumber(options.busid);
  const rootMatch = matchSnapshotFile(root, fileName, size, anchorTime);
  if (rootMatch) {
    const resolved = toResolvedReference(rootMatch, fileId, fallbackBusid);
    if (resolved) return resolved;
  }

  const folderMatch = await searchFolders(
    gateway,
    groupId,
    root,
    fileName,
    size,
    anchorTime,
    1,
    new Set<string>()
  );
  if (folderMatch) {
    return toResolvedReference(folderMatch, fileId, fallbackBusid);
  }

  return null;
}
