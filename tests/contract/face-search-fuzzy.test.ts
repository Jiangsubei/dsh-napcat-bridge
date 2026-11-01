/**
 * tests/contract/face-search-fuzzy.test.ts
 * 契约测试: 表情包存储层模糊匹配 (mood LIKE, tag LIKE, query) 与动态情绪统计
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { MessageDatabase } from '../../src/storage/database.js';

describe('契约测试: 表情包存储层模糊检索与统计能力', () => {
  let tmpDir: string;
  let dbPath: string;
  let db: MessageDatabase;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-face-fuzzy-'));
    dbPath = path.join(tmpDir, 'messages.sqlite');
    db = new MessageDatabase(dbPath);

    // 预置若干具有代表性的测试表情
    db.insertFace({
      id: 'face_cat_1',
      file_path: '/path/cat1.png',
      md5: 'md5_c1',
      source: 'manual',
      tags: ['可爱猫猫', '萌系日常'],
      mood: '卖萌',
      enabled: true,
      size: 1024,
      format: 'png',
    });

    db.insertFace({
      id: 'face_cat_2',
      file_path: '/path/cat2.png',
      md5: 'md5_c2',
      source: 'manual',
      tags: ['猫咪', '叹气'],
      mood: '无奈/无语',
      enabled: true,
      size: 1024,
      format: 'png',
    });

    db.insertFace({
      id: 'face_panda_1',
      file_path: '/path/panda1.jpg',
      md5: 'md5_p1',
      source: 'manual',
      tags: ['熊猫头', '黑人问号'],
      mood: '疑惑/调侃',
      enabled: true,
      size: 1024,
      format: 'jpg',
    });

    db.insertFace({
      id: 'face_panda_2',
      file_path: '/path/panda2.jpg',
      md5: 'md5_p2',
      source: 'manual',
      tags: ['熊猫头', '打工破防'],
      mood: '无奈',
      enabled: true,
      size: 1024,
      format: 'jpg',
    });

    db.insertFace({
      id: 'face_doge_1',
      file_path: '/path/doge.jpg',
      md5: 'md5_d1',
      source: 'manual',
      tags: ['柴犬', '得意'],
      mood: '得意',
      enabled: true,
      size: 1024,
      format: 'jpg',
    });

    db.insertFace({
      id: 'face_disabled',
      file_path: '/path/disabled.png',
      md5: 'md5_dis',
      source: 'manual',
      tags: ['可爱猫猫'],
      mood: '卖萌',
      enabled: false, // 已禁用
      size: 1024,
      format: 'png',
    });
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('契约 1: mood 检索支持模糊包含匹配 (LIKE)', () => {
    // 搜 "无奈"，应该同时命中 mood 为 "无奈" 和 "无奈/无语" 的表情
    const res = db.queryFaces({ mood: '无奈' });
    const ids = res.faces.map((f) => f.id);
    expect(ids).toContain('face_cat_2');
    expect(ids).toContain('face_panda_2');
    expect(ids).not.toContain('face_cat_1');
    expect(ids).not.toContain('face_disabled');

    // 搜 "调侃"，命中 "疑惑/调侃"
    const res2 = db.queryFaces({ mood: '调侃' });
    expect(res2.faces.map((f) => f.id)).toContain('face_panda_1');
  });

  it('契约 2: tag 检索支持子串模糊匹配 (LIKE 且不受外层双引号限制)', () => {
    // 库中 tags 是 ["可爱猫猫", "萌系日常"]
    // 搜单字 "猫"，应当精准命中含 "可爱猫猫" 或 "猫咪" 的表情
    const res = db.queryFaces({ tag: '猫' });
    const ids = res.faces.map((f) => f.id);
    expect(ids).toContain('face_cat_1');
    expect(ids).toContain('face_cat_2');
    expect(ids).not.toContain('face_doge_1');

    // 搜 "问号"，命中 "黑人问号"
    const res2 = db.queryFaces({ tag: '问号' });
    expect(res2.faces.map((f) => f.id)).toContain('face_panda_1');
  });

  it('契约 3: query 综合模糊关键词支持跨 tags 与 mood 同时匹配', () => {
    // query = "破防"，在 tags 命中 face_panda_2
    const res1 = db.queryFaces({ query: '破防' });
    expect(res1.faces.map((f) => f.id)).toContain('face_panda_2');
    expect(res1.total).toBe(1);

    // query = "无语"，在 mood 命中 face_cat_2
    const res2 = db.queryFaces({ query: '无语' });
    expect(res2.faces.map((f) => f.id)).toContain('face_cat_2');

    // query = "猫"，在 tags 命中多个猫相关表情
    const res3 = db.queryFaces({ query: '猫' });
    expect(res3.faces.map((f) => f.id)).toEqual(
      expect.arrayContaining(['face_cat_1', 'face_cat_2'])
    );
  });

  it('契约 4: getFaceMoodSummary 聚合统计总数与情绪降序分布', () => {
    // 活跃表情共 5 个：卖萌(1), 无奈/无语(1), 疑惑/调侃(1), 无奈(1), 得意(1)
    // 其中 '无奈' 和 '无奈/无语' 是不同的 mood 字符串
    const summary = db.getFaceMoodSummary(5);
    expect(summary.total).toBe(5);
    expect(summary.moods.length).toBeGreaterThan(0);

    // 插入更多 "卖萌" 表情，验证按频次降序排序
    db.insertFace({
      id: 'face_cat_3',
      file_path: '/path/cat3.png',
      md5: 'md5_c3',
      source: 'manual',
      tags: ['卖萌猫'],
      mood: '卖萌',
      enabled: true,
      size: 1024,
      format: 'png',
    });

    const summary2 = db.getFaceMoodSummary(5);
    expect(summary2.total).toBe(6);
    // 第一名应该是 "卖萌"，count = 2
    expect(summary2.moods[0].mood).toBe('卖萌');
    expect(summary2.moods[0].count).toBe(2);

    // 软删除后不计入统计
    db.deleteFace('face_cat_3');
    const summary3 = db.getFaceMoodSummary(5);
    expect(summary3.total).toBe(5);
  });
});
