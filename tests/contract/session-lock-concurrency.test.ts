import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fsp } from 'node:fs';
import { Context } from '@deepseek-ai/cordis';
import { bootDshNapcatBridge, type BootedDsh } from '../../src/boot.js';
import {
  SessionManager,
  SessionAlreadyOwnedError,
  RemoteError,
} from '../../src/gateway/session.js';
import { MessageDatabase } from '../../src/storage/database.js';

describe('契约测试: DSH 0.1.5 会话排他锁、退避重试、QQ 优先抢占与 Web UI 只读守护 (Session Lock & Concurrency Contract)', () => {
  let tmpHome: string;
  let booted: BootedDsh | null = null;
  let db: MessageDatabase | null = null;

  beforeEach(async () => {
    tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-lock-concurrency-'));
  });

  afterEach(async () => {
    if (db) {
      db.close();
      db = null;
    }
    if (booted) {
      await booted.dispose().catch(() => {});
      booted = null;
    }
    if (tmpHome) {
      await fsp.rm(tmpHome, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('契约 1: 捕获 SessionAlreadyOwnedError 进行 3 次退避重试，耗尽后抛出明确提示且绝不调用 agents.create', async () => {
    const ctx = new Context();
    let resumeAttempts = 0;
    let createAttempts = 0;

    const mockAgents = {
      get: vi.fn().mockReturnValue(undefined),
      resume: vi.fn().mockImplementation(async (opts: any) => {
        resumeAttempts++;
        throw new SessionAlreadyOwnedError(opts.resumeSessionId);
      }),
      create: vi.fn().mockImplementation(async () => {
        createAttempts++;
        return { agent: { session: { id: 'test' } }, dispose: async () => {} };
      }),
    };
    (ctx as any).agents = mockAgents;

    // 传入极短重试延迟以加速单测执行 (10ms, 20ms, 30ms)
    const sessionManager = new SessionManager(ctx, tmpHome, undefined, {
      retryDelays: [10, 20, 30],
    });

    await expect(sessionManager.getOrCreateAgent('user_1000000001')).rejects.toThrow(
      /会话 qq-user-1000000001 当前正被其他控制台或任务占用（排他锁冲突）/
    );

    // 验证 resume 重试了 3 次
    expect(resumeAttempts).toBe(3);
    // 关键质量红线：绝不能为了兜底而调用 agents.create，避免连环崩溃 (SessionAlreadyExistsError)
    expect(createAttempts).toBe(0);
    expect(mockAgents.create).not.toHaveBeenCalled();
  });

  it('契约 2: 前置重试捕获 SessionAlreadyOwnedError，后续重试锁释放成功恢复会话', async () => {
    const ctx = new Context();
    let resumeAttempts = 0;
    const fakeSession = { id: 'qq-user-1000000002' };
    const fakeAgent = { session: fakeSession, cancel: vi.fn() };
    const fakeHandle = { agent: fakeAgent, dispose: vi.fn() };

    const mockAgents = {
      get: vi.fn().mockReturnValue(undefined),
      resume: vi.fn().mockImplementation(async (opts: any) => {
        resumeAttempts++;
        if (resumeAttempts < 3) {
          throw new SessionAlreadyOwnedError(opts.resumeSessionId);
        }
        return fakeHandle;
      }),
      create: vi.fn(),
    };
    (ctx as any).agents = mockAgents;

    const sessionManager = new SessionManager(ctx, tmpHome, undefined, {
      retryDelays: [10, 20, 30],
    });

    const agent = await sessionManager.getOrCreateAgent('user_1000000002');
    expect(agent).toBe(fakeAgent);
    expect(resumeAttempts).toBe(3);
    expect(sessionManager.hasActiveHandle('qq-user-1000000002')).toBe(true);
    expect(sessionManager.getActiveHandle('qq-user-1000000002')).toBe(fakeHandle);
    expect(mockAgents.create).not.toHaveBeenCalled();
  });

  it('契约 3: QQ 优先抢占：检测到非 QQ handle 占有会话时，主动 cancel 取消生成、关闭旧写句柄并夺回专属写句柄', async () => {
    const ctx = new Context();
    const sessionId = 'qq-group-2000000003';

    // 模拟非 QQ 端（如 Web 控制台）持有的旧 Agent 与 Handle
    const oldCancelMock = vi.fn();
    const oldDisposeMock = vi.fn().mockResolvedValue(undefined);
    const fakeOldAgent = {
      id: sessionId,
      session: { id: sessionId },
      cancel: oldCancelMock,
      handle: { dispose: oldDisposeMock },
      dispose: oldDisposeMock,
      ctx: { scope: { dispose: oldDisposeMock } },
    };

    // 内存中有该 agent，但 QQ 的 activeHandles 中没有
    const agentStore = new Map<string, any>([[sessionId, fakeOldAgent]]);

    const newAgent = { id: sessionId, session: { id: sessionId }, cancel: vi.fn() };
    const newHandle = { agent: newAgent, dispose: vi.fn().mockResolvedValue(undefined) };

    const mockAgents = {
      get: vi.fn().mockImplementation((id: string) => agentStore.get(id)),
      resume: vi.fn().mockImplementation(async () => {
        agentStore.set(sessionId, newAgent);
        return newHandle;
      }),
      create: vi.fn(),
    };
    (ctx as any).agents = mockAgents;

    const sessionManager = new SessionManager(ctx, tmpHome, undefined, {
      retryDelays: [10, 20, 30],
    });

    expect(sessionManager.hasActiveHandle(sessionId)).toBe(false);

    // QQ 收到消息触发 getOrCreateAgent
    const agent = await sessionManager.getOrCreateAgent('group_2000000003');

    // 验证原 agent 被执行取消操作
    expect(oldCancelMock).toHaveBeenCalledWith(expect.objectContaining({ kind: 'user-request' }));
    // 验证旧写句柄被尝试关闭释放锁
    expect(oldDisposeMock).toHaveBeenCalled();
    // 验证 QQ 夺回了专属写句柄
    expect(agent).toBe(newAgent);
    expect(sessionManager.hasActiveHandle(sessionId)).toBe(true);
    expect(sessionManager.getActiveHandle(sessionId)).toBe(newHandle);
  });

  it('契约 4: Web UI 只读锁定与拦截守护：QQ 独占活跃时拒绝 Web prompt 并返回标准 RemoteError', async () => {
    const ctx = new Context();
    const sessionId = 'qq-user-1000000004';

    const fakeAgent = { id: sessionId, session: { id: sessionId }, cancel: vi.fn() };
    const fakeHandle = { agent: fakeAgent, dispose: vi.fn() };

    (ctx as any).agents = {
      get: vi.fn().mockReturnValue(undefined),
      resume: vi.fn().mockResolvedValue(fakeHandle),
      create: vi.fn(),
    };

    const originalPromptMock = vi.fn().mockResolvedValue({ accepted: true });
    const mockSessionController = {
      prompt: originalPromptMock,
    };
    (ctx as any).sessionController = mockSessionController;

    const sessionManager = new SessionManager(ctx, tmpHome);

    // 1. 在 QQ 尚未持有该会话时，Web 端 prompt 正常放行
    const preResult = await mockSessionController.prompt({
      sessionId,
      content: [{ type: 'text', text: 'hi from web' }],
    });
    expect(preResult).toEqual({ accepted: true });
    expect(originalPromptMock).toHaveBeenCalledTimes(1);

    // 2. QQ 收到消息并获取/激活会话
    await sessionManager.getOrCreateAgent('user_1000000004');
    expect(sessionManager.hasActiveHandle(sessionId)).toBe(true);

    // 3. 此时 Web 端再次尝试调用 sessionController.prompt 向该会话发消息 -> 必须被拦截并抛出 RemoteError
    let thrownError: any = null;
    try {
      await mockSessionController.prompt({
        sessionId,
        content: [{ type: 'text', text: 'hi again from web' }],
      });
    } catch (err: any) {
      thrownError = err;
    }

    expect(thrownError).toBeInstanceOf(Error);
    expect(thrownError).toBeInstanceOf(RemoteError);
    expect(thrownError.code).toBe('session/agent-busy');
    expect(thrownError.isDSHRemoteError).toBe(true);
    expect(thrownError.message).toContain('该会话当前正由 QQ 独占使用中，Web 端处于只读监视模式');
    // Web prompt 被拦截后，原函数未被二次调用
    expect(originalPromptMock).toHaveBeenCalledTimes(1);

    // 4. 当 QQ 释放该会话后，Web 端 prompt 恢复正常
    await sessionManager.releaseActiveHandle(sessionId);
    expect(sessionManager.hasActiveHandle(sessionId)).toBe(false);

    const postResult = await mockSessionController.prompt({
      sessionId,
      content: [{ type: 'text', text: 'hi after qq released' }],
    });
    expect(postResult).toEqual({ accepted: true });
    expect(originalPromptMock).toHaveBeenCalledTimes(2);
  });

  it('契约 5: 真实装配路径下 SessionManager 守卫 sessionController.prompt 拦截闭环验证', async () => {
    booted = await bootDshNapcatBridge({
      dshHome: tmpHome,
      mountPlugin: false,
    });

    const sessionManager = new SessionManager(booted.ctx, tmpHome);
    const sessionId = 'qq-group-999999999';

    // 注入模拟的 sessionController 挂入 booted.ctx
    const realPromptMock = vi.fn().mockResolvedValue({ accepted: true });
    (booted.ctx as any).sessionController = {
      prompt: realPromptMock,
    };
    sessionManager.guardSessionController();

    // 唤醒并获取 QQ Agent
    const agent = await sessionManager.getOrCreateAgent('group_999999999');
    expect(agent.session.id).toBe(sessionId);
    expect(sessionManager.hasActiveHandle(sessionId)).toBe(true);

    // Web 端向群聊会话发送消息，验证拦截
    await expect(
      (booted.ctx as any).sessionController.prompt({
        sessionId,
        content: [{ type: 'text', text: 'interception test' }],
      })
    ).rejects.toThrow(RemoteError);

    await sessionManager.dispose();
  });
});
