/**
 * tests/contract/recall-self-content.test.ts
 *
 * 契约测试: 撤回后的内容保留策略
 *
 * 规范:
 * 1. 机器人自身消息撤回 → recalled=1，但原文必须保留（上下文压缩后可回溯）；
 * 2. 他人消息撤回 → 内容替换为「〔已撤回〕」占位；
 * 3. recall_message 工具撤回成功后立即标记本地记录，不依赖 NapCat 自身撤回 notice。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fsp } from 'node:fs';
import { MessageDatabase } from '../../src/storage/database.js';
import { recallMessage } from '../../src/tools/index.js';
import type { MessageRecord } from '../../src/types/index.js';

const PEER = 'user_1000000001';

function record(overrides: Partial<MessageRecord>): MessageRecord {
  return {
    msg_id: 1,
    peer: PEER,
    user_id: '1000000001',
    sender_name: '测试用户',
    time: 1793800000000,
    type: 'text',
    content: '原文',
    raw: JSON.stringify([{ type: 'text', data: { text: '原文' } }]),
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

describe('契约测试: 撤回内容保留策略', () => {
  let tmpDir: string;
  let db: MessageDatabase;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-recall-content-'));
    db = new MessageDatabase(path.join(tmpDir, 'messages.sqlite'));
    db.init();
  });

  afterEach(async () => {
    db.close();
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it('契约 1: 自身消息撤回保留原文，他人消息撤回占位', () => {
    db.saveMessage(record({ msg_id: 101, self: 1, content: '我自己说的话' }));
    db.saveMessage(record({ msg_id: 102, self: 0, content: '别人说的话' }));

    db.markRecalled(101);
    db.markRecalled(102);

    const selfMsg = db.getMessage(101)!;
    expect(selfMsg.recalled).toBe(1);
    expect(selfMsg.content).toBe('我自己说的话');

    const otherMsg = db.getMessage(102)!;
    expect(otherMsg.recalled).toBe(1);
    expect(otherMsg.content).toBe('〔已撤回〕');
  });

  it('契约 2: read_chat_history 仍能读到自身撤回消息的原文（recalled=true）', () => {
    db.saveMessage(record({ msg_id: 201, self: 1, content: '需要保留的原文' }));
    db.markRecalled(201);

    const history = db.readHistory(PEER, { self_only: true });
    expect(history.messages).toHaveLength(1);
    expect(history.messages[0].content).toBe('需要保留的原文');
    expect(history.messages[0].recalled).toBe(true);
  });

  it('契约 3: recall_message 成功后立即标记本地记录（不依赖 notice）', async () => {
    db.saveMessage(record({ msg_id: 301, self: 1, content: '工具撤回的原文' }));

    const gateway: any = {
      deleteMsg: async () => ({ status: 'ok', retcode: 0, data: null }),
    };
    const res = await recallMessage(
      { message_id: 301 },
      { gateway, db, peer: PEER } as any
    );

    expect(res.success).toBe(true);
    const msg = db.getMessage(301)!;
    expect(msg.recalled).toBe(1);
    expect(msg.content).toBe('工具撤回的原文');
  });
});
