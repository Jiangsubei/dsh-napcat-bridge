/**
 * dsh-napcat-bridge: Background Review Manager (自动回顾管理器)
 * 在后台异步审视对话 Turns，自动提炼 QQ 群聊规则与用户画像偏好。
 * 严格对齐 Hermes 自动回顾架构：
 * - 门控检查 (Gating: turnsInterval / toolCallsInterval)
 * - 严格工具白名单沙箱 (仅开放 read_memory, append_memory, update_memory)
 * - 写保护红线 (Do NOT capture 5 类负面约束)
 * - 2 秒取消握手协议 (前台 turn 到来时立即释放，0 阻塞)
 */

import * as path from 'node:path';
import * as os from 'node:os';
import { promises as fsp } from 'node:fs';
import { rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { Context } from '@deepseek-ai/cordis';
import type { MemoryStorage } from './storage.js';
import type { MessageDatabase } from '../storage/database.js';
import type { SessionManager } from '../gateway/session.js';
import {
  DEFAULT_REVIEW_ENABLED,
  DEFAULT_REVIEW_TURNS_INTERVAL,
  DEFAULT_REVIEW_TOOL_CALLS_INTERVAL,
} from '../constants/index.js';

export const ALLOWED_MEMORY_REVIEW_TOOLS: readonly string[] = [
  'read_memory',
  'append_memory',
  'update_memory',
  'read_chat_history',
];

export const BACKGROUND_REVIEW_CANCEL_TIMEOUT_MS = 2000;
export const REVIEW_MAX_ITERATIONS = 16;

export interface HistoryMessage {
  role: string;
  content?: string | any;
  tool_calls?: any[];
  [key: string]: any;
}

export class BackgroundReviewRun {
  public readonly abortController: AbortController = new AbortController();
  private _cancelRequested = false;
  private _requestFinished = false;
  private _cancelDispatched = false;
  private _reviewAgent: any = null;
  public readonly actions: string[] = [];
  public readonly details: {
    memoryChanges: string[];
    rejectedItems: Array<{ type: string; item: string; reason: string }>;
  } = {
    memoryChanges: [],
    rejectedItems: [],
  };

  public readonly requestDone: Promise<void>;
  private _resolveRequestDone!: () => void;

  constructor() {
    this.requestDone = new Promise<void>((resolve) => {
      this._resolveRequestDone = resolve;
    });
  }

  public get cancelRequested(): boolean {
    return this._cancelRequested;
  }

  public get isCancelRequested(): boolean {
    return this._cancelRequested;
  }

  public get isRequestFinished(): boolean {
    return this._requestFinished;
  }

  public beginRequest(reviewAgent?: any): boolean {
    if (this._cancelRequested || this._requestFinished) {
      return false;
    }
    this._reviewAgent = reviewAgent || null;
    return true;
  }

  public cancel(): any {
    this._cancelRequested = true;
    try {
      this.abortController.abort('superseded by a new live turn');
    } catch {}

    if (this._reviewAgent && !this._cancelDispatched) {
      this._cancelDispatched = true;
      const agent = this._reviewAgent;
      try {
        if (typeof agent.abort === 'function') agent.abort();
        else if (typeof agent.interrupt === 'function') agent.interrupt();
        else if (typeof agent.cancel === 'function') agent.cancel();
      } catch {}
      return agent;
    }
    return null;
  }

  public markRequestFinished(): boolean {
    if (this._requestFinished) {
      return false;
    }
    this._requestFinished = true;
    this._reviewAgent = null;
    this._resolveRequestDone();
    return true;
  }
}

export interface BackgroundReviewConfig {
  enabled?: boolean;
  turnsInterval?: number;
  toolCallsInterval?: number;
  storageDir?: string;
  reviewModel?: string;
  cancelTimeoutMs?: number;
  maxIterations?: number;
  db?: MessageDatabase;
  sessionManager?: SessionManager;
}

export interface SessionReviewState {
  peer: string;
  turnsCount: number;
  toolCallsCount: number;
  lastReviewedTurn: number;
  lastReviewedToolCall: number;
  lastReviewTimestamp?: number;
}

export interface ReviewTriggerCheck {
  shouldReview: boolean;
  reason?: string;
  deltaTurns: number;
  deltaToolCalls: number;
}

export interface ReviewSessionContext {
  peer?: string;
  sessionId?: string;
  history?: HistoryMessage[];
  mainModel?: string;
  reviewModel?: string;
  parentSession?: any;
}

export interface ReviewResult {
  executed: boolean;
  peer: string;
  memoryUpdated?: boolean;
  summary?: string;
  actions?: string[];
  message?: string;
  error?: string;
}

/**
 * 汇总 review 变更生成用户可见通知
 */
export function summarizeMemoryReviewActions(actions: string[]): string {
  const unique = Array.from(new Set(actions.filter(Boolean)));
  if (unique.length === 0) return '';
  return `💾 记忆与用户画像自动优化：${unique.join(' · ')}`;
}

/**
 * Hermes 对齐审查提示词模板 (适配 QQ 群聊与私聊两层记忆体系)
 */
export const MEMORY_REVIEW_PROMPT_TEMPLATE = `# Memory Review & Distillation Agent

Review the conversation above and consider saving to memory if appropriate.

Focus on:
1. Has any user revealed things about themselves — their persona, desires, preferences, personal details, tech stacks, or work styles worth remembering? (Save using \`append_memory(type='user', content='...', qq='...')\` or \`update_memory(type='user', ...)\`).
2. Has the group or private chat expressed expectations, group rules, discussion topics, forbidden topics, or ways you should operate in this session? (Save using \`append_memory(type='session', content='...')\` or \`update_memory(type='session', ...)\`).

If something stands out, save it using the memory tools (read_memory, append_memory, update_memory).
You automatically inherit recent conversation history from the parent session. If needed, you may also use \`read_chat_history\` to inspect earlier messages.
If nothing is worth saving, just say 'Nothing to save.' and stop.

## Strict Write Protection Rules (Do NOT capture):
Do NOT capture (these become persistent self-imposed constraints that bite you later when the environment changes):
  • Environment-dependent failures: missing binaries, fresh-install errors, post-migration path mismatches, 'command not found', unconfigured credentials, uninstalled packages. The user can fix these — they are not durable rules.
  • Negative claims about tools or features ('browser tools do not work', 'X tool is broken', 'cannot use Y from execute_code'). These harden into refusals the agent cites against itself for months after the actual problem was fixed.
  • Session-specific transient errors that resolved before the conversation ended. If retrying worked, the lesson is the retry pattern, not the original failure.
  • One-off task narratives. A user asking 'summarize today's market' or 'analyze this PR' is not a class of work that warrants a long-term rule.
  • Unresolved failures: if the session ended WITHOUT actually finding a working method — you tried several things, none worked, and told the user to check manually — do NOT write those attempts up as a 'reliable workflow' or 'recommended approach'. That presents an untested sequence of failures as validated guidance a future session will trust and repeat. Either say 'Nothing to save', or, only if you are independently confident of a real working alternative, capture ONLY that alternative — never the dead ends, and never dressed up as best practice.

'Nothing to save.' is a real option but should NOT be the default. If the session ran smoothly with no new facts/preferences revealed, just say 'Nothing to save.' and stop. Otherwise, act.
`;

export class BackgroundReviewManager {
  private config: BackgroundReviewConfig;
  private sessionStates: Map<string, SessionReviewState> = new Map();
  private activeReviewRuns: Map<string, BackgroundReviewRun> = new Map();
  private logger: any;
  public db?: MessageDatabase;
  public sessionManager?: SessionManager;

  constructor(
    private ctx: Context,
    config: BackgroundReviewConfig = {},
    public storage: MemoryStorage
  ) {
    this.config = {
      enabled: config.enabled ?? DEFAULT_REVIEW_ENABLED,
      turnsInterval: config.turnsInterval ?? DEFAULT_REVIEW_TURNS_INTERVAL,
      toolCallsInterval: config.toolCallsInterval ?? DEFAULT_REVIEW_TOOL_CALLS_INTERVAL,
      cancelTimeoutMs: config.cancelTimeoutMs ?? BACKGROUND_REVIEW_CANCEL_TIMEOUT_MS,
      maxIterations: config.maxIterations ?? REVIEW_MAX_ITERATIONS,
      ...config,
    };
    this.db = config.db;
    this.sessionManager = config.sessionManager;
    this.logger = ctx.logger ? ctx.logger('dsh-napcat:memory-review') : console;
  }

  public getSessionState(peer: string): SessionReviewState {
    let state = this.sessionStates.get(peer);
    if (!state) {
      state = {
        peer,
        turnsCount: 0,
        toolCallsCount: 0,
        lastReviewedTurn: 0,
        lastReviewedToolCall: 0,
      };
      this.sessionStates.set(peer, state);
    }
    return state;
  }

  /**
   * 记录一次对话 Turn 并评估是否达到门控阈值
   */
  public recordTurn(peer: string, toolCallsCount = 0): ReviewTriggerCheck {
    const state = this.getSessionState(peer);
    state.turnsCount += 1;
    state.toolCallsCount += toolCallsCount;

    if (this.config.enabled === false) {
      return {
        shouldReview: false,
        reason: 'Background review disabled',
        deltaTurns: 0,
        deltaToolCalls: 0,
      };
    }

    const turnsInterval = this.config.turnsInterval || DEFAULT_REVIEW_TURNS_INTERVAL;
    const toolCallsInterval = this.config.toolCallsInterval || DEFAULT_REVIEW_TOOL_CALLS_INTERVAL;

    const deltaTurns = state.turnsCount - state.lastReviewedTurn;
    const deltaToolCalls = state.toolCallsCount - state.lastReviewedToolCall;

    let shouldReview = false;
    let reason = '';

    if (deltaTurns >= turnsInterval) {
      shouldReview = true;
      reason = `Reached turns threshold (${deltaTurns} >= ${turnsInterval})`;
    } else if (deltaToolCalls >= toolCallsInterval) {
      shouldReview = true;
      reason = `Reached tool calls threshold (${deltaToolCalls} >= ${toolCallsInterval})`;
    }

    if (shouldReview) {
      state.lastReviewedTurn = state.turnsCount;
      state.lastReviewedToolCall = state.toolCallsCount;
      state.lastReviewTimestamp = Date.now();
    }

    return {
      shouldReview,
      reason,
      deltaTurns,
      deltaToolCalls,
    };
  }

  public prepareReviewRun(peer: string): BackgroundReviewRun | null {
    const current = this.activeReviewRuns.get(peer);
    if (current && !current.isRequestFinished) {
      return null;
    }
    const run = new BackgroundReviewRun();
    this.activeReviewRuns.set(peer, run);
    return run;
  }

  public finishReviewRun(peer: string, run: BackgroundReviewRun): void {
    if (run.markRequestFinished()) {
      if (this.activeReviewRuns.get(peer) === run) {
        this.activeReviewRuns.delete(peer);
      }
    }
  }

  /**
   * 前台 live turn 到来时取消正在执行的后台 review，设置 2.0s 握手超时
   */
  public async cancelReviewForLiveTurn(peer: string): Promise<void> {
    const current = this.activeReviewRuns.get(peer);
    if (!current || current.isRequestFinished) {
      return;
    }

    current.cancel();

    const timeoutMs = this.config.cancelTimeoutMs || BACKGROUND_REVIEW_CANCEL_TIMEOUT_MS;
    try {
      await Promise.race([
        current.requestDone,
        new Promise((resolve) => setTimeout(resolve, timeoutMs)),
      ]);
    } catch {}
  }

  /**
   * 执行一次完整的后台自动回顾
   */
  public async runReview(
    peer: string,
    sessionContext: ReviewSessionContext = {}
  ): Promise<ReviewResult> {
    const run = this.prepareReviewRun(peer);
    if (!run) {
      return {
        executed: false,
        peer,
        message: 'Another review is already in progress for this peer.',
      };
    }

    const reviewSessionId = `review-${peer}-${Date.now()}`;
    let agentHandle: any = null;
    let parentSession: any = sessionContext.parentSession;

    try {
      const sessions = this.ctx.get?.('sessions') || (this.ctx as any).sessions;
      if (!parentSession && sessionContext.sessionId && sessions?.get) {
        try {
          parentSession = sessions.get(sessionContext.sessionId);
        } catch {}
      }

      const parentSessionId =
        parentSession?.header?.id || parentSession?.id || sessionContext.sessionId;
      const parentCwd = parentSession?.header?.cwd || parentSession?.cwd;

      // DSH 原生 fork 机制：从父 Session 事件中截取已完成 turn 的历史切片
      let seed: any[] | undefined = undefined;
      let inheritedEventCount: number | undefined = undefined;

      if (parentSession && typeof parentSession.snapshotEvents === 'function') {
        try {
          const parentEvents = parentSession.snapshotEvents() || [];
          if (parentEvents.length > 0) {
            const lastTurnEndIndex = parentEvents.findLastIndex(
              (ev: any) => ev?.type === 'turn/end'
            );
            if (lastTurnEndIndex >= 0) {
              let cut = lastTurnEndIndex + 1;
              while (cut < parentEvents.length && parentEvents[cut]?.type !== 'turn/start') {
                cut++;
              }
              seed = parentEvents.slice(0, cut);
              inheritedEventCount = cut;
            }
          }
        } catch (err: any) {
          this.logger.warn?.(`[BackgroundReview] snapshotEvents warning: ${err?.message}`);
        }
      }

      // 提示词组装：若无原生 seed 但传入了 history（兼容无 parentSession 单测），则补充 Current Conversation History
      let prompt = MEMORY_REVIEW_PROMPT_TEMPLATE;
      if (
        (!seed || seed.length === 0) &&
        Array.isArray(sessionContext.history) &&
        sessionContext.history.length > 0
      ) {
        prompt = `${MEMORY_REVIEW_PROMPT_TEMPLATE}\n\n## Current Conversation History:\n${JSON.stringify(sessionContext.history, null, 2)}`;
      }

      const agentsService = this.ctx.get?.('agents') || (this.ctx as any).agents;
      if (agentsService?.create) {
        try {
          let reviewModelSelection: any = undefined;
          if (sessionContext.reviewModel) {
            reviewModelSelection = { model: sessionContext.reviewModel };
          } else if (this.config.reviewModel) {
            reviewModelSelection = { model: this.config.reviewModel };
          } else if (
            this.sessionManager &&
            typeof this.sessionManager.getModelSelection === 'function' &&
            parentSessionId
          ) {
            reviewModelSelection = this.sessionManager.getModelSelection(parentSessionId);
          }
          if (!reviewModelSelection) {
            reviewModelSelection = { model: sessionContext.mainModel };
          }

          const maxIterations = this.config.maxIterations || REVIEW_MAX_ITERATIONS;

          // DSH 官方原生 Fork 契约：设置 parentSession 与 isSeeded，origin 设为 'fork'，不挂载工作区
          agentHandle = await agentsService.create({
            sessionId: reviewSessionId,
            model: reviewModelSelection?.model,
            maxIterations,
            ...(seed !== undefined ? { seed, inheritedEventCount } : {}),
            meta: {
              isBackgroundReview: true,
              origin: 'fork',
              parentSession: parentSessionId,
              ...(parentCwd ? { cwd: parentCwd } : {}),
              ...(seed !== undefined ? { isSeeded: true } : {}),
              allowedTools: ALLOWED_MEMORY_REVIEW_TOOLS,
              maxIterations,
            },
            agentOptions: {
              provider: reviewModelSelection?.provider,
              model: reviewModelSelection?.model,
            },
          });

          const agentObj = agentHandle?.agent || agentHandle;

          if (!run.beginRequest(agentObj)) {
            return {
              executed: false,
              peer,
              message: 'Background review was cancelled before execution.',
            };
          }

          if (agentObj && typeof agentObj.followup === 'function') {
            const userMsg = {
              content: [{ type: 'text', text: prompt }],
              source: { kind: 'user' },
            };
            try {
              agentObj.followup(userMsg);
            } catch {
              agentObj.followup(prompt);
            }

            if (typeof agentObj.whenIdle === 'function') {
              await agentObj.whenIdle();
            }
          }
        } catch (err: any) {
          if (run.isCancelRequested) {
            this.logger.info?.(`[BackgroundReview] Review aborted gracefully: ${err?.message}`);
          } else {
            this.logger.warn?.(`[BackgroundReview] Subagent fork warning: ${err?.message}`);
          }
        }
      }

      const actions = [...run.actions];
      const memoryUpdated = actions.length > 0;
      const summary = summarizeMemoryReviewActions(actions);

      if (memoryUpdated && summary) {
        if (this.ctx && typeof (this.ctx as any).emit === 'function') {
          (this.ctx as any).emit('memory/review/notify', {
            peer,
            summary,
            actions,
          });
        }
      }

      return {
        executed: true,
        peer,
        memoryUpdated,
        summary,
        actions,
        message: summary || 'Background review completed with nothing to save.',
      };
    } finally {
      await this.cleanupReviewSession(
        reviewSessionId,
        agentHandle,
        parentSession
      ).catch((err) => {
        this.logger.warn?.(`[BackgroundReview] Cleanup error for ${reviewSessionId}: ${err?.message}`);
      });
      this.finishReviewRun(peer, run);
    }
  }

  /**
   * 物理删除已完成的 Review Session（用完即焚）
   */
  public async cleanupReviewSession(
    sessionId: string,
    agentHandle?: any,
    parentSession?: any,
    parentWorkspace?: any
  ): Promise<void> {
    try {
      // 1. 实时会话持久化与分离
      const sessions = this.ctx.get?.('sessions') || (this.ctx as any).sessions;
      const live = sessions?.get?.(sessionId);
      if (live) {
        try {
          if (typeof sessions.flush === 'function') {
            await sessions.flush(live);
          }
          if (typeof sessions.detachEntered === 'function') {
            const entry =
              typeof sessions.liveEntryFor === 'function' ? sessions.liveEntryFor(live) : live;
            await sessions.detachEntered(entry);
          }
        } catch (err: any) {
          this.logger.warn?.(`[BackgroundReview] sessions flush/detach warning: ${err?.message}`);
        }
      }

      // 2. 投影缓存清理
      const projCache =
        this.ctx.get?.('sessionProjectionCache') || (this.ctx as any).sessionProjectionCache;
      if (projCache) {
        try {
          await projCache.whenIdle?.();
          await projCache.delete?.(sessionId);
        } catch (err: any) {
          this.logger.warn?.(`[BackgroundReview] projCache delete warning: ${err?.message}`);
        }
      }

      // 3. Spill 临时目录清理
      const spill = this.ctx.get?.('spillStore') || (this.ctx as any).spillStore;
      if (spill?.root) {
        try {
          const spillDir = path.join(
            spill.root,
            `session-${createHash('sha256').update(sessionId).digest('hex').slice(0, 12)}`
          );
          await rm(spillDir, { recursive: true, force: true }).catch(() => {});
        } catch {}
      }

      // 4. 物理文件删除
      let sessionPath: string | undefined;
      if (typeof parentSession === 'string') {
        sessionPath = parentSession;
      }

      const persistence =
        this.ctx.get?.('sessionPersistence') || (this.ctx as any).sessionPersistence;
      if (!sessionPath && persistence && typeof persistence.locate === 'function') {
        try {
          const loc = persistence.locate({
            id: sessionId,
            cwd: parentSession?.header?.cwd || parentSession?.cwd,
          });
          if (loc?.path) {
            sessionPath = path.dirname(loc.path);
          }
        } catch {}
      }

      if (!sessionPath) {
        const baseSessionsDir = (this as any).dshHome
          ? path.join((this as any).dshHome, 'sessions')
          : path.join(os.homedir(), '.dsh', 'sessions');
        try {
          const dirs = await fsp.readdir(baseSessionsDir).catch(() => [] as string[]);
          for (const d of dirs) {
            const candidate = path.join(baseSessionsDir, d, sessionId);
            try {
              const st = await fsp.stat(candidate);
              if (st.isDirectory()) {
                sessionPath = candidate;
                break;
              }
            } catch {}
          }
        } catch {}
      }

      if (sessionPath) {
        await rm(sessionPath, { recursive: true, force: true }).catch((err) => {
          this.logger.warn?.(`[BackgroundReview] rm sessionPath warning: ${err?.message}`);
        });
      }

      // 5. 工作区解绑与记账清理
      if (parentWorkspace && typeof parentWorkspace.detachSession === 'function') {
        try {
          await parentWorkspace.detachSession(sessionId).catch(() => {});
        } catch {}
      }

      const wsRegistry =
        this.ctx.get?.('workspaceRegistry') || (this.ctx as any).workspaceRegistry;
      if (wsRegistry) {
        try {
          if (wsRegistry.headers && typeof wsRegistry.headers.delete === 'function') {
            wsRegistry.headers.delete(sessionId);
            wsRegistry.sessionPaths?.delete(sessionId);
            wsRegistry.invalidSessionPaths?.delete(sessionId);
          }
          if (typeof wsRegistry.list === 'function') {
            const workspaces = wsRegistry.list() || [];
            for (const ws of workspaces) {
              if (ws && Array.isArray(ws.sessionIds) && ws.sessionIds.includes(sessionId)) {
                if (typeof ws.detachSession === 'function') {
                  await ws.detachSession(sessionId).catch(() => {});
                }
              }
            }
          }
        } catch (err: any) {
          this.logger.warn?.(`[BackgroundReview] workspaceRegistry cleanup warning: ${err?.message}`);
        }
      }

      // 6. 释放 AgentHandle
      if (agentHandle && typeof agentHandle.dispose === 'function') {
        await agentHandle.dispose().catch(() => {});
      }
    } catch (error: any) {
      this.logger.warn?.(`[BackgroundReview] cleanupReviewSession error: ${error?.message}`);
    }
  }

  /**
   * session/event turn/end 钩子调用入口
   */
  public async onTurnFinished(
    sessionContext: ReviewSessionContext,
    toolCallsCount = 0
  ): Promise<ReviewResult | null> {
    const rawPeer = sessionContext.peer || sessionContext.sessionId || 'default';
    const check = this.recordTurn(rawPeer, toolCallsCount);
    if (!check.shouldReview) {
      return null;
    }
    return this.runReview(rawPeer, sessionContext);
  }
}
