/**
 * tests/contract/internal-message-record.test.ts
 *
 * 契约测试: Agent 内部协同通讯落库（source = 'agent'）
 *
 * 需求背景:
 * 内部协同通讯（send_agent_message / create_user_agent 初始使命）此前只进入
 * Agent 上下文，不写 messages 表。上下文压缩后，Agent 无法通过 read_chat_history
 * 找回「谁给我布置过什么 / 我给谁发过什么」。
 *
 * 覆盖规范:
 * 1. 内部通讯以独立身份落库: sender_name='内部通讯'、user_id='agent:<来源SessionID>'、
 *    source='agent'、self=0；
 * 2. 目标会话 + 发送方会话各一份，内容分别标注来源/去向；
 * 3. 空内容 / 非 internal_agent 触发不落库；
 * 4. read_chat_history 新增 source 维度（qq / agent / 缺省全部），返回结果带 source；
 * 5. 存量/普通 QQ 消息 source 缺省为 'qq'；
 * 6. 真实 bootDshNapcatBridge 装配下 dispatchWakeup 落库闭环。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fsp } from 'node:fs';
import { MessageDatabase } from '../../src/storage/database.js';
import { readChatHistory } from '../../src/tools/index.js';
import {
  buildInternalMessageRecords,
  INTERNAL_MESSAGE_SENDER_NAME,
} from '../../src/storage/internal-message.js';
import type { MessageRecord, WakeupPayload } from '../../src/types/index.js';
import { bootDshNapcatBridge, type BootedDsh } from '../../src/boot.js';

const BOT_QQ = '1000000000';
const FRIEND_A = '1000000001';
const FRIEND_B = '1000000002';
const TARGET_PEER = `user_${FRIEND_B}`;
const FROM_SESSION = `qq-user-${FRIEND_A}`;

function internalPayload(overrides: Partial<WakeupPayload> = {}): WakeupPayload {
  return {
    peer: TARGET_PEER,
    trigger: 'internal_agent',
    from_user: FROM_SESSION,
    from_name: '协同 Agent',
    from_session: FROM_SESSION,
    content: '请统计群内近三天的活跃度',
    timestamp: 1793800000000,
    ...overrides,
  };
}

function qqRecord(overrides: Partial<MessageRecord> = {}): MessageRecord {
  return {
    msg_id: 900000001,
    peer: TARGET_PEER,
    user_id: FRIEND_B,
    sender_name: '群友',
    time: 1793800001000,
    type: 'text',
    content: '真实 QQ 消息',
    raw: JSON.stringify([{ type: 'text', data: { text: '真实 QQ 消息' } }]),
    file_id: null,
    busid: null,
    local_path: null,
    fingerprint: null,
    recalled: 0,
    self: 0,
    reply_to: null,
    ...overrides,
  };
}

describe('契约测试: 内部通讯记录构造 (纯函数)', () => {
  it('契约 1: 目标会话记录 → 独立身份 + source=agent + self=0', () => {
    const records = buildInternalMessageRecords(internalPayload());
    expect(records).toHaveLength(2);

    const target = records.find((r) => r.peer === TARGET_PEER)!;
    expect(target).toBeDefined();
    expect(target.sender_name).toBe(INTERNAL_MESSAGE_SENDER_NAME);
    expect(target.sender_name).toBe('内部通讯');
    expect(target.user_id).toBe(`agent:${FROM_SESSION}`);
    expect(target.source).toBe('agent');
    expect(target.self).toBe(0);
    expect(target.type).toBe('text');
    expect(target.content).toContain(FROM_SESSION);
    expect(target.content).toContain('请统计群内近三天的活跃度');
    expect(target.time).toBe(1793800000000);
    expect(Number.isSafeInteger(target.msg_id)).toBe(true);
    expect(target.msg_id).not.toBe(0);
  });

  it('契约 2: 发送方会话记录 → 标注去向，与目标记录 msg_id 不同', () => {
    const records = buildInternalMessageRecords(internalPayload());
    const sender = records.find((r) => r.peer === `user_${FRIEND_A}`)!;
    expect(sender).toBeDefined();
    expect(sender.content).toContain(`发往会话: ${TARGET_PEER}`);
    expect(sender.content).toContain('请统计群内近三天的活跃度');
    expect(sender.user_id).toBe(`agent:${FROM_SESSION}`);
    expect(sender.source).toBe('agent');

    const target = records.find((r) => r.peer === TARGET_PEER)!;
    expect(sender.msg_id).not.toBe(target.msg_id);
  });

  it('契约 3: 无法解析来源会话时只落目标一份，user_id 回退 agent:system', () => {
    const records = buildInternalMessageRecords(
      internalPayload({ from_session: undefined, from_user: 'system', from_name: '' })
    );
    expect(records).toHaveLength(1);
    expect(records[0].peer).toBe(TARGET_PEER);
    expect(records[0].user_id).toBe('agent:system');
    expect(records[0].sender_name).toBe('内部通讯');
  });

  it('契约 4: 来源与目标为同一会话时只落一份', () => {
    const records = buildInternalMessageRecords(
      internalPayload({ from_session: `qq-user-${FRIEND_B}` })
    );
    expect(records).toHaveLength(1);
    expect(records[0].peer).toBe(TARGET_PEER);
  });

  it('契约 5: 空内容或非 internal_agent 触发 → 不落库', () => {
    expect(buildInternalMessageRecords(internalPayload({ content: '   ' }))).toHaveLength(0);
    expect(
      buildInternalMessageRecords(internalPayload({ trigger: 'scheduled' }))
    ).toHaveLength(0);
  });

  it('契约 6: 同一载荷重复构造 msg_id 稳定（幂等基石），记录字段无 undefined', () => {
    const first = buildInternalMessageRecords(internalPayload());
    const second = buildInternalMessageRecords(internalPayload());
    expect(second.map((r) => r.msg_id)).toEqual(first.map((r) => r.msg_id));

    for (const record of first) {
      for (const [key, value] of Object.entries(record)) {
        expect(value, `字段 ${key} 不应为 undefined`).not.toBeUndefined();
      }
    }
  });
});

describe('契约测试: messages 表 source 维度与 read_chat_history 筛选', () => {
  let tmpDir: string;
  let db: MessageDatabase;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-internal-record-'));
    db = new MessageDatabase(path.join(tmpDir, 'messages.sqlite'));
    db.init();
  });

  afterEach(async () => {
    db.close();
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it('契约 7: 内部通讯落库后可按 source=agent 精确筛选', () => {
    const records = buildInternalMessageRecords(internalPayload());
    for (const record of records) db.saveMessageIfNotExists(record);
    db.saveMessage(qqRecord());

    const agentOnly = db.readHistory(TARGET_PEER, { source: 'agent' });
    expect(agentOnly.total).toBe(1);
    expect(agentOnly.messages[0].source).toBe('agent');
    expect(agentOnly.messages[0].sender_name).toBe('内部通讯');

    const qqOnly = db.readHistory(TARGET_PEER, { source: 'qq' });
    expect(qqOnly.total).toBe(1);
    expect(qqOnly.messages[0].source).toBe('qq');
    expect(qqOnly.messages[0].content).toBe('真实 QQ 消息');

    const all = db.readHistory(TARGET_PEER);
    expect(all.total).toBe(2);
  });

  it('契约 8: 可按内部身份 user_id / sender_name 检索', () => {
    for (const record of buildInternalMessageRecords(internalPayload())) {
      db.saveMessageIfNotExists(record);
    }

    const byUser = db.readHistory(TARGET_PEER, { user_id: `agent:${FROM_SESSION}` });
    expect(byUser.total).toBe(1);
    expect(byUser.messages[0].source).toBe('agent');

    const byName = db.readHistory(TARGET_PEER, { sender_name: '内部通讯' });
    expect(byName.total).toBe(1);
  });

  it('契约 9: 未显式给 source 的普通消息默认落为 qq（存量兼容）', () => {
    db.saveMessageIfNotExists(qqRecord({ msg_id: 900000002 }));
    const row = db.readHistory(TARGET_PEER, { source: 'qq' });
    expect(row.total).toBe(1);
    expect(row.messages[0].source).toBe('qq');
  });

  it('契约 10: 重复投递幂等 → 不产生重复行', () => {
    const records = buildInternalMessageRecords(internalPayload());
    for (const record of records) db.saveMessageIfNotExists(record);
    for (const record of records) db.saveMessageIfNotExists(record);

    expect(db.readHistory(TARGET_PEER, { source: 'agent' }).total).toBe(1);
    expect(db.readHistory(`user_${FRIEND_A}`, { source: 'agent' }).total).toBe(1);
  });

  it('契约 12: read_chat_history 缺省只返回真实 QQ 消息；显式 agent/all 才展示内部通讯', async () => {
    for (const record of buildInternalMessageRecords(internalPayload())) {
      db.saveMessageIfNotExists(record);
    }
    db.saveMessage(qqRecord());

    const defaultResult = await readChatHistory(TARGET_PEER, {}, db);
    expect(defaultResult.total).toBe(1);
    expect(defaultResult.messages[0].source).toBe('qq');

    const agentResult = await readChatHistory(TARGET_PEER, { source: 'agent' }, db);
    expect(agentResult.total).toBe(1);
    expect(agentResult.messages[0].source).toBe('agent');

    const allResult = await readChatHistory(TARGET_PEER, { source: 'all' }, db);
    expect(allResult.total).toBe(2);
  });
});

describe('契约测试: 真实装配下的内部通讯落库闭环', () => {
  let tmpHome: string;
  let booted: BootedDsh | undefined;

  async function waitFor<T>(probe: () => T | undefined, timeoutMs = 8000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = probe();
      if (value !== undefined) return value;
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('等待装配就绪超时');
  }

  beforeEach(async () => {
    tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-internal-assembly-'));
    booted = await bootDshNapcatBridge({
      dshHome: tmpHome,
      mountPlugin: true,
      config: {
        bot_qq: BOT_QQ,
        ws_port: 29873,
        ws_token: 'test-mock-token',
      },
    });
  });

  afterEach(async () => {
    if (booted) {
      await booted.dispose().catch(() => {});
      booted = undefined;
    }
    if (tmpHome) {
      await fsp.rm(tmpHome, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('契约 11: 真实 boot 装配下 dispatchWakeup(internal_agent) → 双方历史均出现 source=agent 记录', async () => {
    const sessionManager: any = await waitFor(() => {
      const c: any = booted!.ctx;
      return (c.get?.('napcat-session') || c['napcat-session']) as any;
    });

    await sessionManager.dispatchWakeup(internalPayload());

    const dbPath = path.join(tmpHome, 'napcat', 'messages.sqlite');
    const rawDb = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const rows = rawDb
        .prepare(
          "SELECT peer, user_id, sender_name, source, self, content FROM messages WHERE source = 'agent' ORDER BY peer"
        )
        .all() as any[];

      expect(rows).toHaveLength(2);
      const peers = rows.map((r) => r.peer).sort();
      expect(peers).toEqual([`user_${FRIEND_A}`, TARGET_PEER].sort());
      for (const row of rows) {
        expect(row.user_id).toBe(`agent:${FROM_SESSION}`);
        expect(row.sender_name).toBe('内部通讯');
        expect(row.source).toBe('agent');
        expect(row.self).toBe(0);
      }
      const targetRow = rows.find((r) => r.peer === TARGET_PEER)!;
      expect(targetRow.content).toContain('请统计群内近三天的活跃度');
      const senderRow = rows.find((r) => r.peer === `user_${FRIEND_A}`)!;
      expect(senderRow.content).toContain(`发往会话: ${TARGET_PEER}`);
    } finally {
      rawDb.close();
    }
  });
});
