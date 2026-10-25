/**
 * dsh-napcat-bridge: 后台表情包整理 Agent (Face Curator)
 * 定期扫描已落盘的群聊/私聊图片目录，交由模型进行表情包判定与语义打标。
 *
 * 核心设计准则：
 * 1. 双重门控: face_enabled && face_auto_curate，关闭时彻底静默；
 * 2. 不做模型能力硬嗅探: 纯文本模型输出 nothing to save 时静默安全退出；
 * 3. 纯粹资产归档: 坚决不建 skill、不写记忆；
 * 4. 去重与防重扫: 已入库的 MD5 直接记录，避免重复扫描。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type { MessageDatabase } from '../storage/database.js';
import type { BridgePluginConfig } from '../types/index.js';

export interface FaceCuratorOptions {
  db: MessageDatabase;
  faceStoreDir?: string;
  imageScanDirs?: string[];
  llmService?: any;
  memoryStorage?: any;
  config?: () => BridgePluginConfig;
}

export interface CurateReport {
  scanned: number;
  adopted: number;
  skipped: number;
}

export class FaceCurator {
  private isRunning = false;

  constructor(private readonly options: FaceCuratorOptions) {}

  /**
   * 执行单次表情包扫描与提炼任务
   */
  async curateOnce(): Promise<CurateReport> {
    const report: CurateReport = { scanned: 0, adopted: 0, skipped: 0 };

    // 1. 双重门控检查
    const cfg = this.options.config ? this.options.config() : {};
    if (!cfg.face_enabled || !cfg.face_auto_curate) {
      return report;
    }

    if (this.isRunning) {
      return report;
    }
    this.isRunning = true;

    try {
      const scanDirs = this.options.imageScanDirs || [];
      const storeDir = this.options.faceStoreDir || path.resolve('.dsh/napcat/faces');
      fs.mkdirSync(storeDir, { recursive: true });

      // 收集待扫描的图片文件
      const imageFiles: string[] = [];
      for (const dir of scanDirs) {
        if (!fs.existsSync(dir)) continue;
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isFile()) {
            const ext = path.extname(entry.name).toLowerCase();
            if (['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(ext)) {
              imageFiles.push(path.join(dir, entry.name));
            }
          }
        }
      }

      for (const filePath of imageFiles) {
        report.scanned++;

        let fileBuf: Buffer;
        try {
          fileBuf = fs.readFileSync(filePath);
        } catch {
          report.skipped++;
          continue;
        }

        const md5 = crypto.createHash('md5').update(fileBuf).digest('hex');
        const ext = path.extname(filePath).replace(/^\./, '').toLowerCase() || 'png';

        // 检查数据库是否已存在该表情
        const existing = this.options.db.getFaceByMd5(md5);
        if (existing && existing.enabled) {
          // 已存在且启用，跳过
          report.skipped++;
          continue;
        }

        // 调用模型进行图片分析
        let analysis: any = null;
        if (this.options.llmService && typeof this.options.llmService.analyzeImage === 'function') {
          try {
            analysis = await this.options.llmService.analyzeImage(filePath);
          } catch {
            analysis = null;
          }
        }

        // 判定结果
        if (typeof analysis === 'string') {
          const lower = analysis.toLowerCase().trim();
          if (lower.includes('nothing to save') || lower.includes('无可保存')) {
            report.skipped++;
            continue;
          }
        }

        if (analysis && typeof analysis === 'object' && analysis.is_face && Array.isArray(analysis.tags)) {
          const targetFile = path.join(storeDir, `${md5}.${ext}`);
          try {
            if (!fs.existsSync(targetFile)) {
              fs.copyFileSync(filePath, targetFile);
            }

            const faceId = `face_${md5.slice(0, 8)}`;
            this.options.db.insertFace(
              {
                id: faceId,
                file_path: targetFile,
                md5,
                source: 'curate',
                tags: analysis.tags,
                mood: typeof analysis.mood === 'string' ? analysis.mood.trim() : undefined,
                enabled: true,
                size: fileBuf.length,
                format: ext,
              },
              {
                max: cfg.face_store_max,
                evictPolicy: cfg.face_evict_policy,
              }
            );
            report.adopted++;
          } catch {
            report.skipped++;
          }
        } else {
          report.skipped++;
        }
      }
    } finally {
      this.isRunning = false;
    }

    return report;
  }
}
