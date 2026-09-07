/**
 * 契约测试: 阶段 5 send_message 首调引用规则 (First-Call Quote/At Rule)
 *
 * 覆盖规范清单:
 * 契约 1: 一轮内多次调用 send_message：第 1 次调用携带引用 (reply) 与艾特 (at) 前缀，第 2 次及后续调用为纯文本，不重复携带引用/艾特；
 * 契约 2: 单次调用场景：本轮仅调用 1 次 send_message，正常携带引用与艾特前缀；
 * 契约 3: 单次超长消息分段：首次调用超长文本分段下发时，仅第 1 个分段携带前缀，后续分段均为纯文本；
 * 契约 4: 私聊会话隔离：私聊会话 (qq-user-* / user_*) 下无论是首次还是多次调用，均下发纯文本，不引用不艾特；
 * 契约 5: 跨轮次隔离：Turn 1 结束后开启 Turn 2，Turn 2 的首次 send_message 能够再次正常携带 Turn 2 的锚点引用；
 * 契约 6: 真实生产装配闭环：使用 bootDshNapcatBridge + 真实 WebSocket 网关，端到端验证群消息入站后，一轮内模型多次调用 send_message 时真实出站 WebSocket 消息帧的首调前缀与后续纯文本行为。
 */

import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fsp } from 'node:fs';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WebSocket } from 'ws';
import { Context } from '@deepseek-ai/cordis';
import { bootDshNapcatBridge, type BootedDsh } from '../../src/boot.js';
import * as NapCatBridgePlugin from '../../src/index.js';
import { OutboundStreamBridge } from '../../src/outbound/stream.js';
import { sendMessage, resetGlobalToolContext } from '../../src/tools/index.js';

describe('契约 1 ~ 5: send_message 首调引用规则单元契约', () => {
  function setupBridgeAndGateway(config: Record<string, any> = {}) {
    const sent: Array<{ peer: string; msg: any }> = [];
    let msgIdSeq = 1000;
    const gateway = {
      sendMsg: vi.fn(async (peer: string, msg: any) => {
        sent.push({ peer, msg });
        msgIdSeq += 1;
        return { status: 'ok', retcode: 0, data: { message_id: msgIdSeq } };
      }),
    };
    const sessionManager = {
      isQQSession: (id: string) => id.startsWith('qq-') || id.startsWith('group_') || id.startsWith('user_'),
      sessionIdToPeer: (id: string) => {
        if (id.startsWith('qq-group-')) return `group_${id.slice('qq-group-'.length)}`;
        if (id.startsWith('qq-user-')) return `user_${id.slice('qq-user-'.length)}`;
        return id;
      },
      peerToSessionId: (peer: string) => {
        if (peer.startsWith('group_')) return `qq-group-${peer.slice(6)}`;
        if (peer.startsWith('user_')) return `qq-user-${peer.slice(5)}`;
        return peer;
      },
    };
    const ctx = new Context();
    const bridge = new OutboundStreamBridge(ctx, {
      gateway: gateway as any,
      sessionManager: sessionManager as any,
      getConfig: () => ({ quote_original: true, at_questioner: true, ...config }),
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    });
    return { bridge, gateway, sent, ctx };
  }

  beforeEach(() => {
    resetGlobalToolContext();
  });

  it('契约 1: 一轮内多次调用 send_message：第 1 次调用携带引用与艾特前缀，第 2 次及后续调用为纯文本', async () => {
    const { bridge, gateway, sent } = setupBridgeAndGateway({ quote_original: true, at_questioner: true });
    const session = { id: 'qq-group-10001' };

    bridge.trackPendingMessage('msg_u1', 'group_10001', {
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
      data: { id: 'msg_u1', content: [{ type: 'text', text: '查询天气' }] },
    } as any);

    // 第 1 次调用 send_message (汇报进度)
    const res1 = await sendMessage(
      { text: '正在查询天气情况，请稍候...' },
      { gateway: gateway as any, peer: 'group_10001', outboundBridge: bridge }
    );
    expect(res1.success).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0].peer).toBe('group_10001');

    // 首次调用应携带 reply 与 at 前缀
    const segs1 = sent[0].msg;
    expect(Array.isArray(segs1)).toBe(true);
    expect(segs1.find((s: any) => s.type === 'reply')?.data?.id).toBe(10001);
    expect(segs1.find((s: any) => s.type === 'at')?.data?.qq).toBe('2000000001');
    expect(segs1.find((s: any) => s.type === 'text')?.data?.text).toBe('正在查询天气情况，请稍候...');

    // 第 2 次调用 send_message (发送最终结果)
    const res2 = await sendMessage(
      { text: '查询完成：今日晴朗，25℃。' },
      { gateway: gateway as any, peer: 'group_10001', outboundBridge: bridge }
    );
    expect(res2.success).toBe(true);
    expect(sent).toHaveLength(2);

    // 第 2 次调用必须是纯文本，不再重复携带 reply 与 at
    const segs2 = sent[1].msg;
    if (Array.isArray(segs2)) {
      expect(segs2.find((s: any) => s.type === 'reply')).toBeUndefined();
      expect(segs2.find((s: any) => s.type === 'at')).toBeUndefined();
      expect(segs2.find((s: any) => s.type === 'text')?.data?.text).toBe('查询完成：今日晴朗，25℃。');
    } else {
      expect(segs2).toBe('查询完成：今日晴朗，25℃。');
    }

    // 第 3 次调用 send_message (追加说明)
    const res3 = await sendMessage(
      { text: '如有其他问题随时询问。' },
      { gateway: gateway as any, peer: 'group_10001', outboundBridge: bridge }
    );
    expect(res3.success).toBe(true);
    expect(sent).toHaveLength(3);
    const segs3 = sent[2].msg;
    if (Array.isArray(segs3)) {
      expect(segs3.find((s: any) => s.type === 'reply')).toBeUndefined();
      expect(segs3.find((s: any) => s.type === 'at')).toBeUndefined();
      expect(segs3.find((s: any) => s.type === 'text')?.data?.text).toBe('如有其他问题随时询问。');
    } else {
      expect(segs3).toBe('如有其他问题随时询问。');
    }
  });

  it('契约 2: 单次调用场景：本轮仅调用 1 次 send_message，正常携带引用与艾特前缀', async () => {
    const { bridge, gateway, sent } = setupBridgeAndGateway({ quote_original: true, at_questioner: true });
    const session = { id: 'qq-group-10001' };

    bridge.trackPendingMessage('msg_single', 'group_10001', {
      msg_id: 20001,
      from_user: '2000000002',
      is_group: true,
    });

    await bridge.handleSessionEvent(session as any, {
      type: 'turn/start',
      data: { turn: 1 },
    } as any);
    await bridge.handleSessionEvent(session as any, {
      type: 'user/message',
      data: { id: 'msg_single', content: [{ type: 'text', text: '单次问答' }] },
    } as any);

    const res = await sendMessage(
      { text: '单次处理完成，这是直接给出的答复。' },
      { gateway: gateway as any, peer: 'group_10001', outboundBridge: bridge }
    );
    expect(res.success).toBe(true);
    expect(sent).toHaveLength(1);

    const segs = sent[0].msg;
    expect(Array.isArray(segs)).toBe(true);
    expect(segs.find((s: any) => s.type === 'reply')?.data?.id).toBe(20001);
    expect(segs.find((s: any) => s.type === 'at')?.data?.qq).toBe('2000000002');
    expect(segs.find((s: any) => s.type === 'text')?.data?.text).toBe('单次处理完成，这是直接给出的答复。');
  });

  it('契约 3: 单次超长消息分段：首次调用超长文本分段下发时，仅第 1 个分段携带前缀，后续分段均为纯文本', async () => {
    const { bridge, gateway, sent } = setupBridgeAndGateway({ quote_original: true, at_questioner: true });
    const session = { id: 'qq-group-10001' };

    bridge.trackPendingMessage('msg_long', 'group_10001', {
      msg_id: 30001,
      from_user: '2000000003',
      is_group: true,
    });

    await bridge.handleSessionEvent(session as any, {
      type: 'turn/start',
      data: { turn: 1 },
    } as any);
    await bridge.handleSessionEvent(session as any, {
      type: 'user/message',
      data: { id: 'msg_long', content: [{ type: 'text', text: '超长分析报告' }] },
    } as any);

    // 构造超长文本 (2600 字符，分为 2 段)
    const longText = '这是一个非常详细的长篇报告内容段落。\n'.repeat(150);
    const res = await sendMessage(
      { text: longText },
      { gateway: gateway as any, peer: 'group_10001', outboundBridge: bridge }
    );
    expect(res.success).toBe(true);
    expect(sent.length).toBeGreaterThanOrEqual(2);

    // 第 1 个分段 (chunk 0) 必须携带 reply 与 at 前缀
    const firstChunkMsg = sent[0].msg;
    expect(Array.isArray(firstChunkMsg)).toBe(true);
    expect(firstChunkMsg.find((s: any) => s.type === 'reply')?.data?.id).toBe(30001);
    expect(firstChunkMsg.find((s: any) => s.type === 'at')?.data?.qq).toBe('2000000003');

    // 后续分段 (chunk 1 及之后) 必须为纯文本，绝不重复携带 reply 与 at
    for (let i = 1; i < sent.length; i++) {
      const laterChunkMsg = sent[i].msg;
      if (Array.isArray(laterChunkMsg)) {
        expect(laterChunkMsg.find((s: any) => s.type === 'reply')).toBeUndefined();
        expect(laterChunkMsg.find((s: any) => s.type === 'at')).toBeUndefined();
      } else {
        expect(typeof laterChunkMsg).toBe('string');
      }
    }
  });

  it('契约 4: 私聊会话隔离：私聊会话下无论是首次还是多次调用，均下发纯文本，不引用不艾特', async () => {
    const { bridge, gateway, sent } = setupBridgeAndGateway({ quote_original: true, at_questioner: true });
    const session = { id: 'qq-user-3000000001' };

    bridge.trackPendingMessage('msg_priv', 'user_3000000001', {
      msg_id: 40001,
      from_user: '3000000001',
      is_group: false,
    });

    await bridge.handleSessionEvent(session as any, {
      type: 'turn/start',
      data: { turn: 1 },
    } as any);
    await bridge.handleSessionEvent(session as any, {
      type: 'user/message',
      data: { id: 'msg_priv', content: [{ type: 'text', text: '私聊测试' }] },
    } as any);

    // 第 1 次调用私聊
    const res1 = await sendMessage(
      { text: '私聊首次回复' },
      { gateway: gateway as any, peer: 'user_3000000001', outboundBridge: bridge }
    );
    expect(res1.success).toBe(true);
    expect(sent).toHaveLength(1);
    // 私聊直接下发纯文本
    expect(sent[0].msg).toBe('私聊首次回复');

    // 第 2 次调用私聊
    const res2 = await sendMessage(
      { text: '私聊后续回复' },
      { gateway: gateway as any, peer: 'user_3000000001', outboundBridge: bridge }
    );
    expect(res2.success).toBe(true);
    expect(sent).toHaveLength(2);
    expect(sent[1].msg).toBe('私聊后续回复');
  });

  it('契约 5: 跨轮次隔离：Turn 1 结束后开启 Turn 2，Turn 2 的首次 send_message 能够再次正常携带 Turn 2 的锚点引用', async () => {
    const { bridge, gateway, sent } = setupBridgeAndGateway({ quote_original: true, at_questioner: true });
    const session = { id: 'qq-group-10001' };

    // --- Turn 1 ---
    bridge.trackPendingMessage('msg_turn1', 'group_10001', {
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
      data: { id: 'msg_turn1', content: [{ type: 'text', text: 'Turn 1 提问' }] },
    } as any);

    // Turn 1 第 1 次调用: 带 Turn 1 前缀
    await sendMessage(
      { text: 'Turn 1 进度汇报' },
      { gateway: gateway as any, peer: 'group_10001', outboundBridge: bridge }
    );
    expect(sent).toHaveLength(1);
    const segsT1_1 = sent[0].msg;
    expect(Array.isArray(segsT1_1)).toBe(true);
    expect(segsT1_1.find((s: any) => s.type === 'reply')?.data?.id).toBe(50001);

    // Turn 1 第 2 次调用: 纯文本
    await sendMessage(
      { text: 'Turn 1 终答' },
      { gateway: gateway as any, peer: 'group_10001', outboundBridge: bridge }
    );
    expect(sent).toHaveLength(2);
    expect(sent[1].msg).toBe('Turn 1 终答');

    // Turn 1 结束
    await bridge.handleSessionEvent(session as any, {
      type: 'turn/end',
      data: { turn: 1, reason: { kind: 'completed' } },
    } as any);

    // --- Turn 2 ---
    bridge.trackPendingMessage('msg_turn2', 'group_10001', {
      msg_id: 50002,
      from_user: '2000000002',
      is_group: true,
    });
    await bridge.handleSessionEvent(session as any, {
      type: 'turn/start',
      data: { turn: 2 },
    } as any);
    await bridge.handleSessionEvent(session as any, {
      type: 'user/message',
      data: { id: 'msg_turn2', content: [{ type: 'text', text: 'Turn 2 提问' }] },
    } as any);

    // Turn 2 第 1 次调用: 必须携带 Turn 2 的新锚点引用 (msg_id: 50002) 与 at 提问者
    await sendMessage(
      { text: 'Turn 2 进度汇报' },
      { gateway: gateway as any, peer: 'group_10001', outboundBridge: bridge }
    );
    expect(sent).toHaveLength(3);
    const segsT2_1 = sent[2].msg;
    expect(Array.isArray(segsT2_1)).toBe(true);
    expect(segsT2_1.find((s: any) => s.type === 'reply')?.data?.id).toBe(50002);
    expect(segsT2_1.find((s: any) => s.type === 'at')?.data?.qq).toBe('2000000002');
    expect(segsT2_1.find((s: any) => s.type === 'text')?.data?.text).toBe('Turn 2 进度汇报');

    // Turn 2 第 2 次调用: 再次变为纯文本
    await sendMessage(
      { text: 'Turn 2 终答' },
      { gateway: gateway as any, peer: 'group_10001', outboundBridge: bridge }
    );
    expect(sent).toHaveLength(4);
    expect(sent[3].msg).toBe('Turn 2 终答');
  });
});

describe('契约 6: 真实生产装配闭环 (Real Assembly Contract via bootDshNapcatBridge + WS Gateway)', () => {
  let tmpHome: string;
  let booted: BootedDsh;
  let client: WebSocket;
  const WS_PORT = 29892;
  const BOT_QQ = '1000000001';
  const GROUP_ID = 888777;
  const USER_QQ = '2000000008';

  beforeEach(async () => {
    tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-send-quote-asm-'));
  });

  afterEach(async () => {
    if (client) {
      try {
        client.close();
      } catch {}
    }
    if (booted) {
      try {
        await booted.dispose();
      } catch {}
    }
    try {
      await fsp.rm(tmpHome, { recursive: true, force: true });
    } catch {}
    resetGlobalToolContext();
  });

  it('真实装配下：群消息入站后，一轮内模型多次调用 send_message 时真实出站 WebSocket 消息帧的首调前缀与后续纯文本行为', async () => {
    booted = await bootDshNapcatBridge({ dshHome: tmpHome, mountPlugin: false });
    await booted.ctx.plugin(NapCatBridgePlugin, {
      bot_qq: BOT_QQ,
      ws_port: WS_PORT,
      quote_original: true,
      at_questioner: true,
    });

    const agents: any = booted.ctx.get('agents');
    const tools: any = booted.ctx.get('tools');

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
    const realMsgId = 88001;

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
        sender: { user_id: USER_QQ, nickname: 'QuoteTester', card: 'QuoteTester' },
        message: [
          { type: 'at', data: { qq: BOT_QQ } },
          { type: 'text', data: { text: ' 查询报表' } },
        ],
        raw_message: `[CQ:at,qq=${BOT_QQ}] 查询报表`,
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

    // 3. 模型第 1 次调用 send_qq_message 工具 (汇报进度)
    const execRes1 = await tools.execute({
      name: 'send_qq_message',
      arguments: { text: '正在生成报表，请稍等片刻...' },
      agent,
      signal: new AbortController().signal,
    });
    expect(execRes1.isError).toBe(false);

    await new Promise((r) => setTimeout(r, 150));
    expect(sentActionFrames).toHaveLength(1);

    const frame1 = sentActionFrames[0];
    expect(frame1.action).toBe('send_group_msg');
    expect(frame1.params.group_id).toBe(GROUP_ID);

    // 断言第 1 次出站消息：包含引用真实消息 ID 88001 与 @提问者 QQ
    expect(Array.isArray(frame1.params.message)).toBe(true);
    const replySeg1 = frame1.params.message.find((s: any) => s.type === 'reply');
    expect(replySeg1).toBeDefined();
    expect(replySeg1.data.id).toBe(realMsgId);
    const atSeg1 = frame1.params.message.find((s: any) => s.type === 'at');
    expect(atSeg1).toBeDefined();
    expect(atSeg1.data.qq).toBe(USER_QQ);
    const textSeg1 = frame1.params.message.find((s: any) => s.type === 'text');
    expect(textSeg1.data.text).toBe('正在生成报表，请稍等片刻...');

    // 4. 模型第 2 次调用 send_qq_message 工具 (发送终答报表)
    const execRes2 = await tools.execute({
      name: 'send_qq_message',
      arguments: { text: '报表已生成完毕，今日总访问量 1024。' },
      agent,
      signal: new AbortController().signal,
    });
    expect(execRes2.isError).toBe(false);

    await new Promise((r) => setTimeout(r, 150));
    expect(sentActionFrames).toHaveLength(2);

    const frame2 = sentActionFrames[1];
    expect(frame2.action).toBe('send_group_msg');
    expect(frame2.params.group_id).toBe(GROUP_ID);

    // 断言第 2 次出站消息：纯文本，不再重复携带 reply 与 at
    if (Array.isArray(frame2.params.message)) {
      expect(frame2.params.message.find((s: any) => s.type === 'reply')).toBeUndefined();
      expect(frame2.params.message.find((s: any) => s.type === 'at')).toBeUndefined();
      expect(frame2.params.message.find((s: any) => s.type === 'text')?.data?.text).toBe(
        '报表已生成完毕，今日总访问量 1024。'
      );
    } else {
      expect(frame2.params.message).toBe('报表已生成完毕，今日总访问量 1024。');
    }

    // 5. 轮次结束，确认旁白抑制保证没有多余补发
    (booted.ctx as any).emit('session/event', session, {
      seq: seq++,
      type: 'turn/end',
      data: { turn: 1, reason: { kind: 'completed' } },
    });
    await new Promise((r) => setTimeout(r, 150));
    expect(sentActionFrames).toHaveLength(2);
  });
});
