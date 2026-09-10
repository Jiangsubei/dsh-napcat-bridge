/**
 * dsh-napcat-bridge: Memory 插件核心模块
 * 组合 MemoryStorage, MemoryTools, BackgroundReviewManager 与 SystemPrompt 动态段注入。
 */

import type { Context } from '@deepseek-ai/cordis';
import type { MessageDatabase } from '../storage/database.js';
import type { SessionManager } from '../gateway/session.js';
import { MemoryStorage } from './storage.js';
import { MemoryTools, createMemoryToolDefinitions, resolveContextPeerAndQQ } from './tools.js';
import { BackgroundReviewManager } from './review.js';
import {
  DEFAULT_MEMORY_BUDGET_CHARS,
  DEFAULT_GROUP_MEMORY_BUDGET_CHARS,
  DEFAULT_PRIVATE_MEMORY_BUDGET_CHARS,
  DEFAULT_REVIEW_ENABLED,
  DEFAULT_REVIEW_TURNS_INTERVAL,
  DEFAULT_REVIEW_TOOL_CALLS_INTERVAL,
} from '../constants/index.js';
import { resolveDshPath } from '../utils/path.js';

export * from './types.js';
export * from './storage.js';
export * from './tools.js';
export * from './review.js';

export interface MemoryBudgetOptions {
  getGroupBudget?: () => number;
  getPrivateBudget?: () => number;
}

export interface MemoryServiceOptions {
  storageDir?: string;
  dshHome?: string;
  budgetChars?: number;
  groupBudgetChars?: number;
  privateBudgetChars?: number;
  getGroupBudgetChars?: () => number;
  getPrivateBudgetChars?: () => number;
  reviewEnabled?: boolean;
  reviewTurnsInterval?: number;
  reviewToolCallsInterval?: number;
  reviewModel?: string;
  db?: MessageDatabase;
  sessionManager?: SessionManager;
}

export function registerMemoryPromptContext(
  ctx: Context,
  storage: MemoryStorage,
  db?: MessageDatabase,
  budgetInput: (() => number) | MemoryBudgetOptions = () => DEFAULT_MEMORY_BUDGET_CHARS
): () => void {
  const systemPrompt = ctx.get('systemPrompt') || (ctx as any).systemPrompt;
  if (!systemPrompt || typeof systemPrompt.context !== 'function') {
    return () => {};
  }

  return systemPrompt.context({
    name: 'napcat:memory',
    order: 40,
    text: (assembleCtx?: any) => {
      const resolved = resolveContextPeerAndQQ(assembleCtx);
      const peer = resolved.peer;

      const isQQSession = Boolean(
        peer &&
          (peer.startsWith('group_') ||
            peer.startsWith('user_') ||
            peer.startsWith('qq-group-') ||
            peer.startsWith('qq-user-') ||
            peer.startsWith('qq-'))
      );

      if (!peer || !isQQSession || peer === 'default') {
        return '';
      }

      const isPrivate = peer.startsWith('user_') || peer.startsWith('qq-user-');
      let budget: number;
      if (typeof budgetInput === 'function') {
        budget = budgetInput() || DEFAULT_MEMORY_BUDGET_CHARS;
      } else {
        budget = isPrivate
          ? (budgetInput.getPrivateBudget?.() ?? DEFAULT_PRIVATE_MEMORY_BUDGET_CHARS)
          : (budgetInput.getGroupBudget?.() ?? DEFAULT_GROUP_MEMORY_BUDGET_CHARS);
      }

      if (isPrivate) {
        // 私聊：直接传入单用户，无 7 天活跃限制
        return storage.getPromptSnapshotSync(peer, [{ qq: resolved.qq, name: resolved.qq }], budget);
      }

      // 群聊：从 SQLite 查询近 7 天活跃发言用户列表 (按发言时间倒序)
      let activeUsers: Array<{ qq: string; name: string }> = [];
      if (db) {
        try {
          const rows = db.getActiveUsers(peer, 7, 15);
          activeUsers = rows.map((r) => ({ qq: r.user_id, name: r.sender_name }));
        } catch {}
      }

      return storage.getPromptSnapshotSync(peer, activeUsers, budget);
    },
  });
}

export function setupMemoryService(
  ctx: Context,
  options: MemoryServiceOptions
): {
  storage: MemoryStorage;
  tools: MemoryTools;
  reviewManager: BackgroundReviewManager;
  dispose: () => void;
} {
  const effectiveDshHome = resolveDshPath(options.dshHome);
  const storage = new MemoryStorage(options.storageDir, effectiveDshHome);

  const getGroupBudget = () =>
    options.getGroupBudgetChars?.() ??
    options.groupBudgetChars ??
    options.budgetChars ??
    DEFAULT_GROUP_MEMORY_BUDGET_CHARS;

  const getPrivateBudget = () =>
    options.getPrivateBudgetChars?.() ??
    options.privateBudgetChars ??
    options.budgetChars ??
    DEFAULT_PRIVATE_MEMORY_BUDGET_CHARS;

  const tools = new MemoryTools(storage, ctx, {
    getUserLimit: getPrivateBudget,
    getSessionLimit: getGroupBudget,
  });

  const reviewManager = new BackgroundReviewManager(
    ctx,
    {
      enabled: options.reviewEnabled ?? DEFAULT_REVIEW_ENABLED,
      turnsInterval: options.reviewTurnsInterval ?? DEFAULT_REVIEW_TURNS_INTERVAL,
      toolCallsInterval: options.reviewToolCallsInterval ?? DEFAULT_REVIEW_TOOL_CALLS_INTERVAL,
      storageDir: storage.getBaseDir(),
      dshHome: effectiveDshHome,
      reviewModel: options.reviewModel,
      db: options.db,
      sessionManager: options.sessionManager,
    },
    storage
  );

  const unregisters: Array<() => void> = [];

  // 1. 注册 3 个 Memory Agent 工具到 DSH ctx.tools
  const doRegisterTools = (toolsService: any) => {
    if (!toolsService || typeof toolsService.register !== 'function') return;
    const defs = createMemoryToolDefinitions(tools);
    for (const def of defs) {
      if (typeof toolsService.get === 'function' && toolsService.get(def.name)) {
        continue;
      }
      unregisters.push(toolsService.register(def));
    }
  };

  const initialTools = ctx.get('tools') || (ctx as any).tools;
  if (initialTools) {
    doRegisterTools(initialTools);
  }

  (ctx as any).on?.('ready', () => {
    const readyTools = ctx.get('tools') || (ctx as any).tools;
    if (readyTools) doRegisterTools(readyTools);
  });

  // 2. 注册 systemPrompt.context 动态记忆段
  const promptDisposer = registerMemoryPromptContext(
    ctx,
    storage,
    options.db,
    {
      getGroupBudget,
      getPrivateBudget,
    }
  );
  unregisters.push(promptDisposer);

  // 3. 监听 session/event 驱动后台自动回顾
  const eventDisposer = (ctx as any).on?.('session/event', async (session: any, event: any) => {
    if (!session || !session.id || !event) return;
    const sessionId = String(session.id);

    // 过滤回顾子代理自身会话
    if (
      sessionId.startsWith('review-') ||
      session.meta?.isBackgroundReview ||
      session.options?.meta?.isBackgroundReview
    ) {
      return;
    }

    // 只处理 QQ 会话：qq-group-/qq-user-/qq- 或 group_/user_。
    // 否则 WebUI 等非 QQ 会话会被误判为 peer='default'，触发后台回顾（真 bug）。
    if (!/^(?:qq-group-|qq-user-|qq-|group_|user_)/.test(sessionId)) {
      return;
    }

    const resolved = resolveContextPeerAndQQ(session);
    let peer = resolved.peer;
    // 修复：resolveContextPeerAndQQ 为工具 exec 设计，raw Session 对象会被
    // `anyCtx.session || anyCtx.agent?.session` 抢先取到错误对象 → peer 误判为 default。
    // 这里直接基于 session.id 重新解析 peer（qq-group-/qq-user-/group_/user_ 前缀）。
    {
      const sid = String(session.id || '');
      const g = sid.match(/^(?:qq-group-|group_)(\d+)/);
      const u = sid.match(/^(?:qq-user-|user-|qq-)(\d+)/);
      if (g) peer = `group_${g[1]}`;
      else if (u) peer = `user_${u[1]}`;
    }
    if (event.type === 'turn/start') {
      try {
        await reviewManager.cancelReviewForLiveTurn(peer);
      } catch {}
    } else if (event.type === 'turn/end') {
      let toolCallsCount = 0;
      if (typeof session.snapshotEvents === 'function') {
        try {
          const events = session.snapshotEvents() || [];
          const currentTurn = event.data?.turn;
          let lastTurnStartSeq = -1;
          for (let i = events.length - 1; i >= 0; i--) {
            if (events[i]?.type === 'turn/start') {
              lastTurnStartSeq = events[i].seq;
              break;
            }
          }
          toolCallsCount = events.filter((e: any) =>
            e?.type === 'tool/call' &&
            (currentTurn !== undefined
              ? e.data?.turn === currentTurn
              : (lastTurnStartSeq >= 0 ? e.seq >= lastTurnStartSeq : true) && e.seq <= event.seq)
          ).length;
        } catch {}
      }

      if (toolCallsCount === 0) {
        if (typeof event.data?.toolCallsCount === 'number') {
          toolCallsCount = event.data.toolCallsCount;
        } else if (Array.isArray(event.data?.tool_calls)) {
          toolCallsCount = event.data.tool_calls.length;
        }
      }

      const mainModel = session.options?.model || session.model;

      reviewManager
        .onTurnFinished(
          {
            peer,
            sessionId,
            mainModel,
            parentSession: session,
          },
          toolCallsCount
        )
        .catch(() => {});
    }
  });

  if (typeof eventDisposer === 'function') {
    unregisters.push(eventDisposer);
  }

  return {
    storage,
    tools,
    reviewManager,
    dispose: () => {
      for (const unreg of unregisters) {
        try {
          unreg();
        } catch {}
      }
    },
  };
}
