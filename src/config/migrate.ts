/**
 * dsh-napcat-bridge: 旧版配置静默迁移
 *
 * 将 0.1.5 时代的 settings.yaml 中的 dsh-napcat-bridge 配置
 * 迁移至 0.2.1 Profile Patch / Volatile Settings 体系。
 * 迁移过程不阻断应用启动，迁移后内部不再保留任何对旧配置文件的读写技术债。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import type { Context } from '@deepseek-ai/cordis';
import type { BridgePluginConfig } from '../types/index.js';
import { PLUGIN_NAME, SETTINGS_NAMESPACE } from '../constants/index.js';
import { migrateLegacyConfigKeys } from './legacy.js';

const require = createRequire(import.meta.url);

export function resolveDshHome(explicitHome?: string): string {
  if (explicitHome && explicitHome.trim()) {
    return path.resolve(explicitHome);
  }
  return path.resolve(
    process.env.DSH_HOME || path.join(process.env.HOME || process.env.USERPROFILE || '/tmp', '.dsh')
  );
}

function parseYaml(content: string): any {
  // 1. 优先通过 @deepseek-ai/dsh-app-boot 加载 js-yaml
  try {
    const bootPkg = require.resolve('@deepseek-ai/dsh-app-boot/package.json');
    const bootReq = createRequire(bootPkg);
    const jsYaml = bootReq('js-yaml');
    if (typeof jsYaml.load === 'function') {
      return jsYaml.load(content);
    }
  } catch {
    // ignore
  }

  // 2. 回退通过 @deepseek-ai/dsh-settings 加载 yaml
  try {
    const settingsPkg = require.resolve('@deepseek-ai/dsh-settings/package.json');
    const settingsReq = createRequire(settingsPkg);
    const yaml = settingsReq('yaml');
    if (typeof yaml.parse === 'function') {
      return yaml.parse(content);
    }
  } catch {
    // ignore
  }

  // 3. 兜底直接 require('js-yaml')
  try {
    const jsYaml = require('js-yaml');
    if (typeof jsYaml.load === 'function') {
      return jsYaml.load(content);
    }
  } catch {
    // ignore
  }

  return undefined;
}

/**
 * 探测并读取旧版配置文件中的 dsh-napcat-bridge 配置字典。
 * 用于首次启动且 profile 配置尚未持久化时的内存兼容。
 */
export function readLegacyConfig(explicitHome?: string): BridgePluginConfig | undefined {
  const dshHome = resolveDshHome(explicitHome);
  const candidateFiles = [
    path.join(dshHome, 'settings.yaml'),
    path.join(dshHome, 'settings.yaml.imported'),
  ];

  for (const file of candidateFiles) {
    if (fs.existsSync(file)) {
      try {
        const content = fs.readFileSync(file, 'utf8');
        if (content.includes(SETTINGS_NAMESPACE)) {
          const doc = parseYaml(content);
          const legacyValues = doc?.[SETTINGS_NAMESPACE];
          if (legacyValues && typeof legacyValues === 'object' && Object.keys(legacyValues).length > 0) {
            // 历史字段映射统一由 legacy.ts 维护
            const config = migrateLegacyConfigKeys({ ...legacyValues } as any);
            return config as BridgePluginConfig;
          }
        }
      } catch {
        // ignore
      }
    }
  }
  return undefined;
}

let migrationExecuted = false;

/** 供测试隔离重置使用 */
export function _resetMigrationExecutedForTesting(): void {
  migrationExecuted = false;
}

/**
 * 探测旧版配置文件并静默迁移 dsh-napcat-bridge 配置到当前 profile。
 * 必须在应用 ready 或异步非阻塞状态下调用，避免死锁。
 */
export async function migrateLegacyConfig(ctx: Context, currentConfig: BridgePluginConfig): Promise<void> {
  if (migrationExecuted) {
    return;
  }
  migrationExecuted = true;

  const logger = (ctx as any).logger ? (ctx as any).logger(PLUGIN_NAME) : console;
  try {
    // a. 若当前配置已由 profile 驱动或已配置，直接跳过
    const settingsService = (ctx as any).get?.('settings');
    let profileSettings: any = undefined;
    if (typeof settingsService?.describe === 'function') {
      const desc = settingsService.describe().find((d: any) => d.ns === SETTINGS_NAMESPACE);
      if (desc?.value) profileSettings = desc.value;
    } else if (typeof settingsService?.get === 'function') {
      profileSettings = settingsService.get(SETTINGS_NAMESPACE);
    }
    if (profileSettings && Object.keys(profileSettings).length > 0) {
      return;
    }

    const rawBotQQ =
      typeof (currentConfig?.bot_qq as any)?.get === 'function'
        ? (currentConfig.bot_qq as any).get()
        : currentConfig?.bot_qq;
    const rawWsToken =
      typeof (currentConfig?.ws_token as any)?.get === 'function'
        ? (currentConfig.ws_token as any).get()
        : currentConfig?.ws_token;

    if (
      (rawBotQQ && String(rawBotQQ).trim() !== '') ||
      (rawWsToken && String(rawWsToken).trim() !== '')
    ) {
      return;
    }

    // b. 探测旧版配置
    const legacyValues = readLegacyConfig();
    if (!legacyValues) {
      return;
    }

    logger.info?.(`[Plugin] 检测到旧版配置文件中的 ${SETTINGS_NAMESPACE} 配置，开始静默迁移至当前 profile...`);

    // c. 准备 3 秒硬超时写入 settings
    const applyToSettings = async (svc: any): Promise<boolean> => {
      const withTimeout = async <T>(promise: Promise<T>, ms: number): Promise<T> => {
        let timer: ReturnType<typeof setTimeout>;
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Settings operation timed out')), ms);
        });
        try {
          return await Promise.race([promise, timeout]);
        } finally {
          clearTimeout(timer!);
        }
      };

      if (typeof svc?.update === 'function') {
        await withTimeout(svc.update(SETTINGS_NAMESPACE, legacyValues), 3000);
        return true;
      }
      if (typeof svc?.mutate === 'function') {
        const ops = Object.entries(legacyValues).map(([key, value]) => ({
          op: 'set' as const,
          path: [key],
          value,
        }));
        await withTimeout(svc.mutate(SETTINGS_NAMESPACE, ops), 3000);
        return true;
      }
      return false;
    };

    const directSettings = (ctx as any).get?.('settings');
    if (directSettings) {
      try {
        const migrated = await applyToSettings(directSettings);
        if (migrated) {
          logger.info?.(`[Plugin] 旧版配置已成功静默迁移至当前 profile`);
          return;
        }
      } catch (err) {
        logger.warn?.('[Plugin] 静默迁移写入 settings 异常（非致命）：', err);
      }
    }

    // 若 settings 尚未注入，异步等待 settings 服务准备就绪（最多等待 3 秒）
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, 3000);
      const dispose = (ctx as any).inject(['settings'], async (subCtx: any) => {
        try {
          clearTimeout(timeout);
          if (typeof dispose === 'function') (dispose as any)();
          const s = (subCtx as any).settings;
          const migrated = await applyToSettings(s);
          if (migrated) {
            logger.info?.(`[Plugin] 旧版配置已成功静默迁移至当前 profile (via settings inject)`);
          }
        } catch (e) {
          logger.info?.('[Plugin] 静默迁移写入 settings 失败：', e);
        } finally {
          resolve();
        }
      });
    });
  } catch (err) {
    // 整个过程 try-catch 包裹，只记录日志，失败不阻断应用启动
    logger.info?.('[Plugin] 静默迁移检查跳过或未执行：', err);
  }
}
