/**
 * 契约测试: AB 测试分支 - 直发模式与 send_qq_message 下线契约
 *
 * 验证规则:
 * 1. 契约 1: bootDshNapcatBridge 真实装配下，QQ 群聊与私聊工具列表中均不包含 send_qq_message 工具；
 * 2. 契约 2: QQ 会话下的 assemble system prompt 不注入任何 “如何发送消息” 动态段或 send_qq_message 描述；
 * 3. 契约 3: 中间轮次正文直发：当 assistant/message 同时包含 reasoning、text、tool-call 时，
 *            reasoning 与 tool-call 被过滤，text 块直接发往 QQ，且群聊首段带引用；
 * 4. 契约 4: 最终回复正文直发：当 assistant/message 仅包含 reasoning 与 text（无 tool-call）时，
 *            text 块作为最终答复直接发往 QQ，同轮次不重复引用；
 * 5. 契约 5: 纯思考与纯工具步骤（无 text 块）不向 QQ 发送任何空消息。
 */

import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fsp } from 'node:fs';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import { bootDshNapcatBridge, type BootedDsh } from '../../src/boot.js';
import { OutboundStreamBridge } from '../../src/outbound/stream.js';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';

describe('契约测试: AB 测试分支直发与工具/提示词下线验证', () => {
  let tmpHome: string;
  let booted: BootedDsh;
  const TEST_PORT = 29777;

  beforeEach(async () => {
    tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-ab-test-'));
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

  it('契约 1: 真实装配下，QQ 会话工具列表中严禁包含 send_qq_message 工具', async () => {
    // 1.1 群聊会话 assemble
    const groupAssembly = await booted.ctx.systemPrompt.assemble({
      session: { id: 'qq-group-10001-1' },
    } as any);
    const groupToolNames = (groupAssembly.tools || []).map((t: any) => t.name);
    expect(groupToolNames).not.toContain('send_qq_message');

    // 1.2 私聊会话 assemble
    const userAssembly = await booted.ctx.systemPrompt.assemble({
      session: { id: 'qq-user-20002-1' },
    } as any);
    const userToolNames = (userAssembly.tools || []).map((t: any) => t.name);
    expect(userToolNames).not.toContain('send_qq_message');
  });

  it('契约 2: QQ 会话下 assemble 系统提示词清理干净，不包含“如何发送消息”与 send_qq_message 描述', async () => {
    const assemblyGroup = await booted.ctx.systemPrompt.assemble({
      session: { id: 'qq-group-10001-1' },
    } as any);

    const fullPromptText = assemblyGroup.contexts.map((c: any) => c.text || '').join('\n');
    expect(fullPromptText).not.toContain('# 如何发送消息');
    expect(fullPromptText).not.toContain('必须调用 send_qq_message 工具');
    expect(fullPromptText).not.toContain('send_qq_message');
    expect(fullPromptText).not.toContain('除工具调用外不要输出任何回复文本');

    // 私聊会话也同样清理干净
    const assemblyUser = await booted.ctx.systemPrompt.assemble({
      session: { id: 'qq-user-20002-1' },
    } as any);
    const userPromptText = assemblyUser.contexts.map((c: any) => c.text || '').join('\n');
    expect(userPromptText).not.toContain('# 如何发送消息');
    expect(userPromptText).not.toContain('send_qq_message');
  });

  it('契约 3 & 4: 中间轮次伴随工具调用的正文与最终回复均直发 QQ，且思考块坚决过滤', async () => {
    const sent: Array<{ peer: string; msg: any }> = [];
    const gateway = {
      sendMsg: async (peer: string, msg: any) => {
        sent.push({ peer, msg });
        return { status: 'ok', retcode: 0, data: { message_id: 100 } };
      },
    };
    const sessionManager = {
      isQQSession: (id: string) => id.startsWith('qq-') || id.startsWith('group_') || id.startsWith('user_'),
      sessionIdToPeer: (id: string) => {
        if (id.startsWith('qq-group-')) return `group_${id.slice('qq-group-'.length)}`;
        if (id.startsWith('qq-user-')) return `user_${id.slice('qq-user-'.length)}`;
        return id;
      },
    };

    const ctx = new Context();
    const bridge = new OutboundStreamBridge(ctx, {
      gateway: gateway as any,
      sessionManager: sessionManager as any,
      getConfig: () => ({ quote_original: true, at_questioner: true }),
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    });

    const session = { id: 'qq-group-10001' };

    // 1. 模拟入站消息挂起
    bridge.trackPendingMessage('inbound_msg_1', 'group_10001', {
      msg_id: 8888,
      from_user: '2415112980',
      is_group: true,
    });

    // 2. 开启轮次
    await bridge.handleSessionEvent(session as any, {
      type: 'turn/start',
      data: { turn: 1 },
    } as any);

    await bridge.handleSessionEvent(session as any, {
      type: 'user/message',
      data: { id: 'inbound_msg_1', content: [{ type: 'text', text: '测速并识图' }] },
    } as any);

    // 3. Step 1: 模型输出思考 (reasoning) + 中间正文 (text) + 工具调用 (bash)
    // 对应日志中的典型场景（如 Turn 12 Step 1）
    const step1Blocks: ContentBlock[] = [
      {
        type: 'reasoning',
        text: 'The user wants two additional decisive tests: speed test and sticker test. Let me run bash...',
      },
      {
        type: 'text',
        text: '行，再加两个硬指标：测速 + 真表情包识图。先把你发过的那个[打电话]表情包转成 png，然后一个脚本跑两项测试。',
      },
      {
        type: 'tool-call',
        id: 'tool_call_1' as any,
        name: 'bash',
        arguments: '{"command":"ls -la"}',
      },
    ];

    await bridge.handleSessionEvent(session as any, {
      type: 'assistant/message',
      data: {
        turn: 1,
        step: 1,
        message: { content: step1Blocks },
      },
    } as any);

    // 断言: 中间正文已直接发送到 QQ！且带首段引用和 @
    expect(sent).toHaveLength(1);
    const sentMsg1 = sent[0].msg as Array<Record<string, any>>;
    expect(Array.isArray(sentMsg1)).toBe(true);
    expect(sentMsg1[0]).toEqual({ type: 'reply', data: { id: 8888 } });
    expect(sentMsg1[1]).toEqual({ type: 'at', data: { qq: '2415112980' } });
    expect(sentMsg1[2].data.text).toContain('行，再加两个硬指标：测速 + 真表情包识图');
    // 思考过程绝不泄漏
    expect(JSON.stringify(sent[0])).not.toContain('The user wants two additional decisive tests');

    // 4. Step 2: 模型仅输出思考 + 工具调用（纯无正文步骤，如日志中的 Step 2）
    const step2Blocks: ContentBlock[] = [
      {
        type: 'reasoning',
        text: 'First run failed, let me retry with increased max_tokens...',
      },
      {
        type: 'tool-call',
        id: 'tool_call_2' as any,
        name: 'bash',
        arguments: '{"command":"curl"}',
      },
    ];

    await bridge.handleSessionEvent(session as any, {
      type: 'assistant/message',
      data: {
        turn: 1,
        step: 2,
        message: { content: step2Blocks },
      },
    } as any);

    // 断言: 纯工具步骤无正文，不产生任何 QQ 下发
    expect(sent).toHaveLength(1);

    // 5. Step 3: 最终回复（无工具调用，输出最终结论）
    const step3Blocks: ContentBlock[] = [
      {
        type: 'reasoning',
        text: 'We now have all results. Let us summarize for the user.',
      },
      {
        type: 'text',
        text: '测速战报：稳定在 ~170 tok/s。识图战报：表情包首帧被读得贼细，原生多模态实锤。',
      },
    ];

    await bridge.handleSessionEvent(session as any, {
      type: 'assistant/message',
      data: {
        turn: 1,
        step: 3,
        message: { content: step3Blocks },
      },
    } as any);

    // 断言: 最终回复也直接发到 QQ！同轮次不重复携带前缀
    expect(sent).toHaveLength(2);
    expect(sent[1].msg).toBe('测速战报：稳定在 ~170 tok/s。识图战报：表情包首帧被读得贼细，原生多模态实锤。');
    // 思考过程绝不泄漏
    expect(JSON.stringify(sent[1])).not.toContain('We now have all results');

    // 6. 结束轮次
    await bridge.handleSessionEvent(session as any, {
      type: 'turn/end',
      data: { turn: 1, reason: { kind: 'completed' } },
    } as any);
  });
});
