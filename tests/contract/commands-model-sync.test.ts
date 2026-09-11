import { describe, it, expect, vi } from 'vitest';
import { safeSyncSessionModel, getDiscoveredModels } from '../../src/commands/index.js';
import type { Context } from '@deepseek-ai/cordis';

describe('契约测试: safeSyncSessionModel 并发互斥锁与模型目录补齐 (Commands Model Sync Contract)', () => {
  describe('契约 1: getDiscoveredModels 模型目录包含 deepseek-flash', () => {
    it('在保底模式下应包含 deepseek-flash (DeepSeek-V41-Flash) 与 deepseek-v4-flash', async () => {
      const mockCtx = {
        get: () => null,
      } as unknown as Context;

      const models = await getDiscoveredModels(mockCtx);
      const flashV41 = models.find(
        (m) => m.provider === 'deepseek-official' && m.model === 'deepseek-flash'
      );
      expect(flashV41).toBeDefined();
      expect(flashV41?.modelName).toBe('DeepSeek-V41-Flash');

      const flashV4 = models.find(
        (m) => m.provider === 'deepseek-official' && m.model === 'deepseek-v4-flash'
      );
      expect(flashV4).toBeDefined();
      expect(flashV4?.modelName).toBe('DeepSeek-V4-Flash');
    });

    it('在动态 llm 服务存在时能够正确列举模型', async () => {
      const mockCtx = {
        get: (name: string) => {
          if (name === 'llm') {
            return {
              listProviders: () => [{ id: 'deepseek-official', name: 'DeepSeek' }],
              listModels: async (providerId: string) => {
                if (providerId === 'deepseek-official') {
                  return [
                    { id: 'deepseek-flash', name: 'DeepSeek-V41-Flash' },
                    { id: 'deepseek-chat', name: 'DeepSeek-V3' },
                  ];
                }
                return [];
              },
            };
          }
          return null;
        },
      } as unknown as Context;

      const models = await getDiscoveredModels(mockCtx);
      expect(models).toHaveLength(2);
      expect(models[0]).toEqual({
        provider: 'deepseek-official',
        providerName: 'DeepSeek',
        model: 'deepseek-flash',
        modelName: 'DeepSeek-V41-Flash',
      });
    });
  });

  describe('契约 2: safeSyncSessionModel 高并发互斥锁防污染保护', () => {
    it('高并发调用 safeSyncSessionModel 时，saveSelection 在所有并发结束后被完整正确还原', async () => {
      const trueOriginalSave = vi.fn(async (_selection: any) => {});
      const agentDefaultModel = {
        saveSelection: trueOriginalSave,
      };

      const selectModelCalls: any[] = [];
      const sessionController = {
        selectModel: vi.fn(async (req: any) => {
          selectModelCalls.push(req);
          // 模拟 DSH 官方 selectModel 内部无条件调用 saveSelection
          await agentDefaultModel.saveSelection(req);
          // 模拟异步延迟以激化并发交叉
          await new Promise((resolve) => setTimeout(resolve, 15));
          return { selected: { provider: req.provider, model: req.model } };
        }),
      };

      const mockCtx = {
        get: (name: string) => {
          if (name === 'sessionController') return sessionController;
          if (name === 'agentDefaultModel') return agentDefaultModel;
          return null;
        },
      } as unknown as Context;

      const CONCURRENCY = 20;
      const tasks = Array.from({ length: CONCURRENCY }, (_, i) =>
        safeSyncSessionModel(
          mockCtx,
          `session-concurrent-${i}`,
          'deepseek-official',
          'deepseek-flash',
          i % 2 === 0 ? 'high' : undefined
        )
      );

      await Promise.all(tasks);

      // 1. 所有调用均已执行
      expect(selectModelCalls).toHaveLength(CONCURRENCY);

      // 2. 在 safeSyncSessionModel 执行期间，真实的 saveSelection 被拦截，未被触发
      expect(trueOriginalSave).toHaveBeenCalledTimes(0);

      // 3. 所有并发执行完毕后，saveSelection 必须被严格还原为原函数，不得残留 dummy
      expect(agentDefaultModel.saveSelection).toBe(trueOriginalSave);

      // 4. 后续正常业务调用必须能正常触发 trueOriginalSave
      await agentDefaultModel.saveSelection({ provider: 'deepseek-official', model: 'deepseek-chat' });
      expect(trueOriginalSave).toHaveBeenCalledTimes(1);
    });

    it('当 selectModel 发生内部异常时，并发锁与原函数仍能安全恢复', async () => {
      const trueOriginalSave = vi.fn(async (_selection: any) => {});
      const agentDefaultModel = {
        saveSelection: trueOriginalSave,
      };

      let failOnce = true;
      const sessionController = {
        selectModel: vi.fn(async (req: any) => {
          await agentDefaultModel.saveSelection(req);
          await new Promise((resolve) => setTimeout(resolve, 10));
          if (failOnce) {
            failOnce = false;
            throw new Error('Simulated selectModel internal failure');
          }
          return { selected: req };
        }),
      };

      const mockCtx = {
        get: (name: string) => {
          if (name === 'sessionController') return sessionController;
          if (name === 'agentDefaultModel') return agentDefaultModel;
          return null;
        },
      } as unknown as Context;

      const tasks = [
        safeSyncSessionModel(mockCtx, 'session-fail', 'deepseek-official', 'deepseek-flash'),
        safeSyncSessionModel(mockCtx, 'session-success', 'deepseek-official', 'deepseek-flash'),
      ];

      await Promise.all(tasks);

      expect(agentDefaultModel.saveSelection).toBe(trueOriginalSave);
      await agentDefaultModel.saveSelection({ test: true });
      expect(trueOriginalSave).toHaveBeenCalledTimes(1);
    });
  });
});
