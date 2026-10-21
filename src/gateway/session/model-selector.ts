/**
 * dsh-napcat-bridge: 模型选择与推理链深度 (reasoningEffort) 调度模块
 * 负责与 DSH LLM 服务交互、维护会话级 (Per-Session) 与 NapCat 插件默认模型选择。
 */

import type { Context } from '@deepseek-ai/cordis';
import type { ModelSelection, ModelSelectionRef } from '@deepseek-ai/dsh-agent';
import type { SessionPersistenceManager } from './persistence.js';

export class SessionModelSelector {
  private selectionMap = new Map<string, ModelSelectionRef>();
  private napcatDefaultModel?: ModelSelection;

  constructor(
    private readonly ctx?: Context,
    private readonly persistence?: SessionPersistenceManager
  ) {}

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
  public getHostDefaultModelSelection(): ModelSelection {
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

    const llm = this.ctx?.get?.('llm') || (this.ctx as any)?.llm;
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
  public async resolveDefaultEffort(provider: string, model: string): Promise<string | undefined> {
    const llm = this.ctx?.get?.('llm') || (this.ctx as any)?.llm;
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
  public getNapcatDefaultModel(): ModelSelection {
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
    const sel: ModelSelection = {
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
  }

  public getDefaultModelSelection(): ModelSelection {
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

  public getModelSelection(sessionId: string): ModelSelection | undefined {
    const ref = this.getOrCreateSelectionRef(sessionId);
    return ref.current;
  }

  public getTrackedSessionIds(): string[] {
    return Array.from(this.selectionMap.keys());
  }

  public clear(): void {
    this.selectionMap.clear();
  }
}
