/**
 * dsh-napcat-bridge: 数据库表结构初始化与平滑迁移 (Schema & Migration)
 */

import { backfillAttachmentJson } from '../attachment/store.js';

/** 存量附件描述符一次性回填标记（完成后不再扫描全表） */
export const ATTACHMENTS_BACKFILL_KEY = 'messages_attachments_backfill_v1';

export interface KvAccess {
  getPluginConfig(key: string): string | null;
  setPluginConfig(key: string, value: string): void;
}

export function initDatabaseSchema(db: any, kv?: KvAccess): void {
  db.exec(`
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
      reply_to INTEGER,
      source TEXT NOT NULL DEFAULT 'qq',
      attachments TEXT
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

    CREATE TABLE IF NOT EXISTS slang_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      term TEXT UNIQUE NOT NULL,
      tags TEXT NOT NULL DEFAULT '',
      definition TEXT NOT NULL,
      example TEXT,
      query_count INTEGER NOT NULL DEFAULT 0,
      last_queried_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_slang_term ON slang_entries (term);
    CREATE INDEX IF NOT EXISTS idx_slang_query_count ON slang_entries (query_count);
    CREATE INDEX IF NOT EXISTS idx_slang_updated_at ON slang_entries (updated_at);
  `);

  // 平滑升级已有数据库
  try {
    db.prepare('ALTER TABLE session_states ADD COLUMN model_provider TEXT').run();
  } catch {}
  try {
    db.prepare('ALTER TABLE session_states ADD COLUMN model_name TEXT').run();
  } catch {}
  try {
    db.prepare('ALTER TABLE session_states ADD COLUMN model_reasoning_effort TEXT').run();
  } catch {}
  try {
    db.prepare('ALTER TABLE faces ADD COLUMN deleted_at INTEGER').run();
  } catch {}

  // 消息来源列（qq = 真实 QQ 消息 / agent = Agent 内部协同通讯），存量数据默认 'qq'
  try {
    db.prepare("ALTER TABLE messages ADD COLUMN source TEXT NOT NULL DEFAULT 'qq'").run();
  } catch {}
  // 统一附件描述符列（存量记录保持 NULL，读取时从 raw 回退解析，不回填）
  try {
    db.prepare('ALTER TABLE messages ADD COLUMN attachments TEXT').run();
  } catch {}
  try {
    db.prepare('CREATE INDEX IF NOT EXISTS idx_messages_peer_source_time ON messages (peer, source, time)').run();
  } catch {}

  if (kv) {
    backfillAttachmentsOnce(db, kv);
  }
}

/**
 * 存量消息附件描述符一次性回填。
 *
 * - 能回填就回填：优先解析 raw 消息段；raw 不可用时用结构化列保守合成；
 * - 无法确认任何附件事实的记录保持 NULL；
 * - 完成后写入 plugin_kv 标记，后续启动不再扫描全表；
 * - 任何异常都不阻断启动（失败时不写标记，下次启动重试）。
 */
export function backfillAttachmentsOnce(db: any, kv: KvAccess): void {
  try {
    if (kv.getPluginConfig(ATTACHMENTS_BACKFILL_KEY) === '1') return;

    const rows = db
      .prepare(
        `SELECT msg_id, peer, self, type, content, raw, file_id, busid, local_path
         FROM messages WHERE attachments IS NULL`
      )
      .all() as any[];

    if (rows.length > 0) {
      const update = db.prepare(
        'UPDATE messages SET attachments = ? WHERE msg_id = ? AND attachments IS NULL'
      );
      const run = db.transaction((items: any[]) => {
        for (const row of items) {
          const json = backfillAttachmentJson(row);
          if (json) update.run(json, row.msg_id);
        }
      });
      run(rows);
    }

    kv.setPluginConfig(ATTACHMENTS_BACKFILL_KEY, '1');
  } catch {
    // 静默降级：不阻断启动，下次启动重试
  }
}
