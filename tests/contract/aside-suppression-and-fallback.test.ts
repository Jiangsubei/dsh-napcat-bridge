/**
 * 契约测试: 阶段 4 出站旁白抑制与 turn/end 自动补发兜底机制
 *
 * 覆盖规范清单:
 * 契约 1: 旁白结构性抑制：当 assistant/message 中同时包含 TextBlock 和 tool-call 块时，纯文本永不自动发送给 NapCat 网关；
 * 契约 2: 纯终答发出：当 assistant/message 中仅包含 TextBlock 且无 tool-call 时，作为终答正常下发（群聊带引用/@ 前缀，私聊纯文本）；
 * 契约 3: turn/end 兜底分支 A (0 次 send_message)：当本轮未调用 send_message 时，纯文本终答正常发送到 QQ；
 * 契约 4: turn/end 兜底分支 B (≥1 次 send_message)：当本轮中途调用了 send_message（收到 tool/call name: 'send_message'），末尾输出的纯文本终答被抑制，不重复发送到 QQ；
 * 契约 5: 多步交互场景：Step 1 带 tool-call (如 read_chat_history) 的思考旁白被抑制，Step 2 纯文本终答正常发出；
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

describe('契约 1 ~ 5: OutboundStreamBridge 旁白抑制与 turn/end 兜底机制单元契约', () => {
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

  it('契约 1: 旁白结构性抑制：当 assistant/message 中同时包含 TextBlock 和 tool-call 块时，纯文本永不自动发送给 NapCat', async () => {
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

    // 模型输出伴随工具调用，包含过程性思考文本
    const blocksWithToolCall: ContentBlock[] = [
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

    // 关键断言：文本被结构性抑制，绝不向 QQ 下发
    expect(sent).toHaveLength(0);
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

  it('契约 3: turn/end 兜底分支 A (0 次 send_message)：当本轮未调用 send_message 时，纯文本终答正常补发到 QQ', async () => {
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

    // 未发生 send_message 调用（sendCount === 0）
    // 输出纯文本终答
    await bridge.handleSessionEvent(session as any, {
      type: 'assistant/message',
      data: {
        turn: 1,
        step: 1,
        message: { content: [{ type: 'text', text: '这是兜底发出的终答。' }] },
      },
    } as any);

    expect(sent).toHaveLength(1);
    const segs = sent[0].msg as Array<Record<string, any>>;
    expect(segs.find((s) => s.type === 'text')?.data?.text).toBe('这是兜底发出的终答。');

    // turn/end 结束并清理
    await bridge.handleSessionEvent(session as any, {
      type: 'turn/end',
      data: { turn: 1 },
    } as any);
    expect(bridge.getTurnSendMessageCount('group_10001', 1)).toBe(0);
  });

  it('契约 4: turn/end 兜底分支 B (≥1 次 send_message)：当本轮中途调用了 send_message，末尾纯文本终答被抑制，不重复发送到 QQ', async () => {
    const sent: Array<{ peer: string; msg: any }> = [];
    const { bridge } = makeMockBridge(sent);
    const session = { id: 'qq-group-10001' };

    bridge.trackPendingMessage('msg_fallback_b', 'group_10001', {
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
      data: { id: 'msg_fallback_b', content: [{ type: 'text', text: '帮我发消息' }] },
    } as any);

    // Step 1: 模型调用了 send_message
    // 1) assistant/message 带 tool-call
    await bridge.handleSessionEvent(session as any, {
      type: 'assistant/message',
      data: {
        turn: 1,
        step: 1,
        message: {
          content: [
            { type: 'text', text: '准备调用 send_message 工具主动发言...' },
            { type: 'tool-call', id: 'call_send', name: 'send_message', arguments: '{"text":"主动内容"}' },
          ],
        },
      },
    } as any);
    expect(sent).toHaveLength(0); // 旁白抑制

    // 2) session 派发 tool/call 事件
    await bridge.handleSessionEvent(session as any, {
      type: 'tool/call',
      data: {
        turn: 1,
        step: 1,
        callId: 'call_send',
        name: 'send_message',
        arguments: '{"text":"主动内容"}',
      },
    } as any);
    expect(bridge.getTurnSendMessageCount('group_10001', 1)).toBe(1);

    // Step 2: 模型在末尾输出了纯文本（仅留存 Web UI，不向 QQ 发送）
    await bridge.handleSessionEvent(session as any, {
      type: 'assistant/message',
      data: {
        turn: 1,
        step: 2,
        message: {
          content: [{ type: 'text', text: '我已经通过主动发言工具发送完毕！' }],
        },
      },
    } as any);

    // 核心断言：因为 sendCount >= 1，末尾的纯文本终答被抑制，sent 依然为 0！
    expect(sent).toHaveLength(0);

    // 轮次正常关闭
    await bridge.handleSessionEvent(session as any, {
      type: 'turn/end',
      data: { turn: 1 },
    } as any);
    expect(bridge.getTurnSendMessageCount('group_10001', 1)).toBe(0);
  });

  it('契约 5: 多步交互场景：Step 1 带 tool-call (如 read_chat_history) 的思考旁白被抑制，Step 2 纯文本终答正常发出', async () => {
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

    // Step 1: 调用 read_chat_history
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
    await bridge.handleSessionEvent(session as any, {
      type: 'tool/call',
      data: {
        turn: 1,
        step: 1,
        callId: 'call_read',
        name: 'read_chat_history',
        arguments: '{"limit":10}',
      },
    } as any);

    // 断言 Step 1 思考旁白被抑制，read_chat_history 不是 send_message 不增加计数
    expect(sent).toHaveLength(0);
    expect(bridge.getTurnSendMessageCount('group_10001', 1)).toBe(0);

    // Step 2: 模型综合查询结果后输出纯文本终答
    await bridge.handleSessionEvent(session as any, {
      type: 'assistant/message',
      data: {
        turn: 1,
        step: 2,
        message: {
          content: [{ type: 'text', text: '根据历史记录，大家讨论了明天的团建安排。' }],
        },
      },
    } as any);

    // 断言 Step 2 纯文本终答正常发出，且首段携带引用
    expect(sent).toHaveLength(1);
    const segs = sent[0].msg as Array<Record<string, any>>;
    expect(segs.find((s) => s.type === 'reply')?.data?.id).toBe(50001);
    expect(segs.find((s) => s.type === 'text')?.data?.text).toBe('根据历史记录，大家讨论了明天的团建安排。');
  });

  it('补充契约: dispose 清空所有 turnSendMessageCounts 映射', async () => {
    const sent: Array<{ peer: string; msg: any }> = [];
    const { bridge } = makeMockBridge(sent);
    const session = { id: 'qq-group-10001' };

    await bridge.handleSessionEvent(session as any, {
      type: 'turn/start',
      data: { turn: 1 },
    } as any);
    await bridge.handleSessionEvent(session as any, {
      type: 'tool/call',
      data: { turn: 1, step: 1, callId: 'c1', name: 'send_message', arguments: '{}' },
    } as any);
    expect(bridge.getTurnSendMessageCount('group_10001', 1)).toBe(1);

    bridge.dispose();
    expect(bridge.getTurnSendMessageCount('group_10001', 1)).toBe(0);
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

  it('真实装配下：带 tool-call 旁白被抑制；0 次 send_message 补发终答；≥1 次 send_message 抑制终答', async () => {
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

    // 3. Step 1: 模型输出带 tool-call 的旁白思考
    (booted.ctx as any).emit('session/event', session, {
      seq: seq++,
      type: 'assistant/message',
      data: {
        turn: 1,
        step: 1,
        message: {
          content: [
            { type: 'text', text: '正在调工具检查系统状态...' },
            { type: 'tool-call', id: 'call_chk', name: 'read_chat_history', arguments: '{}' },
          ],
        },
      },
    });
    (booted.ctx as any).emit('session/event', session, {
      seq: seq++,
      type: 'tool/call',
      data: { turn: 1, step: 1, callId: 'call_chk', name: 'read_chat_history', arguments: '{}' },
    });

    await new Promise((r) => setTimeout(r, 150));
    // 真实网关未收到任何出站消息帧（旁白被结构抑制）
    expect(sentActionFrames).toHaveLength(0);

    // 4. Step 2: 模型输出纯文本终答 (本轮 send_message 计数为 0 -> 兜底发出)
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
    // 真实网关收到 1 条群消息
    expect(sentActionFrames).toHaveLength(1);
    const frame1 = sentActionFrames[0];
    expect(frame1.action).toBe('send_group_msg');
    expect(frame1.params.group_id).toBe(GROUP_ID);
    const replySeg = frame1.params.message.find((s: any) => s.type === 'reply');
    expect(replySeg?.data?.id).toBe(realMsgId);
    const textSeg = frame1.params.message.find((s: any) => s.type === 'text');
    expect(textSeg?.data?.text).toBe('系统一切正常。');

    // 5. 轮次 2：测试 send_message 调用后终答被抑制
    sentActionFrames.length = 0; // 清空
    const realMsgId2 = 77002;
    client.send(
      JSON.stringify({
        post_type: 'message',
        message_type: 'group',
        sub_type: 'normal',
        message_id: realMsgId2,
        group_id: GROUP_ID,
        user_id: USER_QQ,
        time: 1700000005,
        self_id: BOT_QQ,
        sender: { user_id: USER_QQ, nickname: 'Tester', card: 'Tester' },
        message: [
          { type: 'at', data: { qq: BOT_QQ } },
          { type: 'text', data: { text: ' 主动发言测试' } },
        ],
        raw_message: `[CQ:at,qq=${BOT_QQ}] 主动发言测试`,
      })
    );

    await new Promise((r) => setTimeout(r, 150));
    expect(capturedUserMsgs).toHaveLength(2);

    (booted.ctx as any).emit('session/event', session, {
      seq: seq++,
      type: 'turn/start',
      data: { turn: 2 },
    });
    (booted.ctx as any).emit('session/event', session, {
      seq: seq++,
      type: 'user/message',
      data: capturedUserMsgs[1],
    });

    // 模型在轮次 2 中调用了 send_message
    (booted.ctx as any).emit('session/event', session, {
      seq: seq++,
      type: 'tool/call',
      data: { turn: 2, step: 1, callId: 'call_send_2', name: 'send_message', arguments: '{"text":"主动发出的测试"}' },
    });

    // 随后模型输出末尾纯文本回复
    (booted.ctx as any).emit('session/event', session, {
      seq: seq++,
      type: 'assistant/message',
      data: {
        turn: 2,
        step: 2,
        message: {
          content: [{ type: 'text', text: '我已调用主动发言工具完成任务。' }],
        },
      },
    });
    (booted.ctx as any).emit('session/event', session, {
      seq: seq++,
      type: 'turn/end',
      data: { turn: 2, reason: { kind: 'completed' } },
    });

    await new Promise((r) => setTimeout(r, 150));
    // 关键断言：因为本轮已调用 send_message，末尾纯文本被抑制，真实网关未收到多余的出站文本消息
    expect(sentActionFrames).toHaveLength(0);
  });
});
