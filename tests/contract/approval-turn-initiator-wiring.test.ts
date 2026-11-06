import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { SessionManager } from '../../src/gateway/session.js';
import { TurnInitiatorTracker } from '../../src/approval/turn-initiator.js';

/**
 * 契约测试: dispatchWakeup 与本轮唤醒者追踪器的装配接线。
 * 使用 mock Agent 隔离 LLM，只验证「唤醒下发 → 登记 expectation → session/event 绑定」链路。
 */
describe('契约测试: 审批「本轮唤醒者」追踪器与 dispatchWakeup 接线', () => {
  let tmpHome: string;
  let mockCtx: any;
  let mockAgent: any;
  let sessionManager: SessionManager;

  const SESSION_ID = 'qq-group-1000000001';

  beforeEach(() => {
    tmpHome = path.join(os.tmpdir(), `dsh-turn-initiator-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(tmpHome, { recursive: true });

    mockAgent = {
      status: 'running',
      steer: vi.fn(),
      followup: vi.fn(),
      session: { id: SESSION_ID },
    };

    mockCtx = {
      get: vi.fn((key: string) => {
        if (key === 'agents') {
          return {
            get: () => mockAgent,
            create: vi.fn().mockResolvedValue({ agent: mockAgent }),
            resume: vi.fn().mockResolvedValue({ agent: mockAgent }),
          };
        }
        return undefined;
      }),
      logger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
      config: {},
    };

    sessionManager = new SessionManager(mockCtx, tmpHome);
  });

  function wakeup(fromUser: string, trigger: 'at' | 'scheduled' = 'at') {
    return sessionManager.dispatchWakeup({
      trigger,
      peer: 'group_1000000001',
      from_user: fromUser,
      from_name: '测试用户',
      content: '触发一次需要审批的操作',
      timestamp: Date.now(),
    });
  }

  it('契约 1: 真实 QQ 发送者唤醒会在 followup 前登记本轮 expectation', async () => {
    const tracker = new TurnInitiatorTracker();
    sessionManager.setTurnInitiatorTracker(tracker);

    const userMsg = await wakeup('10001');

    expect(userMsg.id).toBeTruthy();
    expect(tracker.pendingCount).toBe(1);

    // 模拟官方 session/event 顺序：turn/start → user/message
    tracker.observe({ id: SESSION_ID }, { type: 'turn/start' } as any);
    tracker.observe({ id: SESSION_ID }, {
      type: 'user/message',
      data: { id: userMsg.id, source: { kind: 'user' } },
    } as any);

    expect(tracker.getInitiator(SESSION_ID)).toBe('10001');
  });

  it('契约 2: 系统触发（scheduled）不登记，审批保持 Fail-Closed', async () => {
    const tracker = new TurnInitiatorTracker();
    sessionManager.setTurnInitiatorTracker(tracker);

    const userMsg = await wakeup('10001', 'scheduled');
    expect(tracker.pendingCount).toBe(0);

    tracker.observe({ id: SESSION_ID }, { type: 'turn/start' } as any);
    tracker.observe({ id: SESSION_ID }, {
      type: 'user/message',
      data: { id: userMsg.id, source: { kind: 'user' } },
    } as any);

    expect(tracker.getInitiator(SESSION_ID)).toBeUndefined();
  });

  it('契约 3: 排队两轮唤醒分别登记，各自轮次独立绑定', async () => {
    mockCtx.config = { new_message_behavior: 'queue' };
    const tracker = new TurnInitiatorTracker();
    sessionManager.setTurnInitiatorTracker(tracker);

    const first = await wakeup('10001');
    const second = await wakeup('99999');
    expect(tracker.pendingCount).toBe(2);

    // 第一轮
    tracker.observe({ id: SESSION_ID }, { type: 'turn/start' } as any);
    tracker.observe({ id: SESSION_ID }, {
      type: 'user/message',
      data: { id: first.id, source: { kind: 'user' } },
    } as any);
    expect(tracker.getInitiator(SESSION_ID)).toBe('10001');

    tracker.observe({ id: SESSION_ID }, {
      type: 'turn/end',
      data: { turn: 1, reason: { kind: 'completed' } },
    } as any);
    expect(tracker.getInitiator(SESSION_ID)).toBeUndefined();

    // 第二轮
    tracker.observe({ id: SESSION_ID }, { type: 'turn/start' } as any);
    tracker.observe({ id: SESSION_ID }, {
      type: 'user/message',
      data: { id: second.id, source: { kind: 'user' } },
    } as any);
    expect(tracker.getInitiator(SESSION_ID)).toBe('99999');

    await sessionManager.dispose();
  });
});
