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
    // 1. 追加到 session (遵循 read-before-write 规范先读)
    await tools.readMemory({ type: 'session', peer: 'group_3000000001' });
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

    // 2. 追加到 user (遵循 read-before-write 规范先读)
    await tools.readMemory({ type: 'user', qq: '470250799' });
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
    // 1. 覆盖 session (遵循 read-before-write 规范先读)
    await tools.readMemory({ type: 'session', peer: 'group_200' });
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

    // 2. 覆盖 user (遵循 read-before-write 规范先读)
    await tools.readMemory({ type: 'user', qq: '999' });
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

  it('契约 5: Read-Before-Write 保护 - 未读直接写入拒绝、连续编辑成功、外部修改检测', async () => {
    // 1. 未 read 过直接 append 必须拒绝
    const unreadAppend = await tools.appendMemory({
      type: 'session',
      content: '未读直接写入',
      peer: 'group_test_protect',
    });
    expect(unreadAppend.success).toBe(false);
    expect(unreadAppend.message).toContain('read_memory');

    // 2. 未 read 过直接 update 必须拒绝
    const unreadUpdate = await tools.updateMemory({
      type: 'session',
      content: '未读直接更新',
      peer: 'group_test_protect',
    });
    expect(unreadUpdate.success).toBe(false);
    expect(unreadUpdate.message).toContain('read_memory');

    // 3. read 后第一次 append 成功
    await tools.readMemory({ type: 'session', peer: 'group_test_protect' });
    const append1 = await tools.appendMemory({
      type: 'session',
      content: '首次合法追加',
      peer: 'group_test_protect',
    });
    expect(append1.success).toBe(true);

    // 4. 同一轮连续 append 成功（缓存同步更新，不需要重新手动 read）
    const append2 = await tools.appendMemory({
      type: 'session',
      content: '连续第二次追加',
      peer: 'group_test_protect',
    });
    expect(append2.success).toBe(true);

    // 5. 外部进程修改文件后，再次写入检测到版本冲突并拒绝
    await storage.writeSessionMemory('group_test_protect', '# 被外部程序覆盖的内容');
    const conflictedAppend = await tools.appendMemory({
      type: 'session',
      content: '冲突追加',
      peer: 'group_test_protect',
    });
    expect(conflictedAppend.success).toBe(false);
    expect(conflictedAppend.message).toContain('read_memory');

    // 6. 重新 read 后即可再次写入
    await tools.readMemory({ type: 'session', peer: 'group_test_protect' });
    const recoveredAppend = await tools.appendMemory({
      type: 'session',
      content: '恢复追加',
      peer: 'group_test_protect',
    });
    expect(recoveredAppend.success).toBe(true);
  });

  it('契约 6: 首次创建（文件不存在）边界 - read 返回空、append 正常创建', async () => {
    const nonExistentPeer = 'group_brand_new_12345';
    // 首次读取不存在的文件，返回空字符串
    const readRes = await tools.readMemory({ type: 'session', peer: nonExistentPeer });
    expect(readRes.success).toBe(true);
    expect(readRes.content).toBe('');

    // 随后 append 检测当前磁盘内容也是 ''，与缓存一致，允许正常创建写入
    const appendRes = await tools.appendMemory({
      type: 'session',
      content: '首次初始化规则',
      peer: nonExistentPeer,
    });
    expect(appendRes.success).toBe(true);

    const saved = await storage.readSessionMemory(nonExistentPeer);
    expect(saved).toContain('首次初始化规则');
  });

  it('契约 7: Peer 映射与 default 会话校验 - 拒绝 default peer，显式传 peer 正确写入目标文件', async () => {
    const toolDefs = createMemoryToolDefinitions(tools);
    const appendTool = toolDefs.find((t) => t.name === 'append_memory')!;
    const readTool = toolDefs.find((t) => t.name === 'read_memory')!;

    // 模拟来自 review-default-xxx 或无 peer 的上下文
    const execDefault = {
      agent: {
        session: { id: 'review-default-1788595929622' },
      },
    };

    // 1. 未显式传 peer 且上下文解析为 default 时被拦截拒绝
    const deniedRes = await appendTool.execute(
      { type: 'session', content: '测试拒绝' },
      execDefault as any
    );
    expect((deniedRes as any).success).toBe(false);
    expect((deniedRes as any).message).toContain('请显式传入 peer 参数');

    // 2. 显式传入 peer='group_123456789' 时执行通过，且落盘到正确的文件
    const targetPeer = 'group_123456789';
    await readTool.execute(
      { type: 'session', peer: targetPeer },
      execDefault as any
    );
    const allowedRes = await appendTool.execute(
      { type: 'session', peer: targetPeer, content: '由 review agent 显式指定 peer 写入' },
      execDefault as any
    );
    expect((allowedRes as any).success).toBe(true);

    const targetContent = await storage.readSessionMemory(targetPeer);
    expect(targetContent).toContain('由 review agent 显式指定 peer 写入');

    // 检查绝不应该生成 review-*.md 文件
    const defaultPath = storage.getSessionMemoryPath('review-default-1788595929622');
    const defaultExists = await fsp.access(defaultPath).then(() => true).catch(() => false);
    expect(defaultExists).toBe(false);
  });
});
