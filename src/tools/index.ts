/**
 * dsh-napcat-bridge: Agent 工具集聚合门面
 *
 * 聚合导出所有领域工具工厂、执行逻辑及类型定义，
 * 并提供 registerAgentTools 统一装配管线。
 */

import type { Context } from '@deepseek-ai/cordis';
import type { BridgePluginConfig } from '../types/index.js';
import { resolveDshPath } from '../utils/path.js';
import { DEFAULT_FACE_STORE_DIR } from '../constants/index.js';

// 1. 公共基础设施
export * from './common/context.js';
export * from '../utils/lossless-json.js';
export * from './pagination.js';
export { normalizePeer } from './common/context.js';

// 2. 领域工具集 Re-export
export * from './messaging/index.js';
export * from './chat-history/index.js';
export * from './face/index.js';
export * from './qzone/index.js';
export * from './contact/index.js';
export * from './agent-ipc/index.js';
export * from './resource/index.js';
export * from './file-source.js';
export * from './private-file.js';
export * from './group-file-resolve.js';
export * from './scheduler.js';
export * from './memory/index.js';
export * from './slang/index.js';
export { SlangStorage } from '../slang/index.js';

// 3. 内部装配依赖
import {
  type AgentToolsOptions,
  setGlobalToolContext,
  getGlobalToolContext,
} from './common/context.js';
import {
  createReadChatHistoryTool,
  createExpandForwardMessageTool,
  createWaitForUserMessagesTool,
} from './chat-history/index.js';
import {
  createFetchChatResourceTool,
  createSendFileTool,
  createListGroupFilesTool,
} from './resource/index.js';
import {
  createSendQqMessageTool,
  createRecallMessageTool,
  createReactMessageTool,
  createPokeUserTool,
} from './messaging/index.js';
import {
  createListFacesTool,
  createSendFaceTool,
  createCollectFaceTool,
  createManageFacesTool,
} from './face/index.js';
import {
  createScheduleTaskTool,
  createManageScheduledTasksTool,
} from './scheduler.js';
import { createSlangToolDefinitions } from './slang/index.js';
import { SlangStorage } from '../slang/index.js';
import {
  createReadQzoneFeedsTool,
  createPublishQzoneFeedTool,
  createCommentQzoneFeedTool,
  createDeleteQzoneFeedTool,
} from './qzone/index.js';
import {
  createGetFriendListTool,
  createGetGroupListTool,
  createGetUserProfileTool,
  createGetGroupInfoTool,
  createGetGroupNoticeTool,
  createGetGroupMemberInfoTool,
} from './contact/index.js';
import {
  createListActiveAgentsTool,
  createCreateTargetAgentTool,
  createSendAgentMessageTool,
} from './agent-ipc/index.js';

/**
 * 注册 Agent 工具集至 DSH 工具运行时 (ctx.tools)
 */
export function registerAgentTools(
  ctx: Context,
  options: AgentToolsOptions
): () => void {
  const getConfig = (): BridgePluginConfig => {
    if (typeof (options as any).config === 'function') {
      return (options as any).config() || {};
    }
    if (typeof (options as any).configGetter === 'function') {
      return (options as any).configGetter() || {};
    }
    if ((options as any).config && typeof (options as any).config === 'object') {
      return (options as any).config;
    }
    return {};
  };

  const currentCfg = getConfig();

  setGlobalToolContext({
    db: options.db,
    gateway: options.gateway,
    mediaManager: options.mediaManager,
    sender: options.sender,
    dshHome: options.dshHome,
    waitRegistry: options.waitRegistry,
    inboundMsgIdGetter: options.inboundMsgIdGetter,
    faceDir: resolveDshPath(options.dshHome, currentCfg.face_store_dir, DEFAULT_FACE_STORE_DIR),
    faceSubType: currentCfg.face_sub_type,
    faceStoreMax: currentCfg.face_store_max,
    faceEvictPolicy: currentCfg.face_evict_policy,
    scheduler: options.scheduler,
    sessionManager: options.sessionManager || (ctx as any).sessionManager || (ctx as any).get?.('sessionManager'),
    config: options.config,
  });

  const unregisters: Array<() => void> = [];

  const doRegister = (tools: any) => {
    if (!tools || typeof tools.register !== 'function' || unregisters.length > 0) {
      return;
    }

    // 1. read_chat_history
    unregisters.push(tools.register(createReadChatHistoryTool(options)));

    // 2. fetch_chat_resource
    unregisters.push(tools.register(createFetchChatResourceTool(options)));

    // 3. expand_forward_message
    unregisters.push(tools.register(createExpandForwardMessageTool(options)));

    // 4. send_file
    unregisters.push(tools.register(createSendFileTool(options)));

    // 5. poke_user
    unregisters.push(tools.register(createPokeUserTool(options)));

    // 6. list_group_files
    unregisters.push(tools.register(createListGroupFilesTool(options)));

    // 7. wait_for_user_messages (EN-005)
    unregisters.push(tools.register(createWaitForUserMessagesTool(options)));

    // 8. react_message
    unregisters.push(tools.register(createReactMessageTool(options)));

    // 9. send_qq_message
    unregisters.push(tools.register(createSendQqMessageTool(options)));

    // 10. recall_message
    unregisters.push(tools.register(createRecallMessageTool(options)));

    // 11. 表情包能力 (由 face_enabled 总开关前置门控)
    if (getConfig().face_enabled) {
      unregisters.push(tools.register(createListFacesTool(options)));
      unregisters.push(tools.register(createSendFaceTool(options)));
      unregisters.push(tools.register(createCollectFaceTool(options)));
      unregisters.push(tools.register(createManageFacesTool(options)));
    }

    // 12. schedule_task
    unregisters.push(
      tools.register(
        createScheduleTaskTool(() => {
          const g = getGlobalToolContext();
          return {
            scheduler: options.scheduler || g.scheduler,
            peer: g.peer,
          };
        })
      )
    );

    // 13. 黑话学习工具集 (由 slang_enabled 总开关前置门控，默认开启)
    if (getConfig().slang_enabled !== false) {
      const storage =
        options.slangStorage ||
        new SlangStorage(
          options.db || getConfig().slang_storage_path,
          () => getConfig().slang_max_entries ?? 300,
          () => getConfig().slang_evict_policy ?? 'reject',
          options.dshHome
        );
      const slangDefs = createSlangToolDefinitions(storage);
      for (const def of slangDefs) {
        unregisters.push(tools.register(def));
      }
    }

    // 14. manage_scheduled_tasks
    unregisters.push(
      tools.register(
        createManageScheduledTasksTool(() => {
          const g = getGlobalToolContext();
          return {
            scheduler: options.scheduler || g.scheduler,
            peer: g.peer,
          };
        })
      )
    );

    // 15. QQ 空间动态工具集
    unregisters.push(tools.register(createReadQzoneFeedsTool(options)));
    unregisters.push(tools.register(createPublishQzoneFeedTool(options)));
    unregisters.push(tools.register(createCommentQzoneFeedTool(options)));
    unregisters.push(tools.register(createDeleteQzoneFeedTool(options)));

    // 16. 社交关系链探查与群信息只读工具集
    const contactContextGetter = () => {
      const g = getGlobalToolContext();
      return {
        ...g,
        gateway: options.gateway || g.gateway,
      };
    };
    unregisters.push(tools.register(createGetFriendListTool(contactContextGetter)));
    unregisters.push(tools.register(createGetGroupListTool(contactContextGetter)));
    unregisters.push(tools.register(createGetUserProfileTool(contactContextGetter)));
    unregisters.push(tools.register(createGetGroupInfoTool(contactContextGetter)));
    unregisters.push(tools.register(createGetGroupNoticeTool(contactContextGetter)));

    // 17. 跨 Agent 内部协同工具集 (Agent IPC)
    const ipcContextGetter = () => {
      const g = getGlobalToolContext();
      return {
        ...g,
        sessionManager:
          options.sessionManager ||
          g.sessionManager ||
          (ctx as any).sessionManager ||
          (typeof (ctx as any).get === 'function' ? (ctx as any).get('sessionManager') : undefined),
      };
    };
    unregisters.push(tools.register(createListActiveAgentsTool(ipcContextGetter)));
    unregisters.push(tools.register(createCreateTargetAgentTool(ipcContextGetter)));
    unregisters.push(tools.register(createSendAgentMessageTool(ipcContextGetter)));

    // 18. get_group_member_info (群成员信息查询)
    unregisters.push(
      tools.register(
        createGetGroupMemberInfoTool(() => {
          const g = getGlobalToolContext();
          return {
            ...g,
            gateway: options.gateway || g.gateway,
          };
        })
      )
    );
  };

  const initialTools =
    (ctx as any).tools || (typeof (ctx as any).get === 'function' ? (ctx as any).get('tools') : undefined);
  if (initialTools) {
    doRegister(initialTools);
  }

  const checkReadyTools = () => {
    if (unregisters.length === 0) {
      const readyTools =
        (ctx as any).tools || (typeof (ctx as any).get === 'function' ? (ctx as any).get('tools') : undefined);
      if (readyTools) doRegister(readyTools);
    }
  };
  const appReady = typeof (ctx as any).get === 'function' ? (ctx as any).get('appReady') : undefined;
  if (appReady && typeof appReady.onReady === 'function') {
    appReady.onReady(checkReadyTools);
  }
  (ctx as any).on?.('ready', checkReadyTools);

  return () => {
    for (const unreg of unregisters) {
      try {
        unreg();
      } catch {}
    }
  };
}
