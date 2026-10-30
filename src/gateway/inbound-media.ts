/**
 * dsh-napcat-bridge: 入站图片/表情包解析落盘（四段式主路）
 *
 * 背景（devlog/修复方案-媒体直链失效与回退落盘_261030.md）：
 *   QQ 消息段里的 `gchat.qpic.cn/download?appid=…&fileid=…&rkey=…` 直链对第三方进程不成立，
 *   即使刚收到消息也立刻返回 `{"retcode":-5503007,"retmsg":"download url has expired"}`；
 *   而 NapCat 的 get_image / get_file 走 QQ 客户端自己的取图链路，稳定返回本机原图路径。
 *
 * 因此取图不再是「直链失败后顺手探测一下」，而是四段式主路（串行、首个成功即返回）：
 *   1. get_image({file})              → NapCat 本机路径（最可靠，优先）
 *   2. get_file({file_id})            → 同上，兼容不同 NapCat 版本
 *   3. HTTP 直链（段内 url）          → multimedia.nt.qq.com.cn / gchatpic_new 这类仍可用的 host
 *   4. get_msg({message_id}) 刷新直链 → 最后兜底，同时验证「新签发的 rkey 是否可用」
 *
 * 任一路拿到字节后一律经 MediaStorageManager 复制进我们自己的 downloads/<type>/<peer>/，
 * 绝不把 NapCat 缓存路径直接写进消息记录（QQ 清缓存/升级会让它变成死链，且绕过 TTL 与去重体系）。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OneBotActionResponse } from '../types/index.js';
import type { MediaStorageManager, SaveResourceOptions } from '../storage/media.js';
import { windowsPathToWsl } from '../tools/file-source.js';

/** 只用到的 NapCat Action 子集（便于测试注入） */
export interface InboundImageGateway {
  getImage?: (file: string) => Promise<OneBotActionResponse>;
  getFile?: (fileId: string) => Promise<OneBotActionResponse>;
  getMsg?: (messageId: number | string) => Promise<OneBotActionResponse>;
}

export interface InboundImageLogger {
  info?: (...args: any[]) => void;
  warn?: (...args: any[]) => void;
  debug?: (...args: any[]) => void;
  error?: (...args: any[]) => void;
}

export interface ResolveInboundImageInput {
  /** 落盘 peer 目录（group_<群号> / user_<QQ>） */
  peer: string;
  isSticker: boolean;
  /** 段内 data.url（QQ 直链，可能对第三方不可用） */
  url?: string;
  /** 段内 data.file（QQ 的 MD5 伪文件名，同时是 get_image 的入参） */
  file?: string;
  /** 段内 data.file_id（部分版本无此字段，缺省用 data.file 代替） */
  fileId?: string;
  /** 段内 data.file_size（用于核对拿到的是否原图） */
  declaredSize?: number | string;
  /** 段内 data.local_path（NapCat 已解析到本机的路径，最优先，且不再重复问 NapCat） */
  localPath?: string;
  /** 段内消息 ID（get_msg 刷新直链用） */
  msgId?: number;
  gateway?: InboundImageGateway | null;
  mediaManager: MediaStorageManager;
  logger?: InboundImageLogger;
}

export type InboundImageVia = 'cache' | 'segment_local_path' | 'get_image' | 'get_file' | 'url' | 'get_msg_url';

export interface InboundImageAttempt {
  via: InboundImageVia;
  ok: boolean;
  error?: string;
}

export interface InboundImageResult {
  ok: boolean;
  localPath?: string;
  fingerprint?: string;
  via?: InboundImageVia;
  /** 本地字节数与消息段声明 file_size 不一致（疑似缩略图），仅告警不改选路 */
  sizeMismatch?: boolean;
  attempts: InboundImageAttempt[];
  error?: string;
}

/** 从 url 里猜扩展名（仅作魔数无法识别时的兜底提示） */
function inferUrlExt(str?: string): string | undefined {
  if (!str || typeof str !== 'string') return undefined;
  const clean = str.split('?')[0].split('#')[0];
  const match = /\.([a-zA-Z0-9]+)$/.exec(clean);
  return match ? match[1].toLowerCase() : undefined;
}

function isHttpUrl(value: unknown): value is string {
  return typeof value === 'string' && /^https?:\/\//i.test(value.trim());
}

/**
 * 把 NapCat 返回的路径候选归一化为本机可读的实际路径：
 *   - file:// URI → 平台路径（fileURLToPath，含 URI 解码）
 *   - Windows 盘符路径（C:\… 或 C:/…）→ 本机存在则原样，否则尝试 WSL 映射
 *   - POSIX 绝对路径 → 存在才认
 * 不存在的一律返回 null（交给下一段兜底，绝不写死链）。
 */
function normalizeLocalCandidate(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;

  let candidate = value;
  if (/^file:\/\//i.test(candidate)) {
    try {
      candidate = fileURLToPath(candidate);
    } catch {
      return null;
    }
  }

  if (path.isAbsolute(candidate)) {
    if (fs.existsSync(candidate)) return candidate;
    // Windows 路径在 WSL 部署下的映射（DSH 在 WSL、NapCat 在 Windows 宿主机）
    if (/^[a-zA-Z]:[\\/]/.test(candidate)) {
      const wsl = windowsPathToWsl(candidate.replace(/\//g, '\\'));
      if (wsl && fs.existsSync(wsl)) return wsl;
    }
  }

  return null;
}

/** 从 get_image / get_file 响应里取本机路径（data.file 优先，data.url 为本地形态时兜底） */
function extractNapcatLocalPath(res: OneBotActionResponse | null | undefined): string | null {
  const data = (res?.data || {}) as any;
  for (const candidate of [data.file, data.url]) {
    if (typeof candidate !== 'string' || candidate.trim() === '') continue;
    if (isHttpUrl(candidate)) continue;
    const resolved = normalizeLocalCandidate(candidate);
    if (resolved) return resolved;
  }
  return null;
}

/** 从 get_msg 响应里取 image 段的新直链 */
function extractMessageImageUrl(res: OneBotActionResponse | null | undefined): string | null {
  const data = (res?.data || {}) as any;
  const segments = Array.isArray(data?.message) ? data.message : Array.isArray(data) ? data : [];
  for (const seg of segments) {
    if (seg && seg.type === 'image' && isHttpUrl(seg.data?.url)) return seg.data!.url;
  }
  if (isHttpUrl(data?.url)) return data.url;
  return null;
}

function summarizeError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err ?? '未知错误');
  return message.slice(0, 200);
}

function checkSizeMismatch(localPath: string, declaredSize: number): boolean {
  if (!Number.isFinite(declaredSize) || declaredSize <= 0) return false;
  try {
    return fs.statSync(localPath).size !== declaredSize;
  } catch {
    return false;
  }
}

/**
 * 入站图片/表情包解析：四段式取图 + 统一复制落盘。
 * 任何一段失败都只记录原因并继续下一段；四段全失败返回 ok:false（调用方保持既有基线行为）。
 */
export async function resolveInboundImage(input: ResolveInboundImageInput): Promise<InboundImageResult> {
  const { peer, isSticker, mediaManager, gateway, logger } = input;
  const attempts: InboundImageAttempt[] = [];

  const segmentFile = typeof input.file === 'string' ? input.file.trim() : '';
  const saveFileId = (input.fileId || segmentFile || '').trim() || undefined;
  const legacyUrl = isHttpUrl(input.url) ? input.url : isHttpUrl(segmentFile) ? segmentFile : undefined;
  const urlExt = inferUrlExt(legacyUrl);
  const saveOpts: SaveResourceOptions = {
    type: isSticker ? 'sticker' : 'image',
    sessionId: peer,
    ...(saveFileId ? { fileId: saveFileId } : {}),
    ...(urlExt ? { ext: urlExt } : {}),
  };
  const declaredSize = Number(input.declaredSize);

  const record = (via: InboundImageVia, ok: boolean, error?: string) => {
    attempts.push(error ? { via, ok, error } : { via, ok });
  };

  /** 复制落盘并收敛结果；失败只记录（继续下一段） */
  const saveSource = async (
    via: InboundImageVia,
    source: string,
    sourceDesc: string
  ): Promise<InboundImageResult | null> => {
    try {
      const saved = await mediaManager.downloadAndSave(source, saveOpts);
      const sizeMismatch = checkSizeMismatch(saved.localPath, declaredSize);
      if (sizeMismatch) {
        logger?.warn?.(
          `[InboundMedia] 本地字节数与段内 file_size 不一致（疑似缩略图）: ${sourceDesc} -> ${saved.localPath}`
        );
      }
      record(via, true);
      return {
        ok: true,
        localPath: saved.localPath,
        fingerprint: saved.fingerprint,
        via,
        ...(sizeMismatch ? { sizeMismatch: true } : {}),
        attempts,
      };
    } catch (err) {
      record(via, false, summarizeError(err));
      return null;
    }
  };

  /** 问 NapCat 要本机路径；拿不到就把原因记进 attempts */
  const probeNapcatPath = async (
    via: 'get_image' | 'get_file',
    call: () => Promise<OneBotActionResponse>
  ): Promise<string | null> => {
    try {
      const res = await call();
      const localPath = res?.status === 'ok' ? extractNapcatLocalPath(res) : null;
      if (localPath) return localPath;
      record(
        via,
        false,
        res?.status === 'ok'
          ? 'no_local_path'
          : `status=${res?.status ?? 'unknown'}${res?.wording ? ` ${res.wording}` : ''}`
      );
      return null;
    } catch (err) {
      record(via, false, summarizeError(err));
      return null;
    }
  };

  // 0. 一级去重先行：同一 file_id 已落盘且文件仍在 → 直接复用，连 NapCat 都不用问
  if (saveFileId) {
    const cached = mediaManager.lookupCached(saveFileId);
    if (cached) {
      return {
        ok: true,
        localPath: cached.localPath,
        fingerprint: cached.fingerprint,
        via: 'cache',
        attempts,
      };
    }
  }

  // 0.5 段内已带 local_path：NapCat 已经给过本机路径，直接复制，不再重复调用 get_image。
  // 若该路径当前不可读（QQ 清缓存 / 跨机器路径），也不要再问 NapCat —— get_image 只会返回同一路径，
  // 反而会把入站消息链路卡在一次 15s Action 超时上；此处快速失败，调用方保持 content 既有路径。
  const segmentLocalPath = typeof input.localPath === 'string' ? input.localPath.trim() : '';
  if (segmentLocalPath) {
    const normalized = normalizeLocalCandidate(segmentLocalPath);
    if (normalized) {
      const done = await saveSource('segment_local_path', normalized, 'segment.local_path');
      if (done) return done;
    } else {
      record('segment_local_path', false, 'not_readable');
    }
    const detail = attempts.map((a) => `${a.via}=${a.ok ? 'ok' : a.error || 'failed'}`).join('; ');
    return { ok: false, attempts, error: detail || 'segment.local_path 不可读' };
  }

  // 1. get_image({file}) —— NapCat 本机路径（今天 19/19 命中）
  if (gateway?.getImage && segmentFile) {
    const localPath = await probeNapcatPath('get_image', () => gateway.getImage!(segmentFile));
    if (localPath) {
      const done = await saveSource('get_image', localPath, `get_image:${segmentFile}`);
      if (done) return done;
    }
  } else {
    record('get_image', false, 'api_unavailable_or_no_file');
  }

  // 2. get_file({file_id}) —— 与 get_image 同源，兼容不同 NapCat 版本
  if (gateway?.getFile && saveFileId) {
    const localPath = await probeNapcatPath('get_file', () => gateway.getFile!(saveFileId));
    if (localPath) {
      const done = await saveSource('get_file', localPath, `get_file:${saveFileId}`);
      if (done) return done;
    }
  } else {
    record('get_file', false, 'api_unavailable_or_no_file_id');
  }

  // 3. 段内直链（multimedia.nt.qq.com.cn / gchatpic_new 这类仍可用的 host 靠这段兜住）
  if (legacyUrl) {
    const done = await saveSource('url', legacyUrl, 'segment.url');
    if (done) return done;
  } else {
    record('url', false, 'no_http_url');
  }

  // 4. get_msg 刷新直链（最后兜底，同时验证新签发 rkey 是否可用）
  if (gateway?.getMsg && input.msgId) {
    try {
      const res = await gateway.getMsg(input.msgId);
      const freshUrl = res?.status === 'ok' ? extractMessageImageUrl(res) : null;
      if (freshUrl) {
        const done = await saveSource('get_msg_url', freshUrl, 'get_msg.url');
        if (done) return done;
      } else {
        record(
          'get_msg_url',
          false,
          res?.status === 'ok' ? 'no_url_in_message' : `status=${res?.status ?? 'unknown'}`
        );
      }
    } catch (err) {
      record('get_msg_url', false, summarizeError(err));
    }
  } else {
    record('get_msg_url', false, gateway?.getMsg ? 'no_msg_id' : 'api_unavailable');
  }

  const detail = attempts.map((a) => `${a.via}=${a.ok ? 'ok' : a.error || 'failed'}`).join('; ');
  return { ok: false, attempts, error: detail || '全部取图手段不可用' };
}
