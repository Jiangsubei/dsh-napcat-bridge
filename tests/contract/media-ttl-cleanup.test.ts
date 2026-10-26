import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { MediaStorageManager, cleanExpiredMedia, startMediaCleanupTask } from '../../src/storage/media.js';
import { MessageDatabase } from '../../src/storage/database.js';

describe('契约测试: 入站媒体 TTL 清理与去重活跃续期 (Media TTL Cleanup Contract)', () => {
  let tmpDir: string;
  let dbPath: string;
  let db: MessageDatabase;
  let mediaManager: MediaStorageManager;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-media-ttl-test-'));
    dbPath = path.join(tmpDir, 'test-msg.db');
    db = new MessageDatabase(dbPath);
    mediaManager = new MediaStorageManager({
      downloadDir: tmpDir,
      db,
      ttlDays: 7,
    });
  });

  afterEach(async () => {
    try {
      db.close();
    } catch {}
    if (tmpDir && fs.existsSync(tmpDir)) {
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('契约 1: 一级去重命中时自动刷新文件 mtime，实现 TTL 活跃续期', async () => {
    const pngBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02]);
    const fileId = 'file_dedup_l1_test';

    // 1. 初次保存落盘
    const res1 = await mediaManager.saveBuffer(pngBuffer, { fileId, type: 'image' });
    expect(res1.deduplicated).toBe(false);
    expect(fs.existsSync(res1.localPath)).toBe(true);

    // 数据库存入带该 fileId 与 localPath 的消息记录
    db.saveMessage({
      msg_id: 1001,
      peer: 'peer_1',
      user_id: '12345',
      sender_name: 'test',
      time: Math.floor(Date.now() / 1000),
      type: 'image',
      content: '[图片]',
      raw: {},
      file_id: fileId,
      local_path: res1.localPath,
      fingerprint: res1.fingerprint,
    });

    // 2. 将文件的 mtime 回拨到 5 天前 (仍在 7 天 TTL 内，但已老化)
    const fiveDaysAgoSec = (Date.now() - 5 * 24 * 3600 * 1000) / 1000;
    await fsp.utimes(res1.localPath, fiveDaysAgoSec, fiveDaysAgoSec);
    const statBefore = await fsp.stat(res1.localPath);
    expect(Math.abs(statBefore.mtimeMs - (Date.now() - 5 * 24 * 3600 * 1000))).toBeLessThan(5000);

    // 3. 再次保存相同 fileId（触发一级去重）
    const beforeSaveNow = Date.now();
    const res2 = await mediaManager.saveBuffer(pngBuffer, { fileId, type: 'image' });
    expect(res2.deduplicated).toBe(true);
    expect(res2.level).toBe(1);
    expect(res2.localPath).toBe(res1.localPath);

    // 4. 断言：mtime 必须被刷新到当前时间附近（刷新成功）
    const statAfter = await fsp.stat(res1.localPath);
    expect(statAfter.mtimeMs).toBeGreaterThanOrEqual(beforeSaveNow - 1000);
  });

  it('契约 2: 二级指纹去重命中时自动刷新文件 mtime，实现 TTL 活跃续期', async () => {
    const pngBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x09, 0x08]);

    // 1. 初次保存（不传 fileId）
    const res1 = await mediaManager.saveBuffer(pngBuffer, { type: 'image' });
    expect(res1.deduplicated).toBe(false);

    // 数据库存入该 fingerprint 的记录
    db.saveMessage({
      msg_id: 2001,
      peer: 'peer_2',
      user_id: '12345',
      sender_name: 'test',
      time: Math.floor(Date.now() / 1000),
      type: 'image',
      content: '[图片]',
      raw: {},
      file_id: 'origin_fid',
      local_path: res1.localPath,
      fingerprint: res1.fingerprint,
    });

    // 2. 将文件的 mtime 回拨到 6 天前
    const sixDaysAgoSec = (Date.now() - 6 * 24 * 3600 * 1000) / 1000;
    await fsp.utimes(res1.localPath, sixDaysAgoSec, sixDaysAgoSec);

    // 3. 再次保存相同字节内容（无相同 fileId，触发 SHA-256 二级去重）
    const beforeSaveNow = Date.now();
    const res2 = await mediaManager.saveBuffer(pngBuffer, { fileId: 'different_fid_2', type: 'image' });
    expect(res2.deduplicated).toBe(true);
    expect(res2.level).toBe(2);
    expect(res2.localPath).toBe(res1.localPath);

    // 4. 断言：mtime 必须被刷新到当前时间附近（刷新成功）
    const statAfter = await fsp.stat(res1.localPath);
    expect(statAfter.mtimeMs).toBeGreaterThanOrEqual(beforeSaveNow - 1000);
  });

  it('契约 3: cleanExpiredMedia 正确按 mtime 与 ttlDays 清理超期文件并更新数据库', async () => {
    const targetDir = path.join(tmpDir, 'image');
    await fsp.mkdir(targetDir, { recursive: true });

    const expiredFile = path.join(targetDir, 'expired.png');
    const freshFile = path.join(targetDir, 'fresh.png');
    await fsp.writeFile(expiredFile, 'expired-data');
    await fsp.writeFile(freshFile, 'fresh-data');

    // 记录到数据库
    db.saveMessage({
      msg_id: 3001,
      peer: 'peer_3',
      user_id: '12345',
      sender_name: 'test',
      time: Math.floor(Date.now() / 1000),
      type: 'image',
      content: '[图片]',
      raw: {},
      file_id: 'fid_expired',
      local_path: expiredFile,
      fingerprint: 'hash_expired',
    });
    db.saveMessage({
      msg_id: 3002,
      peer: 'peer_3',
      user_id: '12345',
      sender_name: 'test',
      time: Math.floor(Date.now() / 1000),
      type: 'image',
      content: '[图片]',
      raw: {},
      file_id: 'fid_fresh',
      local_path: freshFile,
      fingerprint: 'hash_fresh',
    });

    // expiredFile 设为 8 天前 (超过 7 天 TTL)
    const eightDaysAgoSec = (Date.now() - 8 * 24 * 3600 * 1000) / 1000;
    await fsp.utimes(expiredFile, eightDaysAgoSec, eightDaysAgoSec);

    // freshFile 设为 2 天前
    const twoDaysAgoSec = (Date.now() - 2 * 24 * 3600 * 1000) / 1000;
    await fsp.utimes(freshFile, twoDaysAgoSec, twoDaysAgoSec);

    // 执行清理
    const result = await cleanExpiredMedia(tmpDir, 7, db);
    expect(result.deletedFiles).toBe(1);
    expect(fs.existsSync(expiredFile)).toBe(false);
    expect(fs.existsSync(freshFile)).toBe(true);

    // 校验数据库记录中的 local_path 已被清理
    const expiredRecord = db.getByFileId('fid_expired');
    expect(expiredRecord?.local_path).toBeFalsy();
    const freshRecord = db.getByFileId('fid_fresh');
    expect(freshRecord?.local_path).toBe(freshFile);
  });

  it('契约 4: startMediaCleanupTask 支持启动初期延迟执行首轮清理并支持生命周期清理', async () => {
    let cleanCalled = 0;
    const mockManager = {
      cleanExpired: async () => {
        cleanCalled++;
        return { deletedFiles: 0, freedBytes: 0 };
      },
    } as any;

    const disposedCallbacks: Array<() => void> = [];
    const mockCtx = {
      logger: { error: vi.fn() },
      on: (event: string, cb: () => void) => {
        if (event === 'dispose') {
          disposedCallbacks.push(cb);
        }
      },
    };

    // 传入 20ms 的 initialDelayMs
    const stop = startMediaCleanupTask(mockCtx, mockManager, 60000, 20);
    expect(cleanCalled).toBe(0);

    // 等待 60ms，首轮清理应当被触发
    await new Promise((r) => setTimeout(r, 60));
    expect(cleanCalled).toBe(1);

    // 触发销毁
    stop();
  });
});
