/**
 * dsh-napcat-bridge: 黑话存储管理器 (SlangStorage)
 * 管理全局黑话 Markdown 文档 (默认 .dsh/napcat/slang/slang.md) 的读写、解析、原子落盘与字符预算控制。
 */

import * as fsSync from 'node:fs';
import { promises as fs } from 'node:fs';
import { atomicWriteFile } from '../utils/atomic-write.js';
import { DEFAULT_SLANG_BUDGET_CHARS, DEFAULT_SLANG_STORAGE_PATH } from '../constants/index.js';
import { resolveDshPath } from '../utils/path.js';
import type { SlangEntry } from '../types/index.js';

/**
 * 解析紧凑 Markdown 中的黑话词条
 * 标准格式: - **{term}**：{definition}（例：{example}）
 */
export function parseSlangMarkdown(content: string): SlangEntry[] {
  if (!content || !content.trim()) return [];
  const lines = content.split('\n');
  const entries: SlangEntry[] = [];
  // 匹配 - **term**：definition（例：example）
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
 * 将黑话结构化数组格式化为紧凑 Markdown 单行列表
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

export class SlangStorage {
  private filePath: string;
  private budgetChars: number | (() => number);
  private cache: SlangEntry[] | null = null;
  private rawContentCache: string | null = null;
  private updateLock: Promise<any> = Promise.resolve();

  constructor(
    storagePath?: string,
    budgetChars: number | (() => number) = DEFAULT_SLANG_BUDGET_CHARS,
    dshHome?: string
  ) {
    this.budgetChars = budgetChars;
    this.filePath = resolveDshPath(dshHome, storagePath, DEFAULT_SLANG_STORAGE_PATH);
  }

  public getFilePath(): string {
    return this.filePath;
  }

  public getBudgetChars(): number {
    return typeof this.budgetChars === 'function' ? this.budgetChars() : this.budgetChars;
  }

  public invalidateCache(): void {
    this.cache = null;
    this.rawContentCache = null;
  }

  /**
   * 同步加载与解析文件内容（缓存优先）
   */
  public getEntriesSync(): SlangEntry[] {
    if (this.cache !== null) {
      return this.cache;
    }
    try {
      if (fsSync.existsSync(this.filePath)) {
        const content = fsSync.readFileSync(this.filePath, 'utf-8');
        this.rawContentCache = content;
        this.cache = parseSlangMarkdown(content);
        return this.cache;
      }
    } catch {
      // 容错降级
    }
    this.rawContentCache = '';
    this.cache = [];
    return this.cache;
  }

  /**
   * 获取用于 Prompt 注入的原始 Markdown 字符串
   */
  public getRawMarkdownSync(): string {
    if (this.rawContentCache !== null) {
      return this.rawContentCache;
    }
    try {
      if (fsSync.existsSync(this.filePath)) {
        this.rawContentCache = fsSync.readFileSync(this.filePath, 'utf-8');
        return this.rawContentCache;
      }
    } catch {}
    this.rawContentCache = '';
    return '';
  }

  /**
   * 异步获取全部词条
   */
  public async getEntries(): Promise<SlangEntry[]> {
    if (this.cache !== null) {
      return this.cache;
    }
    try {
      const content = await fs.readFile(this.filePath, 'utf-8');
      this.rawContentCache = content;
      this.cache = parseSlangMarkdown(content);
      return this.cache;
    } catch {
      this.rawContentCache = '';
      this.cache = [];
      return this.cache;
    }
  }

  /**
   * 校验格式化后的内容是否超出字符预算
   */
  private checkBudget(formattedMd: string): void {
    const limit = this.getBudgetChars();
    if (formattedMd.length > limit) {
      throw new Error(
        `黑话知识库已达字符预算上限 (${formattedMd.length}/${limit})，请先使用 manage_slang 删除过时条目或合并简化现有条目后再添加。`
      );
    }
  }

  /**
   * 记录新词条（若已存在同名词条则自动更新）
   */
  public async recordEntry(params: {
    term: string;
    definition: string;
    example: string;
  }): Promise<{
    action: 'created' | 'updated';
    entry: SlangEntry;
    charCount: number;
    budgetChars: number;
  }> {
    const cleanTerm = params.term.trim();
    const cleanDef = params.definition.trim();
    const cleanEx = params.example.trim();

    if (!cleanTerm) {
      throw new Error('词条名称不能为空');
    }
    if (!cleanDef) {
      throw new Error('词条释义不能为空');
    }

    return this.withLock(async () => {
      const entries = [...(await this.getEntries())];
      const existingIndex = entries.findIndex((e) => e.term === cleanTerm);

      let action: 'created' | 'updated' = 'created';
      const newEntry: SlangEntry = {
        term: cleanTerm,
        definition: cleanDef,
        example: cleanEx,
      };

      if (existingIndex >= 0) {
        entries[existingIndex] = newEntry;
        action = 'updated';
      } else {
        entries.push(newEntry);
      }

      const formatted = formatSlangMarkdown(entries);
      this.checkBudget(formatted);

      await atomicWriteFile(this.filePath, formatted, 'utf-8');
      this.cache = entries;
      this.rawContentCache = formatted;

      return {
        action,
        entry: newEntry,
        charCount: formatted.length,
        budgetChars: this.getBudgetChars(),
      };
    });
  }

  /**
   * 编辑已有词条（支持改名、改释义或改例句）
   */
  public async editEntry(
    term: string,
    updates: {
      newTerm?: string;
      definition?: string;
      example?: string;
    }
  ): Promise<SlangEntry> {
    const cleanTerm = term.trim();
    return this.withLock(async () => {
      const entries = [...(await this.getEntries())];
      const targetIndex = entries.findIndex((e) => e.term === cleanTerm);

      if (targetIndex < 0) {
        throw new Error(`未找到词条 "${cleanTerm}"`);
      }

      const existing = entries[targetIndex];
      const finalTerm = updates.newTerm?.trim() ? updates.newTerm.trim() : existing.term;
      const finalDef = updates.definition?.trim() ? updates.definition.trim() : existing.definition;
      const finalEx = updates.example !== undefined ? updates.example.trim() : existing.example;

      const updatedEntry: SlangEntry = {
        term: finalTerm,
        definition: finalDef,
        example: finalEx,
      };

      entries[targetIndex] = updatedEntry;

      const formatted = formatSlangMarkdown(entries);
      this.checkBudget(formatted);

      await atomicWriteFile(this.filePath, formatted, 'utf-8');
      this.cache = entries;
      this.rawContentCache = formatted;

      return updatedEntry;
    });
  }

  /**
   * 删除词条
   */
  public async deleteEntry(term: string): Promise<boolean> {
    const cleanTerm = term.trim();
    return this.withLock(async () => {
      const entries = [...(await this.getEntries())];
      const targetIndex = entries.findIndex((e) => e.term === cleanTerm);

      if (targetIndex < 0) {
        return false;
      }

      entries.splice(targetIndex, 1);
      const formatted = formatSlangMarkdown(entries);

      await atomicWriteFile(this.filePath, formatted, 'utf-8');
      this.cache = entries;
      this.rawContentCache = formatted;

      return true;
    });
  }

  /**
   * 检索/列出词条
   */
  public async listEntries(keyword?: string): Promise<SlangEntry[]> {
    const entries = await this.getEntries();
    if (!keyword || !keyword.trim()) {
      return entries;
    }
    const kw = keyword.trim().toLowerCase();
    return entries.filter(
      (e) =>
        e.term.toLowerCase().includes(kw) ||
        e.definition.toLowerCase().includes(kw) ||
        e.example.toLowerCase().includes(kw)
    );
  }

  /**
   * 获取当前存储状态统计
   */
  public getStats(): { total: number; charCount: number; budgetChars: number } {
    const entries = this.getEntriesSync();
    const raw = this.getRawMarkdownSync();
    return {
      total: entries.length,
      charCount: raw.length,
      budgetChars: this.getBudgetChars(),
    };
  }

  private withLock<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.updateLock.then(fn, fn);
    this.updateLock = next.then(
      () => {},
      () => {}
    );
    return next;
  }
}
