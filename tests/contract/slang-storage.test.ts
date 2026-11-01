import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  parseSlangMarkdown,
  formatSlangMarkdown,
  formatSlangContextIndex,
  SlangStorage,
} from '../../src/slang/storage.js';
import { MessageDatabase } from '../../src/storage/database.js';
import { migrateSlangStorage } from '../../src/storage/slang-migration.js';
import type { SlangEntry } from '../../src/types/index.js';

describe('SlangStorage Contract Tests', () => {
  let tmpDir: string;
  let testDbPath: string;
  let db: MessageDatabase;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-slang-storage-test-'));
    testDbPath = path.join(tmpDir, 'test_messages.sqlite');
    db = new MessageDatabase(testDbPath);
  });

  afterEach(() => {
    try {
      db.close();
    } catch {}
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

    it('should format L1 context index with terms and tags', () => {
      const indexText = formatSlangContextIndex([
        { term: '开香槟', tags: '提前庆祝、反转被打脸' },
        { term: '电子阳痿', tags: '游戏倦怠、买而不玩' },
        { term: '旧梗无标签' },
      ]);
      expect(indexText).toContain('- 开香槟：提前庆祝、反转被打脸');
      expect(indexText).toContain('- 电子阳痿：游戏倦怠、买而不玩');
      expect(indexText).toContain('- 旧梗无标签');
    });
  });

  describe('SlangStorage CRUD Operations', () => {
    it('should initialize and return empty list when db has no entries', async () => {
      const storage = new SlangStorage(db, 300, 'reject');
      const entries = await storage.getEntries();
      expect(entries).toEqual([]);
      expect(storage.getEntriesSync()).toEqual([]);
      const stats = storage.getStats();
      expect(stats.total).toBe(0);
      expect(stats.maxEntries).toBe(300);
      expect(stats.evictPolicy).toBe('reject');
    });

    it('should enforce 4 required parameters: term, tags, definition, example', async () => {
      const storage = new SlangStorage(db, 300, 'reject');
      await expect(storage.recordEntry({
        term: '',
        tags: '标签',
        definition: '释义',
        example: '例句',
      })).rejects.toThrow('词条名称不能为空');

      await expect(storage.recordEntry({
        term: '词',
        tags: '',
        definition: '释义',
        example: '例句',
      })).rejects.toThrow('词条标签（简要概述）不能为空');

      await expect(storage.recordEntry({
        term: '词',
        tags: '标签',
        definition: '',
        example: '例句',
      })).rejects.toThrow('词条释义不能为空');

      await expect(storage.recordEntry({
        term: '词',
        tags: '标签',
        definition: '释义',
        example: '',
      })).rejects.toThrow('典型例句不能为空');
    });

    it('should record/add entry with 4 required fields and persist to SQLite', async () => {
      const storage = new SlangStorage(db, 300, 'reject');
      const res = await storage.recordEntry({
        term: '牢大',
        tags: '科比、坠机梗',
        definition: '指科比，戏谑用法。',
        example: '想你了，牢大！',
      });

      expect(res.action).toBe('created');
      expect(res.entry.term).toBe('牢大');
      expect(res.entry.tags).toBe('科比、坠机梗');

      // 再次读取校验
      const entries = await storage.getEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0].term).toBe('牢大');
      expect(entries[0].tags).toBe('科比、坠机梗');

      // 验证 L1 常驻 Prompt 索引内容
      const rawPrompt = storage.getRawMarkdownSync();
      expect(rawPrompt).toContain('- 牢大：科比、坠机梗');
    });

    it('should update existing entry when term already exists in recordEntry', async () => {
      const storage = new SlangStorage(db, 300, 'reject');
      await storage.recordEntry({
        term: '牢大',
        tags: '旧标签',
        definition: '旧释义',
        example: '旧例句',
      });

      const res = await storage.recordEntry({
        term: '牢大',
        tags: '新标签',
        definition: '新释义',
        example: '新例句',
      });

      expect(res.action).toBe('updated');
      expect(res.entry.definition).toBe('新释义');
      expect(res.entry.tags).toBe('新标签');

      const entries = await storage.getEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0].definition).toBe('新释义');
      expect(entries[0].example).toBe('新例句');
    });

    it('should edit entry with rename support and partial update', async () => {
      const storage = new SlangStorage(db, 300, 'reject');
      await storage.recordEntry({
        term: '原始词',
        tags: '原始标签',
        definition: '原始释义',
        example: '原始例句',
      });

      const updated = await storage.editEntry('原始词', {
        new_term: '更名词',
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
      const storage = new SlangStorage(db, 300, 'reject');
      await expect(storage.editEntry('不存在的词', { definition: 'xxx' })).rejects.toThrow('未找到');
    });

    it('should delete existing entry from database', async () => {
      const storage = new SlangStorage(db, 300, 'reject');
      await storage.recordEntry({ term: '词1', tags: '标1', definition: '释义1', example: '例句1' });
      await storage.recordEntry({ term: '词2', tags: '标2', definition: '释义2', example: '例句2' });

      expect(await storage.getEntries()).toHaveLength(2);

      const deleted = await storage.deleteEntry('词1');
      expect(deleted).toBe(true);

      const entries = await storage.getEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0].term).toBe('词2');
    });

    it('should return false when deleting non-existent entry', async () => {
      const storage = new SlangStorage(db, 300, 'reject');
      const deleted = await storage.deleteEntry('不存在');
      expect(deleted).toBe(false);
    });

    it('should filter entries with keyword in listEntries', async () => {
      const storage = new SlangStorage(db, 300, 'reject');
      await storage.recordEntry({ term: '牢大', tags: '篮球', definition: '科比梗', example: '想你了' });
      await storage.recordEntry({ term: '开香槟', tags: '庆祝', definition: '提前庆祝', example: '先别开' });
      await storage.recordEntry({ term: '电子阳痿', tags: '游戏', definition: '游戏倦怠', example: '不想打游戏' });

      const all = await storage.listEntries();
      expect(all).toHaveLength(3);

      const filteredByTerm = await storage.listEntries('香槟');
      expect(filteredByTerm).toHaveLength(1);
      expect(filteredByTerm[0].term).toBe('开香槟');

      const filteredByDef = await storage.listEntries('游戏');
      expect(filteredByDef).toHaveLength(1);
      expect(filteredByDef[0].term).toBe('电子阳痿');
    });

    it('queryEntry should increment query_count and update last_queried_at', async () => {
      const storage = new SlangStorage(db, 300, 'reject');
      await storage.recordEntry({
        term: '开香槟',
        tags: '反转嘲讽',
        definition: '提前庆祝导致翻车',
        example: '优势很大，但先别开香槟',
      });

      // 初始查询次数为 0
      const initial = db.getSlangEntry('开香槟', false);
      expect(initial?.query_count).toBe(0);

      // 查询
      const q1 = await storage.queryEntry('开香槟');
      expect(q1?.term).toBe('开香槟');
      expect(q1?.query_count).toBe(1);
      expect(q1?.last_queried_at).toBeGreaterThan(0);

      const q2 = await storage.queryEntry('开香槟');
      expect(q2?.query_count).toBe(2);
    });
  });

  describe('Capacity and Eviction Policy (reject vs evict_lru)', () => {
    it('should reject adding entry when maxEntries is reached under reject policy', async () => {
      // 设定容量上限为 2
      const storage = new SlangStorage(db, 2, 'reject');

      await storage.recordEntry({ term: '词1', tags: '标1', definition: '释1', example: '例1' });
      await storage.recordEntry({ term: '词2', tags: '标2', definition: '释2', example: '例2' });

      // 第 3 条在 reject 策略下被拒绝
      await expect(
        storage.recordEntry({ term: '词3', tags: '标3', definition: '释3', example: '例3' })
      ).rejects.toThrow(/条数上限 \(2\/2\)/);

      const entries = await storage.getEntries();
      expect(entries).toHaveLength(2);
    });

    it('should evict least queried entry under evict_lru policy', async () => {
      // 设定容量上限为 2，策略为 evict_lru
      const storage = new SlangStorage(db, 2, 'evict_lru');

      await storage.recordEntry({ term: '冷门词', tags: '冷', definition: '没人查的词', example: '例1' });
      await storage.recordEntry({ term: '热门词', tags: '热', definition: '经常查的词', example: '例2' });

      // 模拟模型查询热门词
      await storage.queryEntry('热门词');
      await storage.queryEntry('热门词');

      // 插入第 3 条，应当自动淘汰冷门词 (query_count 为 0)
      const res = await storage.recordEntry({ term: '新词3', tags: '新', definition: '新释义', example: '新例3' });

      expect(res.action).toBe('created');
      expect(res.evictedTerm).toBe('冷门词');
      expect(res.total).toBe(2);

      const remaining = await storage.getEntries();
      const terms = remaining.map((e) => e.term);
      expect(terms).toContain('热门词');
      expect(terms).toContain('新词3');
      expect(terms).not.toContain('冷门词');
    });
  });

  describe('Legacy Markdown Migration', () => {
    it('should migrate legacy markdown entries into SQLite without deleting legacy files', () => {
      const legacyMdPath = path.join(tmpDir, 'slang.md');
      const legacyMdContent = [
        '- **老梗1**：旧释义1（例：旧例句1）',
        '- **老梗2**：旧释义2（例：旧例句2）',
      ].join('\n');
      fs.writeFileSync(legacyMdPath, legacyMdContent, 'utf-8');

      const result = migrateSlangStorage({
        db,
        dshHome: tmpDir,
        storagePath: legacyMdPath,
      });

      expect(result.migratedCount).toBe(2);
      expect(result.totalFound).toBe(2);

      // 验证 SQLite 中已入库，且 tags 保持为空字符串留给模型后续维护
      const entry1 = db.getSlangEntry('老梗1', false);
      expect(entry1).not.toBeNull();
      expect(entry1?.tags).toBe('');
      expect(entry1?.definition).toBe('旧释义1');
      expect(entry1?.example).toBe('旧例句1');

      // 验证物理旧文件完好保留，未被删除
      expect(fs.existsSync(legacyMdPath)).toBe(true);

      // 再次执行，幂等不再重复写入
      const rerun = migrateSlangStorage({
        db,
        dshHome: tmpDir,
        storagePath: legacyMdPath,
      });
      expect(rerun.migratedCount).toBe(0);
    });
  });
});
