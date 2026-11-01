/**
 * dsh-napcat-bridge: 黑话存储管理器 (SlangStorage)
 * 基于 SQLite (slang_entries 表) 管理全局黑话的分层存储、LRU 按查淘汰与 L1 常驻上下文生成。
 * 纯粹四参数体系：标题 (term) + 标签 (tags) + 释义 (definition) + 例句 (example)。
 */

import { MessageDatabase } from '../storage/database.js';
import { DEFAULT_SLANG_MAX_ENTRIES, DEFAULT_SLANG_EVICT_POLICY, DEFAULT_DATABASE_PATH } from '../constants/index.js';
import { resolveDshPath } from '../utils/path.js';
import type { SlangEntry } from '../types/index.js';

/**
 * 解析紧凑 Markdown 中的黑话词条（向后兼容旧格式解析与迁移）
 * 标准格式: - **{term}**：{definition}（例：{example}）
 */
export function parseSlangMarkdown(content: string): SlangEntry[] {
  if (!content || !content.trim()) return [];
  const lines = content.split('\n');
  const entries: SlangEntry[] = [];
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
 * 将黑话结构化数组格式化为紧凑 Markdown 单行列表（用于向后兼容或导出）
 */
export function formatSlangMarkdown(entries: SlangEntry[]): string {
  if (!entries || entries.length === 0) return '';
  return (
    entries
      .map((e) => {
        const examplePart = e.example ? `（例：${e.example}）` : '';
        return `- **${e.term}**：${e.definition}${examplePart}`;
      })
      .join('\n') + '\n'
  );
}

/**
 * 将轻量条目数组格式化为 L1 常驻 Prompt 紧凑索引
 * 格式: - 主标题：标签（简要概述）
 */
export function formatSlangContextIndex(
  entries: Array<{ term: string; tags?: string }>
): string {
  if (!entries || entries.length === 0) return '';
  const lines: string[] = [];
  for (const item of entries) {
    const tagsPart = item.tags && item.tags.trim() ? `：${item.tags.trim()}` : '';
    lines.push(`- ${item.term}${tagsPart}`);
  }
  return lines.join('\n');
}

export class SlangStorage {
  private db: MessageDatabase;
  private maxEntries: number | (() => number);
  private evictPolicy: ('reject' | 'evict_lru') | (() => 'reject' | 'evict_lru');
  private ownDb = false;

  constructor(
    dbOrPath?: MessageDatabase | string,
    maxEntries: number | (() => number) = DEFAULT_SLANG_MAX_ENTRIES,
    evictPolicy: ('reject' | 'evict_lru') | (() => 'reject' | 'evict_lru') = DEFAULT_SLANG_EVICT_POLICY,
    dshHome?: string
  ) {
    this.maxEntries = maxEntries;
    this.evictPolicy = evictPolicy;

    if (dbOrPath && typeof (dbOrPath as any).getSlangEntry === 'function') {
      this.db = dbOrPath as MessageDatabase;
    } else {
      const dbPath = typeof dbOrPath === 'string' && dbOrPath
        ? (dbOrPath.endsWith('.sqlite') || dbOrPath.endsWith('.db')
            ? resolveDshPath(dshHome, dbOrPath)
            : resolveDshPath(dshHome, undefined, DEFAULT_DATABASE_PATH))
        : resolveDshPath(dshHome, undefined, DEFAULT_DATABASE_PATH);
      this.db = new MessageDatabase(dbPath);
      this.ownDb = true;
    }
  }

  public getDatabase(): MessageDatabase {
    return this.db;
  }

  public getMaxEntries(): number {
    return typeof this.maxEntries === 'function' ? this.maxEntries() : this.maxEntries;
  }

  public getEvictPolicy(): 'reject' | 'evict_lru' {
    return typeof this.evictPolicy === 'function' ? this.evictPolicy() : this.evictPolicy;
  }

  /**
   * 按标题查询词条详情（自增查询计数）
   */
  public async queryEntry(term: string): Promise<SlangEntry | null> {
    return this.db.getSlangEntry(term, true);
  }

  /**
   * 记录新词条（若已存在同名词条则自动更新，容量超限时根据策略拒绝或按查淘汰）
   */
  public async recordEntry(params: {
    term: string;
    tags: string;
    definition: string;
    example: string;
  }): Promise<{
    action: 'created' | 'updated';
    entry: SlangEntry;
    total: number;
    maxEntries: number;
    evictedTerm?: string;
  }> {
    const cleanTerm = params.term.trim();
    const cleanDef = params.definition.trim();
    const cleanTags = params.tags.trim();
    const cleanEx = params.example.trim();

    if (!cleanTerm) {
      throw new Error('词条名称不能为空');
    }
    if (!cleanTags) {
      throw new Error('词条标签（简要概述）不能为空');
    }
    if (!cleanDef) {
      throw new Error('词条释义不能为空');
    }
    if (!cleanEx) {
      throw new Error('典型例句不能为空');
    }

    const existing = this.db.getSlangEntry(cleanTerm, false);
    if (existing) {
      const updated = this.db.updateSlangEntry(cleanTerm, {
        tags: cleanTags,
        definition: cleanDef,
        example: cleanEx,
      });
      return {
        action: 'updated',
        entry: updated!,
        total: this.db.getSlangCount(),
        maxEntries: this.getMaxEntries(),
      };
    }

    // 新增前容量检查
    const currentCount = this.db.getSlangCount();
    const limit = this.getMaxEntries();
    let evictedTerm: string | undefined;

    if (currentCount >= limit) {
      const policy = this.getEvictPolicy();
      if (policy === 'reject') {
        throw new Error(
          `黑话知识库已达条数上限 (${currentCount}/${limit})，请先使用 manage_slang 删除过时条目后再添加。`
        );
      } else {
        // evict_lru：淘汰查询次数最少的条目
        const evicted = this.db.evictSlangEntryLru();
        if (evicted) {
          evictedTerm = evicted.term;
        }
      }
    }

    const created = this.db.insertSlangEntry({
      term: cleanTerm,
      tags: cleanTags,
      definition: cleanDef,
      example: cleanEx,
    });

    return {
      action: 'created',
      entry: created,
      total: this.db.getSlangCount(),
      maxEntries: limit,
      evictedTerm,
    };
  }

  /**
   * 编辑已有词条（支持改名、改标签、改释义或改例句）
   */
  public async editEntry(
    term: string,
    updates: {
      newTerm?: string;
      new_term?: string;
      tags?: string;
      definition?: string;
      example?: string;
    }
  ): Promise<SlangEntry> {
    const cleanTerm = term.trim();
    const updated = this.db.updateSlangEntry(cleanTerm, {
      new_term: updates.new_term || updates.newTerm,
      tags: updates.tags,
      definition: updates.definition,
      example: updates.example,
    });

    if (!updated) {
      throw new Error(`未找到词条 "${cleanTerm}"`);
    }
    return updated;
  }

  /**
   * 删除词条
   */
  public async deleteEntry(term: string): Promise<boolean> {
    return this.db.deleteSlangEntry(term.trim());
  }

  /**
   * 检索/列出词条（支持按标题、标签、释义、例句模糊反查，支持可选 limit）
   */
  public async listEntries(keyword?: string, limit?: number): Promise<SlangEntry[]> {
    return this.db.querySlangEntries({ keyword, limit }).entries;
  }

  /**
   * 获取全部词条
   */
  public async getEntries(): Promise<SlangEntry[]> {
    return this.db.querySlangEntries().entries;
  }

  public getEntriesSync(): SlangEntry[] {
    return this.db.querySlangEntries().entries;
  }

  /**
   * 获取供 L1 Prompt 注入的常驻紧凑索引
   */
  public getRawMarkdownSync(): string {
    const items = this.db.getAllSlangEntriesForContext();
    return formatSlangContextIndex(items);
  }

  /**
   * 获取当前存储状态统计
   */
  public getStats(): { total: number; maxEntries: number; evictPolicy: 'reject' | 'evict_lru' } {
    return {
      total: this.db.getSlangCount(),
      maxEntries: this.getMaxEntries(),
      evictPolicy: this.getEvictPolicy(),
    };
  }

  public close(): void {
    if (this.ownDb) {
      try {
        this.db.close();
      } catch {}
    }
  }
}
