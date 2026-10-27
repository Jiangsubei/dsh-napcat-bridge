/**
 * dsh-napcat-bridge: Session 路由与 CWD 隔离映射模块 (Facade)
 * 组装子模块：IdResolver、WorkspaceManager、PersistenceManager、ModelSelector 与 AgentRunner。
 * 保持所有旧有导出与方法签名 100% 向后兼容。
 */

import type { Context } from '@deepseek-ai/cordis';
import type { Agent, AgentHandle, ModelSelection, ModelSelectionRef } from '@deepseek-ai/dsh-agent';
import type { MessageDatabase } from '../storage/database.js';
import type { WakeupPayload } from '../types/index.js';
import { encodeSegment } from '../utils/path.js';

// 导出所有下沉子模块中的类型与异常
export { RemoteError, SessionAlreadyOwnedError, type ParsedSessionId, type OutboundBridgeLike } from './session/types.js';
export {
  parseSessionId,
  generateSessionHash,
  findSmallestAvailableVersion,
  buildSessionId,
  formatSessionTitle,
  formatWakeupPrompt,
  isQQSession,
} from './session/id-resolver.js';
export { encodeSegment };

import {
  type OutboundBridgeLike,
  type SessionManagerOptions,
} from './session/types.js';
import {
  parseSessionId,
  generateSessionHash,
  findSmallestAvailableVersion,
  buildSessionId,
  formatWakeupPrompt,
  isQQSession,
  peerToBaseId,
  sessionIdToPeer,
} from './session/id-resolver.js';
import { SessionWorkspaceManager } from './session/workspace.js';
import { SessionPersistenceManager } from './session/persistence.js';
import { SessionModelSelector } from './session/model-selector.js';
import { SessionAgentRunner } from './session/agent-runner.js';

export class SessionManager {
  private peerCurrentSessionId = new Map<string, string>();
  private clearedVersions = new Map<string, { round: number; version: number }>();
  private pendingClearedSessionId = new Map<string, string>();
  private deletedSessionIds = new Set<string>();

  private readonly workspace: SessionWorkspaceManager;
  private readonly persistence: SessionPersistenceManager;
  private readonly modelSelector: SessionModelSelector;
  private readonly agentRunner: SessionAgentRunner;

  constructor(
    private readonly ctx: Context,
    dshHome?: string,
    private readonly db?: MessageDatabase,
    private readonly options?: SessionManagerOptions
  ) {
    this.workspace = new SessionWorkspaceManager(this.ctx, dshHome);
    this.persistence = new SessionPersistenceManager(this.db, this.ctx, this.workspace);
    this.modelSelector = new SessionModelSelector(this.ctx, this.persistence);

    this.agentRunner = new SessionAgentRunner(
      this.ctx,
      this.workspace,
      this.persistence,
      this.modelSelector,
      {
        peerToSessionId: (peer: string) => this.peerToSessionId(peer),
        sessionIdToPeer: (sessionId: string) => this.sessionIdToPeer(sessionId),
        onSessionReassigned: (peer: string, newSid: string) => {
          if (newSid) {
            this.peerCurrentSessionId.set(peer, newSid);
          } else {
            this.peerCurrentSessionId.delete(peer);
          }
        },
        onClearPendingCleared: (peer: string, sid: string) => {
          if (this.pendingClearedSessionId.get(peer) === sid) {
            this.pendingClearedSessionId.delete(peer);
          }
        },
        isSessionDeleted: (sessionId: string) => this.deletedSessionIds.has(sessionId),
      },
      this.options
    );

    this.loadStateFromDb();
    this.agentRunner.guardSessionController();

    if (typeof (this.ctx as any).on === 'function') {
      (this.ctx as any).on('ready', () => {
        this.agentRunner.guardSessionController();
      });

      // 实时响应 Archive Manager 插件发出的外部会话删除事件
      (this.ctx as any).on('api-session/removed', (sessionId: any) => {
        if (sessionId) {
          this.handleExternalSessionRemoved(String(sessionId));
        }
      });

      // 实时响应 DSH 原生 session teardown 事件
      (this.ctx as any).on('session/disposed', (session: any) => {
        const sid = session?.id ? String(session.id) : '';
        if (sid) {
          this.handleExternalSessionRemoved(sid);
        }
      });

      // 实时感知任何会话的落盘事件，解除新建白名单保护并标记已持久化
      (this.ctx as any).on('session/flush', (session: any) => {
        const sid = session?.id ? String(session.id) : '';
        if (sid) {
          this.agentRunner.markSessionPersistedIfPresent(sid);
        }
      });
    }
  }

  // --- 外部会话删除事件自愈处理 ---
  public handleExternalSessionRemoved(sessionId: string): void {
    this.deletedSessionIds.add(sessionId);

    // 1. 释放并淘汰 AgentHandle 及新建待写白名单
    this.agentRunner.releaseActiveHandle(sessionId);

    // 2. 找到对应 peer，清理内存映射
    const peer = this.sessionIdToPeer(sessionId);
    if (this.peerCurrentSessionId.get(peer) === sessionId) {
      this.peerCurrentSessionId.delete(peer);
    }
    if (this.pendingClearedSessionId.get(peer) === sessionId) {
      this.pendingClearedSessionId.delete(peer);
    }

    // 3. 同步清理 SQLite 数据库中的 current_session_id 记录
    const dbRecord = this.persistence.getSessionState(peer);
    if (dbRecord && dbRecord.current_session_id === sessionId) {
      this.persistence.saveSessionState({
        ...dbRecord,
        current_session_id: '',
        updated_at: Date.now(),
      });
    }
    this.clearedVersions.delete(peer);
  }

  // --- 状态加载 ---
  private loadStateFromDb(): void {
    if (!this.db) return;
    try {
      const records = this.persistence.getAllSessionStates();
      for (const rec of records) {
        if (rec.peer && rec.current_session_id) {
          this.peerCurrentSessionId.set(rec.peer, rec.current_session_id);
          this.clearedVersions.set(rec.peer, {
            round: rec.cleared_round ?? 0,
            version: rec.cleared_version ?? 1,
          });
        }
      }
      this.modelSelector.loadState(records);
    } catch {}
  }

  // --- 出站桥接与轮次委托 ---
  public setOutboundBridge(bridge: OutboundBridgeLike): void {
    this.agentRunner.setOutboundBridge(bridge);
  }

  public getOutboundBridge(): OutboundBridgeLike | undefined {
    return this.agentRunner.getOutboundBridge();
  }

  public getActiveTurn(peer: string): number | undefined {
    return this.agentRunner.getActiveTurn(peer);
  }

  // --- 工作区与 CWD 委托 ---
  public getDshHome(): string {
    return this.workspace.getDshHome();
  }

  public resolveCwd(_peerOrSessionId?: string): string {
    return this.workspace.resolveCwd(_peerOrSessionId);
  }

  public async registerWorkspace(cwd: string, sessionId?: string, title = 'NapCat'): Promise<void> {
    return this.workspace.registerWorkspace(cwd, sessionId, title);
  }

  // --- 持久化与物理存在性委托 ---
  public isSessionArchived(sessionId: string): boolean {
    return this.persistence.isSessionArchived(sessionId);
  }

  public isSessionPhysicallyPresent(sessionId: string): boolean {
    return this.persistence.isSessionPhysicallyPresent(sessionId);
  }

  public isSessionZombie(sessionId: string): boolean {
    return this.agentRunner.isSessionZombie(sessionId);
  }

  public isSessionActiveOrPresent(sessionId: string): boolean {
    if (this.isSessionArchived(sessionId)) return false;
    if (this.agentRunner.isSessionZombie(sessionId)) return false;
    if (this.deletedSessionIds.has(sessionId)) return false;
    if (this.isSessionPhysicallyPresent(sessionId)) {
      this.agentRunner.markSessionPersistedIfPresent(sessionId);
      return true;
    }
    if (this.agentRunner.isPendingFirstTurn(sessionId)) return true;
    const agents = this.ctx.get?.('agents') || (this.ctx as any).agents;
    const liveAgent = agents?.get?.(sessionId as any);
    if (liveAgent) {
      return true;
    }
    return false;
  }

  public async isSessionPhysicallyPresentAsync(sessionId: string): Promise<boolean> {
    return this.persistence.isSessionPhysicallyPresentAsync(sessionId);
  }

  // --- 模型选择委托 ---
  public getHostDefaultModelSelection(): ModelSelection {
    return this.modelSelector.getHostDefaultModelSelection();
  }

  public async resolveDefaultEffort(provider: string, model: string): Promise<string | undefined> {
    return this.modelSelector.resolveDefaultEffort(provider, model);
  }

  public getNapcatDefaultModel(): ModelSelection {
    return this.modelSelector.getNapcatDefaultModel();
  }

  public setNapcatDefaultModel(provider: string, model: string, reasoningEffort?: any): void {
    this.modelSelector.setNapcatDefaultModel(
      provider,
      model,
      reasoningEffort,
      this.getAllQQSessionIds()
    );
  }

  public getDefaultModelSelection(): ModelSelection {
    return this.modelSelector.getDefaultModelSelection();
  }

  public getOrCreateSelectionRef(sessionId: string): ModelSelectionRef {
    return this.modelSelector.getOrCreateSelectionRef(sessionId);
  }

  public setModelSelection(
    sessionId: string,
    provider: string,
    model: string,
    reasoningEffort?: any,
    persistDb = true
  ): void {
    const peer = this.sessionIdToPeer(sessionId);
    this.modelSelector.setModelSelection(
      sessionId,
      provider,
      model,
      reasoningEffort,
      peer,
      persistDb
    );
  }

  public getModelSelection(sessionId: string): ModelSelection | undefined {
    return this.modelSelector.getModelSelection(sessionId);
  }

  public getAllQQSessionIds(): string[] {
    const sids = new Set<string>();
    for (const sid of this.peerCurrentSessionId.values()) {
      if (!this.isSessionArchived(sid)) {
        sids.add(sid);
      }
    }
    for (const sid of this.agentRunner.getActiveHandleKeys()) {
      if (!this.isSessionArchived(sid)) {
        sids.add(sid);
      }
    }
    for (const sid of this.modelSelector.getTrackedSessionIds()) {
      if (!this.isSessionArchived(sid)) {
        sids.add(sid);
      }
    }
    return Array.from(sids);
  }

  // --- Agent 运行时与并发锁委托 ---
  public guardSessionController(sc?: any): void {
    this.agentRunner.guardSessionController(sc);
  }

  public hasActiveHandle(sessionId: string): boolean {
    return this.agentRunner.hasActiveHandle(sessionId);
  }

  public getActiveHandle(sessionId: string): AgentHandle | undefined {
    return this.agentRunner.getActiveHandle(sessionId);
  }

  public async releaseActiveHandle(sessionId: string): Promise<void> {
    return this.agentRunner.releaseActiveHandle(sessionId);
  }

  public markSessionBusy(sessionId: string, busy: boolean): void {
    this.agentRunner.markSessionBusy(sessionId, busy);
  }

  public isSessionBusy(sessionId: string): boolean {
    return this.agentRunner.isSessionBusy(sessionId);
  }

  public isBusy(peerOrSessionId: string): boolean {
    const sessionId = this.peerToSessionId(peerOrSessionId);
    return this.agentRunner.isSessionBusy(sessionId) || this.agentRunner.isSessionBusy(peerOrSessionId);
  }

  public setPeerName(peer: string, name: string): void {
    this.agentRunner.setPeerName(peer, name);
  }

  public getPeerName(peer: string): string | undefined {
    return this.agentRunner.getPeerName(peer);
  }

  public isQQSession(sessionId: string): boolean {
    return isQQSession(sessionId);
  }

  public getAgent(peerOrSessionId: string): Agent | undefined {
    return this.agentRunner.getAgent(peerOrSessionId);
  }

  public updateSessionTitle(session: any, peer: string, sessionId: string, name?: string): void {
    this.agentRunner.updateSessionTitle(session, peer, sessionId, name);
  }

  public async getOrCreateAgent(peerOrSessionId: string): Promise<Agent> {
    return this.agentRunner.getOrCreateAgent(peerOrSessionId);
  }

  public formatWakeupPrompt(payload: WakeupPayload): string {
    return formatWakeupPrompt(payload);
  }

  public async dispatchWakeup(
    payload: WakeupPayload,
    options?: {
      onMessageCreated?: (userMsg: any) => void;
    }
  ): Promise<any> {
    return this.agentRunner.dispatchWakeup(payload, options);
  }

  // --- 会话寻址与路由核心逻辑 ---
  public sessionIdToPeer(sessionId: string): string {
    return sessionIdToPeer(sessionId);
  }

  public peerToSessionId(peer: string): string {
    if (peer.startsWith('qq-group-') || peer.startsWith('qq-user-')) {
      if (!this.isSessionArchived(peer)) {
        return peer;
      }
      peer = this.sessionIdToPeer(peer);
    }

    const pending = this.pendingClearedSessionId.get(peer);
    if (pending) {
      if (!this.isSessionArchived(pending)) {
        return pending;
      }
      this.pendingClearedSessionId.delete(peer);
    }

    const cached = this.peerCurrentSessionId.get(peer);
    if (cached) {
      if (this.isSessionActiveOrPresent(cached)) {
        return cached;
      }
      if (this.agentRunner.isSessionZombie(cached)) {
        this.deletedSessionIds.add(cached);
      }
      this.peerCurrentSessionId.delete(peer);
      this.agentRunner.releaseActiveHandle(cached);
      const dbRecord = this.persistence.getSessionState(peer);
      if (dbRecord && dbRecord.current_session_id === cached) {
        this.persistence.saveSessionState({
          ...dbRecord,
          current_session_id: '',
          updated_at: Date.now(),
        });
      }
    }

    const baseId = peerToBaseId(peer);

    // 1. 扫描当前工作区已登记的所有该 peer 的会话历史
    const known = new Map<string, { round: number; version: number }>();
    const wsRegistry = this.ctx.get?.('workspaceRegistry') || (this.ctx as any).workspaceRegistry;
    if (wsRegistry?.headers && typeof wsRegistry.headers.keys === 'function') {
      for (const rawSid of Array.from(wsRegistry.headers.keys())) {
        const sid = String(rawSid);
        const parsed = parseSessionId(sid);
        if (parsed) {
          const expectedBase = parsed.isGroup ? `qq-group-${parsed.id}` : `qq-user-${parsed.id}`;
          if (expectedBase === baseId) {
            if (this.isSessionPhysicallyPresent(sid)) {
              known.set(sid, { round: parsed.round, version: parsed.version });
            }
          }
        }
      }
    }

    // 补充内存中已存在、但尚未由 NapCat 持久化入库的 live sessions / agents
    const sessionsSvc = this.ctx.get?.('sessions') || (this.ctx as any).sessions;
    if (sessionsSvc?.list && typeof sessionsSvc.list === 'function') {
      try {
        for (const s of sessionsSvc.list()) {
          const sid = s?.id ? String(s.id) : '';
          const parsed = sid ? parseSessionId(sid) : null;
          if (parsed) {
            const expectedBase = parsed.isGroup ? `qq-group-${parsed.id}` : `qq-user-${parsed.id}`;
            if (
              expectedBase === baseId &&
              (this.isSessionPhysicallyPresent(sid) || this.agentRunner.isPendingFirstTurn(sid))
            ) {
              known.set(sid, { round: parsed.round, version: parsed.version });
            }
          }
        }
      } catch {}
    }
    const agentsSvc = this.ctx.get?.('agents') || (this.ctx as any).agents;
    if (agentsSvc?.get) {
      try {
        const liveAgent = agentsSvc.get(baseId as any);
        if (
          liveAgent &&
          (this.isSessionPhysicallyPresent(baseId) || this.agentRunner.isPendingFirstTurn(baseId))
        ) {
          known.set(baseId, { round: 0, version: 1 });
        }
      } catch {}
    }

    // 同时补充来自 db 的记录，并校验物理存在性
    const dbRecord = this.persistence.getSessionState(peer);
    if (dbRecord?.current_session_id) {
      const parsed = parseSessionId(dbRecord.current_session_id);
      if (parsed) {
        if (this.isSessionPhysicallyPresent(dbRecord.current_session_id)) {
          known.set(dbRecord.current_session_id, { round: parsed.round, version: parsed.version });
        } else {
          this.deletedSessionIds.add(dbRecord.current_session_id);
          this.persistence.saveSessionState({
            ...dbRecord,
            current_session_id: '',
            cleared_round: 0,
            cleared_version: 1,
            updated_at: Date.now(),
          });
          this.peerCurrentSessionId.delete(peer);
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

    const isNewCandidate = known.size === 0 || unarchived.length === 0;
    if (known.size === 0) {
      this.clearedVersions.delete(peer);
      targetRound = 0;
      targetVersion = 1;
      targetSessionId = buildSessionId(baseId, targetRound, targetVersion);
    } else if (unarchived.length === 0) {
      const nextRound = maxKnownRound + 1;
      targetRound = nextRound;
      targetVersion = 1;
      targetSessionId = buildSessionId(baseId, targetRound, targetVersion);
    } else {
      unarchived.sort((a, b) => b.round - a.round || b.version - a.version);
      const highest = unarchived[0];
      targetRound = highest.round;
      targetVersion = highest.version;
      targetSessionId = highest.sid;
    }

    // 防撞保护：若目标 ID 曾被外部删除、或已被归档、或磁盘上存在未纳管冲突文件，追加短哈希防撞
    if (
      this.deletedSessionIds.has(targetSessionId) ||
      this.isSessionArchived(targetSessionId) ||
      (isNewCandidate && this.isSessionPhysicallyPresent(targetSessionId))
    ) {
      let hash = generateSessionHash();
      targetSessionId = buildSessionId(baseId, targetRound, targetVersion, hash);
      while (
        this.deletedSessionIds.has(targetSessionId) ||
        this.isSessionArchived(targetSessionId) ||
        this.isSessionPhysicallyPresent(targetSessionId)
      ) {
        hash = generateSessionHash();
        targetSessionId = buildSessionId(baseId, targetRound, targetVersion, hash);
      }
    }

    this.peerCurrentSessionId.set(peer, targetSessionId);
    this.clearedVersions.set(peer, { round: targetRound, version: targetVersion });
    const existing = this.persistence.getSessionState(peer);
    this.persistence.saveSessionState({
      peer,
      current_session_id: targetSessionId,
      cleared_round: targetRound,
      cleared_version: targetVersion,
      updated_at: Date.now(),
      model_provider: existing?.model_provider,
      model_name: existing?.model_name,
      model_reasoning_effort: existing?.model_reasoning_effort,
    });

    return targetSessionId;
  }

  public markSessionCleared(peerOrSessionId: string): string {
    const peer = this.sessionIdToPeer(peerOrSessionId);
    const currentSid = this.peerCurrentSessionId.get(peer) || (peerOrSessionId.startsWith('qq-') ? peerOrSessionId : undefined);
    const baseId = peerToBaseId(peer);

    // 1. 扫描当前 peer 的未归档活跃会话
    const activeSessionIds = this.listPeerSessionIds(peer);
    let maxKnownRound = 0;
    const activeVersions: number[] = [];
    for (const sid of activeSessionIds) {
      const parsed = parseSessionId(sid);
      if (parsed) {
        if (parsed.round > maxKnownRound) {
          maxKnownRound = parsed.round;
        }
        activeVersions.push(parsed.version);
      }
    }

    // 保底：将当前正在被清理的会话（currentSid）强制纳入已占用版本列表
    let currentVersion: number | undefined;
    let currentRound = 0;
    if (currentSid) {
      const curParsed = parseSessionId(currentSid);
      if (curParsed) {
        currentRound = curParsed.round;
        currentVersion = curParsed.version;
        if (curParsed.round > maxKnownRound) {
          maxKnownRound = curParsed.round;
        }
        activeVersions.push(curParsed.version);
      }
    }

    let round = maxKnownRound;
    let nextVersion = findSmallestAvailableVersion(activeVersions);

    // 绝对排他：当前被清空的会话版本绝不能作为新会话版本（杜绝原地重复编号）
    if (currentVersion !== undefined && round === currentRound && nextVersion === currentVersion) {
      const set = new Set(activeVersions);
      let v = currentVersion + 1;
      while (set.has(v)) {
        v++;
      }
      nextVersion = v;
    }

    // 2. 构造新 SessionId 并做防撞处理
    const rawCandidate = buildSessionId(baseId, round, nextVersion);
    let nextSessionId = rawCandidate;
    if (
      this.isSessionArchived(rawCandidate) ||
      this.isSessionPhysicallyPresent(rawCandidate) ||
      this.deletedSessionIds.has(rawCandidate)
    ) {
      let hash = generateSessionHash();
      nextSessionId = buildSessionId(baseId, round, nextVersion, hash);
      while (
        this.isSessionArchived(nextSessionId) ||
        this.isSessionPhysicallyPresent(nextSessionId) ||
        this.deletedSessionIds.has(nextSessionId)
      ) {
        hash = generateSessionHash();
        nextSessionId = buildSessionId(baseId, round, nextVersion, hash);
      }
    }

    this.clearedVersions.set(peer, { round, version: nextVersion });
    this.pendingClearedSessionId.set(peer, nextSessionId);
    this.peerCurrentSessionId.set(peer, nextSessionId);

    // 继承前序会话的模型与思考深度
    const prevSel = currentSid ? this.modelSelector.getModelSelection(currentSid) : undefined;
    const dbPrev = this.persistence.getSessionState(peer);
    const defaultSel = this.getDefaultModelSelection();
    const inheritedProvider = prevSel?.provider || dbPrev?.model_provider || defaultSel.provider;
    const inheritedModel = prevSel?.model || dbPrev?.model_name || defaultSel.model;
    const inheritedEffort =
      prevSel?.reasoningEffort ?? dbPrev?.model_reasoning_effort ?? defaultSel.reasoningEffort;

    this.modelSelector.setModelSelection(
      nextSessionId,
      inheritedProvider,
      inheritedModel,
      inheritedEffort,
      peer,
      false
    );

    this.persistence.saveSessionState({
      peer,
      current_session_id: nextSessionId,
      cleared_round: round,
      cleared_version: nextVersion,
      updated_at: Date.now(),
      model_provider: inheritedProvider,
      model_name: inheritedModel,
      model_reasoning_effort: inheritedEffort,
    });

    return peer;
  }

  public listPeerSessionIds(peer: string): string[] {
    const baseId = peerToBaseId(peer);
    const known = new Map<string, { round: number; version: number }>();
    const wsRegistry = this.ctx.get?.('workspaceRegistry') || (this.ctx as any).workspaceRegistry;
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

    const dbRecord = this.persistence.getSessionState(peer);
    if (dbRecord?.current_session_id) {
      const parsed = parseSessionId(dbRecord.current_session_id);
      if (parsed) {
        if (this.isSessionActiveOrPresent(dbRecord.current_session_id)) {
          known.set(dbRecord.current_session_id, { round: parsed.round, version: parsed.version });
        }
      }
    }

    const curSid = this.peerCurrentSessionId.get(peer);
    if (curSid) {
      const parsed = parseSessionId(curSid);
      if (parsed) {
        if (this.isSessionActiveOrPresent(curSid)) {
          known.set(curSid, { round: parsed.round, version: parsed.version });
        }
      }
    }

    const sessionsSvc = this.ctx.get?.('sessions') || (this.ctx as any).sessions;
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
                if (
                  (this.isSessionPhysicallyPresent(sid) || this.agentRunner.isPendingFirstTurn(sid)) &&
                  !this.isSessionArchived(sid)
                ) {
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
                if (
                  (this.isSessionPhysicallyPresent(sid) || this.agentRunner.isPendingFirstTurn(sid)) &&
                  !this.isSessionArchived(sid)
                ) {
                  known.set(sid, { round: parsed.round, version: parsed.version });
                }
              }
            }
          }
        } catch {}
      }
    }

    for (const sid of this.modelSelector.getTrackedSessionIds()) {
      const parsed = parseSessionId(sid);
      if (parsed) {
        const expectedBase = parsed.isGroup ? `qq-group-${parsed.id}` : `qq-user-${parsed.id}`;
        if (expectedBase === baseId) {
          if (
            (this.isSessionPhysicallyPresent(sid) || this.agentRunner.isPendingFirstTurn(sid)) &&
            !this.isSessionArchived(sid)
          ) {
            known.set(sid, { round: parsed.round, version: parsed.version });
          }
        }
      }
    }

    const list = Array.from(known.entries()).map(([sid, info]) => ({ sid, ...info }));
    list.sort((a, b) => a.round - b.round || a.version - b.version);
    return list.map((item) => item.sid);
  }

  public resumeSession(peer: string, sessionId: string): boolean {
    if (!this.isSessionPhysicallyPresent(sessionId) || this.isSessionArchived(sessionId)) {
      return false;
    }

    const parsed = parseSessionId(sessionId);
    if (!parsed) {
      return false;
    }

    const baseId = peerToBaseId(peer);
    const expectedBase = parsed.isGroup ? `qq-group-${parsed.id}` : `qq-user-${parsed.id}`;
    if (expectedBase !== baseId) {
      return false;
    }

    this.peerCurrentSessionId.set(peer, sessionId);
    this.clearedVersions.set(peer, { round: parsed.round, version: parsed.version });
    const existing = this.persistence.getSessionState(peer);
    this.persistence.saveSessionState({
      peer,
      current_session_id: sessionId,
      cleared_round: parsed.round,
      cleared_version: parsed.version,
      updated_at: Date.now(),
      model_provider: existing?.model_provider,
      model_name: existing?.model_name,
      model_reasoning_effort: existing?.model_reasoning_effort,
    });

    return true;
  }

  public async dispose(): Promise<void> {
    await this.agentRunner.dispose();
    this.peerCurrentSessionId.clear();
    this.clearedVersions.clear();
    this.pendingClearedSessionId.clear();
    this.deletedSessionIds.clear();
    this.modelSelector.clear();
  }
}
