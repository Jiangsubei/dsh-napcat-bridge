/**
 * tests/contract/outbound-face-record.test.ts
 *
 * 契约测试: 出站表情/附件自记录消费统一描述符
 *
 * 背景:
 * send_face 只给 NapCat 发 file:/// URI + sub_type，不带 face 元信息；
 * 历史渲染只能得到 [表情包:file:///...]，且 get_msg 回查会用远端名覆盖本地事实。
 *
 * 覆盖规范:
 * 1. sendFace 发送时旁路携带描述符（face.id / face.mood / local path），不塞进消息段；
 * 2. 真实 WS + SQLite 闭环：self=1 记录 content 为 [表情包: face_x (情绪: y)]，attachments 落库；
 * 3. get_msg 回查只补 remote（file_id/url/busid），绝不覆盖 local / face / kind。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import WebSocket from 'ws';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fsp } from 'node:fs';
import { NapCatGatewayServer, type OutboundSentEvent } from '../../src/gateway/server.js';
import { MessageDatabase } from '../../src/storage/database.js';
import { sendFace } from '../../src/tools/index.js';
import {
  buildSelfMessageRecord,
  recordOutboundSelfMessage,
  enrichOutboundMediaRecord,
} from '../../src/outbound/self-record.js';
import { buildOutboundAttachments } from '../../src/attachment/outbound.js';
import { deserializeAttachments } from '../../src/attachment/store.js';
import type { FaceRecord } from '../../src/types/index.js';

const BOT_QQ = '1000000000';
const FRIEND_QQ = '1000000001';
const GROUP_ID = '8000000001';
const SENDER_NAME = '测试助手';

function noopLogger(): any {
  return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
}

function pngBytes(): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(24, 5),
  ]);
}

function faceRecord(filePath: string, overrides: Partial<FaceRecord> = {}): FaceRecord {
  return {
    id: 'face_test_1',
    file_path: filePath,
    md5: 'abcdef0123456789abcdef0123456789',
    added_at: 1793800000000,
    source: 'manual',
    tags: ['猫猫'],
    mood: '嘲讽',
    enabled: true,
    size: 32,
    format: 'png',
    use_count: 0,
    ...overrides,
  };
}

describe('契约测试: sendFace 出站描述符旁路', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-send-face-out-'));
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it('契约 1: 发送表情时旁路携带 face 元信息，消息段保持 NapCat 兼容形态', async () => {
    const localPath = path.join(tmpDir, 'face.png');
    await fsp.writeFile(localPath, pngBytes());
    const face = faceRecord(localPath);

    let capturedMessage: any;
    let capturedAttachments: any;
    const gateway: any = {
      sendGroupMsg: async (_groupId: string, message: any, attachments?: any) => {
        capturedMessage = message;
        capturedAttachments = attachments;
        return { status: 'ok', retcode: 0, data: { message_id: 1001 } };
      },
    };

    const res = await sendFace(
      { face_id: face.id },
      {
        db: {
          getFaceById: () => face,
          updateFaceFilePath: () => {},
          recordFaceUsage: () => {},
        } as any,
        gateway,
        peer: `group_${GROUP_ID}`,
        groupId: GROUP_ID,
        faceSubType: 1,
      }
    );

    expect(res.success).toBe(true);
    expect(capturedMessage).toEqual([
      { type: 'image', data: { file: expect.stringContaining('file:///'), sub_type: 1 } },
    ]);
    expect(capturedAttachments).toBeDefined();
    expect(capturedAttachments).toHaveLength(1);
    expect(capturedAttachments[0].kind).toBe('sticker');
    expect(capturedAttachments[0].face.id).toBe(face.id);
    expect(capturedAttachments[0].face.mood).toBe('嘲讽');
    expect(capturedAttachments[0].local.path).toBe(localPath);
  });
});

describe('契约测试: 出站描述符构造与自记录', () => {
  it('契约 2: 无旁路描述符时从消息段推导（图片 file:/// → 本地路径）', () => {
    const attachments = buildOutboundAttachments(
      [{ type: 'image', data: { file: 'file:///C:/tmp/a.png' } }],
      { peer: `group_${GROUP_ID}` }
    );

    expect(attachments).toHaveLength(1);
    expect(attachments[0].kind).toBe('image');
    expect(attachments[0].origin).toBe('outbound');
    expect(attachments[0].local?.path?.endsWith('a.png')).toBe(true);
    expect(attachments[0].remote?.fileId).toBeUndefined();
  });

  it('契约 3: 有旁路描述符时自记录直接消费，不再反推 file:///', () => {
    const attachments = buildOutboundAttachments([], { peer: `group_${GROUP_ID}` });
    const provided = [
      {
        kind: 'sticker' as const,
        origin: 'outbound' as const,
        local: { path: path.join('/faces', 'face.png'), format: 'png' },
        face: { id: 'face_x', mood: '开心', tags: ['猫猫'] },
      },
    ];
    expect(attachments).toHaveLength(0);

    const record = buildSelfMessageRecord(
      {
        peer: `group_${GROUP_ID}`,
        msgId: 42,
        message: [{ type: 'image', data: { file: 'file:///faces/face.png', sub_type: 1 } }],
        time: 1793800000000,
        attachments: provided,
      },
      { botQQ: BOT_QQ, senderName: SENDER_NAME }
    )!;

    expect(record.type).toBe('sticker');
    expect(record.content).toBe('[表情包: face_x (情绪: 开心) 路径: /faces/face.png]');
    expect(record.local_path?.endsWith('face.png')).toBe(true);
    expect(deserializeAttachments(record.attachments)[0].face?.id).toBe('face_x');
  });
});

describe('契约测试: 出站表情真实 WS + SQLite 闭环', () => {
  let tmpDir: string;
  let db: MessageDatabase;
  let server: NapCatGatewayServer;
  let client: WebSocket;
  let received: Array<Record<string, any>> = [];
  let sentEvents: OutboundSentEvent[] = [];

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-outbound-face-'));
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
        const record = recordOutboundSelfMessage(event, {
          db,
          botQQ: BOT_QQ,
          senderName: SENDER_NAME,
          logger: noopLogger(),
        });
        if (record) {
          void enrichOutboundMediaRecord(server, db, record, noopLogger());
        }
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

  it('契约 4: 真实发送成功后 content 为 face_id + 情绪，attachments 含 face 元信息', async () => {
    const attachments = [
      {
        kind: 'sticker' as const,
        origin: 'outbound' as const,
        local: { path: path.join(tmpDir, 'face.png'), format: 'png' },
        face: { id: 'face_x', mood: '嘲讽', tags: ['猫猫'] },
      },
    ];

    const pending = server.sendGroupMsg(
      GROUP_ID,
      [{ type: 'image', data: { file: 'file:///tmp/face.png', sub_type: 1 } }],
      attachments
    );
    await respondTo('send_group_msg', { message_id: 2026001 });
    await pending;

    const msg = db.getMessage(2026001)!;
    expect(msg.type).toBe('sticker');
    expect(msg.content).toContain('[表情包: face_x (情绪: 嘲讽) 路径:');
    expect(msg.local_path?.endsWith('face.png')).toBe(true);

    const stored = deserializeAttachments(msg.attachments);
    expect(stored).toHaveLength(1);
    expect(stored[0].face?.id).toBe('face_x');
    expect(stored[0].face?.mood).toBe('嘲讽');

    expect(sentEvents).toHaveLength(1);
    expect(sentEvents[0].attachments?.[0].face?.id).toBe('face_x');
  });

  it('契约 5: get_msg 回查只补 remote，不覆盖 local / face / kind', async () => {
    const attachments = [
      {
        kind: 'sticker' as const,
        origin: 'outbound' as const,
        local: { path: path.join(tmpDir, 'face.png'), format: 'png' },
        face: { id: 'face_x', mood: '嘲讽' },
      },
    ];
    const pending = server.sendGroupMsg(
      GROUP_ID,
      [{ type: 'image', data: { file: 'file:///tmp/face.png', sub_type: 1 } }],
      attachments
    );
    await respondTo('send_group_msg', { message_id: 2026002 });
    await pending;

    await respondTo('get_msg', {
      message: [
        {
          type: 'image',
          data: { file: '9E64D1403F9FBA2D5F9CB90289AD23F4.jpg', url: 'https://example.com/x' },
        },
      ],
    });

    let after = db.getMessage(2026002)!;
    for (let i = 0; i < 100 && after.file_id === null; i++) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      after = db.getMessage(2026002)!;
    }

    expect(after.file_id).toBe('9E64D1403F9FBA2D5F9CB90289AD23F4.jpg');
    expect(after.local_path?.endsWith('face.png')).toBe(true);
    expect(after.type).toBe('sticker');
    expect(after.content).toContain('[表情包: face_x (情绪: 嘲讽) 路径:');
    const stored = deserializeAttachments(after.attachments);
    expect(stored[0].face?.id).toBe('face_x');
    expect(stored[0].local?.path?.endsWith('face.png')).toBe(true);
    expect(stored[0].remote?.fileId).toBe('9E64D1403F9FBA2D5F9CB90289AD23F4.jpg');
  });
});
