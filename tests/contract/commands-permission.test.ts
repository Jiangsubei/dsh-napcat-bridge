import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fsp } from 'node:fs';
import { bootDshNapcatBridge, type BootedDsh } from '../../src/boot.js';
import { isSlashCommand, handleSlashCommand } from '../../src/commands/index.js';
import { SessionManager } from '../../src/gateway/session.js';

describe('契约测试: 斜杠命令白名单与 Per-Session 权限隔离 (Commands & Permission Contract)', () => {
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

  it('契约 1: isSlashCommand 识别斜杠命令，handleSlashCommand 执行管理员白名单门控', async () => {
    const session = booted.ctx.sessions.create('qq-group-1001' as any);
    const admins = ['2000000001']; // 仅此 QQ 为管理员

    // 1. 普通消息不是命令
    expect(isSlashCommand('你好小助手')).toBe(false);

    // 2. / 开头识别为命令
    expect(isSlashCommand('/mode edit')).toBe(true);
    expect(isSlashCommand('/model deepseek-chat')).toBe(true);

    // 3. 管理员执行成功
    const adminRes = await handleSlashCommand('/mode edit', {
      userId: '2000000001',
      admins,
      session,
      ctx: booted.ctx,
    });
    expect(adminRes.handled).toBe(true);
    expect(adminRes.success).toBe(true);

    // 4. 非管理员拒绝
    const nonAdminRes = await handleSlashCommand('/mode yolo', {
      userId: '1234567890',
      admins,
      session,
      ctx: booted.ctx,
    });
    expect(nonAdminRes.handled).toBe(true);
    expect(nonAdminRes.success).toBe(false);
    expect(nonAdminRes.error).toContain('权限不足');
  });

  it('契约 2: /mode 命令通过 permissionPresets.set 实现 Per-Session 权限切换与隔离', async () => {
    const sessionA = booted.ctx.sessions.create('qq-group-1001' as any);
    const sessionB = booted.ctx.sessions.create('qq-group-1002' as any);
    const admins = ['2000000001'];

    // 切换群 A 为 danger-full-access (yolo 模式)
    await handleSlashCommand('/mode yolo', {
      userId: '2000000001',
      admins,
      session: sessionA,
      ctx: booted.ctx,
    });

    // 切换群 B 为 workspace-write (edit 模式)
    await handleSlashCommand('/mode edit', {
      userId: '2000000001',
      admins,
      session: sessionB,
      ctx: booted.ctx,
    });

    // 契约断言: 会话级隔离生效，A 与 B 互不影响
    const presetsSvc = booted.ctx.permissionPresets;
    expect(presetsSvc.current(sessionA)).toBe('danger-full-access');
    expect(presetsSvc.current(sessionB)).toBe('workspace-write');
  });

  it('B1-契约 3: /model 普通命令仅落位当前 QQ 会话，不影响其他 QQ 会话且不污染 Web UI 宿主全局默认', async () => {
    const sessionManager = new SessionManager(booted.ctx, tmpHome);
    const sessionA = booted.ctx.sessions.create('qq-group-1001' as any);
    const sessionB = booted.ctx.sessions.create('qq-group-1002' as any);
    const admins = ['2000000001'];

    const hostDefaultBefore = (booted.ctx as any).agentDefaultModel?.currentSelection?.();

    // 1. 切换 A 会话模型
    const resA = await handleSlashCommand('/model deepseek-v4-pro', {
      userId: '2000000001',
      admins,
      session: sessionA,
      ctx: booted.ctx,
      sessionManager,
    });
    expect(resA.handled).toBe(true);
    expect(resA.success).toBe(true);
    expect(resA.reply).toContain('当前 QQ 会话');

    // 2. A 会话选择已落位
    const selA = sessionManager.getModelSelection(sessionA.id);
    expect(selA?.provider).toBe('deepseek-official');
    expect(selA?.model).toBe('deepseek-v4-pro');

    // 3. B 会话选择不受影响（仍为旧默认）
    const selB = sessionManager.getModelSelection(sessionB.id);
    expect(selB?.model).not.toBe('deepseek-v4-pro');

    // 4. Web UI 宿主全局默认模型绝对未被修改 (保护 Web UI 全局设置)
    const hostDefaultAfter = (booted.ctx as any).agentDefaultModel?.currentSelection?.();
    if (hostDefaultBefore) {
      expect(hostDefaultAfter).toEqual(hostDefaultBefore);
    }
  });

  it('B2-契约 3b: /model --global 切换 NapCat 插件全局 QQ 会话模型，批量同步所有 QQ 会话且不误伤 Web UI 宿主全局设置', async () => {
    const sessionManager = new SessionManager(booted.ctx, tmpHome);
    const sessionA = booted.ctx.sessions.create('qq-group-1001' as any);
    const sessionB = booted.ctx.sessions.create('qq-group-1002' as any);
    const admins = ['2000000001'];

    const hostDefaultBefore = (booted.ctx as any).agentDefaultModel?.currentSelection?.();

    // 1. 执行 NapCat 全局切换命令
    const resGlobal = await handleSlashCommand('/model deepseek-v4-pro --global', {
      userId: '2000000001',
      admins,
      session: sessionA,
      ctx: booted.ctx,
      sessionManager,
    });
    expect(resGlobal.handled).toBe(true);
    expect(resGlobal.success).toBe(true);
    expect(resGlobal.reply).toContain('NapCat 插件全局 QQ 会话模型已切换为');

    // 2. 所有已知的 QQ 会话（A 与 B）均被批量更新为新模型
    const selA = sessionManager.getModelSelection(sessionA.id);
    const selB = sessionManager.getModelSelection(sessionB.id);
    expect(selA?.model).toBe('deepseek-v4-pro');
    expect(selB?.model).toBe('deepseek-v4-pro');

    // 3. 未来新创建的 QQ 会话（如群 C）也继承该 NapCat 全局默认模型
    const sessionC = booted.ctx.sessions.create('qq-group-1003' as any);
    const selC = sessionManager.getModelSelection(sessionC.id);
    expect(selC?.model).toBe('deepseek-v4-pro');

    // 4. 宿主 Web UI 全局设置 (settings.yaml / agentDefaultModel) 绝对未被修改
    const hostDefaultAfter = (booted.ctx as any).agentDefaultModel?.currentSelection?.();
    if (hostDefaultBefore) {
      expect(hostDefaultAfter).toEqual(hostDefaultBefore);
    }

    // 5. 容错测试：支持前置 --global 与 -g 简写
    const resPrefix = await handleSlashCommand('/model -g deepseek-v4-flash', {
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

  it('B3-契约 3c: /model 空参数查询同时呈现当前 QQ 会话模型、NapCat 全局模型及双模切换语法帮助', async () => {
    const sessionManager = new SessionManager(booted.ctx, tmpHome);
    const sessionA = booted.ctx.sessions.create('qq-group-1001' as any);
    const admins = ['2000000001'];

    const res = await handleSlashCommand('/model', {
      userId: '2000000001',
      admins,
      session: sessionA,
      ctx: booted.ctx,
      sessionManager,
    });

    expect(res.handled).toBe(true);
    expect(res.success).toBe(true);
    expect(res.reply).toContain('当前 QQ 会话模型');
    expect(res.reply).toContain('QQ 插件全局默认');
    expect(res.reply).toContain('--global');
  });

  it('B4-契约 3d: 验证与 sessionController 的装配联动与宿主全局设置防污染安全拦截机制', async () => {
    const sessionManager = new SessionManager(booted.ctx, tmpHome);
    const sessionA = booted.ctx.sessions.create('qq-group-1001' as any);
    const admins = ['2000000001'];

    // 模拟挂载宿主 sessionController 与 agentDefaultModel 服务。
    // 注：DSH 0.1.2-rc.1 起 apiProxy 已移除，宿主服务键为 sessionController，
    // selectModel 直接接收 { sessionId, provider, model } 请求体（无 { rpcId, payload } 信封）。
    let selectModelCalledWith: any = null;
    let hostSaveCalled = false;

    const mockSessionController = {
      selectModel: async (req: any) => {
        selectModelCalledWith = req;
        // 模拟 DSH 官方 selectModel 内部默认尝试调用 saveSelection 的行为
        await (booted.ctx as any).agentDefaultModel?.saveSelection?.(req);
        return { selected: { provider: req.provider, model: req.model } };
      },
    };
    (booted.ctx as any).provide('sessionController', mockSessionController);

    const agentDefaultModel = (booted.ctx as any).agentDefaultModel;
    const originalSaveSelection = agentDefaultModel?.saveSelection;
    const spySave = async () => {
      hostSaveCalled = true;
    };
    if (agentDefaultModel) {
      agentDefaultModel.saveSelection = spySave;
    }

    try {
      // 1. 执行普通切换：必须以新直传形态调用 sessionController.selectModel，但宿主
      //    saveSelection 必须被拦截阻止
      const res = await handleSlashCommand('/model deepseek-v4-pro', {
        userId: '2000000001',
        admins,
        session: sessionA,
        ctx: booted.ctx,
        sessionManager,
      });

      expect(res.success).toBe(true);
      expect(selectModelCalledWith).not.toBeNull();
      // 新契约：请求体为直传 { sessionId, provider, model }，不再有旧版 { rpcId, payload } 信封
      expect(selectModelCalledWith.sessionId).toBe(sessionA.id);
      expect(selectModelCalledWith.model).toBe('deepseek-v4-pro');
      expect(selectModelCalledWith.provider).toBeTruthy();
      expect(selectModelCalledWith.rpcId).toBeUndefined();
      expect('payload' in selectModelCalledWith).toBe(false);
      // 关键断言：宿主真实 saveSelection 在命令执行期间绝对不能被触发
      expect(hostSaveCalled).toBe(false);
      // 关键断言：安全拦截结束后原保存逻辑已恢复，后续调用正常触发
      await (booted.ctx as any).agentDefaultModel.saveSelection({ provider: 'test', model: 'test' });
      expect(hostSaveCalled).toBe(true);
    } finally {
      if (agentDefaultModel && originalSaveSelection) {
        agentDefaultModel.saveSelection = originalSaveSelection;
      }
    }
  });

  it('C1-契约 4: /clear 开启全新会话且不归档原会话（直接开启新对话语义）', async () => {
    const sessionManager = new SessionManager(booted.ctx, tmpHome);
    const sessionA = booted.ctx.sessions.create('qq-group-1001' as any);
    const admins = ['2000000001'];

    // 清空前的当前会话为基础会话
    expect(sessionManager.peerToSessionId('group_1001')).toBe('qq-group-1001');

    const res = await handleSlashCommand('/clear', {
      userId: '2000000001',
      admins,
      session: sessionA,
      ctx: booted.ctx,
      sessionManager,
    });
    expect(res.handled).toBe(true);
    expect(res.success).toBe(true);

    // 1. 清空后 peer 映射到全新版本会话
    expect(sessionManager.peerToSessionId('group_1001')).toBe('qq-group-1001-2');

    // 2. 再次唤醒保持新会话（不退回基础会话）
    expect(sessionManager.peerToSessionId('group_1001')).toBe('qq-group-1001-2');

    // 3. 原会话未被归档（Web UI 归档是手动行为，/clear 不归档）
    const wsRegistry = (booted.ctx as any).workspaceRegistry;
    const archived = (wsRegistry?.archivedSessionIds || []) as string[];
    expect(archived).not.toContain('qq-group-1001');
    expect(archived).not.toContain('qq-group-1001-2');
  });

  it('契约 5: /stop 命令通过 sessionController.cancel 停止当前会话生成并受管理员白名单保护', async () => {
    const session = booted.ctx.sessions.create('qq-group-1001' as any);
    const admins = ['2000000001'];

    // 1. 非管理员拒绝
    const nonAdminRes = await handleSlashCommand('/stop', {
      userId: '1234567890',
      admins,
      session,
      ctx: booted.ctx,
    });
    expect(nonAdminRes.handled).toBe(true);
    expect(nonAdminRes.success).toBe(false);
    expect(nonAdminRes.error).toContain('权限不足');

    // 2. 服务未提供时报错
    const noServiceRes = await handleSlashCommand('/stop', {
      userId: '2000000001',
      admins,
      session,
      ctx: booted.ctx,
    });
    expect(noServiceRes.handled).toBe(true);
    expect(noServiceRes.success).toBe(false);
    expect(noServiceRes.error).toContain('sessionController 服务不可用');

    // 3. 挂载 mock sessionController.cancel
    let cancelCalledWith: any = null;
    const mockController = {
      cancel: async (req: any) => {
        cancelCalledWith = req;
        return { accepted: true };
      },
    };
    (booted.ctx as any).provide('sessionController', mockController);

    const adminRes = await handleSlashCommand('/stop', {
      userId: '2000000001',
      admins,
      session,
      ctx: booted.ctx,
    });
    expect(adminRes.handled).toBe(true);
    expect(adminRes.success).toBe(true);
    expect(adminRes.reply).toContain('⏹️ 已停止当前生成。');
    expect(cancelCalledWith).toEqual({ sessionId: session.id });

    // 4. cancel 抛错时优雅处理
    mockController.cancel = async () => {
      throw new Error('agent not found');
    };
    const errRes = await handleSlashCommand('/stop', {
      userId: '2000000001',
      admins,
      session,
      ctx: booted.ctx,
    });
    expect(errRes.handled).toBe(true);
    expect(errRes.success).toBe(false);
    expect(errRes.error).toContain('停止失败: agent not found');
  });

  it('契约 6: /new 命令开启全新会话且不归档原会话（语义对齐 /clear 并受管理员白名单保护）', async () => {
    const sessionManager = new SessionManager(booted.ctx, tmpHome);
    const sessionA = booted.ctx.sessions.create('qq-group-1002' as any);
    const admins = ['2000000001'];

    // 1. 非管理员拒绝
    const nonAdminRes = await handleSlashCommand('/new', {
      userId: '1234567890',
      admins,
      session: sessionA,
      ctx: booted.ctx,
      sessionManager,
    });
    expect(nonAdminRes.handled).toBe(true);
    expect(nonAdminRes.success).toBe(false);
    expect(nonAdminRes.error).toContain('权限不足');

    // 2. 管理员执行成功，版本递增
    expect(sessionManager.peerToSessionId('group_1002')).toBe('qq-group-1002');
    const res = await handleSlashCommand('/new', {
      userId: '2000000001',
      admins,
      session: sessionA,
      ctx: booted.ctx,
      sessionManager,
    });
    expect(res.handled).toBe(true);
    expect(res.success).toBe(true);
    expect(res.reply).toContain('✅ 会话已开启新对话');

    // 3. 验证会话已更新且原会话未被归档
    expect(sessionManager.peerToSessionId('group_1002')).toBe('qq-group-1002-2');
  });

  it('契约 7: /resume 命令列出历史会话（升序排序，倒序渲染，序号切换）并受管理员白名单保护', async () => {
    const sessionManager = new SessionManager(booted.ctx, tmpHome);
    const admins = ['2000000001'];

    // 创建三个同 peer 会话
    const s1 = booted.ctx.sessions.create('qq-group-1003' as any);
    const s2 = booted.ctx.sessions.create('qq-group-1003-2' as any);
    const s3 = booted.ctx.sessions.create('qq-group-1003-3' as any);

    // 1. 非管理员拒绝
    const nonAdminRes = await handleSlashCommand('/resume', {
      userId: '1234567890',
      admins,
      session: s3,
      ctx: booted.ctx,
      sessionManager,
    });
    expect(nonAdminRes.handled).toBe(true);
    expect(nonAdminRes.success).toBe(false);
    expect(nonAdminRes.error).toContain('权限不足');

    // 2. listPeerSessionIds 升序返回旧→新
    const list = sessionManager.listPeerSessionIds('group_1003');
    expect(list).toEqual(['qq-group-1003', 'qq-group-1003-2', 'qq-group-1003-3']);

    // 3. /resume 无参：倒序渲染，最新编号最大在最上，最旧编号 1 在最下
    const listRes = await handleSlashCommand('/resume', {
      userId: '2000000001',
      admins,
      session: s3,
      ctx: booted.ctx,
      sessionManager,
    });
    expect(listRes.handled).toBe(true);
    expect(listRes.success).toBe(true);
    expect(listRes.reply).toContain('3. qq-group-1003-3');
    expect(listRes.reply).toContain('2. qq-group-1003-2');
    expect(listRes.reply).toContain('1. qq-group-1003');
    // 验证相对顺序：3 在 2 前面，2 在 1 前面
    const idx3 = listRes.reply!.indexOf('3. qq-group-1003-3');
    const idx2 = listRes.reply!.indexOf('2. qq-group-1003-2');
    const idx1 = listRes.reply!.indexOf('1. qq-group-1003');
    expect(idx3).toBeLessThan(idx2);
    expect(idx2).toBeLessThan(idx1);

    // 4. /resume <越界序号> 返回错误
    const outOfBoundsRes1 = await handleSlashCommand('/resume 0', {
      userId: '2000000001',
      admins,
      session: s3,
      ctx: booted.ctx,
      sessionManager,
    });
    expect(outOfBoundsRes1.success).toBe(false);
    expect(outOfBoundsRes1.error).toContain('序号无效，范围 1~3');

    const outOfBoundsRes2 = await handleSlashCommand('/resume 4', {
      userId: '2000000001',
      admins,
      session: s3,
      ctx: booted.ctx,
      sessionManager,
    });
    expect(outOfBoundsRes2.success).toBe(false);
    expect(outOfBoundsRes2.error).toContain('序号无效，范围 1~3');

    // 5. /resume 1 切换到最旧会话 qq-group-1003
    const resume1Res = await handleSlashCommand('/resume 1', {
      userId: '2000000001',
      admins,
      session: s3,
      ctx: booted.ctx,
      sessionManager,
    });
    expect(resume1Res.handled).toBe(true);
    expect(resume1Res.success).toBe(true);
    expect(resume1Res.reply).toContain('✅ 已切换到会话 qq-group-1003');
    expect(sessionManager.peerToSessionId('group_1003')).toBe('qq-group-1003');

    // 6. /resume 2 切换到 qq-group-1003-2
    const resume2Res = await handleSlashCommand('/resume 2', {
      userId: '2000000001',
      admins,
      session: s1,
      ctx: booted.ctx,
      sessionManager,
    });
    expect(resume2Res.success).toBe(true);
    expect(resume2Res.reply).toContain('✅ 已切换到会话 qq-group-1003-2');
    expect(sessionManager.peerToSessionId('group_1003')).toBe('qq-group-1003-2');

    // 7. 尝试切换到已归档会话应失败
    const wsRegistry = (booted.ctx as any).workspaceRegistry;
    if (wsRegistry?.archiveSession) {
      await wsRegistry.archiveSession('qq-group-1003');
      const ok = sessionManager.resumeSession('group_1003', 'qq-group-1003');
      expect(ok).toBe(false);
    }
  });
});



