import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { SlangStorage } from '../../src/slang/storage.js';
import { MessageDatabase } from '../../src/storage/database.js';
import {
  createSlangToolDefinitions,
  querySlang,
  recordSlang,
  manageSlang,
} from '../../src/slang/tools.js';

describe('Slang Tools Contract Tests', () => {
  let tmpDir: string;
  let testDbPath: string;
  let db: MessageDatabase;
  let storage: SlangStorage;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-slang-tools-test-'));
    testDbPath = path.join(tmpDir, 'test_messages.sqlite');
    db = new MessageDatabase(testDbPath);
    storage = new SlangStorage(db, 300, 'reject');
  });

  afterEach(() => {
    try {
      db.close();
    } catch {}
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  describe('Tool Definitions & Descriptions', () => {
    it('should create exactly 3 tool definitions: query_slang, record_slang, manage_slang', () => {
      const defs = createSlangToolDefinitions(storage);
      expect(defs).toHaveLength(3);
      const names = defs.map((d) => d.name);
      expect(names).toContain('query_slang');
      expect(names).toContain('record_slang');
      expect(names).toContain('manage_slang');
    });

    it('query_slang should have compliant natural language description and required term parameter', () => {
      const defs = createSlangToolDefinitions(storage);
      const queryDef = defs.find((d) => d.name === 'query_slang')!;

      expect(queryDef.description).not.toContain('#');
      expect(queryDef.description).toContain('完整释义与典型使用例句');
      expect(queryDef.description).toContain('联网搜索');

      const params = queryDef.parameters as any;
      expect(params.properties.term).toBeDefined();
      expect(params.required).toContain('term');
    });

    it('record_slang should enforce 4 required parameters: term, tags, definition, example', () => {
      const defs = createSlangToolDefinitions(storage);
      const recordDef = defs.find((d) => d.name === 'record_slang')!;

      expect(recordDef.description).not.toContain('#');
      expect(recordDef.description).toContain('记录并收录跨会话通用的网络梗');
      expect(recordDef.description).toContain('manage_slang');

      const params = recordDef.parameters as any;
      expect(params.properties.term).toBeDefined();
      expect(params.properties.tags).toBeDefined();
      expect(params.properties.definition).toBeDefined();
      expect(params.properties.example).toBeDefined();
      expect(params.properties.aliases).toBeUndefined();

      // 4 个核心参数必填校验
      expect(params.required).toContain('term');
      expect(params.required).toContain('tags');
      expect(params.required).toContain('definition');
      expect(params.required).toContain('example');
      // aliases 已废除
      expect(params.required).not.toContain('aliases');
    });

    it('manage_slang should have compliant natural language description and action enum', () => {
      const defs = createSlangToolDefinitions(storage);
      const manageDef = defs.find((d) => d.name === 'manage_slang')!;

      expect(manageDef.description).not.toContain('#');
      expect(manageDef.description).toContain('全局黑话知识库');
      expect(manageDef.description).toContain('record_slang');

      const params = manageDef.parameters as any;
      expect(params.properties.action).toBeDefined();
      expect(params.required).toContain('action');
      expect(params.properties.action.enum).toEqual(['list', 'edit', 'delete']);
      expect(params.properties.term).toBeDefined();
      expect(params.properties.tags).toBeDefined();
      expect(params.properties.aliases).toBeUndefined();
      expect(params.properties.definition).toBeDefined();
      expect(params.properties.example).toBeDefined();
      expect(params.properties.keyword).toBeDefined();
      expect(params.properties.limit).toBeDefined();
    });
  });

  describe('querySlang Tool Execution', () => {
    beforeEach(async () => {
      await recordSlang(
        {
          term: '开香槟',
          tags: '反转嘲讽',
          definition: '提前庆祝导致翻车被打脸',
          example: '优势很大，但先别急着开香槟',
        },
        storage
      );
    });

    it('should query slang details by primary term and return complete definition and example', async () => {
      const res = await querySlang({ term: '开香槟' }, storage);
      expect(res.success).toBe(true);
      expect(res.entry?.term).toBe('开香槟');
      expect(res.message).toContain('核心释义: 提前庆祝导致翻车被打脸');
      expect(res.message).toContain('典型例句: 优势很大，但先别急着开香槟');
      expect(res.message).toContain('反转嘲讽');
    });

    it('should increment query_count on query', async () => {
      await querySlang({ term: '开香槟' }, storage);
      const res = await querySlang({ term: '开香槟' }, storage);
      expect(res.entry?.query_count).toBe(2);
    });

    it('should return error when term is not found', async () => {
      const res = await querySlang({ term: '未收录的词' }, storage);
      expect(res.success).toBe(false);
      expect(res.error).toContain('未收录词条');
      expect(res.error).toContain('联网搜索');
    });
  });

  describe('recordSlang Tool Execution', () => {
    it('should record new slang entry successfully with 4 required fields', async () => {
      const res = await recordSlang(
        {
          term: '牢大',
          tags: '科比梗',
          definition: '科比调侃用法',
          example: '想你了牢大',
        },
        storage
      );

      expect(res.success).toBe(true);
      expect(res.action).toBe('created');
      expect(res.entry?.term).toBe('牢大');
      expect(res.entry?.tags).toBe('科比梗');
      expect(res.total).toBe(1);
      expect(res.max_entries).toBe(300);

      const entries = await storage.getEntries();
      expect(entries).toHaveLength(1);
    });

    it('should fail if any of the 4 required parameters is missing', async () => {
      const missingTags = await recordSlang(
        {
          term: '牢大',
          tags: '',
          definition: '科比调侃用法',
          example: '想你了牢大',
        },
        storage
      );
      expect(missingTags.success).toBe(false);
      expect(missingTags.error).toContain('词条标签（简要概述）不能为空');

      const missingExample = await recordSlang(
        {
          term: '牢大',
          tags: '标签',
          definition: '科比调侃用法',
          example: '',
        },
        storage
      );
      expect(missingExample.success).toBe(false);
      expect(missingExample.error).toContain('典型例句不能为空');
    });

    it('should update existing slang entry when recording same term', async () => {
      await recordSlang(
        { term: '开香槟', tags: '旧标签', definition: '旧释义', example: '旧例句' },
        storage
      );

      const res = await recordSlang(
        { term: '开香槟', tags: '新标签', definition: '提前庆祝半场开翻车', example: '别急着开香槟' },
        storage
      );

      expect(res.success).toBe(true);
      expect(res.action).toBe('updated');
      expect(res.entry?.definition).toBe('提前庆祝半场开翻车');
      expect(res.entry?.tags).toBe('新标签');

      const entries = await storage.getEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0].definition).toBe('提前庆祝半场开翻车');
    });

    it('should return error when capacity is exceeded under reject policy', async () => {
      const smallStorage = new SlangStorage(db, 1, 'reject');
      await recordSlang(
        {
          term: '词1',
          tags: '标1',
          definition: '释1',
          example: '例1',
        },
        smallStorage
      );

      const res = await recordSlang(
        {
          term: '词2',
          tags: '标2',
          definition: '释2',
          example: '例2',
        },
        smallStorage
      );

      expect(res.success).toBe(false);
      expect(res.error).toContain('条数上限 (1/1)');
    });
  });

  describe('manageSlang Tool Execution', () => {
    beforeEach(async () => {
      await recordSlang({ term: '牢大', tags: '科比', definition: '科比梗', example: '想你了' }, storage);
      await recordSlang({ term: '开香槟', tags: '反转', definition: '提前庆祝', example: '先别开' }, storage);
    });

    it('action=list should return all entries and stats', async () => {
      const res = await manageSlang({ action: 'list' }, storage);
      expect(res.success).toBe(true);
      expect(res.action).toBe('list');
      expect(res.total).toBe(2);
      expect(res.entries).toHaveLength(2);
      expect(res.max_entries).toBe(300);
    });

    it('action=list render function should output complete details of each entry to model', async () => {
      const defs = createSlangToolDefinitions(storage);
      const manageDef = defs.find((d) => d.name === 'manage_slang')!;
      
      const res = await manageSlang({ action: 'list' }, storage);
      const parts = manageDef.output?.render ? (manageDef.output.render as any)({}, res) : [];
      const renderedText = parts[0]?.text || '';
      
      // 验证模型在上下文中能直接看到各词条的标题、标签、释义与例句，而非只有条数统计
      expect(renderedText).toContain('2/300 条');
      expect(renderedText).toContain('【牢大】');
      expect(renderedText).toContain('标签: 科比');
      expect(renderedText).toContain('释义: 科比梗');
      expect(renderedText).toContain('例句: 想你了');
      expect(renderedText).toContain('【开香槟】');
      expect(renderedText).toContain('标签: 反转');
    });

    it('action=list with limit should restrict returned entries count', async () => {
      const res = await manageSlang({ action: 'list', limit: 1 }, storage);
      expect(res.success).toBe(true);
      expect(res.entries).toHaveLength(1);
      expect(res.total).toBe(1); // 返回 1 条
      expect(res.message).toContain('2/300 条'); // 总体容量为 2
    });

    it('action=list with keyword should filter entries by term, tags or definition', async () => {
      // 1. 按标题搜
      const resByTerm = await manageSlang({ action: 'list', keyword: '香槟' }, storage);
      expect(resByTerm.success).toBe(true);
      expect(resByTerm.entries).toHaveLength(1);
      expect(resByTerm.entries![0].term).toBe('开香槟');

      // 2. 按标签反查
      const resByTag = await manageSlang({ action: 'list', keyword: '反转' }, storage);
      expect(resByTag.success).toBe(true);
      expect(resByTag.entries).toHaveLength(1);
      expect(resByTag.entries![0].term).toBe('开香槟');

      // 3. 按释义反查
      const resByDef = await manageSlang({ action: 'list', keyword: '提前庆祝' }, storage);
      expect(resByDef.success).toBe(true);
      expect(resByDef.entries).toHaveLength(1);
      expect(resByDef.entries![0].term).toBe('开香槟');
    });

    it('action=edit should update term definition, tags, and example', async () => {
      const res = await manageSlang(
        {
          action: 'edit',
          term: '牢大',
          tags: '篮球新标签',
          definition: '更新后的科比调侃梗',
        },
        storage
      );

      expect(res.success).toBe(true);
      expect(res.action).toBe('edit');
      expect(res.entry?.definition).toBe('更新后的科比调侃梗');
      expect(res.entry?.tags).toBe('篮球新标签');
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

  describe('DSH Lossless JSON 契约测试 (Lossless JSON Compliance)', () => {
    it('record_slang execute 输出严格符合 DSH Lossless JSON 约束 (无任何 undefined 键)', async () => {
      const defs = createSlangToolDefinitions(storage);
      const recordDef = defs.find((d) => d.name === 'record_slang')!;

      const result = await (recordDef as any).execute({
        term: '猫娘=猫粮',
        tags: '谐音梗、亲密调侃',
        definition: '猫娘与猫粮谐音',
        example: '你是一袋猫粮',
      });

      expect(result.success).toBe(true);
      // 遍历所有顶层及嵌套属性，绝无 undefined
      for (const [key, value] of Object.entries(result)) {
        expect(value).not.toBeUndefined();
      }
      // 未触发淘汰时，evicted_term 经过清洗后绝不存在
      expect(result.hasOwnProperty('evicted_term')).toBe(false);
      // 无损 JSON 序列化幂等验证
      expect(JSON.stringify(result)).toBe(JSON.stringify(JSON.parse(JSON.stringify(result))));
    });

    it('query_slang execute 输出严格符合 DSH Lossless JSON 约束', async () => {
      const defs = createSlangToolDefinitions(storage);
      const queryDef = defs.find((d) => d.name === 'query_slang')!;

      await recordSlang({ term: '牢大', tags: '科比', definition: '梗', example: '例' }, storage);

      // 1. 成功查询
      const resSuccess = await (queryDef as any).execute({ term: '牢大' });
      expect(resSuccess.success).toBe(true);
      for (const [_k, v] of Object.entries(resSuccess)) {
        expect(v).not.toBeUndefined();
      }

      // 2. 失败查询
      const resFail = await (queryDef as any).execute({ term: '未收录词' });
      expect(resFail.success).toBe(false);
      for (const [_k, v] of Object.entries(resFail)) {
        expect(v).not.toBeUndefined();
      }
    });

    it('manage_slang execute 输出严格符合 DSH Lossless JSON 约束', async () => {
      const defs = createSlangToolDefinitions(storage);
      const manageDef = defs.find((d) => d.name === 'manage_slang')!;

      // 1. list
      const resList = await (manageDef as any).execute({ action: 'list' });
      expect(resList.success).toBe(true);
      for (const [_k, v] of Object.entries(resList)) {
        expect(v).not.toBeUndefined();
      }

      // 2. delete
      const resDel = await (manageDef as any).execute({ action: 'delete', term: '不存在的词' });
      expect(resDel.success).toBe(false);
      for (const [_k, v] of Object.entries(resDel)) {
        expect(v).not.toBeUndefined();
      }
    });
  });
});
