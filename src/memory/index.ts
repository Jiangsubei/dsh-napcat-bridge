/**
 * dsh-napcat-bridge: Memory 插件核心模块
 * 组合 MemoryStorage 与 MemoryTools。
 * 动态提示词快照统一接入 SnapshotManager，全面贯彻 Fail-Closed 白名单防御。
 */

import type { Context } from '@deepseek-ai/cordis';
import type { MessageDatabase } from '../storage/database.js';
import type { SessionManager } from '../gateway/session.js';
import { MemoryStorage } from './storage.js';
import { MemoryTools, createMemoryToolDefinitions } from './tools.js';
import { SnapshotManager } from '../prompt/snapshot.js';
import {
  DEFAULT_USER_PROFILE_BUDGET_CHARS,
  DEFAULT_SESSION_MEMORY_BUDGET_CHARS,
  DEFAULT_GROUP_MEMORY_TOTAL_BUDGET_CHARS,
} from '../constants/index.js';
import { resolveDshPath } from '../utils/path.js';

export * from './types.js';
export * from './storage.js';
export * from './tools.js';

export interface MemoryBudgetOptions {
  /** 群聊注入时所有活跃用户画像合计的总预算 */
  getGroupUserProfilesBudget?: () => number;
}

export interface MemoryServiceOptions {
  storageDir?: string;
  dshHome?: string;
  /** 单个用户画像文件的写入上限 */
  userProfileBudgetChars?: number;
  /** 单个 Session 规则文件的写入上限 */
  sessionMemoryBudgetChars?: number;
  /** 群聊注入时所有活跃用户画像合计的总预算 */
  groupMemoryTotalBudgetChars?: number;
  getUserProfileBudgetChars?: () => number;
  getSessionMemoryBudgetChars?: () => number;
  getGroupMemoryTotalBudgetChars?: () => number;
  getCurrentSpeaker?: (peer: string) => string | undefined;
  db?: MessageDatabase;
  sessionManager?: SessionManager;
  /** 是否向 root ctx.tools 注册全局 Memory 工具（默认 true；在配合预设架构时传入 false 隔离 Web 会话） */
  registerGlobalTools?: boolean;
  /** 是否向 root ctx 注册动态提示词段（默认 true；在配合统一 SnapshotHub 装配时传入 false） */
  registerPromptContext?: boolean;
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

  const getUserProfileBudget = () =>
    options.getUserProfileBudgetChars?.() ??
    options.userProfileBudgetChars ??
    DEFAULT_USER_PROFILE_BUDGET_CHARS;

  const getSessionMemoryBudget = () =>
    options.getSessionMemoryBudgetChars?.() ??
    options.sessionMemoryBudgetChars ??
    DEFAULT_SESSION_MEMORY_BUDGET_CHARS;

  const getGroupUserProfilesBudget = () =>
    options.getGroupMemoryTotalBudgetChars?.() ??
    options.groupMemoryTotalBudgetChars ??
    DEFAULT_GROUP_MEMORY_TOTAL_BUDGET_CHARS;

  const tools = new MemoryTools(storage, ctx, {
    getUserProfileLimit: getUserProfileBudget,
    getSessionLimit: getSessionMemoryBudget,
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

  // 2. 统一通过 SnapshotManager 挂载 napcat:memory 动态上下文段 (Fail-Closed 安全白名单防护)
  if (options.registerPromptContext !== false) {
    const snapshotManager = new SnapshotManager(ctx, {
      getCurrentSpeaker: options.getCurrentSpeaker,
    });
    const promptDisposer = snapshotManager.registerProvider({
      name: 'napcat:memory',
      order: 40,
      provide: (session) => {
        const peer = session.peer;
        const currentQQ = session.qq !== 'default' ? session.qq : undefined;

        if (session.isPrivate) {
          return storage.getPromptSnapshotSync(
            peer,
            [{ qq: session.qq, name: session.qq }],
            DEFAULT_GROUP_MEMORY_TOTAL_BUDGET_CHARS,
            currentQQ
          );
        }

        let activeUsers: Array<{ qq: string; name: string }> = [];
        if (options.db) {
          try {
            const rows = options.db.getActiveUsers(peer, 7, 15);
            activeUsers = rows.map((r) => ({ qq: r.user_id, name: r.sender_name }));
          } catch {}
        }

        return storage.getPromptSnapshotSync(
          peer,
          activeUsers,
          getGroupUserProfilesBudget(),
          currentQQ
        );
      },
    });
    unregisters.push(promptDisposer);
  }

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
