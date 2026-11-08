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

    const slangProvider = hub.getProvider('napcat:slang');
    expect(slangProvider).toBeDefined();
    expect(slangProvider?.order).toBe(45);

    // 1. Web 会话下：严格白名单隔离，pre-step 产出 0 条消息，绝不泄露
    const webArgs = {
      agent: { session: { id: 'web-session-123' } },
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Web 用户' }] }],
    };
    const webRes = await hub.handlePreStep(webArgs, async () => ({ kind: 'enter', messages: webArgs.messages }));
    expect(webRes.messages.length).toBe(1);

    // 2. QQ 会话下，未添加词条时 Prompt 为空，不产生快照
    const qqSession = { peer: 'group_1000000001', qq: 'default', isGroup: true, isPrivate: false };
    const qqAssembleCtx = { agent: { session: { id: 'qq-group-1000000001-1' } } };
    expect(slangProvider?.provide(qqSession, qqAssembleCtx)).toBe('');

    // 3. QQ 会话下添加词条后，包含 L1 索引与 query_slang 指引
    await service.storage.recordEntry({
      term: '牢大',
      tags: '科比、坠机调侃',
      definition: '科比梗详细释义',
      example: '想你了牢大',
    });

    const activePrompt = slangProvider?.provide(qqSession, qqAssembleCtx);
    expect(activePrompt).toContain('社群黑话知识库 (Slang & Memes)');
    expect(activePrompt).toContain('query_slang');
    expect(activePrompt).toContain('- 牢大：科比、坠机调侃');

    // 4. QQ 会话下 pre-step 正确生成独立快照消息，且未变动时不再注入
    const qqArgs = {
      agent: { session: { id: 'qq-group-1000000001' } },
      messages: [],
    };
    const qqRes = await hub.handlePreStep(qqArgs, async () => ({ kind: 'enter', messages: [] }));
    const slangMsg = qqRes.messages.find((m: any) => m.source?.kind === 'napcat:slang');
    expect(slangMsg).toBeDefined();
    expect(slangMsg.source.form).toBe('snapshot');

    // 第二轮内容无变动，0 条快照注入
    const qqRes2 = await hub.handlePreStep(qqArgs, async () => ({ kind: 'enter', messages: [] }));
    expect(qqRes2.messages.length).toBe(0);

    hub.dispose();
    service.dispose();
    expect(hub.getProvider('napcat:slang')).toBeUndefined();
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
