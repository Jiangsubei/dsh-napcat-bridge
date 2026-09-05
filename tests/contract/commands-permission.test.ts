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

  it('B4-契约 3d: 验证与 apiProxy 的装配联动与宿主全局设置防污染安全拦截机制', async () => {
    const sessionManager = new SessionManager(booted.ctx, tmpHome);
    const sessionA = booted.ctx.sessions.create('qq-group-1001' as any);
    const admins = ['2000000001'];

    // 模拟挂载宿主 apiProxy 与 agentDefaultModel 服务
    let selectModelCalledWith: any = null;
    let hostSaveCalled = false;

    const mockApiProxy = {
      sessions: {
        selectModel: async (req: any) => {
          selectModelCalledWith = req;
          // 模拟 DSH 官方 selectModel 内部默认尝试调用 saveSelection 的行为
          await (booted.ctx as any).agentDefaultModel?.saveSelection?.(req.payload);
          return { ok: true, value: { selected: req.payload } };
        },
      },
    };
    (booted.ctx as any).apiProxy = mockApiProxy;

    const agentDefaultModel = (booted.ctx as any).agentDefaultModel;
    const originalSaveSelection = agentDefaultModel?.saveSelection;
    const spySave = async () => {
      hostSaveCalled = true;
    };
    if (agentDefaultModel) {
      agentDefaultModel.saveSelection = spySave;
    }

    try {
      // 1. 执行普通切换：必须调用 apiProxy.sessions.selectModel，但宿主 saveSelection 必须被拦截阻止
      const res = await handleSlashCommand('/model deepseek-v4-pro', {
        userId: '2000000001',
        admins,
        session: sessionA,
        ctx: booted.ctx,
        sessionManager,
      });

      expect(res.success).toBe(true);
      expect(selectModelCalledWith).not.toBeNull();
      expect(selectModelCalledWith.payload.sessionId).toBe(sessionA.id);
      expect(selectModelCalledWith.payload.model).toBe('deepseek-v4-pro');
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
});
