/**
 * dsh-napcat-bridge: 统一运行时动态快照与上下文注入管理器 (SnapshotManager)
 * 集中管理所有注入到 DSH systemPrompt.context 的动态段，
 * 统一执行 Fail-Closed 白名单校验，彻底杜绝黑话、表情包、记忆、人设等泄露至 Web UI 与非 QQ 会话。
 */

import type { Context } from '@deepseek-ai/cordis';
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
  formatMemoryContext,
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
 * 统一快照注入管理器
 */
export class SnapshotManager {
  private providers = new Map<string, SnapshotProvider>();
  private disposers = new Map<string, () => void>();

  constructor(
    private ctx: Context,
    private options: SnapshotManagerOptions = {}
  ) {}

  /**
   * 注册一个动态上下文 Provider
   */
  registerProvider(provider: SnapshotProvider): () => void {
    this.unregisterProvider(provider.name);
    this.providers.set(provider.name, provider);

    const systemPrompt =
      typeof (this.ctx as any).get === 'function'
        ? (this.ctx as any).get('systemPrompt')
        : (this.ctx as any).systemPrompt;

    if (!systemPrompt || typeof systemPrompt.context !== 'function') {
      return () => {
        this.unregisterProvider(provider.name);
      };
    }

    const unregister = systemPrompt.context({
      name: provider.name,
      order: provider.order,
      text: (assembleCtx?: any) => {
        // 安全底线门控：默认 qqOnly 为 true（Fail-Closed）
        if (provider.qqOnly !== false) {
          const session = resolveQQSessionContext(
            assembleCtx,
            this.options.getCurrentSpeaker
          );
          if (!session) {
            return '';
          }
          try {
            const res = provider.provide(session, assembleCtx);
            return res || '';
          } catch (err) {
            this.options.logger?.warn?.(
              `[SnapshotManager] Provider ${provider.name} 渲染异常，降级为空:`,
              err
            );
            return '';
          }
        }

        // 非 qqOnly（显式允许全局注入的 Provider）
        try {
          const session =
            resolveQQSessionContext(assembleCtx, this.options.getCurrentSpeaker) || {
              peer: '',
              qq: '',
              isGroup: false,
              isPrivate: false,
            };
          const res = provider.provide(session, assembleCtx);
          return res || '';
        } catch (err) {
          this.options.logger?.warn?.(
            `[SnapshotManager] Provider ${provider.name} 渲染异常，降级为空:`,
            err
          );
          return '';
        }
      },
    });

    const disposer = () => {
      this.unregisterProvider(provider.name);
      try {
        unregister();
      } catch {}
    };

    this.disposers.set(provider.name, disposer);
    return disposer;
  }

  unregisterProvider(name: string): void {
    this.providers.delete(name);
    const disposer = this.disposers.get(name);
    if (disposer) {
      this.disposers.delete(name);
      try {
        disposer();
      } catch {}
    }
  }

  dispose(): void {
    for (const disposer of Array.from(this.disposers.values())) {
      try {
        disposer();
      } catch {}
    }
    this.providers.clear();
    this.disposers.clear();
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
 * 在插件装配入口一次性装配所有动态快照 Provider
 */
export function setupSnapshotHub(options: SetupSnapshotHubOptions): SnapshotManager {
  const manager = new SnapshotManager(options.ctx, {
    getCurrentSpeaker: options.getCurrentSpeaker,
    logger: options.logger,
  });

  // 1. 注册记忆与画像动态段 (napcat:memory, order: 40)
  if (options.memoryStorage) {
    const memStorage = options.memoryStorage;
    manager.registerProvider({
      name: 'napcat:memory',
      order: 40,
      provide: (session) => {
        const peer = session.peer;
        const currentQQ = session.qq !== 'default' ? session.qq : undefined;

        let raw = '';
        if (session.isPrivate) {
          raw = memStorage.getPromptSnapshotSync(
            peer,
            [{ qq: session.qq, name: session.qq }],
            DEFAULT_GROUP_MEMORY_TOTAL_BUDGET_CHARS,
            currentQQ
          );
        } else {
          // 群聊活跃用户
          let activeUsers: Array<{ qq: string; name: string }> = [];
          try {
            const rows = options.db.getActiveUsers(peer, 7, 15);
            activeUsers = rows.map((r) => ({ qq: r.user_id, name: r.sender_name }));
          } catch {}

          const groupBudget = options.getGroupMemoryBudget?.() ?? DEFAULT_GROUP_MEMORY_TOTAL_BUDGET_CHARS;
          raw = memStorage.getPromptSnapshotSync(peer, activeUsers, groupBudget, currentQQ);
        }

        return raw ? formatMemoryContext(raw) : '';
      },
    });
  }

  // 2. 注册黑话动态段 (napcat:slang, order: 45)
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

  // 3. 注册表情包全量动态段 (napcat:face_summary, order: 48)
  manager.registerProvider({
    name: 'napcat:face_summary',
    order: 48,
    provide: () => {
      if (options.getFaceEnabled && !options.getFaceEnabled()) {
        return '';
      }
      const limit = typeof options.getFaceStoreMax === 'function' ? options.getFaceStoreMax() : DEFAULT_FACE_STORE_MAX;
      const activeFacesRes = options.db.getActiveFacesForContext(limit);
      return formatFaceLibraryContext(activeFacesRes.faces, activeFacesRes.total);
    },
  });

  // 4. 注册人格与行为准则动态段 (napcat:behavior_persona, order: 50)
  manager.registerProvider({
    name: 'napcat:behavior_persona',
    order: 50,
    qqOnly: false,
    provide: (_session, assembleCtx) => {
      // 显式指向非 QQ 会话（如 Web UI 普通会话）时静默阻断
      if (isExplicitNonQQSession(assembleCtx)) {
        return '';
      }

      const p = (options.getPersona?.() || '').trim();
      const b = (options.getBehavior?.() || '').trim();

      const effectivePersona = p || DEFAULT_PERSONA;
      let effectiveBehavior = b || DEFAULT_BEHAVIOR;
      if (
        !effectiveBehavior.includes('记忆工具规则') &&
        !effectiveBehavior.includes('create_memory')
      ) {
        effectiveBehavior = `${effectiveBehavior}\n${DEFAULT_MEMORY_GUIDANCE}`.trim();
      }

      const personaBlock = formatPersonaContext(effectivePersona);
      const behaviorBlock = formatBehaviorContext(effectiveBehavior);

      const parts: string[] = [];
      if (personaBlock) parts.push(personaBlock);
      if (behaviorBlock) parts.push(behaviorBlock);

      return parts.join('\n\n').trim();
    },
  });

  return manager;
}
