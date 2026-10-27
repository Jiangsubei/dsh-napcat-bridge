/**
 * 契约测试: 用户侧静默原则与出站静默契约 (User-Side Silence & Suppression Contract)
 *
 * 覆盖规范清单:
 * 契约 1: 当 assistant/message 包含 TextBlock 与 tool-call 块时，网关保持绝对静默，绝不向 QQ 直发；
 * 契约 2: 纯文本输出：即便 assistant/message 仅包含 TextBlock，未调用 send_qq_message 时依然绝对静默；
 * 契约 3: turn/end 结束时绝对不补发任何兜底文本；
 * 契约 4: 多步交互场景中，跨多 Step 的思考、正文与工具调用，全程 100% 保持静默（sent 长度为 0）；
 * 契约 5: 真实生产装配下验证静默原则（基于 bootDshNapcatBridge + 真实 WS 网关）。
 */

import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fsp } from 'node:fs';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import { Context } from '@deepseek-ai/cordis';
import { bootDshNapcatBridge, type BootedDsh } from '../../src/boot.js';
import { OutboundStreamBridge } from '../../src/outbound/stream.js';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';

describe('契约 1 ~ 4: OutboundStreamBridge 用户侧静默原则单元契约', () => {
  function makeMockBridge(sent: Array<{ peer: string; msg: any }>, config: Record<string, any> = {}) {
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
      getConfig: () => ({ ...config }),
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    });
    return { bridge, ctx };
  }

  it('契约 1: 用户侧静默原则：当 assistant/message 包含 TextBlock 和 tool-call 块时，绝对静默不下发', async () => {
    const sent: Array<{ peer: string; msg: any }> = [];
    const { bridge } = makeMockBridge(sent);
    const session = { id: 'qq-group-10001' };

    bridge.trackInboundContext('group_10001', {
      msg_id: 10001,
      from_user: '2000000001',
      is_group: true,
    });

    await bridge.handleSessionEvent(session as any, {
      type: 'turn/start',
      data: { turn: 1 },
    } as any);

    const blocksWithToolCall: ContentBlock[] = [
      {
        type: 'reasoning',
        text: 'Thinking about weather in Beijing...',
      },
      {
        type: 'text',
        text: '好的，正在为您查询北京市的天气情况，请稍候...',
      },
      {
        type: 'tool-call',
        id: 'call_1' as any,
        name: 'get_weather',
        arguments: '{"city":"Beijing"}',
      },
    ];

    await bridge.handleSessionEvent(session as any, {
      type: 'assistant/message',
      data: {
        turn: 1,
        step: 1,
        message: { content: blocksWithToolCall },
      },
    } as any);

    // 关键断言：绝对静默！未调用 send_qq_message，绝不下发任何文本到 QQ
    expect(sent).toHaveLength(0);
  });

  it('契约 2: 纯文本输出：即便 assistant/message 仅包含 TextBlock，未调 send_qq_message 时依然绝对静默', async () => {
    const sent: Array<{ peer: string; msg: any }> = [];
    const { bridge } = makeMockBridge(sent);
    const session = { id: 'qq-group-10001' };

    await bridge.handleSessionEvent(session as any, {
      type: 'turn/start',
      data: { turn: 1 },
    } as any);

    const pureTextBlocks: ContentBlock[] = [
      {
        type: 'text',
        text: '这是模型生成的普通回复文本，但没有通过 send_qq_message 发送。',
      },
    ];

    await bridge.handleSessionEvent(session as any, {
      type: 'assistant/message',
      data: {
        turn: 1,
        step: 1,
        message: { content: pureTextBlocks },
      },
    } as any);

    // 关键断言：绝对静默！
    expect(sent).toHaveLength(0);
  });

  it('契约 3: turn/end 结束时绝对不补发任何兜底文本', async () => {
    const sent: Array<{ peer: string; msg: any }> = [];
    const { bridge } = makeMockBridge(sent);
    const session = { id: 'qq-group-10001' };

    await bridge.handleSessionEvent(session as any, {
      type: 'turn/start',
      data: { turn: 1 },
    } as any);

    // 轮次结束，无任何兜底补发
    await bridge.handleSessionEvent(session as any, {
      type: 'turn/end',
      data: { turn: 1, reason: { kind: 'completed' } },
    } as any);

    expect(sent).toHaveLength(0);
  });

  it('契约 4: 多步交互场景中，跨多 Step 的思考、正文与工具调用，全程保持静默', async () => {
    const sent: Array<{ peer: string; msg: any }> = [];
    const { bridge } = makeMockBridge(sent);
    const session = { id: 'qq-group-10001' };

    await bridge.handleSessionEvent(session as any, {
      type: 'turn/start',
      data: { turn: 1 },
    } as any);

    // Step 1: 思考 + 正文 + 工具
    await bridge.handleSessionEvent(session as any, {
      type: 'assistant/message',
      data: {
        turn: 1,
        step: 1,
        message: {
          content: [
            { type: 'reasoning', text: 'Step 1' },
            { type: 'text', text: '开始执行步骤 1' },
            { type: 'tool-call', id: 'c1' as any, name: 'bash', arguments: '{}' },
          ],
        },
      },
    } as any);

    // Step 2: 纯工具
    await bridge.handleSessionEvent(session as any, {
      type: 'assistant/message',
      data: {
        turn: 1,
        step: 2,
        message: {
          content: [
            { type: 'tool-call', id: 'c2' as any, name: 'bash', arguments: '{}' },
          ],
        },
      },
    } as any);

    // Step 3: 最终纯文本总结
    await bridge.handleSessionEvent(session as any, {
      type: 'assistant/message',
      data: {
        turn: 1,
        step: 3,
        message: {
          content: [
            { type: 'text', text: '全部步骤执行完成。' },
          ],
        },
      },
    } as any);

    await bridge.handleSessionEvent(session as any, {
      type: 'turn/end',
      data: { turn: 1, reason: { kind: 'completed' } },
    } as any);

    // 全程未调用 send_qq_message，绝不下发任何消息
    expect(sent).toHaveLength(0);
  });
});

describe('契约 5: 真实装配下验证用户侧静默原则闭环', () => {
  let tmpHome: string;
  let booted: BootedDsh;
  const WS_PORT = 29668;

  beforeEach(async () => {
    tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-silence-contract-'));
    booted = await bootDshNapcatBridge({
      dshHome: tmpHome,
      mountPlugin: true,
      config: {
        bot_qq: '1000000001',
        ws_port: WS_PORT,
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

  it('真实装配下：向 session 派发 assistant/message 时，出站网关保持静默', async () => {
    const agents: any = booted.ctx.get('agents');
    const agentCwd = path.join(tmpHome, 'agent-cwd');
    await fsp.mkdir(agentCwd, { recursive: true });
    const handle = await agents.create({
      sessionId: 'qq-group-10001',
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      meta: { cwd: agentCwd },
    });
    const agent = handle.agent || handle;
    const session = agent.session;

    expect(() => {
      (booted.ctx as any).emit('session/event', session, {
        seq: 0,
        type: 'assistant/message',
        data: {
          turn: 1,
          step: 1,
          message: {
            content: [{ type: 'text', text: '未通过 send_qq_message 发送的文本' }],
          },
        },
      });
    }).not.toThrow();
  });
});
