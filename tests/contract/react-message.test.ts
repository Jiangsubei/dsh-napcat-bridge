/**
 * 契约测试: react_message 贴表情工具及群聊会话隔离
 *
 * 覆盖规范清单:
 * 1. 仅群聊注册契约：群聊 Session 下 prompt 装配保留 react_message；私聊 Session 下 prompt 装配过滤 react_message；私聊/非群聊调用被 tools.guard 拦截拒执行。
 * 2. 语义键查表映射契约：传入 thumbs_up, laugh, doge 等，gateway 收到对应的 76, 233, 277。
 * 3. 默认 message_id 绑定契约：当 args.message_id 为空时自动使用当前入站上下文 msg_id。
 * 4. 显式 message_id 契约：传入具体 message_id 时优先使用传入的值。
 * 5. 非法表情名报错契约：传入中文或非法键名报错提示，严禁中文兜底。
 * 6. 无上下文且未传 message_id 报错保护契约。
 * 7. 网关未连接及 API 异常防护契约。
 * 8. GatewayServer setMsgEmojiLike 动作调用契约。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import {
  reactMessage,
  registerAgentTools,
  resetGlobalToolContext,
  EMOJI_MAP,
} from '../../src/tools/index.js';
import { NapCatGatewayServer } from '../../src/gateway/server.js';
import { apply } from '../../src/index.js';

beforeEach(() => {
  resetGlobalToolContext();
});

describe('契约 1: 仅群聊注册与会话隔离门控 (Session Isolation Contract)', () => {
  function setupTestApp() {
    const ctx = new Context();
    const registeredTools: any[] = [];
    let guardFn: ((exec: any) => string | undefined) | null = null;
    let assembleHandler: ((assembly: any, assembleCtx: any, next: any) => Promise<any>) | null = null;

    ctx.provide('tools');
    ctx.set('tools', {
      register: (tool: any) => {
        registeredTools.push(tool);
        return () => {
          const idx = registeredTools.indexOf(tool);
          if (idx >= 0) registeredTools.splice(idx, 1);
        };
      },
      guard: (fn: (exec: any) => string | undefined) => {
        guardFn = fn;
        return () => {
          guardFn = null;
        };
      },
    });

    // 拦截 on('system-prompt/assemble')
    const origOn = ctx.on.bind(ctx);
    ctx.on = ((event: string, listener: any) => {
      if (event === 'system-prompt/assemble') {
        assembleHandler = listener;
      }
      return origOn(event, listener);
    }) as any;

    apply(ctx, { bot_qq: '12345678' });

    return {
      ctx,
      registeredTools,
      getGuardFn: () => guardFn,
      getAssembleHandler: () => assembleHandler,
    };
  }

  it('群聊 Session (qq-group-*) 下 prompt 装配保留 react_message', async () => {
    const { getAssembleHandler } = setupTestApp();
    const handler = getAssembleHandler()!;
    expect(handler).toBeDefined();

    const mockNext = async () => ({
      tools: [
        { name: 'read_chat_history' },
        { name: 'react_message' },
        { name: 'send_file' },
      ],
    });

    const res = await handler(
      {},
      { agent: { session: { id: 'qq-group-987654321' } } },
      mockNext
    );

    const toolNames = res.tools.map((t: any) => t.name);
    expect(toolNames).toContain('react_message');
    expect(toolNames).toContain('read_chat_history');
  });

  it('群聊 Session (group_*) 下 prompt 装配保留 react_message', async () => {
    const { getAssembleHandler } = setupTestApp();
    const handler = getAssembleHandler()!;

    const mockNext = async () => ({
      tools: [{ name: 'react_message' }, { name: 'poke_user' }],
    });

    const res = await handler(
      {},
      { agent: { session: { id: 'group_987654321' } } },
      mockNext
    );

    const toolNames = res.tools.map((t: any) => t.name);
    expect(toolNames).toContain('react_message');
  });

  it('私聊 Session (qq-user-* / user_*) 下 prompt 装配过滤 react_message，但保留其他 QQ 工具', async () => {
    const { getAssembleHandler } = setupTestApp();
    const handler = getAssembleHandler()!;

    const mockNext = async () => ({
      tools: [
        { name: 'read_chat_history' },
        { name: 'react_message' },
        { name: 'send_file' },
        { name: 'poke_user' },
      ],
    });

    // 测试 qq-user- 格式
    const res1 = await handler(
      {},
      { agent: { session: { id: 'qq-user-11223344' } } },
      mockNext
    );
    const toolNames1 = res1.tools.map((t: any) => t.name);
    expect(toolNames1).not.toContain('react_message');
    expect(toolNames1).toContain('read_chat_history');
    expect(toolNames1).toContain('send_file');

    // 测试 user_ 格式
    const res2 = await handler(
      {},
      { agent: { session: { id: 'user_11223344' } } },
      mockNext
    );
    const toolNames2 = res2.tools.map((t: any) => t.name);
    expect(toolNames2).not.toContain('react_message');
    expect(toolNames2).toContain('read_chat_history');
  });

  it('非 QQ 会话 (Web / external) 下 prompt 装配过滤包括 react_message 在内的全部 NapCat 工具', async () => {
    const { getAssembleHandler } = setupTestApp();
    const handler = getAssembleHandler()!;

    const mockNext = async () => ({
      tools: [
        { name: 'read_chat_history' },
        { name: 'react_message' },
        { name: 'general_tool' },
      ],
    });

    const res = await handler(
      {},
      { agent: { session: { id: 'web-session-abc' } } },
      mockNext
    );
    const toolNames = res.tools.map((t: any) => t.name);
    expect(toolNames).not.toContain('react_message');
    expect(toolNames).not.toContain('read_chat_history');
    expect(toolNames).toContain('general_tool');
  });

  it('私聊 Session 调用 react_message 被 tools.guard 拦截拒执行', () => {
    const { getGuardFn } = setupTestApp();
    const guard = getGuardFn()!;
    expect(guard).toBeDefined();

    const decisionPrivate = guard({
      name: 'react_message',
      agent: { session: { id: 'qq-user-11223344' } },
    });
    expect(decisionPrivate).toBe('dsh-napcat-bridge: react_message 工具仅限群聊调用，当前会话不可执行');

    const decisionUser = guard({
      name: 'react_message',
      agent: { session: { id: 'user_11223344' } },
    });
    expect(decisionUser).toBe('dsh-napcat-bridge: react_message 工具仅限群聊调用，当前会话不可执行');
  });

  it('Web / 非群聊 Session 调用 react_message 被 tools.guard 拦截拒执行', () => {
    const { getGuardFn } = setupTestApp();
    const guard = getGuardFn()!;

    const decisionWeb = guard({
      name: 'react_message',
      agent: { session: { id: 'web-session-test' } },
    });
    expect(decisionWeb).toBe('dsh-napcat-bridge: react_message 工具仅限群聊调用，当前会话不可执行');
  });

  it('群聊 Session 调用 react_message 被 tools.guard 正常放行', () => {
    const { getGuardFn } = setupTestApp();
    const guard = getGuardFn()!;

    const decisionGroup1 = guard({
      name: 'react_message',
      agent: { session: { id: 'qq-group-987654321' } },
    });
    expect(decisionGroup1).toBeUndefined();

    const decisionGroup2 = guard({
      name: 'react_message',
      agent: { session: { id: 'group_987654321' } },
    });
    expect(decisionGroup2).toBeUndefined();
  });
});

describe('契约 2: 语义键查表映射与执行契约 (Emoji Mapping Contract)', () => {
  it('映射表完整包含用户确认的 26 个语义键且各字段正确', () => {
    const expectedKeys = [
      'thumbs_up', 'heart', 'laugh', 'grin', 'snicker', 'doge', 'ok', 'cry',
      'grievance', 'hug', 'rose', 'cheer', 'touch_fish', 'celebrate', 'cute',
      'thinking', 'sweat', 'cat', 'skull', 'poop', 'pig', 'button', 'hammer',
      'baldy', 'victim', 'rage',
    ];

    expect(Object.keys(EMOJI_MAP).sort()).toEqual(expectedKeys.sort());
    expect(EMOJI_MAP.thumbs_up).toEqual({ id: '76', name: '点赞' });
    expect(EMOJI_MAP.laugh).toEqual({ id: '233', name: '笑哭' });
    expect(EMOJI_MAP.doge).toEqual({ id: '277', name: '狗头' });
    expect(EMOJI_MAP.heart).toEqual({ id: '66', name: '爱心' });
    expect(EMOJI_MAP.button).toEqual({ id: '424', name: '狂按按钮' });
    expect(EMOJI_MAP.rage).toEqual({ id: '146', name: '爆筋' });
  });

  it('传入 thumbs_up、laugh、doge 等，gateway 正确收到对应的 76、233、277', async () => {
    const mockSetMsgEmojiLike = vi.fn().mockResolvedValue({ status: 'ok', retcode: 0, data: {} });
    const mockGateway = { setMsgEmojiLike: mockSetMsgEmojiLike } as any;

    // 1. thumbs_up -> 76
    const res1 = await reactMessage(
      { emoji: 'thumbs_up', message_id: 1001 },
      { gateway: mockGateway, peer: 'group_123' }
    );
    expect(res1).toEqual({
      success: true,
      message_id: 1001,
      emoji: 'thumbs_up',
      emoji_id: '76',
    });
    expect(mockSetMsgEmojiLike).toHaveBeenCalledWith(1001, '76');

    // 2. laugh -> 233
    const res2 = await reactMessage(
      { emoji: 'laugh', message_id: 1002 },
      { gateway: mockGateway, peer: 'group_123' }
    );
    expect(res2).toEqual({
      success: true,
      message_id: 1002,
      emoji: 'laugh',
      emoji_id: '233',
    });
    expect(mockSetMsgEmojiLike).toHaveBeenCalledWith(1002, '233');

    // 3. doge -> 277
    const res3 = await reactMessage(
      { emoji: 'doge', message_id: 1003 },
      { gateway: mockGateway, peer: 'group_123' }
    );
    expect(res3).toEqual({
      success: true,
      message_id: 1003,
      emoji: 'doge',
      emoji_id: '277',
    });
    expect(mockSetMsgEmojiLike).toHaveBeenCalledWith(1003, '277');
  });

  it('defineTool 注册的 react_message render 正确渲染贴表情成功文案', async () => {
    const ctx = new Context();
    let registeredTool: any = null;
    ctx.provide('tools');
    ctx.set('tools', {
      register: (tool: any) => {
        if (tool.name === 'react_message') {
          registeredTool = tool;
        }
        return () => {};
      },
    });

    const mockGateway = {
      setMsgEmojiLike: vi.fn().mockResolvedValue({ status: 'ok', retcode: 0, data: {} }),
    } as any;

    registerAgentTools(ctx, {
      db: {} as any,
      gateway: mockGateway,
      mediaManager: {} as any,
      inboundMsgIdGetter: () => 8888,
    });

    expect(registeredTool).toBeDefined();
    expect(registeredTool.name).toBe('react_message');
    expect(registeredTool.description).toBe('收到消息时可调用本工具，以表情回应。');

    // 成功 render
    const rendered = registeredTool.output.render(
      { emoji: 'thumbs_up' },
      { success: true, message_id: 8888, emoji: 'thumbs_up', emoji_id: '76' }
    );
    expect(rendered).toEqual([
      {
        type: 'text',
        text: '已对消息 8888 贴表情 [点赞]',
      },
    ]);

    // 失败 render
    const renderedFailed = registeredTool.output.render(
      { emoji: 'thumbs_up' },
      { success: false, error: 'NapCat 未连接 (gateway 不可用)' }
    );
    expect(renderedFailed).toEqual([
      {
        type: 'text',
        text: '贴表情失败: NapCat 未连接 (gateway 不可用)',
      },
    ]);
  });
});

describe('契约 3: 默认 message_id 上下文绑定契约 (Default Binding Contract)', () => {
  it('当 args.message_id 为空时自动使用 inboundMsgIdGetter 返回的入站消息 ID', async () => {
    const mockSetMsgEmojiLike = vi.fn().mockResolvedValue({ status: 'ok', retcode: 0, data: {} });
    const mockGateway = { setMsgEmojiLike: mockSetMsgEmojiLike } as any;

    const inboundGetter = vi.fn((peer: string) => {
      if (peer === 'group_999') return 654321;
      return undefined;
    });

    const res = await reactMessage(
      { emoji: 'ok' },
      {
        gateway: mockGateway,
        peer: 'group_999',
        inboundMsgIdGetter: inboundGetter,
      }
    );

    expect(inboundGetter).toHaveBeenCalledWith('group_999');
    expect(res).toEqual({
      success: true,
      message_id: 654321,
      emoji: 'ok',
      emoji_id: '124',
    });
    expect(mockSetMsgEmojiLike).toHaveBeenCalledWith(654321, '124');
  });

  it('支持在 peer 为 qq-group-xxx 时自动归一化查入站上下文', async () => {
    const mockSetMsgEmojiLike = vi.fn().mockResolvedValue({ status: 'ok', retcode: 0, data: {} });
    const mockGateway = { setMsgEmojiLike: mockSetMsgEmojiLike } as any;

    const inboundGetter = vi.fn((peer: string) => {
      if (peer === 'group_888') return 77777;
      return undefined;
    });

    const res = await reactMessage(
      { emoji: 'heart' },
      {
        gateway: mockGateway,
        peer: 'qq-group-888',
        inboundMsgIdGetter: inboundGetter,
      }
    );

    expect(res.success).toBe(true);
    expect(res.message_id).toBe(77777);
    expect(mockSetMsgEmojiLike).toHaveBeenCalledWith(77777, '66');
  });
});

describe('契约 4: 显式 message_id 优先级契约 (Explicit Message ID Priority Contract)', () => {
  it('传入具体 message_id 时优先使用传入的值，而非上下文绑定的入站消息 ID', async () => {
    const mockSetMsgEmojiLike = vi.fn().mockResolvedValue({ status: 'ok', retcode: 0, data: {} });
    const mockGateway = { setMsgEmojiLike: mockSetMsgEmojiLike } as any;

    const inboundGetter = vi.fn(() => 11111);

    const res = await reactMessage(
      { emoji: 'rose', message_id: 99999 },
      {
        gateway: mockGateway,
        peer: 'group_123',
        inboundMsgIdGetter: inboundGetter,
      }
    );

    expect(res).toEqual({
      success: true,
      message_id: 99999,
      emoji: 'rose',
      emoji_id: '63',
    });
    // 不应调用 getter 或即使调用了也必须优先使用 99999
    expect(mockSetMsgEmojiLike).toHaveBeenCalledWith(99999, '63');
  });
});

describe('契约 5: 非法表情名报错与严禁中文兜底契约 (Invalid Emoji Contract)', () => {
  it('传入中文表情名直接报错，严禁中文兜底，不调用 gateway', async () => {
    const mockSetMsgEmojiLike = vi.fn();
    const mockGateway = { setMsgEmojiLike: mockSetMsgEmojiLike } as any;

    const res = await reactMessage(
      { emoji: '点赞', message_id: 12345 },
      { gateway: mockGateway, peer: 'group_123' }
    );

    expect(res.success).toBe(false);
    expect(res.error).toContain("未知的表情名 '点赞'。请从以下支持的表情中选择: ");
    expect(res.error).toContain('thumbs_up, heart, laugh');
    expect(mockSetMsgEmojiLike).not.toHaveBeenCalled();
  });

  it('传入未定义的英文表情键直接报错，不调用 gateway', async () => {
    const mockSetMsgEmojiLike = vi.fn();
    const mockGateway = { setMsgEmojiLike: mockSetMsgEmojiLike } as any;

    const res = await reactMessage(
      { emoji: 'thumbs_down', message_id: 12345 },
      { gateway: mockGateway, peer: 'group_123' }
    );

    expect(res.success).toBe(false);
    expect(res.error).toContain("未知的表情名 'thumbs_down'。请从以下支持的表情中选择: ");
    expect(mockSetMsgEmojiLike).not.toHaveBeenCalled();
  });
});

describe('契约 6: 无上下文且未传 message_id 报错保护契约 (Missing Context Protection Contract)', () => {
  it('未传 message_id 且未在上下文找到入站消息 ID，直接返回清晰错误保护，不调用 gateway', async () => {
    const mockSetMsgEmojiLike = vi.fn();
    const mockGateway = { setMsgEmojiLike: mockSetMsgEmojiLike } as any;

    const res = await reactMessage(
      { emoji: 'thumbs_up' },
      { gateway: mockGateway, peer: 'group_123', inboundMsgIdGetter: () => undefined }
    );

    expect(res).toEqual({
      success: false,
      error: '未提供 message_id 且当前回合无入站消息上下文',
    });
    expect(mockSetMsgEmojiLike).not.toHaveBeenCalled();
  });

  it('未提供 inboundMsgIdGetter 且未传 message_id，直接返回清晰错误保护', async () => {
    const mockSetMsgEmojiLike = vi.fn();
    const mockGateway = { setMsgEmojiLike: mockSetMsgEmojiLike } as any;

    const res = await reactMessage(
      { emoji: 'thumbs_up' },
      { gateway: mockGateway, peer: 'group_123' }
    );

    expect(res).toEqual({
      success: false,
      error: '未提供 message_id 且当前回合无入站消息上下文',
    });
    expect(mockSetMsgEmojiLike).not.toHaveBeenCalled();
  });
});

describe('契约 7: 网关可用性校验与异常保护契约 (Gateway Availability & Error Contract)', () => {
  it('gateway 未连接时返回清晰失败提示', async () => {
    const res = await reactMessage(
      { emoji: 'thumbs_up', message_id: 12345 },
      { gateway: null, peer: 'group_123' }
    );

    expect(res).toEqual({
      success: false,
      error: 'NapCat 未连接 (gateway 不可用)',
    });
  });

  it('NapCat API 返回 status failed 时透传错误信息', async () => {
    const mockGateway = {
      setMsgEmojiLike: vi.fn().mockResolvedValue({
        status: 'failed',
        retcode: 100,
        message: '消息已过期无法回应',
      }),
    } as any;

    const res = await reactMessage(
      { emoji: 'thumbs_up', message_id: 12345 },
      { gateway: mockGateway, peer: 'group_123' }
    );

    expect(res.success).toBe(false);
    expect(res.error).toBe('消息已过期无法回应');
  });

  it('NapCat API 调用抛出网络异常时捕获并返回', async () => {
    const mockGateway = {
      setMsgEmojiLike: vi.fn().mockRejectedValue(new Error('WebSocket connection lost')),
    } as any;

    const res = await reactMessage(
      { emoji: 'thumbs_up', message_id: 12345 },
      { gateway: mockGateway, peer: 'group_123' }
    );

    expect(res.success).toBe(false);
    expect(res.error).toBe('WebSocket connection lost');
  });
});

describe('契约 8: NapCatGatewayServer.setMsgEmojiLike 动作契约 (Gateway Action Contract)', () => {
  it('调用 setMsgEmojiLike 时正确下发 set_msg_emoji_like action 载荷', async () => {
    const server = new NapCatGatewayServer({ port: 19999 });
    const sendActionSpy = vi.spyOn(server, 'sendAction').mockResolvedValue({
      status: 'ok',
      retcode: 0,
      data: {},
    });

    await server.setMsgEmojiLike(54321, '76', true);

    expect(sendActionSpy).toHaveBeenCalledWith('set_msg_emoji_like', {
      message_id: 54321,
      emoji_id: '76',
      set: true,
    });
  });
});
