import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fsp } from 'node:fs';
import Database from 'better-sqlite3';
import WebSocket from 'ws';
import { shouldWakeup } from '../../src/gateway/wakeup.js';
import { FriendNoticeTracker } from '../../src/gateway/friend-tracker.js';
import { GatewayServer } from '../../src/gateway/server.js';
import { bootDshNapcatBridge, type BootedDsh } from '../../src/boot.js';
import * as NapCatBridgePlugin from '../../src/index.js';
import type { OneBotMessageEvent, OneBotNoticeEvent, OneBotRequestEvent } from '../../src/types/index.js';

describe('契约测试: 好友申请、通过与系统消息唤醒隔离 (Friend Request Wakeup Contract)', () => {
  const BOT_QQ = '1000000001';
  const BOT_NICKNAME = '智能小助手';
  const ALIASES = ['小助手'];
  const USER_QQ = '2000000001';

  let tracker: FriendNoticeTracker;

  beforeEach(() => {
    tracker = new FriendNoticeTracker();
  });

  it('契约 1: 收到加好友请求后，好友通过瞬间注入的附言私聊消息必须不唤醒 Agent', async () => {
    const friendComment = '我是测试用户好友验证';
    const nowSec = 1788045520;

    // 1. 记录入站好友请求
    tracker.recordRequest(USER_QQ, friendComment, nowSec);
    // 2. 记录好友添加成功通知
    tracker.recordFriendAdd(USER_QQ, nowSec + 10);

    // 3. QQNT 注入的私聊首条消息（内容精确匹配附言）
    const injectedMsgEvent: OneBotMessageEvent = {
      post_type: 'message',
      message_type: 'private',
      sub_type: 'friend',
      message_id: 5001,
      user_id: USER_QQ,
      time: nowSec + 10,
      self_id: BOT_QQ,
      sender: { user_id: USER_QQ, nickname: '测试用户' },
      message: [{ type: 'text', data: { text: friendComment } }],
      raw_message: friendComment,
    };

    const decision = await shouldWakeup(injectedMsgEvent, {
      bot_qq: BOT_QQ,
      bot_nickname: BOT_NICKNAME,
      aliases: ALIASES,
      friendTracker: tracker,
    });

    // 必须被阻断，不唤醒 Agent
    expect(decision.wakeup).toBe(false);
    expect(decision.payload).toBeUndefined();
  });

  it('契约 2: 附言消息被消费后，用户在后续聊天中打字发送相同内容，必须正常唤醒 Agent（零误杀）', async () => {
    const friendComment = '我是测试用户好友验证';
    const nowSec = 1788045520;

    // 模拟先经过了好友通过附言消费流程
    tracker.recordRequest(USER_QQ, friendComment, nowSec);
    tracker.recordFriendAdd(USER_QQ, nowSec + 10);
    // 消费一次
    const consumed = tracker.checkAndConsumeFriendNotice(USER_QQ, friendComment);
    expect(consumed).toBe(true);

    // 用户在正常对话中手动发送了一模一样的话
    const realUserMsgEvent: OneBotMessageEvent = {
      post_type: 'message',
      message_type: 'private',
      sub_type: 'friend',
      message_id: 5002,
      user_id: USER_QQ,
      time: nowSec + 15,
      self_id: BOT_QQ,
      sender: { user_id: USER_QQ, nickname: '测试用户' },
      message: [{ type: 'text', data: { text: friendComment } }],
      raw_message: friendComment,
    };

    const decision = await shouldWakeup(realUserMsgEvent, {
      bot_qq: BOT_QQ,
      bot_nickname: BOT_NICKNAME,
      aliases: ALIASES,
      friendTracker: tracker,
    });

    // 正常聊天必须 100% 正常唤醒
    expect(decision.wakeup).toBe(true);
    expect(decision.payload?.peer).toBe(`user_${USER_QQ}`);
    expect(decision.payload?.content).toBe(friendComment);
  });

  it('契约 3: 好友通过后，用户正常发送新问候，必须正常唤醒 Agent', async () => {
    const friendComment = '我是测试用户好友验证';
    const nowSec = 1788045520;

    tracker.recordRequest(USER_QQ, friendComment, nowSec);
    tracker.recordFriendAdd(USER_QQ, nowSec + 10);

    const normalGreetingEvent: OneBotMessageEvent = {
      post_type: 'message',
      message_type: 'private',
      sub_type: 'friend',
      message_id: 5003,
      user_id: USER_QQ,
      time: nowSec + 12,
      self_id: BOT_QQ,
      sender: { user_id: USER_QQ, nickname: '测试用户' },
      message: [{ type: 'text', data: { text: '你好呀，新朋友！' } }],
      raw_message: '你好呀，新朋友！',
    };

    const decision = await shouldWakeup(normalGreetingEvent, {
      bot_qq: BOT_QQ,
      bot_nickname: BOT_NICKNAME,
      aliases: ALIASES,
      friendTracker: tracker,
    });

    expect(decision.wakeup).toBe(true);
    expect(decision.payload?.content).toBe('你好呀，新朋友！');
  });

  it('契约 4: 来自 QQ 系统号 (user_id: 10000) 或 sub_type: "notice" 的私聊系统消息必须不唤醒 Agent', async () => {
    const sysEvent1: OneBotMessageEvent = {
      post_type: 'message',
      message_type: 'private',
      sub_type: 'friend',
      message_id: 5004,
      user_id: 10000,
      time: 1788045530,
      self_id: BOT_QQ,
      sender: { user_id: 10000, nickname: '系统通知' },
      message: [{ type: 'text', data: { text: '你已添加了新好友' } }],
      raw_message: '你已添加了新好友',
    };

    const decision1 = await shouldWakeup(sysEvent1, {
      bot_qq: BOT_QQ,
      bot_nickname: BOT_NICKNAME,
      aliases: ALIASES,
      friendTracker: tracker,
    });
    expect(decision1.wakeup).toBe(false);

    const sysEvent2: OneBotMessageEvent = {
      post_type: 'message',
      message_type: 'private',
      sub_type: 'notice',
      message_id: 5005,
      user_id: USER_QQ,
      time: 1788045531,
      self_id: BOT_QQ,
      sender: { user_id: USER_QQ, nickname: '测试用户' },
      message: [{ type: 'text', data: { text: '对方开启了好友验证' } }],
      raw_message: '对方开启了好友验证',
    };

    const decision2 = await shouldWakeup(sysEvent2, {
      bot_qq: BOT_QQ,
      bot_nickname: BOT_NICKNAME,
      aliases: ALIASES,
      friendTracker: tracker,
    });
    expect(decision2.wakeup).toBe(false);
  });

  it('契约 5: notice 类型的 friend_add 通知事件绝不触发唤醒', async () => {
    const noticeEvent: OneBotNoticeEvent = {
      post_type: 'notice',
      notice_type: 'friend_add',
      user_id: USER_QQ,
      time: 1788045535,
      self_id: BOT_QQ,
    };

    const decision = await shouldWakeup(noticeEvent, {
      bot_qq: BOT_QQ,
      bot_nickname: BOT_NICKNAME,
      aliases: ALIASES,
      friendTracker: tracker,
    });

    expect(decision.wakeup).toBe(false);
  });

  it('契约 6: GatewayServer 能够正确分发 post_type: "request" 事件至 onRequest 处理器', async () => {
    const server = new GatewayServer({
      port: 19888,
      host: '127.0.0.1',
    });

    const receivedRequests: OneBotRequestEvent[] = [];
    server.onRequest((req) => {
      receivedRequests.push(req);
    });

    const mockRequest: OneBotRequestEvent = {
      post_type: 'request',
      request_type: 'friend',
      user_id: USER_QQ,
      comment: '请求加为好友',
      flag: 'flag_12345',
      time: 1788045540,
      self_id: BOT_QQ,
    };

    // 直接通过内部 handleIncomingRaw 分发
    (server as any).handleIncomingRaw(JSON.stringify(mockRequest));

    expect(receivedRequests.length).toBe(1);
    expect(receivedRequests[0].request_type).toBe('friend');
    expect(receivedRequests[0].user_id).toBe(USER_QQ);
    expect(receivedRequests[0].comment).toBe('请求加为好友');
  });
});

describe('装配闭环契约测试: 好友申请附言注入与后续正常消息唤醒 (Assembly Lifecycle Contract)', () => {
  const BOT_QQ = '1000000001';
  const USER_QQ = '2000000001';
  const WS_PORT = 18328;

  let tmpHome: string;
  let booted: BootedDsh;
  let client: WebSocket;
  let capturedFollowups: Array<{ content: string }> = [];

  function dbPath(): string {
    return path.join(tmpHome, 'napcat/messages.sqlite');
  }

  beforeEach(async () => {
    tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-napcat-friend-test-'));
    capturedFollowups = [];
    booted = await bootDshNapcatBridge({ dshHome: tmpHome, mountPlugin: false });
    await booted.ctx.plugin(NapCatBridgePlugin, {
      bot_qq: BOT_QQ,
      ws_token: 'test-token',
      ws_port: WS_PORT,
    });

    const agents: any = booted.ctx.get('agents');
    const handle = await agents.create({
      sessionId: `qq-user-${USER_QQ}`,
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      meta: { cwd: path.join(tmpHome, 'agent-cwd') },
    });
    const agent = handle.agent || handle;
    agent.followup = (msg: any) => {
      const text = Array.isArray(msg?.content)
        ? msg.content.map((c: any) => c?.text || '').join('')
        : String(msg?.content || '');
      capturedFollowups.push({ content: text });
    };

    client = new WebSocket(`ws://127.0.0.1:${WS_PORT}?access_token=test-token`);
    await new Promise<void>((resolve, reject) => {
      client.once('open', () => resolve());
      client.once('error', reject);
    });
  });

  afterEach(async () => {
    if (client && client.readyState === WebSocket.OPEN) {
      client.close();
    }
    await new Promise((r) => setTimeout(r, 100));
    await booted.dispose();
    await fsp.rm(tmpHome, { recursive: true, force: true }).catch(() => {});
  });

  it('装配-契约 7: 完整流程装配闭环验证：好友附言不唤醒且标记为系统提示，后续正常消息顺利唤醒', async () => {
    const friendComment = '申请好友验证附言内容';
    const nowSec = Math.floor(Date.now() / 1000);

    // 1. NapCat 推送好友申请 (request.friend)
    client.send(
      JSON.stringify({
        post_type: 'request',
        request_type: 'friend',
        user_id: USER_QQ,
        comment: friendComment,
        flag: 'flag_test_123',
        time: nowSec,
        self_id: BOT_QQ,
      })
    );
    await new Promise((r) => setTimeout(r, 100));

    // 2. 好友申请被同意，NapCat 推送好友增加通知 (notice.friend_add)
    client.send(
      JSON.stringify({
        post_type: 'notice',
        notice_type: 'friend_add',
        user_id: USER_QQ,
        time: nowSec + 1,
        self_id: BOT_QQ,
      })
    );
    await new Promise((r) => setTimeout(r, 100));

    // 3. QQNT 注入的私聊附言历史消息 (message.private.friend)
    const injectedMsgId = 600001;
    client.send(
      JSON.stringify({
        post_type: 'message',
        message_type: 'private',
        sub_type: 'friend',
        message_id: injectedMsgId,
        user_id: USER_QQ,
        sender: { user_id: USER_QQ, nickname: '测试用户' },
        message: [{ type: 'text', data: { text: friendComment } }],
        raw_message: friendComment,
        time: nowSec + 1,
        self_id: BOT_QQ,
      })
    );

    // 等待 300ms
    await new Promise((r) => setTimeout(r, 300));

    // 核心断言 1: Agent 绝没有被附言注入唤醒
    expect(capturedFollowups.length).toBe(0);

    // 核心断言 2: 数据库中该记录保存为 friend_notice，且发送者为 系统提示
    const db = new Database(dbPath(), { readonly: true });
    try {
      const row: any = db.prepare('SELECT * FROM messages WHERE msg_id = ?').get(injectedMsgId);
      expect(row).toBeDefined();
      expect(row.type).toBe('friend_notice');
      expect(row.sender_name).toBe('系统提示');
    } finally {
      db.close();
    }

    // 4. 用户随后在聊天窗口中发出一条真正的打招呼消息
    const realMsgId = 600002;
    client.send(
      JSON.stringify({
        post_type: 'message',
        message_type: 'private',
        sub_type: 'friend',
        message_id: realMsgId,
        user_id: USER_QQ,
        sender: { user_id: USER_QQ, nickname: '测试用户' },
        message: [{ type: 'text', data: { text: '你好呀，很高兴认识你！' } }],
        raw_message: '你好呀，很高兴认识你！',
        time: nowSec + 3,
        self_id: BOT_QQ,
      })
    );

    // 等待 300ms
    await new Promise((r) => setTimeout(r, 300));

    // 核心断言 3: Agent 被真实用户消息正常唤醒
    expect(capturedFollowups.length).toBe(1);
    expect(capturedFollowups[0].content).toContain('你好呀，很高兴认识你！');
  });
});
