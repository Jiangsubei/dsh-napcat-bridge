/**
 * tests/contract/outbound-self-record.test.ts
 *
 * 契约测试: 出站消息自身落库 (不依赖 OneBot reportSelfMessage 上报)
 *
 * 缺陷背景:
 * 插件此前完全依赖 NapCat 的 message_sent 上报来写入 self = 1 记录。
 * 一旦对端 reportSelfMessage 关闭，Bot 发出的消息在 QQ 端可见但本地历史静默丢失。
 *
 * 覆盖规范:
 * 1. 出站发送成功（retcode/status 成功且有 message_id）立即落库，self = 1；
 * 2. 发送失败绝不落库；
 * 3. group / private / send_msg 三种出站 action 的 peer 解析正确；
 * 4. 消息段归一化 (文本 / 引用 / @ / 图片 / 表情包) 与类型推导；
 * 5. 真实 WS 网关 + 真实 SQLite 的端到端闭环（非自造桩）。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import WebSocket from 'ws';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fsp } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { NapCatGatewayServer, type OutboundSentEvent } from '../../src/gateway/server.js';
import { MessageDatabase } from '../../src/storage/database.js';
import { bootDshNapcatBridge, type BootedDsh } from '../../src/boot.js';
import {
  buildSelfMessageRecord,
  recordOutboundSelfMessage,
} from '../../src/outbound/self-record.js';

const BOT_QQ = '1000000000';
const FRIEND_QQ = '1000000001';
const GROUP_ID = '8000000001';
const SENDER_NAME = '测试助手';

function noopLogger(): any {
  return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
}

describe('契约测试: 出站消息自身记录 (纯函数)', () => {
  const base = {
    botQQ: BOT_QQ,
    senderName: SENDER_NAME,
  };

  it('契约 1: 纯文本出站 → self=1、peer/msg_id/content 正确', () => {
    const record = buildSelfMessageRecord(
      { peer: `group_${GROUP_ID}`, msgId: -123456789, message: '你好呀', time: 1793800000000 },
      base
    );

    expect(record).not.toBeNull();
    expect(record!.msg_id).toBe(-123456789);
    expect(record!.peer).toBe(`group_${GROUP_ID}`);
    expect(record!.user_id).toBe(BOT_QQ);
    expect(record!.sender_name).toBe(SENDER_NAME);
    expect(record!.self).toBe(1);
    expect(record!.recalled).toBe(0);
    expect(record!.type).toBe('text');
    expect(record!.content).toBe('你好呀');
    expect(record!.reply_to).toBeNull();
    expect(JSON.parse(record!.raw)).toEqual([{ type: 'text', data: { text: '你好呀' } }]);
  });

  it('契约 2: 带引用与艾特的出站段 → reply_to 保留、类型为 reply', () => {
    const record = buildSelfMessageRecord(
      {
        peer: `group_${GROUP_ID}`,
        msgId: 987654321,
        message: [
          { type: 'reply', data: { id: 112233 } },
          { type: 'at', data: { qq: FRIEND_QQ } },
          { type: 'text', data: { text: ' 收到' } },
        ],
        time: 1793800001000,
      },
      base
    );

    expect(record).not.toBeNull();
    expect(record!.reply_to).toBe(112233);
    expect(record!.type).toBe('reply');
    expect(record!.content).toContain(`@${FRIEND_QQ}`);
    expect(record!.content).toContain('收到');
  });

  it('契约 3: 图片与表情包段 → 类型推导为 image / sticker', () => {
    const image = buildSelfMessageRecord(
      {
        peer: `user_${FRIEND_QQ}`,
        msgId: 1,
        message: [{ type: 'image', data: { file: 'file:///tmp/a.png' } }],
        time: 1793800002000,
      },
      base
    );
    expect(image!.type).toBe('image');
    expect(image!.content).toContain('[图片:');

    const sticker = buildSelfMessageRecord(
      {
        peer: `user_${FRIEND_QQ}`,
        msgId: 2,
        message: [{ type: 'image', data: { file: 'file:///tmp/b.png', sub_type: 1 } }],
        time: 1793800003000,
      },
      base
    );
    expect(sticker!.type).toBe('sticker');
  });

  it('契约 4: 空内容不产生记录（避免写入无意义行）', () => {
    expect(
      buildSelfMessageRecord(
        { peer: `user_${FRIEND_QQ}`, msgId: 3, message: '', time: 1793800004000 },
        base
      )
    ).toBeNull();
    expect(
      buildSelfMessageRecord(
        { peer: `user_${FRIEND_QQ}`, msgId: 4, message: [], time: 1793800005000 },
        base
      )
    ).toBeNull();
  });

  it('契约 5: 记录字段完整且不含 undefined', () => {
    const record = buildSelfMessageRecord(
      { peer: `user_${FRIEND_QQ}`, msgId: 5, message: 'x', time: 1793800006000 },
      base
    );
    for (const [key, value] of Object.entries(record!)) {
      expect(value, `字段 ${key} 不应为 undefined`).not.toBeUndefined();
    }
  });

  it('契约 6: 群聊文件出站 → 类型 group_file、内容为群文件占位；私聊文件为 file', () => {
    const groupFile = buildSelfMessageRecord(
      {
        peer: `group_${GROUP_ID}`,
        msgId: 6,
        message: [{ type: 'file', data: { file: 'report.pdf' } }],
        time: 1793800007000,
      },
      base
    );
    expect(groupFile!.type).toBe('group_file');
    expect(groupFile!.content).toContain('[群文件:report.pdf]');

    const privateFile = buildSelfMessageRecord(
      {
        peer: `user_${FRIEND_QQ}`,
        msgId: 7,
        message: [{ type: 'file', data: { file: 'report.pdf' } }],
        time: 1793800008000,
      },
      base
    );
    expect(privateFile!.type).toBe('file');
    expect(privateFile!.content).toContain('[文件:report.pdf]');
  });
});

describe('契约测试: 出站消息自身落库 (真实 WS 网关 + SQLite 闭环)', () => {
  let tmpDir: string;
  let db: MessageDatabase;
  let server: NapCatGatewayServer;
  let client: WebSocket;
  let received: Array<Record<string, any>> = [];
  let sentEvents: OutboundSentEvent[] = [];

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-outbound-self-'));
    db = new MessageDatabase(path.join(tmpDir, 'messages.sqlite'));
    db.init();

    received = [];
    sentEvents = [];
    server = new NapCatGatewayServer({
      port: 0,
      token: 'test-mock-token',
      logger: noopLogger(),
      onMessageSent: (event) => {
        sentEvents.push(event);
        recordOutboundSelfMessage(event, {
          db,
          botQQ: BOT_QQ,
          senderName: SENDER_NAME,
          logger: noopLogger(),
        });
      },
    });
    await server.start();
    const addr: any = (server as any).wss.address();
    client = new WebSocket(`ws://127.0.0.1:${addr.port}?access_token=test-mock-token`);
    await new Promise<void>((resolve, reject) => {
      client.once('open', () => resolve());
      client.once('error', reject);
    });
    client.on('message', (data) => {
      received.push(JSON.parse(data.toString()));
    });
  });

  afterEach(async () => {
    if (client) client.terminate();
    await server.stop().catch(() => {});
    db.close();
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  async function respondTo(action: string, data: any): Promise<Record<string, any>> {
    let pending: Record<string, any> | undefined;
    for (let i = 0; i < 100 && !pending; i++) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      pending = received.find((r) => r.action === action);
    }
    if (!pending) throw new Error(`未收到 action: ${action}, received=${JSON.stringify(received)}`);
    client.send(JSON.stringify({ echo: pending.echo, status: 'ok', retcode: 0, data }));
    return pending;
  }

  it('端到端 1: 群聊发送成功 → 自身消息写入本地历史 (无需 message_sent 上报)', async () => {
    const pending = server.sendGroupMsg(GROUP_ID, '群里的自发言');
    await respondTo('send_group_msg', { message_id: -987654 });
    await pending;

    const history = db.readHistory(`group_${GROUP_ID}`, { self_only: true });
    expect(history.messages).toHaveLength(1);
    const msg = history.messages[0];
    expect(msg.msg_id).toBe(-987654);
    expect(msg.self).toBe(true);
    expect(msg.user_id).toBe(BOT_QQ);
    expect(msg.sender_name).toBe(SENDER_NAME);
    expect(msg.content).toBe('群里的自发言');
    expect(sentEvents).toHaveLength(1);
    expect(sentEvents[0].peer).toBe(`group_${GROUP_ID}`);
  });

  it('端到端 2: 私聊发送成功 → 落库到对应用户会话', async () => {
    const pending = server.sendPrivateMsg(FRIEND_QQ, [{ type: 'text', data: { text: '私聊自发言' } }]);
    await respondTo('send_private_msg', { message_id: 123456 });
    await pending;

    const history = db.readHistory(`user_${FRIEND_QQ}`, { self_only: true });
    expect(history.messages).toHaveLength(1);
    expect(history.messages[0].user_id).toBe(BOT_QQ);
    expect(history.messages[0].content).toBe('私聊自发言');
  });

  it('端到端 3: 发送失败 (retcode ≠ 0) → 绝不落库', async () => {
    const pending = server.sendGroupMsg(GROUP_ID, '失败消息');
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    const req = received.find((r) => r.action === 'send_group_msg')!;
    client.send(
      JSON.stringify({ echo: req.echo, status: 'failed', retcode: 100, data: null, message: '风控' })
    );
    const res = await pending;
    expect(res.retcode).toBe(100);

    const history = db.readHistory(`group_${GROUP_ID}`, { self_only: true });
    expect(history.messages).toHaveLength(0);
    expect(sentEvents).toHaveLength(0);
  });

  it('端到端 4: 缺 message_id 的成功应答 → 不落库 (无主键可用)', async () => {
    const pending = server.sendGroupMsg(GROUP_ID, '无 IDF');
    await respondTo('send_group_msg', {});
    await pending;

    expect(db.readHistory(`group_${GROUP_ID}`, { self_only: true }).messages).toHaveLength(0);
    expect(sentEvents).toHaveLength(0);
  });

  it('端到端 5: send_msg 通用 action → 按 group_id 正确解析 peer', async () => {
    const pending = server.sendAction('send_msg', {
      message_type: 'group',
      group_id: Number(GROUP_ID),
      message: '通用发送',
    });
    await respondTo('send_msg', { message_id: 555666 });
    await pending;

    const history = db.readHistory(`group_${GROUP_ID}`, { self_only: true });
    expect(history.messages).toHaveLength(1);
    expect(history.messages[0].content).toBe('通用发送');
  });

  it('端到端 6: 重复上报幂等 → 记录不重复、不覆盖', async () => {
    const pending = server.sendGroupMsg(GROUP_ID, '幂等消息');
    await respondTo('send_group_msg', { message_id: 777888 });
    await pending;

    // 模拟后续收到 message_sent 回显（reportSelfMessage 开启后的场景）
    const inserted = db.saveMessageIfNotExists({
      ...buildSelfMessageRecord(
        { peer: `group_${GROUP_ID}`, msgId: 777888, message: '幂等消息', time: Date.now() },
        { botQQ: BOT_QQ, senderName: SENDER_NAME }
      )!,
      content: '回显内容',
    });
    expect(inserted).toBe(false);

    const history = db.readHistory(`group_${GROUP_ID}`, { self_only: true });
    expect(history.messages).toHaveLength(1);
    expect(history.messages[0].content).toBe('幂等消息');
  });
});

describe('契约测试: 出站自身落库在真实装配下闭环 (bootDshNapcatBridge)', () => {
  const WS_PORT = 29871;
  const WS_TOKEN = 'test-mock-token';
  const ASSEMBLY_SENDER = '装配助手';

  let tmpHome: string;
  let booted: BootedDsh | undefined;
  let gateway: NapCatGatewayServer;
  let client: WebSocket | undefined;

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
    tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-outbound-assembly-'));
    booted = await bootDshNapcatBridge({
      dshHome: tmpHome,
      mountPlugin: true,
      config: {
        bot_qq: BOT_QQ,
        ws_port: WS_PORT,
        ws_token: WS_TOKEN,
        aliases: [ASSEMBLY_SENDER],
      },
    });

    gateway = await waitFor(() => {
      const c: any = booted!.ctx;
      return (c.get?.('napcat-gateway') || c['napcat-gateway']) as NapCatGatewayServer | undefined;
    });
  });

  afterEach(async () => {
    if (client) {
      client.terminate();
      client = undefined;
    }
    if (booted) {
      await booted.dispose().catch(() => {});
      booted = undefined;
    }
    if (tmpHome) {
      await fsp.rm(tmpHome, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('装配 1: 真实 boot 挂载后网关必须已接线 onMessageSent 落库回调', () => {
    expect(gateway).toBeInstanceOf(NapCatGatewayServer);
    expect(typeof gateway.options.onMessageSent).toBe('function');
  });

  it('装配 2: 真实 boot + 真实 WS 客户端发送成功 → 插件数据库出现 self=1 记录', async () => {
    client = new WebSocket(`ws://127.0.0.1:${WS_PORT}?access_token=${WS_TOKEN}`);
    await new Promise<void>((resolve, reject) => {
      client!.once('open', () => resolve());
      client!.once('error', reject);
    });

    let pendingRequest: Record<string, any> | undefined;
    client.on('message', (data) => {
      const payload = JSON.parse(data.toString());
      if (payload.action === 'send_group_msg' && payload.echo) {
        pendingRequest = payload;
        client!.send(
          JSON.stringify({
            echo: payload.echo,
            status: 'ok',
            retcode: 0,
            data: { message_id: -424242 },
          })
        );
      }
    });

    await gateway.sendGroupMsg(GROUP_ID, '装配闭环自发言');
    expect(pendingRequest).toBeDefined();

    // 插件自身持有的数据库文件（真实落盘位置）
    const dbPath = path.join(tmpHome, 'napcat', 'messages.sqlite');
    const rawDb = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const row = rawDb
        .prepare(
          'SELECT msg_id, peer, user_id, sender_name, content, self, type FROM messages WHERE msg_id = ?'
        )
        .get(-424242) as any;

      expect(row).toBeDefined();
      expect(row.self).toBe(1);
      expect(row.peer).toBe(`group_${GROUP_ID}`);
      expect(row.user_id).toBe(BOT_QQ);
      expect(row.sender_name).toBe(ASSEMBLY_SENDER);
      expect(row.content).toBe('装配闭环自发言');
      expect(row.type).toBe('text');
    } finally {
      rawDb.close();
    }
  });
});
