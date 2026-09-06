import { describe, it, expect, vi } from 'vitest';

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  IconChevronDownOutline14: () => null,
}));

import { buildSettingsBridge } from '../../src/client/index.js';
import { SETTINGS_NAMESPACE } from '../../src/constants/index.js';

describe('契约测试: 设置卡片保存 API (settingsScope.mutate)', () => {
  const ns = SETTINGS_NAMESPACE;

  describe('1. 守卫契约', () => {
    it('当 ctx.settingsScope 缺失时抛出「settings API 不可用」', async () => {
      const bridge = buildSettingsBridge({}, ns);
      await expect(
        bridge.onSaveSettings({ image_ttl_days: 7 }, { expectedRevision: 1 })
      ).rejects.toThrow('settings API 不可用');
    });

    it('当 ctx.settingsScope.bind 返回对象没有 mutate 方法时抛出「settings API 不可用」', async () => {
      const ctx = {
        settingsScope: {
          bind: vi.fn().mockReturnValue({}),
        },
      };
      const bridge = buildSettingsBridge(ctx, ns);
      await expect(
        bridge.onSaveSettings({ image_ttl_days: 7 }, { expectedRevision: 1 })
      ).rejects.toThrow('settings API 不可用');
    });

    it('当 ctx.settingsScope 既无 bind 也无 mutate 时抛出「settings API 不可用」', async () => {
      const ctx = {
        settingsScope: {},
      };
      const bridge = buildSettingsBridge(ctx, ns);
      await expect(
        bridge.onSaveSettings({ image_ttl_days: 7 }, { expectedRevision: 1 })
      ).rejects.toThrow('settings API 不可用');
    });
  });

  describe('2. Op 构建契约', () => {
    it('逐字段构建 [{ op: "set", path: [field], value }] 格式操作数组', async () => {
      const mutateFn = vi.fn().mockResolvedValue({
        ok: true,
        value: { revision: 2 },
      });
      const ctx = {
        settingsScope: {
          bind: vi.fn().mockReturnValue({
            mutate: mutateFn,
          }),
        },
      };

      const bridge = buildSettingsBridge(ctx, ns);
      await bridge.onSaveSettings(
        {
          quote_original: false,
          at_questioner: true,
          image_ttl_days: 14,
          aliases: ['雪梨', '小梨'],
        },
        { expectedRevision: 1 }
      );

      expect(ctx.settingsScope.bind).toHaveBeenCalledWith({ namespace: ns });
      expect(mutateFn).toHaveBeenCalledTimes(1);

      const [ops, rev] = mutateFn.mock.calls[0];
      expect(rev).toBe(1);
      expect(ops).toEqual([
        { op: 'set', path: ['quote_original'], value: false },
        { op: 'set', path: ['at_questioner'], value: true },
        { op: 'set', path: ['image_ttl_days'], value: 14 },
        { op: 'set', path: ['aliases'], value: ['雪梨', '小梨'] },
      ]);
    });

    it('values 为空对象时构建空 ops 数组并正常返回', async () => {
      const mutateFn = vi.fn().mockResolvedValue({
        ok: true,
        value: { revision: 1 },
      });
      const ctx = {
        settingsScope: {
          bind: vi.fn().mockReturnValue({
            mutate: mutateFn,
          }),
        },
      };

      const bridge = buildSettingsBridge(ctx, ns);
      const res = await bridge.onSaveSettings({}, { expectedRevision: 1 });

      expect(mutateFn).toHaveBeenCalledWith([], 1);
      expect(res).toEqual({ revision: 1 });
    });
  });

  describe('3. Mutate 调用与 Revision 返回契约', () => {
    it('当 mutate 返回 { ok: true, value: { revision } } 时正确返回 revision', async () => {
      const mutateFn = vi.fn().mockResolvedValue({
        ok: true,
        value: { revision: 42 },
      });
      const ctx = {
        settingsScope: {
          bind: vi.fn().mockReturnValue({
            mutate: mutateFn,
          }),
        },
      };

      const bridge = buildSettingsBridge(ctx, ns);
      const res = await bridge.onSaveSettings(
        { image_ttl_days: 7 },
        { expectedRevision: 5 }
      );

      expect(res).toEqual({ revision: 42 });
    });

    it('适配官方 SettingsScopeController（mutate 返回 void，经 snapshot/describe 观测新版本）', async () => {
      let currentRevision = 1;
      let currentValue: Record<string, unknown> = { image_ttl_days: 7 };

      const mockSnapshot = () => ({
        view: {
          namespaces: [
            {
              ns,
              revision: currentRevision,
              value: currentValue,
              base: {},
            },
          ],
        },
      });

      const mutateFn = vi.fn().mockImplementation(async (ops, expectedRev) => {
        for (const op of ops) {
          currentValue[op.path[0]] = op.value;
        }
        currentRevision = expectedRev + 1;
        return undefined;
      });

      const ctx = {
        settingsScope: {
          describe: () => ({
            getSnapshot: mockSnapshot,
          }),
          bind: vi.fn().mockReturnValue({
            mutate: mutateFn,
            getSnapshot: () => ({
              revision: currentRevision,
              value: currentValue,
              status: 'ready',
            }),
          }),
        },
      };

      const bridge = buildSettingsBridge(ctx, ns);
      const res = await bridge.onSaveSettings(
        { image_ttl_days: 10 },
        { expectedRevision: 1 }
      );

      expect(mutateFn).toHaveBeenCalledWith(
        [{ op: 'set', path: ['image_ttl_days'], value: 10 }],
        1
      );
      expect(res).toEqual({ revision: 2 });
      expect(bridge.revision).toBe(2);
      expect(bridge.initialConfig).toEqual({ image_ttl_days: 10 });
    });
  });

  describe('4. 版本冲突重试契约', () => {
    it('当 mutate 响应 ok=false 且发生版本冲突时，重读最新版本号并重试一次', async () => {
      let currentRevision = 1;

      const mockSnapshot = () => ({
        view: {
          namespaces: [
            {
              ns,
              revision: currentRevision,
              value: { image_ttl_days: 7 },
              base: {},
            },
          ],
        },
      });

      const mutateFn = vi
        .fn()
        .mockImplementationOnce(async () => {
          currentRevision = 2;
          return {
            ok: false,
            error: {
              code: 'SETTINGS_CONFLICT',
              message: 'expected revision 1, but got 2',
            },
          };
        })
        .mockImplementationOnce(async (ops, rev) => {
          expect(rev).toBe(2);
          currentRevision = 3;
          return {
            ok: true,
            value: { revision: 3 },
          };
        });

      const ctx = {
        settingsScope: {
          describe: () => ({
            getSnapshot: mockSnapshot,
          }),
          bind: vi.fn().mockReturnValue({
            mutate: mutateFn,
          }),
        },
      };

      const bridge = buildSettingsBridge(ctx, ns);
      const res = await bridge.onSaveSettings(
        { image_ttl_days: 14 },
        { expectedRevision: 1 }
      );

      expect(mutateFn).toHaveBeenCalledTimes(2);
      expect(res).toEqual({ revision: 3 });
    });

    it('当 mutate 抛出版本冲突异常时，重读最新版本号并重试一次', async () => {
      let currentRevision = 1;

      const mockSnapshot = () => ({
        view: {
          namespaces: [
            {
              ns,
              revision: currentRevision,
              value: { image_ttl_days: 7 },
              base: {},
            },
          ],
        },
      });

      const mutateFn = vi
        .fn()
        .mockImplementationOnce(async () => {
          currentRevision = 2;
          const err: any = new Error('Settings document changed since it was read');
          err.code = 'SETTINGS_CONFLICT';
          throw err;
        })
        .mockImplementationOnce(async (_ops, rev) => {
          expect(rev).toBe(2);
          currentRevision = 3;
          return {
            ok: true,
            value: { revision: 3 },
          };
        });

      const ctx = {
        settingsScope: {
          describe: () => ({
            getSnapshot: mockSnapshot,
          }),
          bind: vi.fn().mockReturnValue({
            mutate: mutateFn,
          }),
        },
      };

      const bridge = buildSettingsBridge(ctx, ns);
      const res = await bridge.onSaveSettings(
        { image_ttl_days: 14 },
        { expectedRevision: 1 }
      );

      expect(mutateFn).toHaveBeenCalledTimes(2);
      expect(res).toEqual({ revision: 3 });
    });

    it('当重试后仍失败时，正确抛出异常', async () => {
      let currentRevision = 1;
      const mockSnapshot = () => ({
        view: {
          namespaces: [
            {
              ns,
              revision: currentRevision,
              value: {},
              base: {},
            },
          ],
        },
      });

      const mutateFn = vi
        .fn()
        .mockImplementationOnce(async () => {
          currentRevision = 2;
          return {
            ok: false,
            error: { message: 'conflict error 1' },
          };
        })
        .mockImplementationOnce(async () => {
          return {
            ok: false,
            error: { message: 'conflict error 2' },
          };
        });

      const ctx = {
        settingsScope: {
          describe: () => ({
            getSnapshot: mockSnapshot,
          }),
          bind: vi.fn().mockReturnValue({
            mutate: mutateFn,
          }),
        },
      };

      const bridge = buildSettingsBridge(ctx, ns);
      await expect(
        bridge.onSaveSettings({ image_ttl_days: 14 }, { expectedRevision: 1 })
      ).rejects.toThrow('conflict error 2');
    });
  });

  describe('5. 读取路径契约', () => {
    it('通过 settingsScope.describe 正确读取 initialConfig、revision 与 baseDefaults', () => {
      const ctx = {
        settingsScope: {
          describe: () => ({
            getSnapshot: () => ({
              view: {
                namespaces: [
                  {
                    ns,
                    revision: 7,
                    value: { ws_port: 8080, persona: '猫娘' },
                    base: { ws_port: 8080, persona: '默认' },
                  },
                ],
              },
            }),
          }),
        },
      };

      const bridge = buildSettingsBridge(ctx, ns);
      expect(bridge.revision).toBe(7);
      expect(bridge.initialConfig).toEqual({ ws_port: 8080, persona: '猫娘' });
      expect(bridge.baseDefaults).toEqual({ ws_port: 8080, persona: '默认' });
      expect(bridge.hasSecret).toBe(false);
    });

    it('当 describe 缺失时降级从 bound scope.getSnapshot() 读取', () => {
      const ctx = {
        settingsScope: {
          bind: vi.fn().mockReturnValue({
            getSnapshot: () => ({
              status: 'ready',
              revision: 4,
              value: { ws_port: 3001 },
              base: { ws_port: 8080 },
            }),
            mutate: vi.fn(),
          }),
        },
      };

      const bridge = buildSettingsBridge(ctx, ns);
      expect(bridge.revision).toBe(4);
      expect(bridge.initialConfig).toEqual({ ws_port: 3001 });
      expect(bridge.baseDefaults).toEqual({ ws_port: 8080 });
    });
  });
});
