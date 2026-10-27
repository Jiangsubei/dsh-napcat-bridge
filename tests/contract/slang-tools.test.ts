import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { SlangStorage } from '../../src/slang/storage.js';
import {
  createSlangToolDefinitions,
  recordSlang,
  manageSlang,
} from '../../src/slang/tools.js';

describe('Slang Tools Contract Tests', () => {
  let tmpDir: string;
  let testFilePath: string;
  let storage: SlangStorage;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-slang-tools-test-'));
    testFilePath = path.join(tmpDir, 'slang.md');
    storage = new SlangStorage(testFilePath, 5000);
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  describe('Tool Definitions & Descriptions', () => {
    it('should create exactly 2 tool definitions: record_slang and manage_slang', () => {
      const defs = createSlangToolDefinitions(storage);
      expect(defs).toHaveLength(2);
      const names = defs.map((d) => d.name);
      expect(names).toContain('record_slang');
      expect(names).toContain('manage_slang');
    });

    it('record_slang should have compliant natural language description and required parameters', () => {
      const defs = createSlangToolDefinitions(storage);
      const recordDef = defs.find((d) => d.name === 'record_slang')!;

      // 验证自然语言且无 markdown 标题
      expect(recordDef.description).not.toContain('#');
      expect(recordDef.description).toContain('记录并收录跨会话通用的网络梗');
      expect(recordDef.description).toContain('manage_slang');

      // 验证参数结构 (JSON Schema)
      const params = recordDef.parameters as any;
      expect(params.properties.term).toBeDefined();
      expect(params.properties.definition).toBeDefined();
      expect(params.properties.example).toBeDefined();
      expect(params.required).toContain('term');
      expect(params.required).toContain('definition');
      expect(params.required).toContain('example');
    });

    it('manage_slang should have compliant natural language description and action enum', () => {
      const defs = createSlangToolDefinitions(storage);
      const manageDef = defs.find((d) => d.name === 'manage_slang')!;

      expect(manageDef.description).not.toContain('#');
      expect(manageDef.description).toContain('管理与维护全局黑话知识库');
      expect(manageDef.description).toContain('record_slang');

      const params = manageDef.parameters as any;
      expect(params.properties.action).toBeDefined();
      expect(params.required).toContain('action');
      expect(params.properties.action.enum).toEqual(['list', 'edit', 'delete']);
      expect(params.properties.term).toBeDefined();
      expect(params.properties.definition).toBeDefined();
      expect(params.properties.example).toBeDefined();
      expect(params.properties.keyword).toBeDefined();
    });
  });

  describe('recordSlang Tool Execution', () => {
    it('should record new slang entry successfully', async () => {
      const res = await recordSlang(
        {
          term: '牢大',
          definition: '科比梗',
          example: '想你了牢大',
        },
        storage
      );

      expect(res.success).toBe(true);
      expect(res.action).toBe('created');
      expect(res.entry?.term).toBe('牢大');
      expect(res.char_count).toBeGreaterThan(0);
      expect(res.budget_chars).toBe(5000);

      const entries = await storage.getEntries();
      expect(entries).toHaveLength(1);
    });

    it('should update existing slang entry when recording same term', async () => {
      await recordSlang(
        { term: '开香槟', definition: '旧释义', example: '旧例句' },
        storage
      );

      const res = await recordSlang(
        { term: '开香槟', definition: '提前庆祝半场开翻车', example: '别急着开香槟' },
        storage
      );

      expect(res.success).toBe(true);
      expect(res.action).toBe('updated');
      expect(res.entry?.definition).toBe('提前庆祝半场开翻车');

      const entries = await storage.getEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0].definition).toBe('提前庆祝半场开翻车');
    });

    it('should return error when budget is exceeded', async () => {
      const smallStorage = new SlangStorage(testFilePath, 30);
      const res = await recordSlang(
        {
          term: '超长黑话测试词条',
          definition: '这个定义非常长，很容易就超出了设定的微小字符预算限制',
          example: '测试例句',
        },
        smallStorage
      );

      expect(res.success).toBe(false);
      expect(res.error).toContain('字符预算上限');
    });
  });

  describe('manageSlang Tool Execution', () => {
    beforeEach(async () => {
      await recordSlang({ term: '牢大', definition: '科比梗', example: '想你了' }, storage);
      await recordSlang({ term: '开香槟', definition: '提前庆祝', example: '先别开' }, storage);
    });

    it('action=list should return all entries and stats', async () => {
      const res = await manageSlang({ action: 'list' }, storage);
      expect(res.success).toBe(true);
      expect(res.action).toBe('list');
      expect(res.total).toBe(2);
      expect(res.entries).toHaveLength(2);
      expect(res.char_count).toBeGreaterThan(0);
    });

    it('action=list with keyword should filter entries', async () => {
      const res = await manageSlang({ action: 'list', keyword: '香槟' }, storage);
      expect(res.success).toBe(true);
      expect(res.entries).toHaveLength(1);
      expect(res.entries![0].term).toBe('开香槟');
    });

    it('action=edit should update term definition and example', async () => {
      const res = await manageSlang(
        {
          action: 'edit',
          term: '牢大',
          definition: '更新后的科比调侃梗',
        },
        storage
      );

      expect(res.success).toBe(true);
      expect(res.action).toBe('edit');
      expect(res.entry?.definition).toBe('更新后的科比调侃梗');
      expect(res.entry?.example).toBe('想你了'); // 原例句保持

      const entries = await storage.getEntries();
      expect(entries.find((e) => e.term === '牢大')?.definition).toBe('更新后的科比调侃梗');
    });

    it('action=edit should fail if term is not found', async () => {
      const res = await manageSlang(
        {
          action: 'edit',
          term: '不存在的词',
          definition: 'xxx',
        },
        storage
      );

      expect(res.success).toBe(false);
      expect(res.error).toContain('未找到');
    });

    it('action=delete should remove entry', async () => {
      const res = await manageSlang(
        {
          action: 'delete',
          term: '牢大',
        },
        storage
      );

      expect(res.success).toBe(true);
      expect(res.action).toBe('delete');

      const entries = await storage.getEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0].term).toBe('开香槟');
    });

    it('action=delete should fail if term is missing or not found', async () => {
      const res = await manageSlang({ action: 'delete' }, storage);
      expect(res.success).toBe(false);
      expect(res.error).toContain('必须提供目标黑话词条');

      const resNotFound = await manageSlang({ action: 'delete', term: '不存在的词' }, storage);
      expect(resNotFound.success).toBe(false);
      expect(resNotFound.error).toContain('未找到');
    });
  });
});
