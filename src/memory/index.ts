/**
 * dsh-napcat-bridge: Memory 插件核心模块
 * 组合 MemoryStorage, MemoryTools 与 SystemPrompt 动态段注入。
 */

import type { Context } from '@deepseek-ai/cordis';
import type { MessageDatabase } from '../storage/database.js';
import type { SessionManager } from '../gateway/session.js';
import { MemoryStorage } from './storage.js';
import { MemoryTools, createMemoryToolDefinitions, resolveContextPeerAndQQ } from './tools.js';
import {
  DEFAULT_MEMORY_BUDGET_CHARS,
  DEFAULT_GROUP_MEMORY_BUDGET_CHARS,
  DEFAULT_PRIVATE_MEMORY_BUDGET_CHARS,
} from '../constants/index.js';
import { resolveDshPath } from '../utils/path.js';

export * from './types.js';
export * from './storage.js';
export * from './tools.js';

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
  getCurrentSpeaker?: (peer: string) => string | undefined;
  db?: MessageDatabase;
  sessionManager?: SessionManager;
  /** 是否向 root ctx.tools 注册全局 Memory 工具（默认 true；在配合预设架构时传入 false 隔离 Web 会话） */
  registerGlobalTools?: boolean;
}

export function registerMemoryPromptContext(
  ctx: Context,
  storage: MemoryStorage,
  db?: MessageDatabase,
  budgetInput: (() => number) | MemoryBudgetOptions = () => DEFAULT_MEMORY_BUDGET_CHARS,
  getCurrentSpeaker?: (peer: string) => string | undefined
): () => void {
  const systemPrompt = typeof (ctx as any).get === 'function' ? (ctx as any).get('systemPrompt') : undefined;
  if (!systemPrompt || typeof systemPrompt.context !== 'function') {
    return () => {};
  }

  return systemPrompt.context({
    name: 'napcat:memory',
    order: 40,
    text: (assembleCtx?: any) => {
      const resolved = resolveContextPeerAndQQ(assembleCtx, getCurrentSpeaker);
      const peer = resolved.peer;
      const currentQQ = resolved.qq !== 'default' ? resolved.qq : (getCurrentSpeaker ? getCurrentSpeaker(peer) : undefined);

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
        return storage.getPromptSnapshotSync(
          peer,
          [{ qq: resolved.qq, name: resolved.qq }],
          budget,
          currentQQ
        );
      }

      // 群聊：从 SQLite 查询近 7 天活跃发言用户列表 (按发言时间倒序)
      let activeUsers: Array<{ qq: string; name: string }> = [];
      if (db) {
        try {
          const rows = db.getActiveUsers(peer, 7, 15);
          activeUsers = rows.map((r) => ({ qq: r.user_id, name: r.sender_name }));
        } catch {}
      }

      return storage.getPromptSnapshotSync(peer, activeUsers, budget, currentQQ);
    },
  });
}

export function setupMemoryService(
  ctx: Context,
  options: MemoryServiceOptions
): {
  storage: MemoryStorage;
  tools: MemoryTools;
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
    getSessionLimitFor: (peer: string) => {
      const isPrivate = peer.startsWith('user_') || peer.startsWith('qq-user-');
      return isPrivate ? getPrivateBudget() : getGroupBudget();
    },
  });

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

  if (options.registerGlobalTools !== false) {
    const initialTools = typeof (ctx as any).get === 'function' ? (ctx as any).get('tools') : undefined;
    if (initialTools) {
      doRegisterTools(initialTools);
    }

    const checkReadyTools = () => {
      const readyTools = typeof (ctx as any).get === 'function' ? (ctx as any).get('tools') : undefined;
      if (readyTools) doRegisterTools(readyTools);
    };
    const appReady = typeof (ctx as any).get === 'function' ? (ctx as any).get('appReady') : undefined;
    if (appReady && typeof appReady.onReady === 'function') {
      appReady.onReady(checkReadyTools);
    }
    (ctx as any).on?.('ready', checkReadyTools);
  }

  // 2. 注册 systemPrompt.context 动态记忆段
  const promptDisposer = registerMemoryPromptContext(
    ctx,
    storage,
    options.db,
    {
      getGroupBudget,
      getPrivateBudget,
    },
    options.getCurrentSpeaker
  );
  unregisters.push(promptDisposer);

  return {
    storage,
    tools,
    dispose: () => {
      for (const unreg of unregisters) {
        try {
          unreg();
        } catch {}
      }
    },
  };
}
