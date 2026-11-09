/**
 * dsh-napcat-bridge: DSH Lossless JSON 辅助函数
 * 确保工具返回值严格符合 DSH 无损 JSON 规范，递归剥离所有 undefined 字段。
 */

/**
 * 清洗对象以确保严格符合 DSH Lossless JSON 约束 (递归剥离所有 undefined 字段)
 * 彻底避免 DSH snapshotJsonValue 抛出 "value is not lossless JSON" 错误
 */
export function toLosslessJson<T>(val: T): T {
  if (val === undefined || val === null) return val;
  return JSON.parse(JSON.stringify(val));
}
