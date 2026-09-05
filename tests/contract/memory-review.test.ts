/**
 * tests/contract/memory-review.test.ts
 *
 * 契约测试: EN-003 BackgroundReviewManager 后台自动回顾机制
 *
 * 覆盖场景:
 * 1. 门控触发 (Gating: turnsInterval 与 toolCallsInterval)
 * 2. Hermes 取消握手协议 (2.0s 契约，live turn 开始时不阻塞前台)
 * 3. 严格工具白名单沙箱 (仅允许 read_memory, append_memory, update_memory)
 * 4. Hermes 对齐提示词 (5 大 Do NOT capture 负面约束与 QQ 两层指引)
 * 5. 回顾变更汇总与通知事件 (memory/review/notify)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fsp } from 'node:fs';
import { MemoryStorage } from '../../src/memory/storage.js';
import {
  BackgroundReviewManager,
  ALLOWED_MEMORY_REVIEW_TOOLS,
  MEMORY_REVIEW_PROMPT_TEMPLATE,
  summarizeMemoryReviewActions,
  BACKGROUND_REVIEW_CANCEL_TIMEOUT_MS,
} from '../../src/memory/review.js';
import { setupMemoryService } from '../../src/memory/index.js';

describe('契约测试: EN-003 BackgroundReviewManager 后台自动回顾机制', () => {
  let tmpDir: string;
  let storage: MemoryStorage;
  let reviewManager: BackgroundReviewManager;
  let mockCtx: any;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-napcat-memrev-test-'));
    storage = new MemoryStorage(tmpDir);

    mockCtx = {
      get: vi.fn((k: string) => (mockCtx as any)[k]),
      emit: vi.fn(),
      logger: () => ({
        info: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
      }),
      agents: {
        create: vi.fn(),
      },
    };

    reviewManager = new BackgroundReviewManager(
      mockCtx,
      {
        enabled: true,
        turnsInterval: 10,
        toolCallsInterval: 10,
        storageDir: tmpDir,
      },
      storage
    );
  });

  afterEach(async () => {
    if (tmpDir) {
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('契约 1: 门控触发逻辑 - 未达阈值跳过，达到 turnsInterval 或 toolCallsInterval 触发', () => {
    // 1. 初始 turn 1，未达阈值
    const check1 = reviewManager.recordTurn('group_3000000001', 0);
    expect(check1.shouldReview).toBe(false);

    // 2. 累积至 9 turns
    for (let i = 2; i <= 9; i++) {
      reviewManager.recordTurn('group_3000000001', 0);
    }
    const check9 = reviewManager.recordTurn('group_3000000001', 0);
    expect(check9.shouldReview).toBe(true);
    expect(check9.reason).toContain('turns threshold');

    // 3. 触发后 checkpoint 更新，再次检查重置为 false
    const check11 = reviewManager.recordTurn('group_3000000001', 0);
    expect(check11.shouldReview).toBe(false);

    // 4. 工具调用突增达到 toolCallsInterval (如 10 次工具调用)
    const checkTools = reviewManager.recordTurn('group_3000000001', 10);
    expect(checkTools.shouldReview).toBe(true);
    expect(checkTools.reason).toContain('tool calls threshold');
  });

  it('契约 2: Hermes 取消握手协议 (2.0s 契约，live turn 开始时不阻塞前台)', async () => {
    expect(BACKGROUND_REVIEW_CANCEL_TIMEOUT_MS).toBe(2000);

    const run = reviewManager.prepareReviewRun('group_3000000001');
    expect(run).toBeDefined();
    expect(run!.isCancelRequested).toBe(false);

    // 模拟子代理注册
    const abortMock = vi.fn();
    run!.beginRequest({ abort: abortMock });

    // 模拟前台 turn/start 到来触发取消
    const cancelPromise = reviewManager.cancelReviewForLiveTurn('group_3000000001');
    // 在子线程/子任务中完成标记
    setTimeout(() => {
      reviewManager.finishReviewRun('group_3000000001', run!);
    }, 50);

    await cancelPromise;
    expect(run!.isCancelRequested).toBe(true);
    expect(abortMock).toHaveBeenCalled();
  });

  it('契约 3: 严格工具白名单沙箱 (仅允许 read_memory, append_memory, update_memory, read_chat_history)', () => {
    expect(ALLOWED_MEMORY_REVIEW_TOOLS).toEqual([
      'read_memory',
      'append_memory',
      'update_memory',
      'read_chat_history',
    ]);
  });

  it('契约 4: Hermes 审查提示词规范 (包含 5 大 Do NOT capture 负面约束与 QQ 两层指引)', () => {
    const prompt = MEMORY_REVIEW_PROMPT_TEMPLATE;

    // 1. 包含 Hermes 核心指导
    expect(prompt).toContain('Memory Review & Distillation Agent');
    expect(prompt).toContain('Nothing to save');

    // 2. 包含 5 大 Do NOT capture 负面约束
    expect(prompt).toContain('Environment-dependent failures');
    expect(prompt).toContain('Negative claims about tools');
    expect(prompt).toContain('Session-specific transient errors');
    expect(prompt).toContain('One-off task narratives');
    expect(prompt).toContain('Unresolved failures');

    // 3. 包含 QQ 两层记忆工具指示
    expect(prompt).toContain('read_memory');
    expect(prompt).toContain('append_memory');
    expect(prompt).toContain('update_memory');
    expect(prompt).toContain('session');
    expect(prompt).toContain('user');
  });

  it('契约 5: 回顾变更汇总与通知事件 (memory/review/notify)', async () => {
    const actions = ['已更新群聊记忆 (group_3000000001)', '已更新用户画像 (2000000001)'];
    const summary = summarizeMemoryReviewActions(actions);
    expect(summary).toContain('💾 记忆与用户画像自动优化：已更新群聊记忆 (group_3000000001) · 已更新用户画像 (2000000001)');

    // 模拟子代理 review 产生变更并通过 ctx.emit 发送通知
    mockCtx.agents.create.mockResolvedValueOnce({
      followup: vi.fn().mockImplementation(async () => {
        // 模拟 review 执行期间调用了工具产生变更
        const currentRun = (reviewManager as any).activeReviewRuns.get('group_3000000001');
        if (currentRun) {
          currentRun.actions.push('已更新群聊记忆 (group_3000000001)');
          currentRun.details.memoryChanges.push('已更新群聊记忆 (group_3000000001)');
        }
      }),
    });

    const result = await reviewManager.runReview('group_3000000001', {
      history: [{ role: 'user', content: '我们群以后只聊 TS 代码' }],
      mainModel: 'deepseek-chat',
    });

    expect(result.executed).toBe(true);
    expect(result.memoryUpdated).toBe(true);
    expect(mockCtx.emit).toHaveBeenCalledWith('memory/review/notify', expect.objectContaining({
      peer: 'group_3000000001',
      summary: expect.stringContaining('已更新群聊记忆'),
    }));
  });

  it('契约 6: cleanupReviewSession 物理清理契约 - 调用 flush/detach、清 workspaceRegistry、物理 rm 会话目录、释放 handle', async () => {
    const reviewSessionId = 'review-test-12345';
    const fakeSessionDir = path.join(tmpDir, 'sessions', 'ws-test', reviewSessionId);
    await fsp.mkdir(fakeSessionDir, { recursive: true });
    await fsp.writeFile(path.join(fakeSessionDir, 'events.jsonl'), '{"type":"test"}\n');

    const liveSessionMock = { id: reviewSessionId };
    const flushMock = vi.fn().mockResolvedValue(undefined);
    const detachEnteredMock = vi.fn().mockResolvedValue(undefined);
    mockCtx.sessions = {
      get: vi.fn().mockReturnValue(liveSessionMock),
      flush: flushMock,
      detachEntered: detachEnteredMock,
    };

    const headersMap = new Map<string, any>();
    headersMap.set(reviewSessionId, { id: reviewSessionId });
    const sessionPathsMap = new Map<string, any>();
    sessionPathsMap.set(reviewSessionId, fakeSessionDir);
    mockCtx.workspaceRegistry = {
      headers: headersMap,
      sessionPaths: sessionPathsMap,
    };

    const handleMock = {
      dispose: vi.fn().mockResolvedValue(undefined),
    };

    (reviewManager as any).dshHome = tmpDir;

    await reviewManager.cleanupReviewSession(reviewSessionId, handleMock, fakeSessionDir);

    expect(flushMock).toHaveBeenCalledWith(liveSessionMock);
    expect(detachEnteredMock).toHaveBeenCalledWith(liveSessionMock);
    expect(headersMap.has(reviewSessionId)).toBe(false);
    expect(sessionPathsMap.has(reviewSessionId)).toBe(false);
    expect(handleMock.dispose).toHaveBeenCalled();
  });

  it('契约 7: DSH 原生 fork 契约 - 从 parentSession snapshotEvents 提取 completed-turn prefix 作为 seed 并继承 cwd', async () => {
    const parentEvents = [
      { type: 'turn/start', seq: 1 },
      { type: 'agent/message', seq: 2, data: { text: 'hello' } },
      { type: 'turn/end', seq: 3 },
      { type: 'turn/start', seq: 4 }, // 未完成 turn
      { type: 'agent/message', seq: 5, data: { text: 'working...' } },
    ];

    const parentSessionMock = {
      id: 'qq-group-3000000001',
      cwd: '/workspace/project-root',
      snapshotEvents: vi.fn().mockReturnValue(parentEvents),
    };

    const handleMock = {
      agent: {
        followup: vi.fn().mockResolvedValue(undefined),
        whenIdle: vi.fn().mockResolvedValue(undefined),
      },
      dispose: vi.fn().mockResolvedValue(undefined),
    };
    mockCtx.agents.create.mockResolvedValueOnce(handleMock);

    const result = await reviewManager.runReview('group_3000000001', {
      parentSession: parentSessionMock,
      mainModel: 'deepseek-chat',
    });

    expect(result.executed).toBe(true);
    expect(mockCtx.agents.create).toHaveBeenCalledWith(expect.objectContaining({
      seed: parentEvents.slice(0, 3),
      inheritedEventCount: 3,
      meta: expect.objectContaining({
        parentSession: 'qq-group-3000000001',
        isSeeded: true,
        cwd: '/workspace/project-root',
        origin: 'fork',
        allowedTools: expect.arrayContaining(['read_chat_history', 'read_memory']),
      }),
    }));
    expect(handleMock.dispose).toHaveBeenCalled();
  });

  it('契约 8: session/event turn/end 配合 snapshotEvents 精确统计工具调用数并触发门控', async () => {
    let sessionEventHandler: any;
    const listeners: Record<string, Function[]> = {};
    const testCtx: any = {
      get: (key: string) => {
        if (key === 'tools') return { register: vi.fn(), get: vi.fn() };
        if (key === 'systemPrompt') return { context: vi.fn() };
        return null;
      },
      on: (event: string, fn: Function) => {
        if (!listeners[event]) listeners[event] = [];
        listeners[event].push(fn);
        if (event === 'session/event') {
          sessionEventHandler = fn;
        }
        return () => {};
      },
      logger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
      emit: vi.fn(),
      agents: {
        create: vi.fn().mockResolvedValue({
          agent: { followup: vi.fn(), whenIdle: vi.fn() },
          dispose: vi.fn(),
        }),
      },
    };

    const memService = setupMemoryService(testCtx, {
      storageDir: tmpDir,
      reviewEnabled: true,
      reviewToolCallsInterval: 5,
      reviewTurnsInterval: 100,
    });

    const mockEvents = [
      { type: 'turn/start', seq: 1 },
      { type: 'tool/call', seq: 2, data: { name: 'read_memory' } },
      { type: 'tool/call', seq: 3, data: { name: 'append_memory' } },
      { type: 'tool/call', seq: 4, data: { name: 'fetch_web' } },
      { type: 'tool/call', seq: 5, data: { name: 'search_history' } },
      { type: 'tool/call', seq: 6, data: { name: 'update_memory' } },
    ];

    const dummySession = {
      id: 'qq-group-3000000001',
      snapshotEvents: () => mockEvents,
      history: [],
      meta: {},
    };

    // 模拟 turn/end 事件触发
    await sessionEventHandler(dummySession, {
      type: 'turn/end',
      seq: 7,
    });

    // toolCallsCount = 5，达到 reviewToolCallsInterval: 5 阈值，触发回顾
    expect(testCtx.agents.create).toHaveBeenCalled();
    memService.dispose();
  });

  it('契约 9: 后台回顾 Fork 会话挂载到工作区并在完成后安全解绑与清理', async () => {
    const parentEvents = [
      { type: 'turn/start', seq: 0 },
      { type: 'user/message', seq: 1, data: { content: '请帮我写个脚本' } },
      { type: 'assistant/message', seq: 2, data: { content: '好的' } },
      { type: 'turn/end', seq: 3 },
    ];

    const parentSessionMock = {
      id: 'main-session-qq-12345',
      header: { cwd: '/workspace/project-root' },
      snapshotEvents: vi.fn().mockReturnValue(parentEvents),
    };

    const attachSessionSpy = vi.fn().mockResolvedValue(undefined);
    const detachSessionSpy = vi.fn().mockResolvedValue(undefined);
    const fakeWorkspace = {
      id: 'ws-root',
      path: '/workspace/project-root',
      sessionIds: ['main-session-qq-12345'],
      attachSession: attachSessionSpy,
      detachSession: detachSessionSpy,
    };

    mockCtx.sessions = {
      get: vi.fn((id: string) => (id === 'main-session-qq-12345' ? parentSessionMock : undefined)),
      flush: vi.fn().mockResolvedValue(undefined),
      detachEntered: vi.fn().mockResolvedValue(undefined),
    };

    mockCtx.workspaceRegistry = {
      resolveByPath: vi.fn().mockResolvedValue(fakeWorkspace),
      list: vi.fn().mockReturnValue([fakeWorkspace]),
    };

    const handleMock = {
      agent: {
        followup: vi.fn().mockResolvedValue(undefined),
        whenIdle: vi.fn().mockResolvedValue(undefined),
      },
      dispose: vi.fn().mockResolvedValue(undefined),
    };
    mockCtx.agents.create.mockResolvedValueOnce(handleMock);

    // 仅传入 sessionId，验证 reviewManager 能通过 sessions.get 找到 parentSession
    const result = await reviewManager.runReview('group_12345', {
      sessionId: 'main-session-qq-12345',
      mainModel: 'deepseek-chat',
    });

    expect(result.executed).toBe(true);
    expect(mockCtx.sessions.get).toHaveBeenCalledWith('main-session-qq-12345');

    // 验证 agents.create 正确使用 DSH 原生 fork 契约
    expect(mockCtx.agents.create).toHaveBeenCalledWith(expect.objectContaining({
      seed: parentEvents,
      inheritedEventCount: 4,
      meta: expect.objectContaining({
        isBackgroundReview: true,
        origin: 'fork',
        parentSession: 'main-session-qq-12345',
        cwd: '/workspace/project-root',
        isSeeded: true,
      }),
    }));

    // 验证挂载到工作区：使 WebUI 侧边栏在运行期间正常显示
    expect(attachSessionSpy).toHaveBeenCalledWith(expect.stringMatching(/^review-group_12345-\d+$/));

    // 验证运行结束后安全解绑（用完即焚）
    expect(detachSessionSpy).toHaveBeenCalledWith(expect.stringMatching(/^review-group_12345-\d+$/));

    // 验证清理完成
    expect(handleMock.dispose).toHaveBeenCalled();
  });

  it('契约 10: 后台回顾 Prompt 必须注入目标 Peer 上下文与显式传参指示', async () => {
    let capturedPrompt = '';
    const handleMock = {
      agent: {
        followup: vi.fn().mockImplementation((msg: any) => {
          if (typeof msg === 'string') capturedPrompt = msg;
          else if (msg?.content?.[0]?.text) capturedPrompt = msg.content[0].text;
        }),
        whenIdle: vi.fn().mockResolvedValue(undefined),
      },
      dispose: vi.fn().mockResolvedValue(undefined),
    };
    mockCtx.agents.create.mockResolvedValueOnce(handleMock);

    const result = await reviewManager.runReview('group_123456789', {
      mainModel: 'deepseek-chat',
    });

    expect(result.executed).toBe(true);
    expect(capturedPrompt).toContain('You are reviewing peer: group_123456789');
    expect(capturedPrompt).toContain("When calling memory tools, always pass peer='group_123456789' explicitly.");
  });
});
