/**
 * dsh-napcat-bridge: 本地资源下载、两级去重与 7 天 TTL 清理模块
 * 管理图片、表情包与文件的本地缓存落盘、两级去重（file_id 索引 + SHA-256 指纹）以及过期文件清理。
 */

import * as fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type { Context } from '@deepseek-ai/cordis';
import type { MessageDatabase } from './database.js';
import { resolveDshPath, DEFAULT_DOWNLOAD_ROOT } from '../constants/index.js';

export interface MediaStorageOptions {
  dshHome?: string;
  downloadDir?: string;
  db?: MessageDatabase | null;
  ttlDays?: number;
}

export interface SaveResourceOptions {
  type?: 'image' | 'sticker' | 'files' | 'file';
  sessionId?: string;
  fileId?: string | null;
  filename?: string;
  ext?: string;
}

export interface SaveResourceResult {
  localPath: string;
  fingerprint: string;
  deduplicated: boolean;
  level?: 1 | 2;
}

export interface DownloadResourceOptions {
  url?: string;
  fileId: string;
  busid?: number;
  filename?: string;
  subType?: number;
  isSticker?: boolean;
  type?: 'image' | 'sticker' | 'files' | 'file';
  sessionId?: string;
}

/**
 * 根据文件头魔数推断文件扩展名
 * 支持: GIF (GIF89a/GIF87a), PNG (\x89PNG), JPEG (\xFF\xD8), WebP (RIFF....WEBP)
 */
export function detectBufferExt(buffer: Buffer): string | undefined {
  if (!buffer || buffer.length < 2) return undefined;

  // GIF87a / GIF89a
  if (buffer.length >= 6) {
    const header6 = buffer.toString('ascii', 0, 6);
    if (header6 === 'GIF89a' || header6 === 'GIF87a') {
      return 'gif';
    }
  }

  // PNG (\x89PNG)
  if (
    buffer.length >= 4 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 && // P
    buffer[2] === 0x4e && // N
    buffer[3] === 0x47    // G
  ) {
    return 'png';
  }

  // JPEG (\xFF\xD8)
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    return 'jpg';
  }

  // WebP (RIFF....WEBP)
  if (
    buffer.length >= 12 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'webp';
  }

  return undefined;
}

export class MediaStorageManager {
  public readonly downloadRoot: string;
  public readonly ttlDays: number;
  private db: MessageDatabase | null;

  constructor(options: MediaStorageOptions = {}) {
    const dshHome = resolveDshPath(options.dshHome || process.env.DSH_HOME, undefined, '');
    this.downloadRoot = resolveDshPath(dshHome, options.downloadDir, DEFAULT_DOWNLOAD_ROOT);
    this.ttlDays = options.ttlDays ?? 7;
    this.db = options.db || null;
  }

  setDatabase(db: MessageDatabase): void {
    this.db = db;
  }

  getDownloadDir(type: 'image' | 'sticker' | 'files' | 'file', sessionId = 'common'): string {
    const normalizedType = type === 'file' ? 'files' : type;
    return path.join(this.downloadRoot, normalizedType, sessionId);
  }

  computeHash(buffer: Buffer): string {
    return crypto.createHash('sha256').update(buffer).digest('hex');
  }

  /**
   * 两级去重并落盘保存 Buffer 数据
   */
  async saveBuffer(buffer: Buffer, options: SaveResourceOptions = {}): Promise<SaveResourceResult> {
    const sessionId = options.sessionId || 'common';
    const type = options.type === 'file' ? 'files' : options.type || 'image';

    // 1. 一级去重: file_id 查库
    if (options.fileId && this.db) {
      const record = this.db.getByFileId(options.fileId);
      if (record?.local_path && fs.existsSync(record.local_path)) {
        return {
          localPath: record.local_path,
          fingerprint: record.fingerprint || '',
          deduplicated: true,
          level: 1,
        };
      }
    }

    // 2. 二级去重: SHA-256 指纹去重
    const fingerprint = this.computeHash(buffer);
    const detectedExt = detectBufferExt(buffer);

    if (this.db) {
      const record = this.db.getByFingerprint(fingerprint);
      if (record?.local_path && fs.existsSync(record.local_path)) {
        let validPath = record.local_path;
        // 自动自愈：若历史已落盘的文件后缀与真实魔数不一致（如历史假 .jpg 实为 .png），自动重命名纠偏
        if (detectedExt && (type === 'image' || type === 'sticker')) {
          const currentExt = path.extname(validPath).replace(/^\./, '').toLowerCase();
          if (currentExt && currentExt !== detectedExt) {
            const correctedPath = validPath.slice(0, -currentExt.length) + detectedExt;
            try {
              await fsp.rename(validPath, correctedPath);
              validPath = correctedPath;
              this.db.updateLocalPathByFileId(record.file_id || options.fileId || '', correctedPath, fingerprint);
            } catch {}
          }
        }
        if (options.fileId) {
          try {
            this.db.updateLocalPathByFileId(options.fileId, validPath, fingerprint);
          } catch {}
        }
        return {
          localPath: validPath,
          fingerprint,
          deduplicated: true,
          level: 2,
        };
      }
    }

    // 3. 落盘写入文件
    // 魔数优先：真实字节流魔数是唯一客观标准，优先于外部传入的伪后缀（如 QQ/NapCat 默认附带的 .jpg）；
    // 仅当魔数无法识别（如非图片未知格式）时，才回退 options.ext 或默认扩展名。
    const ext = (detectedExt || options.ext || (type === 'image' || type === 'sticker' ? 'png' : 'dat'))
      .replace(/^\./, '')
      .toLowerCase();
    const targetDir = this.getDownloadDir(type, sessionId);
    await fsp.mkdir(targetDir, { recursive: true });

    let fileName = options.filename;
    if (!fileName) {
      if (type === 'image' || type === 'sticker') {
        fileName = `${fingerprint}.${ext}`;
      } else {
        fileName = `${options.fileId || fingerprint}.${ext}`;
      }
    } else if ((type === 'image' || type === 'sticker') && detectedExt) {
      const parsed = path.parse(fileName);
      if (parsed.ext.replace(/^\./, '').toLowerCase() !== detectedExt) {
        fileName = `${parsed.name}.${detectedExt}`;
      }
    }

    const targetPath = path.join(targetDir, fileName);
    await fsp.writeFile(targetPath, buffer);

    if (options.fileId && this.db) {
      this.db.updateLocalPathByFileId(options.fileId, targetPath, fingerprint);
    }

    return {
      localPath: targetPath,
      fingerprint,
      deduplicated: false,
    };
  }

  /**
   * 从 URL 或现有本地路径下载并落盘
   */
  async downloadAndSave(
    urlOrPath: string,
    options: SaveResourceOptions = {}
  ): Promise<SaveResourceResult> {
    // 1. 一级去重先行校验
    if (options.fileId && this.db) {
      const record = this.db.getByFileId(options.fileId);
      if (record?.local_path && fs.existsSync(record.local_path)) {
        return {
          localPath: record.local_path,
          fingerprint: record.fingerprint || '',
          deduplicated: true,
          level: 1,
        };
      }
    }

    let buffer: Buffer;

    // 2. 处理本地路径或 file:// URI
    if (urlOrPath.startsWith('file://')) {
      const localFilePath = urlOrPath.replace(/^file:\/\//, '');
      buffer = await fsp.readFile(localFilePath);
    } else if (urlOrPath.startsWith('/') || (process.platform === 'win32' && /^[a-zA-Z]:\\/.test(urlOrPath))) {
      if (fs.existsSync(urlOrPath)) {
        buffer = await fsp.readFile(urlOrPath);
      } else {
        throw new Error(`本地源文件不存在: ${urlOrPath}`);
      }
    } else if (/^https?:\/\//i.test(urlOrPath)) {
      // 3. HTTP(S) 下载
      const response = await fetch(urlOrPath);
      if (!response.ok) {
        throw new Error(`HTTP 下载失败 (status: ${response.status}): ${urlOrPath}`);
      }
      const arrayBuffer = await response.arrayBuffer();
      buffer = Buffer.from(arrayBuffer);
    } else {
      throw new Error(`不支持的 URL 格式: ${urlOrPath}`);
    }

    return this.saveBuffer(buffer, options);
  }

  /**
   * 7 天 TTL 清理任务
   */
  async cleanExpired(ttlDays = this.ttlDays): Promise<{ deletedFiles: number; freedBytes: number }> {
    return cleanExpiredMedia(this.downloadRoot, ttlDays, this.db || undefined);
  }
}

/**
 * 递归扫描并清理过期媒体文件
 */
export async function cleanExpiredMedia(
  downloadRoot: string,
  ttlDays = 7,
  db?: MessageDatabase
): Promise<{ deletedFiles: number; freedBytes: number }> {
  let deletedFiles = 0;
  let freedBytes = 0;
  const ttlMs = ttlDays * 24 * 60 * 60 * 1000;
  const now = Date.now();

  if (!fs.existsSync(downloadRoot)) {
    return { deletedFiles, freedBytes };
  }

  const walkAndClean = async (dir: string): Promise<void> => {
    let entries: fs.Dirent[] = [];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walkAndClean(fullPath);
        const remaining = await fsp.readdir(fullPath).catch(() => ['non-empty']);
        if (remaining.length === 0) {
          await fsp.rmdir(fullPath).catch(() => {});
        }
      } else if (entry.isFile()) {
        try {
          const stat = await fsp.stat(fullPath);
          if (now - stat.mtimeMs > ttlMs) {
            await fsp.unlink(fullPath);
            deletedFiles++;
            freedBytes += stat.size;
            if (db) {
              db.clearLocalPath(fullPath);
            }
          }
        } catch {}
      }
    }
  };

  await walkAndClean(downloadRoot);
  return { deletedFiles, freedBytes };
}

/**
 * 启动媒体 TTL 清理定时任务
 */
export function startMediaCleanupTask(
  ctx: Context | any,
  manager: MediaStorageManager,
  intervalMs = 24 * 60 * 60 * 1000
): () => void {
  const timer = setInterval(() => {
    manager.cleanExpired().catch((err) => {
      ctx.logger?.error?.('[MediaCleanup] 定时清理任务执行异常:', err);
    });
  }, intervalMs);

  const stop = () => {
    clearInterval(timer);
  };

  if (typeof ctx?.on === 'function') {
    ctx.on('dispose', stop);
  }

  return stop;
}
