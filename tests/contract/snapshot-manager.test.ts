/**
 * tests/contract/snapshot-manager.test.ts
 * 契约测试: 多通道独立运行时快照与上下文注入管理器 (SnapshotManager Contract)
 *
 * 验证规则:
 * 1. 契约 1: resolveQQSessionContext 具备严格 Fail-Closed 白名单校验与多源解析能力；
 * 2. 契约 2: SnapshotManager 安全门控 — 非 QQ 会话 (Web UI / 空上下文 / 沙箱) 100% 阻断，0 条注入；
 * 3. 契约 3: 单 Provider 异常时优雅降级隔离，绝不影响其他 Provider 和装配流程；
 * 4. 契约 4: dispose 与 unregister 正确释放 Provider 与清理会话状态；
 * 5. 契约 5: setupSnapshotHub 规范装配 6 大独立原子通道，排版严格遵循 ## 模块名 规范；
 * 6. 契约 6: 多通道独立快照脏检查与增量注入契约（0-Token 命中、单通道增量、历史恢复）。
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  SnapshotManager,
  resolveQQSessionContext,
  setupSnapshotHub,
  type SnapshotProvider,
} from '../../src/prompt/snapshot.js';

describe('契约测试: 多通道独立运行时快照管理器 (SnapshotManager Contract)', () => {
  let mockCtx: any;
  let preStepHandler: ((args: any, next: any) => Promise<any>) | undefined;

  beforeEach(() => {
    preStepHandler = undefined;
    mockCtx = {
      on: vi.fn().mockImplementation((event: string, handler: any) => {
        if (event === 'agent/pre-step') {
          preStepHandler = handler;
        }
        return () => {
          if (preStepHandler === handler) {
            preStepHandler = undefined;
          }
        };
      }),
    };
  });

  describe('契约 1: resolveQQSessionContext Fail-Closed 判定与解析', () => {
    it('1.1 能从多种合法群聊格式中解析出 group peer', () => {
      const ctx1 = { agent: { session: { id: 'qq-group-1000000001-1' } } };
      const res1 = resolveQQSessionContext(ctx1);
      expect(res1).not.toBeNull();
      expect(res1?.peer).toBe('group_1000000001');
      expect(res1?.isGroup).toBe(true);
      expect(res1?.isPrivate).toBe(false);

      const ctx2 = { session: { id: 'group_1000000002' } };
      const res2 = resolveQQSessionContext(ctx2);
      expect(res2?.peer).toBe('group_1000000002');
      expect(res2?.isGroup).toBe(true);

      const ctx3 = { peer: 'qq-group-1000000003' };
      const res3 = resolveQQSessionContext(ctx3);
      expect(res3?.peer).toBe('group_1000000003');
      expect(res3?.isGroup).toBe(true);
    });

    it('1.2 能从多种合法私聊格式中解析出 user peer 与 QQ 号', () => {
      const ctx1 = { agent: { sessionId: 'qq-user-1000000010' } };
      const res1 = resolveQQSessionContext(ctx1);
      expect(res1).not.toBeNull();
      expect(res1?.peer).toBe('user_1000000010');
      expect(res1?.qq).toBe('1000000010');
      expect(res1?.isPrivate).toBe(true);
      expect(res1?.isGroup).toBe(false);

      const ctx2 = { sessionId: 'user_1000000020' };
      const res2 = resolveQQSessionContext(ctx2);
      expect(res2?.peer).toBe('user_1000000020');
      expect(res2?.qq).toBe('1000000020');

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
    it('2.1 非 QQ 会话下触发 pre-step，所有默认 qqOnly Provider 均不被调用且 0 条消息注入', async () => {
      const manager = new SnapshotManager(mockCtx);

      const provideSlang = vi.fn().mockReturnValue('# 社群黑话知识库内容');
      const provideFace = vi.fn().mockReturnValue('[本地表情库概览]');

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

      const webArgs = {
        agent: { session: { id: 'web-session-42' } },
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Web 用户提问' }] }],
      };

      const result = await manager.handlePreStep(webArgs, async () => ({
        kind: 'enter',
        messages: webArgs.messages,
      }));

      // 完全原样返回，0 条注入
      expect(result.messages.length).toBe(1);
      expect(result.messages[0].content[0].text).toBe('Web 用户提问');
      expect(provideSlang).not.toHaveBeenCalled();
      expect(provideFace).not.toHaveBeenCalled();

      manager.dispose();
    });

    it('2.2 QQ 会话下，正常放行并调用 provide 产生专属通道快照消息', async () => {
      const manager = new SnapshotManager(mockCtx);

      const provideSlang = vi.fn().mockReturnValue('## 社群黑话\n- 词条A: 释义A');
      manager.registerProvider({
        name: 'napcat:slang',
        order: 45,
        provide: provideSlang,
      });

      const qqArgs = {
        agent: { session: { id: 'qq-group-1000000001' } },
        messages: [],
      };

      const result = await manager.handlePreStep(qqArgs, async () => ({ kind: 'enter', messages: [] }));

      expect(provideSlang).toHaveBeenCalledTimes(1);
      expect(result.messages.length).toBe(1);
      expect(result.messages[0].source.kind).toBe('napcat:slang');
      expect(result.messages[0].source.form).toBe('snapshot');
      expect(result.messages[0].source.sections[0].text).toContain('词条A');

      manager.dispose();
    });
  });

  describe('契约 3: 单 Provider 异常优雅降级', () => {
    it('3.1 当某 Provider 执行抛出异常时，捕获并不阻断其他正常通道的注入', async () => {
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
        provide: () => '## 社群黑话\n正常黑话内容',
      };

      manager.registerProvider(badProvider);
      manager.registerProvider(goodProvider);

      const qqArgs = {
        agent: { session: { id: 'qq-user-1000000001' } },
        messages: [],
      };

      const result = await manager.handlePreStep(qqArgs, async () => ({ kind: 'enter', messages: [] }));

      // 异常 Provider 静默跳过，正常 Provider 成功注入
      expect(result.messages.length).toBe(1);
      expect(result.messages[0].source.kind).toBe('napcat:slang');

      manager.dispose();
    });
  });

  describe('契约 4: dispose 正确释放注册项与清理状态', () => {
    it('4.1 独立 unregister 与全量 dispose 正确注销通道与清理缓存', async () => {
      const manager = new SnapshotManager(mockCtx);

      const unregister = manager.registerProvider({
        name: 'napcat:slang',
        order: 45,
        provide: () => 'test',
      });
      expect(manager.getProvider('napcat:slang')).toBeDefined();

      unregister();
      expect(manager.getProvider('napcat:slang')).toBeUndefined();

      manager.registerProvider({
        name: 'napcat:session_rules',
        order: 40,
        provide: () => 'rules',
      });
      manager.registerProvider({
        name: 'napcat:face_summary',
        order: 48,
        provide: () => 'face',
      });

      // 预先填充 retained
      await manager.handlePreStep(
        { agent: { session: { id: 'group_1000000001' } }, messages: [] },
        async () => ({ kind: 'enter', messages: [] })
      );
      expect(manager.getRetained('group_1000000001', 'napcat:session_rules')).toBe('rules');

      manager.dispose();
      expect(manager.getProvider('napcat:session_rules')).toBeUndefined();
      expect(manager.getRetained('group_1000000001', 'napcat:session_rules')).toBeUndefined();
    });
  });

  describe('契约 5: setupSnapshotHub 装配 6 大独立原子通道规范', () => {
    it('5.1 准确装配 6 个原子通道，且每个通道输出均遵循 ## 规范', () => {
      const mockDb: any = {
        getActiveFacesForContext: vi.fn().mockReturnValue({
          total: 2,
          faces: [
            { id: 'face_1', mood: '开心', tags: ['大笑'], enabled: true },
            { id: 'face_2', mood: '调侃', tags: ['摊手'], enabled: true },
          ],
        }),
        getActiveUsers: vi.fn().mockReturnValue([{ user_id: '1000000001', sender_name: '测试用户' }]),
      };

      const mockSlangStorage: any = {
        getRawMarkdownSync: vi.fn().mockReturnValue('- **词条一**：解释一'),
      };

      const mockMemoryStorage: any = {
        getSessionRulesSnapshotSync: vi.fn().mockReturnValue('### Session 约定\n- 约定条目'),
        getUserProfilesSnapshotSync: vi.fn().mockReturnValue('### 测试用户 (1000000001)\n- 用户偏好'),
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

      // 验证仅装配 6 个清晰的独立原子通道
      expect(hub.getProvider('napcat:persona')).toBeDefined();
      expect(hub.getProvider('napcat:behavior')).toBeDefined();
      expect(hub.getProvider('napcat:session_rules')).toBeDefined();
      expect(hub.getProvider('napcat:user_profiles')).toBeDefined();
      expect(hub.getProvider('napcat:slang')).toBeDefined();
      expect(hub.getProvider('napcat:face_summary')).toBeDefined();

      // 验证彻底剔除了历史复合通道
      expect(hub.getProvider('napcat:memory')).toBeUndefined();
      expect(hub.getProvider('napcat:behavior_persona')).toBeUndefined();

      const qqSession = { peer: 'group_1000000001', qq: 'default', isGroup: true, isPrivate: false };
      const assembleCtx = { session: { id: 'qq-group-1000000001' } };

      // 1. 人格
      expect(hub.getProvider('napcat:persona')?.provide(qqSession, assembleCtx)).toContain(
        '## 人格设定 (Persona)\n\n自定义人格设定'
      );
      // 2. 行为准则
      expect(hub.getProvider('napcat:behavior')?.provide(qqSession, assembleCtx)).toContain(
        '## 行为准则 (Behavior Guidelines)\n\n自定义行为准则'
      );
      // 3. 会话规则
      expect(hub.getProvider('napcat:session_rules')?.provide(qqSession, assembleCtx)).toContain(
        '## 会话规则与约定 (Session Rules & Conventions)'
      );
      // 4. 用户画像
      expect(hub.getProvider('napcat:user_profiles')?.provide(qqSession, assembleCtx)).toContain(
        '## 用户画像与群成员 (User Profiles & Members)'
      );
      // 5. 黑话
      expect(hub.getProvider('napcat:slang')?.provide(qqSession, assembleCtx)).toContain(
        '## 社群黑话知识库 (Slang & Memes)'
      );
      // 6. 表情包
      expect(hub.getProvider('napcat:face_summary')?.provide(qqSession, assembleCtx)).toContain(
        '## 本地表情包库存 (Sticker & Meme Library)'
      );

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

      const qqSession = { peer: 'group_1000000001', qq: 'default', isGroup: true, isPrivate: false };
      hub.getProvider('napcat:face_summary')?.provide(qqSession, {});

      expect(mockDb.getActiveFacesForContext).toHaveBeenCalledWith(250);

      hub.dispose();
    });
  });

  describe('契约 6: 多通道独立快照脏检查与增量注入契约 (Multi-Channel Snapshot)', () => {
    it('6.1 首次进入会话触发 pre-step，各通道独立生成带有 form: "snapshot" 的 UserMessage', async () => {
      const manager = new SnapshotManager(mockCtx);

      manager.registerProvider({
        name: 'napcat:slang',
        order: 45,
        provide: () => '## 社群黑话\n- 词条A: 释义A',
      });
      manager.registerProvider({
        name: 'napcat:face_summary',
        order: 48,
        provide: () => '## 本地表情包库存\n- face_1',
      });

      const sessionObj = { id: 'qq-group-1000000001' };
      const preStepArgs = {
        agent: { session: sessionObj },
        messages: [{ role: 'user', content: [{ type: 'text', text: '你好' }] }],
      };

      const result = await manager.handlePreStep(preStepArgs, async () => ({
        kind: 'enter',
        messages: preStepArgs.messages,
      }));

      expect(result.kind).toBe('enter');
      // 原消息 1 条 + 2 个通道的独立快照
      expect(result.messages.length).toBe(3);

      const slangMsg = result.messages.find((m: any) => m.source?.kind === 'napcat:slang');
      expect(slangMsg).toBeDefined();
      expect(slangMsg.source.form).toBe('snapshot');
      expect(slangMsg.source.sections[0].name).toBe('napcat:slang');
      expect(slangMsg.source.sections[0].text).toContain('词条A');
      expect(slangMsg.content[0].text).toContain('<system-reminder>');
      expect(slangMsg.content[0].text).toContain('Current runtime context: napcat:slang');

      const faceMsg = result.messages.find((m: any) => m.source?.kind === 'napcat:face_summary');
      expect(faceMsg).toBeDefined();
      expect(faceMsg.source.form).toBe('snapshot');
      expect(faceMsg.source.sections[0].name).toBe('napcat:face_summary');
      expect(faceMsg.source.sections[0].text).toContain('face_1');

      manager.dispose();
    });

    it('6.2 第二轮对话中各通道内容未发生变化时，产出 0 条注入消息，杜绝 Token 浪费', async () => {
      const manager = new SnapshotManager(mockCtx);

      manager.registerProvider({
        name: 'napcat:slang',
        order: 45,
        provide: () => '## 社群黑话\n- 词条A: 释义A',
      });
      manager.registerProvider({
        name: 'napcat:face_summary',
        order: 48,
        provide: () => '## 本地表情包库存\n- face_1',
      });

      const sessionObj = { id: 'qq-group-1000000001' };
      const preStepArgs1 = {
        agent: { session: sessionObj },
        messages: [],
      };

      // 第一轮注入
      await manager.handlePreStep(preStepArgs1, async () => ({ kind: 'enter', messages: [] }));

      // 第二轮同样的内容触发
      const preStepArgs2 = {
        agent: { session: sessionObj },
        messages: [{ role: 'user', content: [{ type: 'text', text: '第二轮发言' }] }],
      };
      const result2 = await manager.handlePreStep(preStepArgs2, async () => ({
        kind: 'enter',
        messages: preStepArgs2.messages,
      }));

      // 仅包含原本的消息，未追加任何快照！
      expect(result2.messages.length).toBe(1);
      expect(result2.messages[0].content[0].text).toBe('第二轮发言');

      manager.dispose();
    });

    it('6.3 仅某一个通道（如黑话）变动时，仅为该通道生成新快照，表情包等大块通道绝不重发', async () => {
      const manager = new SnapshotManager(mockCtx);

      let slangContent = '## 社群黑话\n- 词条1: 释义1';
      manager.registerProvider({
        name: 'napcat:slang',
        order: 45,
        provide: () => slangContent,
      });
      manager.registerProvider({
        name: 'napcat:face_summary',
        order: 48,
        provide: () => '## 本地表情包库存\n- face_1\n- face_2',
      });

      const sessionObj = { id: 'qq-group-1000000001' };

      // 第一轮
      await manager.handlePreStep(
        { agent: { session: sessionObj }, messages: [] },
        async () => ({ kind: 'enter', messages: [] })
      );

      // 黑话发生更新，而表情包库存未变
      slangContent = '## 社群黑话\n- 词条1: 释义1\n- 词条2: 新增词条';

      const result = await manager.handlePreStep(
        { agent: { session: sessionObj }, messages: [] },
        async () => ({ kind: 'enter', messages: [] })
      );

      // 仅注入 1 条消息，且正是 napcat:slang！
      expect(result.messages.length).toBe(1);
      const injected = result.messages[0];
      expect(injected.source.kind).toBe('napcat:slang');
      expect(injected.source.sections[0].text).toContain('词条2: 新增词条');

      // 验证表情包通道绝对没有被触发重发
      expect(result.messages.some((m: any) => m.source?.kind === 'napcat:face_summary')).toBe(false);

      manager.dispose();
    });

    it('6.4 非 QQ 会话（如 Web UI）触发 pre-step，严格 Fail-Closed 阻断，0 条注入', async () => {
      const manager = new SnapshotManager(mockCtx);

      manager.registerProvider({
        name: 'napcat:slang',
        order: 45,
        provide: () => '私密社群黑话',
      });
      manager.registerProvider({
        name: 'napcat:face_summary',
        order: 48,
        provide: () => '私密表情包库存',
      });

      const webSessionObj = { id: 'web-session-999' };
      const preStepArgs = {
        agent: { session: webSessionObj },
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Web端提问' }] }],
      };

      const result = await manager.handlePreStep(preStepArgs, async () => ({
        kind: 'enter',
        messages: preStepArgs.messages,
      }));

      // 完全原样返回，没有任何 QQ 上下文泄露注入
      expect(result.messages.length).toBe(1);
      expect(result.messages[0].content[0].text).toBe('Web端提问');

      manager.dispose();
    });

    it('6.5 会话重连与历史恢复：当会话历史中已存在某通道相同快照时，不重复注入', async () => {
      const manager = new SnapshotManager(mockCtx);

      const existingSlang = '## 社群黑话\n- 历史已学黑话';
      manager.registerProvider({
        name: 'napcat:slang',
        order: 45,
        provide: () => existingSlang,
      });

      const mockSession = {
        id: 'qq-group-1000000001',
        snapshotEvents: () => [
          {
            type: 'user/message',
            data: {
              source: {
                kind: 'napcat:slang',
                form: 'snapshot',
                sections: [{ name: 'napcat:slang', text: existingSlang }],
              },
            },
          },
        ],
      };

      const result = await manager.handlePreStep(
        { agent: { session: mockSession }, messages: [] },
        async () => ({ kind: 'enter', messages: [] })
      );

      // 成功恢复状态，不再重复注入
      expect(result.messages.length).toBe(0);

      manager.dispose();
    });
  });
});
