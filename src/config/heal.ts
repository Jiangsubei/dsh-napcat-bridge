/**
 * dsh-napcat-bridge: 配置动态校验与自愈模块 (Self-Healing Configuration Engine)
 *
 * 核心设计：以 src/config/schema.ts 中的 BridgeConfigSchema 为单一真相源（SSOT），
 * 提供运行时配置清洗与物理配置文件主动自愈能力：
 *   1. getValidConfigKeys: 动态提取当前 Schema 支持的全量有效 volatile 键集合；
 *   2. sanitizeConfigPayload: 纯函数，分离有效配置与无效/过期字段；
 *   3. healProfileConfigFile: 物理级安全自愈，扫描并移除 profile patch 中残留的已废弃死配置；
 *   4. 一次改造，终身受益：无论后续如何增删配置，自愈机制全生命周期自洽运作。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { BridgeConfigSchema } from './schema.js';
import { LEGACY_CONFIG_KEY_MIGRATIONS, migrateLegacyConfigKeys } from './legacy.js';
import type { BridgePluginConfig } from '../types/index.js';
import { PLUGIN_NAME, SETTINGS_NAMESPACE } from '../constants/index.js';

/**
 * 动态获取当前配置 Schema 定义的所有有效键集合 (单一真相源)
 */
export function getValidConfigKeys(): Set<string> {
  const dict = (BridgeConfigSchema as any).dict || (BridgeConfigSchema as any).shape || {};
  return new Set(Object.keys(dict));
}

export interface SanitizeResult {
  valid: BridgePluginConfig;
  removed: string[];
}

/**
 * 纯函数：根据当前 Schema 清洗配置对象，分离出干净合法的配置项与脏键/过期键。
 * 清洗前先将历史配置键的值搬运到当前键，避免升级后用户配置丢失。
 */
export function sanitizeConfigPayload<T extends Record<string, any>>(raw: T): SanitizeResult {
  if (!raw || typeof raw !== 'object') {
    return { valid: {}, removed: [] };
  }

  const migrated = migrateLegacyConfigKeys(raw);
  const validKeys = getValidConfigKeys();
  const valid: Record<string, any> = {};
  const removed: string[] = [];

  for (const [key, value] of Object.entries(migrated)) {
    if (validKeys.has(key)) {
      valid[key] = value;
    } else {
      removed.push(key);
    }
  }

  return { valid: valid as BridgePluginConfig, removed };
}

/**
 * 外科手术式行级 YAML 清洗：
 * 仅定位指定 pluginId 下的 config 节点，精确删除其中的 staleKeys，
 * 并将 renameMap 中指定的历史键原地重命名为当前键（保留原值与其子块），
 * 绝不重排整个文件，严格保留用户的缩进、注释、空行与 !!js 等特殊语法。
 */
export function surgicalCleanYamlConfig(
  yamlContent: string,
  pluginId: string,
  staleKeys: Set<string>,
  renameMap: Map<string, string> = new Map()
): {
  newContent: string;
  removedKeys: string[];
  renamedKeys: Array<{ from: string; to: string }>;
} {
  if (!staleKeys.size && !renameMap.size) {
    return { newContent: yamlContent, removedKeys: [], renamedKeys: [] };
  }

  const lines = yamlContent.split('\n');
  let inTargetPlugin = false;
  let inConfig = false;
  let configIndent = -1;
  const removed = new Set<string>();
  const renamed: Array<{ from: string; to: string }> = [];
  const outputLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // 检测顶层列表项声明 (例如: "- id: dsh-napcat-bridge" 或 "- id: ui-theme")
    if (/^-\s+id:\s*/.test(line)) {
      if (line.includes(pluginId)) {
        inTargetPlugin = true;
      } else {
        inTargetPlugin = false;
      }
      inConfig = false;
      configIndent = -1;
      outputLines.push(line);
      continue;
    }

    if (inTargetPlugin) {
      // 检测进入 config 节点
      const configMatch = line.match(/^(\s+)config:\s*$/);
      if (configMatch) {
        inConfig = true;
        configIndent = configMatch[1].length;
        outputLines.push(line);
        continue;
      }

      if (inConfig) {
        const lineIndent = line.search(/\S/);
        // 若缩进小于等于 configIndent 且非空行，说明已退出 config 块
        if (line.trim().length > 0 && lineIndent !== -1 && lineIndent <= configIndent) {
          inConfig = false;
          outputLines.push(line);
          continue;
        }

        const keyMatch = line.match(/^(\s+)([a-zA-Z0-9_]+):(.*)$/);
        const configKey = keyMatch?.[2];

        // 历史键原地重命名，保留原值与多行子块
        if (configKey && renameMap.has(configKey)) {
          const targetKey = renameMap.get(configKey)!;
          outputLines.push(`${keyMatch![1]}${targetKey}:${keyMatch![3]}`);
          renamed.push({ from: configKey, to: targetKey });
          continue;
        }

        // 检查是否是需要剔除的过期键
        if (configKey && staleKeys.has(configKey)) {
          removed.add(configKey);
          // 若该键的值为多行（如缩进的数组或多行字符串），跳过后续所有更深缩进的行
          let j = i + 1;
          while (j < lines.length) {
            const nextLine = lines[j];
            if (nextLine.trim().length === 0) {
              j++;
              continue;
            }
            const nextIndent = nextLine.search(/\S/);
            if (nextIndent !== -1 && nextIndent > lineIndent) {
              j++;
            } else {
              break;
            }
          }
          i = j - 1; // 跳过整个子块
          continue;
        }
      }
    }

    outputLines.push(line);
  }

  return {
    newContent: outputLines.join('\n'),
    removedKeys: Array.from(removed),
    renamedKeys: renamed,
  };
}

export interface HealResult {
  healed: boolean;
  removedKeys: string[];
  renamedKeys?: Array<{ from: string; to: string }>;
  filePath?: string;
}

/**
 * 物理级自愈：探测并清洗 profile 目录下的 cordis.patch.yml 中残留的过期死键
 */
export function healProfileConfigFile(
  explicitDshHome?: string,
  explicitProfile?: string,
  logger?: any
): HealResult {
  const dshHome = explicitDshHome
    ? path.resolve(explicitDshHome)
    : path.resolve(
        process.env.DSH_HOME ||
          path.join(process.env.HOME || process.env.USERPROFILE || '/tmp', '.dsh')
      );

  const candidateProfiles = explicitProfile ? [explicitProfile] : ['desktop', 'default'];
  const validKeys = getValidConfigKeys();

  for (const profile of candidateProfiles) {
    const patchFile = path.join(dshHome, 'profiles', profile, 'cordis.patch.yml');
    if (!fs.existsSync(patchFile)) {
      continue;
    }

    try {
      const content = fs.readFileSync(patchFile, 'utf8');
      if (!content.includes(SETTINGS_NAMESPACE) && !content.includes(PLUGIN_NAME)) {
        continue;
      }

      // 提取目标插件 config 块下所有的 key，比对是否存在脏键
      const lines = content.split('\n');
      const presentKeys = new Set<string>();
      let inTarget = false;
      let inCfg = false;
      let cfgIndent = -1;

      for (const line of lines) {
        if (/^-\s+id:\s*/.test(line)) {
          inTarget = line.includes(SETTINGS_NAMESPACE) || line.includes(PLUGIN_NAME);
          inCfg = false;
          cfgIndent = -1;
          continue;
        }
        if (inTarget) {
          const cfgMatch = line.match(/^(\s+)config:\s*$/);
          if (cfgMatch) {
            inCfg = true;
            cfgIndent = cfgMatch[1].length;
            continue;
          }
          if (inCfg) {
            const indent = line.search(/\S/);
            if (line.trim().length > 0 && indent <= cfgIndent) {
              inCfg = false;
              continue;
            }
            const keyMatch = line.match(/^\s+([a-zA-Z0-9_]+):/);
            if (keyMatch) {
              presentKeys.add(keyMatch[1]);
            }
          }
        }
      }

      const staleKeys = new Set<string>();
      const renameMap = new Map<string, string>();
      const renameTargets = new Set<string>();

      // 按迁移表优先级决定由哪个旧键胜出，避免多代旧键同时存在时产生重复新键
      for (const migration of LEGACY_CONFIG_KEY_MIGRATIONS) {
        if (!presentKeys.has(migration.legacy)) continue;
        if (presentKeys.has(migration.current) || renameTargets.has(migration.current)) {
          staleKeys.add(migration.legacy);
          continue;
        }
        renameMap.set(migration.legacy, migration.current);
        renameTargets.add(migration.current);
      }

      for (const k of presentKeys) {
        if (!validKeys.has(k) && !renameMap.has(k)) {
          staleKeys.add(k);
        }
      }

      if (staleKeys.size > 0 || renameMap.size > 0) {
        const cleaned = surgicalCleanYamlConfig(
          content,
          SETTINGS_NAMESPACE,
          staleKeys,
          renameMap
        );
        if (cleaned.removedKeys.length > 0 || cleaned.renamedKeys.length > 0) {
          fs.writeFileSync(patchFile, cleaned.newContent, 'utf8');
          const details: string[] = [];
          if (cleaned.renamedKeys.length > 0) {
            details.push(
              `已迁移历史配置项: ${cleaned.renamedKeys
                .map((r) => `${r.from} -> ${r.to}`)
                .join(', ')}`
            );
          }
          if (cleaned.removedKeys.length > 0) {
            details.push(`已物理清除失效配置项: ${cleaned.removedKeys.join(', ')}`);
          }
          logger?.info?.(`[Config] 配置文件自愈成功 (${patchFile})，${details.join('；')}`);
          return {
            healed: true,
            removedKeys: cleaned.removedKeys,
            renamedKeys: cleaned.renamedKeys,
            filePath: patchFile,
          };
        }
      }
    } catch (err: any) {
      logger?.warn?.(`[Config] 物理配置文件自愈扫描异常 (非致命): ${err?.message || err}`);
    }
  }

  return { healed: false, removedKeys: [] };
}
