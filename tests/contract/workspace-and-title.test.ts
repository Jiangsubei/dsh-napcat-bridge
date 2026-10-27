import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { SessionManager, formatSessionTitle } from '../../src/gateway/session.js';
import type { WakeupPayload } from '../../src/types/index.js';

describe('NapCat 顶层工作区与会话标题契约测试', () => {
  const tmpHome = '/tmp/dsh-test-home';
  let ctx: Context;
  let sessionManager: SessionManager;
  let mockWorkspace: any;
  let mockWorkspaceRegistry: any;
  let mockSessionTitle: any;
  let mockAgents: any;

  beforeEach(() => {
    ctx = new Context();
    mockWorkspace = {
      path: path.resolve(tmpHome, 'workspace/napcat'),
      title: 'NapCat',
      attachSession: vi.fn().mockResolvedValue(undefined),
    };
    mockWorkspaceRegistry = {
      create: vi.fn().mockResolvedValue(mockWorkspace),
      archivedSessionIds: [],
    };
    mockSessionTitle = {
      rename: vi.fn(),
      get: vi.fn(),
    };
    mockAgents = {
      create: vi.fn().mockImplementation(async (opts: any) => {
        return {
          agent: {
            session: { id: opts.sessionId },
            followup: vi.fn(),
          },
          dispose: vi.fn(),
        };
      }),
      resume: vi.fn(),
      get: vi.fn(),
    };

    (ctx as any).workspaceRegistry = mockWorkspaceRegistry;
    (ctx as any).sessionTitle = mockSessionTitle;
    (ctx as any).agents = mockAgents;

    sessionManager = new SessionManager(ctx, tmpHome);
  });

  describe('1. 会话标题格式化 (formatSessionTitle)', () => {
    it('群聊带群名称 - 初始版本 #1', () => {
      const title = formatSessionTitle('group_3000000001', 'qq-group-3000000001', '摸鱼交流群');
      expect(title).toBe('群聊: 摸鱼交流群 3000000001 #1');
    });

    it('群聊无群名称 - 初始版本 #1', () => {
      const title = formatSessionTitle('group_3000000001', 'qq-group-3000000001');
      expect(title).toBe('群聊: 3000000001 #1');
    });

    it('群聊带版本号 - /clear 后新会话 #2', () => {
      const title = formatSessionTitle('group_3000000001', 'qq-group-3000000001-2', '摸鱼交流群');
      expect(title).toBe('群聊: 摸鱼交流群 3000000001 #2');
    });

    it('私聊带用户昵称 - 初始版本 #1', () => {
      const title = formatSessionTitle('user_2000000001', 'qq-user-2000000001', 'Nyara');
      expect(title).toBe('私聊: Nyara 2000000001 #1');
    });

    it('私聊无用户昵称 - 初始版本 #1', () => {
      const title = formatSessionTitle('user_2000000001', 'qq-user-2000000001');
      expect(title).toBe('私聊: 2000000001 #1');
    });

    it('私聊带版本号 - /clear 后新会话 #3', () => {
      const title = formatSessionTitle('user_2000000001', 'qq-user-2000000001-3', 'Nyara');
      expect(title).toBe('私聊: Nyara 2000000001 #3');
    });

    it('多轮归档后 - 新轮次 1 初始版本 #1 (1)', () => {
      const title = formatSessionTitle('user_2000000001', 'qq-user-2000000001-r1-1', 'Nyara');
      expect(title).toBe('私聊: Nyara 2000000001 #1 (1)');
    });

    it('多轮归档后 - 新轮次 1 清空后版本 #2 (1)', () => {
      const title = formatSessionTitle('user_2000000001', 'qq-user-2000000001-r1-2', 'Nyara');
      expect(title).toBe('私聊: Nyara 2000000001 #2 (1)');
    });

    it('多轮归档后 - 新轮次 2 初始版本 #1 (2)', () => {
      const title = formatSessionTitle('user_2000000001', 'qq-user-2000000001-r2-1', 'Nyara');
      expect(title).toBe('私聊: Nyara 2000000001 #1 (2)');
    });

    it('群聊多轮归档后 - 新轮次 1 初始版本 #1 (1)', () => {
      const title = formatSessionTitle('group_3000000001', 'qq-group-3000000001-r1-1', '摸鱼交流群');
      expect(title).toBe('群聊: 摸鱼交流群 3000000001 #1 (1)');
    });
  });

  describe('2. 工作区统一注册与 CWD 统一收敛', () => {
    it('无论群聊还是私聊，resolveCwd 均统一返回 napcat 根工作区目录', () => {
      const expectedCwd = path.resolve(tmpHome, 'workspace/napcat');
      expect(sessionManager.resolveCwd('group_3000000001')).toBe(expectedCwd);
      expect(sessionManager.resolveCwd('user_2000000001')).toBe(expectedCwd);
      expect(sessionManager.resolveCwd('qq-group-3000000001-2')).toBe(expectedCwd);
    });

    it('注册工作区时统一创建标题为 NapCat 的顶级工作区，并 attachSession', async () => {
      const cwd = sessionManager.resolveCwd('group_3000000001');
      await sessionManager.registerWorkspace(cwd, 'qq-group-3000000001');

      expect(mockWorkspaceRegistry.create).toHaveBeenCalledWith(cwd, 'NapCat');
      expect(mockWorkspace.attachSession).toHaveBeenCalledWith('qq-group-3000000001');
    });
  });

  describe('3. 会话创建时标题锁定与免 LLM 自动总结覆盖', () => {
    it('创建群聊 Agent 时正确设置并锁定群聊标题', async () => {
      sessionManager.setPeerName('group_3000000001', '核心研发群');
      await sessionManager.getOrCreateAgent('group_3000000001');

      expect(mockSessionTitle.rename).toHaveBeenCalledWith(
        expect.anything(),
        '群聊: 核心研发群 3000000001 #1'
      );
      expect(mockWorkspaceRegistry.create).toHaveBeenCalledWith(
        path.resolve(tmpHome, 'workspace/napcat'),
        'NapCat'
      );
      expect(mockWorkspace.attachSession).toHaveBeenCalledWith('qq-group-3000000001');
    });

    it('创建私聊 Agent 时正确设置并锁定私聊标题', async () => {
      sessionManager.setPeerName('user_2000000001', '小明');
      await sessionManager.getOrCreateAgent('user_2000000001');

      expect(mockSessionTitle.rename).toHaveBeenCalledWith(
        expect.anything(),
        '私聊: 小明 2000000001 #1'
      );
      expect(mockWorkspace.attachSession).toHaveBeenCalledWith('qq-user-2000000001');
    });

    it('dispatchWakeup 收到带有昵称的消息时动态更新会话标题', async () => {
      const payload: WakeupPayload = {
        peer: 'user_2000000001',
        trigger: 'private',
        from_user: '2000000001',
        from_name: '张三丰',
        content: '你好呀',
        timestamp: '2026-08-31 04:00:00',
      };

      await sessionManager.dispatchWakeup(payload);

      expect(mockSessionTitle.rename).toHaveBeenCalledWith(
        expect.anything(),
        '私聊: 张三丰 2000000001 #1'
      );
    });
  });

  describe('4. DSH 0.2.x 工作区 candidateMatches 契约与未分组防掉落', () => {
    it('契约: peerToSessionId 严禁主动从 wsRegistry.sessionPaths 中删除会话，避免触发 DSH mutate 剔除掉入未分组', () => {
      const sessionPaths = new Map<string, string>();
      sessionPaths.set('qq-user-9999999999', path.resolve(tmpHome, 'workspace/napcat'));
      const wsRegistry = {
        headers: new Map<string, any>([
          ['qq-user-9999999999', { id: 'qq-user-9999999999', cwd: path.resolve(tmpHome, 'workspace/napcat') }],
        ]),
        sessionPaths,
        invalidSessionPaths: new Map<string, string>(),
        archivedSessionIds: [],
      };
      (ctx as any).workspaceRegistry = wsRegistry;

      // 模拟磁盘尚未落盘（尚未 flush）
      sessionManager.peerToSessionId('user_9999999999');

      // 验证：绝对不能删除 wsRegistry.sessionPaths 中的该 sessionId！
      expect(sessionPaths.has('qq-user-9999999999')).toBe(true);
    });

    it('契约: 真实 DSH WorkspaceEntity 经历挂载与解绑操作后，父会话必须始终保留在 sessionIds 中', async () => {
      const canonicalPath = path.resolve(tmpHome, 'workspace/napcat');
      const sessionPaths = new Map<string, string>();
      sessionPaths.set('qq-user-1000000001', canonicalPath);

      const candidateMatches = (id: string, p: string) =>
        sessionPaths.get(id) === p;

      const entity = {
        record: {
          path: canonicalPath,
          title: 'NapCat',
          sessionIds: ['qq-user-1000000001'],
        },
        get path() {
          return this.record.path;
        },
        get sessionIds() {
          return this.record.sessionIds.filter((id: string) => candidateMatches(id, this.record.path));
        },
        async attachSession(sessionId: string) {
          if (!this.record.sessionIds.includes(sessionId)) {
            sessionPaths.set(sessionId, this.record.path);
          }
          await this.mutate((rec: any) =>
            rec.sessionIds.includes(sessionId) ? rec : { ...rec, sessionIds: [sessionId, ...rec.sessionIds] }
          );
        },
        async detachSession(sessionId: string) {
          await this.mutate((rec: any) =>
            rec.sessionIds.includes(sessionId)
              ? { ...rec, sessionIds: rec.sessionIds.filter((id: string) => id !== sessionId) }
              : rec
          );
        },
        async mutate(fn: (rec: any) => any) {
          const changed = fn(this.record);
          const filtered = changed.sessionIds.filter((id: string) => candidateMatches(id, changed.path));
          this.record = {
            ...changed,
            sessionIds: filtered,
          };
        },
      };

      // 初始状态：父会话处于 NapCat 工作区中
      expect(entity.sessionIds).toContain('qq-user-1000000001');

      // 模拟后台回顾子会话挂载
      const reviewSessionId = 'review-qq-user-1000000001-123456';
      await entity.attachSession(reviewSessionId);
      expect(entity.sessionIds).toContain('qq-user-1000000001');
      expect(entity.sessionIds).toContain(reviewSessionId);

      // 模拟后台回顾用完即焚解绑
      await entity.detachSession(reviewSessionId);

      // 核心断言：父会话绝对不能掉入未分组，必须依旧在 sessionIds 中！
      expect(entity.sessionIds).toContain('qq-user-1000000001');
      expect(entity.sessionIds).not.toContain(reviewSessionId);
    });

  });
});
