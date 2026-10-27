/**
 * dsh-napcat-bridge: SQLite 消息存储模块
 * 管理 messages 表的结构初始化、消息入库归一化与多维查询。
 * （阶段 2 将具体实现业务逻辑）
 */

import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  ChatMessageSummary,
  GroupFileInfo,
  ListGroupFilesParams,
  ListGroupFilesResult,
  MessageRecord,
  ReadChatHistoryParams,
  ReadChatHistoryResult,
  FaceRecord,
  FaceQueryOptions,
  ScheduledTaskRecord,
  ScheduledTaskStatus,
  RecurringRule,
} from '../types/index.js';

export interface SessionStateRecord {
  peer: string;
  current_session_id: string;
  cleared_round: number;
  cleared_version: number;
  updated_at: number;
  model_provider?: string;
  model_name?: string;
  model_reasoning_effort?: string;
}

type DatabaseType = any;

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

  // 6. ISO 8601 或其他标准日期格式
  const parsed = Date.parse(str);
  if (!Number.isNaN(parsed)) {
    return parsed;
  }

  return undefined;
}

export class MessageDatabase {
  public readonly dbPath: string;
  private db: DatabaseType | null = null;

  constructor(dbPath: string) {
    this.dbPath = path.resolve(dbPath);
  }

  init(): void {
    const dir = path.dirname(this.dbPath);
    if (dir && dir !== '.' && !fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        msg_id INTEGER PRIMARY KEY,
        peer TEXT NOT NULL,
        user_id TEXT NOT NULL,
        sender_name TEXT NOT NULL,
        time INTEGER NOT NULL,
        type TEXT NOT NULL,
        content TEXT NOT NULL,
        raw TEXT NOT NULL,
        file_id TEXT,
        busid INTEGER,
        local_path TEXT,
        fingerprint TEXT,
        recalled INTEGER NOT NULL DEFAULT 0,
        self INTEGER NOT NULL DEFAULT 0,
        reply_to INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_messages_peer_user_time ON messages (peer, user_id, time);
      CREATE INDEX IF NOT EXISTS idx_messages_peer_time ON messages (peer, time);
      CREATE INDEX IF NOT EXISTS idx_messages_file_id ON messages (file_id);
      CREATE INDEX IF NOT EXISTS idx_messages_fingerprint ON messages (fingerprint);

      CREATE TABLE IF NOT EXISTS session_states (
        peer TEXT PRIMARY KEY,
        current_session_id TEXT NOT NULL,
        cleared_round INTEGER NOT NULL DEFAULT 0,
        cleared_version INTEGER NOT NULL DEFAULT 1,
        updated_at INTEGER NOT NULL,
        model_provider TEXT,
        model_name TEXT
      );

      CREATE TABLE IF NOT EXISTS plugin_kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS faces (
        id TEXT PRIMARY KEY,
        file_path TEXT NOT NULL,
        md5 TEXT NOT NULL UNIQUE,
        added_at INTEGER NOT NULL,
        source TEXT NOT NULL,
        tags TEXT NOT NULL,
        mood TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        size INTEGER NOT NULL,
        format TEXT NOT NULL,
        last_used_at INTEGER,
        use_count INTEGER NOT NULL DEFAULT 0,
        deleted_at INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_faces_enabled ON faces (enabled);
      CREATE INDEX IF NOT EXISTS idx_faces_deleted ON faces (deleted_at);
      CREATE INDEX IF NOT EXISTS idx_faces_last_used ON faces (last_used_at);

      CREATE TABLE IF NOT EXISTS scheduled_tasks (
        id TEXT PRIMARY KEY,
        peer TEXT NOT NULL,
        creator TEXT NOT NULL,
        prompt TEXT NOT NULL,
        type TEXT NOT NULL,
        recurring_rule TEXT,
        next_run_at INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_tasks_pending_run ON scheduled_tasks (status, next_run_at);
      CREATE INDEX IF NOT EXISTS idx_tasks_peer ON scheduled_tasks (peer, status);
    `);

    // 平滑升级已有数据库
    try {
      this.db.prepare('ALTER TABLE session_states ADD COLUMN model_provider TEXT').run();
    } catch {}
    try {
      this.db.prepare('ALTER TABLE session_states ADD COLUMN model_name TEXT').run();
    } catch {}
    try {
      this.db.prepare('ALTER TABLE session_states ADD COLUMN model_reasoning_effort TEXT').run();
    } catch {}
    try {
      this.db.prepare('ALTER TABLE faces ADD COLUMN deleted_at INTEGER').run();
    } catch {}
  }

  private ensureDb(): DatabaseType {
    if (!this.db) {
      this.init();
    }
    return this.db!;
  }

  saveMessage(record: MessageRecord): void {
    const db = this.ensureDb();
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO messages (
        msg_id, peer, user_id, sender_name, time, type, content, raw,
        file_id, busid, local_path, fingerprint, recalled, self, reply_to
      ) VALUES (
        @msg_id, @peer, @user_id, @sender_name, @time, @type, @content, @raw,
        @file_id, @busid, @local_path, @fingerprint, @recalled, @self, @reply_to
      )
    `);

    stmt.run({
      msg_id: record.msg_id,
      peer: record.peer,
      user_id: String(record.user_id),
      sender_name: record.sender_name || '',
      time: record.time,
      type: record.type,
      content: record.content,
      raw: typeof record.raw === 'string' ? record.raw : JSON.stringify(record.raw),
      file_id: record.file_id ?? null,
      busid: record.busid ?? null,
      local_path: record.local_path ?? null,
      fingerprint: record.fingerprint ?? null,
      recalled: record.recalled ? 1 : 0,
      self: record.self ? 1 : 0,
      reply_to: record.reply_to ?? null,
    });
  }

  /**
   * 检查指定消息 ID 是否已存在
   */
  hasMessage(msgId: number): boolean {
    const db = this.ensureDb();
    const row = db.prepare('SELECT 1 FROM messages WHERE msg_id = ? LIMIT 1').get(msgId);
    return Boolean(row);
  }

  /**
   * 获取指定会话 peer 在本地数据库中的最新一条消息时间戳（毫秒）
   * 若该 peer 尚无任何历史消息，返回 null
   */
  getLatestMessageTime(peer: string): number | null {
    const db = this.ensureDb();
    const row = db.prepare('SELECT MAX(time) AS max_time FROM messages WHERE peer = ?').get(peer) as
      | { max_time: number | null }
      | undefined;
    return row && row.max_time !== null && !Number.isNaN(row.max_time) ? row.max_time : null;
  }

  /**
   * 离线补全安全入库：仅在消息不存在时插入，已存在时幂等忽略且绝不覆盖已有记录（保护已有 local_path 等）
   * @returns true 表示成功插入新记录，false 表示已存在而忽略
   */
  saveMessageIfNotExists(record: MessageRecord): boolean {
    const db = this.ensureDb();
    const stmt = db.prepare(`
      INSERT OR IGNORE INTO messages (
        msg_id, peer, user_id, sender_name, time, type, content, raw,
        file_id, busid, local_path, fingerprint, recalled, self, reply_to
      ) VALUES (
        @msg_id, @peer, @user_id, @sender_name, @time, @type, @content, @raw,
        @file_id, @busid, @local_path, @fingerprint, @recalled, @self, @reply_to
      )
    `);

    const result = stmt.run({
      msg_id: record.msg_id,
      peer: record.peer,
      user_id: String(record.user_id),
      sender_name: record.sender_name || '',
      time: record.time,
      type: record.type,
      content: record.content,
      raw: typeof record.raw === 'string' ? record.raw : JSON.stringify(record.raw),
      file_id: record.file_id ?? null,
      busid: record.busid ?? null,
      local_path: record.local_path ?? null,
      fingerprint: record.fingerprint ?? null,
      recalled: record.recalled ? 1 : 0,
      self: record.self ? 1 : 0,
      reply_to: record.reply_to ?? null,
    });

    return result.changes > 0;
  }

  readHistory(peer: string, params: ReadChatHistoryParams = {}): ReadChatHistoryResult {
    const db = this.ensureDb();
    const conditions: string[] = ['peer = ?'];
    const sqlParams: any[] = [peer];

    // 1. 发送者 QQ 精确匹配 (带 trim 容错)
    if (params.user_id !== undefined && String(params.user_id).trim() !== '') {
      conditions.push('user_id = ?');
      sqlParams.push(String(params.user_id).trim());
    }

    // 2. 发送者昵称/群名片模糊搜索
    if (params.sender_name !== undefined && params.sender_name.trim() !== '') {
      conditions.push('sender_name LIKE ?');
      sqlParams.push(`%${params.sender_name.trim()}%`);
    }

    // 3. 消息内容关键词模糊搜索
    if (params.keyword !== undefined && params.keyword.trim() !== '') {
      conditions.push('content LIKE ?');
      sqlParams.push(`%${params.keyword.trim()}%`);
    }

    // 4. 消息类型筛选 (支持单类型或类型数组，且查询 text 时兼顾带引用的回复文本 reply)
    if (params.type !== undefined) {
      if (Array.isArray(params.type)) {
        const types = params.type.filter((t) => typeof t === 'string' && t.trim() !== '');
        const expandedTypes = new Set(types);
        if (expandedTypes.has('text')) {
          expandedTypes.add('reply');
        }
        const finalTypes = Array.from(expandedTypes);
        if (finalTypes.length === 1) {
          conditions.push('type = ?');
          sqlParams.push(finalTypes[0]);
        } else if (finalTypes.length > 1) {
          conditions.push(`type IN (${finalTypes.map(() => '?').join(', ')})`);
          sqlParams.push(...finalTypes);
        }
      } else if (typeof params.type === 'string' && params.type.trim() !== '') {
        const t = params.type.trim();
        if (t === 'text') {
          conditions.push("type IN ('text', 'reply')");
        } else {
          conditions.push('type = ?');
          sqlParams.push(t);
        }
      }
    }

    // 5. 友好时间解析与范围筛选
    let sinceTs = parseTimeValue(params.since, false);
    const untilTs = parseTimeValue(params.until, true);

    if (params.relative && sinceTs === undefined) {
      sinceTs = parseTimeValue(params.relative, false);
    }

    if (sinceTs !== undefined && !Number.isNaN(sinceTs)) {
      conditions.push('time >= ?');
      sqlParams.push(sinceTs);
    }

    if (untilTs !== undefined && !Number.isNaN(untilTs)) {
      conditions.push('time <= ?');
      sqlParams.push(untilTs);
    }

    // 6. 附件/多媒体存在性筛选
    if (params.has_file) {
      conditions.push('(local_path IS NOT NULL OR file_id IS NOT NULL)');
    }

    // 7. 回复链关系筛选
    if (params.reply_to !== undefined && params.reply_to !== null) {
      conditions.push('reply_to = ?');
      sqlParams.push(Number(params.reply_to));
    }

    // 8. 机器人自身消息过滤
    if (params.exclude_self) {
      conditions.push('self = 0');
    }
    if (params.self_only) {
      conditions.push('self = 1');
    }

    const whereClause = conditions.join(' AND ');
    const countRow = db.prepare(`SELECT count(*) as count FROM messages WHERE ${whereClause}`).get(...sqlParams) as { count: number };
    const total = countRow ? countRow.count : 0;

    const order = params.order?.toLowerCase() === 'asc' ? 'ASC' : 'DESC';
    const limit = Math.min(Math.max(params.limit ?? 20, 1), 100);

    const rows = db.prepare(`
      SELECT * FROM messages
      WHERE ${whereClause}
      ORDER BY time ${order}
      LIMIT ?
    `).all(...sqlParams, limit) as any[];

    const messages: ChatMessageSummary[] = rows.map((row) => ({
      msg_id: Number(row.msg_id),
      user_id: String(row.user_id),
      sender_name: row.sender_name,
      time: Number(row.time),
      formatted_time: formatDateTime(Number(row.time)),
      type: row.type,
      content: row.content,
      recalled: row.recalled === 1,
      self: row.self === 1,
      reply_to: row.reply_to !== null && row.reply_to !== undefined ? Number(row.reply_to) : null,
      local_path: row.local_path ?? null,
      file_id: row.file_id ?? null,
    }));

    return {
      messages,
      total,
    };
  }

  listGroupFiles(peer: string, params: ListGroupFilesParams = {}): ListGroupFilesResult {
    const db = this.ensureDb();
    const conditions: string[] = ['peer = ?', "type = 'group_file'"];
    const sqlParams: any[] = [peer];

    // 1. 发送者 QQ 精确匹配
    if (params.user_id !== undefined && params.user_id !== '') {
      conditions.push('user_id = ?');
      sqlParams.push(String(params.user_id));
    }

    // 2. 发送者昵称/群名片模糊搜索
    if (params.sender_name !== undefined && params.sender_name.trim() !== '') {
      conditions.push('(sender_name LIKE ? OR user_id = ?)');
      sqlParams.push(`%${params.sender_name.trim()}%`, params.sender_name.trim());
    }

    // 3. 文件名关键词模糊搜索 (匹配 content 或 raw)
    if (params.file_name !== undefined && params.file_name.trim() !== '') {
      conditions.push('(content LIKE ? OR raw LIKE ?)');
      sqlParams.push(`%${params.file_name.trim()}%`, `%${params.file_name.trim()}%`);
    }

    // 4. 时间范围筛选
    const sinceTs = parseTimeValue(params.since, false);
    const untilTs = parseTimeValue(params.until, true);

    if (sinceTs !== undefined && !Number.isNaN(sinceTs)) {
      conditions.push('time >= ?');
      sqlParams.push(sinceTs);
    }
    if (untilTs !== undefined && !Number.isNaN(untilTs)) {
      conditions.push('time <= ?');
      sqlParams.push(untilTs);
    }

    const whereClause = conditions.join(' AND ');
    const countRow = db.prepare(`SELECT count(*) as count FROM messages WHERE ${whereClause}`).get(...sqlParams) as { count: number };
    const total = countRow ? countRow.count : 0;

    const order = params.order?.toLowerCase() === 'asc' ? 'ASC' : 'DESC';
    const limit = Math.min(Math.max(params.limit ?? 20, 1), 100);

    const rows = db.prepare(`
      SELECT * FROM messages
      WHERE ${whereClause}
      ORDER BY time ${order}
      LIMIT ?
    `).all(...sqlParams, limit) as any[];

    const files: GroupFileInfo[] = rows.map((row) => {
      let fileName = '';
      let size: number | undefined = undefined;

      if (row.raw) {
        try {
          const parsed = JSON.parse(row.raw);
          if (parsed.file?.name) fileName = String(parsed.file.name);
          if (typeof parsed.file?.size === 'number') size = parsed.file.size;
        } catch {}
      }

      if (!fileName && row.content) {
        const match = row.content.match(/^\[群文件:(.+?)\s*\(ID:/);
        if (match && match[1]) {
          fileName = match[1].trim();
        } else {
          fileName = row.content.replace(/^\[群文件:/, '').replace(/\]$/, '').trim();
        }
      }

      if (!fileName) {
        fileName = '未知文件';
      }

      const senderName = (row.sender_name && row.sender_name.trim()) ? row.sender_name.trim() : String(row.user_id);

      return {
        msg_id: Number(row.msg_id),
        file_id: String(row.file_id || ''),
        file_name: fileName,
        busid: row.busid !== null && row.busid !== undefined ? Number(row.busid) : 0,
        sender_name: senderName,
        user_id: String(row.user_id),
        time: Number(row.time),
        formatted_time: formatDateTime(Number(row.time)),
        size,
      };
    });

    return {
      success: true,
      files,
      total,
    };
  }

  /**
   * 获取指定 peer 在过去特定时间内（默认 7 天）活跃发言的非机器人用户列表，按最后发言时间降序排列
   */
  getActiveUsers(peer: string, days = 7, limit = 20): Array<{ user_id: string; sender_name: string; last_active: number }> {
    const db = this.ensureDb();
    const sinceTime = Date.now() - days * 24 * 3600 * 1000;
    const rows = db.prepare(`
      SELECT user_id, sender_name, MAX(time) as last_active
      FROM messages
      WHERE peer = ? AND self = 0 AND time >= ?
      GROUP BY user_id
      ORDER BY last_active DESC
      LIMIT ?
    `).all(peer, sinceTime, limit) as any[];

    return rows.map((r) => ({
      user_id: String(r.user_id),
      sender_name: r.sender_name ? String(r.sender_name).trim() : String(r.user_id),
      last_active: Number(r.last_active),
    }));
  }

  /**
   * 检查指定 peer 在特定 msg_id 之后是否有新到达的用户图片/贴图消息 (严格限制 self = 0)
   */
  hasNewImageMessages(peer: string, sinceMsgId: number = 0): { hasNew: boolean; latestMsgId: number } {
    const db = this.ensureDb();
    const row = db.prepare(`
      SELECT COUNT(*) as cnt, COALESCE(MAX(msg_id), ?) as max_id
      FROM messages
      WHERE peer = ? AND self = 0 AND msg_id > ? AND (
        type IN ('image', 'sticker') OR
        content LIKE '%[图片]%' OR
        content LIKE '%[动画表情]%' OR
        content LIKE '%CQ:image%' OR
        (raw LIKE '%"type":"image"%' OR raw LIKE '%CQ:image%')
      )
    `).get(sinceMsgId, peer, sinceMsgId) as any;

    const count = Number(row?.cnt ?? 0);
    const latestMsgId = Number(row?.max_id ?? sinceMsgId);
    return {
      hasNew: count > 0,
      latestMsgId,
    };
  }

  /**
   * 获取指定 peer 的最大 msg_id (用于初始化最后巡检位置)
   */
  getLatestMsgId(peer: string): number {
    const db = this.ensureDb();
    const row = db.prepare(`SELECT MAX(msg_id) as max_id FROM messages WHERE peer = ?`).get(peer) as any;
    return Number(row?.max_id ?? 0);
  }

  markRecalled(msgId: number): void {
    const db = this.ensureDb();
    db.prepare(`UPDATE messages SET recalled = 1, content = '〔已撤回〕' WHERE msg_id = ?`).run(msgId);
  }

  getMessage(msgId: number): MessageRecord | null {
    const db = this.ensureDb();
    const row = db.prepare(`SELECT * FROM messages WHERE msg_id = ?`).get(msgId) as any;
    if (!row) return null;

    return {
      msg_id: Number(row.msg_id),
      peer: row.peer,
      user_id: String(row.user_id),
      sender_name: row.sender_name,
      time: Number(row.time),
      type: row.type,
      content: row.content,
      raw: row.raw,
      file_id: row.file_id ?? null,
      busid: row.busid !== null && row.busid !== undefined ? Number(row.busid) : null,
      local_path: row.local_path ?? null,
      fingerprint: row.fingerprint ?? null,
      recalled: Number(row.recalled),
      self: Number(row.self),
      reply_to: row.reply_to !== null && row.reply_to !== undefined ? Number(row.reply_to) : null,
    };
  }

  getByFileId(fileId: string): MessageRecord | null {
    const db = this.ensureDb();
    const row = db.prepare(`SELECT * FROM messages WHERE file_id = ? LIMIT 1`).get(fileId) as any;
    if (!row) return null;
    return this.getMessage(row.msg_id);
  }

  getByFingerprint(fingerprint: string): MessageRecord | null {
    const db = this.ensureDb();
    const row = db.prepare(`SELECT * FROM messages WHERE fingerprint = ? LIMIT 1`).get(fingerprint) as any;
    if (!row) return null;
    return this.getMessage(row.msg_id);
  }

  updateLocalPath(msgId: number, localPath: string, fingerprint?: string | null): void {
    const db = this.ensureDb();
    if (fingerprint !== undefined) {
      db.prepare(`UPDATE messages SET local_path = ?, fingerprint = ? WHERE msg_id = ?`).run(localPath, fingerprint, msgId);
    } else {
      db.prepare(`UPDATE messages SET local_path = ? WHERE msg_id = ?`).run(localPath, msgId);
    }
  }

  updateLocalPathByFileId(fileId: string, localPath: string, fingerprint?: string | null): void {
    const db = this.ensureDb();
    if (fingerprint !== undefined) {
      db.prepare(`UPDATE messages SET local_path = ?, fingerprint = ? WHERE file_id = ?`).run(localPath, fingerprint, fileId);
    } else {
      db.prepare(`UPDATE messages SET local_path = ? WHERE file_id = ?`).run(localPath, fileId);
    }
  }

  clearLocalPath(localPath: string): void {
    const db = this.ensureDb();
    db.prepare(`UPDATE messages SET local_path = NULL WHERE local_path = ?`).run(localPath);
  }

  saveSessionState(state: SessionStateRecord): void {
    const db = this.ensureDb();
    db.prepare(`
      INSERT OR REPLACE INTO session_states (
        peer, current_session_id, cleared_round, cleared_version, updated_at,
        model_provider, model_name, model_reasoning_effort
      ) VALUES (
        @peer, @current_session_id, @cleared_round, @cleared_version, @updated_at,
        @model_provider, @model_name, @model_reasoning_effort
      )
    `).run({
      peer: state.peer,
      current_session_id: state.current_session_id,
      cleared_round: state.cleared_round ?? 0,
      cleared_version: state.cleared_version ?? 1,
      updated_at: state.updated_at || Date.now(),
      model_provider: state.model_provider ?? null,
      model_name: state.model_name ?? null,
      model_reasoning_effort: state.model_reasoning_effort ?? null,
    });
  }

  getSessionState(peer: string): SessionStateRecord | null {
    const db = this.ensureDb();
    const row = db.prepare(`SELECT * FROM session_states WHERE peer = ?`).get(peer) as any;
    if (!row) return null;
    return {
      peer: row.peer,
      current_session_id: row.current_session_id,
      cleared_round: Number(row.cleared_round ?? 0),
      cleared_version: Number(row.cleared_version ?? 1),
      updated_at: Number(row.updated_at),
      model_provider: row.model_provider || undefined,
      model_name: row.model_name || undefined,
      model_reasoning_effort: row.model_reasoning_effort || undefined,
    };
  }

  getAllSessionStates(): SessionStateRecord[] {
    const db = this.ensureDb();
    const rows = db.prepare(`SELECT * FROM session_states`).all() as any[];
    return rows.map((row) => ({
      peer: row.peer,
      current_session_id: row.current_session_id,
      cleared_round: Number(row.cleared_round ?? 0),
      cleared_version: Number(row.cleared_version ?? 1),
      updated_at: Number(row.updated_at),
      model_provider: row.model_provider || undefined,
      model_name: row.model_name || undefined,
      model_reasoning_effort: row.model_reasoning_effort || undefined,
    }));
  }

  getPluginConfig(key: string): string | null {
    const db = this.ensureDb();
    const row = db.prepare(`SELECT value FROM plugin_kv WHERE key = ?`).get(key) as any;
    return row ? row.value : null;
  }

  setPluginConfig(key: string, value: string): void {
    const db = this.ensureDb();
    db.prepare(`
      INSERT OR REPLACE INTO plugin_kv (key, value, updated_at) VALUES (?, ?, ?)
    `).run(key, value, Date.now());
  }

  // ==================== 表情库管理 (Face Storage) ====================

  private mapFaceRow(row: any): FaceRecord {
    let parsedTags: string[] = [];
    try {
      parsedTags = JSON.parse(row.tags);
      if (!Array.isArray(parsedTags)) parsedTags = [];
    } catch {
      parsedTags = [];
    }
    return {
      id: row.id,
      file_path: row.file_path,
      md5: row.md5,
      added_at: Number(row.added_at),
      source: row.source,
      tags: parsedTags,
      mood: row.mood || undefined,
      enabled: Boolean(row.enabled),
      size: Number(row.size),
      format: row.format,
      last_used_at: row.last_used_at ? Number(row.last_used_at) : undefined,
      use_count: Number(row.use_count ?? 0),
      deleted_at: row.deleted_at ? Number(row.deleted_at) : null,
    };
  }

  insertFace(
    record: {
      id: string;
      file_path: string;
      md5: string;
      source: 'curate' | 'manual' | 'collect';
      tags: string[];
      mood?: string;
      enabled?: boolean;
      size: number;
      format: string;
    },
    options?: { max?: number; evictPolicy?: 'reject' | 'evict_lru' }
  ): FaceRecord & { duplicated?: boolean; restored?: boolean } {
    const db = this.ensureDb();

    // 1. MD5 去重校验
    const existing = db.prepare(`SELECT * FROM faces WHERE md5 = ?`).get(record.md5) as any;
    if (existing) {
      const existingFace = this.mapFaceRow(existing);
      // 若处于 7 天后悔期（软删除），自动复原并激活
      if (existingFace.deleted_at !== null && existingFace.deleted_at !== undefined) {
        const mergedTags = Array.from(new Set([...existingFace.tags, ...(record.tags || [])]));
        const targetPath = existingFace.file_path || record.file_path;
        db.prepare(`
          UPDATE faces
          SET deleted_at = NULL, enabled = 1, file_path = ?, tags = ?, mood = COALESCE(?, mood), format = ?, size = ?
          WHERE id = ?
        `).run(
          targetPath,
          JSON.stringify(mergedTags),
          record.mood || null,
          record.format,
          record.size,
          existingFace.id
        );
        return {
          ...existingFace,
          file_path: targetPath,
          deleted_at: null,
          enabled: true,
          tags: mergedTags,
          mood: record.mood || existingFace.mood,
          restored: true,
        };
      }

      // 活跃表情：增量合并 tags，更新时间戳
      const mergedTags = Array.from(new Set([...existingFace.tags, ...(record.tags || [])]));
      db.prepare(`
        UPDATE faces
        SET tags = ?, mood = COALESCE(?, mood)
        WHERE id = ?
      `).run(JSON.stringify(mergedTags), record.mood || null, existingFace.id);

      return {
        ...existingFace,
        tags: mergedTags,
        mood: record.mood || existingFace.mood,
        duplicated: true,
      };
    }

    // 2. 容量配额检查
    const maxFaces = options?.max;
    if (typeof maxFaces === 'number' && maxFaces > 0) {
      const activeCountRow = db.prepare(`SELECT COUNT(*) as cnt FROM faces WHERE deleted_at IS NULL`).get() as any;
      const currentCount = Number(activeCountRow?.cnt ?? 0);

      if (currentCount >= maxFaces) {
        if (options?.evictPolicy === 'evict_lru') {
          // 查找非 manual 中最久未使用的表情（保护人工导入的表情）
          const candidate = db.prepare(`
            SELECT id FROM faces
            WHERE deleted_at IS NULL AND source != 'manual'
            ORDER BY COALESCE(last_used_at, 0) ASC, added_at ASC
            LIMIT 1
          `).get() as any;

          if (!candidate) {
            throw new Error(`表情库已达配额容量上限 (${maxFaces})，且所有表情均为人工保护表情，无法淘汰`);
          }

          // 软删除淘汰，进入 7 天后悔期
          db.prepare(`
            UPDATE faces
            SET deleted_at = ?, enabled = 0
            WHERE id = ?
          `).run(Date.now(), candidate.id);
        } else {
          // 默认 reject
          throw new Error(`表情库已达配额容量上限 (${maxFaces})，已拒绝新增`);
        }
      }
    }

    // 3. 正常插入新表情
    const now = Date.now();
    const enabledVal = record.enabled ?? true ? 1 : 0;
    db.prepare(`
      INSERT INTO faces (
        id, file_path, md5, added_at, source, tags, mood, enabled, size, format, last_used_at, use_count, deleted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
    `).run(
      record.id,
      record.file_path,
      record.md5,
      now,
      record.source,
      JSON.stringify(record.tags || []),
      record.mood || null,
      enabledVal,
      record.size,
      record.format,
      null,
      0
    );

    return {
      id: record.id,
      file_path: record.file_path,
      md5: record.md5,
      added_at: now,
      source: record.source,
      tags: record.tags || [],
      mood: record.mood,
      enabled: Boolean(enabledVal),
      size: record.size,
      format: record.format,
      use_count: 0,
      deleted_at: null,
    };
  }

  getFaceById(id: string, options?: { includeDeleted?: boolean }): FaceRecord | null {
    const db = this.ensureDb();
    const sql = options?.includeDeleted
      ? `SELECT * FROM faces WHERE id = ?`
      : `SELECT * FROM faces WHERE id = ? AND deleted_at IS NULL`;
    const row = db.prepare(sql).get(id) as any;
    return row ? this.mapFaceRow(row) : null;
  }

  getFaceByMd5(md5: string, options?: { includeDeleted?: boolean }): FaceRecord | null {
    const db = this.ensureDb();
    const sql = options?.includeDeleted
      ? `SELECT * FROM faces WHERE md5 = ?`
      : `SELECT * FROM faces WHERE md5 = ? AND deleted_at IS NULL`;
    const row = db.prepare(sql).get(md5) as any;
    return row ? this.mapFaceRow(row) : null;
  }

  queryFaces(options: FaceQueryOptions = {}): { faces: FaceRecord[]; total: number; has_more: boolean } {
    const db = this.ensureDb();
    const whereClauses: string[] = [];
    const params: any[] = [];

    if (!options.includeDeleted) {
      whereClauses.push('deleted_at IS NULL');
    }

    if (options.enabledOnly ?? true) {
      whereClauses.push('enabled = 1');
    }

    if (options.mood) {
      whereClauses.push('mood = ?');
      params.push(options.mood.trim());
    }

    if (options.untagged) {
      whereClauses.push(`(tags IS NULL OR tags = '' OR tags = '[]')`);
    } else if (options.tag) {
      whereClauses.push('tags LIKE ?');
      params.push(`%"${options.tag.trim()}"%`);
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    const countRow = db.prepare(`SELECT COUNT(*) as cnt FROM faces ${whereSql}`).get(...params) as any;
    const total = Number(countRow?.cnt ?? 0);

    const limit = options.limit && options.limit > 0 ? Math.min(options.limit, 100) : 100;
    const offset = options.offset && options.offset >= 0 ? options.offset : 0;

    let orderByField = 'added_at';
    if (options.orderBy === 'last_used_at') orderByField = 'last_used_at';
    else if (options.orderBy === 'use_count') orderByField = 'use_count';

    const orderDir = options.order?.toLowerCase() === 'asc' ? 'ASC' : 'DESC';

    const querySql = `
      SELECT * FROM faces
      ${whereSql}
      ORDER BY COALESCE(${orderByField}, 0) ${orderDir}, id DESC
      LIMIT ? OFFSET ?
    `;

    const rows = db.prepare(querySql).all(...params, limit, offset) as any[];
    const faces = rows.map((r) => this.mapFaceRow(r));
    const has_more = offset + faces.length < total;

    return { faces, total, has_more };
  }

  updateFace(id: string, updates: { tags?: string[]; mood?: string }): FaceRecord | null {
    const db = this.ensureDb();
    const existing = this.getFaceById(id, { includeDeleted: true });
    if (!existing) return null;

    const newTags = updates.tags !== undefined ? updates.tags : existing.tags;
    const newMood = updates.mood !== undefined ? updates.mood : existing.mood;

    db.prepare(`
      UPDATE faces
      SET tags = ?, mood = ?
      WHERE id = ?
    `).run(JSON.stringify(newTags), newMood || null, id);

    return this.getFaceById(id, { includeDeleted: true });
  }

  updateFaceFilePath(id: string, filePath: string): void {
    const db = this.ensureDb();
    db.prepare(`UPDATE faces SET file_path = ? WHERE id = ?`).run(filePath, id);
  }

  deleteFace(id: string): boolean {
    const db = this.ensureDb();
    const info = db.prepare(`
      UPDATE faces
      SET deleted_at = ?, enabled = 0
      WHERE id = ? AND deleted_at IS NULL
    `).run(Date.now(), id);
    return info.changes > 0;
  }

  restoreFace(id: string): boolean {
    const db = this.ensureDb();
    const info = db.prepare(`
      UPDATE faces
      SET deleted_at = NULL, enabled = 1
      WHERE id = ?
    `).run(id);
    return info.changes > 0;
  }

  purgeExpiredFaces(graceDays: number = 7): string[] {
    const db = this.ensureDb();
    const thresholdMs = Date.now() - graceDays * 24 * 3600 * 1000;
    const rows = db.prepare(`
      SELECT file_path FROM faces
      WHERE deleted_at IS NOT NULL AND deleted_at < ?
    `).all(thresholdMs) as any[];

    if (rows.length > 0) {
      db.prepare(`
        DELETE FROM faces
        WHERE deleted_at IS NOT NULL AND deleted_at < ?
      `).run(thresholdMs);
    }

    return rows.map((r) => r.file_path);
  }

  recordFaceUsage(id: string): void {
    const db = this.ensureDb();
    db.prepare(`
      UPDATE faces
      SET use_count = use_count + 1, last_used_at = ?
      WHERE id = ?
    `).run(Date.now(), id);
  }

  // ==================== 定时任务相关方法 ====================

  /**
   * 将数据库行映射为 ScheduledTaskRecord
   */
  private mapTaskRow(row: any): ScheduledTaskRecord {
    let recurringRule: RecurringRule | null = null;
    if (row.recurring_rule) {
      try {
        recurringRule = typeof row.recurring_rule === 'string'
          ? JSON.parse(row.recurring_rule)
          : row.recurring_rule;
      } catch {}
    }
    return {
      id: row.id,
      peer: row.peer,
      creator: row.creator,
      prompt: row.prompt,
      type: row.type,
      recurring_rule: recurringRule,
      next_run_at: Number(row.next_run_at),
      status: row.status,
      created_at: Number(row.created_at),
      updated_at: Number(row.updated_at),
    };
  }

  /**
   * 创建新的定时任务
   */
  createScheduledTask(task: ScheduledTaskRecord): void {
    const db = this.ensureDb();
    const stmt = db.prepare(`
      INSERT INTO scheduled_tasks (
        id, peer, creator, prompt, type, recurring_rule, next_run_at, status, created_at, updated_at
      ) VALUES (
        @id, @peer, @creator, @prompt, @type, @recurring_rule, @next_run_at, @status, @created_at, @updated_at
      )
    `);

    stmt.run({
      id: task.id,
      peer: task.peer,
      creator: task.creator,
      prompt: task.prompt,
      type: task.type,
      recurring_rule: task.recurring_rule ? JSON.stringify(task.recurring_rule) : null,
      next_run_at: task.next_run_at,
      status: task.status || 'pending',
      created_at: task.created_at || Date.now(),
      updated_at: task.updated_at || Date.now(),
    });
  }

  /**
   * 按 ID 获取单个定时任务
   */
  getScheduledTask(id: string): ScheduledTaskRecord | null {
    const db = this.ensureDb();
    const row = db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id);
    return row ? this.mapTaskRow(row) : null;
  }

  /**
   * 列出指定 peer 的定时任务，默认按 next_run_at 升序排列
   */
  listScheduledTasks(peer: string, status?: ScheduledTaskStatus): ScheduledTaskRecord[] {
    const db = this.ensureDb();
    let query = 'SELECT * FROM scheduled_tasks WHERE peer = ?';
    const params: any[] = [peer];
    if (status) {
      query += ' AND status = ?';
      params.push(status);
    }
    query += ' ORDER BY next_run_at ASC';
    const rows = db.prepare(query).all(...params);
    return rows.map((r: any) => this.mapTaskRow(r));
  }

  /**
   * 更新指定定时任务信息
   */
  updateScheduledTask(
    id: string,
    updates: Partial<Pick<ScheduledTaskRecord, 'prompt' | 'next_run_at' | 'recurring_rule' | 'type'>>
  ): boolean {
    const db = this.ensureDb();
    const sets: string[] = ['updated_at = ?'];
    const values: any[] = [Date.now()];

    if (updates.prompt !== undefined) {
      sets.push('prompt = ?');
      values.push(updates.prompt);
    }
    if (updates.next_run_at !== undefined) {
      sets.push('next_run_at = ?');
      values.push(updates.next_run_at);
    }
    if (updates.type !== undefined) {
      sets.push('type = ?');
      values.push(updates.type);
    }
    if (updates.recurring_rule !== undefined) {
      sets.push('recurring_rule = ?');
      values.push(updates.recurring_rule ? JSON.stringify(updates.recurring_rule) : null);
    }

    values.push(id);
    const result = db.prepare(`UPDATE scheduled_tasks SET ${sets.join(', ')} WHERE id = ?`).run(...values);
    return result.changes > 0;
  }

  /**
   * 取消任务 (标记 status = 'cancelled')
   */
  cancelScheduledTask(id: string): boolean {
    const db = this.ensureDb();
    const result = db.prepare(`
      UPDATE scheduled_tasks
      SET status = 'cancelled', updated_at = ?
      WHERE id = ?
    `).run(Date.now(), id);
    return result.changes > 0;
  }

  /**
   * 完成任务或推进周期任务的下次执行时间
   */
  completeScheduledTask(id: string, nextRunAt?: number): boolean {
    const db = this.ensureDb();
    const now = Date.now();
    if (nextRunAt !== undefined && nextRunAt !== null) {
      const result = db.prepare(`
        UPDATE scheduled_tasks
        SET next_run_at = ?, updated_at = ?
        WHERE id = ?
      `).run(nextRunAt, now, id);
      return result.changes > 0;
    } else {
      const result = db.prepare(`
        UPDATE scheduled_tasks
        SET status = 'completed', updated_at = ?
        WHERE id = ?
      `).run(now, id);
      return result.changes > 0;
    }
  }

  /**
   * 获取所有 pending 状态且已到期（<= thresholdTime）的任务
   */
  getPendingScheduledTasks(thresholdTime: number = Date.now()): ScheduledTaskRecord[] {
    const db = this.ensureDb();
    const rows = db.prepare(`
      SELECT * FROM scheduled_tasks
      WHERE status = 'pending' AND next_run_at <= ?
      ORDER BY next_run_at ASC
    `).all(thresholdTime);
    return rows.map((r: any) => this.mapTaskRow(r));
  }

  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}
