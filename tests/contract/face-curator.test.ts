/**
 * tests/contract/face-curator.test.ts
 * 契约测试: 后台表情包整理 Agent (Face Curator Agent)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { MessageDatabase } from '../../src/storage/database.js';
import { FaceCurator } from '../../src/gateway/curator.js';

describe('契约测试: 后台表情包整理 Agent (Face Curator Contract)', () => {
  let tmpDir: string;
  let dbPath: string;
  let db: MessageDatabase;
  let imgDownloadDir: string;
  let faceStoreDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-face-curator-'));
    dbPath = path.join(tmpDir, 'messages.sqlite');
    db = new MessageDatabase(dbPath);
    imgDownloadDir = path.join(tmpDir, 'downloads', 'image', 'group_123');
    faceStoreDir = path.join(tmpDir, 'faces');
    fs.mkdirSync(imgDownloadDir, { recursive: true });
    fs.mkdirSync(faceStoreDir, { recursive: true });
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('契约 1: 扫描命中表情包并成功提炼入库 (转存/打标/去重)', async () => {
    // 构造测试图片
    const testImg = path.join(imgDownloadDir, 'meme_sample.jpg');
    fs.writeFileSync(testImg, 'sample-meme-content-data');
    const md5 = crypto.createHash('md5').update('sample-meme-content-data').digest('hex');

    // 模拟 LLM 识别服务返回命中结果
    const mockLlm = {
      analyzeImage: vi.fn().mockResolvedValue({
        is_face: true,
        tags: ['猫猫', '喝水'],
        mood: '搞笑',
      }),
    };

    const curator = new FaceCurator({
      db,
      faceStoreDir,
      imageScanDirs: [imgDownloadDir],
      llmService: mockLlm,
      config: () => ({ face_enabled: true, face_auto_curate: true }),
    });

    const report = await curator.curateOnce();

    expect(report.scanned).toBe(1);
    expect(report.adopted).toBe(1);
    expect(report.skipped).toBe(0);

    // 验证数据库入库
    const stored = db.getFaceByMd5(md5);
    expect(stored).toBeDefined();
    expect(stored?.source).toBe('curate');
    expect(stored?.tags).toEqual(['猫猫', '喝水']);
    expect(stored?.mood).toBe('搞笑');
    expect(fs.existsSync(stored!.file_path)).toBe(true);
  });

  it('契约 2: 普通生活照/非表情包被识别并安全跳过 (is_face = false)', async () => {
    const testImg = path.join(imgDownloadDir, 'landscape.jpg');
    fs.writeFileSync(testImg, 'sample-landscape-photo');

    const mockLlm = {
      analyzeImage: vi.fn().mockResolvedValue({
        is_face: false,
        reason: '这是风景照，不是表情包',
      }),
    };

    const curator = new FaceCurator({
      db,
      faceStoreDir,
      imageScanDirs: [imgDownloadDir],
      llmService: mockLlm,
      config: () => ({ face_enabled: true, face_auto_curate: true }),
    });

    const report = await curator.curateOnce();

    expect(report.scanned).toBe(1);
    expect(report.adopted).toBe(0);
    expect(report.skipped).toBe(1);

    // 数据库中不新增条目
    expect(db.queryFaces({}).total).toBe(0);
  });

  it('契约 3: 纯文本模型或模型输出 nothing to save 时静默安全退出 (零崩溃、零脏数据)', async () => {
    const testImg = path.join(imgDownloadDir, 'unknown.jpg');
    fs.writeFileSync(testImg, 'binary-data-for-text-model');

    // 模拟无读图能力的纯文本模型直接输出 nothing to save
    const mockLlm = {
      analyzeImage: vi.fn().mockResolvedValue('nothing to save'),
    };

    const curator = new FaceCurator({
      db,
      faceStoreDir,
      imageScanDirs: [imgDownloadDir],
      llmService: mockLlm,
      config: () => ({ face_enabled: true, face_auto_curate: true }),
    });

    const report = await curator.curateOnce();

    expect(report.scanned).toBe(1);
    expect(report.adopted).toBe(0);
    expect(report.skipped).toBe(1);
    expect(db.queryFaces({}).total).toBe(0);
  });

  it('契约 4: 整理任务坚决不建 skill、不写记忆', async () => {
    const testImg = path.join(imgDownloadDir, 'meme_2.jpg');
    fs.writeFileSync(testImg, 'another-meme-sample');

    const mockMemoryStorage = {
      writeRule: vi.fn(),
      writeProfile: vi.fn(),
      saveMemory: vi.fn(),
    };

    const mockLlm = {
      analyzeImage: vi.fn().mockResolvedValue({
        is_face: true,
        tags: ['柴犬'],
        mood: '调侃',
      }),
    };

    const curator = new FaceCurator({
      db,
      faceStoreDir,
      imageScanDirs: [imgDownloadDir],
      llmService: mockLlm,
      memoryStorage: mockMemoryStorage as any,
      config: () => ({ face_enabled: true, face_auto_curate: true }),
    });

    await curator.curateOnce();

    // 绝对不得触发任何记忆写入
    expect(mockMemoryStorage.writeRule).not.toHaveBeenCalled();
    expect(mockMemoryStorage.writeProfile).not.toHaveBeenCalled();
    expect(mockMemoryStorage.saveMemory).not.toHaveBeenCalled();
  });

  it('契约 5: 双重门控保护 (face_enabled 或 face_auto_curate 关闭时不执行)', async () => {
    const testImg = path.join(imgDownloadDir, 'meme_3.jpg');
    fs.writeFileSync(testImg, 'some-content');

    const mockLlm = {
      analyzeImage: vi.fn(),
    };

    // 1. face_enabled = false
    const curator1 = new FaceCurator({
      db,
      faceStoreDir,
      imageScanDirs: [imgDownloadDir],
      llmService: mockLlm,
      config: () => ({ face_enabled: false, face_auto_curate: true }),
    });
    const rep1 = await curator1.curateOnce();
    expect(rep1.scanned).toBe(0);
    expect(mockLlm.analyzeImage).not.toHaveBeenCalled();

    // 2. face_auto_curate = false
    const curator2 = new FaceCurator({
      db,
      faceStoreDir,
      imageScanDirs: [imgDownloadDir],
      llmService: mockLlm,
      config: () => ({ face_enabled: true, face_auto_curate: false }),
    });
    const rep2 = await curator2.curateOnce();
    expect(rep2.scanned).toBe(0);
    expect(mockLlm.analyzeImage).not.toHaveBeenCalled();
  });

  it('契约 6: runCurator 原生 Fork 会话、注入白名单沙箱并在完成后用完即焚清理临时会话', async () => {
    let capturedAllowedTools: string[] = [];
    const mockAgentHandle = {
      dispose: vi.fn().mockResolvedValue(undefined),
      agent: {
        followup: vi.fn(),
        whenIdle: vi.fn().mockResolvedValue(undefined),
      },
    };

    const mockAgentsService = {
      create: vi.fn().mockImplementation(async (options: any) => {
        // 执行 setup 注入沙箱
        const mockToolsSvc = {
          restrict: vi.fn().mockImplementation(({ allow }) => {
            capturedAllowedTools = allow;
          }),
        };
        if (options.setup) {
          options.setup({ tools: mockToolsSvc });
        }
        return mockAgentHandle;
      }),
    };

    const mockSessions = {
      get: vi.fn().mockReturnValue({}),
      flush: vi.fn().mockResolvedValue(undefined),
      detachEntered: vi.fn(),
      deleteSession: vi.fn().mockResolvedValue(undefined),
    };

    const mockCtx = {
      agents: mockAgentsService,
      sessions: mockSessions,
    };

    const curator = new FaceCurator({
      ctx: mockCtx as any,
      db,
      faceStoreDir,
      config: () => ({ face_enabled: true, face_auto_curate: true }),
    });

    const res = await curator.runCurator('group_123', {
      parentSession: {
        id: 'parent_sess_1',
        snapshotEvents: () => [{ type: 'turn/start' }, { type: 'turn/end' }],
      },
    });

    expect(res.executed).toBe(true);
    // 验证 Fork 创建
    expect(mockAgentsService.create).toHaveBeenCalled();
    // 验证工具白名单沙箱包含且仅包含指定工具
    expect(capturedAllowedTools).toEqual(['collect_face', 'list_faces', 'read_chat_history', 'read_image']);
    // 验证 followup 投递
    expect(mockAgentHandle.agent.followup).toHaveBeenCalled();
    // 验证用完即焚清理：agent 释放先行 -> 会话物理删除
    expect(mockAgentHandle.dispose).toHaveBeenCalled();
    expect(mockSessions.deleteSession).toHaveBeenCalled();
  });
});
