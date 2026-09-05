/**
 * dsh-napcat-bridge: 私聊文件入站即时落盘助手 (PF-001)
 *
 * 私聊文件「占位假成功」接线整改核心助手（任务包《私聊文件入站落盘整改》§3.1 用户拍板两级退化）：
 *   首选 get_private_file_url：拿 data.url（HTTP 直链）→ mediaManager.downloadAndSave 落盘
 *       （NapCat 源码实证该接口依赖 packet 后端，QQ 9.9.30-48762 起可能不可用，见 GetPrivateFileUrl.ts）；
 *   回退 get_file：拿 NapCat 侧本地路径 → windowsPathToWsl 翻译为 /mnt/<drive>/… → 校验存在 →
 *       拷入 napcat_download/files/<peer>/（不依赖 packet，见 GetFile.ts）；
 *   两路都失败：返回清晰错误（文件下载失败: <具体环节原因>…），绝不返回占位假路径。
 *
 * 目录约定（任务包 §3.2，沿用现有体系不新建）：落盘到 files/<peer>/（peer=user_<qq>）。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { NapCatGatewayServer } from '../gateway/server.js';
import type { MediaStorageManager, SaveResourceResult } from '../storage/media.js';
import type { OneBotActionResponse } from '../types/index.js';
import { windowsPathToWsl } from './file-source.js';

export interface DownloadPrivateFileLogger {
  info?: (...args: any[]) => void;
  warn?: (...args: any[]) => void;
  error?: (...args: any[]) => void;
  debug?: (...args: any[]) => void;
}

export interface DownloadPrivateFileOptions {
  fileId: string;
  /** 落盘 peer（user_<qq>），缺失时回退 common（仅工具缺上下文场景） */
  peer?: string;
  /**
   * 消息上下文 busid（NapCat GetPrivateFileUrl/GetFile 的 PayloadSchema 均不消费该字段，
   * 保留为调用上下文与后续 NapCat 版本兼容预留）
   */
  busid?: number | null;
  /** 保存文件名建议（入站时取段内 file_name/file，外部来源不可信，统一 basename 规整） */
  filename?: string;
  gateway: NapCatGatewayServer | null | undefined;
  mediaManager: MediaStorageManager | null | undefined;
  logger?: DownloadPrivateFileLogger;
}

export interface DownloadPrivateFileResult {
  ok: boolean;
  localPath: string | null;
  fingerprint?: string | null;
  /** 具体环节原因（双失败时呈现完整两路原因，绝不占位） */
  error?: string;
  /** 成功路径: 'url' = get_private_file_url 直链；'local' = get_file 本地路径 |
   *  null = 未成功 */
  via: 'url' | 'local' | null;
}

/** 文件名安全规整（外部来源文件名严禁路径穿越） */
function safeFileName(name?: string | null): string | undefined {
  if (!name) return undefined;
  const base = path.basename(String(name).trim());
  return base || undefined;
}

/** 提取 NapCat get_file 响应中的可用本地路径（data.file 优先，data.url 兜底本地形态） */
function extractNapcatLocalPath(res: OneBotActionResponse): string | null {
  const data = (res?.data || {}) as any;
  if (typeof data.file === 'string' && data.file.trim() !== '') {
    return data.file.trim();
  }
  if (
    typeof data.url === 'string' &&
    (data.url.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(data.url))
  ) {
    return data.url.trim();
  }
  return null;
}

export async function downloadPrivateFile(
  options: DownloadPrivateFileOptions
): Promise<DownloadPrivateFileResult> {
  const { fileId, peer, filename, logger } = options;
  const gateway = options.gateway;
  const mediaManager = options.mediaManager;

  if (!fileId || typeof fileId !== 'string' || fileId.trim() === '') {
    return { ok: false, localPath: null, via: null, error: '文件下载失败: 缺少 file_id' };
  }
  if (!gateway) {
    return { ok: false, localPath: null, via: null, error: '文件下载失败: NapCat 未连接 (gateway 不可用)' };
  }
  if (!mediaManager) {
    return { ok: false, localPath: null, via: null, error: '文件下载失败: 媒体存储服务不可用' };
  }

  const sessionId = peer && peer.trim() !== '' ? peer.trim() : undefined;
  const saveOpts = {
    fileId: fileId.trim(),
    type: 'files' as const,
    ...(sessionId ? { sessionId } : {}),
    ...(filename ? { filename: safeFileName(filename) } : {}),
  };

  // —— 首选：get_private_file_url → data.url (HTTP 直链) → downloadAndSave ——
  let urlErr: string | null = null;
  try {
    const res = await gateway.getPrivateFileUrl(fileId);
    const url = typeof res?.data?.url === 'string' ? res.data.url : '';
    if (res?.status === 'ok' && /^https?:\/\//i.test(url)) {
      const saved: SaveResourceResult = await mediaManager.downloadAndSave(url, saveOpts);
      return { ok: true, localPath: saved.localPath, fingerprint: saved.fingerprint ?? null, via: 'url' };
    }
    const info = [res?.wording, res?.message].filter(Boolean).join(' ');
    urlErr = `get_private_file_url 失败 (file_id: ${fileId})${info ? ` — NapCat: ${info}` : ''}${
      url ? ` — 返回的 url 非 HTTP 直链: ${url.slice(0, 80)}` : ' — 未返回 data.url'
    }`;
  } catch (err: any) {
    urlErr = `get_private_file_url 异常: ${err?.message || '未知错误'}`;
  }
  logger?.debug?.('[PrivateFile] 首选直链不可用，回退 get_file:', urlErr);

  // —— 回退：get_file → NapCat 本地路径 → WSL 翻译 → 校验存在 → 拷入 files/<peer>/ ——
  let localErr: string | null = null;
  try {
    const res = await gateway.getFile(fileId);
    const napcatPath = extractNapcatLocalPath(res);
    if (!napcatPath) {
      localErr = `get_file 未返回可用的本地路径 (file_id: ${fileId})${
        res?.wording ? ` — NapCat: ${res.wording}` : ''
      }`;
    } else {
      let wslPath: string | null = napcatPath;
      if (!napcatPath.startsWith('/')) {
        // Windows 盘符路径（C:\… / C:/…）→ /mnt/<drive>/…；非盘符绝对路径直接判为无法翻译
        wslPath = windowsPathToWsl(napcatPath);
        if (!wslPath) {
          localErr = `get_file 本地路径无法翻译为 WSL 路径: ${napcatPath}`;
        }
      }
      if (wslPath) {
        if (!fs.existsSync(wslPath)) {
          localErr = `get_file 本地文件不存在 (翻译后路径: ${wslPath})`;
        } else {
          const saved: SaveResourceResult = await mediaManager.downloadAndSave(wslPath, saveOpts);
          return { ok: true, localPath: saved.localPath, fingerprint: saved.fingerprint ?? null, via: 'local' };
        }
      }
    }
  } catch (err: any) {
    localErr = `get_file 回退异常: ${err?.message || '未知错误'}`;
  }

  return {
    ok: false,
    localPath: null,
    via: null,
    error: `文件下载失败: ${urlErr || 'get_private_file_url 不可用'}; ${localErr || 'get_file 不可用'}`,
  };
}