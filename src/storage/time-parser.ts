/**
 * dsh-napcat-bridge: 自然语言时间表达式与时间戳解析工具
 */

/**
 * 格式化时间戳为本地时间字符串 YYYY-MM-DD HH:mm:ss
 */
export function formatDateTime(timestamp: number): string {
  if (!timestamp || Number.isNaN(timestamp)) return '';
  const d = new Date(timestamp);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  const year = d.getFullYear();
  const month = pad(d.getMonth() + 1);
  const day = pad(d.getDate());
  const hour = pad(d.getHours());
  const minute = pad(d.getMinutes());
  const second = pad(d.getSeconds());
  return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
}

/**
 * 解析用户/大模型传入的多样化时间参数为毫秒级 Unix 时间戳
 * 支持：
 * - 纯毫秒数字或秒级数字（如 1725062400 或 1725062400000）
 * - 相对时间表达式（如 "30m", "2h", "1d", "7d", "2w", "30秒", "1小时", "3天"）
 * - 自然日期时间字符串（如 "2026-08-30", "2026-08-30 14:00", "2026-08-30 14:00:00", ISO 8601）
 */
export function parseTimeValue(val: number | string | undefined | null, isEnd = false): number | undefined {
  if (val === undefined || val === null || val === '') {
    return undefined;
  }

  // 1. 数字类型 (9~10 位标准 Unix 秒级时间戳智能转毫秒，其余直接作为数值)
  if (typeof val === 'number') {
    if (Number.isNaN(val)) return undefined;
    return val >= 100000000 && val < 10000000000 ? val * 1000 : val;
  }

  const str = String(val).trim();
  if (!str) return undefined;

  // 2. 纯数字字符串
  if (/^\d+$/.test(str)) {
    const num = Number(str);
    if (!Number.isNaN(num)) {
      return num >= 100000000 && num < 10000000000 ? num * 1000 : num;
    }
  }

  // 3. 相对时间表达式（支持简写、中文与英文全称复数，如 "30m", "2h", "1 hour", "2 hrs", "30 mins", "1 day", "2 weeks"）
  const relativeMatch = str.match(/^(\d+)\s*(s|sec|secs|second|seconds|秒|m|min|mins|minute|minutes|分|h|hr|hrs|hour|hours|小时|d|day|days|天|w|week|weeks|周|y|yr|yrs|year|years|年)$/i);
  if (relativeMatch) {
    const count = Number(relativeMatch[1]);
    const unit = relativeMatch[2].toLowerCase();
    let unitMs = 1000;
    if (unit === 's' || unit === 'sec' || unit === 'secs' || unit === 'second' || unit === 'seconds' || unit === '秒') unitMs = 1000;
    else if (unit === 'm' || unit === 'min' || unit === 'mins' || unit === 'minute' || unit === 'minutes' || unit === '分') unitMs = 60 * 1000;
    else if (unit === 'h' || unit === 'hr' || unit === 'hrs' || unit === 'hour' || unit === 'hours' || unit === '小时') unitMs = 3600 * 1000;
    else if (unit === 'd' || unit === 'day' || unit === 'days' || unit === '天') unitMs = 86400 * 1000;
    else if (unit === 'w' || unit === 'week' || unit === 'weeks' || unit === '周') unitMs = 7 * 86400 * 1000;
    else if (unit === 'y' || unit === 'yr' || unit === 'yrs' || unit === 'year' || unit === 'years' || unit === '年') unitMs = 365 * 86400 * 1000;

    return Date.now() - count * unitMs;
  }

  // 4. 纯日期格式 YYYY-MM-DD
  const dateOnlyMatch = str.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (dateOnlyMatch) {
    const y = Number(dateOnlyMatch[1]);
    const m = Number(dateOnlyMatch[2]) - 1;
    const d = Number(dateOnlyMatch[3]);
    const targetDate = isEnd
      ? new Date(y, m, d, 23, 59, 59, 999)
      : new Date(y, m, d, 0, 0, 0, 0);
    const ts = targetDate.getTime();
    return Number.isNaN(ts) ? undefined : ts;
  }

  // 5. 日期时间格式 YYYY-MM-DD HH:mm(:ss)?
  const dateTimeMatch = str.match(/^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?$/);
  if (dateTimeMatch) {
    const y = Number(dateTimeMatch[1]);
    const m = Number(dateTimeMatch[2]) - 1;
    const d = Number(dateTimeMatch[3]);
    const hh = Number(dateTimeMatch[4]);
    const mm = Number(dateTimeMatch[5]);
    const ss = dateTimeMatch[6] ? Number(dateTimeMatch[6]) : (isEnd ? 59 : 0);
    const ms = isEnd ? 999 : 0;
    const targetDate = new Date(y, m, d, hh, mm, ss, ms);
    const ts = targetDate.getTime();
    return Number.isNaN(ts) ? undefined : ts;
  }

  // 6. 裸时间格式 HH:mm(:ss)? (自动补全本地当前年月日，若 since 晚于当前时间则防未来回退 1 天)
  const timeOnlyMatch = str.match(/^(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?$/);
  if (timeOnlyMatch) {
    const hh = Number(timeOnlyMatch[1]);
    const mm = Number(timeOnlyMatch[2]);
    const ss = timeOnlyMatch[3] !== undefined ? Number(timeOnlyMatch[3]) : (isEnd ? 59 : 0);
    const ms = isEnd ? 999 : 0;
    if (hh >= 0 && hh < 24 && mm >= 0 && mm < 60 && ss >= 0 && ss < 60) {
      const now = new Date();
      const targetDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, mm, ss, ms);
      // 聊天历史记录属于过去。若起始时间晚于当前时刻，说明是指昨天的该时刻，自动回退 1 天
      if (!isEnd && targetDate.getTime() > now.getTime()) {
        targetDate.setDate(targetDate.getDate() - 1);
      }
      const ts = targetDate.getTime();
      return Number.isNaN(ts) ? undefined : ts;
    }
  }

  // 7. 省略年份的月日或月日时间格式 MM-DD 或 MM-DD HH:mm(:ss)? (自动补全当前年份，若 since 晚于当前时间则回退 1 年)
  const monthDayMatch = str.match(/^(\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?$/);
  if (monthDayMatch) {
    const now = new Date();
    const y = now.getFullYear();
    const m = Number(monthDayMatch[1]) - 1;
    const d = Number(monthDayMatch[2]);
    const hh = monthDayMatch[3] !== undefined ? Number(monthDayMatch[3]) : (isEnd ? 23 : 0);
    const mm = monthDayMatch[4] !== undefined ? Number(monthDayMatch[4]) : (isEnd ? 59 : 0);
    const ss = monthDayMatch[5] !== undefined ? Number(monthDayMatch[5]) : (isEnd ? 59 : 0);
    const ms = isEnd ? 999 : 0;
    if (m >= 0 && m < 12 && d >= 1 && d <= 31 && hh >= 0 && hh < 24 && mm >= 0 && mm < 60 && ss >= 0 && ss < 60) {
      const targetDate = new Date(y, m, d, hh, mm, ss, ms);
      if (!isEnd && targetDate.getTime() > now.getTime()) {
        targetDate.setFullYear(y - 1);
      }
      const ts = targetDate.getTime();
      return Number.isNaN(ts) ? undefined : ts;
    }
  }

  // 8. ISO 8601 或其他标准日期格式
  const parsed = Date.parse(str);
  if (!Number.isNaN(parsed)) {
    return parsed;
  }

  return undefined;
}
