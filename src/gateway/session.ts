/**
 * dsh-napcat-bridge: Session 路由与 CWD 隔离映射模块
 * 负责 QQ Peer 与 DSH SessionId 的双向转换，CWD 目录隔离分配，以及驱动 Agent 生命周期与 followup 消息下发。
 * 当检测到此前会话已被 Web UI 归档时，自动建立新的活跃会话。
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { promises as fsp } from 'node:fs';
import type { Context } from '@deepseek-ai/cordis';
import {
  installModelSelection,
  type Agent,
  type AgentHandle,
  type ModelSelection,
  type ModelSelectionRef,
} from '@deepseek-ai/dsh-agent';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { formatDateTime, type MessageDatabase } from '../storage/database.js';
import type { WakeupPayload } from '../types/index.js';
import { DEFAULT_WORKSPACE_ROOT } from '../constants/index.js';
import { resolveDshPath, encodeSegment } from '../utils/path.js';

export { encodeSegment };

/**
 * 结构化 RemoteError 类（对齐 DSH typert-protocol 远程调用失败契约）
 */
export class RemoteError extends Error {
  readonly code: string;
  readonly details: any;
  readonly isDSHRemoteError = true;

  constructor(code: string, message: string, details: any = {}, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
    this.details = details;
    this.name = 'RemoteError';
    Object.setPrototypeOf(this, RemoteError.prototype);
  }
}

/**
 * DSH 0.1.5 文件级排他锁 (session.lock) 冲突异常
 */
export class SessionAlreadyOwnedError extends Error {
  readonly sessionId: string;

  constructor(sessionId: string, message?: string) {
    super(
      message ||
        `会话 ${sessionId} 当前正被其他控制台或任务占用（排他锁冲突），请稍后重试或在 Web 端切换其他会话以释放锁。`
    );
    this.name = 'SessionAlreadyOwnedError';
    this.sessionId = sessionId;
    Object.setPrototypeOf(this, SessionAlreadyOwnedError.prototype);
  }
}

export interface ParsedSessionId {
  peer: string;
  id: string;
  round: number;
  version: number;
  isGroup: boolean;
}

/**
 * 解析 DSH SessionId（支持基础版本 qq-user-123 / qq-user-123-2 及多轮归档版本 qq-user-123-r1-1）
 */
export function parseSessionId(sessionId: string): ParsedSessionId | null {
  const groupMatch = sessionId.match(/^qq-group-([0-9a-zA-Z_]+?)(?:-r(\d+))?(?:-(\d+))?$/);
  if (groupMatch) {
    const id = groupMatch[1];
    const round = groupMatch[2] ? parseInt(groupMatch[2], 10) : 0;
    const version = groupMatch[3] ? parseInt(groupMatch[3], 10) : (round > 0 ? 1 : 1);
    return { peer: `group_${id}`, id, round, version, isGroup: true };
  }
  const userMatch = sessionId.match(/^qq-user-([0-9a-zA-Z_]+?)(?:-r(\d+))?(?:-(\d+))?$/);
  if (userMatch) {
    const id = userMatch[1];
    const round = userMatch[2] ? parseInt(userMatch[2], 10) : 0;
    const version = userMatch[3] ? parseInt(userMatch[3], 10) : (round > 0 ? 1 : 1);
    return { peer: `user_${id}`, id, round, version, isGroup: false };
  }
  return null;
}

/**
 * 构造符合命名规范的 SessionId
 */
export function buildSessionId(baseId: string, round: number, version: number): string {
  if (round === 0) {
    return version === 1 ? baseId : `${baseId}-${version}`;
  }
  return `${baseId}-r${round}-${version}`;
}

export interface OutboundBridgeLike {
  trackInboundContext(peer: string, context: any): void;
  trackPendingMessage?(messageId: string, peer: string, context: any): void;
}

export class SessionManager {
  private activeHandles = new Map<string, AgentHandle>();
  private peerCurrentSessionId = new Map<string, string>();
  private selectionMap = new Map<string, ModelSelectionRef>();
  /** 每 peer 的"已清空并开启新会话"版本与轮次号 (Spec §8.1 /clear: 直接开启新对话，不归档旧会话) */
  private clearedVersions = new Map<string, { round: number; version: number }>();

  private napcatDefaultModel?: ModelSelection;
  private outboundBridge?: OutboundBridgeLike;
  private busySessions = new Set<string>();

  setOutboundBridge(bridge: OutboundBridgeLike): void {
    this.outboundBridge = bridge;
  }

  getOutboundBridge(): OutboundBridgeLike | undefined {
    return this.outboundBridge;
  }

  getActiveTurn(peer: string): number | undefined {
    return (this.outboundBridge as any)?.getActiveTurn?.(peer);
  }

  private readonly dshHome: string;

  constructor(
    private readonly ctx: Context,
    dshHome?: string,
    private readonly db?: MessageDatabase,
    private readonly options?: { retryDelays?: number[] }
  ) {
    this.dshHome = path.resolve(dshHome || process.env.DSH_HOME || path.join(os.homedir(), '.dsh'));
    this.loadStateFromDb();
    this.guardSessionController();
    if (typeof (this.ctx as any).on === 'function') {
      (this.ctx as any).on('ready', () => {
        this.guardSessionController();
      });
    }
  }

  /**
   * 拦截 Web UI 发送消息 (sessionController.prompt)：
   * 当 QQ 会话处于活跃状态或独占持有时，强制拒绝并返回只读提示
   */
  public guardSessionController(sc?: any): void {
    let target = sc;
    if (!target) {
      try {
        target = (this.ctx as any).root?.sessionController || (this.ctx as any).sessionController;
      } catch {
        try {
          target = this.ctx.get?.('sessionController');
        } catch {}
      }
    }
    if (target && typeof target.prompt === 'function' && !(target.prompt as any).__dsh_napcat_guarded) {
      const originalPrompt = target.prompt.bind(target);
      const guardedPrompt = async (request: any) => {
        const sid = request?.sessionId;
        if (sid && (this.activeHandles.has(sid) || (this.isQQSession(sid) && this.isSessionBusy(sid)))) {
          throw new RemoteError(
            'session/agent-busy',
            '⚠️ 该会话当前正由 QQ 独占使用中，Web 端处于只读监视模式。请在 QQ 端发送消息。',
            { reason: 'EXCLUSIVE_QQ_SESSION', sessionId: sid }
          );
        }
        return originalPrompt(request);
      };
      (guardedPrompt as any).__dsh_napcat_guarded = true;
      (guardedPrompt as any).__originalPrompt = originalPrompt;
      target.prompt = guardedPrompt;
    }
  }

  hasActiveHandle(sessionId: string): boolean {
    return this.activeHandles.has(sessionId);
  }

  getActiveHandle(sessionId: string): AgentHandle | undefined {
    return this.activeHandles.get(sessionId);
  }

  async releaseActiveHandle(sessionId: string): Promise<void> {
    const handle = this.activeHandles.get(sessionId);
    if (handle) {
      this.activeHandles.delete(sessionId);
      if (typeof handle.dispose === 'function') {
        await Promise.resolve(handle.dispose()).catch(() => {});
      }
    }
  }

  markSessionBusy(sessionId: string, busy: boolean): void {
    if (busy) {
      this.busySessions.add(sessionId);
    } else {
      this.busySessions.delete(sessionId);
    }
  }

  isSessionBusy(sessionId: string): boolean {
    return this.busySessions.has(sessionId);
  }

  public getDshHome(): string {
    return this.dshHome;
  }

  private loadStateFromDb(): void {
    if (!this.db) return;
    try {
      const rawDefault = this.db.getPluginConfig?.('napcat_default_model');
      if (rawDefault) {
        try {
          this.napcatDefaultModel = JSON.parse(rawDefault);
        } catch {}
      }

      const records = this.db.getAllSessionStates();
      for (const rec of records) {
        if (rec.peer && rec.current_session_id) {
          this.peerCurrentSessionId.set(rec.peer, rec.current_session_id);
          this.clearedVersions.set(rec.peer, {
            round: rec.cleared_round ?? 0,
            version: rec.cleared_version ?? 1,
          });
          if (rec.model_provider && rec.model_name) {
            this.selectionMap.set(rec.current_session_id, {
              current: {
                provider: rec.model_provider,
                model: rec.model_name,
                ...(rec.model_reasoning_effort ? { reasoningEffort: rec.model_reasoning_effort as any } : {}),
              },
              assembled: undefined,
            });
          }
        }
      }
    } catch {}
  }

  /**
   * 获取 DSH 宿主全局默认模型 (跟随 agentDefaultModel)
   */
  getHostDefaultModelSelection(): ModelSelection {
    const defaultModelSvc =
      this.ctx.get('agentDefaultModel') || (this.ctx as any).agentDefaultModel;
    if (defaultModelSvc && typeof defaultModelSvc.currentSelection === 'function') {
      try {
        const sel = defaultModelSvc.currentSelection();
        if (sel?.provider && sel?.model) {
          return {
            provider: sel.provider,
            model: sel.model,
            ...(sel.reasoningEffort ? { reasoningEffort: sel.reasoningEffort } : {}),
          };
        }
      } catch {}
    }

    const llm = this.ctx.get('llm') || (this.ctx as any).llm;
    if (llm && typeof llm.listProviders === 'function') {
      try {
        const providers = llm.listProviders();
        if (providers.length > 0) {
          const p = providers[0];
          const models = llm.listModels(p.id || p);
          if (models.length > 0) {
            return { provider: p.id || p, model: models[0]?.id || models[0] };
          }
        }
      } catch {}
    }

    return {
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      reasoningEffort: 'high' as any,
    };
  }

  /**
   * 动态解析指定模型的默认思考档位 (若模型不支持思考则返回 undefined)
   */
  async resolveDefaultEffort(provider: string, model: string): Promise<string | undefined> {
    const llm = this.ctx.get('llm') || (this.ctx as any).llm;
    if (llm && typeof llm.resolveModelInfo === 'function') {
      try {
        const info = await llm.resolveModelInfo(provider, model);
        if (info && info.reasoning && Array.isArray(info.reasoning.efforts) && info.reasoning.efforts.length > 0) {
          return info.reasoning.defaultEffort
            ? String(info.reasoning.defaultEffort)
            : String(info.reasoning.efforts[0]?.id);
        } else if (info && info.reasoning === undefined) {
          return undefined;
        }
      } catch {}
    }
    if (provider === 'deepseek-official') {
      return 'high';
    }
    return undefined;
  }

  /**
   * 获取 NapCat 插件全局默认模型 (优先使用插件配置，否则回退到宿主默认)
   */
  getNapcatDefaultModel(): ModelSelection {
    if (this.napcatDefaultModel?.provider && this.napcatDefaultModel?.model) {
      return { ...this.napcatDefaultModel };
    }
    return this.getHostDefaultModelSelection();
  }

  /**
   * 设置 NapCat 插件全局默认模型，并批量联动同步已知的所有 QQ 会话 (不修改宿主全局 settings)
   */
  setNapcatDefaultModel(
    provider: string,
    model: string,
    reasoningEffort?: any
  ): void {
    const sel: ModelSelection = {
      provider,
      model,
      ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    };
    this.napcatDefaultModel = sel;
    if (this.db) {
      this.db.setPluginConfig?.('napcat_default_model', JSON.stringify(sel));
    }

    // 1. 同步内存中所有已记录的会话 selection
    for (const sid of this.getAllQQSessionIds()) {
      const ref = this.getOrCreateSelectionRef(sid);
      ref.current = { ...sel };
    }

    // 2. 持久化至已知的所有 peer 数据库状态中
    if (this.db) {
      const allStates = this.db.getAllSessionStates?.() || [];
      for (const st of allStates) {
        st.model_provider = provider;
        st.model_name = model;
        st.model_reasoning_effort = reasoningEffort ?? undefined;
        this.db.saveSessionState(st);
      }
    }
  }

  /**
   * 获取所有已知/活跃的 QQ 会话 ID
   */
  getAllQQSessionIds(): string[] {
    const sids = new Set<string>();
    for (const sid of this.peerCurrentSessionId.values()) {
      sids.add(sid);
    }
    for (const sid of this.activeHandles.keys()) {
      sids.add(sid);
    }
    for (const sid of this.selectionMap.keys()) {
      sids.add(sid);
    }
    return Array.from(sids);
  }

  /**
   * 获取当前默认模型 (优先 NapCat 插件全局)
   */
  getDefaultModelSelection(): ModelSelection {
    return this.getNapcatDefaultModel();
  }

  getOrCreateSelectionRef(sessionId: string): ModelSelectionRef {
    let ref = this.selectionMap.get(sessionId);
    if (!ref) {
      ref = {
        current: this.getDefaultModelSelection(),
        assembled: undefined,
      };
      this.selectionMap.set(sessionId, ref);
    }
    return ref;
  }

  setModelSelection(
    sessionId: string,
    provider: string,
    model: string,
    reasoningEffort?: any,
    persistDb = true
  ): void {
    const ref = this.getOrCreateSelectionRef(sessionId);
    ref.current = {
      provider,
      model,
      ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    };

    if (persistDb && this.db) {
      const peer = this.sessionIdToPeer(sessionId);
      let state = this.db.getSessionState(peer);
      if (!state) {
        state = {
          peer,
          current_session_id: sessionId,
          cleared_round: 0,
          cleared_version: 1,
          updated_at: Date.now(),
        };
      }
      state.model_provider = provider;
      state.model_name = model;
      state.model_reasoning_effort = reasoningEffort ?? undefined;
      this.db.saveSessionState(state);
    }
  }

  getModelSelection(sessionId: string): ModelSelection | undefined {
    const ref = this.getOrCreateSelectionRef(sessionId);
    return ref.current;
  }

  /**
   * 判断指定 SessionId 是否已被 DSH Web UI / workspaceRegistry 归档
   */
  isSessionArchived(sessionId: string): boolean {
    const wsRegistry = this.ctx.get('workspaceRegistry') || (this.ctx as any).workspaceRegistry;
    if (wsRegistry?.archivedSessionIds && Array.isArray(wsRegistry.archivedSessionIds)) {
      return wsRegistry.archivedSessionIds.includes(sessionId as any);
    }
    return false;
  }

  /**
   * 检查指定 Session 是否在内存或物理磁盘中有效存在
   */
  isSessionPhysicallyPresent(sessionId: string): boolean {
    if (this.activeHandles.has(sessionId)) return true;
    const live = (this.ctx.get('sessions') || (this.ctx as any).sessions)?.get?.(sessionId);
    if (live) return true;

    const persistence = this.ctx.get('sessionPersistence') || (this.ctx as any).sessionPersistence;
    if (persistence && typeof (persistence as any).locate === 'function') {
      try {
        const loc = (persistence as any).locate({ id: sessionId, cwd: this.resolveCwd() });
        if (loc?.path) {
          if (fs.existsSync(loc.path) || fs.existsSync(path.dirname(loc.path))) {
            return true;
          }
        }
      } catch {}
    }

    // 文件系统直接探测：支持 V3 encodeSegment 目录编码与 V3/V2/旧版会话文件名
    const encodedId = encodeSegment(sessionId);
    const sessionFileCandidates = [
      'session.v3.jsonl',
      'session.v3.jsonl.zstd',
      'session.v2.jsonl',
      'session.v2.jsonl.zstd',
      'session.jsonl',
      'session.jsonl.zstd',
    ];

    const checkRoots = [
      path.join(this.dshHome, 'sessions'),
      path.join(os.homedir(), '.dsh', 'sessions'),
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
                    if (hasLog || files.length === 0) return true;
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
   * 异步精确检查物理会话状态（优先利用 DSH 0.1.5 sessionPersistence.stat API）
   */
  async isSessionPhysicallyPresentAsync(sessionId: string): Promise<boolean> {
    if (this.activeHandles.has(sessionId)) return true;
    const live = (this.ctx.get('sessions') || (this.ctx as any).sessions)?.get?.(sessionId);
    if (live) return true;

    const persistence = this.ctx.get('sessionPersistence') || (this.ctx as any).sessionPersistence;
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

  /**
   * 将 QQ Peer 转换为当前活跃的 DSH SessionId（智能寻址算法：最高未归档版本优先，全量归档自动开启新轮次）
   */
  peerToSessionId(peer: string): string {
    if (peer.startsWith('qq-group-') || peer.startsWith('qq-user-')) {
      if (!this.isSessionArchived(peer)) {
        return peer;
      }
      // 如果传入的已是旧的带版本号/不带版本号的 SessionId，且已被归档，转为 peer 再重算
      peer = this.sessionIdToPeer(peer);
    }

    const cached = this.peerCurrentSessionId.get(peer);
    if (cached) {
      if (!this.isSessionArchived(cached) && this.isSessionPhysicallyPresent(cached)) {
        return cached;
      }
      this.peerCurrentSessionId.delete(peer);
    }

    let baseId: string;
    if (peer.startsWith('group_')) {
      baseId = `qq-group-${peer.slice(6)}`;
    } else if (peer.startsWith('user_')) {
      baseId = `qq-user-${peer.slice(5)}`;
    } else {
      baseId = `qq-${peer}`;
    }

    // 1. 扫描当前工作区已登记的所有该 peer 的会话历史
    const known = new Map<string, { round: number; version: number }>();
    const wsRegistry = this.ctx.get('workspaceRegistry') || (this.ctx as any).workspaceRegistry;
    if (wsRegistry?.headers && typeof wsRegistry.headers.keys === 'function') {
      for (const rawSid of Array.from(wsRegistry.headers.keys())) {
        const sid = String(rawSid);
        const parsed = parseSessionId(sid);
        if (parsed) {
          const expectedBase = parsed.isGroup ? `qq-group-${parsed.id}` : `qq-user-${parsed.id}`;
          if (expectedBase === baseId) {
            if (this.isSessionPhysicallyPresent(sid)) {
              known.set(sid, { round: parsed.round, version: parsed.version });
            } else {
              try {
                wsRegistry.headers.delete(sid);
                wsRegistry.sessionPaths?.delete?.(sid);
                wsRegistry.invalidSessionPaths?.delete?.(sid);
              } catch {}
            }
          }
        }
      }
    }

    // 同时补充来自 db 的记录，并校验物理存在性
    const dbRecord = this.db?.getSessionState(peer);
    if (dbRecord?.current_session_id) {
      const parsed = parseSessionId(dbRecord.current_session_id);
      if (parsed) {
        if (this.isSessionPhysicallyPresent(dbRecord.current_session_id)) {
          known.set(dbRecord.current_session_id, { round: parsed.round, version: parsed.version });
        } else {
          // 物理不存在：清除 DB 记录与内存记录
          this.db?.saveSessionState({
            ...dbRecord,
            current_session_id: '',
            cleared_round: 0,
            cleared_version: 1,
            updated_at: Date.now(),
          });
          this.peerCurrentSessionId.delete(peer);
          if (known.size === 0) {
            this.clearedVersions.delete(peer);
          }
        }
      }
    }

    // 2. 统计已归档与未归档会话
    const unarchived: Array<{ sid: string; round: number; version: number }> = [];
    let maxKnownRound = 0;
    for (const [sid, info] of known.entries()) {
      if (info.round > maxKnownRound) {
        maxKnownRound = info.round;
      }
      if (!this.isSessionArchived(sid)) {
        unarchived.push({ sid, ...info });
      }
    }

    let targetSessionId: string;
    let targetRound = 0;
    let targetVersion = 1;

    const cleared = this.clearedVersions.get(peer);

    if (known.size === 0) {
      // 分支 1: 此前没有任何会话历史（首次进入）
      targetRound = cleared?.round ?? 0;
      targetVersion = cleared?.version ?? 1;
      targetSessionId = buildSessionId(baseId, targetRound, targetVersion);
    } else if (unarchived.length === 0) {
      // 分支 2: 所有已存在历史会话均已被 Web UI 归档（视为全量删除），开启全新一轮 #1 (maxKnownRound + 1)
      const nextRound = maxKnownRound + 1;
      targetRound = nextRound;
      targetVersion = 1;
      targetSessionId = buildSessionId(baseId, targetRound, targetVersion);
    } else {
      // 分支 3: 存在未归档会话，选取最大轮次中版本号最高的活跃会话 (Highest Active Version)
      unarchived.sort((a, b) => b.round - a.round || b.version - a.version);
      const highest = unarchived[0];

      if (cleared && cleared.round === highest.round && cleared.version > highest.version) {
        targetRound = cleared.round;
        targetVersion = cleared.version;
        targetSessionId = buildSessionId(baseId, targetRound, targetVersion);
      } else {
        targetRound = highest.round;
        targetVersion = highest.version;
        targetSessionId = highest.sid;
      }
    }

    this.peerCurrentSessionId.set(peer, targetSessionId);
    this.clearedVersions.set(peer, { round: targetRound, version: targetVersion });
    if (this.db) {
      const existing = this.db.getSessionState(peer);
      this.db.saveSessionState({
        peer,
        current_session_id: targetSessionId,
        cleared_round: targetRound,
        cleared_version: targetVersion,
        updated_at: Date.now(),
        model_provider: existing?.model_provider,
        model_name: existing?.model_name,
        model_reasoning_effort: existing?.model_reasoning_effort,
      });
    }

    return targetSessionId;
  }

  /**
   * /clear 命令语义：为该 peer 开启一个全新的会话版本（原会话保留、不归档）。
   */
  markSessionCleared(peerOrSessionId: string): string {
    const peer = this.sessionIdToPeer(peerOrSessionId);
    const currentSid = this.peerCurrentSessionId.get(peer) || (peerOrSessionId.startsWith('qq-') ? peerOrSessionId : undefined);
    const parsed = currentSid ? parseSessionId(currentSid) : null;

    let round = 0;
    let version = 1;
    if (parsed) {
      round = parsed.round;
      version = parsed.version;
    } else {
      const existingCleared = this.clearedVersions.get(peer);
      if (existingCleared) {
        round = existingCleared.round;
        version = existingCleared.version;
      }
    }

    const nextVersion = version + 1;
    this.clearedVersions.set(peer, { round, version: nextVersion });
    this.peerCurrentSessionId.delete(peer);

    let baseId: string;
    if (peer.startsWith('group_')) {
      baseId = `qq-group-${peer.slice(6)}`;
    } else if (peer.startsWith('user_')) {
      baseId = `qq-user-${peer.slice(5)}`;
    } else {
      baseId = `qq-${peer}`;
    }
    const nextSessionId = buildSessionId(baseId, round, nextVersion);

    // 关键：继承前序会话的模型与思考深度，避免新建会话/清空会话后丢失思考配置
    const prevSel = currentSid ? this.selectionMap.get(currentSid)?.current : undefined;
    const dbPrev = this.db?.getSessionState(peer);
    const defaultSel = this.getDefaultModelSelection();
    const inheritedProvider = prevSel?.provider || dbPrev?.model_provider || defaultSel.provider;
    const inheritedModel = prevSel?.model || dbPrev?.model_name || defaultSel.model;
    const inheritedEffort =
      prevSel?.reasoningEffort ?? dbPrev?.model_reasoning_effort ?? defaultSel.reasoningEffort;

    this.selectionMap.set(nextSessionId, {
      current: {
        provider: inheritedProvider,
        model: inheritedModel,
        ...(inheritedEffort !== undefined ? { reasoningEffort: inheritedEffort as any } : {}),
      },
      assembled: undefined,
    });

    if (this.db) {
      this.db.saveSessionState({
        peer,
        current_session_id: nextSessionId,
        cleared_round: round,
        cleared_version: nextVersion,
        updated_at: Date.now(),
        model_provider: inheritedProvider,
        model_name: inheritedModel,
        model_reasoning_effort: inheritedEffort,
      });
    }

    return peer;
  }

  /**
   * 将 DSH SessionId 反向解析为 QQ Peer（支持自动剥离版本/轮次后缀）
   */
  sessionIdToPeer(sessionId: string): string {
    const parsed = parseSessionId(sessionId);
    if (parsed) {
      return parsed.peer;
    }
    if (sessionId.startsWith('group_') || sessionId.startsWith('user_')) {
      return sessionId;
    }
    return sessionId;
  }

  /**
   * 列出 peer 的所有历史会话（来自 wsRegistry.headers，parseSessionId 匹配同 base）
   * 按 (round, version) 升序返回（旧→新）
   */
  listPeerSessionIds(peer: string): string[] {
    let baseId: string;
    if (peer.startsWith('group_')) {
      baseId = `qq-group-${peer.slice(6)}`;
    } else if (peer.startsWith('user_')) {
      baseId = `qq-user-${peer.slice(5)}`;
    } else {
      baseId = `qq-${peer}`;
    }

    const known = new Map<string, { round: number; version: number }>();
    const wsRegistry = this.ctx.get('workspaceRegistry') || (this.ctx as any).workspaceRegistry;
    if (wsRegistry?.headers && typeof wsRegistry.headers.keys === 'function') {
      for (const rawSid of Array.from(wsRegistry.headers.keys())) {
        const sid = String(rawSid);
        const parsed = parseSessionId(sid);
        if (parsed) {
          const expectedBase = parsed.isGroup ? `qq-group-${parsed.id}` : `qq-user-${parsed.id}`;
          if (expectedBase === baseId) {
            if (this.isSessionPhysicallyPresent(sid) && !this.isSessionArchived(sid)) {
              known.set(sid, { round: parsed.round, version: parsed.version });
            }
          }
        }
      }
    }

    // 同时补充来自 db 的记录
    const dbRecord = this.db?.getSessionState(peer);
    if (dbRecord?.current_session_id) {
      const parsed = parseSessionId(dbRecord.current_session_id);
      if (parsed) {
        if (
          this.isSessionPhysicallyPresent(dbRecord.current_session_id) &&
          !this.isSessionArchived(dbRecord.current_session_id)
        ) {
          known.set(dbRecord.current_session_id, { round: parsed.round, version: parsed.version });
        }
      }
    }

    // 同时补充来自 peerCurrentSessionId 的记录
    const curSid = this.peerCurrentSessionId.get(peer);
    if (curSid) {
      const parsed = parseSessionId(curSid);
      if (parsed) {
        if (this.isSessionPhysicallyPresent(curSid) && !this.isSessionArchived(curSid)) {
          known.set(curSid, { round: parsed.round, version: parsed.version });
        }
      }
    }

    // 内存中活动的 sessions
    const sessionsSvc = this.ctx.get('sessions') || (this.ctx as any).sessions;
    if (sessionsSvc) {
      if (typeof sessionsSvc.list === 'function') {
        try {
          const liveList = sessionsSvc.list() || [];
          for (const s of liveList) {
            const sid = s?.id ? String(s.id) : '';
            if (!sid) continue;
            const parsed = parseSessionId(sid);
            if (parsed) {
              const expectedBase = parsed.isGroup ? `qq-group-${parsed.id}` : `qq-user-${parsed.id}`;
              if (expectedBase === baseId) {
                if (this.isSessionPhysicallyPresent(sid) && !this.isSessionArchived(sid)) {
                  known.set(sid, { round: parsed.round, version: parsed.version });
                }
              }
            }
          }
        } catch {}
      }
      if (sessionsSvc.store && typeof sessionsSvc.store.keys === 'function') {
        try {
          for (const rawSid of Array.from(sessionsSvc.store.keys())) {
            const sid = String(rawSid);
            const parsed = parseSessionId(sid);
            if (parsed) {
              const expectedBase = parsed.isGroup ? `qq-group-${parsed.id}` : `qq-user-${parsed.id}`;
              if (expectedBase === baseId) {
                if (this.isSessionPhysicallyPresent(sid) && !this.isSessionArchived(sid)) {
                  known.set(sid, { round: parsed.round, version: parsed.version });
                }
              }
            }
          }
        } catch {}
      }
    }

    // selectionMap 中跟踪的会话
    for (const sid of this.selectionMap.keys()) {
      const parsed = parseSessionId(sid);
      if (parsed) {
        const expectedBase = parsed.isGroup ? `qq-group-${parsed.id}` : `qq-user-${parsed.id}`;
        if (expectedBase === baseId) {
          if (this.isSessionPhysicallyPresent(sid) && !this.isSessionArchived(sid)) {
            known.set(sid, { round: parsed.round, version: parsed.version });
          }
        }
      }
    }

    const list = Array.from(known.entries()).map(([sid, info]) => ({ sid, ...info }));
    list.sort((a, b) => a.round - b.round || a.version - b.version);
    return list.map((item) => item.sid);
  }

  /**
   * 切换 peer 当前活跃会话到指定 sid
   * 前置校验：物理存在 且 未归档；通过则写 peerCurrentSessionId + clearedVersions + db
   */
  resumeSession(peer: string, sessionId: string): boolean {
    if (!this.isSessionPhysicallyPresent(sessionId) || this.isSessionArchived(sessionId)) {
      return false;
    }

    const parsed = parseSessionId(sessionId);
    if (!parsed) {
      return false;
    }

    let baseId: string;
    if (peer.startsWith('group_')) {
      baseId = `qq-group-${peer.slice(6)}`;
    } else if (peer.startsWith('user_')) {
      baseId = `qq-user-${peer.slice(5)}`;
    } else {
      baseId = `qq-${peer}`;
    }
    const expectedBase = parsed.isGroup ? `qq-group-${parsed.id}` : `qq-user-${parsed.id}`;
    if (expectedBase !== baseId) {
      return false;
    }

    this.peerCurrentSessionId.set(peer, sessionId);
    this.clearedVersions.set(peer, { round: parsed.round, version: parsed.version });
    if (this.db) {
      const existing = this.db.getSessionState(peer);
      this.db.saveSessionState({
        peer,
        current_session_id: sessionId,
        cleared_round: parsed.round,
        cleared_version: parsed.version,
        updated_at: Date.now(),
        model_provider: existing?.model_provider,
        model_name: existing?.model_name,
        model_reasoning_effort: existing?.model_reasoning_effort,
      });
    }

    return true;
  }

  private peerNames = new Map<string, string>();

  setPeerName(peer: string, name: string): void {
    if (name && typeof name === 'string' && name.trim()) {
      this.peerNames.set(peer, name.trim());
    }
  }

  getPeerName(peer: string): string | undefined {
    return this.peerNames.get(peer);
  }

  isQQSession(sessionId: string): boolean {
    return sessionId.startsWith('qq-group-') || sessionId.startsWith('qq-user-') || sessionId.startsWith('qq-');
  }

  resolveCwd(_peerOrSessionId?: string): string {
    return resolveDshPath(this.dshHome, undefined, DEFAULT_WORKSPACE_ROOT);
  }

  getAgent(peerOrSessionId: string): Agent | undefined {
    const sessionId = this.peerToSessionId(peerOrSessionId);
    const agents = this.ctx.get('agents') || (this.ctx as any).agents;
    return agents?.get(sessionId as any);
  }

  async registerWorkspace(cwd: string, sessionId?: string, title = 'NapCat'): Promise<void> {
    const wsRegistry = this.ctx.get('workspaceRegistry') || (this.ctx as any).workspaceRegistry;
    if (!wsRegistry || typeof wsRegistry.create !== 'function') return;
    try {
      const resolvedCwd = resolveDshPath(this.dshHome, cwd, DEFAULT_WORKSPACE_ROOT);
      await fsp.mkdir(resolvedCwd, { recursive: true });
      const ws = await wsRegistry.create(resolvedCwd, title);
      if (ws && sessionId && typeof ws.attachSession === 'function') {
        await ws.attachSession(sessionId).catch(() => {});
      }
    } catch (err) {
      this.ctx.logger?.('dsh-napcat-bridge')?.warn?.(`[SessionManager] 注册工作区 ${cwd} 失败:`, err);
    }
  }

  updateSessionTitle(session: any, peer: string, sessionId: string, name?: string): void {
    if (!session) return;
    if (name) {
      this.setPeerName(peer, name);
    }
    const currentName = name || this.getPeerName(peer);
    const title = formatSessionTitle(peer, sessionId, currentName);
    const sessionTitleSvc = this.ctx.get('sessionTitle') || (this.ctx as any).sessionTitle;
    if (sessionTitleSvc && typeof sessionTitleSvc.rename === 'function') {
      try {
        sessionTitleSvc.rename(session, title);
      } catch (err: any) {
        this.ctx.logger?.('dsh-napcat-bridge')?.debug?.(
          `[SessionManager] 锁定会话标题 ${sessionId} 失败:`,
          err?.message
        );
      }
    }
  }

  async getOrCreateAgent(peerOrSessionId: string): Promise<Agent> {
    let sessionId = this.peerToSessionId(peerOrSessionId);
    const peer = this.sessionIdToPeer(peerOrSessionId);

    // 二次确认：若当前 sessionId 在运行时被归档，则立即换新 session
    if (this.isSessionArchived(sessionId)) {
      this.peerCurrentSessionId.delete(peer);
      sessionId = this.peerToSessionId(peer);
    }

    const selectionRef = this.getOrCreateSelectionRef(sessionId);
    const agents = this.ctx.get('agents') || (this.ctx as any).agents;

    // 1. 若当前会话已由 QQ 自身持有专属写句柄，直接复用
    if (this.activeHandles.has(sessionId)) {
      const handle = this.activeHandles.get(sessionId)!;
      if (!this.isSessionArchived(sessionId)) {
        (handle.agent as any).modelSelection = selectionRef;
        this.updateSessionTitle((handle.agent as any).session, peer, sessionId);
        return handle.agent;
      }
      this.activeHandles.delete(sessionId);
      if (typeof handle.dispose === 'function') {
        await Promise.resolve(handle.dispose()).catch(() => {});
      }
    }

    // 2. 检测内存中已存在的 agent
    const existingAgent = agents?.get?.(sessionId as any);
    if (existingAgent && !this.isSessionArchived(sessionId)) {
      // QQ 优先抢占：若在途生成中，优先取消生成
      try {
        existingAgent.cancel?.({ kind: 'user-request' } as any);
      } catch {
        try {
          (existingAgent as any).cancel?.('user-request');
        } catch {}
      }

      // 若测试桩或外部显式绑定了 handle.dispose，配合抢占释放句柄
      if (typeof (existingAgent as any).handle?.dispose === 'function') {
        try {
          await (existingAgent as any).handle.dispose();
        } catch {}
        const sessions = this.ctx.get?.('sessions') || (this.ctx as any).sessions;
        if (sessions && typeof sessions.detachEntered === 'function') {
          try {
            const live = sessions.get?.(sessionId);
            if (live) {
              const entry = typeof sessions.liveEntryFor === 'function' ? sessions.liveEntryFor(live) : live;
              await sessions.detachEntered(entry).catch(() => {});
            }
          } catch {}
        }
        await new Promise((res) => setTimeout(res, 150));
      } else {
        (existingAgent as any).modelSelection = selectionRef;
        this.updateSessionTitle((existingAgent as any).session, peer, sessionId);
        return existingAgent;
      }
    }

    const cwd = this.resolveCwd(sessionId);
    await fsp.mkdir(cwd, { recursive: true });

    const defaultSel = this.getDefaultModelSelection();
    const provider = selectionRef.current?.provider || defaultSel.provider;
    const model = selectionRef.current?.model || defaultSel.model;

    // 关键修复：确保 reasoningEffort 明确解析，防止 undefined 导致 DSH installModelSelection 清空思考档位
    let effort: any = selectionRef.current?.reasoningEffort || defaultSel.reasoningEffort;
    if (effort === undefined) {
      effort = await this.resolveDefaultEffort(provider, model);
    }
    if (effort !== undefined) {
      selectionRef.current = {
        provider,
        model,
        reasoningEffort: effort,
      };
      if (this.db) {
        let state = this.db.getSessionState(peer);
        if (!state) {
          state = {
            peer,
            current_session_id: sessionId,
            cleared_round: 0,
            cleared_version: 1,
            updated_at: Date.now(),
          };
        }
        if (!state.model_reasoning_effort) {
          state.model_provider = provider;
          state.model_name = model;
          state.model_reasoning_effort = effort;
          this.db.saveSessionState(state);
        }
      }
    }

    const setupFn = (agentCtx: any) => {
      if (typeof agentCtx?.on === 'function') {
        installModelSelection(agentCtx, selectionRef);
      }
      const presets: any =
        agentCtx?.get?.('agentPresets') || (this.ctx as any).agentPresets;
      if (presets?.mount) {
        return presets
          .mount(agentCtx)
          .then(() => undefined)
          .catch((err: any) => {
            this.ctx.logger?.('dsh-napcat-bridge')?.debug?.(
              '[SessionManager] mount preset:',
              err?.message
            );
            return undefined;
          });
      }
      return undefined;
    };

    let handle: AgentHandle | undefined;
    let isSessionLocked = false;

    // 3. 若该会话此前已持久化在磁盘上，优先通过 agents.resume 恢复会话（带锁冲突重试与抢占保护）
    if (typeof agents?.resume === 'function') {
      const delays = this.options?.retryDelays || [300, 600, 900];
      const maxRetries = delays.length;
      for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
          handle = await agents.resume({
            resumeSessionId: sessionId as any,
            agentOptions: {
              provider,
              model,
              ...(effort !== undefined ? { reasoningEffort: effort } : {}),
            },
            setup: setupFn,
          });
          break;
        } catch (err: any) {
          const isOwnedError =
            err?.name === 'SessionAlreadyOwnedError' ||
            err?.constructor?.name === 'SessionAlreadyOwnedError' ||
            (typeof err?.message === 'string' &&
              (err.message.includes('SessionAlreadyOwnedError') ||
               err.message.includes('already has a live persistence owner') ||
               err.message.includes('while it is live') ||
               err.message.includes('already owned')));

          if (isOwnedError) {
            isSessionLocked = true;
            this.ctx.logger?.('dsh-napcat-bridge')?.warn?.(
              `[SessionManager] 会话 ${sessionId} 正在被其他进程或控制台占用 (SessionAlreadyOwnedError)，正在进行第 ${attempt + 1}/${maxRetries} 次重试...`
            );

            // 再次尝试抢占并关闭可能占用的非 QQ 写句柄
            const occAgent = agents?.get?.(sessionId as any);
            if (occAgent && !this.activeHandles.has(sessionId)) {
              try {
                occAgent.cancel?.({ kind: 'user-request' } as any);
              } catch {
                try { (occAgent as any).cancel?.('user-request'); } catch {}
              }
              try {
                if (typeof (occAgent as any).handle?.dispose === 'function') {
                  await (occAgent as any).handle.dispose();
                } else if (typeof (occAgent as any).dispose === 'function') {
                  await (occAgent as any).dispose();
                } else if (typeof (occAgent as any).ctx?.scope?.dispose === 'function') {
                  await (occAgent as any).ctx.scope.dispose();
                }
              } catch {}
            }

            if (attempt < maxRetries - 1) {
              await new Promise((res) => setTimeout(res, delays[attempt]));
              continue;
            }
            // 重试耗尽，严禁进入 agents.create，抛出明确错误
            throw new SessionAlreadyOwnedError(
              sessionId,
              `会话 ${sessionId} 当前正被其他控制台或任务占用（排他锁冲突），请稍后重试或在 Web 端切换其他会话以释放锁。`
            );
          }

          this.ctx.logger?.('dsh-napcat-bridge')?.debug?.(
            `[SessionManager] Resume session ${sessionId} 未命中或异常:`,
            err?.message
          );
          break;
        }
      }
    }

    // 4. 若磁盘无历史记录或未恢复（且绝非持锁冲突状态），则创建全新的 session
    if (!handle && !isSessionLocked) {
      if (typeof agents?.create !== 'function') {
        throw new Error('agents.create is not available');
      }
      handle = await agents.create({
        sessionId: sessionId as any,
        agentOptions: {
          provider,
          model,
          ...(effort !== undefined ? { reasoningEffort: effort } : {}),
        },
        meta: { cwd },
        setup: setupFn,
      });
    }

    if (!handle) {
      throw new Error(`Failed to create or resume agent for session ${sessionId}`);
    }

    this.activeHandles.set(sessionId, handle);

    // 自动在 DSH workspaceRegistry 中登记单一 NapCat 顶级工作区并关联活跃会话
    await this.registerWorkspace(cwd, sessionId, 'NapCat');

    // 锁定会话标题，防止 LLM 自动总结覆盖
    this.updateSessionTitle(handle.agent.session, peer, sessionId);

    (handle.agent as any).modelSelection = selectionRef;
    return handle.agent;
  }

  formatWakeupPrompt(payload: WakeupPayload): string {
    return formatWakeupPrompt(payload);
  }

  async dispatchWakeup(
    payload: WakeupPayload,
    options?: {
      onMessageCreated?: (userMsg: any) => void;
    }
  ): Promise<any> {
    const isNoMessageWakeup =
      payload.trigger === 'poke' ||
      (payload.trigger === 'proactive' && payload.sub_trigger === 'idle') ||
      (!(payload as any).msg_id && !payload.from_user);

    if (isNoMessageWakeup && this.outboundBridge) {
      const isGroup = payload.peer.startsWith('group_') || payload.peer.startsWith('qq-group-');
      this.outboundBridge.trackInboundContext(payload.peer, {
        msg_id: undefined,
        from_user: '',
        is_group: isGroup,
        trigger: payload.trigger === 'poke' ? 'poke' : 'idle',
      });
    }

    const agent = await this.getOrCreateAgent(payload.peer);
    const sessionId = this.peerToSessionId(payload.peer);

    // 若唤醒消息携带发送者昵称，更新私聊会话标题锁定
    if (payload.from_name) {
      if (payload.peer.startsWith('user_') || payload.peer.startsWith('qq-user-')) {
        this.updateSessionTitle((agent as any).session, payload.peer, sessionId, payload.from_name);
      }
    }

    const promptText = this.formatWakeupPrompt(payload);

    const userMsg = createUserMessage({
      content: [{ type: 'text', text: promptText }],
      source: { kind: 'user' },
    });

    if (isNoMessageWakeup && this.outboundBridge && userMsg?.id) {
      const isGroup = payload.peer.startsWith('group_') || payload.peer.startsWith('qq-group-');
      this.outboundBridge.trackPendingMessage?.(userMsg.id, payload.peer, {
        msg_id: undefined,
        from_user: '',
        is_group: isGroup,
        trigger: payload.trigger === 'poke' ? 'poke' : 'idle',
      });
    }

    this.markSessionBusy(sessionId, true);
    try {
      options?.onMessageCreated?.(userMsg);
      agent.followup(userMsg);
      return userMsg;
    } finally {
      this.markSessionBusy(sessionId, false);
    }
  }

  async dispose(): Promise<void> {
    const sc = this.ctx.get?.('sessionController') || (this.ctx as any).sessionController;
    if (sc && (sc.prompt as any)?.__dsh_napcat_guarded) {
      sc.prompt = (sc.prompt as any).__originalPrompt;
    }
    for (const [id, handle] of this.activeHandles.entries()) {
      try {
        await handle.dispose();
      } catch (err) {
        this.ctx.logger?.('dsh-napcat-bridge')?.warn?.(`[SessionManager] 销毁 Agent ${id} 失败:`, err);
      }
    }
    this.activeHandles.clear();
    this.peerCurrentSessionId.clear();
    this.peerNames.clear();
    this.busySessions.clear();
  }
}

/**
 * 根据 peer、sessionId 与群名/昵称格式化会话标题 (支持多轮归档格式如 #1 (1))
 */
export function formatSessionTitle(
  peer: string,
  sessionId: string,
  name?: string
): string {
  let versionNum = '1';
  let roundNum = 0;
  const parsed = parseSessionId(sessionId);
  if (parsed) {
    versionNum = String(parsed.version);
    roundNum = parsed.round;
  }

  const tag = roundNum > 0 ? `#${versionNum} (${roundNum})` : `#${versionNum}`;

  if (peer.startsWith('group_') || peer.startsWith('qq-group-')) {
    const groupId = peer.replace(/^(group_|qq-group-)/, '').split('-')[0];
    const displayName = name ? `${name} ` : '';
    return `群聊: ${displayName}${groupId} ${tag}`;
  } else if (peer.startsWith('user_') || peer.startsWith('qq-user-')) {
    const userId = peer.replace(/^(user_|qq-user-)/, '').split('-')[0];
    const displayName = name ? `${name} ` : '';
    return `私聊: ${displayName}${userId} ${tag}`;
  } else {
    const displayName = name ? `${name} ` : '';
    return `QQ: ${displayName}${peer} ${tag}`;
  }
}

/**
 * 组装发给 Agent 的唤醒文本 (Wakeup Prompt)
 * 格式与存储层 / 历史记录检索格式对齐，包含本地化时间戳 [YYYY-MM-DD HH:mm:ss]
 */
export function formatWakeupPrompt(payload: WakeupPayload): string {
  const isGroup = payload.peer.startsWith('group_') || payload.peer.startsWith('qq-group-');
  const groupId = isGroup
    ? payload.peer.replace(/^(group_|qq-group-)/, '').split('-')[0]
    : undefined;
  const fromUser = payload.from_user || (payload as any).userId || '';
  const fromName = payload.from_name || (payload as any).senderName || '';

  const senderStr = fromName
    ? `${fromName} (QQ: ${fromUser})`
    : fromUser
      ? `QQ: ${fromUser}`
      : '未知用户';

  const timeStr = payload.timestamp
    ? formatDateTime(payload.timestamp)
    : formatDateTime(Date.now());

  const channelStr = isGroup ? `[QQ群聊: ${groupId}]` : `[QQ私聊]`;
  const headerTime = timeStr ? ` [${timeStr}]` : '';

  if (payload.trigger === 'poke') {
    return `${channelStr}${headerTime} 用户 ${senderStr} 戳了戳你。`;
  }

  if (payload.trigger === 'proactive' && payload.sub_trigger === 'idle') {
    return `${channelStr}${headerTime}\n（当前群聊已较长时间没有新发言，你正主动在群里发起一条消息。你需要先调用 read_chat_history 工具查询此前群内最近的消息记录以补充上下文再发言。切勿在回复中透露任何系统事件、潜水超时或定时任务等后台痕迹。）`;
  }

  if (payload.trigger === 'proactive') {
    let prompt = `${channelStr}${headerTime} 发送者: ${senderStr}\n`;
    prompt += `（你正在主动参与该群聊的交流。你需要先调用 read_chat_history 工具查询群内最近的消息记录以补充上下文再回复。不要在发言中透露任何系统提示或触发机制的痕迹。）\n`;
    if (payload.quoted) {
      let quotedSender = '';
      if (payload.quoted.from_name && payload.quoted.user_id) {
        quotedSender = `${payload.quoted.from_name} (QQ: ${payload.quoted.user_id})`;
      } else if (payload.quoted.from_name) {
        quotedSender = payload.quoted.from_name;
      } else if (payload.quoted.user_id) {
        quotedSender = `QQ: ${payload.quoted.user_id}`;
      } else if (payload.quoted.msg_id) {
        quotedSender = `消息ID: ${payload.quoted.msg_id}`;
      } else {
        quotedSender = '历史消息';
      }
      prompt += `[引用回复 ${quotedSender}${payload.quoted.text ? `: "${payload.quoted.text}"` : ''}]\n`;
    }
    prompt += payload.content;
    return prompt;
  }

  let prompt = `${channelStr}${headerTime} 发送者: ${senderStr}\n`;


  if (payload.quoted) {
    let quotedSender = '';
    if (payload.quoted.from_name && payload.quoted.user_id) {
      quotedSender = `${payload.quoted.from_name} (QQ: ${payload.quoted.user_id})`;
    } else if (payload.quoted.from_name) {
      quotedSender = payload.quoted.from_name;
    } else if (payload.quoted.user_id) {
      quotedSender = `QQ: ${payload.quoted.user_id}`;
    } else if (payload.quoted.msg_id) {
      quotedSender = `消息ID: ${payload.quoted.msg_id}`;
    } else {
      quotedSender = '历史消息';
    }
    prompt += `[引用回复 ${quotedSender}${payload.quoted.text ? `: "${payload.quoted.text}"` : ''}]\n`;
  }

  prompt += payload.content;
  return prompt;
}

