import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fsp } from 'node:fs';
import WebSocket from 'ws';
import { bootDshNapcatBridge, type BootedDsh } from '../../src/boot.js';
import * as NapCatBridgePlugin from '../../src/index.js';
import { OutboundStreamBridge } from '../../src/outbound/stream.js';
import { SessionManager } from '../../src/gateway/session.js';
import { MessageDatabase } from '../../src/storage/database.js';

/**
 * 契约测试: 主动触发回复引用陈旧消息修复 (Stale Inbound Quote Fix Contract)
 *
 * 核心契约：
 * 1. 戳一戳 (poke) 触发的回复为纯文本，绝不包含 CQ:reply 与 CQ:at；
 * 2. 潜水超时 (idle) 触发的主动冒泡回复为纯文本，绝不包含 CQ:reply 与 CQ:at；
 * 3. 连续多次戳一戳 (poke) 回复均不引用不艾特，彻底修复"永远引用上一条真实消息 A"的缺陷；
 * 4. poke/idle 之后下一条真实入站消息恢复引用原消息与@提问者 (不误伤真实消息)；
 * 5. 真实消息按 quote_original / at_questioner 配置正常生效 (不误伤配置)；
 * 6. buildMessagePayload 兜底加固：跨轮次未绑定上下文时回退为纯文本，绝不复用陈旧 inbound；
 * 7. 真实生产装配闭环：bootDshNapcatBridge + WS 网关验证 真实消息 -> poke -> 真实消息 引用闭环。
 */

describe('契约测试: 主动触发回复引用陈旧消息修复 (Stale Inbound Quote Fix Contract)', () => {
  let tmpHome: string;
  let booted: BootedDsh;
  let db: MessageDatabase;

  beforeEach(async () => {
    tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-stale-inbound-'));
    db = new MessageDatabase(path.join(tmpHome, 'messages.db'));
    booted = await bootDshNapcatBridge({ dshHome: tmpHome, mountPlugin: false });
  });

  afterEach(async () => {
    try {
      db.close();
    } catch {}
    if (booted) {
      await booted.dispose().catch(() => {});
    }
    if (tmpHome) {
      await fsp.rm(tmpHome, { recursive: true, force: true }).catch(() => {});
    }
  });

  function makeBridgeFixture(options?: {
    quote_original?: boolean;
    at_questioner?: boolean;
  }) {
    const sent: Array<{ peer: string; msg: any }> = [];
    const gateway = {
      sendMsg: async (peer: string, msg: any) => {
        sent.push({ peer, msg });
        return { status: 'ok', retcode: 0, data: { message_id: 100 } };
      },
    };
    const sessionManager = new SessionManager(booted.ctx, tmpHome, db);
    const bridge = new OutboundStreamBridge(booted.ctx, {
      gateway: gateway as any,
      sessionManager,
      getConfig: () => ({
        quote_original: options?.quote_original ?? true,
        at_questioner: options?.at_questioner ?? true,
      }),
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    });
    bridge.start();
    (sessionManager as any).setOutboundBridge?.(bridge);
    return { bridge, sessionManager, sent };
  }

  it('契约 1: 戳一戳 (poke) 触发的回复为纯文本，绝不包含 CQ:reply 与 CQ:at', async () => {
    const { bridge, sessionManager, sent } = makeBridgeFixture();
    const peer = 'group_123';
    const session = { id: 'qq-group-123' };

    // 1. 模拟先前存在一条真实消息 A
    bridge.trackInboundContext(peer, {
      msg_id: 1001,
      from_user: 'user_A',
      is_group: true,
    });

    // 2. 触发戳一戳唤醒 (无 message_id)
    await sessionManager.dispatchWakeup({
      trigger: 'poke',
      peer,
      from_user: 'user_poker',
      from_name: 'Poker',
      content: '[戳一戳]',
      timestamp: Date.now(),
    });

    // 3. 产生回复
    await bridge.handleSessionEvent(session as any, {
      type: 'turn/start',
      data: { turn: 2 },
    } as any);
    await bridge.handleSessionEvent(session as any, {
      type: 'assistant/message',
      data: {
        turn: 2,
        step: 1,
        message: { content: [{ type: 'text', text: '戳我干嘛？' }] },
      },
    } as any);
    await bridge.handleSessionEvent(session as any, {
      type: 'turn/end',
      data: { turn: 2 },
    } as any);

    expect(sent).toHaveLength(1);
    // 断言：回复必须是纯文本，绝不包含 reply 或 at 段
    expect(sent[0].msg).toBe('戳我干嘛？');
  });

  it('契约 2: 潜水超时 (idle) 触发的主动冒泡回复为纯文本，绝不包含 CQ:reply 与 CQ:at', async () => {
    const { bridge, sessionManager, sent } = makeBridgeFixture();
    const peer = 'group_123';
    const session = { id: 'qq-group-123' };

    // 1. 模拟先前存在一条真实消息 A
    bridge.trackInboundContext(peer, {
      msg_id: 1001,
      from_user: 'user_A',
      is_group: true,
    });

    // 2. 触发潜水超时冒泡 (from_user 为空，无 message_id)
    await sessionManager.dispatchWakeup({
      trigger: 'proactive',
      sub_trigger: 'idle',
      peer,
      from_user: '',
      from_name: '',
      content: '',
      timestamp: Date.now(),
    });

    // 3. 产生回复
    await bridge.handleSessionEvent(session as any, {
      type: 'turn/start',
      data: { turn: 2 },
    } as any);
    await bridge.handleSessionEvent(session as any, {
      type: 'assistant/message',
      data: {
        turn: 2,
        step: 1,
        message: { content: [{ type: 'text', text: '大家怎么都不说话了呀~' }] },
      },
    } as any);
    await bridge.handleSessionEvent(session as any, {
      type: 'turn/end',
      data: { turn: 2 },
    } as any);

    expect(sent).toHaveLength(1);
    // 必须为纯文本，不引用 A，不艾特 A
    expect(sent[0].msg).toBe('大家怎么都不说话了呀~');
  });

  it('契约 3: 连续多次戳一戳 (poke) 回复均不引用不艾特，修复"永远引用消息 A"缺陷', async () => {
    const { bridge, sessionManager, sent } = makeBridgeFixture();
    const peer = 'group_123';
    const session = { id: 'qq-group-123' };

    // 1. 真实消息 A 入站并回复
    bridge.trackInboundContext(peer, {
      msg_id: 1001,
      from_user: 'user_A',
      is_group: true,
    });
    let userMsgA: any;
    await sessionManager.dispatchWakeup(
      {
        trigger: 'at',
        peer,
        from_user: 'user_A',
        from_name: 'Alice',
        content: '你好',
        timestamp: Date.now(),
      },
      {
        onMessageCreated: (msg) => {
          userMsgA = msg;
          bridge.trackPendingMessage(msg.id, peer, {
            msg_id: 1001,
            from_user: 'user_A',
            is_group: true,
          });
        },
      }
    );
    await bridge.handleSessionEvent(session as any, {
      type: 'turn/start',
      data: { turn: 1 },
    } as any);
    await bridge.handleSessionEvent(session as any, {
      type: 'user/message',
      data: { id: userMsgA.id, content: [{ type: 'text', text: '你好' }] },
    } as any);
    await bridge.handleSessionEvent(session as any, {
      type: 'assistant/message',
      data: {
        turn: 1,
        step: 1,
        message: { content: [{ type: 'text', text: '你好呀 Alice' }] },
      },
    } as any);
    await bridge.handleSessionEvent(session as any, {
      type: 'turn/end',
      data: { turn: 1 },
    } as any);

    // 消息 A 的回复有引用与 @
    expect(sent).toHaveLength(1);
    const replyA = sent[0].msg as Array<Record<string, any>>;
    expect(Array.isArray(replyA)).toBe(true);
    expect(replyA[0]).toEqual({ type: 'reply', data: { id: 1001 } });
    expect(replyA[1]).toEqual({ type: 'at', data: { qq: 'user_A' } });

    // 2. 连续第 1 次 poke
    let pokeMsg1: any;
    await sessionManager.dispatchWakeup(
      {
        trigger: 'poke',
        peer,
        from_user: 'user_poker1',
        from_name: 'Poker1',
        content: '[戳一戳]',
        timestamp: Date.now(),
      },
      {
        onMessageCreated: (msg) => {
          pokeMsg1 = msg;
        },
      }
    );
    await bridge.handleSessionEvent(session as any, {
      type: 'turn/start',
      data: { turn: 2 },
    } as any);
    if (pokeMsg1) {
      await bridge.handleSessionEvent(session as any, {
        type: 'user/message',
        data: { id: pokeMsg1.id, content: [{ type: 'text', text: '[戳一戳]' }] },
      } as any);
    }
    await bridge.handleSessionEvent(session as any, {
      type: 'assistant/message',
      data: {
        turn: 2,
        step: 1,
        message: { content: [{ type: 'text', text: '别戳啦 1' }] },
      },
    } as any);
    await bridge.handleSessionEvent(session as any, {
      type: 'turn/end',
      data: { turn: 2 },
    } as any);

    // 3. 连续第 2 次 poke
    let pokeMsg2: any;
    await sessionManager.dispatchWakeup(
      {
        trigger: 'poke',
        peer,
        from_user: 'user_poker2',
        from_name: 'Poker2',
        content: '[戳一戳]',
        timestamp: Date.now(),
      },
      {
        onMessageCreated: (msg) => {
          pokeMsg2 = msg;
        },
      }
    );
    await bridge.handleSessionEvent(session as any, {
      type: 'turn/start',
      data: { turn: 3 },
    } as any);
    if (pokeMsg2) {
      await bridge.handleSessionEvent(session as any, {
        type: 'user/message',
        data: { id: pokeMsg2.id, content: [{ type: 'text', text: '[戳一戳]' }] },
      } as any);
    }
    await bridge.handleSessionEvent(session as any, {
      type: 'assistant/message',
      data: {
        turn: 3,
        step: 1,
        message: { content: [{ type: 'text', text: '别戳啦 2' }] },
      },
    } as any);
    await bridge.handleSessionEvent(session as any, {
      type: 'turn/end',
      data: { turn: 3 },
    } as any);

    expect(sent).toHaveLength(3);
    // 连续两次 poke 均是纯文本，绝不引用消息 A (1001) 也不 @ user_A
    expect(sent[1].msg).toBe('别戳啦 1');
    expect(sent[2].msg).toBe('别戳啦 2');
  });

  it('契约 4: poke/idle 之后下一条真实入站消息恢复引用原消息与@提问者 (不误伤真实消息)', async () => {
    const { bridge, sessionManager, sent } = makeBridgeFixture();
    const peer = 'group_123';
    const session = { id: 'qq-group-123' };

    // 1. 先触发一次 poke 唤醒
    await sessionManager.dispatchWakeup({
      trigger: 'poke',
      peer,
      from_user: 'user_poker',
      from_name: 'Poker',
      content: '[戳一戳]',
      timestamp: Date.now(),
    });
    await bridge.handleSessionEvent(session as any, {
      type: 'turn/start',
      data: { turn: 1 },
    } as any);
    await bridge.handleSessionEvent(session as any, {
      type: 'assistant/message',
      data: {
        turn: 1,
        step: 1,
        message: { content: [{ type: 'text', text: '戳一戳回复' }] },
      },
    } as any);
    await bridge.handleSessionEvent(session as any, {
      type: 'turn/end',
      data: { turn: 1 },
    } as any);

    expect(sent[0].msg).toBe('戳一戳回复');

    // 2. 下一条真实消息 B 到来
    const replyContextB = {
      msg_id: 2002,
      from_user: 'user_B',
      is_group: true,
    };
    bridge.trackInboundContext(peer, replyContextB);

    let userMsgB: any;
    await sessionManager.dispatchWakeup(
      {
        trigger: 'at',
        peer,
        from_user: 'user_B',
        from_name: 'Bob',
        content: '帮我查一下天气',
        timestamp: Date.now(),
      },
      {
        onMessageCreated: (msg) => {
          userMsgB = msg;
          bridge.trackPendingMessage(msg.id, peer, replyContextB);
        },
      }
    );

    await bridge.handleSessionEvent(session as any, {
      type: 'turn/start',
      data: { turn: 2 },
    } as any);
    await bridge.handleSessionEvent(session as any, {
      type: 'user/message',
      data: { id: userMsgB.id, content: [{ type: 'text', text: '帮我查一下天气' }] },
    } as any);
    await bridge.handleSessionEvent(session as any, {
      type: 'assistant/message',
      data: {
        turn: 2,
        step: 1,
        message: { content: [{ type: 'text', text: '今天晴天。' }] },
      },
    } as any);
    await bridge.handleSessionEvent(session as any, {
      type: 'turn/end',
      data: { turn: 2 },
    } as any);

    // 真实消息 B 正常恢复引用与 @
    expect(sent).toHaveLength(2);
    const replyB = sent[1].msg as Array<Record<string, any>>;
    expect(Array.isArray(replyB)).toBe(true);
    expect(replyB[0]).toEqual({ type: 'reply', data: { id: 2002 } });
    expect(replyB[1]).toEqual({ type: 'at', data: { qq: 'user_B' } });
    expect(replyB[2]).toEqual({ type: 'text', data: { text: '今天晴天。' } });
  });

  it('契约 5: 真实消息按 quote_original / at_questioner 配置正常生效 (不误伤配置)', async () => {
    // 仅 quote_original = true, at_questioner = false
    const fix1 = makeBridgeFixture({ quote_original: true, at_questioner: false });
    fix1.bridge.trackInboundContext('group_123', {
      msg_id: 3001,
      from_user: 'user_C',
      is_group: true,
    });
    await fix1.bridge.sendSerialized('group_123', '仅引用测试', { withPrefix: true });
    const segs1 = fix1.sent[0].msg as Array<Record<string, any>>;
    expect(segs1[0]).toEqual({ type: 'reply', data: { id: 3001 } });
    expect(segs1.some((s) => s.type === 'at')).toBe(false);

    // 仅 quote_original = false, at_questioner = true
    const fix2 = makeBridgeFixture({ quote_original: false, at_questioner: true });
    fix2.bridge.trackInboundContext('group_123', {
      msg_id: 3002,
      from_user: 'user_D',
      is_group: true,
    });
    await fix2.bridge.sendSerialized('group_123', '仅艾特测试', { withPrefix: true });
    const segs2 = fix2.sent[0].msg as Array<Record<string, any>>;
    expect(segs2.some((s) => s.type === 'reply')).toBe(false);
    expect(segs2[0]).toEqual({ type: 'at', data: { qq: 'user_D' } });
  });

  it('契约 6: buildMessagePayload 兜底加固 - 跨轮次未绑定上下文时回退为纯文本，绝不复用陈旧 inbound', async () => {
    const { bridge, sent } = makeBridgeFixture();
    const peer = 'group_123';
    const session = { id: 'qq-group-123' };

    // 1. 模拟遗留了一个旧 inboundContext (例如旧消息 A)
    bridge.trackInboundContext(peer, {
      msg_id: 9999,
      from_user: 'stale_user',
      is_group: true,
    });

    // 2. 发生了一个未绑定 inboundContext 的轮次 (例如主动唤醒但未传 inbound)
    await bridge.handleSessionEvent(session as any, {
      type: 'turn/start',
      data: { turn: 10 },
    } as any);
    await bridge.handleSessionEvent(session as any, {
      type: 'assistant/message',
      data: {
        turn: 10,
        step: 1,
        message: { content: [{ type: 'text', text: '无绑定轮次的输出' }] },
      },
    } as any);
    await bridge.handleSessionEvent(session as any, {
      type: 'turn/end',
      data: { turn: 10 },
    } as any);

    expect(sent).toHaveLength(1);
    // 加固契约：当该 turn 没有绑定 inbound 时，绝不能 fallback 到旧的 9999 / stale_user，必须降级纯文本！
    expect(sent[0].msg).toBe('无绑定轮次的输出');
  });

  it('契约 7: 真实生产装配闭环 - bootDshNapcatBridge + WS 网关验证 真实消息 -> poke -> 真实消息 引用闭环', async () => {
    const WS_PORT = 18366;
    const GROUP_ID = 3000000001;
    const BOT_QQ = '1000000001';

    const fullBooted = await bootDshNapcatBridge({ dshHome: tmpHome, mountPlugin: false });
    await fullBooted.ctx.plugin(NapCatBridgePlugin, {
      bot_qq: BOT_QQ,
      ws_port: WS_PORT,
      quote_original: true,
      at_questioner: true,
    });

    // 预创建群聊 Agent 并捕获 followup 产生的 userMsg
    const agents: any = fullBooted.ctx.get('agents');
    const handle = await agents.create({
      sessionId: `qq-group-${GROUP_ID}`,
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      meta: { cwd: path.join(tmpHome, 'agent-cwd') },
    });
    const agent = handle.agent || handle;
    const capturedUserMsgs: any[] = [];
    const origFollowup = agent.followup?.bind(agent);
    agent.followup = (msg: any) => {
      capturedUserMsgs.push(msg);
      if (origFollowup) origFollowup(msg);
    };

    const client = new WebSocket(`ws://127.0.0.1:${WS_PORT}`);
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
      // 自动响应 echo
      if (frame.echo) {
        client.send(
          JSON.stringify({
            echo: frame.echo,
            status: 'ok',
            retcode: 0,
            data: { message_id: 12345 },
          })
        );
      }
    });

    try {
      const sessionA = agent.session;
      let seq = 0;

      // 1. 发送真实消息 A (message_id: 10001)
      client.send(
        JSON.stringify({
          post_type: 'message',
          message_type: 'group',
          sub_type: 'normal',
          message_id: 10001,
          group_id: GROUP_ID,
          user_id: 2000000001,
          time: Math.floor(Date.now() / 1000),
          self_id: BOT_QQ,
          sender: { user_id: 2000000001, nickname: 'UserA', card: 'UserA' },
          message: [
            { type: 'at', data: { qq: BOT_QQ } },
            { type: 'text', data: { text: ' 消息 A' } },
          ],
          raw_message: `[CQ:at,qq=${BOT_QQ}] 消息 A`,
        })
      );

      await new Promise((r) => setTimeout(r, 150));
      expect(capturedUserMsgs).toHaveLength(1);

      // 驱动轮次 1 回复消息 A
      (fullBooted.ctx as any).emit('session/event', sessionA, {
        seq: seq++,
        type: 'turn/start',
        data: { turn: 1 },
      });
      (fullBooted.ctx as any).emit('session/event', sessionA, {
        seq: seq++,
        type: 'user/message',
        data: capturedUserMsgs[0],
      });
      (fullBooted.ctx as any).emit('session/event', sessionA, {
        seq: seq++,
        type: 'assistant/message',
        data: {
          turn: 1,
          step: 1,
          message: { content: [{ type: 'text', text: '收到消息 A' }] },
        },
      });
      (fullBooted.ctx as any).emit('session/event', sessionA, {
        seq: seq++,
        type: 'turn/end',
        data: { turn: 1, reason: { kind: 'completed' } },
      });

      await new Promise((r) => setTimeout(r, 150));
      expect(sentActionFrames.length).toBeGreaterThanOrEqual(1);
      const frameA = sentActionFrames[0].params.message;
      expect(Array.isArray(frameA)).toBe(true);
      expect(frameA[0]).toEqual({ type: 'reply', data: { id: 10001 } });
      expect(frameA[1]).toEqual({ type: 'at', data: { qq: '2000000001' } });

      // 2. 发送戳一戳 Notice 事件 (无 message_id)
      client.send(
        JSON.stringify({
          post_type: 'notice',
          notice_type: 'notify',
          sub_type: 'poke',
          target_id: BOT_QQ,
          user_id: 2000000002,
          group_id: GROUP_ID,
          time: Math.floor(Date.now() / 1000),
          self_id: BOT_QQ,
        })
      );

      await new Promise((r) => setTimeout(r, 150));
      expect(capturedUserMsgs).toHaveLength(2);

      // 驱动轮次 2 回复戳一戳
      (fullBooted.ctx as any).emit('session/event', sessionA, {
        seq: seq++,
        type: 'turn/start',
        data: { turn: 2 },
      });
      (fullBooted.ctx as any).emit('session/event', sessionA, {
        seq: seq++,
        type: 'user/message',
        data: capturedUserMsgs[1],
      });
      (fullBooted.ctx as any).emit('session/event', sessionA, {
        seq: seq++,
        type: 'assistant/message',
        data: {
          turn: 2,
          step: 1,
          message: { content: [{ type: 'text', text: '戳一戳纯文本回复' }] },
        },
      });
      (fullBooted.ctx as any).emit('session/event', sessionA, {
        seq: seq++,
        type: 'turn/end',
        data: { turn: 2, reason: { kind: 'completed' } },
      });

      await new Promise((r) => setTimeout(r, 150));
      expect(sentActionFrames.length).toBeGreaterThanOrEqual(2);
      const framePoke = sentActionFrames[1].params.message;
      // 戳一戳回复必须是纯文本，绝不包含 reply 10001，也不包含 at
      expect(framePoke).toBe('戳一戳纯文本回复');

      // 3. 发送下一条真实消息 B (message_id: 10002)
      client.send(
        JSON.stringify({
          post_type: 'message',
          message_type: 'group',
          sub_type: 'normal',
          message_id: 10002,
          group_id: GROUP_ID,
          user_id: 2000000003,
          time: Math.floor(Date.now() / 1000),
          self_id: BOT_QQ,
          sender: { user_id: 2000000003, nickname: 'UserB', card: 'UserB' },
          message: [
            { type: 'at', data: { qq: BOT_QQ } },
            { type: 'text', data: { text: ' 消息 B' } },
          ],
          raw_message: `[CQ:at,qq=${BOT_QQ}] 消息 B`,
        })
      );

      await new Promise((r) => setTimeout(r, 150));
      expect(capturedUserMsgs).toHaveLength(3);

      // 驱动轮次 3 回复消息 B
      (fullBooted.ctx as any).emit('session/event', sessionA, {
        seq: seq++,
        type: 'turn/start',
        data: { turn: 3 },
      });
      (fullBooted.ctx as any).emit('session/event', sessionA, {
        seq: seq++,
        type: 'user/message',
        data: capturedUserMsgs[2],
      });
      (fullBooted.ctx as any).emit('session/event', sessionA, {
        seq: seq++,
        type: 'assistant/message',
        data: {
          turn: 3,
          step: 1,
          message: { content: [{ type: 'text', text: '收到消息 B' }] },
        },
      });
      (fullBooted.ctx as any).emit('session/event', sessionA, {
        seq: seq++,
        type: 'turn/end',
        data: { turn: 3, reason: { kind: 'completed' } },
      });

      await new Promise((r) => setTimeout(r, 150));
      expect(sentActionFrames.length).toBeGreaterThanOrEqual(3);
      const frameB = sentActionFrames[2].params.message;
      // 消息 B 正确引用 10002 与 @ 2000000003
      expect(Array.isArray(frameB)).toBe(true);
      expect(frameB[0]).toEqual({ type: 'reply', data: { id: 10002 } });
      expect(frameB[1]).toEqual({ type: 'at', data: { qq: '2000000003' } });
    } finally {
      client.terminate();
      await fullBooted.dispose().catch(() => {});
    }
  });
});
