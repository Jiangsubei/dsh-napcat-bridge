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

  it('契约 7: runAllActivePeers 三条件门控：若该会话无新图片消息且表情库无未打标表情，彻底静默，绝不拉起 Agent (0 Token 浪费)', async () => {
    const mockAgentsService = {
      create: vi.fn(),
    };
    const curator = new FaceCurator({
      ctx: { agents: mockAgentsService } as any,
      db,
      faceStoreDir,
      config: () => ({ face_enabled: true, face_auto_curate: true, face_curate_interval_mins: 0 }),
    });

    // 绑定活跃会话，但仅有纯文本消息
    db.saveSessionState({
      peer: 'group_text_only',
      current_session_id: 'qq-group-text_only',
    });
    db.saveMessage({
      msg_id: 1,
      peer: 'group_text_only',
      user_id: '1001',
      sender_name: 'Alice',
      time: Date.now(),
      type: 'text',
      content: '纯文字消息，没有表情包',
      raw: {},
    });

    const results = await curator.runAllActivePeers();

    // 彻底静默：跳过执行，0 结果，绝不创建 Agent
    expect(results).toEqual([]);
    expect(mockAgentsService.create).not.toHaveBeenCalled();
  });

  it('契约 8: runAllActivePeers 三条件门控：仅对当前绑定的活跃会话触发，已归档会话被过滤', async () => {
    const mockAgentHandle = {
      dispose: vi.fn().mockResolvedValue(undefined),
      agent: { followup: vi.fn(), whenIdle: vi.fn().mockResolvedValue(undefined) },
    };
    const mockAgentsService = {
      create: vi.fn().mockResolvedValue(mockAgentHandle),
    };
    const mockSessionManager = {
      isQQSession: vi.fn().mockReturnValue(true),
      isSessionArchived: vi.fn().mockImplementation((sid: string) => sid.includes('archived')),
    };

    const curator = new FaceCurator({
      ctx: { agents: mockAgentsService } as any,
      db,
      faceStoreDir,
      sessionManager: mockSessionManager,
      config: () => ({ face_enabled: true, face_auto_curate: true, face_curate_interval_mins: 0 }),
    });

    // 会话 A: 已归档
    db.saveSessionState({
      peer: 'group_archived',
      current_session_id: 'qq-group-archived',
    });
    db.saveMessage({
      msg_id: 10,
      peer: 'group_archived',
      user_id: '1001',
      sender_name: 'Bob',
      time: Date.now(),
      type: 'image',
      content: '[图片]',
      raw: {},
    });

    // 会话 B: 活跃会话
    db.saveSessionState({
      peer: 'group_active',
      current_session_id: 'qq-group-active',
    });
    db.saveMessage({
      msg_id: 20,
      peer: 'group_active',
      user_id: '1002',
      sender_name: 'Charlie',
      time: Date.now(),
      type: 'image',
      content: '[图片]',
      raw: {},
    });

    const results = await curator.runAllActivePeers();

    // 仅活跃会话触发
    expect(results.length).toBe(1);
    expect(results[0].peer).toBe('group_active');
    expect(mockAgentsService.create).toHaveBeenCalledTimes(1);
  });

  it('契约 9: runAllActivePeers 三条件门控：新入站图片消息到达时触发并推进游标，无新消息时下次巡检静默', async () => {
    const mockAgentHandle = {
      dispose: vi.fn().mockResolvedValue(undefined),
      agent: { followup: vi.fn(), whenIdle: vi.fn().mockResolvedValue(undefined) },
    };
    const mockAgentsService = {
      create: vi.fn().mockResolvedValue(mockAgentHandle),
    };

    const curator = new FaceCurator({
      ctx: { agents: mockAgentsService } as any,
      db,
      faceStoreDir,
      config: () => ({ face_enabled: true, face_auto_curate: true, face_curate_interval_mins: 0 }),
    });

    db.saveSessionState({
      peer: 'group_cursor_test',
      current_session_id: 'qq-group-cursor_test',
    });

    // 轮次 1: 仅文本，不触发
    db.saveMessage({
      msg_id: 1,
      peer: 'group_cursor_test',
      user_id: '1001',
      sender_name: 'David',
      time: Date.now(),
      type: 'text',
      content: 'hello',
      raw: {},
    });
    let results = await curator.runAllActivePeers();
    expect(results.length).toBe(0);
    expect(mockAgentsService.create).not.toHaveBeenCalled();

    // 轮次 2: 收到新图片消息，触发巡检
    db.saveMessage({
      msg_id: 5,
      peer: 'group_cursor_test',
      user_id: '1001',
      sender_name: 'David',
      time: Date.now(),
      type: 'image',
      content: '[图片]',
      raw: {},
    });
    results = await curator.runAllActivePeers();
    expect(results.length).toBe(1);
    expect(mockAgentsService.create).toHaveBeenCalledTimes(1);
    // 游标已推进到 5
    expect(curator.getLastCuratedMsgId('group_cursor_test')).toBeGreaterThanOrEqual(5);

    // 轮次 3: 定时到达但没有新消息，静默跳过 (0 Token 消耗)
    mockAgentsService.create.mockClear();
    results = await curator.runAllActivePeers();
    expect(results.length).toBe(0);
    expect(mockAgentsService.create).not.toHaveBeenCalled();

    // 轮次 4: 再次收到新图片消息，再次触发
    db.saveMessage({
      msg_id: 12,
      peer: 'group_cursor_test',
      user_id: '1002',
      sender_name: 'Eve',
      time: Date.now(),
      type: 'image',
      content: '[图片]',
      raw: {},
    });
    results = await curator.runAllActivePeers();
    expect(results.length).toBe(1);
    expect(mockAgentsService.create).toHaveBeenCalledTimes(1);
    expect(curator.getLastCuratedMsgId('group_cursor_test')).toBeGreaterThanOrEqual(12);
  });

  it('契约 10: 本地表情库有未打标表情时，即使无新图片消息也会触发补标巡检', async () => {
    const mockAgentHandle = {
      dispose: vi.fn().mockResolvedValue(undefined),
      agent: { followup: vi.fn(), whenIdle: vi.fn().mockResolvedValue(undefined) },
    };
    const mockAgentsService = {
      create: vi.fn().mockResolvedValue(mockAgentHandle),
    };

    const curator = new FaceCurator({
      ctx: { agents: mockAgentsService } as any,
      db,
      faceStoreDir,
      config: () => ({ face_enabled: true, face_auto_curate: true, face_curate_interval_mins: 0 }),
    });

    db.saveSessionState({
      peer: 'group_untagged_test',
      current_session_id: 'qq-group-untagged_test',
    });

    // 插入未打标表情
    db.insertFace({
      id: 'face_untagged_1',
      file_path: '/path/to/face1.png',
      md5: 'md5_untagged_1',
      source: 'user',
      tags: [],
      mood: '',
      size: 100,
      format: 'png',
      enabled: true,
    });

    const results = await curator.runAllActivePeers();
    expect(results.length).toBe(1);
    expect(mockAgentsService.create).toHaveBeenCalledTimes(1);
  });

  it('契约 11: 会话独立计时与打标完成重置：未满周期跳过，满周期触发，打标完成后重置该 peer 专属倒计时', async () => {
    const mockAgentHandle = {
      dispose: vi.fn().mockResolvedValue(undefined),
      agent: { followup: vi.fn(), whenIdle: vi.fn().mockResolvedValue(undefined) },
    };
    const mockAgentsService = {
      create: vi.fn().mockResolvedValue(mockAgentHandle),
    };

    const curator = new FaceCurator({
      ctx: { agents: mockAgentsService } as any,
      db,
      faceStoreDir,
      config: () => ({ face_enabled: true, face_auto_curate: true, face_curate_interval_mins: 60 }),
    });

    db.saveSessionState({
      peer: 'group_interval_peer',
      current_session_id: 'qq-group-interval_peer',
    });
    db.saveMessage({
      msg_id: 100,
      peer: 'group_interval_peer',
      user_id: '1001',
      sender_name: 'Tester',
      time: Date.now(),
      type: 'image',
      content: '[图片]',
      self: 0,
      raw: {},
    });

    // 1. 刚启动，距 startTime 仅 0ms，未满 60 分钟 -> 跳过
    let results = await curator.runAllActivePeers();
    expect(results.length).toBe(0);
    expect(mockAgentsService.create).not.toHaveBeenCalled();

    // 2. 模拟 61 分钟已过 (修改该 peer 上次完成时间)
    curator.setLastCuratedAt('group_interval_peer', Date.now() - 61 * 60 * 1000);
    results = await curator.runAllActivePeers();
    expect(results.length).toBe(1);
    expect(mockAgentsService.create).toHaveBeenCalledTimes(1);

    // 3. 验证打标完成后，该 peer 的 lastCuratedAt 已被刷新至最新完成时间
    const updatedLastAt = curator.getLastCuratedAt('group_interval_peer');
    expect(Date.now() - updatedLastAt).toBeLessThan(2000);

    // 4. 再次巡检，因为刚重置倒计时（0 分钟 < 60 分钟），再次跳过
    mockAgentsService.create.mockClear();
    results = await curator.runAllActivePeers();
    expect(results.length).toBe(0);
    expect(mockAgentsService.create).not.toHaveBeenCalled();
  });

  it('契约 12: 用户新图判定 (self = 0)：机器人自身发送的图片消息 (self = 1) 绝不算作用户新图，不会误触发后台巡检', async () => {
    const mockAgentsService = {
      create: vi.fn(),
    };
    const curator = new FaceCurator({
      ctx: { agents: mockAgentsService } as any,
      db,
      faceStoreDir,
      config: () => ({ face_enabled: true, face_auto_curate: true, face_curate_interval_mins: 0 }),
    });

    db.saveSessionState({
      peer: 'group_bot_only',
      current_session_id: 'qq-group-bot_only',
    });

    // 只有机器人自己发出的图片 (self = 1)
    db.saveMessage({
      msg_id: 200,
      peer: 'group_bot_only',
      user_id: '888888',
      sender_name: 'BotSelf',
      time: Date.now(),
      type: 'image',
      content: '[图片]',
      self: 1,
      raw: {},
    });

    const results = await curator.runAllActivePeers();
    // 机器人自己的图片不触发后台巡检
    expect(results).toEqual([]);
    expect(mockAgentsService.create).not.toHaveBeenCalled();
  });

  it('契约 13: 多会话天然错峰：Peer A 与 Peer B 在不同时间点完成打标，各自的下次触发时间自然错开', async () => {
    const mockAgentHandle = {
      dispose: vi.fn().mockResolvedValue(undefined),
      agent: { followup: vi.fn(), whenIdle: vi.fn().mockResolvedValue(undefined) },
    };
    const mockAgentsService = {
      create: vi.fn().mockResolvedValue(mockAgentHandle),
    };

    const curator = new FaceCurator({
      ctx: { agents: mockAgentsService } as any,
      db,
      faceStoreDir,
      config: () => ({ face_enabled: true, face_auto_curate: true, face_curate_interval_mins: 60 }),
    });

    // 会话 A 和 会话 B
    db.saveSessionState({ peer: 'group_A', current_session_id: 'qq-group-A' });
    db.saveSessionState({ peer: 'group_B', current_session_id: 'qq-group-B' });

    db.saveMessage({
      msg_id: 301,
      peer: 'group_A',
      user_id: '1001',
      sender_name: 'UserA',
      time: Date.now(),
      type: 'image',
      content: '[图片]',
      self: 0,
      raw: {},
    });
    db.saveMessage({
      msg_id: 302,
      peer: 'group_B',
      user_id: '1002',
      sender_name: 'UserB',
      time: Date.now(),
      type: 'image',
      content: '[图片]',
      self: 0,
      raw: {},
    });

    // 设定 会话 A 已经过了 70 分钟，而 会话 B 只过了 20 分钟
    curator.setLastCuratedAt('group_A', Date.now() - 70 * 60 * 1000);
    curator.setLastCuratedAt('group_B', Date.now() - 20 * 60 * 1000);

    const results = await curator.runAllActivePeers();

    // 只有到期的 会话 A 触发巡检，会话 B 错峰等待
    expect(results.length).toBe(1);
    expect(results[0].peer).toBe('group_A');
    expect(mockAgentsService.create).toHaveBeenCalledTimes(1);

    // 会话 A 触发后被重置为当前时间
    expect(Date.now() - curator.getLastCuratedAt('group_A')).toBeLessThan(2000);
    // 会话 B 的计时保持原来的 20 分钟不变
    expect(Date.now() - curator.getLastCuratedAt('group_B')).toBeGreaterThan(15 * 60 * 1000);
  });
});
