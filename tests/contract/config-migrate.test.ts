import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fsp } from 'node:fs';
import {
  readLegacyConfig,
  migrateLegacyConfig,
  _resetMigrationExecutedForTesting,
} from '../../src/config/migrate.js';
import { SETTINGS_NAMESPACE } from '../../src/constants/index.js';
import type { BridgePluginConfig } from '../../src/types/index.js';

describe('契约测试: 旧版配置静默探测与迁移 (migrate.ts)', () => {
  let tmpHome: string;

  beforeEach(async () => {
    tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-napcat-migrate-'));
    _resetMigrationExecutedForTesting();
  });

  afterEach(async () => {
    if (tmpHome) {
      await fsp.rm(tmpHome, { recursive: true, force: true }).catch(() => {});
    }
  });

  describe('1. readLegacyConfig 探测与解析', () => {
    it('当 settings.yaml 不存在时返回 undefined', () => {
      const result = readLegacyConfig(tmpHome);
      expect(result).toBeUndefined();
    });

    it('当 settings.yaml 存在且包含 dsh-napcat-bridge 配置时正确读取', async () => {
      const yamlContent = `
${SETTINGS_NAMESPACE}:
  ws_port: 8090
  ws_token: legacy-token-abc
  bot_qq: "987654321"
`;
      await fsp.writeFile(path.join(tmpHome, 'settings.yaml'), yamlContent, 'utf8');

      const result = readLegacyConfig(tmpHome);
      expect(result).toBeDefined();
      expect(result?.ws_port).toBe(8090);
      expect(result?.ws_token).toBe('legacy-token-abc');
      expect(result?.bot_qq).toBe('987654321');
    });

    it('当旧配置包含 memory_budget_chars 时正确映射至 group_memory_budget_chars', async () => {
      const yamlContent = `
${SETTINGS_NAMESPACE}:
  ws_port: 8080
  memory_budget_chars: 3500
`;
      await fsp.writeFile(path.join(tmpHome, 'settings.yaml'), yamlContent, 'utf8');

      const result = readLegacyConfig(tmpHome);
      expect(result).toBeDefined();
      expect(result?.group_memory_budget_chars).toBe(3500);
    });

    it('支持从 settings.yaml.imported 读取旧配置', async () => {
      const yamlContent = `
${SETTINGS_NAMESPACE}:
  ws_port: 8095
  bot_qq: "11223344"
`;
      await fsp.writeFile(path.join(tmpHome, 'settings.yaml.imported'), yamlContent, 'utf8');

      const result = readLegacyConfig(tmpHome);
      expect(result).toBeDefined();
      expect(result?.ws_port).toBe(8095);
      expect(result?.bot_qq).toBe('11223344');
    });
  });

  describe('2. migrateLegacyConfig 异步迁移契约', () => {
    it('当当前配置已有 bot_qq 时视为已配置，直接跳过迁移', async () => {
      const mutateMock = vi.fn();
      const mockCtx: any = {
        get: vi.fn((name) => (name === 'settings' ? { mutate: mutateMock } : undefined)),
        inject: vi.fn(),
      };

      const currentConfig: BridgePluginConfig = {
        bot_qq: '12345678',
      };

      await migrateLegacyConfig(mockCtx, currentConfig);
      expect(mutateMock).not.toHaveBeenCalled();
    });

    it('当当前配置已有 ws_token 时视为已配置，直接跳过迁移', async () => {
      const mutateMock = vi.fn();
      const mockCtx: any = {
        get: vi.fn((name) => (name === 'settings' ? { mutate: mutateMock } : undefined)),
        inject: vi.fn(),
      };

      const currentConfig: BridgePluginConfig = {
        ws_token: 'existing-token',
      };

      await migrateLegacyConfig(mockCtx, currentConfig);
      expect(mutateMock).not.toHaveBeenCalled();
    });

    it('当 profile settings 已有配置项时直接跳过迁移', async () => {
      const mutateMock = vi.fn();
      const mockCtx: any = {
        get: vi.fn((name) =>
          name === 'settings'
            ? {
                get: vi.fn(() => ({ ws_port: 8080 })),
                mutate: mutateMock,
              }
            : undefined
        ),
        inject: vi.fn(),
      };

      await migrateLegacyConfig(mockCtx, {});
      expect(mutateMock).not.toHaveBeenCalled();
    });

    it('幂等性契约：同一个生命周期内 migrateLegacyConfig 只执行一次', async () => {
      const updateMock = vi.fn().mockResolvedValue({ ok: true });
      const mockCtx: any = {
        get: vi.fn((name) =>
          name === 'settings'
            ? {
                get: vi.fn(() => undefined),
                update: updateMock,
              }
            : undefined
        ),
        inject: vi.fn(),
      };

      await migrateLegacyConfig(mockCtx, {});
      expect(updateMock).toHaveBeenCalledTimes(1);
      // 第二次调用时因 migrationExecuted = true 立即返回，不会再次调用
      await migrateLegacyConfig(mockCtx, {});
      expect(updateMock).toHaveBeenCalledTimes(1);
    });
  });
});

