/**
 * dsh-napcat-bridge: 表情包资产库持久化仓库 (faces)
 */

import type {
  FaceRecord,
  FaceQueryOptions,
  FaceMoodSummary,
} from '../../types/index.js';
import { DEFAULT_FACE_STORE_MAX } from '../../constants/index.js';

export class FaceRepository {
  constructor(private getDb: () => any) {}

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
    const db = this.getDb();

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
    const db = this.getDb();
    const sql = options?.includeDeleted
      ? `SELECT * FROM faces WHERE id = ?`
      : `SELECT * FROM faces WHERE id = ? AND deleted_at IS NULL`;
    const row = db.prepare(sql).get(id) as any;
    return row ? this.mapFaceRow(row) : null;
  }

  getFaceByMd5(md5: string, options?: { includeDeleted?: boolean }): FaceRecord | null {
    const db = this.getDb();
    const sql = options?.includeDeleted
      ? `SELECT * FROM faces WHERE md5 = ?`
      : `SELECT * FROM faces WHERE md5 = ? AND deleted_at IS NULL`;
    const row = db.prepare(sql).get(md5) as any;
    return row ? this.mapFaceRow(row) : null;
  }

  /**
   * 获取表情包库容概览与情绪统计 (按情绪频次降序)
   */
  getFaceMoodSummary(limitMoods: number = 8): FaceMoodSummary {
    const db = this.getDb();
    const countRow = db
      .prepare(`SELECT COUNT(*) as cnt FROM faces WHERE deleted_at IS NULL AND enabled = 1`)
      .get() as any;
    const total = Number(countRow?.cnt ?? 0);

    const safeLimit = Math.max(1, limitMoods);
    const rows = db
      .prepare(
        `
      SELECT mood, COUNT(*) as cnt
      FROM faces
      WHERE deleted_at IS NULL AND enabled = 1 AND mood IS NOT NULL AND TRIM(mood) != ''
      GROUP BY mood
      ORDER BY cnt DESC, mood ASC
      LIMIT ?
    `
      )
      .all(safeLimit) as any[];

    const moods = rows.map((r) => ({
      mood: String(r.mood),
      count: Number(r.cnt ?? 0),
    }));

    return { total, moods };
  }

  /**
   * 获取供动态上下文注入的活跃表情包列表 (默认最多 DEFAULT_FACE_STORE_MAX 张)
   */
  getActiveFacesForContext(limit: number = DEFAULT_FACE_STORE_MAX): { faces: FaceRecord[]; total: number } {
    const q = this.queryFaces({ enabledOnly: true, limit: Math.max(1, limit) });
    return { faces: q.faces, total: q.total };
  }

  queryFaces(options: FaceQueryOptions = {}): { faces: FaceRecord[]; total: number; has_more: boolean } {
    const db = this.getDb();
    const whereClauses: string[] = [];
    const params: any[] = [];

    if (!options.includeDeleted) {
      whereClauses.push('deleted_at IS NULL');
    }

    if (options.enabledOnly ?? true) {
      whereClauses.push('enabled = 1');
    }

    if (options.mood && options.mood.trim()) {
      whereClauses.push('mood LIKE ?');
      params.push(`%${options.mood.trim()}%`);
    }

    if (options.untagged) {
      whereClauses.push(`(tags IS NULL OR tags = '' OR tags = '[]')`);
    } else if (options.tag && options.tag.trim()) {
      whereClauses.push('tags LIKE ?');
      params.push(`%${options.tag.trim()}%`);
    }

    if (options.query && options.query.trim()) {
      const q = options.query.trim();
      whereClauses.push('(tags LIKE ? OR mood LIKE ?)');
      params.push(`%${q}%`, `%${q}%`);
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
    const db = this.getDb();
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
    const db = this.getDb();
    db.prepare(`UPDATE faces SET file_path = ? WHERE id = ?`).run(filePath, id);
  }

  deleteFace(id: string): boolean {
    const db = this.getDb();
    const info = db.prepare(`
      UPDATE faces
      SET deleted_at = ?, enabled = 0
      WHERE id = ? AND deleted_at IS NULL
    `).run(Date.now(), id);
    return info.changes > 0;
  }

  restoreFace(id: string): boolean {
    const db = this.getDb();
    const info = db.prepare(`
      UPDATE faces
      SET deleted_at = NULL, enabled = 1
      WHERE id = ?
    `).run(id);
    return info.changes > 0;
  }

  purgeExpiredFaces(graceDays: number = 7): string[] {
    const db = this.getDb();
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
    const db = this.getDb();
    db.prepare(`
      UPDATE faces
      SET use_count = use_count + 1, last_used_at = ?
      WHERE id = ?
    `).run(Date.now(), id);
  }
}
