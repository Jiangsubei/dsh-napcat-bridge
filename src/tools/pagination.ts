/**
 * src/tools/pagination.ts
 *
 * 列表工具统一 offset + limit 分页工具。
 *
 * 约定:
 * - offset 从 0 开始，表示过滤后结果集的起始序号偏移；
 * - limit 为正整数，超出上限时收敛到上限；
 * - 返回 total（本次条数）、total_matched、offset、limit、has_more、message；
 * - next_offset 仅作为内部计算字段，不再作为工具返回值暴露给模型。
 */

export interface OffsetPaginationParams {
  offset?: unknown;
  limit?: unknown;
}

export interface OffsetPaginationOptions {
  defaultLimit: number;
  maxLimit: number;
}

export interface OffsetPage<T> {
  items: T[];
  offset: number;
  limit: number;
  totalMatched: number;
  returned: number;
  startOrdinal: number;
  endOrdinal: number;
  hasMore: boolean;
  nextOffset?: number;
}

/** 将任意输入归一化为合法的从 0 开始的偏移量 */
export function normalizeOffset(value: unknown): number {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** 将任意输入归一化为合法的 limit（默认值 / 上限收敛） */
export function normalizeLimit(value: unknown, defaultValue: number, maxValue: number): number {
  const fallback = Math.min(Math.max(Math.floor(defaultValue) || 1, 1), maxValue);
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.max(n, 1), maxValue);
}

/** 对过滤后的结果集执行 offset + limit 切片 */
export function paginateByOffset<T>(
  items: readonly T[],
  params: OffsetPaginationParams | undefined,
  options: OffsetPaginationOptions
): OffsetPage<T> {
  const offset = normalizeOffset(params?.offset);
  const limit = normalizeLimit(params?.limit, options.defaultLimit, options.maxLimit);
  const totalMatched = items.length;
  const startIndex = Math.min(offset, totalMatched);
  const sliced = startIndex < totalMatched ? items.slice(startIndex, startIndex + limit) : [];
  const returned = sliced.length;
  const hasMore = offset + returned < totalMatched;

  return {
    items: [...sliced],
    offset,
    limit,
    totalMatched,
    returned,
    startOrdinal: offset + 1,
    endOrdinal: offset + returned,
    hasMore,
    ...(hasMore ? { nextOffset: offset + returned } : {}),
  };
}

export interface OffsetMessageOptions {
  offset: number;
  returned: number;
  totalMatched: number;
  hasMore: boolean;
  nextOffset?: number;
  /** 计量单位，如 '人'、'个群'、'个表情' */
  unit: string;
}

/**
 * 生成面向 Agent 的翻页引导语。
 * totalMatched 为 0 时交由调用方返回业务化的“未找到”提示。
 */
export function buildOffsetMessage(options: OffsetMessageOptions): string | undefined {
  const { offset, returned, totalMatched, hasMore, nextOffset, unit } = options;
  if (totalMatched === 0) return undefined;

  if (returned === 0) {
    return `offset ${offset} 超出范围（共 ${totalMatched} ${unit}），请使用 0~${totalMatched - 1} 之间的偏移量。`;
  }

  if (hasMore) {
    return `本次展示序号 ${offset + 1}~${offset + returned}（共 ${totalMatched} ${unit}）。继续浏览请传入 offset: ${nextOffset}。`;
  }

  if (offset > 0) {
    return `已展示至最后一页（序号 ${offset + 1}~${offset + returned}，共 ${totalMatched} ${unit}）。`;
  }

  return undefined;
}

/** 按数字 ID 比较，非数字时退化为字符串比较 */
export function compareNumericIdLike(a: unknown, b: unknown): number {
  const an = Number(String(a ?? '').trim());
  const bn = Number(String(b ?? '').trim());
  if (Number.isFinite(an) && Number.isFinite(bn)) {
    return an - bn;
  }
  return String(a ?? '').localeCompare(String(b ?? ''));
}

/** 按数字 ID 升序排序，返回新数组 */
export function sortByNumericId<T>(items: readonly T[], getKey: (item: T) => unknown): T[] {
  return [...items].sort((a, b) => compareNumericIdLike(getKey(a), getKey(b)));
}
