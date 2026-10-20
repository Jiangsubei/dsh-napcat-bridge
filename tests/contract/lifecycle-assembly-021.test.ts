import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import {
  registerNapCatQuestionChannel,
  NapCatQuestionProvider,
  NapCatApprovalResponder,
} from '../../src/approval/responder.js';
import { registerConfigRoute } from '../../src/server/routes.js';
import * as migrateModule from '../../src/config/migrate.js';
import * as NapCatBridgePlugin from '../../src/index.js';

describe('阶段 1 契约测试：生命周期与 P0 装配契约 (Lifecycle & Assembly P0)', () => {
  describe('A4/A5: 提问与审批 waterfall 先手契约 (prepend: true)', () => {
    it('A5: 宿主提问处理者先注册且不 next() 时，NapCat 仍能通过 prepend 优先认领 QQ 会话', async () => {
      const ctx = new Context();

      // 1. 模拟宿主 answerer 先注册，且无条件认领全部提问（不调用 next）
      let hostHandledCount = 0;
      ctx.on('user-questions/request', async (req: any, next: any) => {
        hostHandledCount += 1;
        return { answers: [{ id: 'q1', selected: ['host-default-answer'] }] };
      });

      // 2. 插件注册 NapCatQuestionChannel
      let napcatHandledCount = 0;
      const fakeProvider = {
        ask: async (req: any) => {
          napcatHandledCount += 1;
          return { answers: [{ id: 'q1', selected: ['napcat-qq-answer'] }] };
        },
      } as any;

      const unregister = registerNapCatQuestionChannel(ctx, {
        questionProvider: fakeProvider,
        isQQSession: (sid) => sid.startsWith('qq-'),
      });

      // 3. QQ 会话提问：NapCat 必须先手认领，绝不能被宿主截胡
      const qqReq = {
        agent: { id: 'qq-group-1001', session: { id: 'qq-group-1001' } },
        questions: [{ id: 'q1', question: 'QQ问题' }],
      };
      const qqRes = await (ctx as any).waterfall(
        'user-questions/request',
        qqReq as any,
        () => Promise.reject(new Error('no answerer'))
      );
      expect(napcatHandledCount).toBe(1);
      expect(hostHandledCount).toBe(0);
      expect(qqRes).toEqual({ answers: [{ id: 'q1', selected: ['napcat-qq-answer'] }] });

      // 4. 非 QQ 会话提问：NapCat 通过 next() 委派，宿主成功处理
      const webReq = {
        agent: { id: 'web-session-1', session: { id: 'web-session-1' } },
        questions: [{ id: 'q1', question: 'Web问题' }],
      };
      const webRes = await (ctx as any).waterfall(
        'user-questions/request',
        webReq as any,
        () => Promise.reject(new Error('no answerer'))
      );
      expect(napcatHandledCount).toBe(1);
      expect(hostHandledCount).toBe(1);
      expect(webRes).toEqual({ answers: [{ id: 'q1', selected: ['host-default-answer'] }] });

      unregister();
    });

    it('A4: 宿主审批处理者先注册且不 next() 时，NapCat 仍能通过 prepend 优先认领 QQ 审批', async () => {
      const ctx = new Context();

      // 1. 模拟宿主审批 answerer 先注册，且无条件处理任何审批（不调用 next）
      let hostApprovalHandled = false;
      ctx.on('approval/request', async (req: any, next: any) => {
        hostApprovalHandled = true;
        return 'allowed-once';
      });

      // 2. 模拟 NapCat 审批处理者
      let napcatApprovalHandled = false;
      const fakeResponder = {
        handleApprovalRequest: async () => {
          napcatApprovalHandled = true;
          return 'rejected';
        },
      };

      const sessionManager = {
        isQQSession: (id: string) => id.startsWith('qq-'),
        sessionIdToPeer: (id: string) => id,
      };

      // 按照 { prepend: true } 注册审批
      const unregister = (ctx as any).on(
        'approval/request',
        async (req: any, next: any) => {
          const sessionId = req.agent?.session?.id;
          if (!sessionId || !sessionManager.isQQSession(sessionId)) {
            return next ? next() : 'unavailable';
          }
          const peer = sessionManager.sessionIdToPeer(sessionId);
          return await fakeResponder.handleApprovalRequest();
        },
        { prepend: true }
      );

      // 3. QQ 会话审批：NapCat 必须先手认领
      const qqReq = {
        agent: { session: { id: 'qq-group-2001' } },
        toolName: 'bash',
        reason: 'execute command',
      };
      const qqRes = await (ctx as any).waterfall(
        'approval/request',
        qqReq as any,
        () => Promise.reject(new Error('no answerer'))
      );
      expect(napcatApprovalHandled).toBe(true);
      expect(hostApprovalHandled).toBe(false);
      expect(qqRes).toBe('rejected');

      // 4. Web 会话审批：委派给宿主
      napcatApprovalHandled = false;
      hostApprovalHandled = false;
      const webReq = {
        agent: { session: { id: 'web-session-2' } },
        toolName: 'bash',
        reason: 'execute command',
      };
      const webRes = await (ctx as any).waterfall(
        'approval/request',
        webReq as any,
        () => Promise.reject(new Error('no answerer'))
      );
      expect(napcatApprovalHandled).toBe(false);
      expect(hostApprovalHandled).toBe(true);
      expect(webRes).toBe('allowed-once');

      unregister();
    });
  });

  describe('A6/A11: 生命周期就绪、配置迁移与卸载清理', () => {
    it('A6: 存在 appReady 服务时通过 onReady 触发配置迁移；不存在时兜底触发', async () => {
      const migrateSpy = vi.spyOn(migrateModule, 'migrateLegacyConfig').mockResolvedValue(true as any);

      // 场景 1: 带有 0.2.1 appReady 服务的环境
      const ctx1 = new Context();
      let readyCallback: (() => void) | undefined;
      const appReadyService = {
        onReady: vi.fn((cb: () => void) => {
          readyCallback = cb;
          return () => {};
        }),
      };
      ctx1.provide('appReady', appReadyService);

      const fork1 = ctx1.plugin(NapCatBridgePlugin.apply, { bot_qq: '123456' });
      await fork1;

      expect(appReadyService.onReady).toHaveBeenCalled();
      // 在 onReady 触发前尚未调用
      expect(migrateSpy).not.toHaveBeenCalled();

      // 触发 onReady
      readyCallback?.();
      expect(migrateSpy).toHaveBeenCalledWith(expect.anything(), expect.anything());

      await fork1.dispose();
      migrateSpy.mockClear();

      // 场景 2: 无 appReady 服务的单测/独立环境，自动兜底调用
      const ctx2 = new Context();
      const fork2 = ctx2.plugin(NapCatBridgePlugin.apply, { bot_qq: '123456' });
      await fork2;

      expect(migrateSpy).toHaveBeenCalledWith(expect.anything(), expect.anything());

      await fork2.dispose();
      migrateSpy.mockRestore();
    });

    it('A6/A11: 插件卸载 (fiber.dispose / ctx.effect) 时完整注销 REST 路由并移除进程监听器', async () => {
      const ctx = new Context();

      let unregisterCalled = false;
      const mockWebServer = {
        register: vi.fn(() => () => {
          unregisterCalled = true;
        }),
      };
      ctx.provide('webServer', mockWebServer);

      const sigintCountBefore = process.listenerCount('SIGINT');
      const sigtermCountBefore = process.listenerCount('SIGTERM');

      const fork = ctx.plugin(NapCatBridgePlugin.apply, { bot_qq: '123456' });
      await fork;

      expect(mockWebServer.register).toHaveBeenCalled();
      expect(process.listenerCount('SIGINT')).toBe(sigintCountBefore + 1);
      expect(process.listenerCount('SIGTERM')).toBe(sigtermCountBefore + 1);

      // 执行插件销毁
      await fork.dispose();

      // 断言: 路由已被注销
      expect(unregisterCalled).toBe(true);
      // 断言: 进程监听器已被全部移除，不泄漏
      expect(process.listenerCount('SIGINT')).toBe(sigintCountBefore);
      expect(process.listenerCount('SIGTERM')).toBe(sigtermCountBefore);
    });

    it('A11: webServer 重复注册抛出异常时安全捕获，且返回的 disposer 仍能安全注销', () => {
      const ctx = new Context();
      let unregisterCalled = false;
      const mockWebServer = {
        register: vi.fn().mockImplementationOnce(() => () => {
          unregisterCalled = true;
        }).mockImplementationOnce(() => {
          throw new Error('webserver: duplicate exact route "/plugins/dsh-napcat-bridge/config"');
        }),
      };
      ctx.provide('webServer', mockWebServer);

      // 第一次注册成功
      const unregister1 = registerConfigRoute(ctx, () => ({}) as any, async () => {});
      expect(mockWebServer.register).toHaveBeenCalledTimes(1);

      // 第二次注册模拟重复注册，不应抛出异常
      let unregister2: (() => void) | undefined;
      expect(() => {
        unregister2 = registerConfigRoute(ctx, () => ({}) as any, async () => {});
      }).not.toThrow();

      // 清理
      unregister1();
      unregister2?.();
      expect(unregisterCalled).toBe(true);
    });
  });
});
