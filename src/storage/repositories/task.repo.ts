/**
 * dsh-napcat-bridge: 定时任务表持久化仓库 (scheduled_tasks)
 */

import type {
  ScheduledTaskRecord,
  ScheduledTaskStatus,
  RecurringRule,
} from '../../types/index.js';

export class TaskRepository {
  constructor(private getDb: () => any) {}

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

  createScheduledTask(task: ScheduledTaskRecord): void {
    const db = this.getDb();
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

  getScheduledTask(id: string): ScheduledTaskRecord | null {
    const db = this.getDb();
    const row = db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id);
    return row ? this.mapTaskRow(row) : null;
  }

  listScheduledTasks(peer: string, status?: ScheduledTaskStatus): ScheduledTaskRecord[] {
    const db = this.getDb();
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

  updateScheduledTask(
    id: string,
    updates: Partial<Pick<ScheduledTaskRecord, 'prompt' | 'next_run_at' | 'recurring_rule' | 'type'>>
  ): boolean {
    const db = this.getDb();
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

  cancelScheduledTask(id: string): boolean {
    const db = this.getDb();
    const result = db.prepare(`
      UPDATE scheduled_tasks
      SET status = 'cancelled', updated_at = ?
      WHERE id = ?
    `).run(Date.now(), id);
    return result.changes > 0;
  }

  completeScheduledTask(id: string, nextRunAt?: number): boolean {
    const db = this.getDb();
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

  getPendingScheduledTasks(thresholdTime: number = Date.now()): ScheduledTaskRecord[] {
    const db = this.getDb();
    const rows = db.prepare(`
      SELECT * FROM scheduled_tasks
      WHERE status = 'pending' AND next_run_at <= ?
      ORDER BY next_run_at ASC
    `).all(thresholdTime);
    return rows.map((r: any) => this.mapTaskRow(r));
  }
}
