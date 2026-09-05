/**
 * tests/contract/memory-tools.test.ts
 *
 * 契约测试: EN-003 3个核心 Memory Agent 工具 (read_memory, append_memory, update_memory)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fsp } from 'node:fs';
import { MemoryStorage } from '../../src/memory/storage.js';
import {
  MemoryTools,
  createMemoryToolDefinitions,
  resolveContextPeerAndQQ,
} from '../../src/memory/tools.js';

describe('契约测试: EN-003 Memory Agent 工具 (read_memory, append_memory, update_memory)', () => {
  let tmpDir: string;
  let storage: MemoryStorage;
  let tools: MemoryTools;
  let emitMock: any;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-napcat-memtools-test-'));
    storage = new MemoryStorage(tmpDir);
    emitMock = vi.fn();
    tools = new MemoryTools(storage, { emit: emitMock } as any);
  });

  afterEach(async () => {
    if (tmpDir) {
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('契约 1: read_memory 读取 session 规则与用户画像', async () => {
    await storage.writeSessionMemory('group_3000000001', '群规：禁止水群');
    await storage.writeUserProfile('2000000001', '偏好：喜欢 Python 和 TS');

    // 1. 读 session
    const resSession = await tools.readMemory({
      type: 'session',
      peer: 'group_3000000001',
    });
    expect(resSession.success).toBe(true);
    expect(resSession.content).toBe('群规：禁止水群');
    expect(resSession.message).toContain('group_3000000001');

    // 2. 读 user
    const resUser = await tools.readMemory({
      type: 'user',
      qq: '2000000001',
    });
    expect(resUser.success).toBe(true);
    expect(resUser.content).toBe('偏好：喜欢 Python 和 TS');
    expect(resUser.message).toContain('2000000001');
  });

  it('契约 2: append_memory 追加条目并触发 memory/change 事件', async () => {
    // 1. 追加到 session
    const resSession = await tools.appendMemory({
      type: 'session',
      content: '新增一条群规：提问请附带报错日志',
      peer: 'group_3000000001',
    });
    expect(resSession.success).toBe(true);
    expect(resSession.message).toContain('已更新记忆');
    expect(emitMock).toHaveBeenCalledWith('memory/change', expect.objectContaining({
      type: 'session',
      peer: 'group_3000000001',
      action: 'append',
    }));

    const sessionContent = await storage.readSessionMemory('group_3000000001');
    expect(sessionContent).toContain('新增一条群规：提问请附带报错日志');

    // 2. 追加到 user
    const resUser = await tools.appendMemory({
      type: 'user',
      content: '经常使用 Linux 系统',
      qq: '470250799',
    });
    expect(resUser.success).toBe(true);
    expect(resUser.message).toContain('470250799');
    expect(emitMock).toHaveBeenCalledWith('memory/change', expect.objectContaining({
      type: 'user',
      qq: '470250799',
      action: 'append',
    }));

    const userContent = await storage.readUserProfile('470250799');
    expect(userContent).toContain('经常使用 Linux 系统');
  });

  it('契约 3: update_memory 全量重写 session 或 user 画像', async () => {
    // 1. 覆盖 session
    await tools.updateMemory({
      type: 'session',
      content: '# 新群规\n- 仅限算法讨论',
      peer: 'group_200',
    });
    expect(await storage.readSessionMemory('group_200')).toBe('# 新群规\n- 仅限算法讨论');
    expect(emitMock).toHaveBeenCalledWith('memory/change', expect.objectContaining({
      type: 'session',
      peer: 'group_200',
      action: 'update',
    }));

    // 2. 覆盖 user
    await tools.updateMemory({
      type: 'user',
      content: '# 完整用户画像\n- 昵称李四\n- 架构师',
      qq: '999',
    });
    expect(await storage.readUserProfile('999')).toBe('# 完整用户画像\n- 昵称李四\n- 架构师');
    expect(emitMock).toHaveBeenCalledWith('memory/change', expect.objectContaining({
      type: 'user',
      qq: '999',
      action: 'update',
    }));
  });

  it('契约 4: DSH ToolDefinitions 声明与执行上下文绑定', async () => {
    const toolDefs = createMemoryToolDefinitions(tools);
    expect(toolDefs.length).toBe(3);

    const names = toolDefs.map((t) => t.name);
    expect(names).toEqual(['read_memory', 'append_memory', 'update_memory']);

    // 验证 resolveContextPeerAndQQ 上下文推导
    const execGroup = {
      agent: {
        userId: '2000000001',
        session: { id: 'qq-group-3000000001-1' },
      },
    };
    const resolvedGroup = resolveContextPeerAndQQ(execGroup);
    expect(resolvedGroup.peer).toBe('group_3000000001');
    expect(resolvedGroup.qq).toBe('2000000001');

    const execPrivate = {
      agent: {
        session: { id: 'qq-user-470250799-1' },
      },
    };
    const resolvedPrivate = resolveContextPeerAndQQ(execPrivate);
    expect(resolvedPrivate.peer).toBe('user_470250799');
    expect(resolvedPrivate.qq).toBe('470250799');

    // 验证 toolDef.execute
    const readTool = toolDefs.find((t) => t.name === 'read_memory')!;
    await storage.writeSessionMemory('group_3000000001', '测试群记忆');
    const readResult = await readTool.execute({ type: 'session' }, execGroup as any);
    expect((readResult as any).success).toBe(true);
    expect((readResult as any).content).toBe('测试群记忆');
  });
});
