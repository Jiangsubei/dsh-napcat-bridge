/**
 * dsh-napcat-bridge: 主插件入口 (Cordis Plugin)
 * 接入 NapCat (OneBot 11)，让 DeepSeek Harness Agent 在 QQ 群聊/私聊中对话、检索历史与收发文件。
 */

import * as path from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import {
  PLUGIN_NAME,
  SETTINGS_NAMESPACE,
  DEFAULT_WS_PORT,
  DEFAULT_MEMORY_DIR,
  DEFAULT_GROUP_MEMORY_BUDGET_CHARS,
  DEFAULT_PRIVATE_MEMORY_BUDGET_CHARS,
  DEFAULT_DATABASE_PATH,
  DEFAULT_FACE_STORE_DIR,
} from './constants/index.js';
import { BridgeConfigSchema } from './config/schema.js';
import { resolveDshPath } from './utils/path.js';
import { EMOJI_MAP, type BridgePluginConfig, type MessageRecord } from './types/index.js';
import { MessageDatabase } from './storage/database.js';
import { MediaStorageManager, startMediaCleanupTask } from './storage/media.js';
import { NapCatGatewayServer, MessageWaitRegistry } from './gateway/server.js';
import { SessionManager } from './gateway/session.js';
import { shouldWakeup, parseNormalizedContent, resolveAtNicknames } from './gateway/wakeup.js';
import { CachedGroupMemberResolver } from './gateway/members.js';
import { ProactiveManager } from './gateway/proactive.js';
import { registerAgentTools, type AgentToolsOptions } from './tools/index.js';
import { setGlobalBridgeToolsProvider, type NapCatBridgeToolsProvider } from './tools/plugin.js';
import { createMemoryToolDefinitions } from './memory/tools.js';
import { OutboundStreamBridge } from './outbound/stream.js';
import { PerPeerSerialSender } from './outbound/queue.js';
import { NapCatQuestionProvider, NapCatApprovalResponder, registerNapCatQuestionChannel } from './approval/responder.js';
import { downloadPrivateFile } from './tools/private-file.js';
import { isSlashCommand, handleSlashCommand } from './commands/index.js';
import { registerNapCatDynamicPrompt } from './prompt/dynamic.js';
import { setupMemoryService } from './memory/index.js';

import { registerConfigRoute } from './server/routes.js';
import { registerFacesRoutes } from './server/face-routes.js';
import { migrateLegacyConfig, readLegacyConfig } from './config/migrate.js';
import { migrateFaceStoragePaths } from './storage/face-migration.js';

export * from './memory/index.js';


export const name = PLUGIN_NAME;
export const inject = ['tools', 'systemPrompt', 'agents'];
export const Config = BridgeConfigSchema;

export function apply(ctx: Context, config: BridgePluginConfig = {}) {
  const logger = ctx.logger ? ctx.logger(PLUGIN_NAME) : console;
  const dshHome = path.resolve(
    process.env.DSH_HOME || path.join(process.env.HOME || process.env.USERPROFILE || '/tmp', '.dsh')
  );

  const extractConfig = (cfg: unknown): BridgePluginConfig => {
    if (!cfg || typeof cfg !== 'object') return {};
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(cfg as Record<string, unknown>)) {
      if (val && typeof val === 'object' && typeof (val as { get?: unknown }).get === 'function') {
        out[key] = (val as { get: () => unknown }).get();
      } else {
        out[key] = val;
      }
    }
    return out as BridgePluginConfig;
  };

  const readSettingsConfig = (): BridgePluginConfig => {
    const settingsService = (ctx as any).get?.('settings');
    if (!settingsService) return {};
    try {
      if (typeof settingsService.describe === 'function') {
        const desc = settingsService.describe().find(
          (d: any) => d.ns === SETTINGS_NAMESPACE
        );
        if (desc?.value) return desc.value as BridgePluginConfig;
      }
      if (typeof settingsService.get === 'function') {
        const val = settingsService.get(SETTINGS_NAMESPACE);
        if (val && typeof val === 'object') return val;
      }
    } catch {
      // ignore
    }
    return {};
  };

  const mergeConfigs = (base: BridgePluginConfig, overrides: BridgePluginConfig): BridgePluginConfig => {
    const result: Record<string, unknown> = { ...base };
    for (const [key, val] of Object.entries(overrides)) {
      if (val !== undefined && val !== '') {
        result[key] = val;
      } else if (result[key] === undefined) {
        result[key] = val;
      }
    }
    return result as BridgePluginConfig;
  };

  const currentConfig = (): BridgePluginConfig => {
    const fromSettings = readSettingsConfig();
    const fromArgs = extractConfig(config);
    // 0.2.1 规范优先级：以加载时传入的配置参数 (fromArgs) 为底，以用户在设置系统中配置并保存的最新项 (fromSettings) 覆盖
    let merged = mergeConfigs(fromArgs, fromSettings);
    if (!merged.bot_qq && !merged.ws_token) {
      const legacy = readLegacyConfig(dshHome);
      if (legacy) {
        merged = mergeConfigs(legacy, merged);
      }
    }
    return merged;
  };

  // B6: bot_qq 为 Spec 必填项 (Spec §8.2 / §1.1)；缺失时明确告警，避免自循环防护静默降级
  if (!String(currentConfig().bot_qq || '').trim()) {
    logger.warn?.(
      '[Plugin] 配置缺失 bot_qq（机器人自身 QQ 号，Spec 必填）：自循环防护将退化为仅依赖 post_type===message_sent，无法按 QQ 号过滤，请在设置卡片中补全'
    );
  }

  // A3: 共享 per-peer 串行发送器 (Spec §7.3)：正文、提问、审批、发文件全部经由同一队列下发
  const serialSender = new PerPeerSerialSender();

  // 主动回复管理器 (冷却控制、潜水定时巡检、免打扰判定)
  const proactiveManager = new ProactiveManager();

  // EN-005: 入站消息等待收集器（wait_for_user_messages 工具的消息桥接，
  //         等待期间同 peer 入站消息经 index.ts 门控转发给收集器并抑制唤醒）
  const waitRegistry = new MessageWaitRegistry();

  let memoryService: any = null;
  let unregisterFacesRoutes: (() => void) | undefined;
  let isDisposed = false;

  // C2: Notice 事件 (group_upload / poke) 无真实 message_id 时的稳定正数主键策略
  //     FNV-1a 32-bit，避免 -Date.now() 负数假 id 在极高并发下撞主键
  const stableNoticeMsgId = (key: string): number => {
    let hash = 0x811c9dc5;
    for (let i = 0; i < key.length; i++) {
      hash ^= key.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0) || 1;
  };

  // 1. 初始化 Gateway WebSocket 服务端
  const server = new NapCatGatewayServer({
    port: currentConfig().ws_port || DEFAULT_WS_PORT,
    token: currentConfig().ws_token,
    logger,
  });

  // 声明自定义设置卡片，跳过官方粗糙默认表单 (DSH 0.2.1 规范)
  (ctx as any).inject(['settings'], (s: any) => (s as any).settings?.configure?.({ auto: false }, ctx.fiber));

  // Reconciler 状态机：配置变更时对齐运行状态
  const reconcile = async (forcedConfig?: BridgePluginConfig): Promise<void> => {
    if (isDisposed) return;
    const active = forcedConfig
      ? { ...currentConfig(), ...extractConfig(forcedConfig) }
      : currentConfig();

    logger.info?.('[Plugin] 对齐并应用最新配置:', active);

    const targetPort = active.ws_port || DEFAULT_WS_PORT;
    const targetToken = active.ws_token || '';

    if (server.options.port !== targetPort || (server.options.token || '') !== targetToken) {
      logger.info?.(`[Plugin] 检测到 WS 端口/Token 变更 (${server.options.port} -> ${targetPort})，正在热重启 WS 服务端...`);
      try {
        await server.restart({
          port: targetPort,
          token: targetToken,
        });
        logger.info?.(`[Plugin] WS 服务端热重启成功，正在监听端口 ${targetPort}`);
      } catch (err) {
        logger.error?.('[Plugin] WS 服务端热重启失败:', err);
      }
    }

    if (active.memory_storage_dir) {
      const updatedMemoryDir = resolveDshPath(dshHome, active.memory_storage_dir, DEFAULT_MEMORY_DIR);
      if (memoryService?.storage && memoryService.storage.getBaseDir() !== updatedMemoryDir) {
        memoryService.storage.setBaseDir(updatedMemoryDir, dshHome);
      }
    }
  };

  let reconcileRunning = false;
  let hasPendingReconcile = false;
  let pendingConfig: BridgePluginConfig | undefined = undefined;

  const queueReconcile = async (newVal?: BridgePluginConfig): Promise<void> => {
    if (newVal) pendingConfig = newVal;
    hasPendingReconcile = true;
    if (reconcileRunning) return;
    reconcileRunning = true;
    try {
      while (hasPendingReconcile) {
        hasPendingReconcile = false;
        const nextCfg = pendingConfig;
        pendingConfig = undefined;
        await reconcile(nextCfg);
      }
    } finally {
      reconcileRunning = false;
    }
  };

  // 挂载服务端配置 REST 路由
  const unregisterConfigRoute = registerConfigRoute(ctx, currentConfig, queueReconcile);

  // 监听 0.2.1 原生 volatile 配置热更新与 settings document-updated 事件
  (ctx as any).on('loader/volatile-update', () => {
    if (isDisposed) return;
    logger.info?.('[Plugin] 收到 loader/volatile-update 事件，正在对齐运行状态...');
    void queueReconcile();
  });
  (ctx as any).on('settings/document-updated', (ns: string) => {
    if (isDisposed) return;
    if (!ns || ns === SETTINGS_NAMESPACE) {
      logger.info?.('[Plugin] 收到 settings/document-updated 事件，正在对齐运行状态...');
      void queueReconcile();
    }
  });

  // 立即按当前有效配置启动 WebSocket 服务端
  const effectivePort = currentConfig().ws_port || DEFAULT_WS_PORT;
  const effectiveToken = currentConfig().ws_token || '';
  if (server.options.port !== effectivePort || (server.options.token || '') !== effectiveToken) {
    server.options.port = effectivePort;
    server.options.token = effectiveToken;
  }

  server.start().then(() => {
    logger.info?.(`[Plugin] OneBot 11 反向 WS 服务端已在端口 ${server.options.port} 成功启动`);
  }).catch((err) => {
    logger.warn?.(`[Plugin] GatewayServer 启动告警 (端口: ${server.options.port}):`, err);
  });

  // EN-001: 群成员昵称解析器（at 段被@者昵称，TTL 缓存避免每条消息多次 get_group_member_info）
  const memberResolver = new CachedGroupMemberResolver(server);

  // 2. 注册 System Prompt 动态上下文段
  // 2.1 注册人格与行为准则动态段 (napcat:behavior_persona, order: 50)
  const unregisterDynamicPrompt = registerNapCatDynamicPrompt(
    ctx,
    () => currentConfig().persona || '',
    () => currentConfig().behavior || ''
  );

  // 3. 初始化存储、媒体管理器与会话管理器
  const dbPath = resolveDshPath(dshHome, undefined, DEFAULT_DATABASE_PATH);
  const db = new MessageDatabase(dbPath);
  db.init();

  // 启动时自动规范化存量表情包存储路径，并从工作区 profiles 目录自愈找回物理文件
  try {
    const rawFaceDir = currentConfig().face_store_dir;
    const faceStoreDir = resolveDshPath(dshHome, rawFaceDir, DEFAULT_FACE_STORE_DIR);
    migrateFaceStoragePaths({ db, dshHome, faceStoreDir });
  } catch (migErr) {
    logger.warn?.('[Plugin] 启动时表情包存储路径自愈迁移失败:', migErr);
  }

  // 挂载表情包管理 REST 路由 (列表、上传、大图预览、编辑、删除)
  unregisterFacesRoutes = registerFacesRoutes({ ctx, db, getConfig: currentConfig, dshHome });

  const mediaManager = new MediaStorageManager({
    dshHome,
    db,
    ttlDays: config.image_ttl_days ?? 7,
  });

  const sessionManager = new SessionManager(ctx, dshHome, db);
  sessionManager.registerWorkspace(sessionManager.resolveCwd()).catch((wsErr) => {
    logger.warn?.('[Plugin] 初始化注册 NapCat 顶级工作区失败:', wsErr);
  });

  let outboundBridge: OutboundStreamBridge | null = null;

  // 4. 注册 Agent 工具集与 7 天 TTL 定时清理任务
  const toolsOptions: AgentToolsOptions = {
    db,
    gateway: server,
    mediaManager,
    sender: serialSender,
    dshHome,
    waitRegistry,
    config: currentConfig,
    inboundMsgIdGetter: (peer: string) => {
      if (!outboundBridge) return undefined;
      const inboundCtx =
        outboundBridge.getActiveTurnContext?.(peer) ??
        (outboundBridge as any).getInboundContext?.(peer) ??
        (outboundBridge as any).inboundContexts?.get?.(peer);
      if (inboundCtx && ((inboundCtx as any).is_synthetic || (inboundCtx as any).synthetic)) {
        return undefined;
      }
      return inboundCtx?.msg_id;
    },
  };
  // 工具不再全局直挂到 root ctx，杜绝向 Web UI 等非 QQ 会话泄露；
  // 统一通过 qq-session 预设（dsh-napcat-bridge/tools 插件）挂载至具体 QQ Agent 实例 Context。
  const unregisterTools = () => {};

  // 5. 初始化并挂载 Memory 两层记忆体系插件服务 (storageDir 严格绝对路径锚定到 dshHome)
  const currentSpeakers = new Map<string, string>();
  const rawMemoryDir = currentConfig().memory_storage_dir;
  const normalizedMemoryDir = resolveDshPath(dshHome, rawMemoryDir, DEFAULT_MEMORY_DIR);

  memoryService = setupMemoryService(ctx, {
    storageDir: normalizedMemoryDir,
    dshHome,
    registerGlobalTools: false,
    groupBudgetChars: currentConfig().group_memory_budget_chars,
    privateBudgetChars: currentConfig().private_memory_budget_chars,
    getGroupBudgetChars: () =>
      currentConfig().group_memory_budget_chars ??
      DEFAULT_GROUP_MEMORY_BUDGET_CHARS,
    getPrivateBudgetChars: () =>
      currentConfig().private_memory_budget_chars ??
      DEFAULT_PRIVATE_MEMORY_BUDGET_CHARS,
    getCurrentSpeaker: (peer: string) => currentSpeakers.get(peer),
    db,
    sessionManager,
  });

  // 5.1 构造 NapCat 专属工具提供者 (供 dsh-napcat-bridge/tools 插件与 qq-session 预设挂载)
  const napcatBridgeTools: NapCatBridgeToolsProvider = {
    registerTools(targetCtx: Context) {
      const unregAgent = registerAgentTools(targetCtx, toolsOptions);
      const unregMemory: Array<() => void> = [];
      if (memoryService?.tools) {
        const toolsService =
          (targetCtx as any).tools ||
          (typeof (targetCtx as any).get === 'function' ? (targetCtx as any).get('tools') : undefined);
        if (toolsService && typeof toolsService.register === 'function') {
          const defs = createMemoryToolDefinitions(memoryService.tools);
          for (const def of defs) {
            if (typeof toolsService.get === 'function' && toolsService.get(def.name)) {
              continue;
            }
            unregMemory.push(toolsService.register(def));
          }
        }
      }
      return () => {
        try {
          unregAgent();
        } catch {}
        for (const unreg of unregMemory) {
          try {
            unreg();
          } catch {}
        }
      };
    },
  };

  setGlobalBridgeToolsProvider(napcatBridgeTools);
  if (typeof (ctx as any).provide === 'function') {
    try {
      (ctx as any).provide('napcatBridgeTools', napcatBridgeTools);
    } catch {}
  }

  // 5.2 若当前环境提供了 agentPresets 且未注册 qq-session 预设，则动态补全注册
  (ctx as any).inject?.(['agentPresets'], (presetCtx: Context) => {
    const agentPresetsSvc = (presetCtx as any).agentPresets;
    if (agentPresetsSvc && typeof agentPresetsSvc.register === 'function') {
      agentPresetsSvc.list?.().then((presetsList: any[]) => {
        const exists = Array.isArray(presetsList) && presetsList.some((p: any) => p.id === 'qq-session');
        if (!exists) {
          agentPresetsSvc.register({
            id: 'qq-session',
            name: 'QQ 智能助手',
            description: 'QQ 会话专属预设，包含工作区文件与跨平台 Shell、官方 Web 搜索与 NapCat QQ 交互能力',
            order: 10,
            plugins: [
              {
                id: 'persona',
                name: '@deepseek-ai/dsh-persona',
                config: {
                  prefix: '当前会话是 qq 会话。注意：你的直接文本回复不会自动发送给用户，向用户回复或发言必须通过 send_qq_message 工具显式下发。',
                  complete: true,
                },
              },
              {
                id: 'agent-instructions',
                name: '@deepseek-ai/dsh-agent-instructions',
                config: {
                  maxBytes: 65536,
                },
              },
              { id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs' },
              { id: 'tool-working-directory', name: '@deepseek-ai/dsh-tool-working-directory' },
              {
                id: 'tool-workspace-dependencies',
                name: '@deepseek-ai/dsh-tool-workspace-dependencies',
                disabled: !(process.env.DSH_PRIMARY_RUNTIME || process.env.DSH_BUNDLED_PRIMARY_RUNTIME),
                config: {
                  source: process.env.DSH_PRIMARY_RUNTIME || process.env.DSH_BUNDLED_PRIMARY_RUNTIME || '',
                },
              },
              {
                id: 'tool-bash',
                name: '@deepseek-ai/dsh-tool-bash',
                disabled: process.platform === 'win32',
              },
              {
                id: 'tool-pwsh',
                name: '@deepseek-ai/dsh-tool-pwsh',
                disabled: process.platform !== 'win32',
              },
              {
                id: 'tool-web',
                name: '@deepseek-ai/dsh-tool-web',
                config: { fetch: true, searchTimeoutMs: 30000 },
              },
              { id: 'skill-filesystem', name: '@deepseek-ai/dsh-skill-filesystem' },
              { id: 'tool-skill', name: '@deepseek-ai/dsh-tool-skill' },
              { id: 'tool-ask-user', name: '@deepseek-ai/dsh-tool-ask-user' },
              { id: 'napcat-tools', name: 'dsh-napcat-bridge/tools' },
            ],
          }).catch((err: any) => {
            logger.debug?.('[Plugin] 动态注册 qq-session 预设已跳过或失败:', err?.message);
          });
        }
      }).catch(() => {});
    }
  });

  // 4.1 初始化后台媒体清理任务
  const stopCleanupTask = startMediaCleanupTask(ctx, mediaManager);

  // 5. 挂载出方向事件流桥接器 (过滤 reasoning/tool-call，Markdown Strip 后分段下发)
  outboundBridge = new OutboundStreamBridge(ctx, {
    gateway: server,
    sessionManager,
    getConfig: currentConfig,
    logger,
  });
  sessionManager.setOutboundBridge?.(outboundBridge);
  const stopOutboundBridge = outboundBridge.start();

  // 6. 审批 waterfall 响应器（独立于提问 provider，不注册 userQuestions 以避免与官方冲突）
  // 注：提问 provider 注册已移除 —— DSH web profile 下官方 dsh-host-apiproxy 已注册唯一 userQuestions
  // provider（registerProvider 抛 DUPLICATE_PROVIDER）。本插件不再注册 NapCat 提问渠道，提问经官方
  // Web UI 渠道呈现。QQ 侧提问能力待按官方「单一组合 provider 统一路由」方式由后续整改接入
  //（见 issue / 子代理调研 dsh-host-apiproxy provider 集成方式 —— 由下方 TD-001 接线补入 QQ 渠道）。
  const approvalResponder = new NapCatApprovalResponder({
    gateway: server,
    sessionManager,
    sender: serialSender,
    admins: currentConfig().admins,
    logger,
  });

  // TD-001: QQ 侧提问渠道 —— 按用户拍板方案（参照 nyagent composite 成熟实现）接线：
  // 纯 headless 无宿主 provider 时走官方 registerProvider；web+QQ 同部署时以按 session
  // 路由的 composite provider 直接赋值（等 apiProxy 就绪后接管，卸载还原宿主 provider）。
  const questionProvider = new NapCatQuestionProvider({
    gateway: server,
    sessionManager,
    sender: serialSender,
    logger,
  });
  let unregisterQuestionChannel: (() => void) | null = null;
  try {
    unregisterQuestionChannel = registerNapCatQuestionChannel(ctx as any, {
      questionProvider,
      isQQSession: (sessionId) => sessionManager.isQQSession(sessionId),
      logger,
    });
  } catch (channelErr) {
    logger.warn?.('[Plugin] 注册 QQ 提问渠道异常:', channelErr);
  }

  const unregisterApproval = (ctx as any).on(
    'approval/request',
    async (req: any, next: any) => {
      const sessionId = req.agent?.session?.id;
      if (!sessionId || !sessionManager.isQQSession(sessionId)) {
        return next ? next() : 'unavailable';
      }
      const peer = sessionManager.sessionIdToPeer(sessionId);
      return await approvalResponder.handleApprovalRequest({
        peer,
        toolName: req.toolName,
        callId: req.callId,
        reason: req.reason,
        signal: req.signal,
      });
    },
    { prepend: true }
  );

  // 7. 监听入方向消息并执行入库、审批/提问拦截与唤醒门控
  server.onMessage(async (event) => {
    const botQQ = currentConfig().bot_qq || '';
    const isGroup = event.message_type === 'group';
    const isSelfMsg = event.post_type === 'message_sent';
    const fromUser = isSelfMsg
      ? String(event.self_id || botQQ || event.sender?.user_id || event.user_id || '')
      : String(event.sender?.user_id ?? event.user_id ?? '');
    const peer = isGroup
      ? `group_${event.group_id}`
      : `user_${isSelfMsg ? event.user_id || event.target_id || fromUser : fromUser}`;
    let senderName = isSelfMsg
      ? (currentConfig().aliases?.[0] || '智能助手')
      : event.sender?.card || event.sender?.nickname || '';
    if (isGroup && !senderName && event.group_id !== undefined && !isSelfMsg) {
      try {
        senderName = (await memberResolver.resolve(event.group_id, fromUser)) || '';
      } catch {}
    }
    if (!isSelfMsg && fromUser) {
      currentSpeakers.set(peer, fromUser);
    }
    const timestamp = event.time
      ? event.time < 10000000000
        ? event.time * 1000
        : event.time
      : Date.now();

    let primaryLocalPath: string | null = null;
    let primaryFingerprint: string | null = null;
    let dominantType = 'text';
    let fileId: string | null = null;
    let busid: number | null = null;

    // 1. 即时预处理并下载图片/表情包落盘
    if (Array.isArray(event.message)) {
      for (const seg of event.message) {
        if (!seg || typeof seg !== 'object') continue;
        const data = (seg.data || {}) as any;

        if (seg.type === 'image') {
          dominantType = 'image';
          fileId = data.file || data.file_id || null;
          const isSticker = data.sub_type === 1 || Boolean(data.emoji_package_id);
          if (isSticker) dominantType = 'sticker';
          const imgUrl = data.url || data.file;

          if (imgUrl && /^https?:\/\//i.test(imgUrl) && mediaManager) {
            try {
              // 注意：QQ/NapCat 上报的 data.file 经常固定带 .jpg 伪后缀（如 PNG/GIF 表情包被无脑命名为 MD5.jpg），
              // 绝不能将 data.file 作为图片扩展名传给底层；仅在 data.url 显式携带路径扩展名时作为可选参考，
              // 最终落盘扩展名由 mediaManager 依据 Buffer 真实魔数（PNG/JPEG/GIF/WebP）精准识别。
              const inferUrlExt = (str?: string): string | undefined => {
                if (!str || typeof str !== 'string') return undefined;
                const clean = str.split('?')[0].split('#')[0];
                const match = /\.([a-zA-Z0-9]+)$/.exec(clean);
                return match ? match[1].toLowerCase() : undefined;
              };
              const urlExt = inferUrlExt(data.url);

              const saved = await mediaManager.downloadAndSave(imgUrl, {
                type: isSticker ? 'sticker' : 'image',
                sessionId: peer,
                fileId: fileId || undefined,
                ...(urlExt ? { ext: urlExt } : {}),
              });
              data.local_path = saved.localPath;
              if (!primaryLocalPath) {
                primaryLocalPath = saved.localPath;
                primaryFingerprint = saved.fingerprint;
              }
            } catch (dlErr) {
              logger.debug?.('[Plugin] 即时下载图片媒体失败 (跳过直接存库):', dlErr);
            }
          }
        } else if (seg.type === 'file') {
          dominantType = isGroup ? 'group_file' : 'file';
          fileId = data.file_id || data.file || null;
          busid = data.busid ?? null;
          // PF-001: 私聊文件入站即时落盘（同步 await 落盘完成后再构建唤醒包/入库，任务包 §3.3）。
          //   - 群聊 file 段保持现状（group_upload notice 懒载），静默跳过；
          //   - 机器人自己发出的文件（message_sent）不入站回拉：段内即本机来源路径，无需 NapCat 中转。
          //   - 两级退化（用户拍板 §3.1）：首选 get_private_file_url 直链 → 回退 get_file 本地路径；
          //     双失败绝不返回占位假路径：消息照常入库但 local_path 置空，content 如实标注入站落盘失败。
          if (!isGroup && !isSelfMsg && fileId && mediaManager) {
            const pf = await downloadPrivateFile({
              fileId,
              peer,
              busid,
              filename: data.file_name || data.file || undefined,
              gateway: server,
              mediaManager,
              logger,
            });
            if (pf.ok && pf.localPath) {
              data.local_path = pf.localPath;
              if (!primaryLocalPath) {
                primaryLocalPath = pf.localPath;
                primaryFingerprint = pf.fingerprint ?? null;
              }
              logger.info?.(`[Plugin] 私聊文件已即时落盘 (peer: ${peer}, file_id: ${fileId}) -> ${pf.localPath}`);
            } else {
              data.dl_failed = true;
              logger.warn?.(
                `[Plugin] 私聊文件入站落盘失败 (peer: ${peer}, file_id: ${fileId}): ${pf.error || '未知原因'}`
              );
            }
          }
        } else if (seg.type === 'forward') {
          dominantType = 'forward';
          fileId = data.id || data.forward_id || null;
        } else if (seg.type === 'record') {
          dominantType = 'record';
          fileId = data.file || data.file_id || null;
        } else if (seg.type === 'video') {
          dominantType = 'video';
          fileId = data.file || data.file_id || null;
        } else if (seg.type === 'poke') {
          dominantType = 'poke';
        } else if (seg.type === 'shake') {
          dominantType = 'shake';
        } else if (seg.type === 'json' || seg.type === 'xml') {
          dominantType = seg.type;
        } else if (seg.type === 'reply' && dominantType === 'text') {
          dominantType = 'reply';
        } else if (seg.type === 'at' && dominantType === 'text') {
          dominantType = 'at';
        }
      }
    }

    const { content: rawContent, replyId, atQQs } = parseNormalizedContent(event);

    // 过滤完全为空的消息事件 (无字符、无媒体、无文件、无引用，如 NapCat 上报的文件下载回执/系统灰条)
    const hasMedia = Boolean(
      primaryLocalPath ||
      fileId ||
      (dominantType !== 'text' && dominantType !== 'reply')
    );
    const isCompletelyEmpty =
      rawContent.length === 0 &&
      !hasMedia &&
      replyId === undefined &&
      atQQs.length === 0;

    if (isCompletelyEmpty) {
      logger.debug?.(
        `[Plugin] 收到完全为空的消息事件 (msg_id: ${event.message_id}, peer: ${peer})，已过滤不落盘不唤醒`
      );
      return;
    }

    // EN-001: 入库 content 统一归一化为 @昵称(QQ号)（落库/唤醒包/消息记录同源格式）；
    // 纯文本手敲的 "@昵称"（非 CQ:at 段）保持原样
    let content = rawContent;
    const msgGroupId = event.group_id;
    if (isGroup && atQQs.length > 0 && msgGroupId !== undefined) {
      try {
        content = await resolveAtNicknames(
          content,
          atQQs,
          msgGroupId,
          (gid, qq) => memberResolver.resolve(gid, qq)
        );
      } catch (resolveErr) {
        logger.debug?.('[Plugin] at 昵称归一化失败 (回退裸 QQ 号):', resolveErr);
      }
    }

    const isSelf = isSelfMsg || (botQQ !== '' && fromUser === botQQ) ? 1 : 0;

    const record: MessageRecord = {
      msg_id: event.message_id,
      peer,
      user_id: fromUser,
      sender_name: senderName,
      time: timestamp,
      type: dominantType,
      content,
      raw: JSON.stringify(event.message || event.raw_message),
      file_id: fileId,
      busid,
      local_path: primaryLocalPath,
      fingerprint: primaryFingerprint,
      recalled: 0,
      self: isSelf,
      reply_to: replyId ?? null,
    };

    try {
      db.saveMessage(record);
    } catch (err) {
      logger.error?.('[Plugin] 消息入库失败:', err);
    }

    // 优先拦截斜杠命令 (如 /mode, /model, /think, /help, /clear)
    if (isSlashCommand(content)) {
      try {
        const agent = await sessionManager.getOrCreateAgent(peer);
        const session = agent.session;
        const result = await handleSlashCommand(content, {
          userId: fromUser,
          admins: currentConfig().admins || [],
          session,
          ctx,
          sessionManager,
        });
        const replyText = result.reply || result.error;
        if (replyText) {
          if (isGroup && event.group_id) {
            await server.sendGroupMsg(event.group_id, replyText).catch((err) => {
              logger.error?.('[Plugin] 下发斜杠命令响应异常:', err);
            });
          } else if (event.user_id) {
            await server.sendPrivateMsg(event.user_id, replyText).catch((err) => {
              logger.error?.('[Plugin] 下发斜杠命令响应异常:', err);
            });
          }
        }
      } catch (cmdErr) {
        logger.error?.('[Plugin] 执行斜杠命令异常:', cmdErr);
      }
      return;
    }

    // EN-005: 等待门控——等待期间该 peer 新消息「仅落库 + (命中则)进收集器」，
    //         其余环节（提问/审批/主动回复/唤醒）全部跳过，杜绝 collect + followup 双重投递。
    //         斜杠命令已在上方拦截（程序层，用户拍板除外项）；自身消息回显只抑制不收集。
    if (waitRegistry.isWaiting(peer)) {
      if (!isSelf && waitRegistry.tryDeliver(peer, {
        from: senderName,
        user_id: fromUser,
        content,
        time: timestamp,
      })) {
        // 刷新出方向回复锚点（@提问者/引用原消息锚定最后一条被收集消息）
        const consumedMsgId = Number(event.message_id);
        if (consumedMsgId) {
          const waitCtx = {
            msg_id: consumedMsgId,
            from_user: fromUser,
            is_group: isGroup,
          };
          outboundBridge.trackInboundContext(peer, waitCtx);
          outboundBridge.updateActiveTurnContext(peer, waitCtx);
        }
      }
      logger.debug?.(`[Plugin] 等待收集期间抑制入站消息流转 (peer: ${peer})`);
      return;
    }

    // 提问回复拦截（用户拍板顺序：存库 → 斜杠命令 → 提问 → 审批 → 唤醒）
    // 群聊引用锚定：仅「引用当前提问卡片那条消息」的回复命中；未命中按普通消息继续流转
    try {
      const questionConsumed = questionProvider.handleInboundReply(peer, content, {
        replyId: replyId ?? undefined,
      });
      if (questionConsumed) {
        logger.info?.(`[Plugin] 提问回复已处理 (peer: ${peer}, reply: ${content})`);
        return;
      }
    } catch (questionErr) {
      // 拦截异常不应殃及正常消息流：记日志后继续（不吞消息、不误答）
      logger.warn?.('[Plugin] 提问回复拦截异常 (忽略继续流转):', questionErr);
    }

    // 审批回复拦截 (y/n) —— 提问回复不再在此拦截（提问拦截已前置并独立处理）
    if (
      approvalResponder.handleInboundReply(peer, content, {
        userId: event.user_id,
        replyId: (event as any).reply?.id,
      })
    ) {
      logger.info?.(`[Plugin] 审批决策已处理 (peer: ${peer}, reply: ${content})`);
      return;
    }

    // 记录人类发言时间 (非自身群聊消息)
    if (isGroup && !isSelf) {
      proactiveManager.recordHumanMessage(peer, timestamp);
    }

    // 唤醒门控判定
    try {
      const decision = await shouldWakeup(event, {
        bot_qq: botQQ,
        bot_nickname: (currentConfig() as any).bot_nickname || (currentConfig().aliases?.[0] ?? undefined),
        aliases: currentConfig().aliases,
        proactive: currentConfig(),
        proactiveManager,
        // EN-001: 被@者昵称解析（有 TTL 缓存，不重复 API 调用）
        resolveNickname: (gid, qq) => memberResolver.resolve(gid, qq),
        getQuotedMessage: async (repId: number) => {
          // 1. 本地 SQLite 优先查询（耗时 < 1ms，0 网络/API 开销）
          const cached = db.getMessage(repId);
          if (cached) {
            let quotedContent = cached.content;
            const images: string[] = [];

            // 若本地记录存有原始 raw，使用最新解析器动态重新解析（兼顾历史老数据升级与格式对齐）
            if (cached.raw) {
              try {
                const rawSegments = JSON.parse(cached.raw);
                if (Array.isArray(rawSegments)) {
                  const reParsed = parseNormalizedContent({
                    message: rawSegments,
                    raw_message: '',
                  } as any);
                  if (reParsed.content) {
                    quotedContent = reParsed.content;
                  }
                  if (reParsed.images && Array.isArray(reParsed.images)) {
                    for (const img of reParsed.images) {
                      if (img && !images.includes(img)) images.push(img);
                    }
                  }
                }
              } catch {}
            }

            if (cached.local_path && !images.includes(cached.local_path)) {
              images.push(cached.local_path);
            }

            return {
              user_id: cached.user_id,
              sender_name: cached.sender_name,
              content: quotedContent,
              self: cached.self,
              images: images.length > 0 ? images : undefined,
            };
          }

          // 2. 本地未命中，调用 NapCat get_msg API 二级兜底拉取
          try {
            const res = await server.getMsg(repId);
            if (res && res.status === 'ok' && res.data) {
              const remoteMsg = res.data;
              const { content: quotedContent, images: quotedImages } = parseNormalizedContent(remoteMsg);
              const quotedUserId = String(remoteMsg.sender?.user_id ?? remoteMsg.user_id ?? '');
              let quotedName = remoteMsg.sender?.card || remoteMsg.sender?.nickname || '';
              if (!quotedName && isGroup && event.group_id && quotedUserId) {
                try {
                  quotedName = (await memberResolver.resolve(event.group_id, quotedUserId)) || '';
                } catch {}
              }
              const quotedSelf = botQQ !== '' && quotedUserId === botQQ ? 1 : 0;

              // 自动回填本地 SQLite 补齐记录
              try {
                db.saveMessage({
                  msg_id: repId,
                  peer,
                  user_id: quotedUserId,
                  sender_name: quotedName,
                  time: remoteMsg.time
                    ? remoteMsg.time < 10000000000
                      ? remoteMsg.time * 1000
                      : remoteMsg.time
                    : Date.now(),
                  type: 'text',
                  content: quotedContent,
                  raw: JSON.stringify(remoteMsg.message || remoteMsg.raw_message),
                  file_id: null,
                  busid: null,
                  local_path: quotedImages[0] || null,
                  fingerprint: null,
                  recalled: 0,
                  self: quotedSelf,
                  reply_to: null,
                });
              } catch {}

              return {
                user_id: quotedUserId,
                sender_name: quotedName,
                content: quotedContent,
                self: quotedSelf,
                images: quotedImages.length > 0 ? quotedImages : undefined,
              };
            }
          } catch (apiErr) {
            logger.debug?.(`[Plugin] 从 NapCat 拉取引用消息 (msg_id: ${repId}) 失败:`, apiErr);
          }

          // 3. 两级均查不到时返回 null（触发 shouldWakeup 优雅降级保底）
          return null;
        },
        isQuotingBot: async (repId: number) => {
          const quotedMsg = db.getMessage(repId);
          return quotedMsg?.self === 1 || (botQQ !== '' && quotedMsg?.user_id === botQQ);
        },
      });

      if (decision.wakeup && decision.payload) {
        logger.info?.(`[Plugin] 触发唤醒 (trigger: ${decision.trigger}, peer: ${decision.payload.peer})`);

        if (decision.trigger === 'proactive') {
          proactiveManager.recordProactiveReply(decision.payload.peer, timestamp);
        }

        // A1: 记录唤醒源消息上下文 (msg_id + 提问者 QQ)，供出方向按

        // at_questioner / quote_original 组装 @提问者 / 引用原消息 前缀 (Spec §7.1 决策 A)
        const payloadPeer = decision.payload.peer;
        const msgIdFromEvent = Number(event.message_id);
        if (msgIdFromEvent) {
          (decision.payload as any).msg_id = msgIdFromEvent;
        }
        const replyContext = (payloadPeer && msgIdFromEvent)
          ? {
              msg_id: msgIdFromEvent,
              from_user: decision.payload.from_user,
              is_group: isGroup,
            }
          : undefined;

        if (payloadPeer && replyContext) {
          outboundBridge.trackInboundContext(payloadPeer, replyContext);
        }

        // 若为群聊且当前群名称未缓存，尝试异步获取群信息以更新会话标题
        if (isGroup && event.group_id && !sessionManager.getPeerName(payloadPeer)) {
          server.getGroupInfo(event.group_id).then((infoRes: any) => {
            const groupName = infoRes?.data?.group_name || infoRes?.group_name;
            if (groupName) {
              sessionManager.setPeerName(payloadPeer, groupName);
              const agent = sessionManager.getAgent(payloadPeer);
              if (agent) {
                const sessionId = sessionManager.peerToSessionId(payloadPeer);
                sessionManager.updateSessionTitle((agent as any).session, payloadPeer, sessionId, groupName);
              }
            }
          }).catch(() => {});
        }

        await sessionManager.dispatchWakeup(decision.payload, {
          onMessageCreated: (userMsg) => {
            if (payloadPeer && replyContext && userMsg?.id) {
              outboundBridge.trackPendingMessage(userMsg.id, payloadPeer, replyContext);
            }
          },
        });
      }
    } catch (err) {
      logger.error?.('[Plugin] 唤醒判定或下发异常:', err);
    }
  });

  // 8. 监听 Notice 事件 (撤回、戳一戳、群文件上传等)
  server.onNotice(async (event) => {
    // 撤回处理
    if (event.notice_type === 'group_recall' || event.notice_type === 'friend_recall') {
      if (event.message_id) {
        db.markRecalled(Number(event.message_id));
        logger.info?.(`[Plugin] 标记消息已撤回 (msg_id: ${event.message_id})`);
      }
      return;
    }

    // 群消息贴表情事件处理 (group_msg_emoji_like: 纯后台审计落库，绝不唤醒 Agent)
    if (event.notice_type === 'group_msg_emoji_like') {
      // 1. 解析目标消息 ID 与群号
      const targetMsgId = Number(event.message_id);
      const groupId = event.group_id;
      if (!groupId || !targetMsgId) return;

      const peer = `group_${groupId}`;
      const fromUser = String(event.user_id ?? event.operator_id ?? '');
      const timestamp = event.time
        ? event.time < 10000000000
          ? event.time * 1000
          : event.time
        : Date.now();

      // 2. 合成稳定正数 msg_id (利用已有的 stableNoticeMsgId 函数)
      const syntheticMsgId = stableNoticeMsgId(`emoji_like:${groupId}:${targetMsgId}:${timestamp}`);

      // 3. 汇总 likes 列表为易读 content
      const likesArr = Array.isArray(event.likes) ? event.likes : [];
      const likesSummary = likesArr.map((l: any) => {
        const eid = String(l.emoji_id ?? l.id ?? '');
        // 从 EMOJI_MAP 找匹配的中文名
        const found = Object.values(EMOJI_MAP).find(e => e.id === eid);
        const name = found ? `${found.name}(${eid})` : eid;
        return `${name}x${l.count ?? 1}`;
      }).join(', ');
      const content = `[表情回应: ${likesSummary || '无'}]`;

      // 4. 落库保存至 messages 表
      try {
        db.saveMessage({
          msg_id: syntheticMsgId,
          peer,
          user_id: fromUser,
          sender_name: '',
          time: timestamp,
          type: 'emoji_like',
          content,
          raw: JSON.stringify(event),
          file_id: null,
          busid: null,
          local_path: null,
          fingerprint: null,
          recalled: 0,
          self: 0,
          reply_to: targetMsgId, // 记录被贴表情的目标消息 ID
        });
        logger.info?.(`[Plugin] 群消息贴表情事件已入库 (group: ${groupId}, target_msg: ${targetMsgId}, likes: ${likesSummary})`);
      } catch (saveErr) {
        logger.error?.('[Plugin] 群消息贴表情事件入库失败:', saveErr);
      }

      // 直接 return，绝不流转到唤醒逻辑
      return;
    }

    // 群文件上传通知处理
    if (event.notice_type === 'group_upload') {
      const file = event.file;
      if (file && event.group_id) {
        const peer = `group_${event.group_id}`;
        const fromUser = String(event.user_id || '');
        const timestamp = event.time
          ? event.time < 10000000000
            ? event.time * 1000
            : event.time
          : Date.now();
        let senderName = '';
        if (event.group_id && fromUser) {
          try {
            senderName = (await memberResolver.resolve(event.group_id, fromUser)) || '';
          } catch {}
        }
        const fakeMsgId = Number(event.message_id) || stableNoticeMsgId(`group_upload:${event.group_id}:${file.id}:${timestamp}`);

        try {
          db.saveMessage({
            msg_id: fakeMsgId,
            peer,
            user_id: fromUser,
            sender_name: senderName,
            time: timestamp,
            type: 'group_file',
            content: `[群文件:${file.name || '未知文件'} (ID:${file.id})]`,
            raw: JSON.stringify(event),
            file_id: file.id,
            busid: file.busid ?? null,
            local_path: null,
            fingerprint: null,
            recalled: 0,
            self: 0,
            reply_to: null,
          });
          logger.info?.(`[Plugin] 群文件上传事件已入库 (group: ${event.group_id}, file: ${file.name})`);
        } catch (saveErr) {
          logger.error?.('[Plugin] 群文件上传事件入库失败:', saveErr);
        }
      }
      return;
    }

    // 戳一戳入库与唤醒处理
    if (event.notice_type === 'notify' && event.sub_type === 'poke') {
      const botQQ = currentConfig().bot_qq || '';
      const fromUser = String(event.user_id ?? event.sender_id ?? event.operator_id ?? '');
      const isGroup = Boolean(event.group_id);
      const peer = isGroup ? `group_${event.group_id}` : `user_${fromUser}`;
      const isSelf = botQQ !== '' && fromUser === botQQ ? 1 : 0;
      const timestamp = event.time
        ? event.time < 10000000000
          ? event.time * 1000
          : event.time
        : Date.now();

      let senderName = '';
      if (isGroup && event.group_id) {
        try {
          senderName = (await memberResolver.resolve(event.group_id, fromUser)) || '';
        } catch {}
      }

      try {
        db.saveMessage({
          msg_id: Number(event.message_id) || stableNoticeMsgId(`poke:${peer}:${fromUser}:${timestamp}`),
          peer,
          user_id: fromUser,
          sender_name: senderName,
          time: timestamp,
          type: 'poke',
          content: '[戳一戳]',
          raw: JSON.stringify(event),
          file_id: null,
          busid: null,
          local_path: null,
          fingerprint: null,
          recalled: 0,
          self: isSelf,
          reply_to: null,
        });
      } catch (saveErr) {
        logger.error?.('[Plugin] 戳一戳消息入库失败:', saveErr);
      }

      // EN-005: 等待收集期间，戳一戳仅入库不唤醒（不触发新回合，保持等待回合独占）
      if (waitRegistry.isWaiting(peer)) {
        logger.debug?.(`[Plugin] 等待收集期间忽略戳一戳唤醒 (peer: ${peer})`);
        return;
      }

      try {
        const decision = await shouldWakeup(event, {
          bot_qq: botQQ,
          bot_nickname: (currentConfig() as any).bot_nickname || (currentConfig().aliases?.[0] ?? undefined),
          aliases: currentConfig().aliases,
          resolveNickname: (gid, qq) => memberResolver.resolve(gid, qq),
        });

        if (decision.wakeup && decision.payload) {
          const payloadPeer = decision.payload.peer;
          logger.info?.(`[Plugin] 戳一戳触发唤醒 (peer: ${payloadPeer})`);
          const blankContext = {
            msg_id: undefined as any,
            from_user: '',
            is_group: isGroup,
            trigger: 'poke',
            is_synthetic: true,
          };
          outboundBridge.trackInboundContext(payloadPeer, blankContext);
          await sessionManager.dispatchWakeup(decision.payload, {
            onMessageCreated: (userMsg) => {
              if (userMsg?.id) {
                outboundBridge.trackPendingMessage(userMsg.id, payloadPeer, blankContext);
              }
            },
          });
        }
      } catch (err) {
        logger.error?.('[Plugin] 通知事件处理异常:', err);
      }
    }
  });

  // 9. 生命周期接线
  const startServer = async () => {
    logger.info?.(`${PLUGIN_NAME} 插件已加载并就绪`);
    try {
      await server.start();
    } catch (err) {
      logger.warn?.('[Plugin] GatewayServer 启动告警 (可能端口被占用或测试环境):', err);
    }

    // 启动群聊潜水超时主动巡检定时器
    proactiveManager.startIdleChecker(() => ({
      config: currentConfig(),
      dispatchWakeup: async (payload) => {
        logger.info?.(`[Plugin] 潜水超时触发主动唤醒 (peer: ${payload.peer})`);
        const isGroup = payload.peer.startsWith('group_') || payload.peer.startsWith('qq-group-');
        const blankContext = {
          msg_id: undefined as any,
          from_user: '',
          is_group: isGroup,
          trigger: 'idle',
          is_synthetic: true,
        };
        outboundBridge.trackInboundContext(payload.peer, blankContext);
        await sessionManager.dispatchWakeup(payload, {
          onMessageCreated: (userMsg) => {
            if (userMsg?.id) {
              outboundBridge.trackPendingMessage(userMsg.id, payload.peer, blankContext);
            }
          },
        });
      },
      knownPeers: () => {
        try {
          return db.getAllSessionStates().map((s) => s.peer);
        } catch {
          return [];
        }
      },
    }));
  };

  const appReady = typeof (ctx as any).get === 'function' ? (ctx as any).get('appReady') : undefined;
  if (appReady && typeof appReady.onReady === 'function') {
    appReady.onReady(() => {
      void migrateLegacyConfig(ctx, currentConfig());
      void startServer().catch(() => {});
    });
  } else {
    // 独立环境 / 测试环境 / 未注入 appReady 的场景兜底直接触发
    void migrateLegacyConfig(ctx, currentConfig());
    void startServer().catch(() => {});
  }

  const onProcessExit = () => {
    server.stop().catch(() => {});
  };
  process.once('SIGINT', onProcessExit);
  process.once('SIGTERM', onProcessExit);
  process.once('beforeExit', onProcessExit);

  const disposePlugin = async () => {
    if (isDisposed) return;
    isDisposed = true;
    try {
      unregisterConfigRoute();
      if (typeof unregisterFacesRoutes === 'function') unregisterFacesRoutes();
    } catch {
      // ignore
    }
    logger.info?.(`${PLUGIN_NAME} 插件正在卸载`);
    process.removeListener('SIGINT', onProcessExit);
    process.removeListener('SIGTERM', onProcessExit);
    process.removeListener('beforeExit', onProcessExit);
    stopCleanupTask();
    unregisterTools();
    waitRegistry.clear();
    memoryService.dispose();
    proactiveManager.dispose();
    if (typeof stopOutboundBridge === 'function') {
      stopOutboundBridge();
    }
    try {
      outboundBridge.dispose();
      sessionManager.setOutboundBridge?.(null as any);
    } catch {}
    if (typeof unregisterApproval === 'function') {
      unregisterApproval();
    }
    if (typeof unregisterQuestionChannel === 'function') {
      unregisterQuestionChannel();
    }
    if (typeof unregisterDynamicPrompt === 'function') {
      unregisterDynamicPrompt();
    }
    await server.stop().catch(() => {});
    await sessionManager.dispose().catch(() => {});
    db.close();
  };

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      void disposePlugin();
    });
  }

  (ctx as any).on?.('dispose', () => {
    void disposePlugin();
  });
}

