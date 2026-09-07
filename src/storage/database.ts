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
} from '../types/index.js';

export interface SessionStateRecord {
  peer: string;
  current_session_id: string;
  cleared_round: number;
  cleared_version: number;
  updated_at: number;
  model_provider?: string;
  model_name?: string;
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

  // 3. 相对时间表达式（如 "30m", "2h", "1d", "7d", "2小时", "3天"）
  const relativeMatch = str.match(/^(\d+)\s*(s|m|h|d|w|y|秒|分|小时|天|周|年)$/i);
  if (relativeMatch) {
    const count = Number(relativeMatch[1]);
    const unit = relativeMatch[2].toLowerCase();
    let unitMs = 1000;
    if (unit === 's' || unit === '秒') unitMs = 1000;
    else if (unit === 'm' || unit === '分') unitMs = 60 * 1000;
    else if (unit === 'h' || unit === '小时') unitMs = 3600 * 1000;
    else if (unit === 'd' || unit === '天') unitMs = 86400 * 1000;
    else if (unit === 'w' || unit === '周') unitMs = 7 * 86400 * 1000;
    else if (unit === 'y' || unit === '年') unitMs = 365 * 86400 * 1000;

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
    `);

    // 平滑升级已有数据库
    try {
      this.db.prepare('ALTER TABLE session_states ADD COLUMN model_provider TEXT').run();
    } catch {}
    try {
      this.db.prepare('ALTER TABLE session_states ADD COLUMN model_name TEXT').run();
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

  readHistory(peer: string, params: ReadChatHistoryParams = {}): ReadChatHistoryResult {
    const db = this.ensureDb();
    const conditions: string[] = ['peer = ?'];
    const sqlParams: any[] = [peer];

    // 1. 发送者 QQ 精确匹配
    if (params.user_id !== undefined && params.user_id !== '') {
      conditions.push('user_id = ?');
      sqlParams.push(String(params.user_id));
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

    // 4. 消息类型筛选 (支持单类型或类型数组)
    if (params.type !== undefined) {
      if (Array.isArray(params.type)) {
        const types = params.type.filter((t) => typeof t === 'string' && t.trim() !== '');
        if (types.length === 1) {
          conditions.push('type = ?');
          sqlParams.push(types[0]);
        } else if (types.length > 1) {
          conditions.push(`type IN (${types.map(() => '?').join(', ')})`);
          sqlParams.push(...types);
        }
      } else if (typeof params.type === 'string' && params.type.trim() !== '') {
        conditions.push('type = ?');
        sqlParams.push(params.type.trim());
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
        model_provider, model_name
      ) VALUES (
        @peer, @current_session_id, @cleared_round, @cleared_version, @updated_at,
        @model_provider, @model_name
      )
    `).run({
      peer: state.peer,
      current_session_id: state.current_session_id,
      cleared_round: state.cleared_round ?? 0,
      cleared_version: state.cleared_version ?? 1,
      updated_at: state.updated_at || Date.now(),
      model_provider: state.model_provider ?? null,
      model_name: state.model_name ?? null,
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

  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}
