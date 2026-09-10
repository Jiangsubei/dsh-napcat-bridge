/**
 * 契约测试: 出站直发模式（Direct Stream）与多步消息流转机制
 *
 * 覆盖规范清单:
 * 契约 1: 伴随工具调用的中间正文直接直发 NapCat，且思考块 (reasoning) 严密过滤不泄漏；
 * 契约 2: 纯终答发出：当 assistant/message 仅包含 TextBlock 且无 tool-call 时，作为终答正常下发（群聊带引用/@ 前缀，私聊纯文本）；
 * 契约 3: 纯文本终答直发出站，turn 结束正常清理映射；
 * 契约 4: 多步交互场景中，伴随工具调用的中间正文首发带前缀，末尾终答直接下发且不重复携带前缀；
 * 契约 5: 多步交互场景：Step 1 伴随 tool-call 正文直发，Step 2 纯工具调用无正文不下发，Step 3 纯文本终答直发；
 * 契约 6: 真实生产装配闭环验证（基于 bootDshNapcatBridge + 真实 WS 网关）。
 */

import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fsp } from 'node:fs';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import { Context } from '@deepseek-ai/cordis';
import { MessageDatabase } from '../../src/storage/database.js';
import { bootDshNapcatBridge, type BootedDsh } from '../../src/boot.js';
import * as NapCatBridgePlugin from '../../src/index.js';
import { OutboundStreamBridge } from '../../src/outbound/stream.js';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';

describe('契约 1 ~ 5: OutboundStreamBridge 直发模式与多步消息出站单元契约', () => {
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
      getConfig: () => ({ quote_original: true, at_questioner: false, ...config }),
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    });
    return { bridge, ctx };
  }

  it('契约 1: 直发模式：当 assistant/message 中同时包含 TextBlock 和 tool-call 块时，中间正文直接发送给 NapCat，且思考块严禁泄漏', async () => {
    const sent: Array<{ peer: string; msg: any }> = [];
    const { bridge } = makeMockBridge(sent);
    const session = { id: 'qq-group-10001' };

    bridge.trackPendingMessage('msg_user_1', 'group_10001', {
      msg_id: 10001,
      from_user: '2000000001',
      is_group: true,
    });

    await bridge.handleSessionEvent(session as any, {
      type: 'turn/start',
      data: { turn: 1 },
    } as any);
    await bridge.handleSessionEvent(session as any, {
      type: 'user/message',
      data: { id: 'msg_user_1', content: [{ type: 'text', text: '请帮我查天气' }] },
    } as any);

    // 模型输出伴随工具调用，包含过程性思考文本与正文
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

    // 关键断言：直发模式下，中间正文直接向 QQ 下发，首段携带引用，思考过程严禁外泄
    expect(sent).toHaveLength(1);
    expect(sent[0].peer).toBe('group_10001');
    const segs = sent[0].msg as Array<Record<string, any>>;
    expect(Array.isArray(segs)).toBe(true);
    expect(segs.find((s) => s.type === 'reply')?.data?.id).toBe(10001);
    expect(segs.find((s) => s.type === 'text')?.data?.text).toBe('好的，正在为您查询北京市的天气情况，请稍候...');
    expect(JSON.stringify(sent[0])).not.toContain('Thinking about weather');
  });

  it('契约 2: 纯终答发出：当 assistant/message 仅包含 TextBlock 且无 tool-call 时，作为终答正常下发（群聊带引用/@ 前缀，私聊纯文本）', async () => {
    // 2.1 群聊场景
    const groupSent: Array<{ peer: string; msg: any }> = [];
    const { bridge: groupBridge } = makeMockBridge(groupSent, { quote_original: true, at_questioner: true });
    const groupSession = { id: 'qq-group-10001' };

    groupBridge.trackPendingMessage('msg_group_1', 'group_10001', {
      msg_id: 20001,
      from_user: '2000000001',
      is_group: true,
    });
    await groupBridge.handleSessionEvent(groupSession as any, {
      type: 'turn/start',
      data: { turn: 1 },
    } as any);
    await groupBridge.handleSessionEvent(groupSession as any, {
      type: 'user/message',
      data: { id: 'msg_group_1', content: [{ type: 'text', text: '群聊提问' }] },
    } as any);

    await groupBridge.handleSessionEvent(groupSession as any, {
      type: 'assistant/message',
      data: {
        turn: 1,
        step: 1,
        message: { content: [{ type: 'text', text: '群聊纯文本终答。' }] },
      },
    } as any);

    expect(groupSent).toHaveLength(1);
    expect(groupSent[0].peer).toBe('group_10001');
    const segs = groupSent[0].msg as Array<Record<string, any>>;
    expect(Array.isArray(segs)).toBe(true);
    expect(segs.find((s) => s.type === 'reply')?.data?.id).toBe(20001);
    expect(segs.find((s) => s.type === 'at')?.data?.qq).toBe('2000000001');
    expect(segs.find((s) => s.type === 'text')?.data?.text).toBe('群聊纯文本终答。');

    // 2.2 私聊场景
    const userSent: Array<{ peer: string; msg: any }> = [];
    const { bridge: userBridge } = makeMockBridge(userSent, { quote_original: true, at_questioner: true });
    const userSession = { id: 'qq-user-3000000001' };

    userBridge.trackPendingMessage('msg_user_priv', 'user_3000000001', {
      msg_id: 20002,
      from_user: '3000000001',
      is_group: false,
    });
    await userBridge.handleSessionEvent(userSession as any, {
      type: 'turn/start',
      data: { turn: 1 },
    } as any);
    await userBridge.handleSessionEvent(userSession as any, {
      type: 'user/message',
      data: { id: 'msg_user_priv', content: [{ type: 'text', text: '私聊提问' }] },
    } as any);

    await userBridge.handleSessionEvent(userSession as any, {
      type: 'assistant/message',
      data: {
        turn: 1,
        step: 1,
        message: { content: [{ type: 'text', text: '私聊纯文本终答。' }] },
      },
    } as any);

    expect(userSent).toHaveLength(1);
    expect(userSent[0].peer).toBe('user_3000000001');
    // 私聊不 @ 不引用，为纯文本
    expect(userSent[0].msg).toBe('私聊纯文本终答。');
  });

  it('契约 3: 纯文本终答直发出站，turn 结束正常清理映射', async () => {
    const sent: Array<{ peer: string; msg: any }> = [];
    const { bridge } = makeMockBridge(sent);
    const session = { id: 'qq-group-10001' };

    bridge.trackPendingMessage('msg_fallback_a', 'group_10001', {
      msg_id: 30001,
      from_user: '2000000001',
      is_group: true,
    });

    await bridge.handleSessionEvent(session as any, {
      type: 'turn/start',
      data: { turn: 1 },
    } as any);
    await bridge.handleSessionEvent(session as any, {
      type: 'user/message',
      data: { id: 'msg_fallback_a', content: [{ type: 'text', text: '你好' }] },
    } as any);

    // 输出纯文本终答
    await bridge.handleSessionEvent(session as any, {
      type: 'assistant/message',
      data: {
        turn: 1,
        step: 1,
        message: { content: [{ type: 'text', text: '这是发出的终答。' }] },
      },
    } as any);

    expect(sent).toHaveLength(1);
    const segs = sent[0].msg as Array<Record<string, any>>;
    expect(segs.find((s) => s.type === 'text')?.data?.text).toBe('这是发出的终答。');

    // turn/end 结束并清理
    await bridge.handleSessionEvent(session as any, {
      type: 'turn/end',
      data: { turn: 1 },
    } as any);
  });

  it('契约 4: 多步交互场景中，伴随工具调用的中间正文与末尾终答均直发 QQ，且同轮次后续不重复带前缀', async () => {
    const sent: Array<{ peer: string; msg: any }> = [];
    const { bridge } = makeMockBridge(sent);
    const session = { id: 'qq-group-10001' };

    bridge.trackPendingMessage('msg_step_flow', 'group_10001', {
      msg_id: 40001,
      from_user: '2000000001',
      is_group: true,
    });

    await bridge.handleSessionEvent(session as any, {
      type: 'turn/start',
      data: { turn: 1 },
    } as any);
    await bridge.handleSessionEvent(session as any, {
      type: 'user/message',
      data: { id: 'msg_step_flow', content: [{ type: 'text', text: '帮我发消息' }] },
    } as any);

    // Step 1: 模型输出中间正文并调用工具
    await bridge.handleSessionEvent(session as any, {
      type: 'assistant/message',
      data: {
        turn: 1,
        step: 1,
        message: {
          content: [
            { type: 'text', text: '正在处理中，请稍候...' },
            { type: 'tool-call', id: 'call_bash', name: 'bash', arguments: '{"command":"ls"}' },
          ],
        },
      },
    } as any);

    // Step 1 正文直发出站，首段带引用
    expect(sent).toHaveLength(1);
    const segs1 = sent[0].msg as Array<Record<string, any>>;
    expect(segs1.find((s) => s.type === 'reply')?.data?.id).toBe(40001);
    expect(segs1.find((s) => s.type === 'text')?.data?.text).toBe('正在处理中，请稍候...');

    // Step 2: 模型输出末尾纯文本终答
    await bridge.handleSessionEvent(session as any, {
      type: 'assistant/message',
      data: {
        turn: 1,
        step: 2,
        message: {
          content: [{ type: 'text', text: '任务已全部处理完成！' }],
        },
      },
    } as any);

    // 终答直接下发，同轮次后续不重复带前缀
    expect(sent).toHaveLength(2);
    expect(sent[1].msg).toBe('任务已全部处理完成！');

    // 轮次正常关闭
    await bridge.handleSessionEvent(session as any, {
      type: 'turn/end',
      data: { turn: 1 },
    } as any);
  });

  it('契约 5: 多步交互场景：Step 1 带正文和 tool-call 时正文直发，Step 2 纯工具调用无正文不下发，Step 3 纯文本终答直发', async () => {
    const sent: Array<{ peer: string; msg: any }> = [];
    const { bridge } = makeMockBridge(sent);
    const session = { id: 'qq-group-10001' };

    bridge.trackPendingMessage('msg_multi_step', 'group_10001', {
      msg_id: 50001,
      from_user: '2000000001',
      is_group: true,
    });

    await bridge.handleSessionEvent(session as any, {
      type: 'turn/start',
      data: { turn: 1 },
    } as any);
    await bridge.handleSessionEvent(session as any, {
      type: 'user/message',
      data: { id: 'msg_multi_step', content: [{ type: 'text', text: '查一下之前的讨论' }] },
    } as any);

    // Step 1: 调用 read_chat_history 并伴随正文说明
    await bridge.handleSessionEvent(session as any, {
      type: 'assistant/message',
      data: {
        turn: 1,
        step: 1,
        message: {
          content: [
            { type: 'text', text: '我来看看大家刚才在聊什么...' },
            { type: 'tool-call', id: 'call_read', name: 'read_chat_history', arguments: '{"limit":10}' },
          ],
        },
      },
    } as any);

    // Step 1 正文直发出站
    expect(sent).toHaveLength(1);
    const segs1 = sent[0].msg as Array<Record<string, any>>;
    expect(segs1.find((s) => s.type === 'reply')?.data?.id).toBe(50001);
    expect(segs1.find((s) => s.type === 'text')?.data?.text).toBe('我来看看大家刚才在聊什么...');

    // Step 2: 纯工具调用无正文（只有 reasoning + tool-call）
    await bridge.handleSessionEvent(session as any, {
      type: 'assistant/message',
      data: {
        turn: 1,
        step: 2,
        message: {
          content: [
            { type: 'reasoning', text: 'Analyzing records...' },
            { type: 'tool-call', id: 'call_tool2', name: 'other_tool', arguments: '{}' },
          ],
        },
      },
    } as any);

    // 纯工具步骤无正文，不下发任何 QQ 消息
    expect(sent).toHaveLength(1);

    // Step 3: 模型综合查询结果后输出纯文本终答
    await bridge.handleSessionEvent(session as any, {
      type: 'assistant/message',
      data: {
        turn: 1,
        step: 3,
        message: {
          content: [{ type: 'text', text: '根据历史记录，大家讨论了明天的团建安排。' }],
        },
      },
    } as any);

    // 断言 Step 3 纯文本终答正常发出，同轮次不重复带前缀
    expect(sent).toHaveLength(2);
    expect(sent[1].msg).toBe('根据历史记录，大家讨论了明天的团建安排。');
  });

  it('补充契约: dispose 安全清理映射', async () => {
    const sent: Array<{ peer: string; msg: any }> = [];
    const { bridge } = makeMockBridge(sent);
    bridge.dispose();
    expect(sent).toHaveLength(0);
  });
});

describe('契约 6: 真实生产装配闭环验证 (Real Assembly via bootDshNapcatBridge)', () => {
  const BOT_QQ = '1000000001';
  const GROUP_ID = 987654321;
  const USER_QQ = '2000000001';
  const WS_PORT = 29891;

  let tmpHome: string;
  let booted: BootedDsh;
  let client: WebSocket;
  let db: MessageDatabase;

  beforeEach(async () => {
    tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-aside-fallback-'));
    db = new MessageDatabase(path.join(tmpHome, 'messages.db'));
  });

  afterEach(async () => {
    if (client) {
      client.terminate();
    }
    try {
      db.close();
    } catch {}
    if (booted) {
      await booted.dispose().catch(() => {});
    }
    try {
      await fsp.rm(tmpHome, { recursive: true, force: true });
    } catch {}
  });

  it('真实装配下：中间正文与最终终答均顺畅直发出站，且 reasoning 块坚决过滤', async () => {
    booted = await bootDshNapcatBridge({ dshHome: tmpHome, mountPlugin: false });
    await booted.ctx.plugin(NapCatBridgePlugin, {
      bot_qq: BOT_QQ,
      ws_port: WS_PORT,
      quote_original: true,
      at_questioner: false,
    });

    const agents: any = booted.ctx.get('agents');
    const handle = await agents.create({
      sessionId: `qq-group-${GROUP_ID}`,
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      meta: { cwd: path.join(tmpHome, 'agent-cwd') },
    });
    const agent = handle.agent || handle;
    const capturedUserMsgs: any[] = [];
    agent.followup = (msg: any) => {
      capturedUserMsgs.push(msg);
    };

    client = new WebSocket(`ws://127.0.0.1:${WS_PORT}`);
    await new Promise<void>((resolve, reject) => {
      client.once('open', () => resolve());
      client.once('error', reject);
    });

    const sentActionFrames: Array<Record<string, any>> = [];
    client.on('message', (data) => {
      const frame = JSON.parse(data.toString());
      if (frame.action === 'send_group_msg' || frame.action === 'send_msg') {
        sentActionFrames.push(frame);
      }
      if (frame.echo) {
        client.send(
          JSON.stringify({
            echo: frame.echo,
            status: 'ok',
            retcode: 0,
            data: { message_id: 88888 },
          })
        );
      }
    });

    const session = agent.session;
    let seq = 0;
    const realMsgId = 77001;

    // 1. 发送真实群消息唤醒
    client.send(
      JSON.stringify({
        post_type: 'message',
        message_type: 'group',
        sub_type: 'normal',
        message_id: realMsgId,
        group_id: GROUP_ID,
        user_id: USER_QQ,
        time: 1700000000,
        self_id: BOT_QQ,
        sender: { user_id: USER_QQ, nickname: 'Tester', card: 'Tester' },
        message: [
          { type: 'at', data: { qq: BOT_QQ } },
          { type: 'text', data: { text: ' 查一下状态' } },
        ],
        raw_message: `[CQ:at,qq=${BOT_QQ}] 查一下状态`,
      })
    );

    await new Promise((r) => setTimeout(r, 150));
    expect(capturedUserMsgs).toHaveLength(1);

    // 2. 轮次 1 开启
    (booted.ctx as any).emit('session/event', session, {
      seq: seq++,
      type: 'turn/start',
      data: { turn: 1 },
    });
    (booted.ctx as any).emit('session/event', session, {
      seq: seq++,
      type: 'user/message',
      data: capturedUserMsgs[0],
    });

    // 3. Step 1: 模型输出带 tool-call 的中间正文与思考
    (booted.ctx as any).emit('session/event', session, {
      seq: seq++,
      type: 'assistant/message',
      data: {
        turn: 1,
        step: 1,
        message: {
          content: [
            { type: 'reasoning', text: 'Internal checking logic...' },
            { type: 'text', text: '正在调工具检查系统状态...' },
            { type: 'tool-call', id: 'call_chk', name: 'read_chat_history', arguments: '{}' },
          ],
        },
      },
    });

    await new Promise((r) => setTimeout(r, 150));
    // 真实网关收到第 1 条中间正文，且携带引用
    expect(sentActionFrames).toHaveLength(1);
    const frame1 = sentActionFrames[0];
    expect(frame1.action).toBe('send_group_msg');
    expect(frame1.params.group_id).toBe(GROUP_ID);
    const replySeg = frame1.params.message.find((s: any) => s.type === 'reply');
    expect(replySeg?.data?.id).toBe(realMsgId);
    const textSeg = frame1.params.message.find((s: any) => s.type === 'text');
    expect(textSeg?.data?.text).toBe('正在调工具检查系统状态...');
    // 思考过程绝不外泄
    expect(JSON.stringify(frame1)).not.toContain('Internal checking logic');

    // 4. Step 2: 模型输出纯文本终答
    (booted.ctx as any).emit('session/event', session, {
      seq: seq++,
      type: 'assistant/message',
      data: {
        turn: 1,
        step: 2,
        message: {
          content: [{ type: 'text', text: '系统一切正常。' }],
        },
      },
    });
    (booted.ctx as any).emit('session/event', session, {
      seq: seq++,
      type: 'turn/end',
      data: { turn: 1, reason: { kind: 'completed' } },
    });

    await new Promise((r) => setTimeout(r, 150));
    // 真实网关共收到 2 条群消息，终答顺畅发出
    expect(sentActionFrames).toHaveLength(2);
    const frame2 = sentActionFrames[1];
    expect(frame2.action).toBe('send_group_msg');
    expect(frame2.params.group_id).toBe(GROUP_ID);
    expect(frame2.params.message).toBe('系统一切正常。');
  });
});

