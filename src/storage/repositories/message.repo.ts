/**
 * dsh-napcat-bridge: 消息记录与群文件持久化仓库 (messages)
 */

import type {
  ChatMessageSummary,
  GroupFileInfo,
  ListGroupFilesParams,
  ListGroupFilesResult,
  MessageRecord,
  ReadChatHistoryParams,
  ReadChatHistoryResult,
  FaceRecord,
} from '../../types/index.js';
import { formatDateTime, parseTimeValue } from '../time-parser.js';
import {
  GROUP_FILE_DEDUPE_WINDOW_MS,
  parseGroupFileRowInfo,
  mergeDuplicateGroupFileRows,
} from '../group-file-helper.js';

export class MessageRepository {
  constructor(
    private getDb: () => any,
    private getFaceById?: (id: string, options?: { includeDeleted?: boolean }) => FaceRecord | null
  ) {}

  saveMessage(record: MessageRecord): void {
    const db = this.getDb();
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO messages (
        msg_id, peer, user_id, sender_name, time, type, content, raw,
        file_id, busid, local_path, fingerprint, recalled, self, reply_to, source, attachments
      ) VALUES (
        @msg_id, @peer, @user_id, @sender_name, @time, @type, @content, @raw,
        @file_id, @busid, @local_path, @fingerprint, @recalled, @self, @reply_to, @source, @attachments
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
      source: record.source ?? 'qq',
      attachments: record.attachments ?? null,
    });
  }

  /**
   * 检查指定消息 ID 是否已存在
   */
  hasMessage(msgId: number): boolean {
    const db = this.getDb();
    const row = db.prepare('SELECT 1 FROM messages WHERE msg_id = ? LIMIT 1').get(msgId);
    return Boolean(row);
  }

  /**
   * 获取指定会话 peer 在本地数据库中的最新一条消息时间戳（毫秒）
   * 若该 peer 尚无任何历史消息，返回 null
   */
  getLatestMessageTime(peer: string): number | null {
    const db = this.getDb();
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
    const db = this.getDb();
    const stmt = db.prepare(`
      INSERT OR IGNORE INTO messages (
        msg_id, peer, user_id, sender_name, time, type, content, raw,
        file_id, busid, local_path, fingerprint, recalled, self, reply_to, source, attachments
      ) VALUES (
        @msg_id, @peer, @user_id, @sender_name, @time, @type, @content, @raw,
        @file_id, @busid, @local_path, @fingerprint, @recalled, @self, @reply_to, @source, @attachments
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
      source: record.source ?? 'qq',
      attachments: record.attachments ?? null,
    });

    return result.changes > 0;
  }

  readHistory(peer: string, params: ReadChatHistoryParams = {}): ReadChatHistoryResult {
    const db = this.getDb();
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

    if (params.since !== undefined && params.since !== null && String(params.since).trim() !== '' && sinceTs === undefined) {
      console.warn(`[MessageDatabase] readHistory: 无法解析 since 时间参数 "${params.since}"，该筛选条件已被忽略`);
    }
    if (params.until !== undefined && params.until !== null && String(params.until).trim() !== '' && untilTs === undefined) {
      console.warn(`[MessageDatabase] readHistory: 无法解析 until 时间参数 "${params.until}"，该筛选条件已被忽略`);
    }

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

    // 9. 消息来源筛选 (qq = 真实 QQ 消息 / agent = Agent 内部协同通讯)
    if (params.source !== undefined) {
      const rawSources = Array.isArray(params.source) ? params.source : [params.source];
      const sources = rawSources.filter(
        (s): s is 'qq' | 'agent' => s === 'qq' || s === 'agent'
      );
      if (sources.length === 1) {
        conditions.push('source = ?');
        sqlParams.push(sources[0]);
      } else if (sources.length > 1) {
        conditions.push(`source IN (${sources.map(() => '?').join(', ')})`);
        sqlParams.push(...sources);
      }
    }

    const whereClause = conditions.join(' AND ');
    const countRow = db.prepare(`SELECT count(*) as count FROM messages WHERE ${whereClause}`).get(...sqlParams) as { count: number };
    const total = countRow ? countRow.count : 0;

    const order = params.order?.toLowerCase() === 'asc' ? 'ASC' : 'DESC';
    const offset = Number.isFinite(Number(params.offset)) && Number(params.offset) > 0
      ? Math.floor(Number(params.offset))
      : 0;
    const limit = Math.min(Math.max(params.limit ?? 20, 1), 100);

    const rows = db.prepare(`
      SELECT * FROM messages
      WHERE ${whereClause}
      ORDER BY time ${order}
      LIMIT ? OFFSET ?
    `).all(...sqlParams, limit, offset) as any[];

    const messages: ChatMessageSummary[] = rows.map((row) => {
      let localPath = row.local_path ?? null;
      let content = row.content;

      // 针对存量或未记录 local_path 的表情包记录进行兜底补全
      if (!localPath && content) {
        const faceMatch = content.match(/\[表情包:\s*([^ (\]]+)/);
        if (faceMatch && faceMatch[1]) {
          const face = this.getFaceById ? this.getFaceById(faceMatch[1].trim()) : null;
          if (face && face.file_path) {
            localPath = face.file_path;
          }
        }
      }

      // 存量历史消息格式归一化与路径补齐：
      // 1) 库内表情旧格式 [表情包: face_xxx (情绪: yyy)] -> 补齐 " 路径: <localPath>"
      // 2) 普通表情旧格式 [表情包:[动画表情] 已保存: <path>] -> 清洗嵌套方括号与已保存 -> [表情包: 动画表情 路径: <path>]
      // 3) 普通表情旧格式 [表情包:滑稽 已保存: <path>] -> [表情包: 滑稽 路径: <path>]
      if (content && localPath && !content.includes(' 路径: ')) {
        if (content.includes('已保存: ')) {
          content = content.replace(
            /\[表情包:(?:\[(.*?)\]|([^ \]]+))\s+已保存:\s*([^\]]+)\]/g,
            (_m: string, p1?: string, p2?: string, p3?: string) => `[表情包: ${(p1 || p2 || '表情').trim()} 路径: ${(p3 || '').trim()}]`
          );
        } else {
          content = content.replace(
            /\[表情包:\s*([^\]]+?)\]/g,
            (_m: string, inner: string) => `[表情包: ${inner.trim()} 路径: ${localPath}]`
          );
        }
      } else if (content && content.includes('已保存: ')) {
        content = content.replace(
          /\[表情包:(?:\[(.*?)\]|([^ \]]+))\s+已保存:\s*([^\]]+)\]/g,
          (_m: string, p1?: string, p2?: string, p3?: string) => `[表情包: ${(p1 || p2 || '表情').trim()} 路径: ${(p3 || '').trim()}]`
        );
      }

      return {
        msg_id: Number(row.msg_id),
        user_id: String(row.user_id),
        sender_name: row.sender_name,
        time: Number(row.time),
        formatted_time: formatDateTime(Number(row.time)),
        type: row.type,
        content,
        recalled: row.recalled === 1,
        self: row.self === 1,
        reply_to: row.reply_to !== null && row.reply_to !== undefined ? Number(row.reply_to) : null,
        local_path: localPath,
        file_id: row.file_id ?? null,
        attachments: row.attachments ?? null,
        source: row.source === 'agent' ? 'agent' : 'qq',
      };
    });

    return {
      messages,
      total: messages.length,
      total_matched: total,
      offset,
      limit,
      has_more: offset + messages.length < total,
    };
  }

  listGroupFiles(peer: string, params: ListGroupFilesParams = {}): ListGroupFilesResult {
    const db = this.getDb();
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
    const order = params.order?.toLowerCase() === 'asc' ? 'ASC' : 'DESC';
    const offset = Number.isFinite(Number(params.offset)) && Number(params.offset) > 0
      ? Math.floor(Number(params.offset))
      : 0;
    const limit = Math.min(Math.max(params.limit ?? 20, 1), 100);

    // SnowLuma 兼容：同一次上传会同时产生 notice 与消息段两条记录，
    // 先按时间升序全量取出并合并双记录，再统一排序分页，避免分页后再去重造成条数抖动。
    const rows = db.prepare(`
      SELECT * FROM messages
      WHERE ${whereClause}
      ORDER BY time ASC, msg_id ASC
    `).all(...sqlParams) as any[];

    const merged = mergeDuplicateGroupFileRows(rows);
    if (order === 'DESC') merged.reverse();

    const total = merged.length;
    const pageEntries = merged.slice(offset, offset + limit);

    const files: GroupFileInfo[] = pageEntries.map((entry) => {
      const row = entry.row;
      const senderName = (row.sender_name && String(row.sender_name).trim())
        ? String(row.sender_name).trim()
        : String(row.user_id);

      return {
        msg_id: Number(row.msg_id),
        file_id: entry.fileId,
        file_name: entry.fileName,
        busid: entry.busid,
        sender_name: senderName,
        user_id: String(row.user_id),
        time: Number(row.time),
        formatted_time: formatDateTime(Number(row.time)),
        size: entry.size,
      };
    });

    return {
      success: true,
      files,
      total: files.length,
      total_matched: total,
      offset,
      limit,
      has_more: offset + files.length < total,
    };
  }

  /**
   * 查找同一次群文件上传产生的消息段兄弟记录（file_id 为 /uuid 形态）。
   * 用于 SnowLuma 兼容垫片：notice 事件只带 32 位 hex file_id，需换回可用形态。
   */
  findGroupFileSibling(
    peer: string,
    fileName: string,
    time: number,
    size?: number
  ): MessageRecord | null {
    if (!peer || !fileName || !Number.isFinite(time)) return null;
    const db = this.getDb();
    const targetName = fileName.trim();
    if (!targetName) return null;

    const rows = db.prepare(`
      SELECT * FROM messages
      WHERE peer = ? AND type = 'group_file' AND file_id LIKE '/%'
      ORDER BY ABS(time - ?) ASC
      LIMIT 50
    `).all(peer, time) as any[];

    for (const row of rows) {
      if (Math.abs(Number(row.time) - time) > GROUP_FILE_DEDUPE_WINDOW_MS) break;
      const info = parseGroupFileRowInfo(row);
      if (info.fileName !== targetName) continue;
      if (size !== undefined && info.size !== undefined && info.size !== size) continue;
      return this.getMessage(Number(row.msg_id));
    }

    return null;
  }

  /**
   * 获取指定 peer 在过去特定时间内（默认 7 天）活跃发言的非机器人用户列表，按最后发言时间降序排列
   */
  getActiveUsers(peer: string, days = 7, limit = 20): Array<{ user_id: string; sender_name: string; last_active: number }> {
    const db = this.getDb();
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
    const db = this.getDb();
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
    const db = this.getDb();
    const row = db.prepare(`SELECT MAX(msg_id) as max_id FROM messages WHERE peer = ?`).get(peer) as any;
    return Number(row?.max_id ?? 0);
  }

  /**
   * 标记消息已撤回。
   * - 机器人自身消息：仅置 recalled=1，保留原文（上下文压缩后仍能回溯自己说过什么）；
   * - 他人消息：内容替换为占位符（不保留被撤回者原文）。
   */
  markRecalled(msgId: number): void {
    const db = this.getDb();
    db.prepare(
      `UPDATE messages
         SET recalled = 1,
             content = CASE WHEN self = 1 THEN content ELSE '〔已撤回〕' END
       WHERE msg_id = ?`
    ).run(msgId);
  }

  getMessage(msgId: number): MessageRecord | null {
    const db = this.getDb();
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
      attachments: row.attachments ?? null,
    };
  }

  getByFileId(fileId: string): MessageRecord | null {
    const db = this.getDb();
    const row = db.prepare(`SELECT * FROM messages WHERE file_id = ? LIMIT 1`).get(fileId) as any;
    if (!row) return null;
    return this.getMessage(row.msg_id);
  }

  getByFingerprint(fingerprint: string): MessageRecord | null {
    const db = this.getDb();
    const row = db.prepare(`SELECT * FROM messages WHERE fingerprint = ? LIMIT 1`).get(fingerprint) as any;
    if (!row) return null;
    return this.getMessage(row.msg_id);
  }

  updateLocalPath(msgId: number, localPath: string, fingerprint?: string | null): void {
    const db = this.getDb();
    if (fingerprint !== undefined) {
      db.prepare(`UPDATE messages SET local_path = ?, fingerprint = ? WHERE msg_id = ?`).run(localPath, fingerprint, msgId);
    } else {
      db.prepare(`UPDATE messages SET local_path = ? WHERE msg_id = ?`).run(localPath, msgId);
    }
  }

  /**
   * 出站媒体元数据补全：仅更新传入的字段（file_id / busid / local_path / raw / attachments），
   * 绝不覆盖未传入的已有值，保证 get_msg 回填失败时 payload 版本仍然可用。
   */
  updateMessageMedia(
    msgId: number,
    patch: {
      file_id?: string | null;
      busid?: number | null;
      local_path?: string | null;
      raw?: string;
      attachments?: string | null;
    }
  ): void {
    const db = this.getDb();
    const sets: string[] = [];
    const values: any[] = [];

    if (patch.file_id !== undefined) {
      sets.push('file_id = ?');
      values.push(patch.file_id ?? null);
    }
    if (patch.busid !== undefined) {
      sets.push('busid = ?');
      values.push(patch.busid ?? null);
    }
    if (patch.local_path !== undefined) {
      sets.push('local_path = ?');
      values.push(patch.local_path ?? null);
    }
    if (patch.raw !== undefined) {
      sets.push('raw = ?');
      values.push(patch.raw);
    }
    if (patch.attachments !== undefined) {
      sets.push('attachments = ?');
      values.push(patch.attachments ?? null);
    }
    if (sets.length === 0) return;

    values.push(msgId);
    db.prepare(`UPDATE messages SET ${sets.join(', ')} WHERE msg_id = ?`).run(...values);
  }

  updateLocalPathByFileId(fileId: string, localPath: string, fingerprint?: string | null): void {
    const db = this.getDb();
    if (fingerprint !== undefined) {
      db.prepare(`UPDATE messages SET local_path = ?, fingerprint = ? WHERE file_id = ?`).run(localPath, fingerprint, fileId);
    } else {
      db.prepare(`UPDATE messages SET local_path = ? WHERE file_id = ?`).run(localPath, fileId);
    }
  }

  clearLocalPath(localPath: string): void {
    const db = this.getDb();
    db.prepare(`UPDATE messages SET local_path = NULL WHERE local_path = ?`).run(localPath);
  }
}
