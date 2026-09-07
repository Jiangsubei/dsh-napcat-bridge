/**
 * 契约测试: send_message 主动发言工具及会话隔离
 *
 * 覆盖规范清单:
 * 契约 1: 注册范围与隔离门控（QQ 群聊与私聊 Session 下装配包含 send_message；WebUI、review 沙箱、加好友 session 下过滤排除；非法会话被 tools.guard 拦截拒执行）；
 * 契约 2: 空文本 / 纯空白 / stripMarkdown 后为空报错契约（返回"发送内容不能为空。"，不调用网关）；
 * 契约 3: 网关返回失败或异常时透传报错（"消息发送失败: ..."）；
 * 契约 4: 成功发送并返回 message_id 与 sent_preview，消息走 stripMarkdown 排版，并经过串行队列下发；
 * 契约 5: 超长文本自动分段分批下发；
 * 契约 6: 防御守卫：缺少 peer/会话上下文时安全报错拦截。
 */

import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fsp } from 'node:fs';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import { bootDshNapcatBridge, type BootedDsh } from '../../src/boot.js';
import {
  sendMessage,
  splitMessageText,
  registerAgentTools,
  resetGlobalToolContext,
} from '../../src/tools/index.js';
import { apply } from '../../src/index.js';

beforeEach(() => {
  resetGlobalToolContext();
});

describe('契约 1: 注册范围与会话隔离门控 (Session Isolation Contract)', () => {
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

    const origOn = ctx.on.bind(ctx);
    ctx.on = ((event: string, listener: any) => {
      if (event === 'system-prompt/assemble') {
        assembleHandler = listener;
      }
      return origOn(event, listener);
    }) as any;

    apply(ctx, { bot_qq: '12345678', ws_port: 29878 });

    return {
      ctx,
      registeredTools,
      getGuardFn: () => guardFn,
      getAssembleHandler: () => assembleHandler,
    };
  }

  it('1.1 QQ 群聊 Session (qq-group-* / group_*) 下 prompt 装配保留 send_message，guard 放行', async () => {
    const { getAssembleHandler, getGuardFn } = setupTestApp();
    const handler = getAssembleHandler()!;
    expect(handler).toBeDefined();

    const mockNext = async () => ({
      tools: [
        { name: 'read_chat_history' },
        { name: 'send_message' },
        { name: 'react_message' },
      ],
    });

    // 1.1.1 qq-group- 前缀
    const res1 = await handler(
      {},
      { agent: { session: { id: 'qq-group-10001' } } },
      mockNext
    );
    expect(res1.tools.map((t: any) => t.name)).toContain('send_message');

    // 1.1.2 group_ 前缀
    const res2 = await handler(
      {},
      { agent: { session: { id: 'group_10001' } } },
      mockNext
    );
    expect(res2.tools.map((t: any) => t.name)).toContain('send_message');

    // guard 校验放行
    const guard = getGuardFn()!;
    expect(guard({ name: 'send_message', agent: { session: { id: 'qq-group-10001' } } })).toBeUndefined();
    expect(guard({ name: 'send_message', agent: { session: { id: 'group_10001' } } })).toBeUndefined();
  });

  it('1.2 QQ 私聊 Session (qq-user-* / user_*) 下 prompt 装配保留 send_message，guard 放行（与 react_message 仅群聊不同）', async () => {
    const { getAssembleHandler, getGuardFn } = setupTestApp();
    const handler = getAssembleHandler()!;

    const mockNext = async () => ({
      tools: [
        { name: 'read_chat_history' },
        { name: 'send_message' },
        { name: 'react_message' },
      ],
    });

    // 1.2.1 qq-user- 前缀
    const res1 = await handler(
      {},
      { agent: { session: { id: 'qq-user-20002' } } },
      mockNext
    );
    const toolNames1 = res1.tools.map((t: any) => t.name);
    expect(toolNames1).toContain('send_message');
    expect(toolNames1).not.toContain('react_message'); // react_message 私聊应被过滤

    // 1.2.2 user_ 前缀
    const res2 = await handler(
      {},
      { agent: { session: { id: 'user_20002' } } },
      mockNext
    );
    const toolNames2 = res2.tools.map((t: any) => t.name);
    expect(toolNames2).toContain('send_message');
    expect(toolNames2).not.toContain('react_message');

    // guard 校验放行
    const guard = getGuardFn()!;
    expect(guard({ name: 'send_message', agent: { session: { id: 'qq-user-20002' } } })).toBeUndefined();
    expect(guard({ name: 'send_message', agent: { session: { id: 'user_20002' } } })).toBeUndefined();
  });

  it('1.3 非 QQ 会话 (Web UI web-*) 下 prompt 装配过滤 send_message，guard 拦截拒执行', async () => {
    const { getAssembleHandler, getGuardFn } = setupTestApp();
    const handler = getAssembleHandler()!;

    const mockNext = async () => ({
      tools: [
        { name: 'send_message' },
        { name: 'other_tool' },
      ],
    });

    const res = await handler(
      {},
      { agent: { session: { id: 'web-session-test' } } },
      mockNext
    );
    expect(res.tools.map((t: any) => t.name)).not.toContain('send_message');
    expect(res.tools.map((t: any) => t.name)).toContain('other_tool');

    const guard = getGuardFn()!;
    const decision = guard({ name: 'send_message', agent: { session: { id: 'web-session-test' } } });
    expect(decision).toBe('dsh-napcat-bridge: send_message 工具仅限 QQ 聊天会话调用，当前会话不可执行');
  });

  it('1.4 Background Review 沙箱 (review-*) 下严禁注册 send_message，guard 拦截拒执行', async () => {
    const { getAssembleHandler, getGuardFn } = setupTestApp();
    const handler = getAssembleHandler()!;

    const mockNext = async () => ({
      tools: [
        { name: 'read_memory' },
        { name: 'send_message' },
      ],
    });

    const res = await handler(
      {},
      { agent: { session: { id: 'review-group_10001' } } },
      mockNext
    );
    expect(res.tools.map((t: any) => t.name)).not.toContain('send_message');
    expect(res.tools.map((t: any) => t.name)).toContain('read_memory');

    const guard = getGuardFn()!;
    const decision = guard({ name: 'send_message', agent: { session: { id: 'review-group_10001' } } });
    expect(decision).toBe('dsh-napcat-bridge: send_message 工具仅限 QQ 聊天会话调用，当前会话不可执行');
  });

  it('1.5 加好友专用 Session (friend-request-*) 下严禁注册 send_message，guard 拦截拒执行', async () => {
    const { getAssembleHandler, getGuardFn } = setupTestApp();
    const handler = getAssembleHandler()!;

    const mockNext = async () => ({
      tools: [
        { name: 'send_message' },
      ],
    });

    const res = await handler(
      {},
      { agent: { session: { id: 'friend-request-30003' } } },
      mockNext
    );
    expect(res.tools.map((t: any) => t.name)).not.toContain('send_message');

    const guard = getGuardFn()!;
    const decision = guard({ name: 'send_message', agent: { session: { id: 'friend-request-30003' } } });
    expect(decision).toBe('dsh-napcat-bridge: send_message 工具仅限 QQ 聊天会话调用，当前会话不可执行');
  });

  it('1.6 defineTool 声明工具名、参数与描述完全对齐需求规范 §1.5', () => {
    const ctx = new Context();
    let registeredTool: any = null;
    ctx.provide('tools');
    ctx.set('tools', {
      register: (tool: any) => {
        if (tool.name === 'send_message') {
          registeredTool = tool;
        }
        return () => {};
      },
    });

    registerAgentTools(ctx, {
      db: {} as any,
      gateway: {} as any,
      mediaManager: {} as any,
    });

    expect(registeredTool).toBeDefined();
    expect(registeredTool.name).toBe('send_message');
    expect(registeredTool.description).toBe(
      '向当前 QQ 会话（群聊/私聊）主动发送一条文本给用户。\n' +
      '- 长任务进行中：向用户汇报进度或说明需要等待\n' +
      '- 任务完成时：发送最终答复（务必用本工具发）\n' +
      '- 每条 text 为一条独立 QQ 消息，过长自动分段'
    );
    expect(registeredTool.parameters).toEqual({
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: '要发送给用户的文本内容',
        },
      },
      required: ['text'],
    });
  });
});

describe('契约 2: 空文本 / 纯空白 / stripMarkdown 后为空报错契约 (Empty Text Contract)', () => {
  it('传入空字符串 text="" 时返回"发送内容不能为空。"，不调用网关', async () => {
    const mockSendMsg = vi.fn();
    const gateway = { sendMsg: mockSendMsg } as any;

    const res = await sendMessage(
      { text: '' },
      { gateway, peer: 'group_1001' }
    );

    expect(res).toEqual({
      success: false,
      error: '发送内容不能为空。',
    });
    expect(mockSendMsg).not.toHaveBeenCalled();
  });

  it('传入纯空白字符串时返回"发送内容不能为空。"，不调用网关', async () => {
    const mockSendMsg = vi.fn();
    const gateway = { sendMsg: mockSendMsg } as any;

    const res = await sendMessage(
      { text: '   \n  \t   ' },
      { gateway, peer: 'group_1001' }
    );

    expect(res).toEqual({
      success: false,
      error: '发送内容不能为空。',
    });
    expect(mockSendMsg).not.toHaveBeenCalled();
  });

  it('传入纯 Markdown 符号在 stripMarkdown 后变为空白时返回"发送内容不能为空。"，不调用网关', async () => {
    const mockSendMsg = vi.fn();
    const gateway = { sendMsg: mockSendMsg } as any;

    const res = await sendMessage(
      { text: '```\n\n```' },
      { gateway, peer: 'group_1001' }
    );

    expect(res).toEqual({
      success: false,
      error: '发送内容不能为空。',
    });
    expect(mockSendMsg).not.toHaveBeenCalled();
  });
});

describe('契约 3: 网关返回失败或异常时透传报错 (Gateway Error Contract)', () => {
  it('NapCat API 返回 status failed 且带 wording 时透传报错', async () => {
    const gateway = {
      sendMsg: vi.fn().mockResolvedValue({
        status: 'failed',
        retcode: 100,
        wording: '消息发送受限',
      }),
    } as any;

    const res = await sendMessage(
      { text: '你好' },
      { gateway, peer: 'group_1001' }
    );

    expect(res).toEqual({
      success: false,
      error: '消息发送失败: 消息发送受限',
    });
  });

  it('NapCat API 返回 status failed 且仅带 retcode 时透传 retcode', async () => {
    const gateway = {
      sendMsg: vi.fn().mockResolvedValue({
        status: 'failed',
        retcode: 102,
      }),
    } as any;

    const res = await sendMessage(
      { text: '你好' },
      { gateway, peer: 'group_1001' }
    );

    expect(res).toEqual({
      success: false,
      error: '消息发送失败: 102',
    });
  });

  it('网关抛出网络异常时捕获并透传错误', async () => {
    const gateway = {
      sendMsg: vi.fn().mockRejectedValue(new Error('WebSocket 连接中断')),
    } as any;

    const res = await sendMessage(
      { text: '你好' },
      { gateway, peer: 'group_1001' }
    );

    expect(res).toEqual({
      success: false,
      error: '消息发送失败: WebSocket 连接中断',
    });
  });

  it('缺少 gateway 实例时返回 NapCat 未连接报错', async () => {
    const res = await sendMessage(
      { text: '你好' },
      { gateway: null, peer: 'group_1001' }
    );

    expect(res).toEqual({
      success: false,
      error: '消息发送失败: NapCat 未连接 (gateway 不可用)',
    });
  });
});

describe('契约 4: 成功发送并返回 message_id 与 sent_preview，消息走 stripMarkdown 排版与串行队列 (Success Contract)', () => {
  it('Markdown 语法被正确 strip，并经由串行队列排队下发', async () => {
    const mockSendMsg = vi.fn().mockResolvedValue({
      status: 'ok',
      retcode: 0,
      data: { message_id: 67890 },
    });
    const gateway = { sendMsg: mockSendMsg } as any;

    const enqueueCalls: string[] = [];
    const sender = {
      enqueue: vi.fn(async (peer: string, task: () => Promise<any>) => {
        enqueueCalls.push(peer);
        return task();
      }),
    };

    const res = await sendMessage(
      { text: '# 进度汇报\n**当前状态**: 正在下载 `file.txt`' },
      {
        gateway,
        sender,
        peer: 'group_1001',
      }
    );

    expect(res).toEqual({
      success: true,
      message_id: 67890,
      sent_preview: '【进度汇报】\n当前状态: 正在下载 file.txt',
    });

    // 验证经过串行队列
    expect(sender.enqueue).toHaveBeenCalledTimes(1);
    expect(enqueueCalls).toEqual(['group_1001']);

    // 验证 stripMarkdown 结果
    expect(mockSendMsg).toHaveBeenCalledWith('group_1001', '【进度汇报】\n当前状态: 正在下载 file.txt');
  });

  it('QQ 私聊会话 (qq-user-*) 下发正常通过并归一化 peer', async () => {
    const mockSendMsg = vi.fn().mockResolvedValue({
      status: 'ok',
      retcode: 0,
      data: { message_id: 11223 },
    });
    const gateway = { sendMsg: mockSendMsg } as any;

    const sender = {
      enqueue: vi.fn(async (_peer: string, task: () => Promise<any>) => task()),
    };

    const res = await sendMessage(
      { text: '私聊测试消息' },
      {
        gateway,
        sender,
        peer: 'qq-user-54321',
      }
    );

    expect(res).toEqual({
      success: true,
      message_id: 11223,
      sent_preview: '私聊测试消息',
    });
    expect(sender.enqueue).toHaveBeenCalledWith('user_54321', expect.any(Function));
    expect(mockSendMsg).toHaveBeenCalledWith('user_54321', '私聊测试消息');
  });

  it('defineTool output.render 正确渲染成功与失败文本', () => {
    const ctx = new Context();
    let registeredTool: any = null;
    ctx.provide('tools');
    ctx.set('tools', {
      register: (tool: any) => {
        if (tool.name === 'send_message') {
          registeredTool = tool;
        }
        return () => {};
      },
    });

    registerAgentTools(ctx, {
      db: {} as any,
      gateway: {} as any,
      mediaManager: {} as any,
    });

    // 成功 render
    const renderedOk = registeredTool.output.render(
      { text: '测试内容' },
      { success: true, message_id: 12345, sent_preview: '测试内容' }
    );
    expect(renderedOk).toEqual([
      {
        type: 'text',
        text: '消息发送成功 (message_id: 12345)\n预览: 测试内容',
      },
    ]);

    // 失败 render
    const renderedFail = registeredTool.output.render(
      { text: '测试内容' },
      { success: false, error: 'NapCat 未连接' }
    );
    expect(renderedFail).toEqual([
      {
        type: 'text',
        text: '消息发送失败: NapCat 未连接',
      },
    ]);
  });
});

describe('契约 5: 超长文本自动分段分批下发 (Long Message Chunking Contract)', () => {
  it('splitMessageText 工具函数在超出限制时正确按长度/换行分段', () => {
    const shortText = '这是一条普通消息';
    expect(splitMessageText(shortText, 1500)).toEqual([shortText]);

    // 3200 字符
    const line = '测试分段内容。'.repeat(100); // 700 字符
    const longText = `${line}\n${line}\n${line}\n${line}\n${line}`; // 3500+ 字符
    const chunks = splitMessageText(longText, 1500);

    expect(chunks.length).toBeGreaterThanOrEqual(3);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(1500);
      expect(chunk.trim().length).toBeGreaterThan(0);
    }
  });

  it('超长文本自动分段并通过串行队列按序分批下发，返回末条 message_id 与前缀 preview', async () => {
    const sentMessages: string[] = [];
    const mockSendMsg = vi.fn().mockImplementation(async (_peer: string, msg: string) => {
      sentMessages.push(msg);
      return {
        status: 'ok',
        retcode: 0,
        data: { message_id: 1000 + sentMessages.length },
      };
    });
    const gateway = { sendMsg: mockSendMsg } as any;

    const longText = '一段超长的长文本测试内容。'.repeat(200); // 2600 字符
    const res = await sendMessage(
      { text: longText },
      {
        gateway,
        peer: 'group_1001',
      }
    );

    expect(res.success).toBe(true);
    expect(mockSendMsg).toHaveBeenCalledTimes(2);
    expect(res.message_id).toBe(1002); // 第二批的 message_id
    expect(res.sent_preview?.endsWith('...')).toBe(true);
    expect(res.sent_preview?.length).toBeLessThanOrEqual(63);
  });
});

describe('契约 6: 防御守卫：缺少 peer/会话上下文时安全报错拦截 (Missing Context Contract)', () => {
  it('未提供 peer 上下文时返回清晰错误，不调用网关', async () => {
    const mockSendMsg = vi.fn();
    const gateway = { sendMsg: mockSendMsg } as any;

    const res = await sendMessage(
      { text: '测试文本' },
      { gateway, peer: undefined }
    );

    expect(res).toEqual({
      success: false,
      error: 'send_message 需在 QQ 会话中执行',
    });
    expect(mockSendMsg).not.toHaveBeenCalled();
  });

  it('peer 为非 QQ 会话 (如 web-xxx) 时返回清晰错误，不调用网关', async () => {
    const mockSendMsg = vi.fn();
    const gateway = { sendMsg: mockSendMsg } as any;

    const res = await sendMessage(
      { text: '测试文本' },
      { gateway, peer: 'web-session-123' }
    );

    expect(res).toEqual({
      success: false,
      error: 'send_message 需在 QQ 会话中执行',
    });
    expect(mockSendMsg).not.toHaveBeenCalled();
  });

  it('peer 为 review 沙箱时返回清晰错误，不调用网关', async () => {
    const mockSendMsg = vi.fn();
    const gateway = { sendMsg: mockSendMsg } as any;

    const res = await sendMessage(
      { text: '测试文本' },
      { gateway, peer: 'review-group_1001' }
    );

    expect(res).toEqual({
      success: false,
      error: 'send_message 需在 QQ 会话中执行',
    });
    expect(mockSendMsg).not.toHaveBeenCalled();
  });

  it('peer 为加好友专用 session (friend-request-*) 时返回清晰错误，不调用网关', async () => {
    const mockSendMsg = vi.fn();
    const gateway = { sendMsg: mockSendMsg } as any;

    const res = await sendMessage(
      { text: '测试文本' },
      { gateway, peer: 'friend-request-1001' }
    );

    expect(res).toEqual({
      success: false,
      error: 'send_message 需在 QQ 会话中执行',
    });
    expect(mockSendMsg).not.toHaveBeenCalled();
  });
});

describe('契约 7: 真实生产装配闭环 (Real Assembly Contract via bootDshNapcatBridge)', () => {
  let tmpHome: string;
  let booted: BootedDsh;
  const TEST_PORT = 29899;

  beforeEach(async () => {
    tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-send-msg-asm-'));
    booted = await bootDshNapcatBridge({
      dshHome: tmpHome,
      mountPlugin: true,
      config: {
        bot_qq: '1000000001',
        ws_port: TEST_PORT,
      },
    });
  });

  afterEach(async () => {
    if (booted) {
      await booted.dispose().catch(() => {});
    }
    if (tmpHome) {
      await fsp.rm(tmpHome, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('真实装配下：QQ 群聊与私聊包含 send_message，WebUI 与沙箱排除，且 guard 拦截非法调用', async () => {
    const ctx = booted.ctx;
    const tools: any = ctx.get('tools');

    // 1. QQ 群聊 Agent
    const qqGroupHandle = await ctx.agents.create({
      sessionId: 'qq-group-8888',
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      meta: { cwd: path.join(tmpHome, 'qq-ws-group') },
    });
    const qqGroupAgent = qqGroupHandle.agent || qqGroupHandle;
    const asmGroup = await ctx.systemPrompt.assemble({ scope: qqGroupAgent, agent: qqGroupAgent } as any);
    const groupToolNames = (asmGroup.tools as any[]).map((t) => t.name);
    expect(groupToolNames).toContain('send_message');

    // 2. QQ 私聊 Agent
    const qqUserHandle = await ctx.agents.create({
      sessionId: 'qq-user-9999',
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      meta: { cwd: path.join(tmpHome, 'qq-ws-user') },
    });
    const qqUserAgent = qqUserHandle.agent || qqUserHandle;
    const asmUser = await ctx.systemPrompt.assemble({ scope: qqUserAgent, agent: qqUserAgent } as any);
    const userToolNames = (asmUser.tools as any[]).map((t) => t.name);
    expect(userToolNames).toContain('send_message');

    // 3. Web UI Agent (隔离)
    const webHandle = await ctx.agents.create({
      sessionId: 'web-session-8888',
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      meta: { cwd: path.join(tmpHome, 'web-ws') },
    });
    const webAgent = webHandle.agent || webHandle;
    const asmWeb = await ctx.systemPrompt.assemble({ scope: webAgent, agent: webAgent } as any);
    const webToolNames = (asmWeb.tools as any[]).map((t) => t.name);
    expect(webToolNames).not.toContain('send_message');

    // Web 会话调用 send_message 被 tools.guard 拒绝
    const webExec = await tools.execute({
      name: 'send_message',
      arguments: { text: 'test' },
      agent: webAgent,
      signal: new AbortController().signal,
    });
    expect(webExec.isError).toBe(true);
    expect((webExec as any).error?.message).toContain('dsh-napcat-bridge: send_message 工具仅限 QQ 聊天会话调用');

    // 4. Review 沙箱 Agent (隔离)
    const reviewHandle = await ctx.agents.create({
      sessionId: 'review-group_8888',
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      meta: { cwd: path.join(tmpHome, 'review-ws') },
    });
    const reviewAgent = reviewHandle.agent || reviewHandle;
    const asmReview = await ctx.systemPrompt.assemble({ scope: reviewAgent, agent: reviewAgent } as any);
    const reviewToolNames = (asmReview.tools as any[]).map((t) => t.name);
    expect(reviewToolNames).not.toContain('send_message');

    // Review 会话调用 send_message 被 tools.guard 拒绝
    const reviewExec = await tools.execute({
      name: 'send_message',
      arguments: { text: 'test' },
      agent: reviewAgent,
      signal: new AbortController().signal,
    });
    expect(reviewExec.isError).toBe(true);
    expect((reviewExec as any).error?.message).toContain('dsh-napcat-bridge: send_message 工具仅限 QQ 聊天会话调用');
  });
});
