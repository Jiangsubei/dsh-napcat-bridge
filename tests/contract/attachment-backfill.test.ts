/**
 * tests/contract/attachment-backfill.test.ts
 *
 * 契约测试: 存量消息附件描述符回填
 *
 * 背景:
 * `messages.attachments` 是新增列，历史记录该列一律为 NULL。
 * 用户要求：能回填就回填，不能回填就保持 NULL。
 *
 * 覆盖规范:
 * 1. raw 消息段可解析 → 回填完整描述符（kind / origin / local / remote / face）；
 * 2. raw 不可用但结构化列仍有事实 → 保守合成描述符；
 * 3. 无法确认任何附件事实 → 保持 NULL，绝不编造；
 * 4. 已有 attachments 的记录绝不被覆盖；
 * 5. 回填是一次性迁移，重复 init 幂等。
 */

import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fsp } from 'node:fs';
import { MessageDatabase } from '../../src/storage/database.js';
import { deserializeAttachments } from '../../src/attachment/store.js';
import type { MessageRecord } from '../../src/types/index.js';

const BACKFILL_KEY = 'messages_attachments_backfill_v1';

interface LegacyRowInput {
  msg_id: number;
  peer: string;
  type: string;
  content: string;
  raw: string;
  self?: number;
  file_id?: string | null;
  busid?: number | null;
  local_path?: string | null;
  attachments?: string | null;
}

let tmpDir: string | null = null;
let db: MessageDatabase | null = null;

afterEach(async () => {
  if (db) {
    db.close();
    db = null;
  }
  if (tmpDir) {
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    tmpDir = null;
  }
});

async function setupDatabase(): Promise<string> {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-attachment-backfill-'));
  return path.join(tmpDir, 'messages.sqlite');
}

/** 先建好真实 schema，再写入旧记录（attachments = NULL），最后重新 init 触发回填。 */
async function seedAndReopen(rows: LegacyRowInput[]): Promise<MessageDatabase> {
  const dbPath = await setupDatabase();

  const seed = new MessageDatabase(dbPath);
  seed.init();
  seed.close();

  const raw = new Database(dbPath);
  try {
    // 空库初始化会写入一次性标记，这里删除以模拟「首次升级到本次改动」
    raw.prepare('DELETE FROM plugin_kv WHERE key = ?').run(BACKFILL_KEY);

    const insert = raw.prepare(`
      INSERT INTO messages (
        msg_id, peer, user_id, sender_name, time, type, content, raw,
        file_id, busid, local_path, fingerprint, recalled, self, reply_to, source, attachments
      ) VALUES (
        @msg_id, @peer, '1000000001', '测试成员', 1793800000000, @type, @content, @raw,
        @file_id, @busid, @local_path, NULL, 0, @self, NULL, 'qq', @attachments
      )
    `);

    for (const row of rows) {
      insert.run({
        msg_id: row.msg_id,
        peer: row.peer,
        type: row.type,
        content: row.content,
        raw: row.raw,
        file_id: row.file_id ?? null,
        busid: row.busid ?? null,
        local_path: row.local_path ?? null,
        self: row.self ?? 0,
        attachments: row.attachments ?? null,
      });
    }
  } finally {
    raw.close();
  }

  db = new MessageDatabase(dbPath);
  db.init();
  return db;
}

function attachmentsOf(id: number): any[] {
  const record = db!.getMessage(id) as MessageRecord;
  return deserializeAttachments(record.attachments);
}

describe('契约测试: 存量附件描述符回填', () => {
  it('契约 1: raw 可解析 → 回填入站图片的 kind/origin/local/remote/face', async () => {
    await seedAndReopen([
      {
        msg_id: 1,
        peer: 'group_8000000001',
        type: 'image',
        content: '[图片:/旧路径.jpg]',
        raw: JSON.stringify([
          {
            type: 'image',
            data: {
              file: 'REMOTE_IMAGE.png',
              local_path: '/data/downloads/image/group_1/real.jpg',
              local_format: 'jpg',
              fingerprint: 'fp-legacy-1',
              face: { id: 'face_legacy', mood: '开心', tags: ['猫猫'] },
            },
          },
        ]),
      },
    ]);

    const attachments = attachmentsOf(1);
    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toMatchObject({
      kind: 'image',
      origin: 'inbound',
      remote: { fileId: 'REMOTE_IMAGE.png' },
      local: { path: '/data/downloads/image/group_1/real.jpg', format: 'jpg', fingerprint: 'fp-legacy-1' },
      face: { id: 'face_legacy', mood: '开心', tags: ['猫猫'] },
    });
  });

  it('契约 2: 出站自记录 raw 的 file:/// 转为本地路径，origin=outbound', async () => {
    await seedAndReopen([
      {
        msg_id: 2,
        peer: 'user_1000000002',
        type: 'sticker',
        content: '[表情包:file:///C:/faces/a.png]',
        self: 1,
        raw: JSON.stringify([
          { type: 'image', data: { file: 'file:///C:/faces/a.png', sub_type: 1 } },
        ]),
      },
    ]);

    const attachments = attachmentsOf(2);
    expect(attachments).toHaveLength(1);
    expect(attachments[0].kind).toBe('sticker');
    expect(attachments[0].origin).toBe('outbound');
    expect(attachments[0].local?.path?.endsWith('a.png')).toBe(true);
    expect(attachments[0].local?.path?.startsWith('file:///')).toBe(false);
    expect(attachments[0].remote?.fileId).toBeUndefined();
  });

  it('契约 3: raw 不可用时用结构化列保守合成（群文件 name / file_id / busid）', async () => {
    await seedAndReopen([
      {
        msg_id: 3,
        peer: 'group_8000000001',
        type: 'group_file',
        content: '[群文件:周报.pdf (ID:gf-legacy)]',
        raw: '"[CQ:file,file=周报.pdf]"',
        file_id: 'gf-legacy',
        busid: 102,
        local_path: null,
      },
    ]);

    const attachments = attachmentsOf(3);
    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toMatchObject({
      kind: 'group_file',
      origin: 'inbound',
      fileName: '周报.pdf',
      remote: { fileId: 'gf-legacy', busid: 102 },
    });
    expect(attachments[0].local).toBeUndefined();
  });

  it('契约 4: 无法确认任何附件事实 → 保持 NULL，不编造描述符', async () => {
    await seedAndReopen([
      {
        msg_id: 4,
        peer: 'group_8000000001',
        type: 'text',
        content: '普通文本',
        raw: 'not-json',
      },
      {
        msg_id: 5,
        peer: 'user_1000000002',
        type: 'text',
        content: '普通文本',
        raw: JSON.stringify([{ type: 'text', data: { text: '普通文本' } }]),
      },
      {
        msg_id: 6,
        peer: 'user_1000000002',
        type: 'image',
        content: '[图片:0123456789ABCDEF0123456789ABCDEF.png]',
        raw: 'broken-json',
        file_id: null,
        local_path: null,
      },
    ]);

    for (const id of [4, 5, 6]) {
      expect((db!.getMessage(id) as MessageRecord).attachments).toBeNull();
      expect(attachmentsOf(id)).toEqual([]);
    }
  });

  it('契约 5: 已有 attachments 的记录绝不被覆盖', async () => {
    const existing = JSON.stringify([
      { kind: 'image', origin: 'inbound', local: { path: '/keep/me.png' } },
    ]);

    await seedAndReopen([
      {
        msg_id: 7,
        peer: 'user_1000000002',
        type: 'image',
        content: '已存在描述符',
        raw: JSON.stringify([
          { type: 'image', data: { file: 'SHOULD_NOT_WIN.png', local_path: '/other.png' } },
        ]),
        attachments: existing,
      },
    ]);

    const record = db!.getMessage(7) as MessageRecord;
    expect(record.attachments).toBe(existing);
    expect(attachmentsOf(7)[0].local?.path).toBe('/keep/me.png');
  });

  it('契约 6: 一次性迁移幂等，重复 init 不改变已回填结果', async () => {
    const dbPath = await setupDatabase();
    const seed = new MessageDatabase(dbPath);
    seed.init();
    seed.close();

    const raw = new Database(dbPath);
    raw.prepare('DELETE FROM plugin_kv WHERE key = ?').run(BACKFILL_KEY);
    raw.prepare(`
      INSERT INTO messages (
        msg_id, peer, user_id, sender_name, time, type, content, raw,
        file_id, busid, local_path, fingerprint, recalled, self, reply_to, source, attachments
      ) VALUES (8, 'group_8000000001', '1000000001', '测试成员', 1793800000000, 'image',
        '[图片:/tmp/a.png]', @raw, 'A.png', NULL, '/tmp/a.png', NULL, 0, 0, NULL, 'qq', NULL)
    `).run({
      raw: JSON.stringify([
        { type: 'image', data: { file: 'A.png', local_path: '/tmp/a.png' } },
      ]),
    });
    raw.close();

    db = new MessageDatabase(dbPath);
    db.init();
    const first = (db.getMessage(8) as MessageRecord).attachments;
    expect(first).toBeTruthy();

    db.close();
    db = new MessageDatabase(dbPath);
    db.init();
    expect((db.getMessage(8) as MessageRecord).attachments).toBe(first);
  });
});
