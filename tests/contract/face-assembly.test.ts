/**
 * tests/contract/face-assembly.test.ts
 * 契约测试: 表情包模块真实装配闭环 (Real Assembly via bootDshNapcatBridge)
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { bootDshNapcatBridge, type BootedDsh } from '../../src/boot.js';
import * as NapCatBridgePlugin from '../../src/index.js';

describe('契约测试: 表情包系统真实装配闭环 (Face Assembly Contract)', () => {
  let booted: BootedDsh | null = null;
  let tmpHome: string | null = null;

  afterEach(async () => {
    if (booted) {
      await booted.dispose();
      booted = null;
    }
    if (tmpHome && fs.existsSync(tmpHome)) {
      try {
        fs.rmSync(tmpHome, { recursive: true, force: true });
      } catch {}
      tmpHome = null;
    }
  });

  it('装配 1: 默认状态 (face_enabled=false) 真实装配下绝不暴露表情工具', async () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-face-asm-off-'));
    booted = await bootDshNapcatBridge({
      dshHome: tmpHome,
      mountPlugin: false,
    });

    // 以默认配置 (face_enabled: false) 挂载插件
    await booted.ctx.plugin(NapCatBridgePlugin, {
      ws_port: 29991,
      face_enabled: false,
    });

    const toolsService = (booted.ctx.get('tools') || (booted.ctx as any).tools) as any;
    expect(toolsService).toBeDefined();

    expect(toolsService.get('list_faces')).toBeUndefined();
    expect(toolsService.get('send_face')).toBeUndefined();
    expect(toolsService.get('collect_face')).toBeUndefined();
  });

  it('装配 2: 开启总开关 (face_enabled=true) 真实装配下完整挂载表情工具并可执行', async () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-face-asm-on-'));
    booted = await bootDshNapcatBridge({
      dshHome: tmpHome,
      mountPlugin: false,
    });

    // 开启表情总开关挂载插件
    await booted.ctx.plugin(NapCatBridgePlugin, {
      ws_port: 29992,
      face_enabled: true,
      face_store_max: 50,
      face_sub_type: 1,
    });

    const provider = (booted.ctx.get('napcatBridgeTools') || (booted.ctx as any).napcatBridgeTools) as any;
    expect(provider).toBeDefined();

    // 挂载到测试上下文获取注册工具
    provider.registerTools(booted.ctx);

    const toolsService = (booted.ctx.get('tools') || (booted.ctx as any).tools) as any;
    expect(toolsService).toBeDefined();

    const listFacesTool = toolsService.get('list_faces');
    const sendFaceTool = toolsService.get('send_face');
    const collectFaceTool = toolsService.get('collect_face');

    expect(listFacesTool).toBeDefined();
    expect(sendFaceTool).toBeDefined();
    expect(collectFaceTool).toBeDefined();

    // 验证真实工具可执行且返回结构符合契约
    const res = await listFacesTool.execute({}, { agent: { session: { id: 'qq-group-8000000002' } } });
    expect(res).toBeDefined();
    expect(res.faces).toEqual([]);
    expect(res.total).toBe(0);

    // 验证插入未打标表情后执行 list_faces 返回结果严格满足 Lossless JSON
    const dbPath = path.join(tmpHome, 'napcat', 'messages.sqlite');
    const { MessageDatabase } = await import('../../src/storage/database.js');
    const db = new MessageDatabase(dbPath);
    db.init();
    db.insertFace({
      id: 'face_test_lossless',
      file_path: '/fake/path/lossless.png',
      md5: 'md5_lossless_test',
      source: 'manual',
      tags: [],
      size: 100,
      format: 'png',
    });
    db.close();

    const res2 = await listFacesTool.execute({}, { agent: { session: { id: 'qq-group-8000000002' } } });
    expect(res2.faces).toHaveLength(1);
    expect(res2.faces[0].id).toBe('face_test_lossless');
    expect(Object.hasOwn(res2.faces[0], 'mood')).toBe(false);
    expect(Object.hasOwn(res2, 'next_cursor')).toBe(false);
  });

  it('装配 3: 表情工具仅限 QQ 会话呈现与执行 — WebUI 隔离且从 assemble 中剔除，QQ 与 curator- 会话放行', async () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-face-asm-guard-'));
    booted = await bootDshNapcatBridge({
      dshHome: tmpHome,
      mountPlugin: false,
    });

    await booted.ctx.plugin(NapCatBridgePlugin, {
      ws_port: 29993,
      face_enabled: true,
    });

    const FACE_TOOL_NAMES = new Set(['list_faces', 'send_face', 'collect_face']);

    const webWs = path.join(tmpHome, 'web-ws');
    const qqWs = path.join(tmpHome, 'qq-ws');
    const curatorWs = path.join(tmpHome, 'curator-ws');
    fs.mkdirSync(webWs, { recursive: true });
    fs.mkdirSync(qqWs, { recursive: true });
    fs.mkdirSync(curatorWs, { recursive: true });

    // 1. Web 会话 Agent: assemble 中不能包含表情工具
    const webHandle = await booted.ctx.agents.create({
      sessionId: 'web-session-face',
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      meta: { cwd: webWs },
    });
    const webAgent = webHandle.agent || webHandle;
    const asmWeb = await booted.ctx.systemPrompt.assemble({ scope: webAgent, agent: webAgent } as any);
    const webFaces = (asmWeb.tools as any[]).filter((t) => FACE_TOOL_NAMES.has(t.name));
    expect(webFaces).toHaveLength(0);

    // 2. Web 会话 Agent: 调用未在预设中的表情工具被 DSH 拦截拒绝
    const tools: any = booted.ctx.get('tools');
    const denied = await tools.execute({
      name: 'list_faces',
      arguments: {},
      agent: webAgent,
      signal: new AbortController().signal,
    });
    expect(denied.isError).toBe(true);

    // 3. QQ 会话 Agent: 挂载 qq-session 预设，assemble 中包含全量表情工具，调用放行
    const qqHandle = await booted.ctx.agents.create({
      sessionId: 'qq-group-8000000002',
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      meta: { cwd: qqWs },
      setup: async (agentCtx: any) => {
        await (booted.ctx as any).agentPresets.mount(agentCtx, 'qq-session');
      },
    });
    const qqAgent = qqHandle.agent || qqHandle;
    const asmQq = await booted.ctx.systemPrompt.assemble({ scope: qqAgent, agent: qqAgent } as any);
    const qqFaces = (asmQq.tools as any[]).filter((t) => FACE_TOOL_NAMES.has(t.name));
    expect(qqFaces.map((t) => t.name).sort()).toEqual([...FACE_TOOL_NAMES].sort());

    const allowed = await tools.execute({
      name: 'list_faces',
      arguments: {},
      agent: qqAgent,
      signal: new AbortController().signal,
    });
    expect(allowed.isError).toBe(false);

    // 4. curator- 临时巡检会话: 挂载 qq-session 预设，assemble 与调用均放行
    const curatorHandle = await booted.ctx.agents.create({
      sessionId: 'curator-group_8000000002-12345678',
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      meta: { cwd: curatorWs },
      setup: async (agentCtx: any) => {
        await (booted.ctx as any).agentPresets.mount(agentCtx, 'qq-session');
      },
    });
    const curatorAgent = curatorHandle.agent || curatorHandle;
    const asmCurator = await booted.ctx.systemPrompt.assemble({ scope: curatorAgent, agent: curatorAgent } as any);
    const curatorFaces = (asmCurator.tools as any[]).filter((t) => FACE_TOOL_NAMES.has(t.name));
    expect(curatorFaces.map((t) => t.name).sort()).toEqual([...FACE_TOOL_NAMES].sort());

    const curatorAllowed = await tools.execute({
      name: 'list_faces',
      arguments: {},
      agent: curatorAgent,
      signal: new AbortController().signal,
    });
    expect(curatorAllowed.isError).toBe(false);
  });

  it('装配 4: collect_face 收集表情包必须使用绝对路径规范落盘至 canonicalFaceStoreDir，绝不受 process.cwd 漂移影响', async () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-face-asm-path-'));
    booted = await bootDshNapcatBridge({
      dshHome: tmpHome,
      mountPlugin: false,
    });

    await booted.ctx.plugin(NapCatBridgePlugin, {
      ws_port: 29994,
      face_enabled: true,
    });

    const provider = (booted.ctx.get('napcatBridgeTools') || (booted.ctx as any).napcatBridgeTools) as any;
    provider.registerTools(booted.ctx);

    const toolsService = (booted.ctx.get('tools') || (booted.ctx as any).tools) as any;
    const collectFaceTool = toolsService.get('collect_face');

    // 准备一条包含本地图片的模拟消息
    const dbPath = path.join(tmpHome, 'napcat', 'messages.sqlite');
    const { MessageDatabase } = await import('../../src/storage/database.js');
    const db = new MessageDatabase(dbPath);
    db.init();

    const sampleImgPath = path.join(tmpHome, 'sample_meme.png');
    fs.writeFileSync(sampleImgPath, 'dummy-meme-content');

    db.saveMessage({
      msg_id: 8888,
      peer: 'group_1001',
      user_id: '12345',
      sender_name: 'TestUser',
      time: Date.now(),
      type: 'image',
      content: '[图片]',
      local_path: sampleImgPath,
      raw: {},
    });

    // 执行 collect_face
    const res = await collectFaceTool.execute(
      {
        message_id: 8888,
        tags: ['测试猫猫'],
        mood: '搞笑',
      },
      {
        agent: { session: { id: 'qq-group-1001' } },
      }
    );

    expect(res.success).toBe(true);
    expect(res.face_id).toBeDefined();

    // 验证落盘文件路径为绝对路径，且在 tmpHome/napcat/faces 下
    const faceRecord = db.getFaceById(res.face_id);
    expect(faceRecord).toBeDefined();
    expect(path.isAbsolute(faceRecord!.file_path)).toBe(true);
    const expectedDir = path.resolve(tmpHome, 'napcat', 'faces');
    expect(faceRecord!.file_path.startsWith(expectedDir)).toBe(true);
    expect(fs.existsSync(faceRecord!.file_path)).toBe(true);
    db.close();
  });

  it('装配 5: 启动自愈迁移：若 faces 表中存在存量相对路径记录，启动时自动修复为绝对路径并从 profiles 目录找回物理文件', async () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-face-asm-mig-'));

    // 在插件挂载前，预置一个具有存量相对路径记录的 messages.sqlite
    const dbPath = path.join(tmpHome, 'napcat', 'messages.sqlite');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const { MessageDatabase } = await import('../../src/storage/database.js');
    const db = new MessageDatabase(dbPath);
    db.init();

    const md5 = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
    // 物理文件掉入 profiles/desktop/.dsh/napcat/faces 中
    const orphanDir = path.join(tmpHome, 'profiles', 'desktop', '.dsh', 'napcat', 'faces');
    fs.mkdirSync(orphanDir, { recursive: true });
    const orphanFile = path.join(orphanDir, `${md5}.jpg`);
    fs.writeFileSync(orphanFile, 'orphaned-meme-image-bytes');

    // 数据库存的是相对路径
    db.insertFace({
      id: 'face_orphan_1',
      file_path: `.dsh\\napcat\\faces\\${md5}.jpg`,
      md5,
      source: 'collect',
      tags: ['孤儿表情'],
      mood: '无奈',
      size: 100,
      format: 'jpg',
    });
    db.close();

    // 挂载插件，触发启动时自动迁移与自愈
    booted = await bootDshNapcatBridge({
      dshHome: tmpHome,
      mountPlugin: false,
    });

    await booted.ctx.plugin(NapCatBridgePlugin, {
      ws_port: 29995,
      face_enabled: true,
    });

    // 检查数据库记录已自愈为标准绝对路径
    const checkDb = new MessageDatabase(dbPath);
    checkDb.init();
    const migrated = checkDb.getFaceById('face_orphan_1');
    expect(migrated).toBeDefined();
    expect(path.isAbsolute(migrated!.file_path)).toBe(true);
    const canonicalExpected = path.join(tmpHome, 'napcat', 'faces', `${md5}.jpg`);
    expect(migrated!.file_path).toBe(canonicalExpected);
    // 物理文件已安全迁移到标准目录
    expect(fs.existsSync(canonicalExpected)).toBe(true);
    checkDb.close();
  });
});
