/**
 * tests/contract/face-storage.test.ts
 * 契约测试: 本地表情库 SQLite 存储、去重、配额淘汰与 7 天后悔期软删除
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { MessageDatabase } from '../../src/storage/database.js';
import type { FaceRecord, FaceQueryOptions } from '../../src/types/index.js';

describe('契约测试: 本地表情库 SQLite 存储与资产管理 (Face Storage Contract)', () => {
  let tmpDir: string;
  let dbPath: string;
  let db: MessageDatabase;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-face-db-'));
    dbPath = path.join(tmpDir, 'messages.sqlite');
    db = new MessageDatabase(dbPath);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('契约 1: faces 表结构初始化与基础插入', () => {
    const face = db.insertFace({
      id: 'face_1',
      file_path: '/path/to/cat.png',
      md5: 'md5_cat_1',
      source: 'manual',
      tags: ['猫', '卖萌'],
      mood: '卖萌',
      enabled: true,
      size: 10240,
      format: 'png',
    });

    expect(face).toBeDefined();
    expect(face.id).toBe('face_1');
    expect(face.md5).toBe('md5_cat_1');
    expect(face.tags).toEqual(['猫', '卖萌']);
    expect(face.use_count).toBe(0);
    expect(face.deleted_at).toBeNull();

    const retrieved = db.getFaceById('face_1');
    expect(retrieved).toBeDefined();
    expect(retrieved?.id).toBe('face_1');
    expect(retrieved?.file_path).toBe('/path/to/cat.png');
  });

  it('契约 2: MD5 唯一性去重与标签增量合并', () => {
    // 首次入库
    const first = db.insertFace({
      id: 'face_first',
      file_path: '/path/to/panda.jpg',
      md5: 'md5_panda',
      source: 'curate',
      tags: ['熊猫头'],
      mood: '嘲讽',
      enabled: true,
      size: 20480,
      format: 'jpg',
    });
    expect(first.id).toBe('face_first');

    // 再次入库相同 MD5
    const duplicate = db.insertFace({
      id: 'face_second',
      file_path: '/another/path/panda_copy.jpg',
      md5: 'md5_panda',
      source: 'collect',
      tags: ['问号', '熊猫头'],
      mood: '疑惑',
      enabled: true,
      size: 20480,
      format: 'jpg',
    });

    // 应该复用已有记录，不生成重复记录
    expect(duplicate.id).toBe('face_first');
    expect(duplicate.duplicated).toBe(true);
    // 标签应合并去重
    expect(duplicate.tags).toEqual(expect.arrayContaining(['熊猫头', '问号']));

    // 表中总记录数仍然只有 1 条
    const all = db.queryFaces({});
    expect(all.total).toBe(1);
  });

  it('契约 3: 容量配额门控 (reject 策略)', () => {
    // 设置配额上限为 2
    const maxFaces = 2;

    db.insertFace({
      id: 'face_a',
      file_path: '/a.png',
      md5: 'md5_a',
      source: 'curate',
      tags: ['A'],
      enabled: true,
      size: 100,
      format: 'png',
    }, { max: maxFaces, evictPolicy: 'reject' });

    db.insertFace({
      id: 'face_b',
      file_path: '/b.png',
      md5: 'md5_b',
      source: 'curate',
      tags: ['B'],
      enabled: true,
      size: 100,
      format: 'png',
    }, { max: maxFaces, evictPolicy: 'reject' });

    // 第 3 张应被 reject 拒绝新增
    expect(() => {
      db.insertFace({
        id: 'face_c',
        file_path: '/c.png',
        md5: 'md5_c',
        source: 'curate',
        tags: ['C'],
        enabled: true,
        size: 100,
        format: 'png',
      }, { max: maxFaces, evictPolicy: 'reject' });
    }).toThrow(/配额/);

    expect(db.queryFaces({}).total).toBe(2);
  });

  it('契约 4: 容量配额门控 (evict_lru 策略与保护 manual 表情)', () => {
    const maxFaces = 2;

    // A 是人工导入的表情 (manual)
    db.insertFace({
      id: 'face_manual',
      file_path: '/manual.png',
      md5: 'md5_manual',
      source: 'manual',
      tags: ['人工'],
      enabled: true,
      size: 100,
      format: 'png',
    }, { max: maxFaces });

    // B 是自动整理的表情 (curate)
    db.insertFace({
      id: 'face_curate',
      file_path: '/curate.png',
      md5: 'md5_curate',
      source: 'curate',
      tags: ['自动'],
      enabled: true,
      size: 100,
      format: 'png',
    }, { max: maxFaces });

    // 模拟 B 被使用过一次，A 没被使用过；但是 A 是 manual 不能删
    db.recordFaceUsage('face_curate');

    // 插入 C 时超出配额，触发 evict_lru，应淘汰非 manual 中最旧的（即使 manual 没被用过）
    const insertedC = db.insertFace({
      id: 'face_c',
      file_path: '/c.png',
      md5: 'md5_c',
      source: 'collect',
      tags: ['偷图'],
      enabled: true,
      size: 100,
      format: 'png',
    }, { max: maxFaces, evictPolicy: 'evict_lru' });

    expect(insertedC.id).toBe('face_c');

    // 活跃表情总数保持在 2
    const activeFaces = db.queryFaces({});
    expect(activeFaces.total).toBe(2);
    expect(activeFaces.faces.map(f => f.id)).toContain('face_manual');
    expect(activeFaces.faces.map(f => f.id)).toContain('face_c');
    expect(activeFaces.faces.map(f => f.id)).not.toContain('face_curate');

    // 被淘汰的 face_curate 进入 7 天后悔期（soft deleted）
    const evicted = db.getFaceById('face_curate', { includeDeleted: true });
    expect(evicted?.deleted_at).not.toBeNull();
  });

  it('契约 5: 软删除、7 天后悔期与复原', () => {
    db.insertFace({
      id: 'face_delete_me',
      file_path: '/del.png',
      md5: 'md5_del',
      source: 'collect',
      tags: ['待删'],
      enabled: true,
      size: 100,
      format: 'png',
    });

    // 1. 软删除
    const delRes = db.deleteFace('face_delete_me');
    expect(delRes).toBe(true);

    // 正常检索不再出现
    const listAfterDel = db.queryFaces({});
    expect(listAfterDel.total).toBe(0);

    // 2. 7 天后悔期内被重新收藏同张图（MD5 命中已删除的记录）→ 自动复原激活
    const restored = db.insertFace({
      id: 'face_new_attempt',
      file_path: '/del_again.png',
      md5: 'md5_del',
      source: 'collect',
      tags: ['复原标签'],
      enabled: true,
      size: 100,
      format: 'png',
    });

    expect(restored.id).toBe('face_delete_me');
    expect(restored.restored).toBe(true);
    expect(restored.deleted_at).toBeNull();
    expect(restored.enabled).toBe(true);

    // 3. 物理清理过期记录（7 天以上未捞回的）
    // 手工模拟置为 8 天前删除
    const eightDaysAgo = Date.now() - 8 * 24 * 3600 * 1000;
    db.deleteFace('face_delete_me');
    (db as any).db.prepare('UPDATE faces SET deleted_at = ? WHERE id = ?').run(eightDaysAgo, 'face_delete_me');

    // 执行 purge
    const purged = db.purgeExpiredFaces(7);
    expect(purged).toEqual(['/del.png']);

    // 彻底物理抹除
    expect(db.getFaceById('face_delete_me', { includeDeleted: true })).toBeNull();
  });

  it('契约 6: 语义检索与多维度分页', () => {
    for (let i = 1; i <= 15; i++) {
      db.insertFace({
        id: `face_${i}`,
        file_path: `/face_${i}.png`,
        md5: `md5_${i}`,
        source: 'curate',
        tags: i % 2 === 0 ? ['猫猫', '可爱'] : ['熊猫头', '搞笑'],
        mood: i % 2 === 0 ? '卖萌' : '嘲讽',
        enabled: true,
        size: 100 * i,
        format: 'png',
      });
    }

    // 按 tag 筛选猫猫 (偶数，共 7 个)
    const catFaces = db.queryFaces({ tag: '猫猫', limit: 10 });
    expect(catFaces.total).toBe(7);
    expect(catFaces.faces.length).toBe(7);

    // 按 mood 筛选卖萌
    const cuteFaces = db.queryFaces({ mood: '卖萌', limit: 10 });
    expect(cuteFaces.total).toBe(7);

    // 分页测试 (第 1 页 5 条，第 2 页 5 条)
    const page1 = db.queryFaces({ limit: 5, offset: 0 });
    expect(page1.faces.length).toBe(5);
    expect(page1.has_more).toBe(true);
    expect(page1.total).toBe(15);

    const page2 = db.queryFaces({ limit: 5, offset: 5 });
    expect(page2.faces.length).toBe(5);
    expect(page2.faces[0].id).not.toBe(page1.faces[0].id);

    // 使用更新
    db.recordFaceUsage('face_1');
    const usedFace = db.getFaceById('face_1');
    expect(usedFace?.use_count).toBe(1);
    expect(usedFace?.last_used_at).toBeDefined();
  });
});
