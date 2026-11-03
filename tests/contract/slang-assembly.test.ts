/**
 * tests/contract/slang-assembly.test.ts
 * 契约测试: 黑话系统装配与运行时接线闭环
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { SlangStorage } from '../../src/slang/storage.js';
import { setupSlangService } from '../../src/slang/index.js';
import { setupSnapshotHub } from '../../src/prompt/snapshot.js';
import { registerAgentTools } from '../../src/tools/index.js';
import { MessageDatabase } from '../../src/storage/database.js';

describe('契约测试: 黑话系统装配与运行时接线闭环 (Slang Assembly Contract)', () => {
  let tmpDir: string;
  let testFilePath: string;
  let db: MessageDatabase;
  let registeredTools: Map<string, any>;
  let mockToolsService: any;
  let registeredPrompts: Map<string, any>;
  let mockSystemPrompt: any;
  let mockCtx: any;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-slang-assembly-'));
    testFilePath = path.join(tmpDir, 'slang.md');
    db = new MessageDatabase(path.join(tmpDir, 'test.db'));

    registeredTools = new Map();
    mockToolsService = {
      register: vi.fn().mockImplementation((def: any) => {
        registeredTools.set(def.name, def);
        return () => {
          registeredTools.delete(def.name);
        };
      }),
      get: (name: string) => registeredTools.get(name),
    };

    registeredPrompts = new Map();
    mockSystemPrompt = {
      context: vi.fn().mockImplementation((opts: any) => {
        registeredPrompts.set(opts.name, opts);
        return () => {
          registeredPrompts.delete(opts.name);
        };
      }),
    };

    mockCtx = {
      get: (name: string) => {
        if (name === 'tools') return mockToolsService;
        if (name === 'systemPrompt') return mockSystemPrompt;
        return undefined;
      },
      on: vi.fn(),
    };
  });

  afterEach(() => {
    try {
      db.close();
    } catch {}
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it('契约 1: setupSnapshotHub 配合 slangService 正确注册 napcat:slang (order 45)，且 Web UI 隔离、QQ 会话放行', async () => {
    const service = setupSlangService(mockCtx, {
      db,
      storagePath: testFilePath,
      registerGlobalTools: false,
    });

    const hub = setupSnapshotHub({
      ctx: mockCtx,
      db,
      slangStorage: service.storage,
      getSlangEnabled: () => true,
    });

    expect(mockSystemPrompt.context).toHaveBeenCalled();
    expect(registeredPrompts.has('napcat:slang')).toBe(true);

    const promptObj = registeredPrompts.get('napcat:slang');
    expect(promptObj.order).toBe(45);

    // 1. Web 会话 / 空上下文下：严格白名单隔离，绝对不泄露
    const webAssembleCtx = { session: { id: 'web-session-123' } };
    expect(promptObj.text(webAssembleCtx)).toBe('');
    expect(promptObj.text()).toBe('');

    // 2. QQ 会话下，未添加词条时 Prompt 为空
    const qqAssembleCtx = { agent: { session: { id: 'qq-group-1000000001-1' } } };
    expect(promptObj.text(qqAssembleCtx)).toBe('');

    // 3. QQ 会话下添加词条后，包含 L1 索引与 query_slang 指引
    await service.storage.recordEntry({
      term: '牢大',
      tags: '科比、坠机调侃',
      definition: '科比梗详细释义',
      example: '想你了牢大',
    });

    const activePrompt = promptObj.text(qqAssembleCtx);
    expect(activePrompt).toContain('社群黑话与网络流行语知识库');
    expect(activePrompt).toContain('query_slang');
    expect(activePrompt).toContain('- 牢大：科比、坠机调侃');

    hub.dispose();
    service.dispose();
    expect(registeredPrompts.has('napcat:slang')).toBe(false);
  });

  it('契约 2: registerAgentTools 在 slang_enabled !== false 时装配 query_slang, record_slang 与 manage_slang', () => {
    const storage = new SlangStorage(db, 300, 'reject');
    const unregister = registerAgentTools(mockCtx, {
      db,
      dshHome: tmpDir,
      slangStorage: storage,
      configGetter: () => ({ slang_enabled: true }),
    });

    expect(registeredTools.has('query_slang')).toBe(true);
    expect(registeredTools.has('record_slang')).toBe(true);
    expect(registeredTools.has('manage_slang')).toBe(true);

    unregister();
    expect(registeredTools.has('query_slang')).toBe(false);
    expect(registeredTools.has('record_slang')).toBe(false);
    expect(registeredTools.has('manage_slang')).toBe(false);
  });

  it('契约 3: registerAgentTools 在 slang_enabled === false 时跳过黑话工具装配', () => {
    const storage = new SlangStorage(db, 300, 'reject');
    const unregister = registerAgentTools(mockCtx, {
      db,
      dshHome: tmpDir,
      slangStorage: storage,
      configGetter: () => ({ slang_enabled: false }),
    });

    expect(registeredTools.has('query_slang')).toBe(false);
    expect(registeredTools.has('record_slang')).toBe(false);
    expect(registeredTools.has('manage_slang')).toBe(false);

    unregister();
  });
});
