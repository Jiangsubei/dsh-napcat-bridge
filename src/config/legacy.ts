/**
 * dsh-napcat-bridge: 历史配置键迁移映射
 *
 * 统一维护旧配置键 → 当前配置键的搬运规则，供以下三处共用：
 *   1. sanitizeConfigPayload: 运行时配置清洗前的值搬运；
 *   2. readLegacyConfig: 旧版 settings.yaml 的静默迁移；
 *   3. healProfileConfigFile: profile patch 物理文件自愈时的键名重写。
 */

export interface LegacyConfigKeyMigration {
  /** 历史配置键 */
  legacy: string;
  /** 当前配置键 */
  current: string;
  /** 可选值转换（如旧值语义需要换算时使用） */
  transform?: (value: unknown) => unknown;
}

export const LEGACY_CONFIG_KEY_MIGRATIONS: LegacyConfigKeyMigration[] = [
  // 新的旧键优先：若同一文件同时残留多代旧键，保留更接近当前语义的 group_memory_budget_chars
  { legacy: 'group_memory_budget_chars', current: 'group_memory_total_budget_chars' },
  { legacy: 'private_memory_budget_chars', current: 'user_profile_budget_chars' },
  { legacy: 'memory_budget_chars', current: 'group_memory_total_budget_chars' },
];

/**
 * 将历史配置键的值搬运到当前键（仅当当前键未显式设置时），并删除历史键。
 * 纯函数，不修改入参。
 */
export function migrateLegacyConfigKeys<T extends Record<string, any>>(raw: T): T {
  const result: Record<string, any> = { ...raw };
  for (const { legacy, current, transform } of LEGACY_CONFIG_KEY_MIGRATIONS) {
    if (result[legacy] === undefined) continue;
    const value = transform ? transform(result[legacy]) : result[legacy];
    if (result[current] === undefined && value !== undefined) {
      result[current] = value;
    }
    delete result[legacy];
  }
  return result as T;
}
