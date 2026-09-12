import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fsp } from 'node:fs';
import { bootDshNapcatBridge, type BootedDsh } from '../../src/boot.js';
import { isSlashCommand, handleSlashCommand, formatTokens } from '../../src/commands/index.js';
import { SessionManager } from '../../src/gateway/session.js';

describe('契约测试: 两字中文斜杠命令与白名单门控 (Two-Character Chinese Commands Contract)', () => {
  let tmpHome: string;
  let booted: BootedDsh;

  beforeEach(async () => {
    tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-napcat-cmd-'));
    booted = await bootDshNapcatBridge({
      dshHome: tmpHome,
      mountPlugin: false,
    });
  });

  afterEach(async () => {
    if (booted) {
      await booted.dispose().catch(() => {});
    }
    if (tmpHome) {
      await fsp.rm(tmpHome, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('契约 1: isSlashCommand 识别半角/全角斜杠命令，handleSlashCommand 执行管理员白名单门控', async () => {
    const session = booted.ctx.sessions.create('qq-group-1001' as any);
    const admins = ['2000000001']; // 仅此 QQ 为管理员

    // 1. 普通消息不是命令
    expect(isSlashCommand('你好小助手')).toBe(false);

    // 2. / 开头识别为命令，且兼容全角 ／
    expect(isSlashCommand('/权限 编辑')).toBe(true);
    expect(isSlashCommand('/模型 deepseek-v4-flash')).toBe(true);
    expect(isSlashCommand('／状态')).toBe(true);

    // 3. 管理员执行成功（含全角斜杠兼容）
    const adminRes = await handleSlashCommand('/权限 编辑', {
      userId: '2000000001',
      admins,
      session,
      ctx: booted.ctx,
    });
    expect(adminRes.handled).toBe(true);
    expect(adminRes.success).toBe(true);

    const fullWidthRes = await handleSlashCommand('／权限 只读', {
      userId: '2000000001',
      admins,
      session,
      ctx: booted.ctx,
    });
    expect(fullWidthRes.handled).toBe(true);
    expect(fullWidthRes.success).toBe(true);

    // 4. 非管理员拒绝
    const nonAdminRes = await handleSlashCommand('/权限 完全', {
      userId: '1234567890',
      admins,
      session,
      ctx: booted.ctx,
    });
    expect(nonAdminRes.handled).toBe(true);
    expect(nonAdminRes.success).toBe(false);
    expect(nonAdminRes.error).toContain('权限不足');
    // 无 emoji
    expect(nonAdminRes.error).not.toMatch(/[\u{1F300}-\u{1F9FF}]/u);
  });

  it('契约 2: /权限 命令仅支持中文参数（只读/编辑/完全），无参展示当前模式，严格隔离并杜绝英文参数', async () => {
    const sessionA = booted.ctx.sessions.create('qq-group-1001' as any);
    const sessionB = booted.ctx.sessions.create('qq-group-1002' as any);
    const admins = ['2000000001'];

    // 切换群 A 为 完全 (danger-full-access)
    const resA = await handleSlashCommand('/权限 完全', {
      userId: '2000000001',
      admins,
      session: sessionA,
      ctx: booted.ctx,
    });
    expect(resA.success).toBe(true);
    expect(resA.reply).toBe('权限模式已切换为：完全');

    // 切换群 B 为 编辑 (workspace-write)
    const resB = await handleSlashCommand('/权限 编辑', {
      userId: '2000000001',
      admins,
      session: sessionB,
      ctx: booted.ctx,
    });
    expect(resB.success).toBe(true);
    expect(resB.reply).toBe('权限模式已切换为：编辑');

    // 契约断言: 会话级隔离生效，A 与 B 互不影响
    const presetsSvc = booted.ctx.permissionPresets;
    expect(presetsSvc.current(sessionA)).toBe('danger-full-access');
    expect(presetsSvc.current(sessionB)).toBe('workspace-write');

    // 无参数查询：返回中文友好模式名，符合用户预期
    const queryA = await handleSlashCommand('/权限', {
      userId: '2000000001',
      admins,
      session: sessionA,
      ctx: booted.ctx,
    });
    expect(queryA.reply).toBe('当前权限模式：完全');

    const queryB = await handleSlashCommand('/权限', {
      userId: '2000000001',
      admins,
      session: sessionB,
      ctx: booted.ctx,
    });
    expect(queryB.reply).toBe('当前权限模式：编辑');

    // 不再支持旧英文参数：拒绝并提示可用中文模式
    const invalidRes = await handleSlashCommand('/权限 yolo', {
      userId: '2000000001',
      admins,
      session: sessionA,
      ctx: booted.ctx,
    });
    expect(invalidRes.success).toBe(false);
    expect(invalidRes.error).toContain('无效的权限模式：yolo');
    expect(invalidRes.error).toContain('可用模式：只读、编辑、完全');
  });

  it('契约 3: /模型 普通命令仅落位当前 QQ 会话，无 emoji，不污染 Web UI 宿主全局默认', async () => {
    const sessionManager = new SessionManager(booted.ctx, tmpHome);
    const sessionA = booted.ctx.sessions.create('qq-group-1001' as any);
    const sessionB = booted.ctx.sessions.create('qq-group-1002' as any);
    const admins = ['2000000001'];

    const hostDefaultBefore = (booted.ctx as any).agentDefaultModel?.currentSelection?.();

    // 1. 切换 A 会话模型
    const resA = await handleSlashCommand('/模型 deepseek-v4-pro', {
      userId: '2000000001',
      admins,
      session: sessionA,
      ctx: booted.ctx,
      sessionManager,
    });
    expect(resA.handled).toBe(true);
    expect(resA.success).toBe(true);
    expect(resA.reply).toContain('当前会话模型已切换为：deepseek-official / deepseek-v4-pro');
    expect(resA.reply).not.toMatch(/[\u{1F300}-\u{1F9FF}]/u);

    // 2. A 会话选择已落位
    const selA = sessionManager.getModelSelection(sessionA.id);
    expect(selA?.provider).toBe('deepseek-official');
    expect(selA?.model).toBe('deepseek-v4-pro');

    // 3. B 会话选择不受影响（仍为旧默认）
    const selB = sessionManager.getModelSelection(sessionB.id);
    expect(selB?.model).not.toBe('deepseek-v4-pro');

    // 4. Web UI 宿主全局默认模型绝对未被修改
    const hostDefaultAfter = (booted.ctx as any).agentDefaultModel?.currentSelection?.();
    if (hostDefaultBefore) {
      expect(hostDefaultAfter).toEqual(hostDefaultBefore);
    }
  });

  it('契约 3b: /模型 支持 -g 与 --全局 参数切换 QQ 全局默认模型', async () => {
    const sessionManager = new SessionManager(booted.ctx, tmpHome);
    const sessionA = booted.ctx.sessions.create('qq-group-1001' as any);
    const sessionB = booted.ctx.sessions.create('qq-group-1002' as any);
    const admins = ['2000000001'];

    // 1. 执行全局切换命令（支持 --全局）
    const resGlobal = await handleSlashCommand('/模型 deepseek-v4-pro --全局', {
      userId: '2000000001',
      admins,
      session: sessionA,
      ctx: booted.ctx,
      sessionManager,
    });
    expect(resGlobal.handled).toBe(true);
    expect(resGlobal.success).toBe(true);
    expect(resGlobal.reply).toContain('QQ全局模型已切换为：deepseek-official / deepseek-v4-pro');
    expect(resGlobal.reply).not.toMatch(/[\u{1F300}-\u{1F9FF}]/u);

    // 2. 所有已知的 QQ 会话（A 与 B）均被批量更新为新模型
    const selA = sessionManager.getModelSelection(sessionA.id);
    const selB = sessionManager.getModelSelection(sessionB.id);
    expect(selA?.model).toBe('deepseek-v4-pro');
    expect(selB?.model).toBe('deepseek-v4-pro');

    // 3. 容错测试：支持 -g 简写
    const resPrefix = await handleSlashCommand('/模型 -g deepseek-v4-flash', {
      userId: '2000000001',
      admins,
      session: sessionA,
      ctx: booted.ctx,
      sessionManager,
    });
    expect(resPrefix.success).toBe(true);
    expect(sessionManager.getModelSelection(sessionA.id)?.model).toBe('deepseek-v4-flash');
    expect(sessionManager.getModelSelection(sessionB.id)?.model).toBe('deepseek-v4-flash');
  });

  it('契约 3c: /模型 空参数查询呈现当前会话模型、QQ全局模型及帮助说明，无 emoji', async () => {
    const sessionManager = new SessionManager(booted.ctx, tmpHome);
    const sessionA = booted.ctx.sessions.create('qq-group-1001' as any);
    const admins = ['2000000001'];

    const res = await handleSlashCommand('/模型', {
      userId: '2000000001',
      admins,
      session: sessionA,
      ctx: booted.ctx,
      sessionManager,
    });

    expect(res.handled).toBe(true);
    expect(res.success).toBe(true);
    expect(res.reply).toContain('当前会话模型：');
    expect(res.reply).toContain('QQ全局默认：');
    expect(res.reply).toContain('可用模型列表：');
    expect(res.reply).toContain('--全局');
    expect(res.reply).not.toMatch(/[\u{1F300}-\u{1F9FF}]/u);
  });

  it('契约 4: /新建 开启全新会话且不归档原会话（清空当前上下文，原会话进历史）', async () => {
    const sessionManager = new SessionManager(booted.ctx, tmpHome);
    const sessionA = booted.ctx.sessions.create('qq-group-1001' as any);
    const admins = ['2000000001'];

    expect(sessionManager.peerToSessionId('group_1001')).toBe('qq-group-1001');

    const res = await handleSlashCommand('/新建', {
      userId: '2000000001',
      admins,
      session: sessionA,
      ctx: booted.ctx,
      sessionManager,
    });
    expect(res.handled).toBe(true);
    expect(res.success).toBe(true);
    expect(res.reply).toBe('已开启新会话（原会话已保留归档，新消息将计入新会话）。');
    expect(res.reply).not.toMatch(/[\u{1F300}-\u{1F9FF}]/u);

    // 1. 清空后 peer 映射到全新版本会话
    expect(sessionManager.peerToSessionId('group_1001')).toBe('qq-group-1001-2');
  });

  it('契约 5: /停止 命令停止当前生成，回复无 emoji', async () => {
    const session = booted.ctx.sessions.create('qq-group-1001' as any);
    const admins = ['2000000001'];

    let cancelCalledWith: any = null;
    const mockController = {
      cancel: async (req: any) => {
        cancelCalledWith = req;
        return { accepted: true };
      },
    };
    (booted.ctx as any).provide('sessionController', mockController);

    const adminRes = await handleSlashCommand('/停止', {
      userId: '2000000001',
      admins,
      session,
      ctx: booted.ctx,
    });
    expect(adminRes.handled).toBe(true);
    expect(adminRes.success).toBe(true);
    expect(adminRes.reply).toBe('已停止当前生成。');
    expect(adminRes.reply).not.toMatch(/[\u{1F300}-\u{1F9FF}]/u);
    expect(cancelCalledWith).toEqual({ sessionId: session.id });
  });

  it('契约 6: 不再响应旧英文命令（如 /help, /model, /clear 等均报未知指令）', async () => {
    const session = booted.ctx.sessions.create('qq-group-1001' as any);
    const admins = ['2000000001'];

    const oldCommands = ['/help', '/model', '/clear', '/new', '/stop', '/ctx', '/mode', '/think', '/resume'];
    for (const cmd of oldCommands) {
      const res = await handleSlashCommand(cmd, {
        userId: '2000000001',
        admins,
        session,
        ctx: booted.ctx,
      });
      expect(res.handled).toBe(true);
      expect(res.success).toBe(false);
      expect(res.error).toContain(`未知指令：${cmd}，输入 /帮助 查看可用指令`);
    }
  });

  it('契约 7: /会话 命令无参列出历史会话，支持序号或标题切换，无 emoji', async () => {
    const sessionManager = new SessionManager(booted.ctx, tmpHome);
    const admins = ['2000000001'];

    const s1 = booted.ctx.sessions.create('qq-group-1003' as any);
    const s2 = booted.ctx.sessions.create('qq-group-1003-2' as any);
    const s3 = booted.ctx.sessions.create('qq-group-1003-3' as any);

    sessionManager.setPeerName('group_1003', '摸鱼交流群');

    // 1. /会话 无参：列出历史会话
    const listRes = await handleSlashCommand('/会话', {
      userId: '2000000001',
      admins,
      session: s3,
      ctx: booted.ctx,
      sessionManager,
    });
    expect(listRes.handled).toBe(true);
    expect(listRes.success).toBe(true);
    expect(listRes.reply).toContain('历史会话列表');
    expect(listRes.reply).toContain('qq-group-1003-3');
    expect(listRes.reply).toContain('qq-group-1003');
    expect(listRes.reply).not.toMatch(/[\u{1F300}-\u{1F9FF}]/u);

    // 2. /会话 1 序号切换到最旧会话
    const resume1Res = await handleSlashCommand('/会话 1', {
      userId: '2000000001',
      admins,
      session: s3,
      ctx: booted.ctx,
      sessionManager,
    });
    expect(resume1Res.success).toBe(true);
    expect(resume1Res.reply).toContain('已切换到会话：');
    expect(resume1Res.reply).toContain('qq-group-1003');
    expect(sessionManager.peerToSessionId('group_1003')).toBe('qq-group-1003');

    // 3. /会话 #2 按标题或版本特征切换
    const resumeTitleRes = await handleSlashCommand('/会话 #2', {
      userId: '2000000001',
      admins,
      session: s1,
      ctx: booted.ctx,
      sessionManager,
    });
    expect(resumeTitleRes.success).toBe(true);
    expect(resumeTitleRes.reply).toContain('qq-group-1003-2');
    expect(sessionManager.peerToSessionId('group_1003')).toBe('qq-group-1003-2');
  });

  it('契约 8: /用量 命令测量上下文用量明细，无 emoji', async () => {
    const session = booted.ctx.sessions.create('qq-group-1004' as any);
    const admins = ['2000000001'];

    const tokenMeter = booted.ctx.get('tokenMeter') || (booted.ctx as any).tokenMeter;
    const originalMeasure = tokenMeter?.measure;
    if (tokenMeter) {
      tokenMeter.measure = () => ({
        totalTokens: 250000,
        surfaceTokens: 113000,
      });
    }

    const sessionProjections = booted.ctx.get('sessionProjections') || (booted.ctx as any).sessionProjections;
    const originalSnapshot = sessionProjections?.snapshot;
    if (sessionProjections) {
      sessionProjections.snapshot = () => ({
        asOfSeq: 1,
        values: {
          contextPressure: { contextWindow: 1000000 },
          contextBreakdown: {
            systemTokens: 1700,
            toolsTokens: 17000,
            messageTokens: 113000,
          },
        },
      });
    }

    try {
      const res = await handleSlashCommand('/用量', {
        userId: '2000000001',
        admins,
        session,
        ctx: booted.ctx,
      });
      expect(res.handled).toBe(true);
      expect(res.success).toBe(true);
      expect(res.reply).toContain('上下文已用：~250K / 1M (25%)');
      expect(res.reply).toContain('系统提示词：~1.7K');
      expect(res.reply).toContain('工具声明：~17K');
      expect(res.reply).toContain('对话消息：~113K');
      expect(res.reply).not.toMatch(/[\u{1F300}-\u{1F9FF}]/u);
    } finally {
      if (tokenMeter && originalMeasure) tokenMeter.measure = originalMeasure;
      if (sessionProjections && originalSnapshot) sessionProjections.snapshot = originalSnapshot;
    }
  });

  it('契约 9: /帮助 命令输出 9 个两字中文指令，无 emoji', async () => {
    const session = booted.ctx.sessions.create('qq-group-1005' as any);
    const admins = ['2000000001'];

    const adminRes = await handleSlashCommand('/帮助', {
      userId: '2000000001',
      admins,
      session,
      ctx: booted.ctx,
    });
    expect(adminRes.handled).toBe(true);
    expect(adminRes.success).toBe(true);
    const reply = adminRes.reply!;
    expect(reply).toContain('【快捷指令帮助】');
    expect(reply).toContain('/状态');
    expect(reply).toContain('/模型');
    expect(reply).toContain('/权限');
    expect(reply).toContain('/思考');
    expect(reply).toContain('/会话');
    expect(reply).toContain('/新建');
    expect(reply).toContain('/用量');
    expect(reply).toContain('/停止');
    expect(reply).toContain('/帮助');
    expect(reply).not.toMatch(/[\u{1F300}-\u{1F9FF}]/u);
  });

  it('契约 10: /思考 命令保留英文档位参数方便输入，无 emoji', async () => {
    const sessionManager = new SessionManager(booted.ctx, tmpHome);
    const session = booted.ctx.sessions.create('qq-group-1010' as any);
    const admins = ['2000000001'];

    // 1. 无参查询
    const queryRes = await handleSlashCommand('/思考', {
      userId: '2000000001',
      admins,
      session,
      ctx: booted.ctx,
      sessionManager,
    });
    expect(queryRes.success).toBe(true);
    expect(queryRes.reply).toContain('当前思考强度：');
    expect(queryRes.reply).toContain('支持的思考档位：');
    expect(queryRes.reply).not.toMatch(/[\u{1F300}-\u{1F9FF}]/u);

    // 2. 切换 max 档位
    const setRes = await handleSlashCommand('/思考 max', {
      userId: '2000000001',
      admins,
      session,
      ctx: booted.ctx,
      sessionManager,
    });
    expect(setRes.success).toBe(true);
    expect(setRes.reply).toContain('当前会话思考深度已切换为：max (Max)');
    expect(setRes.reply).not.toMatch(/[\u{1F300}-\u{1F9FF}]/u);

    // 3. 全局切换支持 --全局
    const globalRes = await handleSlashCommand('/思考 low --全局', {
      userId: '2000000001',
      admins,
      session,
      ctx: booted.ctx,
      sessionManager,
    });
    expect(globalRes.success).toBe(true);
    expect(globalRes.reply).toContain('QQ全局思考深度已切换为：low (Low)');
  });

  it('契约 11: /状态 命令汇总模型、思考等级、权限模式、上下文用量及运行状态', async () => {
    const sessionManager = new SessionManager(booted.ctx, tmpHome);
    const session = booted.ctx.sessions.create('qq-group-1020' as any);
    const admins = ['2000000001'];

    sessionManager.setModelSelection(session.id, 'deepseek-official', 'deepseek-v4-pro', 'high');
    booted.ctx.permissionPresets.set(session, 'danger-full-access');

    // 1. 空闲状态查询
    const idleRes = await handleSlashCommand('/状态', {
      userId: '2000000001',
      admins,
      session,
      ctx: booted.ctx,
      sessionManager,
    });
    expect(idleRes.handled).toBe(true);
    expect(idleRes.success).toBe(true);
    const idleReply = idleRes.reply!;
    expect(idleReply).toContain('【当前会话状态】');
    expect(idleReply).toContain('运行状态：空闲');
    expect(idleReply).toContain('当前模型：deepseek-official / deepseek-v4-pro');
    expect(idleReply).toContain('思考等级：high');
    expect(idleReply).toContain('权限模式：完全');
    expect(idleReply).toContain('上下文用量：');
    expect(idleReply).toContain('会话标识：');
    expect(idleReply).not.toMatch(/[\u{1F300}-\u{1F9FF}]/u);

    // 2. 运行中状态查询（模拟 activeTurn）
    const mockOutbound = {
      getActiveTurn: (_peer: string) => 3,
    };
    (sessionManager as any).setOutboundBridge?.(mockOutbound);

    const busyRes = await handleSlashCommand('/状态', {
      userId: '2000000001',
      admins,
      session,
      ctx: booted.ctx,
      sessionManager,
    });
    expect(busyRes.success).toBe(true);
    expect(busyRes.reply).toContain('运行状态：正在运行（轮次 #3）');
  });

  it('契约 12: /模型 优化：唯一模型 ID 智能匹配、空格多词匹配及供应商显式指定', async () => {
    const sessionManager = new SessionManager(booted.ctx, tmpHome);
    const session = booted.ctx.sessions.create('qq-group-1030' as any);
    const admins = ['2000000001'];

    // 1. 唯一模型 ID 免输供应商：/模型 deepseek-v4-flash
    const res1 = await handleSlashCommand('/模型 deepseek-v4-flash', {
      userId: '2000000001',
      admins,
      session,
      ctx: booted.ctx,
      sessionManager,
    });
    expect(res1.success).toBe(true);
    expect(sessionManager.getModelSelection(session.id)?.provider).toBe('deepseek-official');
    expect(sessionManager.getModelSelection(session.id)?.model).toBe('deepseek-v4-flash');

    // 2. 空格多词智能匹配：/模型 deepseek flash -> 匹配到 deepseek-flash
    const res2 = await handleSlashCommand('/模型 deepseek flash', {
      userId: '2000000001',
      admins,
      session,
      ctx: booted.ctx,
      sessionManager,
    });
    expect(res2.success).toBe(true);
    expect(sessionManager.getModelSelection(session.id)?.model).toBe('deepseek-flash');

    // 3. 显式指定供应商与模型：/模型 deepseek-official deepseek-v4-pro
    const res3 = await handleSlashCommand('/模型 deepseek-official deepseek-v4-pro', {
      userId: '2000000001',
      admins,
      session,
      ctx: booted.ctx,
      sessionManager,
    });
    expect(res3.success).toBe(true);
    expect(sessionManager.getModelSelection(session.id)?.model).toBe('deepseek-v4-pro');
  });
});





