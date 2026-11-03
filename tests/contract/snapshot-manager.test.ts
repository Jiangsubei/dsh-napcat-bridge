/**
 * tests/contract/snapshot-manager.test.ts
 * 契约测试: 统一运行时动态快照与上下文注入管理器 (SnapshotManager Contract)
 *
 * 验证规则:
 * 1. 契约 1: resolveQQSessionContext 具备严格 Fail-Closed 白名单校验与多源解析能力；
 * 2. 契约 2: SnapshotManager 统一安全门控 — Web UI 会话与空上下文中 100% 阻断，绝不泄露；
 * 3. 契约 3: SnapshotManager 在 QQ 会话下放行并正确透传 QQSessionContext；
 * 4. 契约 4: 单 Provider 异常时优雅降级隔离，绝不影响其他 Provider 和装配流程。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  SnapshotManager,
  resolveQQSessionContext,
  setupSnapshotHub,
  type SnapshotProvider,
} from '../../src/prompt/snapshot.js';

describe('契约测试: 统一运行时动态快照与上下文注入管理器 (SnapshotManager Contract)', () => {
  let mockSystemPrompt: any;
  let registeredContexts: Map<string, any>;
  let mockCtx: any;

  beforeEach(() => {
    registeredContexts = new Map();
    mockSystemPrompt = {
      context: vi.fn().mockImplementation((opts: any) => {
        registeredContexts.set(opts.name, opts);
        return () => {
          registeredContexts.delete(opts.name);
        };
      }),
    };

    mockCtx = {
      get: (name: string) => {
        if (name === 'systemPrompt') return mockSystemPrompt;
        return undefined;
      },
    };
  });

  afterEach(() => {
    registeredContexts.clear();
  });

  describe('契约 1: resolveQQSessionContext Fail-Closed 判定与解析', () => {
    it('1.1 能从多种合法群聊格式中解析出 group peer', () => {
      // agent.session.id
      const ctx1 = { agent: { session: { id: 'qq-group-1000000001-1' } } };
      const res1 = resolveQQSessionContext(ctx1);
      expect(res1).not.toBeNull();
      expect(res1?.peer).toBe('group_1000000001');
      expect(res1?.isGroup).toBe(true);
      expect(res1?.isPrivate).toBe(false);

      // session.id
      const ctx2 = { session: { id: 'group_1000000002' } };
      const res2 = resolveQQSessionContext(ctx2);
      expect(res2?.peer).toBe('group_1000000002');
      expect(res2?.isGroup).toBe(true);

      // 显式 peer 属性
      const ctx3 = { peer: 'qq-group-1000000003' };
      const res3 = resolveQQSessionContext(ctx3);
      expect(res3?.peer).toBe('group_1000000003');
      expect(res3?.isGroup).toBe(true);
    });

    it('1.2 能从多种合法私聊格式中解析出 user peer 与 QQ 号', () => {
      // qq-user-<id>
      const ctx1 = { agent: { sessionId: 'qq-user-1000000010' } };
      const res1 = resolveQQSessionContext(ctx1);
      expect(res1).not.toBeNull();
      expect(res1?.peer).toBe('user_1000000010');
      expect(res1?.qq).toBe('1000000010');
      expect(res1?.isPrivate).toBe(true);
      expect(res1?.isGroup).toBe(false);

      // user_<id>
      const ctx2 = { sessionId: 'user_1000000020' };
      const res2 = resolveQQSessionContext(ctx2);
      expect(res2?.peer).toBe('user_1000000020');
      expect(res2?.qq).toBe('1000000020');

      // qq-<id>
      const ctx3 = { session: { id: 'qq-1000000030' } };
      const res3 = resolveQQSessionContext(ctx3);
      expect(res3?.peer).toBe('user_1000000030');
      expect(res3?.qq).toBe('1000000030');
    });

    it('1.3 发言人识别：配合 getCurrentSpeaker 正确解析群内发言人', () => {
      const ctx = { agent: { session: { id: 'qq-group-1000000001-1' } } };
      const getSpeaker = (peer: string) => (peer === 'group_1000000001' ? '1000000099' : undefined);
      const res = resolveQQSessionContext(ctx, getSpeaker);
      expect(res?.peer).toBe('group_1000000001');
      expect(res?.qq).toBe('1000000099');
    });

    it('1.4 严格 Fail-Closed: 非 QQ 会话、未知格式与空上下文一律返回 null', () => {
      expect(resolveQQSessionContext(undefined)).toBeNull();
      expect(resolveQQSessionContext(null)).toBeNull();
      expect(resolveQQSessionContext({})).toBeNull();
      expect(resolveQQSessionContext({ session: { id: '' } })).toBeNull();
      expect(resolveQQSessionContext({ session: { id: 'web-session-123' } })).toBeNull();
      expect(resolveQQSessionContext({ agent: { sessionId: 'desktop-main' } })).toBeNull();
      expect(resolveQQSessionContext({ scope: 's-random-guid' })).toBeNull();
      expect(resolveQQSessionContext({ peer: 'default' })).toBeNull();
      expect(resolveQQSessionContext({ peer: 'review-group_1000000001' })).toBeNull();
    });
  });

  describe('契约 2: SnapshotManager 统一安全门控 (Web UI / 非 QQ 0 泄露)', () => {
    it('2.1 非 QQ 会话下，所有默认 qqOnly Provider 均返回空字符串，绝不泄露', () => {
      const manager = new SnapshotManager(mockCtx);

      const provideSlang = vi.fn().mockReturnValue('# 社群黑话知识库内容');
      const provideFace = vi.fn().mockReturnValue('[本地表情库概览]');
      const provideMemory = vi.fn().mockReturnValue('## 记忆');

      manager.registerProvider({
        name: 'napcat:slang',
        order: 45,
        provide: provideSlang,
      });
      manager.registerProvider({
        name: 'napcat:face_summary',
        order: 48,
        provide: provideFace,
      });
      manager.registerProvider({
        name: 'napcat:memory',
        order: 40,
        provide: provideMemory,
      });

      // 验证注册成功
      expect(registeredContexts.has('napcat:slang')).toBe(true);
      expect(registeredContexts.has('napcat:face_summary')).toBe(true);
      expect(registeredContexts.has('napcat:memory')).toBe(true);

      // Web 会话上下文
      const webAssembleCtx = { session: { id: 'web-session-42' } };

      const slangText = registeredContexts.get('napcat:slang').text(webAssembleCtx);
      const faceText = registeredContexts.get('napcat:face_summary').text(webAssembleCtx);
      const memoryText = registeredContexts.get('napcat:memory').text(webAssembleCtx);

      expect(slangText).toBe('');
      expect(faceText).toBe('');
      expect(memoryText).toBe('');

      // 业务 provide 函数在 Web 会话下根本不被调用
      expect(provideSlang).not.toHaveBeenCalled();
      expect(provideFace).not.toHaveBeenCalled();
      expect(provideMemory).not.toHaveBeenCalled();

      // 空上下文（无参调用）同样 100% 阻断
      expect(registeredContexts.get('napcat:slang').text()).toBe('');
      expect(registeredContexts.get('napcat:face_summary').text({})).toBe('');
    });

    it('2.2 QQ 会话下，正常放行并调用 provide 产生文本', () => {
      const manager = new SnapshotManager(mockCtx);

      const provideSlang = vi.fn().mockReturnValue('# 黑话词条：牢大');
      manager.registerProvider({
        name: 'napcat:slang',
        order: 45,
        provide: provideSlang,
      });

      const qqAssembleCtx = { agent: { session: { id: 'qq-group-1000000001-1' } } };
      const output = registeredContexts.get('napcat:slang').text(qqAssembleCtx);

      expect(output).toBe('# 黑话词条：牢大');
      expect(provideSlang).toHaveBeenCalledTimes(1);
      const [sessionArg] = provideSlang.mock.calls[0];
      expect(sessionArg.peer).toBe('group_1000000001');
      expect(sessionArg.isGroup).toBe(true);
    });
  });

  describe('契约 3: 单 Provider 异常优雅降级', () => {
    it('3.1 当某 Provider 执行抛出异常时，捕获并返回空字符串，不影响其他 Provider', () => {
      const manager = new SnapshotManager(mockCtx);

      const badProvider: SnapshotProvider = {
        name: 'napcat:face_summary',
        order: 48,
        provide: () => {
          throw new Error('SQLite disk I/O error');
        },
      };

      const goodProvider: SnapshotProvider = {
        name: 'napcat:slang',
        order: 45,
        provide: () => '正常黑话内容',
      };

      manager.registerProvider(badProvider);
      manager.registerProvider(goodProvider);

      const qqAssembleCtx = { session: { id: 'qq-user-1000000001' } };

      // 异常 Provider 静默降级为 ''
      expect(() => {
        const text = registeredContexts.get('napcat:face_summary').text(qqAssembleCtx);
        expect(text).toBe('');
      }).not.toThrow();

      // 正常 Provider 正常输出
      const goodText = registeredContexts.get('napcat:slang').text(qqAssembleCtx);
      expect(goodText).toBe('正常黑话内容');
    });
  });

  describe('契约 4: dispose 正确释放注册项', () => {
    it('4.1 独立 unregister 与全量 dispose 正确注销动态上下文', () => {
      const manager = new SnapshotManager(mockCtx);

      const unregister = manager.registerProvider({
        name: 'napcat:slang',
        order: 45,
        provide: () => 'test',
      });
      expect(registeredContexts.has('napcat:slang')).toBe(true);

      unregister();
      expect(registeredContexts.has('napcat:slang')).toBe(false);

      manager.registerProvider({
        name: 'napcat:memory',
        order: 40,
        provide: () => 'mem',
      });
      manager.registerProvider({
        name: 'napcat:face_summary',
        order: 48,
        provide: () => 'face',
      });

      expect(registeredContexts.size).toBe(2);
      manager.dispose();
      expect(registeredContexts.size).toBe(0);
    });
  });

  describe('契约 5: setupSnapshotHub 组装各业务统一二级标题格式', () => {
    it('5.1 注册的所有 Provider 输出均严格遵循 ## 模块名 规范，且表情包按情绪分组带 ID', () => {
      const mockDb: any = {
        getActiveFacesForContext: vi.fn().mockReturnValue({
          total: 2,
          faces: [
            { id: 'face_1', mood: '开心', tags: ['大笑'], enabled: true },
            { id: 'face_2', mood: '调侃', tags: ['摊手'], enabled: true },
          ],
        }),
        getFaceMoodSummary: vi.fn().mockReturnValue({ total: 2, moods: [] }),
        getActiveUsers: vi.fn().mockReturnValue([]),
      };

      const mockSlangStorage: any = {
        getRawMarkdownSync: vi.fn().mockReturnValue('- **词条一**：解释一'),
      };

      const mockMemoryStorage: any = {
        getPromptSnapshotSync: vi.fn().mockReturnValue('### Session 记忆\n- 备忘条目'),
      };

      const hub = setupSnapshotHub({
        ctx: mockCtx,
        db: mockDb,
        memoryStorage: mockMemoryStorage,
        slangStorage: mockSlangStorage,
        getPersona: () => '自定义人格设定',
        getBehavior: () => '自定义行为准则',
        getFaceEnabled: () => true,
        getSlangEnabled: () => true,
      });

      const qqCtx = { session: { id: 'qq-group-1000000001' } };

      // 1. 记忆与画像
      const memText = registeredContexts.get('napcat:memory').text(qqCtx);
      expect(memText).toContain('## 会话规则与用户画像 (Memory & Profiles)');
      expect(memText).toContain('### Session 记忆');

      // 2. 黑话
      const slangText = registeredContexts.get('napcat:slang').text(qqCtx);
      expect(slangText).toContain('## 社群黑话知识库 (Slang & Memes)');
      expect(slangText).toContain('- **词条一**：解释一');

      // 3. 表情包全量注入
      const faceText = registeredContexts.get('napcat:face_summary').text(qqCtx);
      expect(faceText).toContain('## 本地表情包库存 (Sticker & Meme Library)');
      expect(faceText).toContain('共 2 张可用表情包');
      expect(faceText).toContain('### 开心 (1)');
      expect(faceText).toContain('- face_1: 标签: 大笑');
      expect(faceText).toContain('### 调侃 (1)');
      expect(faceText).toContain('- face_2: 标签: 摊手');

      // 4. 人格与行为准则
      const pbText = registeredContexts.get('napcat:behavior_persona').text(qqCtx);
      expect(pbText).toContain('## 人格设定 (Persona)\n\n自定义人格设定');
      expect(pbText).toContain('## 行为准则 (Behavior Guidelines)\n\n自定义行为准则');

      hub.dispose();
    });

    it('5.2 setupSnapshotHub 传递 getFaceStoreMax 时，表情包查询上限严格遵循该配置', () => {
      const mockDb: any = {
        getActiveFacesForContext: vi.fn().mockReturnValue({
          total: 0,
          faces: [],
        }),
      };

      const hub = setupSnapshotHub({
        ctx: mockCtx,
        db: mockDb,
        getFaceEnabled: () => true,
        getFaceStoreMax: () => 250,
      });

      const qqCtx = { session: { id: 'qq-group-1000000001' } };
      registeredContexts.get('napcat:face_summary').text(qqCtx);

      expect(mockDb.getActiveFacesForContext).toHaveBeenCalledWith(250);

      hub.dispose();
    });
  });
});
