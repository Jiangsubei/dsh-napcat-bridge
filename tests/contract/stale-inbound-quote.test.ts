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
 * 核心契约（对齐 All-in-One 单 Agent 统筹重构与 send_qq_message 显式入参规范）：
 * 1. 戳一戳 (poke) 触发的唤醒 Prompt 严禁拼接 [消息ID: <id>]，且 assistant/message 坚决保持静默；
 * 2. 潜水超时 (idle) 触发的主动冒泡唤醒 Prompt 严禁拼接 [消息ID: <id>]，且 assistant/message 坚决保持静默；
 * 3. 连续多次戳一戳 (poke) 唤醒均不包含消息 ID，assistant/message 保持绝对静默，杜绝引用陈旧消息；
 * 4. poke/idle 之后下一条真实入站消息精准透传当前真实 [消息ID: <id>]，绝不串扰陈旧 ID；
 * 5. 真实消息出站按 send_qq_message 工具显式参数精准引用；
 * 6. assistant/message 坚决执行用户侧静默原则，未通过 send_qq_message 发送时绝不下发任何文本；
 * 7. 真实生产装配闭环：bootDshNapcatBridge + WS 网关验证 真实消息 -> poke -> 真实消息 引用隔离与静默闭环。
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

  function makeBridgeFixture() {
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
      getConfig: () => ({}),
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    });
    bridge.start();
    (sessionManager as any).setOutboundBridge?.(bridge);
    return { bridge, sessionManager, sent };
  }

  it('契约 1: 戳一戳 (poke) 触发的回复为纯文本，且 assistant/message 坚决保持静默', async () => {
    const { bridge, sessionManager, sent } = makeBridgeFixture();
    const peer = 'group_123';
    const session = { id: 'qq-group-123' };

    // 1. 模拟先前存在一条真实消息 A
    bridge.trackInboundContext(peer, {
      msg_id: 1001,
      from_user: 'user_A',
      is_group: true,
    });

    let pokeUserMsg: any;
    // 2. 触发戳一戳唤醒 (无 message_id)
    await sessionManager.dispatchWakeup(
      {
        trigger: 'poke',
        peer,
        from_user: 'user_poker',
        from_name: 'Poker',
        content: '[戳一戳]',
        timestamp: Date.now(),
      },
      {
        onMessageCreated: (msg) => {
          pokeUserMsg = msg;
        },
      }
    );

    // 唤醒文本严禁透传虚假消息 ID
    const pokePrompt = pokeUserMsg?.content?.[0]?.text || '';
    expect(pokePrompt).not.toContain('[消息ID:');
    expect(pokePrompt).toContain('戳了戳你');

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

    // 静默原则：assistant/message 事件绝不自动下发
    expect(sent).toHaveLength(0);

    // 静默原则：无 send_qq_message 时绝不自动下发
    expect(sent).toHaveLength(0);
  });

  it('契约 2: 潜水超时 (idle) 触发的主动冒泡回复为纯文本，且 assistant/message 坚决保持静默', async () => {
    const { bridge, sessionManager, sent } = makeBridgeFixture();
    const peer = 'group_123';
    const session = { id: 'qq-group-123' };

    // 1. 模拟先前存在一条真实消息 A
    bridge.trackInboundContext(peer, {
      msg_id: 1001,
      from_user: 'user_A',
      is_group: true,
    });

    let idleUserMsg: any;
    // 2. 触发潜水超时冒泡 (from_user 为空，无 message_id)
    await sessionManager.dispatchWakeup(
      {
        trigger: 'proactive',
        sub_trigger: 'idle',
        peer,
        from_user: '',
        from_name: '',
        content: '',
        timestamp: Date.now(),
      },
      {
        onMessageCreated: (msg) => {
          idleUserMsg = msg;
        },
      }
    );

    const idlePrompt = idleUserMsg?.content?.[0]?.text || '';
    expect(idlePrompt).not.toContain('[消息ID:');
    expect(idlePrompt).toContain('当前群聊已较长时间没有新发言');

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

    expect(sent).toHaveLength(0);
  });

  it('契约 3: 连续多次戳一戳 (poke) 回复均不引用不艾特，修复"永远引用消息 A"缺陷', async () => {
    const { bridge, sessionManager, sent } = makeBridgeFixture();
    const peer = 'group_123';
    const session = { id: 'qq-group-123' };

    // 1. 连续第 1 次 poke
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
      data: { turn: 1 },
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
        turn: 1,
        step: 1,
        message: { content: [{ type: 'text', text: '别戳啦 1' }] },
      },
    } as any);
    await bridge.handleSessionEvent(session as any, {
      type: 'turn/end',
      data: { turn: 1 },
    } as any);

    // 2. 连续第 2 次 poke
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
      data: { turn: 2 },
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
        turn: 2,
        step: 1,
        message: { content: [{ type: 'text', text: '别戳啦 2' }] },
      },
    } as any);
    await bridge.handleSessionEvent(session as any, {
      type: 'turn/end',
      data: { turn: 2 },
    } as any);

    // 静默原则：两次 poke 的 assistant/message 均保持静默
    expect(sent).toHaveLength(0);

    // 验证 Prompt 均未透传消息 ID
    expect(pokeMsg1?.content?.[0]?.text).not.toContain('[消息ID:');
    expect(pokeMsg2?.content?.[0]?.text).not.toContain('[消息ID:');
  });

  it('契约 4: poke/idle 之后下一条真实入站消息恢复引用原消息与@提问者 (不误伤真实消息)', async () => {
    const { bridge, sessionManager, sent } = makeBridgeFixture();
    const peer = 'group_123';
    const session = { id: 'qq-group-123' };

    // 1. 发生一次 poke 唤醒
    let pokeUserMsg: any;
    await sessionManager.dispatchWakeup(
      {
        trigger: 'poke',
        peer,
        from_user: 'user_poker',
        from_name: 'Poker',
        content: '[戳一戳]',
        timestamp: Date.now(),
      },
      {
        onMessageCreated: (msg) => {
          pokeUserMsg = msg;
        },
      }
    );
    expect(pokeUserMsg?.content?.[0]?.text).not.toContain('[消息ID:');

    // 2. 下一条真实消息 B 到来 (携带 msg_id: 2002)
    const replyContextB = {
      msg_id: 2002,
      from_user: 'user_B',
      is_group: true,
    };
    bridge.trackInboundContext(peer, replyContextB);

    let userMsgB: any;
    await sessionManager.dispatchWakeup(
      {
        msg_id: 2002,
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

    // 核心契约：真实消息 B 的唤醒 Prompt 必须显式携带 [消息ID: 2002]
    const promptB = userMsgB?.content?.[0]?.text || '';
    expect(promptB).toContain('[消息ID: 2002]');
    expect(promptB).toContain('帮我查一下天气');

    // assistant/message 静默
    await bridge.handleSessionEvent(session as any, {
      type: 'turn/start',
      data: { turn: 2 },
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

    expect(sent).toHaveLength(0);
  });

  it('契约 7: 真实生产装配闭环 - bootDshNapcatBridge + WS 网关验证 真实消息 -> poke -> 真实消息 引用闭环与静默', async () => {
    const WS_PORT = 18366;
    const GROUP_ID = 3000000001;
    const BOT_QQ = '1000000001';

    const fullBooted = await bootDshNapcatBridge({ dshHome: tmpHome, mountPlugin: false });
    await fullBooted.ctx.plugin(NapCatBridgePlugin, {
      bot_qq: BOT_QQ,
      ws_port: WS_PORT,
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
    agent.followup = (msg: any) => {
      capturedUserMsgs.push(msg);
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
      expect(capturedUserMsgs[0].content[0].text).toContain('[消息ID: 10001]');

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
          stream: [],
          message: { content: [{ type: 'text', text: '收到消息 A' }] },
        },
      });
      (fullBooted.ctx as any).emit('session/event', sessionA, {
        seq: seq++,
        type: 'turn/end',
        data: { turn: 1, reason: { kind: 'completed' } },
      });

      await new Promise((r) => setTimeout(r, 150));
      // 贯彻静默原则：assistant/message 不直发出站
      expect(sentActionFrames).toHaveLength(0);

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
      // 戳一戳绝不附带消息 ID
      expect(capturedUserMsgs[1].content[0].text).not.toContain('[消息ID:');
      expect(capturedUserMsgs[1].content[0].text).toContain('戳了戳你');

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
          stream: [],
          message: { content: [{ type: 'text', text: '戳一戳纯文本回复' }] },
        },
      });
      (fullBooted.ctx as any).emit('session/event', sessionA, {
        seq: seq++,
        type: 'turn/end',
        data: { turn: 2, reason: { kind: 'completed' } },
      });

      await new Promise((r) => setTimeout(r, 150));
      expect(sentActionFrames).toHaveLength(0);

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
      expect(capturedUserMsgs[2].content[0].text).toContain('[消息ID: 10002]');

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
          stream: [],
          message: { content: [{ type: 'text', text: '收到消息 B' }] },
        },
      });
      (fullBooted.ctx as any).emit('session/event', sessionA, {
        seq: seq++,
        type: 'turn/end',
        data: { turn: 3, reason: { kind: 'completed' } },
      });

      await new Promise((r) => setTimeout(r, 150));
      // 静默原则：整个过程未调用 send_qq_message，出站始终为 0
      expect(sentActionFrames).toHaveLength(0);
    } finally {
      client.terminate();
      await fullBooted.dispose().catch(() => {});
    }
  });
});
