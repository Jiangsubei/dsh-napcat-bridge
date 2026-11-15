/**
 * dsh-napcat-bridge: 模型选择与推理链深度 (reasoningEffort) 调度模块
 * 负责与 DSH LLM 服务交互、维护会话级 (Per-Session) 与 NapCat 插件默认模型选择。
 *
 * DSH 0.2.2-rc.3 起，Agent 的真实模型选择由 `agent.model`（AgentModel + Session
 * modelSelection 投影）承载；本模块维护「NapCat 插件视角」的选择，并在需要时通过
 * `agent.model.select()` 同步到 live Agent，读取时以 `agent.model.current()` 为准。
 */

import type { Context } from '@deepseek-ai/cordis';
import type { SessionPersistenceManager } from './persistence.js';
import { isQQSession } from './id-resolver.js';

/** 插件视角的模型选择（结构与 DSH ModelSelection 兼容，effort 保持宽松类型） */
export interface SelectionLike {
  provider: string;
  model: string;
  reasoningEffort?: any;
}

/**
 * 会话级可变选择。
 * - `current`：NapCat 视角下该会话应使用的模型；
 * - `assembled`：历史兼容字段，DSH 0.2.2 不再读取，保留以避免旧调用方断链。
 */
export interface ModelSelectionRef {
  current: SelectionLike | undefined;
  assembled?: SelectionLike | undefined;
}

export class SessionModelSelector {
  private selectionMap = new Map<string, ModelSelectionRef>();
  private napcatDefaultModel?: SelectionLike;

  constructor(
    private readonly ctx?: Context,
    private readonly persistence?: SessionPersistenceManager
  ) {}

  /**
   * 读取 live Agent 上 DSH 认可的真实当前选择（0.2.2：agent.model.current()）。
   */
  public readAgentSelection(agent: any): SelectionLike | undefined {
    try {
      const sel = agent?.model?.current?.();
      if (sel?.provider && sel?.model) {
        return {
          provider: sel.provider,
          model: sel.model,
          ...(sel.reasoningEffort ? { reasoningEffort: sel.reasoningEffort } : {}),
        };
      }
    } catch {}
    return undefined;
  }

  /**
   * 把插件记录的选择写入 live Agent（0.2.2：agent.model.select()）。
   * @returns 是否真正发起了切换（选择未变化或无可用 Agent 时返回 false）。
   */
  public applySelectionToAgent(agent: any, selection?: SelectionLike): boolean {
    if (!selection?.provider || !selection?.model) return false;
    const model = agent?.model;
    if (!model || typeof model.select !== 'function') return false;
    try {
      const current = model.current?.();
      if (
        current?.provider === selection.provider &&
        current?.model === selection.model &&
        (current?.reasoningEffort ?? undefined) === (selection.reasoningEffort ?? undefined)
      ) {
        return false;
      }
      model.select({
        provider: selection.provider,
        model: selection.model,
        ...(selection.reasoningEffort !== undefined
          ? { reasoningEffort: selection.reasoningEffort }
          : {}),
      });
      return true;
    } catch {
      return false;
    }
  }

  private resolveLiveAgent(sessionId: string): any {
    const agents: any = this.ctx?.get?.('agents') || (this.ctx as any)?.agents;
    return agents?.get?.(sessionId as any);
  }

  /**
   * 将选择同步到所有 live 的 QQ 会话 Agent，避免为离线会话逐个 resume。
   * @returns 实际发起切换的 Agent 数量。
   */
  public syncLiveAgents(selection?: SelectionLike): number {
    const agents: any = this.ctx?.get?.('agents') || (this.ctx as any)?.agents;
    const list = typeof agents?.list === 'function' ? agents.list() : undefined;
    if (!Array.isArray(list)) return 0;
    let applied = 0;
    for (const agent of list) {
      const id = agent?.id ? String(agent.id) : '';
      if (!id || !isQQSession(id)) continue;
      if (this.applySelectionToAgent(agent, selection)) applied++;
    }
    return applied;
  }

  /** 读取会话当前选择：优先插件记录，其次 live Agent，最后回退默认值。 */
  public getModelSelection(sessionId: string): SelectionLike | undefined {
    const recorded = this.selectionMap.get(sessionId)?.current;
    if (recorded) return recorded;

    const fromAgent = this.readAgentSelection(this.resolveLiveAgent(sessionId));
    if (fromAgent) return fromAgent;

    return this.getOrCreateSelectionRef(sessionId).current;
  }

  public loadState(records: any[]): void {
    if (!this.persistence) return;
    try {
      const rawDefault = this.persistence.getPluginConfig('napcat_default_model');
      if (rawDefault) {
        try {
          this.napcatDefaultModel = JSON.parse(rawDefault);
        } catch {}
      }

      for (const rec of records) {
        if (rec.peer && rec.current_session_id) {
          if (rec.model_provider && rec.model_name) {
            this.selectionMap.set(rec.current_session_id, {
              current: {
                provider: rec.model_provider,
                model: rec.model_name,
                ...(rec.model_reasoning_effort
                  ? { reasoningEffort: rec.model_reasoning_effort as any }
                  : {}),
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
  public getHostDefaultModelSelection(): SelectionLike {
    const defaultModelSvc =
      this.ctx?.get?.('agentDefaultModel') || (this.ctx as any)?.agentDefaultModel;
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

    // 0.2.2 起 llm.listModels() 为异步接口，本同步兜底路径不做模型探测，
    // 直接回退到内置默认，避免把 Promise 当数组使用。
    return {
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      reasoningEffort: 'high' as any,
    };
  }

  /**
   * 动态解析指定模型的默认思考档位 (若模型不支持思考则返回 undefined)
   */
  public async resolveDefaultEffort(provider: string, model: string): Promise<string | undefined> {
    const llm = this.ctx?.get?.('llm') || (this.ctx as any)?.llm;
    if (llm && typeof llm.resolveModelInfo === 'function') {
      try {
        const info = await llm.resolveModelInfo(provider, model);
        if (
          info &&
          info.reasoning &&
          Array.isArray(info.reasoning.efforts) &&
          info.reasoning.efforts.length > 0
        ) {
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
  public getNapcatDefaultModel(): SelectionLike {
    if (this.napcatDefaultModel?.provider && this.napcatDefaultModel?.model) {
      return { ...this.napcatDefaultModel };
    }
    return this.getHostDefaultModelSelection();
  }

  /**
   * 设置 NapCat 插件全局默认模型，并批量联动同步已知的所有 QQ 会话
   */
  public setNapcatDefaultModel(
    provider: string,
    model: string,
    reasoningEffort?: any,
    activeSessionIds?: string[]
  ): void {
    const sel: SelectionLike = {
      provider,
      model,
      ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    };
    this.napcatDefaultModel = sel;
    if (this.persistence) {
      this.persistence.setPluginConfig('napcat_default_model', JSON.stringify(sel));
    }

    // 1. 同步内存中所有已记录的会话 selection
    const sids = activeSessionIds || Array.from(this.selectionMap.keys());
    for (const sid of sids) {
      const ref = this.getOrCreateSelectionRef(sid);
      ref.current = { ...sel };
    }

    // 2. 持久化至已知的所有 peer 数据库状态中
    if (this.persistence) {
      const allStates = this.persistence.getAllSessionStates();
      for (const st of allStates) {
        st.model_provider = provider;
        st.model_name = model;
        st.model_reasoning_effort = reasoningEffort ?? undefined;
        this.persistence.saveSessionState(st);
      }
    }

    // 3. 对 live 的 QQ 会话 Agent 立即生效；离线会话在下次 resume/创建时再同步，
    //    避免为每个历史会话触发 DSH 的 resume（0.2.2 selectModel 语义）。
    this.syncLiveAgents(sel);
  }

  public getDefaultModelSelection(): SelectionLike {
    return this.getNapcatDefaultModel();
  }

  public getOrCreateSelectionRef(sessionId: string): ModelSelectionRef {
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

  public setModelSelection(
    sessionId: string,
    provider: string,
    model: string,
    reasoningEffort?: any,
    peer?: string,
    persistDb = true
  ): void {
    const ref = this.getOrCreateSelectionRef(sessionId);
    ref.current = {
      provider,
      model,
      ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    };

    // 0.2.2：把选择写入 live Agent 的 Session 投影，保证下一次请求真实采用该模型
    const agent = this.resolveLiveAgent(sessionId);
    if (agent) {
      this.applySelectionToAgent(agent, ref.current);
    }

    if (persistDb && this.persistence && peer) {
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
      state.model_provider = provider;
      state.model_name = model;
      state.model_reasoning_effort = reasoningEffort ?? undefined;
      this.persistence.saveSessionState(state);
    }
  }

  public getTrackedSessionIds(): string[] {
    return Array.from(this.selectionMap.keys());
  }

  public clear(): void {
    this.selectionMap.clear();
  }
}
