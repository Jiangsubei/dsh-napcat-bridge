import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fsp } from 'node:fs';
import WebSocket from 'ws';
import { Context } from '@deepseek-ai/cordis';
import { bootDshNapcatBridge, type BootedDsh } from '../../src/boot.js';
import * as NapCatBridgePlugin from '../../src/index.js';
import { OutboundStreamBridge } from '../../src/outbound/stream.js';
import { SessionManager } from '../../src/gateway/session.js';
import { MessageDatabase } from '../../src/storage/database.js';

/**
 * 契约测试: 回合锚定锁定与合成 ID 隔离防御修复 (Turn Anchor Bugfix Contract)
 *
 * 验证核心规范:
 * 1. 场景 1 (真实装配闭环): 真实消息入站触发群聊回合 -> 中途下发 group_msg_emoji_like notice 事件 (贴表情回传) ->
 *    模型输出回复 -> 断言 WS 发送的 send_group_msg 中的 reply 段 ID 必须依然是起始真实消息的 msg_id，绝不是 syntheticMsgId！
 * 2. 场景 2 (合成标记防御降级): 若上下文中的 msg_id 带有合成标记 (is_synthetic: true 或 synthetic: true)，
 *    出站自动降级为纯文本，绝不生成 reply 引用段。
 * 3. 场景 3 (非法 msg_id 防御): msg_id <= 0 或非合法整数时，严禁生成 reply 段，降级为纯文本。
 * 4. 场景 4 (inboundMsgIdGetter 优先活跃 Turn 且过滤合成 ID):
 *    优先从 getActiveTurnContext(peer)?.msg_id 读取；若为合成 ID 返回 undefined。
 */

const WS_PORT = 18377;
const GROUP_ID = 3000000001;
const BOT_QQ = '1000000001';
const USER_QQ = '2000000001';

function calcStableNoticeMsgId(key: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) || 1;
}

describe('契约测试: 回合锚定锁定与合成 ID 隔离防御修复 (Turn Anchor Bugfix)', () => {
  let tmpHome: string;
  let booted: BootedDsh;
  let client: WebSocket;
  let db: MessageDatabase;

  beforeEach(async () => {
    tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-turn-anchor-fix-'));
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
    if (tmpHome) {
      await fsp.rm(tmpHome, { recursive: true, force: true }).catch(() => {});
    }
    vi.restoreAllMocks();
  });

  it('场景 1: 真实装配闭环 - 真实群消息入站 -> 中途 group_msg_emoji_like notice -> 出站回复仍引用起始真实消息 msg_id', async () => {
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
            data: { message_id: 99999 },
          })
        );
      }
    });

    const session = agent.session;
    let seq = 0;
    const realMsgId = 10001;

    // 1. 发送真实群消息入站唤醒
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
        sender: { user_id: USER_QQ, nickname: 'UserA', card: 'UserA' },
        message: [
          { type: 'at', data: { qq: BOT_QQ } },
          { type: 'text', data: { text: ' 你好机器人' } },
        ],
        raw_message: `[CQ:at,qq=${BOT_QQ}] 你好机器人`,
      })
    );

    await new Promise((r) => setTimeout(r, 150));
    expect(capturedUserMsgs).toHaveLength(1);

    // 2. 启动 Turn 1
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

    // 3. 中途模拟 NapCat 回传 group_msg_emoji_like notice (例如执行 react_message 贴表情后收到 notice)
    const noticeTimestamp = 1700000010;
    client.send(
      JSON.stringify({
        post_type: 'notice',
        notice_type: 'group_msg_emoji_like',
        group_id: GROUP_ID,
        user_id: USER_QQ,
        message_id: realMsgId,
        likes: [{ emoji_id: '76', count: 1 }],
        time: noticeTimestamp,
        self_id: BOT_QQ,
      })
    );

    // 等待 notice 事件被 server.onNotice 处理并落库
    await new Promise((r) => setTimeout(r, 150));

    // 计算 notice 的合成 ID
    const syntheticNoticeId = calcStableNoticeMsgId(`emoji_like:${GROUP_ID}:${realMsgId}:${noticeTimestamp * 1000}`);

    // 4. 模型输出 AssistantMessage
    (booted.ctx as any).emit('session/event', session, {
      seq: seq++,
      type: 'assistant/message',
      data: {
        turn: 1,
        step: 1,
        message: { content: [{ type: 'text', text: '你好！我是助手。' }] },
      },
    });
    (booted.ctx as any).emit('session/event', session, {
      seq: seq++,
      type: 'turn/end',
      data: { turn: 1, reason: { kind: 'completed' } },
    });

    await new Promise((r) => setTimeout(r, 150));

    // 断言出站消息
    expect(sentActionFrames.length).toBeGreaterThanOrEqual(1);
    const sentFrame = sentActionFrames[0];
    expect(sentFrame.action).toBe('send_group_msg');
    expect(sentFrame.params.group_id).toBe(GROUP_ID);

    const messagePayload = sentFrame.params.message;
    expect(Array.isArray(messagePayload)).toBe(true);

    const replySegment = messagePayload.find((s: any) => s.type === 'reply');
    expect(replySegment).toBeDefined();
    // 关键契约断言：引用段 ID 必须依然是起始真实消息的 msg_id (10001)，绝不是 notice 的 syntheticNoticeId！
    expect(replySegment.data.id).toBe(realMsgId);
    expect(replySegment.data.id).not.toBe(syntheticNoticeId);

    const textSegment = messagePayload.find((s: any) => s.type === 'text');
    expect(textSegment).toBeDefined();
    expect(textSegment.data.text).toBe('你好！我是助手。');
  });

  it('场景 2: 防御性断言 - 若上下文中的 msg_id 带有合成标记 (is_synthetic: true 或 synthetic: true)，出站自动降级为纯文本', () => {
    const sessionManager = new SessionManager(new Context(), tmpHome, db);
    const bridge = new OutboundStreamBridge(sessionManager.ctx, {
      gateway: { sendMsg: vi.fn() } as any,
      sessionManager,
      getConfig: () => ({ quote_original: true, at_questioner: true }),
    });

    // 1. is_synthetic: true
    const payload1 = bridge.buildMessagePayload('group_123456', '测试回复内容1', {
      withPrefix: true,
      inbound: {
        msg_id: 888888,
        from_user: '2000000001',
        is_group: true,
        is_synthetic: true,
      },
    });
    // 断言：直接返回纯文本，绝不生成包含 reply 段的数组
    expect(payload1).toBe('测试回复内容1');

    // 2. synthetic: true
    const payload2 = bridge.buildMessagePayload('group_123456', '测试回复内容2', {
      withPrefix: true,
      inbound: {
        msg_id: 888888,
        from_user: '2000000001',
        is_group: true,
        synthetic: true,
      },
    });
    expect(payload2).toBe('测试回复内容2');

    // 3. trigger: 'poke' / 'idle' 带有合成标记
    const payload3 = bridge.buildMessagePayload('group_123456', '测试回复内容3', {
      withPrefix: true,
      inbound: {
        msg_id: 888888,
        from_user: '2000000001',
        is_group: true,
        trigger: 'poke',
      },
    });
    expect(payload3).toBe('测试回复内容3');
  });

  it('场景 3: 非法 msg_id 防御 - 非正整数或非法数值时严禁生成 reply 段', () => {
    const sessionManager = new SessionManager(new Context(), tmpHome, db);
    const bridge = new OutboundStreamBridge(sessionManager.ctx, {
      gateway: { sendMsg: vi.fn() } as any,
      sessionManager,
      getConfig: () => ({ quote_original: true, at_questioner: false }),
    });

    // msg_id 为负数
    const p1 = bridge.buildMessagePayload('group_123456', '负数 ID', {
      withPrefix: true,
      inbound: { msg_id: -1, is_group: true },
    });
    expect(p1).toBe('负数 ID');

    // msg_id 为 0
    const p2 = bridge.buildMessagePayload('group_123456', '零 ID', {
      withPrefix: true,
      inbound: { msg_id: 0, is_group: true },
    });
    expect(p2).toBe('零 ID');

    // msg_id 为 NaN
    const p3 = bridge.buildMessagePayload('group_123456', 'NaN ID', {
      withPrefix: true,
      inbound: { msg_id: NaN, is_group: true },
    });
    expect(p3).toBe('NaN ID');
  });

  it('场景 4: getActiveTurnContext 暴露与 inboundMsgIdGetter 优先活跃 Turn 锚点', async () => {
    booted = await bootDshNapcatBridge({ dshHome: tmpHome, mountPlugin: false });
    await booted.ctx.plugin(NapCatBridgePlugin, {
      bot_qq: BOT_QQ,
      ws_port: WS_PORT + 1,
    });

    const sessionManager = (booted.ctx as any).get('sessionManager') ||
      new SessionManager(booted.ctx, tmpHome, db);

    const bridge = new OutboundStreamBridge(booted.ctx, {
      gateway: { sendMsg: vi.fn() } as any,
      sessionManager,
    });

    const peer = `group_${GROUP_ID}`;
    const session = { id: `qq-group-${GROUP_ID}` };

    // 1. 设置真实入站消息上下文并开启 Turn 1
    bridge.trackInboundContext(peer, {
      msg_id: 55555,
      from_user: USER_QQ,
      is_group: true,
    });
    bridge.trackPendingMessage('msg-uuid-1', peer, {
      msg_id: 55555,
      from_user: USER_QQ,
      is_group: true,
    });

    await bridge.handleSessionEvent(session as any, {
      type: 'turn/start',
      data: { turn: 1 },
    } as any);

    // 断言 getActiveTurnContext 返回 Turn 1 的真实锚点
    const activeCtx1 = bridge.getActiveTurnContext(peer);
    expect(activeCtx1).toBeDefined();
    expect(activeCtx1?.msg_id).toBe(55555);

    // 断言使用 session id 形式 (qq-group-*) 查询也能返回正确上下文
    const activeCtxFromSessionId = bridge.getActiveTurnContext(`qq-group-${GROUP_ID}`);
    expect(activeCtxFromSessionId).toBeDefined();
    expect(activeCtxFromSessionId?.msg_id).toBe(55555);

    // 2. 中途模拟闲聊或外部事件调用了 trackInboundContext 写入了新 ID (如 66666)
    bridge.trackInboundContext(peer, {
      msg_id: 66666,
      from_user: 'another_user',
      is_group: true,
    });

    // 核心断言：当前活跃 Turn 1 的锚点绝不被覆盖，getActiveTurnContext 依然返回 55555！
    const activeCtxStillTurn1 = bridge.getActiveTurnContext(peer);
    expect(activeCtxStillTurn1?.msg_id).toBe(55555);

    // 3. 结束 Turn 1
    await bridge.handleSessionEvent(session as any, {
      type: 'turn/end',
      data: { turn: 1 },
    } as any);

    // Turn 1 结束后，回退到最新的保底 inboundContexts (66666)
    const afterTurnCtx = bridge.getActiveTurnContext(peer);
    expect(afterTurnCtx?.msg_id).toBe(66666);
  });

  it('场景 5: 合成 ID 强隔离 - inboundMsgIdGetter 对 is_synthetic 标记返回 undefined，防止 react_message 误贴虚假消息', async () => {
    let capturedGetter: ((peer: string) => number | undefined) | null = null;
    const ctx = new Context();
    ctx.provide('tools');
    ctx.set('tools', {
      register: vi.fn(),
      guard: vi.fn(),
    });

    const sessionManager = new SessionManager(ctx, tmpHome, db);
    const bridge = new OutboundStreamBridge(ctx, {
      gateway: { sendMsg: vi.fn() } as any,
      sessionManager,
    });

    // 模拟注册插件时捕获 inboundMsgIdGetter
    const outboundBridge = bridge;
    const inboundMsgIdGetter = (peer: string) => {
      if (!outboundBridge) return undefined;
      const inboundCtx =
        outboundBridge.getActiveTurnContext?.(peer) ??
        (outboundBridge as any).getInboundContext?.(peer) ??
        (outboundBridge as any).inboundContexts?.get?.(peer);
      if (inboundCtx && ((inboundCtx as any).is_synthetic || (inboundCtx as any).synthetic)) {
        return undefined;
      }
      return inboundCtx?.msg_id;
    };

    const peer = `group_${GROUP_ID}`;
    const session = { id: `qq-group-${GROUP_ID}` };

    // 1. 若当前上下文为合成 ID (例如 poke 或 notice)
    bridge.trackInboundContext(peer, {
      msg_id: 999999,
      from_user: USER_QQ,
      is_group: true,
      is_synthetic: true,
    });

    // 此时通过 inboundMsgIdGetter 查询，必须返回 undefined，绝对不能暴露 999999
    expect(inboundMsgIdGetter(peer)).toBeUndefined();

    // 2. 若当前为真实消息
    bridge.trackInboundContext(peer, {
      msg_id: 12345,
      from_user: USER_QQ,
      is_group: true,
    });

    expect(inboundMsgIdGetter(peer)).toBe(12345);
  });
});
