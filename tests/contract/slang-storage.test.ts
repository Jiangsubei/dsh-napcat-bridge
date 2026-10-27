import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  parseSlangMarkdown,
  formatSlangMarkdown,
  SlangStorage,
} from '../../src/slang/storage.js';
import type { SlangEntry } from '../../src/types/index.js';

describe('SlangStorage Contract Tests', () => {
  let tmpDir: string;
  let testFilePath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-slang-storage-test-'));
    testFilePath = path.join(tmpDir, 'slang.md');
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  describe('Markdown Parser & Formatter', () => {
    it('should parse empty or whitespace markdown into empty array', () => {
      expect(parseSlangMarkdown('')).toEqual([]);
      expect(parseSlangMarkdown('   \n\n  ')).toEqual([]);
    });

    it('should parse standard slang entries correctly', () => {
      const md = [
        '- **牢大**：指科比·布莱恩特，现多用于戏谑调侃。（例：想你了，牢大！）',
        '- **开香槟**：提前庆祝或半场开香槟导致翻车。（例：优势很大，但先别开香槟。）',
      ].join('\n');

      const entries = parseSlangMarkdown(md);
      expect(entries).toHaveLength(2);
      expect(entries[0]).toEqual({
        term: '牢大',
        definition: '指科比·布莱恩特，现多用于戏谑调侃。',
        example: '想你了，牢大！',
      });
      expect(entries[1]).toEqual({
        term: '开香槟',
        definition: '提前庆祝或半场开香槟导致翻车。',
        example: '优势很大，但先别开香槟。',
      });
    });

    it('should gracefully skip malformed lines or comment lines', () => {
      const md = [
        '# 黑话知识库',
        '一些说明文字',
        '- **有效词条**：释义内容。（例：例句内容）',
        '- 无效行没有冒号和粗体',
        '',
      ].join('\n');

      const entries = parseSlangMarkdown(md);
      expect(entries).toHaveLength(1);
      expect(entries[0].term).toBe('有效词条');
      expect(entries[0].definition).toBe('释义内容。');
      expect(entries[0].example).toBe('例句内容');
    });

    it('should format entries into standard compact markdown lines', () => {
      const entries: SlangEntry[] = [
        { term: '电子阳痿', definition: '买了游戏却不想玩的状态。', example: '下了一堆 Steam 游戏，结果电子阳痿了。' },
      ];
      const md = formatSlangMarkdown(entries);
      expect(md).toBe('- **电子阳痿**：买了游戏却不想玩的状态。（例：下了一堆 Steam 游戏，结果电子阳痿了。）\n');
    });
  });

  describe('SlangStorage CRUD Operations', () => {
    it('should initialize and return empty list when file does not exist', async () => {
      const storage = new SlangStorage(testFilePath, 5000);
      const entries = await storage.getEntries();
      expect(entries).toEqual([]);
      expect(storage.getEntriesSync()).toEqual([]);
      const stats = storage.getStats();
      expect(stats.total).toBe(0);
      expect(stats.charCount).toBe(0);
      expect(stats.budgetChars).toBe(5000);
    });

    it('should record/add entry and persist to file atomically', async () => {
      const storage = new SlangStorage(testFilePath, 5000);
      const res = await storage.recordEntry({
        term: '牢大',
        definition: '指科比，戏谑用法。',
        example: '想你了，牢大！',
      });

      expect(res.action).toBe('created');
      expect(res.entry.term).toBe('牢大');

      // 验证落盘文件存在且内容正确
      expect(fs.existsSync(testFilePath)).toBe(true);
      const rawContent = fs.readFileSync(testFilePath, 'utf-8');
      expect(rawContent).toContain('**牢大**');

      // 再次读取
      const entries = await storage.getEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0].term).toBe('牢大');
    });

    it('should update existing entry when term already exists in recordEntry', async () => {
      const storage = new SlangStorage(testFilePath, 5000);
      await storage.recordEntry({
        term: '牢大',
        definition: '旧释义',
        example: '旧例句',
      });

      const res = await storage.recordEntry({
        term: '牢大',
        definition: '新释义',
        example: '新例句',
      });

      expect(res.action).toBe('updated');
      expect(res.entry.definition).toBe('新释义');

      const entries = await storage.getEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0].definition).toBe('新释义');
      expect(entries[0].example).toBe('新例句');
    });

    it('should edit entry with rename support and partial update', async () => {
      const storage = new SlangStorage(testFilePath, 5000);
      await storage.recordEntry({
        term: '原始词',
        definition: '原始释义',
        example: '原始例句',
      });

      const updated = await storage.editEntry('原始词', {
        newTerm: '更名词',
        definition: '更新后释义',
      });

      expect(updated.term).toBe('更名词');
      expect(updated.definition).toBe('更新后释义');
      expect(updated.example).toBe('原始例句');

      const entries = await storage.getEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0].term).toBe('更名词');
    });

    it('should throw error when editing non-existent entry', async () => {
      const storage = new SlangStorage(testFilePath, 5000);
      await expect(storage.editEntry('不存在的词', { definition: 'xxx' })).rejects.toThrow('未找到');
    });

    it('should delete existing entry and atomic update file', async () => {
      const storage = new SlangStorage(testFilePath, 5000);
      await storage.recordEntry({ term: '词1', definition: '释义1', example: '例句1' });
      await storage.recordEntry({ term: '词2', definition: '释义2', example: '例句2' });

      expect(await storage.getEntries()).toHaveLength(2);

      const deleted = await storage.deleteEntry('词1');
      expect(deleted).toBe(true);

      const entries = await storage.getEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0].term).toBe('词2');
    });

    it('should return false when deleting non-existent entry', async () => {
      const storage = new SlangStorage(testFilePath, 5000);
      const deleted = await storage.deleteEntry('不存在');
      expect(deleted).toBe(false);
    });

    it('should filter entries with keyword in listEntries', async () => {
      const storage = new SlangStorage(testFilePath, 5000);
      await storage.recordEntry({ term: '牢大', definition: '科比梗', example: '想你了' });
      await storage.recordEntry({ term: '开香槟', definition: '提前庆祝', example: '先别开' });
      await storage.recordEntry({ term: '电子阳痿', definition: '游戏倦怠', example: '不想打游戏' });

      const all = await storage.listEntries();
      expect(all).toHaveLength(3);

      const filteredByTerm = await storage.listEntries('香槟');
      expect(filteredByTerm).toHaveLength(1);
      expect(filteredByTerm[0].term).toBe('开香槟');

      const filteredByDef = await storage.listEntries('游戏');
      expect(filteredByDef).toHaveLength(1);
      expect(filteredByDef[0].term).toBe('电子阳痿');
    });
  });

  describe('Budget Enforcement', () => {
    it('should reject adding entry when total characters exceed budgetChars', async () => {
      // 设定极小的预算: 50 字符
      const storage = new SlangStorage(testFilePath, 50);

      // 第一条 ~40 字符，成功
      await storage.recordEntry({
        term: '简短词',
        definition: '简短释义',
        example: '简短例句',
      });

      // 第二条加入后总字符必超 50
      await expect(
        storage.recordEntry({
          term: '第二个词',
          definition: '这个释义比较长，会导致总字符数超过预算上限',
          example: '测试超预算用例',
        })
      ).rejects.toThrow(/字符预算上限/);

      // 验证第二条未写入
      const entries = await storage.getEntries();
      expect(entries).toHaveLength(1);
    });
  });
});
