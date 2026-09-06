import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fsp } from 'node:fs';
import Database from 'better-sqlite3';
import WebSocket from 'ws';
import { bootDshNapcatBridge, type BootedDsh } from '../../src/boot.js';
import * as NapCatBridgePlugin from '../../src/index.js';
import * as wakeupModule from '../../src/gateway/wakeup.js';
import { SessionManager } from '../../src/gateway/session.js';

/**
 * 契约测试: 入站贴表情事件落库 (group_msg_emoji_like Contract)
 *
 * 验证规范:
 * 1. 发送 notice_type === 'group_msg_emoji_like' 事件，断言 db.saveMessage 真实入库，记录包含：
 *    - type === 'emoji_like'
 *    - reply_to === targetMsgId
 *    - peer === 'group_<群号>'
 *    - content 包含 likes 汇总内容（如 [表情回应: 点赞(76)x2, 爱心(66)x1]）
 *    - raw 包含完整 JSON 事件
 *    - msg_id 为由 stableNoticeMsgId 生成的正整数
 * 2. 硬性红线：入站贴表情事件绝不作为入站唤醒来源，绝不触发 shouldWakeup，绝不唤醒 Agent (followup 不被调用)。
 * 3. 针对 likes 缺失或空的异常边界，依然安全落库不崩溃，content 为 [表情回应: 无]。
 * 4. 针对非法事件（缺失 group_id 或 message_id）安全忽略不落库。
 */

const BOT_QQ = '1000000001';
const GROUP_ID = 3000000001;
const OPERATOR_QQ = '2000000001';
const WS_PORT = 18342;

function calcStableNoticeMsgId(key: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) || 1;
}

describe('契约测试: 入站贴表情事件落库 (group_msg_emoji_like)', () => {
  let tmpHome: string;
  let booted: BootedDsh;
  let client: WebSocket;
  let capturedFollowups: Array<{ content: string }> = [];
  let agent: any;

  function dbPath(): string {
    return path.join(tmpHome, 'workspace/napcat/messages.sqlite');
  }

  beforeEach(async () => {
    tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-napcat-emoji-like-'));
    capturedFollowups = [];

    booted = await bootDshNapcatBridge({ dshHome: tmpHome, mountPlugin: false });
    await booted.ctx.plugin(NapCatBridgePlugin, {
      bot_qq: BOT_QQ,
      ws_port: WS_PORT,
    });

    const agents: any = booted.ctx.get('agents');
    const handle = await agents.create({
      sessionId: `qq-group-${GROUP_ID}`,
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      meta: { cwd: path.join(tmpHome, 'agent-cwd') },
    });
    agent = handle.agent || handle;
    agent.followup = (msg: any) => {
      const text = Array.isArray(msg?.content)
        ? msg.content.map((c: any) => c?.text || '').join('')
        : String(msg?.content || '');
      capturedFollowups.push({ content: text });
    };

    client = new WebSocket(`ws://127.0.0.1:${WS_PORT}`);
    await new Promise<void>((resolve, reject) => {
      client.once('open', () => resolve());
      client.once('error', reject);
    });
  });

  afterEach(async () => {
    if (client) {
      client.terminate();
    }
    if (booted) {
      await booted.dispose().catch(() => {});
    }
    if (tmpHome) {
      await fsp.rm(tmpHome, { recursive: true, force: true }).catch(() => {});
    }
    vi.restoreAllMocks();
  });

  async function waitForDbRow(replyTo: number, timeoutMs = 2000): Promise<any> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const db = new Database(dbPath(), { readonly: true });
        try {
          const row = db
            .prepare('SELECT * FROM messages WHERE reply_to = ? AND type = ?')
            .get(replyTo, 'emoji_like');
          if (row) return row;
        } finally {
          db.close();
        }
      } catch {
        // 数据库文件可能尚未创建
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`等待 emoji_like 消息记录超时 (reply_to: ${replyTo})`);
  }

  it('契约 1: 发送 group_msg_emoji_like 事件，断言真实落库且包含完整字段与稳定 msg_id', async () => {
    const targetMsgId = 665544;
    const eventTimeSec = 1788045600;
    const eventTimeMs = eventTimeSec * 1000;
    const event = {
      post_type: 'notice',
      notice_type: 'group_msg_emoji_like',
      group_id: GROUP_ID,
      user_id: OPERATOR_QQ,
      message_id: targetMsgId,
      likes: [
        { emoji_id: '76', count: 2 },
        { emoji_id: '66', count: 1 },
      ],
      time: eventTimeSec,
      self_id: BOT_QQ,
    };

    client.send(JSON.stringify(event));

    const row = await waitForDbRow(targetMsgId);
    expect(row).toBeDefined();
    expect(row.type).toBe('emoji_like');
    expect(row.reply_to).toBe(targetMsgId);
    expect(row.peer).toBe(`group_${GROUP_ID}`);
    expect(row.user_id).toBe(OPERATOR_QQ);
    expect(row.sender_name).toBe('');
    expect(row.time).toBe(eventTimeMs);
    expect(row.content).toBe('[表情回应: 点赞(76)x2, 爱心(66)x1]');
    expect(row.raw).toBe(JSON.stringify(event));
    expect(row.file_id).toBeNull();
    expect(row.busid).toBeNull();
    expect(row.local_path).toBeNull();
    expect(row.fingerprint).toBeNull();
    expect(row.recalled).toBe(0);
    expect(row.self).toBe(0);

    const expectedMsgId = calcStableNoticeMsgId(`emoji_like:${GROUP_ID}:${targetMsgId}:${eventTimeMs}`);
    expect(row.msg_id).toBe(expectedMsgId);
    expect(row.msg_id).toBeGreaterThan(0);
    expect(Number.isInteger(row.msg_id)).toBe(true);
  });

  it('契约 2: 入站贴表情事件绝不触发 shouldWakeup，绝不唤醒 Agent (纯后台审计落库)', async () => {
    const shouldWakeupSpy = vi.spyOn(wakeupModule, 'shouldWakeup');
    const dispatchWakeupSpy = vi.spyOn(SessionManager.prototype, 'dispatchWakeup');

    const targetMsgId = 778899;
    const event = {
      post_type: 'notice',
      notice_type: 'group_msg_emoji_like',
      group_id: GROUP_ID,
      operator_id: OPERATOR_QQ,
      message_id: targetMsgId,
      likes: [{ emoji_id: '233', count: 5 }],
      time: Math.floor(Date.now() / 1000),
      self_id: BOT_QQ,
    };

    client.send(JSON.stringify(event));

    // 等待落库完成
    const row = await waitForDbRow(targetMsgId);
    expect(row).toBeDefined();
    expect(row.content).toBe('[表情回应: 笑哭(233)x5]');
    expect(row.user_id).toBe(OPERATOR_QQ); // 验证 operator_id 正常映射到 user_id

    // 等待一小段窗口以确保即使有异步唤醒也无法漏网
    await new Promise((r) => setTimeout(r, 200));

    // 硬性红线断言
    expect(shouldWakeupSpy).not.toHaveBeenCalled();
    expect(dispatchWakeupSpy).not.toHaveBeenCalled();
    expect(capturedFollowups.length).toBe(0);
  });

  it('契约 3: likes 缺失或为空数组的异常边界，依然安全落库不崩溃', async () => {
    // 3.1 空数组 likes: []
    const targetMsgId1 = 112233;
    const eventEmpty = {
      post_type: 'notice',
      notice_type: 'group_msg_emoji_like',
      group_id: GROUP_ID,
      user_id: OPERATOR_QQ,
      message_id: targetMsgId1,
      likes: [],
      time: Math.floor(Date.now() / 1000),
      self_id: BOT_QQ,
    };

    client.send(JSON.stringify(eventEmpty));
    const row1 = await waitForDbRow(targetMsgId1);
    expect(row1).toBeDefined();
    expect(row1.content).toBe('[表情回应: 无]');

    // 3.2 likes 缺失 (undefined)
    const targetMsgId2 = 445566;
    const eventMissing = {
      post_type: 'notice',
      notice_type: 'group_msg_emoji_like',
      group_id: GROUP_ID,
      user_id: OPERATOR_QQ,
      message_id: targetMsgId2,
      time: Math.floor(Date.now() / 1000),
      self_id: BOT_QQ,
    };

    client.send(JSON.stringify(eventMissing));
    const row2 = await waitForDbRow(targetMsgId2);
    expect(row2).toBeDefined();
    expect(row2.content).toBe('[表情回应: 无]');
  });

  it('契约 4: 未知 emoji_id 优雅降级显示 ID 自身，合法解析字符串格式 message_id', async () => {
    const targetMsgId = 998877;
    const event = {
      post_type: 'notice',
      notice_type: 'group_msg_emoji_like',
      group_id: GROUP_ID,
      operator_id: OPERATOR_QQ,
      message_id: String(targetMsgId), // 传入字符串类型 message_id
      likes: [{ emoji_id: '99999', count: 3 }], // 未知 emoji
      time: Math.floor(Date.now() / 1000),
      self_id: BOT_QQ,
    };

    client.send(JSON.stringify(event));
    const row = await waitForDbRow(targetMsgId);
    expect(row).toBeDefined();
    expect(row.reply_to).toBe(targetMsgId);
    expect(row.content).toBe('[表情回应: 99999x3]');
  });

  it('契约 5: 缺失 group_id 或 message_id 时安全忽略不落库', async () => {
    const invalidEvent1 = {
      post_type: 'notice',
      notice_type: 'group_msg_emoji_like',
      // group_id 缺失
      message_id: 12345,
      likes: [{ emoji_id: '76', count: 1 }],
      time: Math.floor(Date.now() / 1000),
    };
    const invalidEvent2 = {
      post_type: 'notice',
      notice_type: 'group_msg_emoji_like',
      group_id: GROUP_ID,
      // message_id 缺失
      likes: [{ emoji_id: '76', count: 1 }],
      time: Math.floor(Date.now() / 1000),
    };

    client.send(JSON.stringify(invalidEvent1));
    client.send(JSON.stringify(invalidEvent2));

    await new Promise((r) => setTimeout(r, 200));

    const db = new Database(dbPath(), { readonly: true });
    try {
      const rows = db.prepare('SELECT * FROM messages WHERE type = ?').all('emoji_like');
      expect(rows.length).toBe(0);
    } finally {
      db.close();
    }
  });
});
