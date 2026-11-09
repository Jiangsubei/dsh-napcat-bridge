/**
 * dsh-napcat-bridge: 社群黑话词典持久化仓库 (slang_entries)
 */

import type { SlangEntry } from '../../types/index.js';

export class SlangRepository {
  constructor(private getDb: () => any) {}

  private mapSlangRow(row: any): SlangEntry {
    return {
      id: row.id,
      term: row.term,
      tags: row.tags || '',
      definition: row.definition,
      example: row.example || '',
      query_count: row.query_count || 0,
      last_queried_at: row.last_queried_at || null,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  /**
   * 按词条标题检索黑话词条
   * @param term 标题名称
   * @param incrementQueryCount 是否自增 query_count 并更新 last_queried_at
   */
  getSlangEntry(term: string, incrementQueryCount = false): SlangEntry | null {
    const db = this.getDb();
    const clean = term.trim();
    if (!clean) return null;

    let row = db.prepare('SELECT * FROM slang_entries WHERE term = ?').get(clean);
    if (!row) return null;

    if (incrementQueryCount) {
      const now = Date.now();
      db.prepare('UPDATE slang_entries SET query_count = query_count + 1, last_queried_at = ? WHERE id = ?').run(now, row.id);
      row.query_count = (row.query_count || 0) + 1;
      row.last_queried_at = now;
    }

    return this.mapSlangRow(row);
  }

  /**
   * 插入新黑话词条
   */
  insertSlangEntry(entry: {
    term: string;
    tags?: string;
    definition: string;
    example?: string;
  }): SlangEntry {
    const db = this.getDb();
    const cleanTerm = entry.term.trim();
    const cleanDef = entry.definition.trim();
    const cleanTags = (entry.tags || '').trim();
    const cleanEx = (entry.example || '').trim();
    const now = Date.now();

    const info = db.prepare(`
      INSERT INTO slang_entries (term, tags, definition, example, query_count, last_queried_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, 0, NULL, ?, ?)
    `).run(cleanTerm, cleanTags, cleanDef, cleanEx, now, now);

    return {
      id: Number(info.lastInsertRowid),
      term: cleanTerm,
      tags: cleanTags,
      definition: cleanDef,
      example: cleanEx,
      query_count: 0,
      last_queried_at: null,
      created_at: now,
      updated_at: now,
    };
  }

  /**
   * 更新已有黑话词条
   */
  updateSlangEntry(
    term: string,
    updates: {
      new_term?: string;
      tags?: string;
      definition?: string;
      example?: string;
    }
  ): SlangEntry | null {
    const db = this.getDb();
    const existing = this.getSlangEntry(term, false);
    if (!existing) return null;

    const sets: string[] = [];
    const values: any[] = [];

    if (updates.new_term !== undefined && updates.new_term.trim()) {
      sets.push('term = ?');
      values.push(updates.new_term.trim());
    }
    if (updates.tags !== undefined) {
      sets.push('tags = ?');
      values.push(updates.tags.trim());
    }
    if (updates.definition !== undefined && updates.definition.trim()) {
      sets.push('definition = ?');
      values.push(updates.definition.trim());
    }
    if (updates.example !== undefined) {
      sets.push('example = ?');
      values.push(updates.example.trim());
    }

    const now = Date.now();
    sets.push('updated_at = ?');
    values.push(now);

    values.push(existing.id);

    db.prepare(`UPDATE slang_entries SET ${sets.join(', ')} WHERE id = ?`).run(...values);
    return this.getSlangEntry(updates.new_term?.trim() || existing.term, false);
  }

  /**
   * 删除指定黑话词条
   */
  deleteSlangEntry(term: string): boolean {
    const db = this.getDb();
    const existing = this.getSlangEntry(term, false);
    if (!existing) return false;
    const res = db.prepare('DELETE FROM slang_entries WHERE id = ?').run(existing.id);
    return res.changes > 0;
  }

  /**
   * 查询黑话列表（支持按标题、标签、释义、例句关键词模糊反查，支持可选 limit）
   */
  querySlangEntries(options: { keyword?: string; offset?: number; limit?: number } = {}): {
    entries: SlangEntry[];
    total: number;
  } {
    const db = this.getDb();
    const kw = options.keyword?.trim();
    let whereClause = '';
    const params: any[] = [];

    if (kw) {
      whereClause = 'WHERE term LIKE ? OR tags LIKE ? OR definition LIKE ? OR example LIKE ?';
      const like = `%${kw}%`;
      params.push(like, like, like, like);
    }

    const totalRow = db.prepare(`SELECT COUNT(*) as total FROM slang_entries ${whereClause}`).get(...params);
    const total = totalRow ? totalRow.total : 0;

    let query = `SELECT * FROM slang_entries ${whereClause} ORDER BY updated_at DESC, id DESC`;
    if (options.limit !== undefined && options.limit > 0) {
      query += ` LIMIT ${Number(options.limit)}`;
      if (options.offset !== undefined && options.offset > 0) {
        query += ` OFFSET ${Math.floor(Number(options.offset))}`;
      }
    }

    const rows = db.prepare(query).all(...params);
    return {
      entries: rows.map((r: any) => this.mapSlangRow(r)),
      total,
    };
  }

  /**
   * 获取用于常驻 L1 Prompt 渲染的轻量索引列表
   */
  getAllSlangEntriesForContext(): Array<{ term: string; tags: string }> {
    const db = this.getDb();
    const rows = db.prepare('SELECT term, tags FROM slang_entries ORDER BY updated_at DESC, id DESC').all();
    return rows.map((r: any) => ({
      term: r.term,
      tags: r.tags || '',
    }));
  }

  /**
   * 获取黑话总条数
   */
  getSlangCount(): number {
    const db = this.getDb();
    const row = db.prepare('SELECT COUNT(*) as count FROM slang_entries').get();
    return row ? row.count : 0;
  }

  /**
   * LRU 淘汰策略：淘汰被模型查询次数最少且最久未被查询的词条
   */
  evictSlangEntryLru(): SlangEntry | null {
    const db = this.getDb();
    const candidate = db.prepare(`
      SELECT * FROM slang_entries
      ORDER BY query_count ASC, COALESCE(last_queried_at, 0) ASC, id ASC
      LIMIT 1
    `).get();

    if (!candidate) return null;
    db.prepare('DELETE FROM slang_entries WHERE id = ?').run(candidate.id);
    return this.mapSlangRow(candidate);
  }
}
