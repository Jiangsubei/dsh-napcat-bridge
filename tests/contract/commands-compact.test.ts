import { describe, it, expect, vi } from 'vitest';
import { handleSlashCommand, type CommandContext } from '../../src/commands/index.js';
import { getRuntimePresetDefinition } from '../../src/constants/preset.js';
import type { Context } from '@deepseek-ai/cordis';
import type { Session } from '@deepseek-ai/dsh-session';

describe('契约测试: /压缩 斜杠命令与 Compaction 预设规范 (Commands Compact Contract)', () => {
  const adminUser = '1000000001';
  const normalUser = '1000000002';
  const mockSession = { id: 'session-compact-test-1' } as unknown as Session;

  function createMockContext(options?: {
    engine?: { compactNow: (...args: any[]) => Promise<any> };
    scopedEngine?: { compactNow: (...args: any[]) => Promise<any> };
    tokenMeter?: { measure: (session: any) => any };
    sessionProjections?: { snapshot: (session: any, fields: string[]) => any };
  }) {
    const mockAgent = {
      session: mockSession,
      ctx: {},
    };

    const ctx = {
      get: (name: string) => {
        if (name === 'agents') {
          return {
            get: (id: string) => (id === mockSession.id ? mockAgent : undefined),
          };
        }
        if (name === 'agentPresets') {
          return {
            serviceFor: (agent: any, svcName: string) => {
              if (svcName === 'compaction') {
                return options?.scopedEngine;
              }
              return undefined;
            },
          };
        }
        if (name === 'compaction') {
          return options?.engine;
        }
        if (name === 'tokenMeter') {
          return options?.tokenMeter ?? {
            measure: () => ({ totalTokens: 3200, surfaceTokens: 600 }),
          };
        }
        if (name === 'sessionProjections') {
          return options?.sessionProjections ?? {
            snapshot: () => ({
              values: {
                contextPressure: { contextWindow: 128000 },
              },
            }),
          };
        }
        return undefined;
      },
      logger: () => ({
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      }),
    } as unknown as Context;

    const cmdCtx: CommandContext = {
      userId: adminUser,
      admins: [adminUser],
      session: mockSession,
      ctx,
    };

    return { ctx, cmdCtx, mockAgent };
  }

  describe('契约 1: /帮助 列表包含 /压缩 且位置符合规范', () => {
    it('/帮助 应包含 - /压缩 说明，且排在 - /停止 之前', async () => {
      const { cmdCtx } = createMockContext();
      const res = await handleSlashCommand('/帮助', cmdCtx);
      expect(res.handled).toBe(true);
      expect(res.success).toBe(true);
      expect(res.reply).toBeDefined();

      const lines = res.reply!.split('\n');
      const compactIdx = lines.findIndex((l) => l.includes('- /压缩 : 整理并压缩会话历史，释放上下文空间'));
      const stopIdx = lines.findIndex((l) => l.includes('- /停止'));
      const usageIdx = lines.findIndex((l) => l.includes('- /用量'));

      expect(compactIdx).toBeGreaterThan(-1);
      expect(stopIdx).toBeGreaterThan(-1);
      expect(usageIdx).toBeGreaterThan(-1);
      expect(compactIdx).toBeGreaterThan(usageIdx);
      expect(compactIdx).toBeLessThan(stopIdx);
    });
  });

  describe('契约 2: /压缩 门控与参数校验', () => {
    it('非管理员执行 /压缩 应当被权限门控拒绝', async () => {
      const { cmdCtx } = createMockContext();
      const nonAdminCtx = { ...cmdCtx, userId: normalUser };
      const res = await handleSlashCommand('/压缩', nonAdminCtx);
      expect(res.handled).toBe(true);
      expect(res.success).toBe(false);
      expect(res.error).toBe('权限不足：仅管理员允许执行指令');
    });

    it('携带任何参数时应当直接返回不接受参数的错误提示', async () => {
      const { cmdCtx } = createMockContext();
      const res = await handleSlashCommand('/压缩 now', cmdCtx);
      expect(res.handled).toBe(true);
      expect(res.success).toBe(false);
      expect(res.error).toBe('『/压缩』不接受参数。');
    });

    it('当会话未挂载压缩能力且 host 无压缩服务时，应提示服务不可用', async () => {
      const { cmdCtx } = createMockContext({ scopedEngine: undefined, engine: undefined });
      const res = await handleSlashCommand('/压缩', cmdCtx);
      expect(res.handled).toBe(true);
      expect(res.success).toBe(false);
      expect(res.error).toBe('压缩服务不可用：当前会话未挂载压缩能力。');
    });
  });

  describe('契约 3: /压缩 两段式异步执行与用量报告 (方案 B)', () => {
    it('压缩成功时应先返回立即回执，随后在 followUp 中返回压缩条数与方案 B 上下文用量', async () => {
      const mockCompactNow = vi.fn(async () => ({
        shadowedSeqs: [1, 2, 3, 4, 5],
        shadowedTokenCount: 2560,
      }));

      const { cmdCtx, mockAgent } = createMockContext({
        scopedEngine: { compactNow: mockCompactNow },
      });

      const res = await handleSlashCommand('/压缩', cmdCtx);
      expect(res.handled).toBe(true);
      expect(res.success).toBe(true);
      expect(res.reply).toBe('正在压缩会话历史…');
      expect(typeof res.followUp).toBe('function');

      const followUpText = await res.followUp!();
      expect(mockCompactNow).toHaveBeenCalledTimes(1);
      expect(mockCompactNow).toHaveBeenCalledWith(mockAgent, expect.any(AbortSignal));

      expect(followUpText).toContain('已压缩 5 条历史（约 2.6K tokens）。');
      // 方案 B 格式: 当前上下文：~3.2K / 128K (3%)
      expect(followUpText).toContain('当前上下文：~3.2K / 128K (3%)');
    });

    it('无变更时应在 followUp 中返回会话未变更提示', async () => {
      const mockCompactNow = vi.fn(async () => null);
      const { cmdCtx } = createMockContext({
        scopedEngine: { compactNow: mockCompactNow },
      });

      const res = await handleSlashCommand('/压缩', cmdCtx);
      expect(res.reply).toBe('正在压缩会话历史…');
      const followUpText = await res.followUp!();
      expect(followUpText).toBe('没有可压缩的历史（会话未变更）。');
    });

    it('当引擎抛出 ManualCompactionError(busy) 时应转化为友好中文提示', async () => {
      const busyErr = new Error('Session busy');
      (busyErr as any).name = 'ManualCompactionError';
      (busyErr as any).code = 'busy';

      const mockCompactNow = vi.fn(async () => {
        throw busyErr;
      });

      const { cmdCtx } = createMockContext({
        scopedEngine: { compactNow: mockCompactNow },
      });

      const res = await handleSlashCommand('/压缩', cmdCtx);
      const followUpText = await res.followUp!();
      expect(followUpText).toBe('压缩失败：本进程已有压缩在进行，或该会话不空闲；请等当前回合结束后重试。');
    });

    it('当引擎抛出 ManualCompactionError(summary) 时应转化为有效摘要生成失败提示', async () => {
      const summaryErr = new Error('Summary failed');
      (summaryErr as any).name = 'ManualCompactionError';
      (summaryErr as any).code = 'summary';

      const mockCompactNow = vi.fn(async () => {
        throw summaryErr;
      });

      const { cmdCtx } = createMockContext({
        scopedEngine: { compactNow: mockCompactNow },
      });

      const res = await handleSlashCommand('/压缩', cmdCtx);
      const followUpText = await res.followUp!();
      expect(followUpText).toBe('压缩失败：压缩未能产出有效摘要，会话未变更。');
    });

    it('优先经由 agentPresets.serviceFor 寻址，host 平面仅作为降级兜底', async () => {
      const scopedCompactNow = vi.fn(async () => null);
      const hostCompactNow = vi.fn(async () => null);

      const { cmdCtx } = createMockContext({
        scopedEngine: { compactNow: scopedCompactNow },
        engine: { compactNow: hostCompactNow },
      });

      const res = await handleSlashCommand('/压缩', cmdCtx);
      await res.followUp!();

      expect(scopedCompactNow).toHaveBeenCalledTimes(1);
      expect(hostCompactNow).not.toHaveBeenCalled();
    });

    it('当 context.agent 直接提供时优先使用，不依赖 agents.get 寻址', async () => {
      const explicitAgentCompactNow = vi.fn(async () => null);
      const { cmdCtx } = createMockContext({
        scopedEngine: { compactNow: explicitAgentCompactNow },
      });

      const explicitAgent = {
        session: cmdCtx.session,
        ctx: {},
      };

      const customCmdCtx: CommandContext = {
        ...cmdCtx,
        agent: explicitAgent,
      };

      const res = await handleSlashCommand('/压缩', customCmdCtx);
      expect(res.handled).toBe(true);
      expect(res.success).toBe(true);
      await res.followUp!();
      expect(explicitAgentCompactNow).toHaveBeenCalledWith(explicitAgent, expect.any(AbortSignal));
    });

    it('当 agent 缺少 ctx 或 serviceFor 抛出异常时，平稳回退至 host compaction 平面而不崩溃', async () => {
      const hostCompactNow = vi.fn(async () => null);
      const { cmdCtx } = createMockContext({
        engine: { compactNow: hostCompactNow },
      });

      // agent 故意不提供 ctx（或者 serviceFor 抛出 TypeError）
      const brokenAgent = {
        session: cmdCtx.session,
        // ctx 缺失
      };

      const customCmdCtx: CommandContext = {
        ...cmdCtx,
        agent: brokenAgent,
      };

      const res = await handleSlashCommand('/压缩', customCmdCtx);
      expect(res.handled).toBe(true);
      expect(res.success).toBe(true);
      expect(res.reply).toBe('正在压缩会话历史…');
      await res.followUp!();
      expect(hostCompactNow).toHaveBeenCalledWith(brokenAgent, expect.any(AbortSignal));
    });

    it('当 agents.get 未命中时，可经由 sessionManager.getOrCreateAgent 兜底获取 agent', async () => {
      const hostCompactNow = vi.fn(async () => null);
      const { cmdCtx } = createMockContext({
        engine: { compactNow: hostCompactNow },
      });

      const fallbackAgent = {
        session: cmdCtx.session,
        ctx: {},
      };

      const mockSessionManager = {
        sessionIdToPeer: vi.fn(() => 'user:1000000001'),
        getOrCreateAgent: vi.fn(async () => fallbackAgent),
      };

      const customCmdCtx: CommandContext = {
        ...cmdCtx,
        sessionManager: mockSessionManager as any,
      };

      // 覆盖 ctx.get('agents') 使其返回空
      (customCmdCtx.ctx as any).get = (name: string) => {
        if (name === 'agents') {
          return { get: () => undefined };
        }
        if (name === 'compaction') {
          return { compactNow: hostCompactNow };
        }
        return (cmdCtx.ctx as any).get(name);
      };

      const res = await handleSlashCommand('/压缩', customCmdCtx);
      expect(res.handled).toBe(true);
      expect(res.success).toBe(true);
      await res.followUp!();
      expect(mockSessionManager.getOrCreateAgent).toHaveBeenCalledWith('user:1000000001');
      expect(hostCompactNow).toHaveBeenCalledWith(fallbackAgent, expect.any(AbortSignal));
    });

    it('当会话未挂载 compaction 且 host 无服务时，如实返回服务不可用提示，绝不抛出 without inject 异常', async () => {
      const { cmdCtx } = createMockContext();
      const mockAgent = { session: cmdCtx.session, ctx: {} };
      (cmdCtx.ctx as any).get = (name: string) => {
        if (name === 'agentPresets') return { serviceFor: () => undefined };
        if (name === 'compaction') return undefined; // host 平面不可用
        if (name === 'agents') return { get: () => mockAgent };
        return undefined;
      };

      const res = await handleSlashCommand('/压缩', cmdCtx);
      expect(res.handled).toBe(true);
      expect(res.success).toBe(false);
      expect(res.error).toBe('压缩服务不可用：当前会话未挂载压缩能力。');
    });
  });

  describe('契约 4: 运行时预设中必须包含 compaction 组插件', () => {
    it('getRuntimePresetDefinition 必须包含 id 为 compaction 的 group 插件并配齐三件套', () => {
      const presetDef = getRuntimePresetDefinition();
      const plugins = presetDef.plugins;
      const compactionPlugin = plugins.find((p: any) => p.id === 'compaction');

      expect(compactionPlugin).toBeDefined();
      expect(compactionPlugin?.name).toBe('cordis:group');
      expect(compactionPlugin?.group).toBe(true);
      expect(compactionPlugin?.isolate).toEqual({
        compaction: true,
        toolResultPruner: true,
      });

      expect(Array.isArray(compactionPlugin?.config)).toBe(true);
      const childIds = compactionPlugin?.config.map((c: any) => c.id);
      expect(childIds).toContain('compaction-basic');
      expect(childIds).toContain('command-compact');
      expect(childIds).toContain('tool-result-pruner');
    });
  });

  describe('契约 5: 网关两段式下发闭环验证 (Gateway Two-Stage Dispatch Contract)', () => {
    it('当收到 /压缩 命令且存在 followUp 时，网关先发送正在压缩回执，随后异步追发完成消息', async () => {
      const sentMessages: string[] = [];
      const mockServer = {
        sendPrivateMsg: vi.fn(async (_uid: any, msg: string) => {
          sentMessages.push(msg);
        }),
        sendGroupMsg: vi.fn(async (_gid: any, msg: string) => {
          sentMessages.push(msg);
        }),
      };

      const mockCompactNow = vi.fn(async () => ({
        shadowedSeqs: [1, 2],
        shadowedTokenCount: 1024,
      }));

      const { cmdCtx } = createMockContext({
        scopedEngine: { compactNow: mockCompactNow },
      });

      // 模拟网关事件分发闭环 (对齐 src/index.ts 870-910 装配逻辑)
      const isGroup = false;
      const event = { user_id: 1000000001 };
      const result = await handleSlashCommand('/压缩', cmdCtx);

      const replyText = result.reply || result.error;
      if (replyText) {
        if (isGroup) {
          await mockServer.sendGroupMsg(123456, replyText);
        } else {
          await mockServer.sendPrivateMsg(event.user_id, replyText);
        }
      }

      expect(sentMessages).toEqual(['正在压缩会话历史…']);

      if (typeof result.followUp === 'function') {
        const followUpText = await result.followUp();
        if (followUpText) {
          if (isGroup) {
            await mockServer.sendGroupMsg(123456, followUpText);
          } else {
            await mockServer.sendPrivateMsg(event.user_id, followUpText);
          }
        }
      }

      expect(sentMessages).toHaveLength(2);
      expect(sentMessages[0]).toBe('正在压缩会话历史…');
      expect(sentMessages[1]).toContain('已压缩 2 条历史');
      expect(sentMessages[1]).toContain('当前上下文：');
    });
  });
});
