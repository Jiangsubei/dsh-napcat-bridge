/**
 * dsh-napcat-bridge: 多通道独立运行时快照管理器 (MultiChannelSnapshotHub)
 * 集中管理所有注入到会话的动态上下文与快照，
 * 基于 DSH agent/pre-step 瀑布流实现多通道独立状态追踪 (Multi-Channel Independent Snapshots)，
 * 并统一贯彻 Fail-Closed 白名单防御，彻底杜绝黑话、表情包、记忆、人设等泄露至 Web UI 与非 QQ 会话。
 */

import type { Context } from '@deepseek-ai/cordis';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import {
  DEFAULT_PERSONA,
  DEFAULT_BEHAVIOR,
  DEFAULT_MEMORY_GUIDANCE,
  DEFAULT_GROUP_MEMORY_TOTAL_BUDGET_CHARS,
  DEFAULT_FACE_STORE_MAX,
} from '../constants/index.js';
import type { MessageDatabase } from '../storage/database.js';
import type { MemoryStorage } from '../memory/storage.js';
import type { SlangStorage } from '../slang/storage.js';
import {
  formatFaceLibraryContext,
  formatPersonaContext,
  formatBehaviorContext,
  formatSlangContext,
  formatSessionRulesContext,
  formatUserProfilesContext,
} from './formatter.js';

export * from './formatter.js';

export interface QQSessionContext {
  peer: string;
  qq: string;
  isGroup: boolean;
  isPrivate: boolean;
}

export interface SnapshotProvider {
  name: string;
  order: number;
  /**
   * 提供动态上下文文本。
   * 当 qqOnly 为 true（默认）时，入参保证必定为已验证的 QQSessionContext。
   */
  provide: (session: QQSessionContext, assembleCtx: any) => string | null | undefined;
  /** 是否仅限 QQ 会话注入。默认为 true（贯彻 Fail-Closed 白名单防护） */
  qqOnly?: boolean;
  /** 兼容性/快捷调用接口：直接传入 assembleCtx 解析 session 并生成文本 */
  text?: (assembleCtx: any) => string;
}

export interface SnapshotManagerOptions {
  getCurrentSpeaker?: (peer: string) => string | undefined;
  logger?: {
    warn?: (message: string, ...args: any[]) => void;
    info?: (message: string, ...args: any[]) => void;
  };
}

/**
 * 判断 assembleCtx 是否属于明确的非 QQ 会话 (如 Web UI 会话、Coding 沙箱等)
 */
export function isExplicitNonQQSession(assembleCtx?: unknown): boolean {
  if (!assembleCtx || typeof assembleCtx !== 'object') {
    return false;
  }
  const anyCtx = assembleCtx as Record<string, any>;
  const session = anyCtx.session || anyCtx.agent?.session || anyCtx.agent;
  const rawId =
    session?.id ||
    session?.sessionId ||
    anyCtx.sessionId ||
    anyCtx.peer ||
    (typeof anyCtx.scope === 'string' ? anyCtx.scope : '');

  if (typeof rawId !== 'string' || !rawId.trim()) {
    return false;
  }
  const trimmed = rawId.trim();
  const isQQ =
    trimmed.startsWith('qq-group-') ||
    trimmed.startsWith('group_') ||
    trimmed.startsWith('group-') ||
    trimmed.startsWith('qq-user-') ||
    trimmed.startsWith('user_') ||
    trimmed.startsWith('user-') ||
    trimmed.startsWith('qq-');

  return !isQQ;
}

/**
 * 严格 Fail-Closed: 从 assembleCtx 解析合法的 QQ 会话上下文。
 * 无法提取或属于非 QQ 会话（Web、沙箱、未知格式、空上下文）时坚决返回 null。
 */
export function resolveQQSessionContext(
  assembleCtx?: unknown,
  getCurrentSpeaker?: (peer: string) => string | undefined
): QQSessionContext | null {
  if (!assembleCtx || typeof assembleCtx !== 'object') {
    return null;
  }

  const anyCtx = assembleCtx as Record<string, any>;
  const session = anyCtx.session || anyCtx.agent?.session || anyCtx.agent;
  const rawId =
    session?.id ||
    session?.sessionId ||
    anyCtx.sessionId ||
    anyCtx.peer ||
    (typeof anyCtx.scope === 'string' ? anyCtx.scope : '');

  if (typeof rawId !== 'string' || !rawId.trim()) {
    return null;
  }

  const trimmed = rawId.trim();

  // 显式排除 review 等后台沙箱或非 QQ 格式
  if (
    trimmed.startsWith('review-') ||
    trimmed.startsWith('web-') ||
    trimmed.startsWith('desktop-') ||
    trimmed.startsWith('s-') ||
    trimmed === 'default'
  ) {
    return null;
  }

  let peer: string | null = null;
  let qq = 'default';

  // 1. 群聊匹配: qq-group-123456 或 group_123456 或 group-123456
  const groupMatch = trimmed.match(/^(?:qq-group-|group_|group-)(\d+)/);
  if (groupMatch) {
    peer = `group_${groupMatch[1]}`;
  } else {
    // 2. 私聊匹配: qq-user-123456 或 user_123456 或 user-123456 或 qq-123456
    const userMatch = trimmed.match(/^(?:qq-user-|user_|user-|qq-)(\d+)/);
    if (userMatch) {
      peer = `user_${userMatch[1]}`;
      qq = userMatch[1];
    }
  }

  if (!peer) {
    return null;
  }

  // 3. 发言人解析: 若提供了 getCurrentSpeaker 且为群聊，尝试提取当前发言人
  if (getCurrentSpeaker && peer.startsWith('group_')) {
    const speaker = getCurrentSpeaker(peer);
    if (typeof speaker === 'string' && speaker.trim()) {
      qq = speaker.trim();
    }
  }

  return {
    peer,
    qq,
    isGroup: peer.startsWith('group_'),
    isPrivate: peer.startsWith('user_'),
  };
}

/**
 * 多通道独立快照注入管理器 (MultiChannelSnapshotHub)
 */
export class SnapshotManager {
  private providers = new Map<string, SnapshotProvider>();
  /** 会话维度的独立快照缓存：sessionId -> (channelName -> lastRenderedText) */
  private retained = new Map<string, Map<string, string>>();
  private preStepDisposer?: () => void;

  constructor(
    private ctx: Context,
    private options: SnapshotManagerOptions = {}
  ) {
    this.setupPreStepListener();
  }

  /**
   * 注册 agent/pre-step 瀑布流钩子，实现各通道独立增量注入
   */
  private setupPreStepListener(): void {
    if (!this.ctx || typeof (this.ctx as any).on !== 'function') {
      return;
    }

    try {
      const unreg = (this.ctx as any).on(
        'agent/pre-step',
        async (args: any, next: any) => {
          return this.handlePreStep(args, next);
        }
      );
      this.preStepDisposer = typeof unreg === 'function' ? unreg : undefined;
    } catch (err) {
      this.options.logger?.warn?.(
        '[SnapshotManager] 挂载 agent/pre-step 钩子异常:',
        err
      );
    }
  }

  /**
   * 执行 pre-step 多通道独立快照检查与注入
   */
  public async handlePreStep(args: any, next?: any): Promise<any> {
    const decision =
      typeof next === 'function'
        ? await next()
        : { kind: 'enter', messages: args?.messages || [] };

    if (decision?.kind === 'reject') {
      return decision;
    }

    const agent = args?.agent;
    const signal = args?.signal;
    signal?.throwIfAborted?.();

    const assembleCtx = {
      agent,
      session: agent?.session,
      ...args,
    };

    // 严格 Fail-Closed 安全白名单门控：非 QQ 会话绝不注入任何快照消息
    const session = resolveQQSessionContext(
      assembleCtx,
      this.options.getCurrentSpeaker
    );
    if (!session) {
      return decision;
    }

    const sessionId = agent?.session?.id || session.peer;
    let sessionRetained = this.retained.get(sessionId);
    if (!sessionRetained) {
      sessionRetained = new Map<string, string>();
      this.retained.set(sessionId, sessionRetained);
      this.restoreSessionRetained(agent?.session, sessionRetained);
    }

    const sorted = Array.from(this.providers.values()).sort(
      (a, b) => a.order - b.order
    );
    const injections: any[] = [];

    for (const provider of sorted) {
      if (provider.qqOnly !== false && !session) {
        continue;
      }

      try {
        const raw = provider.provide(session, assembleCtx);
        const newText = (raw || '').trim();
        const lastText = sessionRetained.get(provider.name);

        if (newText && newText !== lastText) {
          // 该通道产生增量/变更快照，生成专属 UserMessage 注入会话
          const msg = this.createChannelSnapshotMessage(provider.name, newText);
          injections.push(msg);
          sessionRetained.set(provider.name, newText);
        } else if (!newText && lastText) {
          // 内容被清空
          sessionRetained.delete(provider.name);
        }
      } catch (err) {
        this.options.logger?.warn?.(
          `[SnapshotManager] Provider ${provider.name} 独立快照渲染异常:`,
          err
        );
      }
    }

    if (injections.length === 0) {
      return decision;
    }

    const existingMessages = Array.isArray(decision.messages)
      ? decision.messages
      : [];

    return {
      ...decision,
      messages: [...existingMessages, ...injections],
    };
  }

  /**
   * 构造通道独立快照 UserMessage
   */
  public createChannelSnapshotMessage(channelName: string, text: string): any {
    const reminderText = [
      `<system-reminder>`,
      `Current runtime context: ${channelName}. This snapshot supersedes earlier ${channelName} snapshots in this session.`,
      ``,
      text,
      `</system-reminder>`,
    ].join('\n');

    try {
      return createUserMessage({
        content: [{ type: 'text', text: reminderText }],
        source: {
          kind: channelName as any,
          form: 'snapshot',
          sections: [{ name: channelName, text }],
        },
      });
    } catch {
      // 在未挂载完整 dsh-llm 运行时的降级对象构造
      return {
        id: `snap-${channelName.replace(/[^a-zA-Z0-9_-]/g, '_')}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        role: 'user',
        content: [{ type: 'text', text: reminderText }],
        source: {
          kind: channelName,
          form: 'snapshot',
          sections: [{ name: channelName, text }],
        },
      };
    }
  }

  /**
   * 尝试从历史消息恢复 retained 状态（服务重启或断线重连场景）
   */
  private restoreSessionRetained(
    session: any,
    sessionRetained: Map<string, string>
  ): void {
    if (!session || typeof session.snapshotEvents !== 'function') return;
    try {
      const events = session.snapshotEvents();
      if (!Array.isArray(events)) return;
      for (let i = events.length - 1; i >= 0; i--) {
        const ev = events[i];
        if (ev?.type === 'user/message') {
          const src = ev.data?.source || ev.data?.message?.source;
          if (
            src &&
            typeof src.kind === 'string' &&
            src.form === 'snapshot' &&
            !sessionRetained.has(src.kind)
          ) {
            const text = src.sections?.[0]?.text;
            if (typeof text === 'string') {
              sessionRetained.set(src.kind, text);
            }
          }
        }
      }
    } catch {}
  }

  /**
   * 注册一个动态上下文通道 Provider
   */
  registerProvider(provider: SnapshotProvider): () => void {
    this.unregisterProvider(provider.name);
    const wrapped: SnapshotProvider = {
      ...provider,
      text: (assembleCtx: any) => {
        const session = resolveQQSessionContext(
          assembleCtx,
          this.options.getCurrentSpeaker
        );
        if (provider.qqOnly !== false && !session) {
          return '';
        }
        return (provider.provide(session as any, assembleCtx) || '').trim();
      },
    };
    this.providers.set(provider.name, wrapped);

    return () => {
      this.unregisterProvider(provider.name);
    };
  }

  unregisterProvider(name: string): void {
    this.providers.delete(name);
  }

  public getProvider(name: string): SnapshotProvider | undefined {
    return this.providers.get(name);
  }

  public getRetained(sessionId: string, channelName: string): string | undefined {
    return this.retained.get(sessionId)?.get(channelName);
  }

  public clearRetained(sessionId?: string): void {
    if (sessionId) {
      this.retained.delete(sessionId);
    } else {
      this.retained.clear();
    }
  }

  dispose(): void {
    if (this.preStepDisposer) {
      try {
        this.preStepDisposer();
      } catch {}
      this.preStepDisposer = undefined;
    }
    this.providers.clear();
    this.retained.clear();
  }
}

export interface SetupSnapshotHubOptions {
  ctx: Context;
  db: MessageDatabase;
  memoryStorage?: MemoryStorage;
  slangStorage?: SlangStorage;
  getCurrentSpeaker?: (peer: string) => string | undefined;
  getGroupMemoryBudget?: () => number;
  getSlangEnabled?: () => boolean;
  getFaceEnabled?: () => boolean;
  getFaceStoreMax?: () => number;
  getPersona?: () => string;
  getBehavior?: () => string;
  logger?: {
    warn?: (message: string, ...args: any[]) => void;
    info?: (message: string, ...args: any[]) => void;
  };
}

/**
 * 在插件装配入口装配 6 大独立动态快照通道 (Multi-Channel Snapshot Hub)
 */
export function setupSnapshotHub(options: SetupSnapshotHubOptions): SnapshotManager {
  const manager = new SnapshotManager(options.ctx, {
    getCurrentSpeaker: options.getCurrentSpeaker,
    logger: options.logger,
  });

  const getEffectivePersona = () => (options.getPersona?.() || '').trim() || DEFAULT_PERSONA;
  const getEffectiveBehavior = () => {
    let b = (options.getBehavior?.() || '').trim() || DEFAULT_BEHAVIOR;
    if (
      !b.includes('记忆工具规则') &&
      !b.includes('create_memory')
    ) {
      b = `${b}\n${DEFAULT_MEMORY_GUIDANCE}`.trim();
    }
    return b;
  };

  // 1. 通道 A: 人格设定 (napcat:persona, order: 30)
  manager.registerProvider({
    name: 'napcat:persona',
    order: 30,
    qqOnly: false,
    provide: (_session, assembleCtx) => {
      if (isExplicitNonQQSession(assembleCtx)) return '';
      return formatPersonaContext(getEffectivePersona());
    },
  });

  // 2. 通道 B: 行为准则 (napcat:behavior, order: 35)
  manager.registerProvider({
    name: 'napcat:behavior',
    order: 35,
    qqOnly: false,
    provide: (_session, assembleCtx) => {
      if (isExplicitNonQQSession(assembleCtx)) return '';
      return formatBehaviorContext(getEffectiveBehavior());
    },
  });

  // 3. 通道 C: 会话规则与约定 (napcat:session_rules, order: 40)
  if (options.memoryStorage) {
    const memStorage = options.memoryStorage;
    manager.registerProvider({
      name: 'napcat:session_rules',
      order: 40,
      provide: (session) => {
        const raw = memStorage.getSessionRulesSnapshotSync(session.peer);
        return raw ? formatSessionRulesContext(raw) : '';
      },
    });

    // 4. 通道 D: 用户画像与群成员 (napcat:user_profiles, order: 42)
    manager.registerProvider({
      name: 'napcat:user_profiles',
      order: 42,
      provide: (session) => {
        const peer = session.peer;
        const currentQQ = session.qq !== 'default' ? session.qq : undefined;

        let raw = '';
        if (session.isPrivate) {
          raw = memStorage.getUserProfilesSnapshotSync(
            peer,
            [{ qq: session.qq, name: session.qq }],
            DEFAULT_GROUP_MEMORY_TOTAL_BUDGET_CHARS,
            currentQQ
          );
        } else {
          let activeUsers: Array<{ qq: string; name: string }> = [];
          try {
            const rows = options.db.getActiveUsers(peer, 7, 15);
            activeUsers = rows.map((r) => ({ qq: r.user_id, name: r.sender_name }));
          } catch {}

          const groupBudget = options.getGroupMemoryBudget?.() ?? DEFAULT_GROUP_MEMORY_TOTAL_BUDGET_CHARS;
          raw = memStorage.getUserProfilesSnapshotSync(peer, activeUsers, groupBudget, currentQQ);
        }

        return raw ? formatUserProfilesContext(raw) : '';
      },
    });
  }

  // 5. 通道 E: 社群黑话知识库 (napcat:slang, order: 45)
  if (options.slangStorage) {
    const sStorage = options.slangStorage;
    manager.registerProvider({
      name: 'napcat:slang',
      order: 45,
      provide: () => {
        if (options.getSlangEnabled && !options.getSlangEnabled()) {
          return '';
        }
        const rawMarkdown = sStorage.getRawMarkdownSync();
        if (!rawMarkdown || !rawMarkdown.trim()) {
          return '';
        }
        return formatSlangContext(rawMarkdown.trim());
      },
    });
  }

  // 6. 通道 F: 本地表情包库存 (napcat:face_summary, order: 48)
  manager.registerProvider({
    name: 'napcat:face_summary',
    order: 48,
    provide: () => {
      if (options.getFaceEnabled && !options.getFaceEnabled()) {
        return '';
      }
      const limit =
        typeof options.getFaceStoreMax === 'function'
          ? options.getFaceStoreMax()
          : DEFAULT_FACE_STORE_MAX;
      const activeFacesRes = options.db.getActiveFacesForContext(limit);
      return formatFaceLibraryContext(activeFacesRes.faces, activeFacesRes.total);
    },
  });

  return manager;
}
