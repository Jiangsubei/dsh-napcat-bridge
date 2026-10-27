import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fsp } from 'node:fs';
import { MessageDatabase } from '../../src/storage/database.js';
import type { MessageRecord } from '../../src/types/index.js';

describe('契约测试: 离线消息同步与去重存储契约 (Offline Sync Storage Contract)', () => {
  let tmpDir: string;
  let db: MessageDatabase;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-napcat-sync-db-'));
    const dbFile = path.join(tmpDir, 'test_messages.sqlite');
    db = new MessageDatabase(dbFile);
    db.init();
  });

  afterEach(async () => {
    if (db) db.close();
    if (tmpDir) {
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('契约 1: getLatestMessageTime 能正确返回指定 peer 的最新消息毫秒时间戳与会话隔离', () => {
    expect(db.getLatestMessageTime('group_1001')).toBeNull();

    db.saveMessage({
      msg_id: 1,
      peer: 'group_1001',
      user_id: '100',
      sender_name: '用户A',
      time: 1700000000000,
      type: 'text',
      content: 'hello 1',
      raw: '{}',
      file_id: null,
      busid: null,
      local_path: null,
      fingerprint: null,
      recalled: 0,
      self: 0,
      reply_to: null,
    });

    db.saveMessage({
      msg_id: 2,
      peer: 'group_1001',
      user_id: '101',
      sender_name: '用户B',
      time: 1700000050000,
      type: 'text',
      content: 'hello 2',
      raw: '{}',
      file_id: null,
      busid: null,
      local_path: null,
      fingerprint: null,
      recalled: 0,
      self: 0,
      reply_to: null,
    });

    db.saveMessage({
      msg_id: 3,
      peer: 'user_2002',
      user_id: '2002',
      sender_name: '私聊用户',
      time: 1700000090000,
      type: 'text',
      content: 'private msg',
      raw: '{}',
      file_id: null,
      busid: null,
      local_path: null,
      fingerprint: null,
      recalled: 0,
      self: 0,
      reply_to: null,
    });

    expect(db.getLatestMessageTime('group_1001')).toBe(1700000050000);
    expect(db.getLatestMessageTime('user_2002')).toBe(1700000090000);
    expect(db.getLatestMessageTime('group_9999')).toBeNull();
  });

  it('契约 2: hasMessage 正确判断消息 ID 是否存在', () => {
    expect(db.hasMessage(999)).toBe(false);

    db.saveMessage({
      msg_id: 999,
      peer: 'group_1001',
      user_id: '100',
      sender_name: '用户A',
      time: 1700000000000,
      type: 'text',
      content: 'test',
      raw: '{}',
      file_id: null,
      busid: null,
      local_path: null,
      fingerprint: null,
      recalled: 0,
      self: 0,
      reply_to: null,
    });

    expect(db.hasMessage(999)).toBe(true);
    expect(db.hasMessage(1000)).toBe(false);
  });

  it('契约 3: saveMessageIfNotExists 在新消息时入库并返回 true，已存在时幂等忽略且绝不覆盖已有本地媒体路径', () => {
    const existingRecord: MessageRecord = {
      msg_id: 500,
      peer: 'group_1001',
      user_id: '100',
      sender_name: '用户A',
      time: 1700000000000,
      type: 'image',
      content: '[图片:/local/cache/img1.png]',
      raw: '{"type":"image"}',
      file_id: 'img1.png',
      busid: null,
      local_path: '/local/cache/img1.png',
      fingerprint: 'hash_img_1',
      recalled: 0,
      self: 0,
      reply_to: null,
    };
    db.saveMessage(existingRecord);

    // 离线补全拉到的重复记录（通常没有 local_path）
    const offlineDuplicate: MessageRecord = {
      msg_id: 500,
      peer: 'group_1001',
      user_id: '100',
      sender_name: '用户A',
      time: 1700000000000,
      type: 'image',
      content: '[图片]',
      raw: '{"type":"image"}',
      file_id: 'img1.png',
      busid: null,
      local_path: null,
      fingerprint: null,
      recalled: 0,
      self: 0,
      reply_to: null,
    };

    const inserted = db.saveMessageIfNotExists(offlineDuplicate);
    expect(inserted).toBe(false);

    // 验证已有记录中的 local_path 和 fingerprint 完好保留，没有被冲刷
    const fetched = db.getMessage(500);
    expect(fetched?.local_path).toBe('/local/cache/img1.png');
    expect(fetched?.fingerprint).toBe('hash_img_1');
    expect(fetched?.content).toBe('[图片:/local/cache/img1.png]');

    // 插入全新离线消息
    const offlineNew: MessageRecord = {
      msg_id: 501,
      peer: 'group_1001',
      user_id: '102',
      sender_name: '用户C',
      time: 1700000010000,
      type: 'text',
      content: 'new offline msg',
      raw: '{"type":"text"}',
      file_id: null,
      busid: null,
      local_path: null,
      fingerprint: null,
      recalled: 0,
      self: 0,
      reply_to: null,
    };

    const insertedNew = db.saveMessageIfNotExists(offlineNew);
    expect(insertedNew).toBe(true);
    expect(db.getMessage(501)?.content).toBe('new offline msg');
  });
});
