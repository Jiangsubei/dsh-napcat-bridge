/**
 * dsh-napcat-bridge: Background Review Manager (自动回顾管理器)
 * 在后台异步审视对话 Turns，自动提炼 QQ 群聊规则与用户画像偏好。
 * 严格对齐 Hermes 自动回顾架构：
 * - 门控检查 (Gating: turnsInterval / toolCallsInterval)
 * - 严格工具白名单沙箱 (仅开放 read_memory, create_memory, edit_memory, read_chat_history)
 * - 写保护红线 (Do NOT capture 5 类负面约束)
 * - 2 秒取消握手协议 (前台 turn 到来时立即释放，0 阻塞)
 */

import * as path from 'node:path';
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
import { resolveDshPath, encodeSegment } from '../utils/path.js';

export const ALLOWED_MEMORY_REVIEW_TOOLS: readonly string[] = [
  'read_memory',
  'create_memory',
  'edit_memory',
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
  dshHome?: string;
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
 * Hermes 对齐审查提示词模板 (适配 QQ 群聊与私聊两层记忆体系，严格遵循高信号与容量安全原则)
 */
export const MEMORY_REVIEW_PROMPT_TEMPLATE = `# Memory Review & Distillation Agent

Review the conversation above and consider saving durable facts to persistent memory if appropriate.

## Focus Areas (两层长期记忆):
1. **User Profile (type='user', qq='...')**:
   - 用户的持久人设、工作风格、技术栈、沟通/记忆偏好、对你的长期期望与习惯。
2. **Session Rules & Culture (type='session', peer='...')**:
   - 会话/群聊的通用规则、长期约定与禁忌话题；
   - **长期稳定的群梗、代号外号、固定互动剧本与群内黑话文化**（此类内容是维系群体氛围与情感连接的核心，应当保留，但必须极度精简，一句话说清对应关系或触发契机，例如 “某暗号触发某类特定回复剧本” 或 “特定技术/术语的固定戏称”）。

## Strict Guidelines (精炼与高信号铁律):
- **Compact & High-Signal**: 记忆在后续每轮都会注入上下文，必须保持极度紧凑。
- **单行陈述事实**: 每条记录必须为单行简短陈述事实（推荐 30~80 字，如 \`- 偏好：xxx\` 或 \`- 梗/互动：xxx\`）。**严禁编写叙事性段落，严禁记录会话背景故事、具体排查流水账、单次测试细节或长篇复盘**。
- **Consolidation (合并与精简优先)**:
  - 遇到已有相似或相关条目，**必须使用 \`edit_memory\` 进行提炼融合或更新，严禁无意义堆叠追加**；
  - 发现已有记忆中存在过时、失效、冗长或琐碎的内容，主动使用 \`edit_memory\` 精简删减（保持文件体积在容量安全线内）；
  - 工具设有字符预算硬上限，若写入超限工具会直接拒绝并返回当前用量与错误提示，届时必须通过 \`edit_memory\` 精简合并或删除旧条目。

## What to SKIP (禁止记录项):
- **任务执行过程与排查方法 (How-to & Procedures)**: 本系统不维护操作手册或技术规程。命令参数、执行步骤、调试排查流程、单次问题解决结论严格属于会话即时上下文，严禁存入记忆；
- **一次性任务与技术排查**: 某次模型单次跑分、接口调试过程、临时报错分析、限时促销活动/价格变动等（这些属于会话内瞬时信息）；
- **瞬时社交与无意义水群**: 路过新面孔打招呼、随口客套、单次复读、打卡摸鱼、一过性戏谑、无后续共识的一次性玩笑；
- **临时 TODO 与未解决失败**: 会话内已解决的瞬时问题、未验证的死胡同方案、容易重新查验的公开信息；
- **5 类环境/工具负面约束 (Do NOT capture)**:
  • Environment-dependent failures: missing binaries, fresh-install errors, post-migration path mismatches, 'command not found', unconfigured credentials, uninstalled packages. The user can fix these — they are not durable rules.
  • Negative claims about tools or features ('browser tools do not work', 'X tool is broken', 'cannot use Y from execute_code'). These harden into refusals the agent cites against itself for months after the actual problem was fixed.
  • Session-specific transient errors that resolved before the conversation ended. If retrying worked, the lesson is the retry pattern, not the original failure.
  • One-off task narratives. A user asking 'summarize today's market' or 'analyze this PR' is not a class of work that warrants a long-term rule.
  • Unresolved failures: if the session ended WITHOUT actually finding a working method — you tried several things, none worked, and told the user to check manually — do NOT write those attempts up as a 'reliable workflow' or 'recommended approach'. That presents an untested sequence of failures as validated guidance a future session will trust and repeat. Either say 'Nothing to save', or, only if you are independently confident of a real working alternative, capture ONLY that alternative — never the dead ends, and never dressed up as best practice.

## Stopping Condition:
If the conversation was ordinary chatting, one-off task execution, or produced no durable facts/preferences/stable culture worth remembering, **just say 'Nothing to save.' and stop immediately**. 'Nothing to save.' is the normal and expected outcome for most regular turns.

## Available Memory Tools:
- \`read_memory(type='session'|'user', peer='...', qq='...')\`: 读取现有记忆内容以供比对与定位编辑点。
- \`create_memory(type='session'|'user', content='...', peer='...', qq='...')\`: 仅在文件不存在时首次创建。
- \`edit_memory(type='session'|'user', old_string='...', new_string='...', peer='...', qq='...')\`: 精确定向修改、合并条目，或将 new_string 设为空/省略以删除过时片段。
`;

export class BackgroundReviewManager {
  private config: BackgroundReviewConfig;
  private readonly dshHome: string;
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
    this.dshHome = resolveDshPath(config.dshHome);
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
    let parentWorkspace: any = undefined;

    let unlistenMemoryChange: (() => void) | undefined;
    if (this.ctx && typeof (this.ctx as any).on === 'function') {
      unlistenMemoryChange = (this.ctx as any).on('memory/change', (change: any) => {
        if (change?.message) {
          run.actions.push(change.message);
          run.details.memoryChanges.push(change.message);
        }
      });
    }

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

      // 提示词组装：包含 peer 上下文指引；若无原生 seed 但传入了 history（兼容无 parentSession 单测），则补充 Current Conversation History
      let prompt = `${MEMORY_REVIEW_PROMPT_TEMPLATE}\n\n## Context\nYou are reviewing peer: ${peer}\nWhen calling memory tools, always pass peer='${peer}' explicitly.`;
      if (
        (!seed || seed.length === 0) &&
        Array.isArray(sessionContext.history) &&
        sessionContext.history.length > 0
      ) {
        prompt += `\n\n## Current Conversation History:\n${JSON.stringify(sessionContext.history, null, 2)}`;
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
              // 注意：DSH validateSessionHeader 要求 origin 必须是 "subagent" 或「不传」。
              // 传任何其他值(如 'fork')都会在 create 时抛 "origin must be subagent"。
              // 这里不传 origin —— 通过校验，且 WebUI 侧 `origin !== 'subagent'` 不会把它当子代理显示。
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

          // 挂载到工作区：使后台回顾在运行期间正常显示在工作区侧边栏
          const wsRegistry = this.ctx.get?.('workspaceRegistry') || (this.ctx as any).workspaceRegistry;
          if (wsRegistry && parentCwd) {
            try {
              if (typeof wsRegistry.resolveByPath === 'function') {
                parentWorkspace = await wsRegistry.resolveByPath(parentCwd);
              }
              if (!parentWorkspace && typeof wsRegistry.list === 'function') {
                const list = wsRegistry.list() || [];
                parentWorkspace = list.find((ws: any) => ws?.path === parentCwd);
              }
              if (parentWorkspace && typeof parentWorkspace.attachSession === 'function') {
                await parentWorkspace.attachSession(reviewSessionId);
              }
            } catch (err: any) {
              this.logger.warn?.(`[BackgroundReview] attachSession warning: ${err?.message}`);
            }
          }

          // 标记 WebUI 会话标题，明确标识为 Background Review
          const sessionTitleSvc = this.ctx.get?.('sessionTitle') || (this.ctx as any).sessionTitle;
          const targetSession = agentObj?.session || (agentHandle as any)?.session;
          if (sessionTitleSvc && typeof sessionTitleSvc.rename === 'function' && targetSession) {
            try {
              const baseTitle = parentSession?.header?.title || parentSession?.title || peer;
              sessionTitleSvc.rename(targetSession, `${baseTitle} [Background Review]`);
            } catch {}
          }

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

      // 兜底：若 session 事件中有 create_memory / edit_memory 调用，确保 run.actions 记录
      try {
        const sess = agentHandle?.agent?.session || (agentHandle as any)?.session;
        if (sess && typeof sess.snapshotEvents === 'function' && run.actions.length === 0) {
          const revEvents = sess.snapshotEvents() || [];
          const toolCalls = revEvents.filter(
            (e: any) =>
              e?.type === 'tool/call' &&
              (e?.data?.name === 'create_memory' || e?.data?.name === 'edit_memory')
          );
          for (const tc of toolCalls) {
            const desc =
              tc.data?.name === 'create_memory'
                ? `已创建记忆 (${peer})`
                : `已编辑记忆 (${peer})`;
            run.actions.push(desc);
            run.details.memoryChanges.push(desc);
          }
        }
      } catch {}

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
      if (typeof unlistenMemoryChange === 'function') {
        try {
          unlistenMemoryChange();
        } catch {}
      }
      await this.cleanupReviewSession(
        reviewSessionId,
        agentHandle,
        parentSession,
        parentWorkspace
      ).catch((err) => {
        this.logger.warn?.(`[BackgroundReview] Cleanup error for ${reviewSessionId}: ${err?.message}`);
      });
      this.finishReviewRun(peer, run);
    }
  }

  /**
   * 物理删除已完成的 Review Session（用完即焚）
   * 严格对齐 DSH 0.1.5 销毁时序：内核锁释放先行 -> 内存与持久化解绑 -> 投影清理 -> Spill 清理 -> 工作区解绑 -> 最终物理删除
   */
  public async cleanupReviewSession(
    sessionId: string,
    agentHandle?: any,
    parentSession?: any,
    parentWorkspace?: any
  ): Promise<void> {
    try {
      // Step 1【首要步骤】：优先执行 await agentHandle.dispose()，停止循环、排空待写缓冲、彻底释放 session.lock 内核锁并解绑
      if (agentHandle && typeof agentHandle.dispose === 'function') {
        try {
          await agentHandle.dispose();
        } catch (err: any) {
          this.logger.warn?.(`[BackgroundReview] agentHandle.dispose warning: ${err?.message}`);
        }
      }

      // Step 2：内存 Session 清理与持久化解绑（sessions.detachEntered 防御性清理）
      const sessions = this.ctx.get?.('sessions') || (this.ctx as any).sessions;
      if (sessions) {
        try {
          const live = sessions.get?.(sessionId);
          if (live) {
            if (typeof sessions.flush === 'function') {
              await sessions.flush(live);
            }
            if (typeof sessions.detachEntered === 'function') {
              const entry =
                typeof sessions.liveEntryFor === 'function' ? sessions.liveEntryFor(live) : live;
              await sessions.detachEntered(entry);
            }
          }
        } catch (err: any) {
          this.logger.warn?.(`[BackgroundReview] sessions flush/detach warning: ${err?.message}`);
        }
      }

      // Step 3：投影缓存清理（sessionProjectionCache.delete）
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

      // Step 4：Spill 临时目录清理（spillStore）
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

      // Step 5：工作区解绑与记账清理（workspaceRegistry 解绑）
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

      // Step 6【最后步骤】：物理文件与目录彻底删除（此时文件锁已完全释放，无任何死锁与占用风险）
      let sessionPath: string | undefined;
      if (typeof parentSession === 'string') {
        sessionPath = parentSession;
      }

      const persistence =
        this.ctx.get?.('sessionPersistence') || (this.ctx as any).sessionPersistence;
      if (!sessionPath && persistence && typeof (persistence as any).locate === 'function') {
        try {
          const loc = (persistence as any).locate({
            id: sessionId,
            cwd: parentSession?.header?.cwd || parentSession?.cwd,
          });
          if (loc?.path) {
            sessionPath = path.dirname(loc.path);
          }
        } catch {}
      }

      if (!sessionPath) {
        let encodedId: string;
        try {
          encodedId = encodeSegment(sessionId);
        } catch {
          encodedId = sessionId;
        }

        const baseSessionsDir = path.join(this.dshHome, 'sessions');
        try {
          const dirs = await fsp.readdir(baseSessionsDir).catch(() => [] as string[]);
          for (const d of dirs) {
            const candidates = [
              path.join(baseSessionsDir, d, encodedId),
              ...(encodedId !== sessionId ? [path.join(baseSessionsDir, d, sessionId)] : []),
            ];
            for (const candidate of candidates) {
              try {
                const st = await fsp.stat(candidate);
                if (st.isDirectory()) {
                  sessionPath = candidate;
                  break;
                }
              } catch {}
            }
            if (sessionPath) break;
          }
        } catch {}
      }

      if (sessionPath) {
        await rm(sessionPath, { recursive: true, force: true }).catch((err) => {
          this.logger.warn?.(`[BackgroundReview] rm sessionPath warning: ${err?.message}`);
        });
      }
    } catch (error: any) {
      this.logger.warn?.(`[BackgroundReview] cleanupReviewSession error: ${error?.message}`);
    }
  }

  /**
   * 销毁临时回顾会话（destroyTemporarySession，内核锁释放先行，对齐 cleanupReviewSession）
   */
  public async destroyTemporarySession(
    sessionId: string,
    agentHandle?: any,
    parentSession?: any,
    parentWorkspace?: any
  ): Promise<void> {
    return this.cleanupReviewSession(sessionId, agentHandle, parentSession, parentWorkspace);
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
