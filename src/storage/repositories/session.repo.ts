/**
 * dsh-napcat-bridge: 会话状态与模型路由偏好持久化仓库 (session_states)
 */

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

export class SessionRepository {
  constructor(private getDb: () => any) {}

  saveSessionState(state: SessionStateRecord): void {
    const db = this.getDb();
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
    const db = this.getDb();
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
    const db = this.getDb();
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
}
