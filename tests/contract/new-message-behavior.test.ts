import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  IconChevronDownOutlineRegular: () => null,
  IconChevronDownOutlineMedium: () => null,
}));

import { SessionManager } from '../../src/gateway/session.js';
import { NapCatSettingsCard, type CardProps, type CardController } from '../../src/client/card.js';
import { DEFAULT_NEW_MESSAGE_BEHAVIOR } from '../../src/constants/index.js';

describe('契约测试: 运行中新消息行为模式 (New Message Behavior: Steer vs Queue)', () => {
  let tmpHome: string;
  let mockCtx: any;

  beforeEach(() => {
    tmpHome = path.join(os.tmpdir(), `dsh-msg-behavior-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(tmpHome, { recursive: true });

    mockCtx = {
      get: vi.fn(),
      logger: () => ({
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      }),
      config: {},
    };
  });

  it('契约 1: 默认配置下 (new_message_behavior 为 steer)，dispatchWakeup 优先调用 agent.steer 进行及时插话', async () => {
    const steerSpy = vi.fn();
    const followupSpy = vi.fn();

    const mockAgent: any = {
      status: 'running',
      steer: steerSpy,
      followup: followupSpy,
      session: { id: 'qq-group-1000000001' },
    };

    mockCtx.get = vi.fn((key: string) => {
      if (key === 'agents') {
        return {
          get: () => mockAgent,
          create: vi.fn().mockResolvedValue({ agent: mockAgent }),
          resume: vi.fn().mockResolvedValue({ agent: mockAgent }),
        };
      }
      return undefined;
    });

    const sessionManager = new SessionManager(mockCtx, tmpHome);

    const userMsg = await sessionManager.dispatchWakeup({
      trigger: 'direct',
      peer: 'group_1000000001',
      from_user: '10001',
      from_name: '测试用户',
      content: '请中途插话处理',
      timestamp: Date.now(),
    });

    expect(userMsg).toBeDefined();
    expect(steerSpy).toHaveBeenCalledTimes(1);
    expect(steerSpy).toHaveBeenCalledWith(userMsg);
    expect(followupSpy).not.toHaveBeenCalled();

    await sessionManager.dispose();
  });

  it('契约 2: 当显式配置 new_message_behavior 为 queue 时，dispatchWakeup 调用 agent.followup 加入队列', async () => {
    const steerSpy = vi.fn();
    const followupSpy = vi.fn();

    const mockAgent: any = {
      status: 'running',
      steer: steerSpy,
      followup: followupSpy,
      session: { id: 'qq-group-1000000002' },
    };

    mockCtx.config = {
      new_message_behavior: 'queue',
    };

    mockCtx.get = vi.fn((key: string) => {
      if (key === 'agents') {
        return {
          get: () => mockAgent,
          create: vi.fn().mockResolvedValue({ agent: mockAgent }),
          resume: vi.fn().mockResolvedValue({ agent: mockAgent }),
        };
      }
      return undefined;
    });

    const sessionManager = new SessionManager(mockCtx, tmpHome);

    const userMsg = await sessionManager.dispatchWakeup({
      trigger: 'direct',
      peer: 'group_1000000002',
      from_user: '10002',
      from_name: '测试用户2',
      content: '排队等待处理',
      timestamp: Date.now(),
    });

    expect(userMsg).toBeDefined();
    expect(followupSpy).toHaveBeenCalledTimes(1);
    expect(followupSpy).toHaveBeenCalledWith(userMsg);
    expect(steerSpy).not.toHaveBeenCalled();

    await sessionManager.dispose();
  });

  it('契约 3: 若 agent 实例未提供 steer 方法，自动降级调用 agent.followup', async () => {
    const followupSpy = vi.fn();

    const mockAgentWithoutSteer: any = {
      status: 'running',
      followup: followupSpy,
      session: { id: 'qq-group-1000000003' },
    };

    mockCtx.config = {
      new_message_behavior: 'steer',
    };

    mockCtx.get = vi.fn((key: string) => {
      if (key === 'agents') {
        return {
          get: () => mockAgentWithoutSteer,
          create: vi.fn().mockResolvedValue({ agent: mockAgentWithoutSteer }),
          resume: vi.fn().mockResolvedValue({ agent: mockAgentWithoutSteer }),
        };
      }
      return undefined;
    });

    const sessionManager = new SessionManager(mockCtx, tmpHome);

    const userMsg = await sessionManager.dispatchWakeup({
      trigger: 'direct',
      peer: 'group_1000000003',
      from_user: '10003',
      from_name: '测试用户3',
      content: '无 steer 方法降级测试',
      timestamp: Date.now(),
    });

    expect(userMsg).toBeDefined();
    expect(followupSpy).toHaveBeenCalledTimes(1);
    expect(followupSpy).toHaveBeenCalledWith(userMsg);

    await sessionManager.dispose();
  });

  it('契约 4: Card UI 回复配置面板在“滑动窗口保留条数”之下、“启用群聊主动回复”之上渲染新消息行为选择器', () => {
    let captured: CardController | null = null;
    const html = renderToStaticMarkup(
      React.createElement(NapCatSettingsCard, {
        initialExpanded: true,
        initialTab: 'proactive',
        initialConfig: {
          new_message_behavior: 'steer',
        },
        controllerRef: (ctrl) => {
          captured = ctrl;
        },
      })
    );

    expect(html).toContain('id="napcat-tabpanel-proactive"');
    expect(html).toContain('id="napcat-new-message-behavior"');
    expect(html).toContain('新消息行为 (new_message_behavior)');
    expect(html).toContain('value="steer"');
    expect(html).toContain('value="queue"');

    // 位置断言：在 napcat-proactive-buffer-size 之下，且在 napcat-proactive-reply-enabled 之上
    const bufferSizeIndex = html.indexOf('id="napcat-proactive-buffer-size"');
    const behaviorIndex = html.indexOf('id="napcat-new-message-behavior"');
    const replyEnabledIndex = html.indexOf('id="napcat-proactive-reply-enabled"');

    expect(bufferSizeIndex).toBeGreaterThan(-1);
    expect(behaviorIndex).toBeGreaterThan(bufferSizeIndex);
    expect(replyEnabledIndex).toBeGreaterThan(behaviorIndex);

    // 控制器双向绑定验证
    expect(captured).not.toBeNull();
    expect(captured!.model.getDraft().new_message_behavior).toBe(DEFAULT_NEW_MESSAGE_BEHAVIOR);

    captured!.handleFieldChange('new_message_behavior', 'queue');
    expect(captured!.model.getDraft().new_message_behavior).toBe('queue');
  });
});
