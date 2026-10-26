/**
 * dsh-napcat-bridge: Agent 运行时生命周期与执行调度模块
 * 负责 Agent 创建与恢复、会话独占锁与看门狗、以及入站唤醒 (dispatchWakeup) 的消息排队下发。
 */

import { promises as fsp } from 'node:fs';
import type { Context } from '@deepseek-ai/cordis';
import {
  installModelSelection,
  type Agent,
  type AgentHandle,
} from '@deepseek-ai/dsh-agent';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import type { WakeupPayload } from '../../types/index.js';
import {
  RemoteError,
  SessionAlreadyOwnedError,
  type OutboundBridgeLike,
  type SessionManagerOptions,
} from './types.js';
import {
  parseSessionId,
  buildSessionId,
  generateSessionHash,
  formatSessionTitle,
  formatWakeupPrompt,
  isQQSession,
} from './id-resolver.js';
import type { SessionWorkspaceManager } from './workspace.js';
import type { SessionPersistenceManager } from './persistence.js';
import type { SessionModelSelector } from './model-selector.js';

export interface AgentRunnerDelegate {
  peerToSessionId(peer: string): string;
  sessionIdToPeer(sessionId: string): string;
  onSessionReassigned?(peer: string, newSessionId: string): void;
  onClearPendingCleared?(peer: string, sessionId: string): void;
  isSessionDeleted?(sessionId: string): boolean;
}

export class SessionAgentRunner {
  private activeHandles = new Map<string, AgentHandle>();
  private busySessions = new Set<string>();
  private peerNames = new Map<string, string>();
  private persistedSessions = new Set<string>();
  private pendingFirstTurnSessions = new Set<string>();
  private outboundBridge?: OutboundBridgeLike;

  constructor(
    private readonly ctx: Context,
    private readonly workspace: SessionWorkspaceManager,
    private readonly persistence: SessionPersistenceManager,
    private readonly modelSelector: SessionModelSelector,
    private readonly delegate: AgentRunnerDelegate,
    private readonly options?: SessionManagerOptions
  ) {}

  public setOutboundBridge(bridge: OutboundBridgeLike): void {
    this.outboundBridge = bridge;
  }

  public getOutboundBridge(): OutboundBridgeLike | undefined {
    return this.outboundBridge;
  }

  public getActiveTurn(peer: string): number | undefined {
    return (this.outboundBridge as any)?.getActiveTurn?.(peer);
  }

  public isPendingFirstTurn(sessionId: string): boolean {
    if (this.persistedSessions.has(sessionId)) {
      this.pendingFirstTurnSessions.delete(sessionId);
      return false;
    }
    return this.pendingFirstTurnSessions.has(sessionId);
  }

  public markPendingFirstTurn(sessionId: string): void {
    if (!this.persistedSessions.has(sessionId)) {
      this.pendingFirstTurnSessions.add(sessionId);
    }
  }

  public clearPendingFirstTurn(sessionId: string): void {
    this.pendingFirstTurnSessions.delete(sessionId);
  }

  public markSessionPersistedIfPresent(sessionId: string): boolean {
    if (this.persistence.isSessionPhysicallyPresent(sessionId)) {
      this.persistedSessions.add(sessionId);
      this.pendingFirstTurnSessions.delete(sessionId);
      return true;
    }
    return false;
  }

  public isSessionZombie(sessionId: string): boolean {
    if (this.isPendingFirstTurn(sessionId)) {
      return false;
    }
    if (this.markSessionPersistedIfPresent(sessionId)) {
      return false;
    }
    return this.persistedSessions.has(sessionId);
  }

  public markSessionPersisted(sessionId: string): void {
    this.persistedSessions.add(sessionId);
  }

  public setPeerName(peer: string, name: string): void {
    if (name && typeof name === 'string' && name.trim()) {
      this.peerNames.set(peer, name.trim());
    }
  }

  public getPeerName(peer: string): string | undefined {
    return this.peerNames.get(peer);
  }

  public hasActiveHandle(sessionId: string): boolean {
    return this.activeHandles.has(sessionId);
  }

  public getActiveHandle(sessionId: string): AgentHandle | undefined {
    return this.activeHandles.get(sessionId);
  }

  public getActiveHandleKeys(): IterableIterator<string> {
    return this.activeHandles.keys();
  }

  public async releaseActiveHandle(sessionId: string): Promise<void> {
    this.clearPendingFirstTurn(sessionId);
    this.persistedSessions.delete(sessionId);
    const handle = this.activeHandles.get(sessionId);
    if (handle) {
      this.activeHandles.delete(sessionId);
      if (typeof handle.dispose === 'function') {
        await Promise.resolve(handle.dispose()).catch(() => {});
      }
    }
  }

  public markSessionBusy(sessionId: string, busy: boolean): void {
    if (busy) {
      this.busySessions.add(sessionId);
    } else {
      this.busySessions.delete(sessionId);
    }
  }

  public isSessionBusy(sessionId: string): boolean {
    return this.busySessions.has(sessionId);
  }

  public getAgent(peerOrSessionId: string): Agent | undefined {
    const sessionId = isQQSession(peerOrSessionId)
      ? peerOrSessionId
      : this.delegate.peerToSessionId(peerOrSessionId);

    const fromHandle = this.activeHandles.get(sessionId);
    if (fromHandle?.agent) {
      return fromHandle.agent;
    }

    const agents = this.ctx.get?.('agents') || (this.ctx as any).agents;
    return agents?.get?.(sessionId as any);
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
        if (sid && (this.activeHandles.has(sid) || (isQQSession(sid) && this.isSessionBusy(sid)))) {
          throw new RemoteError(
            'session/agent-busy',
            '该会话当前正由 QQ 独占使用中，Web 端处于只读监视模式。请在 QQ 端发送消息。',
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

  public updateSessionTitle(session: any, peer: string, sessionId: string, name?: string): void {
    if (!session) return;
    if (name) {
      this.setPeerName(peer, name);
    }
    const currentName = name || this.getPeerName(peer);
    const title = formatSessionTitle(peer, sessionId, currentName);
    const sessionTitleSvc = this.ctx.get?.('sessionTitle') || (this.ctx as any).sessionTitle;
    if (sessionTitleSvc && typeof sessionTitleSvc.rename === 'function') {
      try {
        sessionTitleSvc.rename(session, title);
      } catch (err: any) {
        this.ctx.logger?.('dsh-napcat-bridge')?.debug?.(
          `[SessionAgentRunner] 锁定会话标题 ${sessionId} 失败:`,
          err?.message
        );
      }
    }
  }

  public async getOrCreateAgent(peerOrSessionId: string): Promise<Agent> {
    let sessionId = this.delegate.peerToSessionId(peerOrSessionId);
    const peer = this.delegate.sessionIdToPeer(peerOrSessionId);

    if (this.persistence.isSessionPhysicallyPresent(sessionId)) {
      this.persistedSessions.add(sessionId);
      this.clearPendingFirstTurn(sessionId);
    }

    // 二次确认：若当前已持有该会话句柄或 live agent，但在运行时被归档或底层物理文件已被删除（僵尸句柄），销毁旧句柄并重新寻址
    const isCurrentZombie =
      this.persistence.isSessionArchived(sessionId) ||
      this.isSessionZombie(sessionId) ||
      Boolean(this.delegate.isSessionDeleted?.(sessionId));

    if (isCurrentZombie) {
      await this.releaseActiveHandle(sessionId);
      this.delegate.onSessionReassigned?.(peer, '');
      sessionId = this.delegate.peerToSessionId(peer);
    }

    const selectionRef = this.modelSelector.getOrCreateSelectionRef(sessionId);
    const agents = this.ctx.get?.('agents') || (this.ctx as any).agents;

    // 1. 若当前会话已由 QQ 自身持有专属写句柄，检查其归档状态与物理有效性
    if (this.activeHandles.has(sessionId)) {
      const handle = this.activeHandles.get(sessionId)!;
      const isHandleValid =
        !this.persistence.isSessionArchived(sessionId) &&
        !this.isSessionZombie(sessionId) &&
        !this.delegate.isSessionDeleted?.(sessionId);

      if (isHandleValid) {
        (handle.agent as any).modelSelection = selectionRef;
        this.updateSessionTitle((handle.agent as any).session, peer, sessionId);
        return handle.agent;
      }
      this.activeHandles.delete(sessionId);
      if (typeof handle.dispose === 'function') {
        await Promise.resolve(handle.dispose()).catch(() => {});
      }
      this.delegate.onSessionReassigned?.(peer, '');
      sessionId = this.delegate.peerToSessionId(peer);
    }

    // 2. 内存中已存在该会话的 live agent（由 Web UI 会话控制器等其它 owner 创建/持有）：
    //    只复用同一 agent，让新消息经 agent.followup() 排队等待（同 peer 串行）
    //    但若物理文件已确认被删除或处于僵尸状态，绝不能复用残留的僵尸 Agent
    const existingAgent = agents?.get?.(sessionId as any);
    if (existingAgent && !this.persistence.isSessionArchived(sessionId)) {
      const isExistingZombie =
        this.isSessionZombie(sessionId) ||
        Boolean(this.delegate.isSessionDeleted?.(sessionId));

      if (!isExistingZombie) {
        (existingAgent as any).modelSelection = selectionRef;
        this.updateSessionTitle((existingAgent as any).session, peer, sessionId);
        return existingAgent;
      }
      // 物理文件已不存在或已被删除，绝不能复用残留的僵尸 Agent
      this.delegate.onSessionReassigned?.(peer, '');
      sessionId = this.delegate.peerToSessionId(peer);
    }

    let cwd = this.workspace.resolveCwd(sessionId);
    await fsp.mkdir(cwd, { recursive: true });

    const defaultSel = this.modelSelector.getDefaultModelSelection();
    const provider = selectionRef.current?.provider || defaultSel.provider;
    const model = selectionRef.current?.model || defaultSel.model;

    // 确保 reasoningEffort 明确解析，防止 undefined 导致 DSH installModelSelection 清空思考档位
    let effort: any = selectionRef.current?.reasoningEffort || defaultSel.reasoningEffort;
    if (effort === undefined) {
      effort = await this.modelSelector.resolveDefaultEffort(provider, model);
    }
    if (effort !== undefined) {
      selectionRef.current = {
        provider,
        model,
        reasoningEffort: effort,
      };
      let state = this.persistence.getSessionState(peer);
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
        this.persistence.saveSessionState(state);
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
          .mount(agentCtx, 'qq-session')
          .then(() => undefined)
          .catch((err: any) => {
            this.ctx.logger?.('dsh-napcat-bridge')?.debug?.(
              '[SessionAgentRunner] mount preset qq-session failed, falling back:',
              err?.message
            );
            const provider =
              (this.ctx as any).napcatBridgeTools ||
              (this.ctx.root as any)?.napcatBridgeTools;
            provider?.registerTools?.(agentCtx);
            return undefined;
          });
      }
      const provider =
        (this.ctx as any).napcatBridgeTools ||
        (this.ctx.root as any)?.napcatBridgeTools;
      provider?.registerTools?.(agentCtx);
      return undefined;
    };

    let handle: AgentHandle | undefined;
    let isSessionLocked = false;
    let isResumed = false;

    // 3. 若该会话此前已持久化在磁盘上，优先通过 agents.resume 恢复会话（带锁冲突退避重试）
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
          isResumed = true;
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
              `[SessionAgentRunner] 会话 ${sessionId} 正在被其他进程或控制台占用 (SessionAlreadyOwnedError)，正在进行第 ${attempt + 1}/${maxRetries} 次重试...`
            );

            if (attempt < maxRetries - 1) {
              await new Promise((res) => setTimeout(res, delays[attempt]));
              continue;
            }
            throw new SessionAlreadyOwnedError(
              sessionId,
              `会话 ${sessionId} 当前正被其他控制台或任务占用（排他锁冲突），请稍后重试或在 Web 端切换其他会话以释放锁。`
            );
          }

          this.ctx.logger?.('dsh-napcat-bridge')?.debug?.(
            `[SessionAgentRunner] Resume session ${sessionId} 未命中或异常:`,
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
      try {
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
      } catch (createErr: any) {
        if (
          typeof createErr?.message === 'string' &&
          (createErr.message.includes('already exists') || createErr.message.includes('already attached'))
        ) {
          const hash = generateSessionHash();
          const parsed = parseSessionId(sessionId);
          const fallbackSid = parsed
            ? buildSessionId(
                parsed.isGroup ? `qq-group-${parsed.id}` : `qq-user-${parsed.id}`,
                parsed.round,
                parsed.version,
                hash
              )
            : `${sessionId}-${hash}`;
          this.ctx.logger?.('dsh-napcat-bridge')?.warn?.(
            `[SessionAgentRunner] 创建会话 ${sessionId} 遭遇宿主内存残留冲突 (${createErr.message})，自动切换短哈希防撞会话: ${fallbackSid}`
          );
          sessionId = fallbackSid;
          this.delegate.onSessionReassigned?.(peer, sessionId);
          cwd = this.workspace.resolveCwd(sessionId);
          await fsp.mkdir(cwd, { recursive: true });
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
        } else {
          throw createErr;
        }
      }
    }

    if (!handle) {
      throw new Error(`Failed to create or resume agent for session ${sessionId}`);
    }

    this.activeHandles.set(sessionId, handle);
    if (isResumed) {
      this.markSessionPersisted(sessionId);
      this.clearPendingFirstTurn(sessionId);
    } else {
      // 全新创建的会话打入新建保护期，防止首轮交互完成落盘前被误判死亡
      this.markPendingFirstTurn(sessionId);
    }

    // 自动在 DSH workspaceRegistry 中登记单一 NapCat 顶级工作区并关联活跃会话
    await this.workspace.registerWorkspace(cwd, sessionId, 'NapCat');

    // 锁定会话标题，防止 LLM 自动总结覆盖
    this.updateSessionTitle(handle.agent.session, peer, sessionId);

    (handle.agent as any).modelSelection = selectionRef;
    this.delegate.onClearPendingCleared?.(peer, sessionId);
    return handle.agent;
  }

  public async dispatchWakeup(
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
    const sessionId = (agent as any).session?.id || this.delegate.peerToSessionId(payload.peer);

    // 若唤醒消息携带发送者昵称，更新私聊会话标题锁定
    if (payload.from_name) {
      if (payload.peer.startsWith('user_') || payload.peer.startsWith('qq-user-')) {
        this.updateSessionTitle((agent as any).session, payload.peer, sessionId, payload.from_name);
      }
    }

    const promptText = formatWakeupPrompt(payload);

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
      // 若此时物理磁盘已完成写入落盘，解除新建保护期
      if (this.persistence.isSessionPhysicallyPresent(sessionId)) {
        this.clearPendingFirstTurn(sessionId);
        this.markSessionPersisted(sessionId);
      }
    }
  }

  public async dispose(): Promise<void> {
    const sc = this.ctx.get?.('sessionController') || (this.ctx as any).sessionController;
    if (sc && (sc.prompt as any)?.__dsh_napcat_guarded) {
      sc.prompt = (sc.prompt as any).__originalPrompt;
    }
    for (const [id, handle] of this.activeHandles.entries()) {
      try {
        await handle.dispose();
      } catch (err) {
        this.ctx.logger?.('dsh-napcat-bridge')?.warn?.(`[SessionAgentRunner] 销毁 Agent ${id} 失败:`, err);
      }
    }
    this.activeHandles.clear();
    this.pendingFirstTurnSessions.clear();
    this.persistedSessions.clear();
    this.peerNames.clear();
    this.busySessions.clear();
  }
}
