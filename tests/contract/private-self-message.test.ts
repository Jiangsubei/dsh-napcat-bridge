import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fsp } from 'node:fs';
import Database from 'better-sqlite3';
import WebSocket from 'ws';
import { bootDshNapcatBridge, type BootedDsh } from '../../src/boot.js';
import * as NapCatBridgePlugin from '../../src/index.js';
import { convertOneBotToRecord } from '../../src/gateway/sync.js';
import { readChatHistory } from '../../src/tools/index.js';
import { MessageDatabase } from '../../src/storage/database.js';

const BOT_QQ = '1000000000';
const USER_QQ = '1000000001';
const WS_PORT = 18349;

describe('契约测试: 私聊自身消息 (message_sent) Peer 归属与历史记录查询闭环', () => {
  let tmpHome: string;
  let booted: BootedDsh;
  let client: WebSocket;

  function dbPath(): string {
    return path.join(tmpHome, 'napcat/messages.sqlite');
  }

  beforeEach(async () => {
    tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-napcat-self-msg-'));

    booted = await bootDshNapcatBridge({ dshHome: tmpHome, mountPlugin: false });
    await booted.ctx.plugin(NapCatBridgePlugin, {
      bot_qq: BOT_QQ,
      ws_port: WS_PORT,
      ws_host: '127.0.0.1',
    });

    client = new WebSocket(`ws://127.0.0.1:${WS_PORT}`);
    await new Promise<void>((resolve, reject) => {
      client.once('open', () => resolve());
      client.once('error', (err) => reject(err));
    });
  });

  afterEach(async () => {
    if (client && client.readyState === WebSocket.OPEN) {
      client.close();
    }
    if (booted) {
      await booted.dispose();
    }
    if (tmpHome) {
      await fsp.rm(tmpHome, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('契约 1: 真实装配下私聊出站回执 (message_sent) peer 归档为 user_<target_id>，绝非 user_<bot_qq>', async () => {
    // 1. 用户发来私聊消息
    const userMsgEvent = {
      post_type: 'message',
      message_type: 'private',
      sub_type: 'friend',
      message_id: 10001,
      user_id: Number(USER_QQ),
      self_id: Number(BOT_QQ),
      time: Math.floor(Date.now() / 1000) - 10,
      sender: { user_id: Number(USER_QQ), nickname: '我也要做吗' },
      message: [{ type: 'text', data: { text: '看看最近一小时聊了啥' } }],
      raw_message: '看看最近一小时聊了啥',
    };
    client.send(JSON.stringify(userMsgEvent));

    // 2. 机器人向用户回复私聊消息 (NapCat 回推 message_sent)
    const botSentEvent = {
      post_type: 'message_sent',
      message_type: 'private',
      sub_type: 'friend',
      message_id: 10002,
      user_id: Number(BOT_QQ),
      target_id: Number(USER_QQ),
      self_id: Number(BOT_QQ),
      time: Math.floor(Date.now() / 1000),
      sender: { user_id: Number(BOT_QQ), nickname: '雪梨' },
      message: [{ type: 'text', data: { text: '最近一小时聊了代码和工具' } }],
      raw_message: '最近一小时聊了代码和工具',
    };
    client.send(JSON.stringify(botSentEvent));

    // 等待异步落库
    await new Promise((r) => setTimeout(r, 600));

    const sqlite = new Database(dbPath(), { readonly: true });
    try {
      const rows = sqlite.prepare('SELECT msg_id, peer, user_id, self, content FROM messages ORDER BY msg_id ASC').all() as any[];
      expect(rows).toHaveLength(2);

      // 用户消息: peer 为 user_1000000001, self=0
      expect(rows[0].msg_id).toBe(10001);
      expect(rows[0].peer).toBe(`user_${USER_QQ}`);
      expect(rows[0].self).toBe(0);

      // 机器人自身出站消息: peer 必须同为 user_1000000001, 绝不是 user_1000000000!
      expect(rows[1].msg_id).toBe(10002);
      expect(rows[1].peer).toBe(`user_${USER_QQ}`);
      expect(rows[1].self).toBe(1);

      // 绝对没有任何归属到 user_<bot_qq> 的消息
      const botPeerRows = sqlite.prepare(`SELECT count(*) as count FROM messages WHERE peer = 'user_${BOT_QQ}'`).get() as any;
      expect(botPeerRows.count).toBe(0);
    } finally {
      sqlite.close();
    }
  });

  it('契约 2: 私聊历史记录查询 (read_chat_history) 正常展示完整对话，不被 peer 隔离割裂', async () => {
    // 构造同上事件
    client.send(JSON.stringify({
      post_type: 'message',
      message_type: 'private',
      sub_type: 'friend',
      message_id: 20001,
      user_id: Number(USER_QQ),
      self_id: Number(BOT_QQ),
      time: Math.floor(Date.now() / 1000) - 20,
      sender: { user_id: Number(USER_QQ), nickname: '我也要做吗' },
      message: [{ type: 'text', data: { text: '你好呀' } }],
      raw_message: '你好呀',
    }));

    client.send(JSON.stringify({
      post_type: 'message_sent',
      message_type: 'private',
      sub_type: 'friend',
      message_id: 20002,
      user_id: Number(BOT_QQ),
      target_id: Number(USER_QQ),
      self_id: Number(BOT_QQ),
      time: Math.floor(Date.now() / 1000) - 10,
      sender: { user_id: Number(BOT_QQ), nickname: '雪梨' },
      message: [{ type: 'text', data: { text: '我在呢喵' } }],
      raw_message: '我在呢喵',
    }));

    await new Promise((r) => setTimeout(r, 600));

    const msgDb = new MessageDatabase(dbPath());
    msgDb.init();
    try {
      // 在当前私聊会话中查询历史记录
      const history = await readChatHistory(`user_${USER_QQ}`, {}, msgDb);
      expect(history.total).toBe(2);
      expect(history.messages).toHaveLength(2);

      // 必须包含用户发的消息与机器人发的消息
      const contents = history.messages.map(m => m.content);
      expect(contents).toContain('你好呀');
      expect(contents).toContain('我在呢喵');

      // 且默认包含 self=1 的消息
      const selfMsg = history.messages.find(m => m.msg_id === 20002);
      expect(selfMsg?.self).toBe(true);
    } finally {
      msgDb.close();
    }
  });

  it('契约 3: convertOneBotToRecord 离线同步对私聊自身发出的消息正确归档为 target_id 或指定 targetPeer', () => {
    const offlineSelfMsg = {
      message_id: 30001,
      message_type: 'private',
      user_id: Number(BOT_QQ),
      target_id: Number(USER_QQ),
      time: 1788045820,
      message: [{ type: 'text', data: { text: '离线自身消息测试' } }],
    };

    // 不传 targetPeer 时，依据 isSelf + target_id 正确推导为 user_<target_id>
    const recordAuto = convertOneBotToRecord(offlineSelfMsg, BOT_QQ);
    expect(recordAuto).toBeDefined();
    expect(recordAuto?.peer).toBe(`user_${USER_QQ}`);
    expect(recordAuto?.self).toBe(1);

    // 显式传 targetPeer 时，优先使用 targetPeer
    const recordExplicit = convertOneBotToRecord(offlineSelfMsg, BOT_QQ, `user_${USER_QQ}`);
    expect(recordExplicit).toBeDefined();
    expect(recordExplicit?.peer).toBe(`user_${USER_QQ}`);
    expect(recordExplicit?.self).toBe(1);
  });
});
