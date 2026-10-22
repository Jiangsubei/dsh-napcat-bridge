/**
 * dsh-napcat-bridge: 会话持久化与物理磁盘有效性探查模块
 * 负责与 SQLite 数据库同步会话状态，并双向校验磁盘物理会话日志存活性。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { Context } from '@deepseek-ai/cordis';
import type { MessageDatabase } from '../../storage/database.js';
import { encodeSegment } from '../../utils/path.js';
import type { SessionWorkspaceManager } from './workspace.js';

export class SessionPersistenceManager {
  constructor(
    private readonly db?: MessageDatabase | null,
    private readonly ctx?: Context,
    private readonly workspace?: SessionWorkspaceManager
  ) {}

  public getPluginConfig(key: string): string | null | undefined {
    return this.db?.getPluginConfig?.(key);
  }

  public setPluginConfig(key: string, value: string): void {
    this.db?.setPluginConfig?.(key, value);
  }

  public getAllSessionStates(): any[] {
    return this.db?.getAllSessionStates?.() || [];
  }

  public getSessionState(peer: string): any {
    return this.db?.getSessionState?.(peer);
  }

  public saveSessionState(state: any): void {
    this.db?.saveSessionState?.(state);
  }

  /**
   * 判断指定 SessionId 是否已被 DSH Web UI / workspaceRegistry 归档
   */
  public isSessionArchived(sessionId: string): boolean {
    const wsRegistry = this.ctx?.get?.('workspaceRegistry') || (this.ctx as any)?.workspaceRegistry;
    if (wsRegistry?.archivedSessionIds && Array.isArray(wsRegistry.archivedSessionIds)) {
      return wsRegistry.archivedSessionIds.includes(sessionId as any);
    }
    return false;
  }

  /**
   * 检查指定 Session 是否有效存在（支持内存活跃会话与物理磁盘日志文件，确保未落盘的 live 会话不被误杀）
   */
  public isSessionPhysicallyPresent(sessionId: string): boolean {
    // 0. 优先检查进程内存中的活跃会话或 Agent（DSH 0.2.x 延迟落盘保护，防止 live 会话因未写盘被误判死亡）
    const sessions = this.ctx?.get?.('sessions') || (this.ctx as any)?.sessions;
    if (sessions && typeof sessions.get === 'function') {
      try {
        const live = sessions.get(sessionId);
        if (live !== undefined) return true;
      } catch {}
    }

    const agents = this.ctx?.get?.('agents') || (this.ctx as any)?.agents;
    if (agents && typeof agents.get === 'function') {
      try {
        const liveAgent = agents.get(sessionId);
        if (liveAgent !== undefined) return true;
      } catch {}
    }

    const persistence = this.ctx?.get?.('sessionPersistence') || (this.ctx as any)?.sessionPersistence;
    if (persistence && typeof (persistence as any).locate === 'function') {
      try {
        const cwd = this.workspace?.resolveCwd() || '';
        const loc = (persistence as any).locate({ id: sessionId, cwd });
        if (loc?.path) {
          if (fs.existsSync(loc.path) && !fs.statSync(loc.path).isDirectory()) {
            return true;
          }
        }
      } catch {}
    }

    const defaultHome = path.join(os.homedir(), '.dsh');
    const dshHome = this.workspace?.getDshHome() || defaultHome;
    const encodedId = encodeSegment(sessionId);
    const sessionFileCandidates = [
      'session.v4.jsonl',
      'session.v4.jsonl.zstd',
      'session.v3.jsonl',
      'session.v3.jsonl.zstd',
      'session.v2.jsonl',
      'session.v2.jsonl.zstd',
      'session.jsonl',
      'session.jsonl.zstd',
    ];

    const checkRoots = [
      path.join(dshHome, 'sessions'),
      ...(dshHome !== defaultHome ? [] : [path.join(os.homedir(), '.dsh', 'sessions')]),
    ];

    for (const baseSessionsDir of checkRoots) {
      if (fs.existsSync(baseSessionsDir)) {
        try {
          const dirs = fs.readdirSync(baseSessionsDir);
          for (const d of dirs) {
            const candidates = [
              path.join(baseSessionsDir, d, encodedId),
              ...(encodedId !== sessionId ? [path.join(baseSessionsDir, d, sessionId)] : []),
            ];
            for (const candidate of candidates) {
              if (fs.existsSync(candidate)) {
                try {
                  const st = fs.statSync(candidate);
                  if (st.isDirectory()) {
                    const files = fs.readdirSync(candidate);
                    const hasLog = sessionFileCandidates.some((fn) =>
                      files.includes(fn)
                    );
                    if (hasLog) return true;
                  } else if (st.isFile()) {
                    return true;
                  }
                } catch {}
              }
            }
          }
        } catch {}
      }
    }

    return false;
  }

  /**
   * 异步精确检查物理会话状态（利用 DSH 0.2.x sessionPersistence.stat API）
   */
  public async isSessionPhysicallyPresentAsync(sessionId: string): Promise<boolean> {
    const persistence = this.ctx?.get?.('sessionPersistence') || (this.ctx as any)?.sessionPersistence;
    if (persistence && typeof persistence.stat === 'function') {
      try {
        const snapshot = await persistence.stat(sessionId as any);
        if (snapshot !== undefined) {
          return true;
        }
      } catch {}
    }

    return this.isSessionPhysicallyPresent(sessionId);
  }
}
