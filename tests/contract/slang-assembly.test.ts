/**
 * tests/contract/slang-assembly.test.ts
 * 契约测试: 黑话系统装配与运行时接线闭环
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { EventEmitter } from 'node:events';
import { SlangStorage } from '../../src/slang/storage.js';
import { setupSlangService, registerSlangPromptContext } from '../../src/slang/index.js';
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

  it('契约 1: setupSlangService 正确注册 napcat:slang 动态提示词且 order 为 45', async () => {
    const storage = new SlangStorage(testFilePath, 5000);
    const service = setupSlangService(mockCtx, {
      storagePath: testFilePath,
      registerGlobalTools: false,
    });

    expect(mockSystemPrompt.context).toHaveBeenCalled();
    expect(registeredPrompts.has('napcat:slang')).toBe(true);

    const promptObj = registeredPrompts.get('napcat:slang');
    expect(promptObj.order).toBe(45);

    // 未添加词条时，Prompt 为空
    expect(promptObj.text()).toBe('');

    // 添加词条后，Prompt 同步包含最新黑话
    await service.storage.recordEntry({
      term: '牢大',
      definition: '科比梗',
      example: '想你了牢大',
    });

    const activePrompt = promptObj.text();
    expect(activePrompt).toContain('社群黑话与网络流行语知识库');
    expect(activePrompt).toContain('**牢大**');
    expect(activePrompt).toContain('科比梗');

    service.dispose();
    expect(registeredPrompts.has('napcat:slang')).toBe(false);
  });

  it('契约 2: registerAgentTools 在 slang_enabled !== false 时装配 record_slang 与 manage_slang', () => {
    const storage = new SlangStorage(testFilePath, 5000);
    const unregister = registerAgentTools(mockCtx, {
      db,
      dshHome: tmpDir,
      slangStorage: storage,
      configGetter: () => ({ slang_enabled: true }),
    });

    expect(registeredTools.has('record_slang')).toBe(true);
    expect(registeredTools.has('manage_slang')).toBe(true);

    unregister();
    expect(registeredTools.has('record_slang')).toBe(false);
    expect(registeredTools.has('manage_slang')).toBe(false);
  });

  it('契约 3: registerAgentTools 在 slang_enabled === false 时跳过黑话工具装配', () => {
    const storage = new SlangStorage(testFilePath, 5000);
    const unregister = registerAgentTools(mockCtx, {
      db,
      dshHome: tmpDir,
      slangStorage: storage,
      configGetter: () => ({ slang_enabled: false }),
    });

    expect(registeredTools.has('record_slang')).toBe(false);
    expect(registeredTools.has('manage_slang')).toBe(false);

    unregister();
  });
});
