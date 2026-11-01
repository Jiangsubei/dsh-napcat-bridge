/**
 * src/storage/slang-migration.ts
 * 负责在插件启动时平滑迁移存量黑话 Markdown 文件 (.dsh/napcat/slang/slang.md) 至 SQLite 数据库。
 * 遵循原则：
 * 1. 启动时自动将现有的标题+释义+例句平滑迁移到 SQLite 表；
 * 2. 存量词条标签 (tags) 保持为空，不通过程序自作聪明地机械提取，留待后续模型/用户在自然交互中维护；
 * 3. 绝不自动删除旧文件夹、旧目录及旧 Markdown 文件，保留物理资产安全底线。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { MessageDatabase } from './database.js';
import { resolveDshPath } from '../utils/path.js';
import { DEFAULT_SLANG_STORAGE_PATH } from '../constants/index.js';

export interface SlangMigrationOptions {
  db: MessageDatabase;
  dshHome?: string;
  storagePath?: string;
}

export interface SlangMigrationResult {
  migratedCount: number;
  totalFound: number;
}

/**
 * 解析紧凑 Markdown 中的旧版黑话词条
 * 格式: - **{term}**：{definition}（例：{example}）
 */
export function parseLegacySlangMarkdown(content: string): Array<{
  term: string;
  definition: string;
  example: string;
}> {
  if (!content || !content.trim()) return [];
  const lines = content.split('\n');
  const entries: Array<{ term: string; definition: string; example: string }> = [];
  const regex = /^\s*-\s*\*\*(.+?)\*\*\s*[:：]\s*(.+?)(?:[（(]例[:：]?\s*(.+?)[)）])?\s*$/;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(regex);
    if (match) {
      entries.push({
        term: match[1].trim(),
        definition: match[2].trim(),
        example: match[3]?.trim() || '',
      });
    }
  }
  return entries;
}

/**
 * 执行黑话存量数据平滑迁移
 */
export function migrateSlangStorage(options: SlangMigrationOptions): SlangMigrationResult {
  const dshHome = options.dshHome || process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const targetPath = resolveDshPath(dshHome, options.storagePath, DEFAULT_SLANG_STORAGE_PATH);

  if (!fs.existsSync(targetPath)) {
    return { migratedCount: 0, totalFound: 0 };
  }

  let content = '';
  try {
    content = fs.readFileSync(targetPath, 'utf-8');
  } catch {
    return { migratedCount: 0, totalFound: 0 };
  }

  const legacyEntries = parseLegacySlangMarkdown(content);
  let migratedCount = 0;

  for (const entry of legacyEntries) {
    if (!entry.term) continue;
    // 幂等校验：数据库中已存在则跳过
    const existing = options.db.getSlangEntry(entry.term, false);
    if (!existing) {
      try {
        options.db.insertSlangEntry({
          term: entry.term,
          tags: '', // 留空，不机械提取标签，留给模型后续维护
          definition: entry.definition,
          example: entry.example,
        });
        migratedCount++;
      } catch {
        // 忽略单条写入冲突异常
      }
    }
  }

  return {
    migratedCount,
    totalFound: legacyEntries.length,
  };
}
