import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fsp } from 'node:fs';
import { MessageDatabase } from '../../src/storage/database.js';
import type { MessageRecord } from '../../src/types/index.js';

describe('契约测试: SQLite 消息存储与读记录多条件查询 (Storage & Query Contract)', () => {
  let tmpDir: string;
  let db: MessageDatabase;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-napcat-db-'));
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

  it('契约 1: 消息入库与多字段保真存储', () => {
    const record: MessageRecord = {
      msg_id: 1001,
      peer: 'group_3000000001',
      user_id: '2000000001',
      sender_name: '测试用户',
      time: 1788045798000,
      type: 'image',
      content: '[图片:/path/to/img.png] 拼接消息测试',
      raw: JSON.stringify([{ type: 'image', data: { file: 'C488.png' } }, { type: 'text', data: { text: ' 拼接消息测试' } }]),
      file_id: 'C488.png',
      busid: null,
      local_path: '/path/to/img.png',
      fingerprint: 'sha256_hash_value',
      recalled: 0,
      self: 0,
      reply_to: null,
    };

    db.saveMessage(record);

    const fetched = db.getMessage(1001);
    expect(fetched).toBeDefined();
    expect(fetched?.peer).toBe('group_3000000001');
    expect(fetched?.content).toBe('[图片:/path/to/img.png] 拼接消息测试');
    expect(fetched?.fingerprint).toBe('sha256_hash_value');
    expect(fetched?.recalled).toBe(0);
  });

  it('契约 2: 读历史记录工具支持多条件自由组合筛选与会话隔离', () => {
    // 插入不同用户、不同时间、不同会话的测试数据
    db.saveMessage({
      msg_id: 1, peer: 'group_A', user_id: 'user_1', sender_name: 'User 1', time: 1000,
      type: 'text', content: 'Msg 1', raw: '{}', file_id: null, busid: null, local_path: null, fingerprint: null, recalled: 0, self: 0, reply_to: null,
    });
    db.saveMessage({
      msg_id: 2, peer: 'group_A', user_id: 'user_1', sender_name: 'User 1', time: 2000,
      type: 'text', content: 'Msg 2', raw: '{}', file_id: null, busid: null, local_path: null, fingerprint: null, recalled: 0, self: 0, reply_to: null,
    });
    db.saveMessage({
      msg_id: 3, peer: 'group_A', user_id: 'user_2', sender_name: 'User 2', time: 3000,
      type: 'text', content: 'Msg 3', raw: '{}', file_id: null, busid: null, local_path: null, fingerprint: null, recalled: 0, self: 0, reply_to: null,
    });
    db.saveMessage({
      msg_id: 4, peer: 'group_A', user_id: 'user_1', sender_name: 'User 1', time: 4000,
      type: 'text', content: 'Msg 4', raw: '{}', file_id: null, busid: null, local_path: null, fingerprint: null, recalled: 0, self: 0, reply_to: null,
    });
    db.saveMessage({
      msg_id: 5, peer: 'group_B', user_id: 'user_1', sender_name: 'User 1', time: 5000,
      type: 'text', content: 'Msg 5 (Other Group)', raw: '{}', file_id: null, busid: null, local_path: null, fingerprint: null, recalled: 0, self: 0, reply_to: null,
    });

    // 多条件组合查询: peer=group_A, user_id=user_1, since=1500, limit=10, order=desc
    const res = db.readHistory('group_A', {
      user_id: 'user_1',
      since: 1500,
      limit: 10,
      order: 'desc',
    });

    expect(res.messages).toHaveLength(2);
    expect(res.messages[0].msg_id).toBe(4); // Msg 4 (time: 4000)
    expect(res.messages[1].msg_id).toBe(2); // Msg 2 (time: 2000)

    // 跨会话隔离断言: group_A 绝对查不到 group_B 的数据
    const resB = db.readHistory('group_A', { user_id: 'user_1', since: 0 });
    expect(resB.messages.some((m) => m.msg_id === 5)).toBe(false);
  });

  it('契约 3: 撤回通知精准更新对应消息状态', () => {
    db.saveMessage({
      msg_id: 2001, peer: 'group_A', user_id: 'user_1', sender_name: 'User 1', time: 1000,
      type: 'text', content: '原消息内容', raw: '{}', file_id: null, busid: null, local_path: null, fingerprint: null, recalled: 0, self: 0, reply_to: null,
    });

    // 执行撤回更新
    db.markRecalled(2001);

    const updated = db.getMessage(2001);
    expect(updated?.recalled).toBe(1);
    expect(updated?.content).toBe('〔已撤回〕');
  });

  it('契约 4: 关键词模糊检索 (keyword)', () => {
    db.saveMessage({
      msg_id: 101, peer: 'group_A', user_id: 'user_1', sender_name: 'Alice', time: 1000,
      type: 'text', content: '今天晚上讨论部署方案', raw: '{}', file_id: null, busid: null, local_path: null, fingerprint: null, recalled: 0, self: 0, reply_to: null,
    });
    db.saveMessage({
      msg_id: 102, peer: 'group_A', user_id: 'user_2', sender_name: 'Bob', time: 2000,
      type: 'text', content: '明天吃火锅', raw: '{}', file_id: null, busid: null, local_path: null, fingerprint: null, recalled: 0, self: 0, reply_to: null,
    });
    db.saveMessage({
      msg_id: 103, peer: 'group_A', user_id: 'user_1', sender_name: 'Alice', time: 3000,
      type: 'text', content: '部署方案文档已上传', raw: '{}', file_id: null, busid: null, local_path: null, fingerprint: null, recalled: 0, self: 0, reply_to: null,
    });

    const res = db.readHistory('group_A', { keyword: '部署' });
    expect(res.messages).toHaveLength(2);
    expect(res.total).toBe(2);
    expect(res.messages.map((m) => m.msg_id)).toEqual([103, 101]);
  });

  it('契约 5: 发送者昵称模糊检索 (sender_name)', () => {
    db.saveMessage({
      msg_id: 201, peer: 'group_A', user_id: '10001', sender_name: '张三【开发组】', time: 1000,
      type: 'text', content: 'Hello', raw: '{}', file_id: null, busid: null, local_path: null, fingerprint: null, recalled: 0, self: 0, reply_to: null,
    });
    db.saveMessage({
      msg_id: 202, peer: 'group_A', user_id: '10002', sender_name: '李四【测试组】', time: 2000,
      type: 'text', content: 'World', raw: '{}', file_id: null, busid: null, local_path: null, fingerprint: null, recalled: 0, self: 0, reply_to: null,
    });

    const res = db.readHistory('group_A', { sender_name: '张三' });
    expect(res.messages).toHaveLength(1);
    expect(res.messages[0].msg_id).toBe(201);
  });

  it('契约 6: 消息类型精确与多类型组合筛选 (type)', () => {
    db.saveMessage({
      msg_id: 301, peer: 'group_A', user_id: 'u1', sender_name: 'U1', time: 1000,
      type: 'text', content: '文字', raw: '{}', file_id: null, busid: null, local_path: null, fingerprint: null, recalled: 0, self: 0, reply_to: null,
    });
    db.saveMessage({
      msg_id: 302, peer: 'group_A', user_id: 'u1', sender_name: 'U1', time: 2000,
      type: 'image', content: '[图片:a.png]', raw: '{}', file_id: 'img1', busid: null, local_path: '/tmp/a.png', fingerprint: null, recalled: 0, self: 0, reply_to: null,
    });
    db.saveMessage({
      msg_id: 303, peer: 'group_A', user_id: 'u1', sender_name: 'U1', time: 3000,
      type: 'group_file', content: '[群文件:b.pdf]', raw: '{}', file_id: 'f1', busid: 101, local_path: null, fingerprint: null, recalled: 0, self: 0, reply_to: null,
    });
    db.saveMessage({
      msg_id: 304, peer: 'group_A', user_id: 'u1', sender_name: 'U1', time: 4000,
      type: 'poke', content: '[戳一戳]', raw: '{}', file_id: null, busid: null, local_path: null, fingerprint: null, recalled: 0, self: 0, reply_to: null,
    });

    // 单类型筛选
    const resImg = db.readHistory('group_A', { type: 'image' });
    expect(resImg.messages).toHaveLength(1);
    expect(resImg.messages[0].msg_id).toBe(302);

    // 多类型筛选
    const resMedia = db.readHistory('group_A', { type: ['image', 'group_file'] });
    expect(resMedia.messages).toHaveLength(2);
    expect(resMedia.messages.map((m) => m.msg_id)).toEqual([303, 302]);
  });

  it('契约 7: 人性化相对时间解析与范围筛选 (relative / since 相对表达式)', () => {
    const now = Date.now();
    // 30分钟前
    db.saveMessage({
      msg_id: 401, peer: 'group_A', user_id: 'u1', sender_name: 'U1', time: now - 30 * 60 * 1000,
      type: 'text', content: '半小时前', raw: '{}', file_id: null, busid: null, local_path: null, fingerprint: null, recalled: 0, self: 0, reply_to: null,
    });
    // 3小时前
    db.saveMessage({
      msg_id: 402, peer: 'group_A', user_id: 'u1', sender_name: 'U1', time: now - 3 * 3600 * 1000,
      type: 'text', content: '三小时前', raw: '{}', file_id: null, busid: null, local_path: null, fingerprint: null, recalled: 0, self: 0, reply_to: null,
    });
    // 2天前
    db.saveMessage({
      msg_id: 403, peer: 'group_A', user_id: 'u1', sender_name: 'U1', time: now - 2 * 86400 * 1000,
      type: 'text', content: '两天前', raw: '{}', file_id: null, busid: null, local_path: null, fingerprint: null, recalled: 0, self: 0, reply_to: null,
    });

    // 查最近 1 小时内 (relative: '1h')
    const res1h = db.readHistory('group_A', { relative: '1h' });
    expect(res1h.messages).toHaveLength(1);
    expect(res1h.messages[0].msg_id).toBe(401);

    // 查最近 4 小时内 (since: '4h')
    const res4h = db.readHistory('group_A', { since: '4h' });
    expect(res4h.messages).toHaveLength(2);
    expect(res4h.messages.map((m) => m.msg_id)).toEqual([401, 402]);
  });

  it('契约 8: 友好日期字符串时间解析与筛选 (since / until)', () => {
    // 2026-08-30 10:00:00 UTC+8 -> 1788055200000 左右
    const t1 = new Date('2026-08-30T10:00:00+08:00').getTime();
    const t2 = new Date('2026-08-31T10:00:00+08:00').getTime();

    db.saveMessage({
      msg_id: 501, peer: 'group_A', user_id: 'u1', sender_name: 'U1', time: t1,
      type: 'text', content: '8月30日消息', raw: '{}', file_id: null, busid: null, local_path: null, fingerprint: null, recalled: 0, self: 0, reply_to: null,
    });
    db.saveMessage({
      msg_id: 502, peer: 'group_A', user_id: 'u1', sender_name: 'U1', time: t2,
      type: 'text', content: '8月31日消息', raw: '{}', file_id: null, busid: null, local_path: null, fingerprint: null, recalled: 0, self: 0, reply_to: null,
    });

    const res = db.readHistory('group_A', { since: '2026-08-31' });
    expect(res.messages).toHaveLength(1);
    expect(res.messages[0].msg_id).toBe(502);
  });

  it('契约 9: 附件/文件存在性筛选 (has_file)', () => {
    db.saveMessage({
      msg_id: 601, peer: 'group_A', user_id: 'u1', sender_name: 'U1', time: 1000,
      type: 'text', content: '普通文本', raw: '{}', file_id: null, busid: null, local_path: null, fingerprint: null, recalled: 0, self: 0, reply_to: null,
    });
    db.saveMessage({
      msg_id: 602, peer: 'group_A', user_id: 'u1', sender_name: 'U1', time: 2000,
      type: 'file', content: '[文件:doc.pdf]', raw: '{}', file_id: 'f_602', busid: null, local_path: '/path/doc.pdf', fingerprint: null, recalled: 0, self: 0, reply_to: null,
    });

    const res = db.readHistory('group_A', { has_file: true });
    expect(res.messages).toHaveLength(1);
    expect(res.messages[0].msg_id).toBe(602);
    expect(res.messages[0].file_id).toBe('f_602');
  });

  it('契约 10: 机器人自身消息过滤与定向筛选 (exclude_self / self_only)', () => {
    db.saveMessage({
      msg_id: 701, peer: 'group_A', user_id: 'user_1', sender_name: 'User 1', time: 1000,
      type: 'text', content: '用户说', raw: '{}', file_id: null, busid: null, local_path: null, fingerprint: null, recalled: 0, self: 0, reply_to: null,
    });
    db.saveMessage({
      msg_id: 702, peer: 'group_A', user_id: 'bot_qq', sender_name: 'Bot', time: 2000,
      type: 'text', content: '机器人回复', raw: '{}', file_id: null, busid: null, local_path: null, fingerprint: null, recalled: 0, self: 1, reply_to: 701,
    });

    const resEx = db.readHistory('group_A', { exclude_self: true });
    expect(resEx.messages).toHaveLength(1);
    expect(resEx.messages[0].msg_id).toBe(701);

    const resSelf = db.readHistory('group_A', { self_only: true });
    expect(resSelf.messages).toHaveLength(1);
    expect(resSelf.messages[0].msg_id).toBe(702);
  });

  it('契约 11: 引用回复链关系筛选 (reply_to)', () => {
    db.saveMessage({
      msg_id: 801, peer: 'group_A', user_id: 'u1', sender_name: 'U1', time: 1000,
      type: 'text', content: '原始问题', raw: '{}', file_id: null, busid: null, local_path: null, fingerprint: null, recalled: 0, self: 0, reply_to: null,
    });
    db.saveMessage({
      msg_id: 802, peer: 'group_A', user_id: 'u2', sender_name: 'U2', time: 2000,
      type: 'text', content: '回答问题', raw: '{}', file_id: null, busid: null, local_path: null, fingerprint: null, recalled: 0, self: 0, reply_to: 801,
    });

    const res = db.readHistory('group_A', { reply_to: 801 });
    expect(res.messages).toHaveLength(1);
    expect(res.messages[0].msg_id).toBe(802);
  });

  it('契约 12: 消息出参携带格式化人类可读时间 (formatted_time)', () => {
    db.saveMessage({
      msg_id: 901, peer: 'group_A', user_id: 'u1', sender_name: 'U1', time: 1725062400000,
      type: 'text', content: '时间测试', raw: '{}', file_id: null, busid: null, local_path: null, fingerprint: null, recalled: 0, self: 0, reply_to: null,
    });

    const res = db.readHistory('group_A', { limit: 1 });
    expect(res.messages[0].formatted_time).toBeDefined();
    expect(typeof res.messages[0].formatted_time).toBe('string');
    expect(res.messages[0].formatted_time).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it('契约 13: readChatHistory 工具函数多维参数透传与执行', async () => {
    const { readChatHistory } = await import('../../src/tools/index.js');
    db.saveMessage({
      msg_id: 1001, peer: 'group_123456', user_id: 'u1', sender_name: 'Alice', time: 1000,
      type: 'text', content: '工具端到端关键词测试', raw: '{}', file_id: null, busid: null, local_path: null, fingerprint: null, recalled: 0, self: 0, reply_to: null,
    });

    const res = await readChatHistory('qq-group-123456', { keyword: '端到端' }, db);
    expect(res.messages).toHaveLength(1);
    expect(res.messages[0].msg_id).toBe(1001);
  });
});

describe('契约测试: MediaStorageManager 媒体落盘与魔数推断 (Media Storage Contract)', () => {
  let tmpMediaDir: string;
  let mediaManager: any;

  beforeEach(async () => {
    tmpMediaDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-napcat-media-'));
    const { MediaStorageManager } = await import('../../src/storage/media.js');
    mediaManager = new MediaStorageManager({ downloadDir: tmpMediaDir });
  });

  afterEach(async () => {
    if (tmpMediaDir) {
      await fsp.rm(tmpMediaDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('契约 1: saveBuffer 对 GIF89a / GIF87a 魔数推断为 .gif，存盘后缀正确', async () => {
    const gif89Buffer = Buffer.from('GIF89a\x01\x00\x01\x00\x80\x00\x00');
    const res89 = await mediaManager.saveBuffer(gif89Buffer, {
      type: 'sticker',
      sessionId: 'user_2000000001',
    });
    expect(res89.localPath.endsWith('.gif')).toBe(true);
    const content89 = await fsp.readFile(res89.localPath);
    expect(content89.subarray(0, 6).toString('ascii')).toBe('GIF89a');

    const gif87Buffer = Buffer.from('GIF87a\x01\x00\x01\x00\x80\x00\x00');
    const res87 = await mediaManager.saveBuffer(gif87Buffer, {
      type: 'image',
      sessionId: 'user_2000000001',
    });
    expect(res87.localPath.endsWith('.gif')).toBe(true);
  });

  it('契约 2: saveBuffer 对 PNG / JPEG / WebP 自动识别魔数', async () => {
    // PNG
    const pngBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
    const resPng = await mediaManager.saveBuffer(pngBuffer, { type: 'image' });
    expect(resPng.localPath.endsWith('.png')).toBe(true);

    // JPEG
    const jpgBuffer = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    const resJpg = await mediaManager.saveBuffer(jpgBuffer, { type: 'image' });
    expect(resJpg.localPath.endsWith('.jpg')).toBe(true);

    // WebP
    const webpBuffer = Buffer.concat([
      Buffer.from('RIFF'),
      Buffer.alloc(4),
      Buffer.from('WEBP'),
      Buffer.alloc(10),
    ]);
    const resWebp = await mediaManager.saveBuffer(webpBuffer, { type: 'sticker' });
    expect(resWebp.localPath.endsWith('.webp')).toBe(true);
  });

  it('契约 3: 已知魔数识别优先级高于外部传入的 options.ext（防止外部伪后缀如 .jpg 污染真实 PNG/GIF）', async () => {
    // 场景 A: 真实 PNG 文件，但外部误传 options.ext = 'jpg'（如 QQ/NapCat 上报 data.file 默认带 .jpg）
    const pngBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
    const resPng = await mediaManager.saveBuffer(pngBuffer, {
      type: 'sticker',
      ext: 'jpg',
    });
    expect(resPng.localPath.endsWith('.png')).toBe(true);

    // 场景 B: 真实 GIF 文件，即使外部指定 options.ext 也优先根据魔数存为 .gif
    const gifBuffer = Buffer.from('GIF89a\x01\x00\x01\x00\x80\x00\x00');
    const resGif = await mediaManager.saveBuffer(gifBuffer, {
      type: 'sticker',
      ext: 'custom',
    });
    expect(resGif.localPath.endsWith('.gif')).toBe(true);
  });

  it('契约 4: 无法识别魔数的未知格式/二进制流，回退使用 options.ext 与默认后缀', async () => {
    const customBuffer = Buffer.from('some custom binary or text data');
    const res = await mediaManager.saveBuffer(customBuffer, {
      type: 'files',
      ext: 'custom',
    });
    expect(res.localPath.endsWith('.custom')).toBe(true);
  });
});

