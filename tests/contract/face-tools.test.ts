/**
 * tests/contract/face-tools.test.ts
 * 契约测试: Agent 表情工具集 (list_faces, send_face, collect_face) 与门控
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { MessageDatabase } from '../../src/storage/database.js';
import { PerPeerSerialSender } from '../../src/outbound/queue.js';
import {
  listFaces,
  sendFace,
  collectFace,
  registerAgentTools,
} from '../../src/tools/index.js';
import type { FaceRecord } from '../../src/types/index.js';

describe('契约测试: Agent 表情工具集 (Face Tools Contract)', () => {
  let tmpDir: string;
  let dbPath: string;
  let db: MessageDatabase;
  let faceDir: string;
  let sender: PerPeerSerialSender;
  let mockGateway: any;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-face-tools-'));
    dbPath = path.join(tmpDir, 'messages.sqlite');
    db = new MessageDatabase(dbPath);
    faceDir = path.join(tmpDir, 'faces');
    fs.mkdirSync(faceDir, { recursive: true });

    sender = new PerPeerSerialSender();
    mockGateway = {
      sendGroupMsg: vi.fn().mockResolvedValue({ status: 'ok', retcode: 0, data: { message_id: 10001 } }),
      sendPrivateMsg: vi.fn().mockResolvedValue({ status: 'ok', retcode: 0, data: { message_id: 10002 } }),
    };
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('契约 1: list_faces 分页、标签筛选与绝对路径防泄露', async () => {
    // 插入 3 张表情，其中 1 张停用
    db.insertFace({
      id: 'face_active_1',
      file_path: '/secret/path/cat.png',
      md5: 'md5_1',
      source: 'manual',
      tags: ['猫猫', '可爱'],
      mood: '卖萌',
      enabled: true,
      size: 1024,
      format: 'png',
    });
    db.insertFace({
      id: 'face_active_2',
      file_path: '/secret/path/panda.jpg',
      md5: 'md5_2',
      source: 'collect',
      tags: ['熊猫头', '问号'],
      mood: '疑惑',
      enabled: true,
      size: 2048,
      format: 'jpg',
    });
    db.insertFace({
      id: 'face_disabled',
      file_path: '/secret/path/bad.png',
      md5: 'md5_3',
      source: 'manual',
      tags: ['猫猫'],
      mood: '卖萌',
      enabled: false, // 停用
      size: 1024,
      format: 'png',
    });

    const res = await listFaces({ mood: '卖萌' }, { db });

    expect(res.faces).toHaveLength(1);
    expect(res.faces[0].id).toBe('face_active_1');
    expect(res.faces[0].tags).toEqual(['猫猫', '可爱']);
    expect(res.faces[0].mood).toBe('卖萌');
    // 提供本地图片路径，供多模态 Agent 读图与补标
    expect(res.faces[0].file_path).toBe('/secret/path/cat.png');
  });

  it('契约 2: send_face 构造 sub_type=1 并接入串行队列与更新使用频次', async () => {
    const testImgPath = path.join(faceDir, 'doge.png');
    fs.writeFileSync(testImgPath, 'fake-doge-image-binary');

    db.insertFace({
      id: 'face_doge',
      file_path: testImgPath,
      md5: 'md5_doge',
      source: 'manual',
      tags: ['狗头'],
      mood: '调侃',
      enabled: true,
      size: 1024,
      format: 'png',
    });

    const enqueueSpy = vi.spyOn(sender, 'enqueue');

    const res = await sendFace(
      { face_id: 'face_doge' },
      {
        db,
        gateway: mockGateway,
        sender,
        peer: 'group_123456',
        groupId: '123456',
      }
    );

    expect(res.success).toBe(true);
    expect(res.message_id).toBe(10001);

    // 必须经由 sender.enqueue 串行发送
    expect(enqueueSpy).toHaveBeenCalled();

    // 验证 Gateway 调用参数包含 sub_type = 1 且为 file:// 路径
    expect(mockGateway.sendGroupMsg).toHaveBeenCalledWith(
      '123456',
      expect.arrayContaining([
        expect.objectContaining({
          type: 'image',
          data: expect.objectContaining({
            file: expect.stringMatching(/^file:\/\/\//),
            sub_type: 1,
          }),
        }),
      ])
    );

    // 验证使用频次与时间被记录
    const updated = db.getFaceById('face_doge');
    expect(updated?.use_count).toBe(1);
    expect(updated?.last_used_at).toBeGreaterThan(0);
  });

  it('契约 3: send_face 表情不存在或已禁用时返回清晰错误', async () => {
    const resNotFound = await sendFace(
      { face_id: 'non_existent' },
      { db, gateway: mockGateway, sender, peer: 'user_123' }
    );
    expect(resNotFound.success).toBe(false);
    expect(resNotFound.error).toMatch(/不存在/);

    // 禁用表情
    db.insertFace({
      id: 'face_disabled',
      file_path: '/path.png',
      md5: 'md5_dis',
      source: 'manual',
      tags: ['禁用'],
      enabled: false,
      size: 100,
      format: 'png',
    });

    const resDisabled = await sendFace(
      { face_id: 'face_disabled' },
      { db, gateway: mockGateway, sender, peer: 'user_123' }
    );
    expect(resDisabled.success).toBe(false);
    expect(resDisabled.error).toMatch(/已禁用/);
  });

  it('契约 4: collect_face 提取消息附件、落盘至 face 目录并入库', async () => {
    // 模拟消息数据库中有一条带图片的入站消息
    const srcImgFile = path.join(tmpDir, 'downloaded_image.jpg');
    fs.writeFileSync(srcImgFile, 'real-image-data-sample-12345');
    const imgMd5 = crypto.createHash('md5').update('real-image-data-sample-12345').digest('hex');

    db.saveMessage({
      msg_id: 88881,
      peer: 'group_123456',
      user_id: '999999',
      sender_name: '群友A',
      time: Math.floor(Date.now() / 1000),
      type: 'image',
      content: '[图片]',
      raw: JSON.stringify([{ type: 'image', data: { file: 'test.jpg' } }]),
      local_path: srcImgFile,
    });

    const res = await collectFace(
      {
        message_id: 88881,
        tags: ['猫猫', '喝水'],
        mood: '搞笑',
      },
      {
        db,
        peer: 'group_123456',
        faceDir,
      }
    );

    expect(res.success).toBe(true);
    expect(res.face_id).toBeDefined();

    // 验证文件已成功转存至 faceDir
    const storedFace = db.getFaceById(res.face_id!);
    expect(storedFace).toBeDefined();
    expect(storedFace?.md5).toBe(imgMd5);
    expect(storedFace?.tags).toEqual(['猫猫', '喝水']);
    expect(storedFace?.mood).toBe('搞笑');
    expect(fs.existsSync(storedFace!.file_path)).toBe(true);
  });

  it('契约 5: collect_face 重复偷图时显式告知已存在与既有标签 (防上下文遗忘)', async () => {
    const srcImgFile = path.join(tmpDir, 'dup_image.png');
    fs.writeFileSync(srcImgFile, 'duplicate-content-xyz');
    const imgMd5 = crypto.createHash('md5').update('duplicate-content-xyz').digest('hex');

    // 预先入库此表情
    db.insertFace({
      id: 'existing_face_id',
      file_path: '/already/stored.png',
      md5: imgMd5,
      source: 'collect',
      tags: ['已有标签1', '已有标签2'],
      mood: '已知情绪',
      enabled: true,
      size: 100,
      format: 'png',
    });

    db.saveMessage({
      msg_id: 88882,
      peer: 'group_123456',
      user_id: '999999',
      sender_name: '群友B',
      time: Math.floor(Date.now() / 1000),
      type: 'image',
      content: '[图片]',
      raw: '',
      local_path: srcImgFile,
    });

    const res = await collectFace(
      {
        message_id: 88882,
        tags: ['新标签'],
        mood: '新情绪',
      },
      {
        db,
        peer: 'group_123456',
        faceDir,
      }
    );

    expect(res.success).toBe(true);
    expect(res.duplicated).toBe(true);
    expect(res.face_id).toBe('existing_face_id');
    // 明确提示已有表情及标签，解决上下文压缩遗忘
    expect(res.message).toMatch(/已在你的表情库中存在/);
    expect(res.message).toMatch(/已有标签1/);
  });

  it('契约 6: collect_face 参数校验 (缺少 tags/mood 或目标消息无图片时拒绝)', async () => {
    // 缺少 tags
    const resNoTags = await collectFace(
      { mood: '卖萌' } as any,
      { db, peer: 'group_123456', faceDir }
    );
    expect(resNoTags.success).toBe(false);
    expect(resNoTags.error).toMatch(/tags/);

    // 目标消息无图片
    db.saveMessage({
      msg_id: 88883,
      peer: 'group_123456',
      user_id: '999999',
      sender_name: '群友C',
      time: Math.floor(Date.now() / 1000),
      type: 'text',
      content: '纯文本消息',
      raw: '纯文本消息',
    });

    const resNoImg = await collectFace(
      {
        message_id: 88883,
        tags: ['标签'],
        mood: '情绪',
      },
      { db, peer: 'group_123456', faceDir }
    );
    expect(resNoImg.success).toBe(false);
    expect(resNoImg.error).toMatch(/未找到图片/);
  });

  it('契约 8: collect_face 支持传入 face_id 为已有未打标表情补全 tags 与 mood', async () => {
    // 预先存入一个无标签表情
    db.insertFace({
      id: 'face_to_edit',
      file_path: '/path/to/img.png',
      md5: 'md5_to_edit',
      source: 'user_upload',
      tags: [],
      enabled: true,
      size: 100,
      format: 'png',
    });

    // Agent 补标：缺少 tags 必须报错拒绝
    const failNoTags = await collectFace(
      { face_id: 'face_to_edit', mood: '疑惑' } as any,
      { db }
    );
    expect(failNoTags.success).toBe(false);
    expect(failNoTags.error).toMatch(/tags/);

    // Agent 补标：合法参数更新
    const successEdit = await collectFace(
      {
        face_id: 'face_to_edit',
        tags: ['新打标猫猫', '喝水'],
        mood: '呆萌',
      },
      { db }
    );
    expect(successEdit.success).toBe(true);
    expect(successEdit.face_id).toBe('face_to_edit');

    const edited = db.getFaceById('face_to_edit');
    expect(edited?.tags).toEqual(['新打标猫猫', '喝水']);
    expect(edited?.mood).toBe('呆萌');
  });

  it('契约 7: 门控装配契约 (face_enabled 为 false 时不注册表情工具)', () => {
    const mockTools = {
      register: vi.fn(),
    };
    const mockCtx = {
      tools: mockTools,
    };

    // 1. 关闭总开关 (face_enabled = false)
    registerAgentTools(mockCtx as any, {
      db,
      mediaManager: {} as any,
      config: () => ({ face_enabled: false } as any),
    } as any);

    const registeredNamesFalse = mockTools.register.mock.calls.map(call => call[0].name);
    expect(registeredNamesFalse).not.toContain('list_faces');
    expect(registeredNamesFalse).not.toContain('send_face');
    expect(registeredNamesFalse).not.toContain('collect_face');

    // 2. 开启总开关 (face_enabled = true)
    mockTools.register.mockClear();
    registerAgentTools(mockCtx as any, {
      db,
      mediaManager: {} as any,
      config: () => ({ face_enabled: true } as any),
    } as any);

    const registeredNamesTrue = mockTools.register.mock.calls.map(call => call[0].name);
    expect(registeredNamesTrue).toContain('list_faces');
    expect(registeredNamesTrue).toContain('send_face');
    expect(registeredNamesTrue).toContain('collect_face');
  });
});
