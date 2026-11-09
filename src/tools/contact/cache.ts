/**
 * 社交关系链缓存池与字符处理辅助
 */

export const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000; // 默认 5 分钟缓存
export const DEFAULT_LIST_LIMIT = 20;
export const MAX_LIST_LIMIT = 50;

/**
 * 解码 HTML 实体编码文本（如 &#10; 换行、&nbsp; 空格、&lt;、&gt; 等）
 */
export function decodeHtmlEntities(str: string): string {
  if (!str) return '';
  return str
    .replace(/&#(\d+);/g, (_, dec) => {
      const code = Number(dec);
      return Number.isSafeInteger(code) ? String.fromCodePoint(code) : _;
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
      const code = parseInt(hex, 16);
      return Number.isSafeInteger(code) ? String.fromCodePoint(code) : _;
    })
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'");
}

/**
 * 内存 TTL 缓存池基类
 */
export class MemoryCachePool<T> {
  private cache = new Map<string, { expires: number; data: T }>();

  get(key: string): T | undefined {
    const entry = this.cache.get(key);
    if (entry && entry.expires > Date.now()) {
      return entry.data;
    }
    return undefined;
  }

  set(key: string, data: T, ttlMs = DEFAULT_CACHE_TTL_MS): void {
    this.cache.set(key, {
      expires: Date.now() + ttlMs,
      data,
    });
  }

  clear(key: string): void {
    this.cache.delete(key);
  }

  clearAll(): void {
    this.cache.clear();
  }
}

export const friendListCache = new MemoryCachePool<any[]>();
export const groupListCache = new MemoryCachePool<any[]>();
