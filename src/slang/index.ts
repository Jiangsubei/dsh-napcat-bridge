/**
 * dsh-napcat-bridge: 黑话学习套件核心模块
 * 组合 SlangStorage, SlangTools 与 SystemPrompt 动态段注入。
 */

import type { Context } from '@deepseek-ai/cordis';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import { SlangStorage } from './storage.js';
import { createSlangToolDefinitions } from './tools.js';
import {
  DEFAULT_SLANG_MAX_ENTRIES,
  DEFAULT_SLANG_EVICT_POLICY,
  DEFAULT_SLANG_STORAGE_PATH,
  DEFAULT_DATABASE_PATH,
} from '../constants/index.js';
import { resolveDshPath } from '../utils/path.js';
import type { MessageDatabase } from '../storage/database.js';
import { migrateSlangStorage } from '../storage/slang-migration.js';

export * from './storage.js';
export * from './tools.js';

export interface SlangServiceOptions {
  db?: MessageDatabase;
  storagePath?: string;
  dshHome?: string;
  maxEntries?: number | (() => number);
  getMaxEntries?: () => number;
  evictPolicy?: 'reject' | 'evict_lru' | (() => 'reject' | 'evict_lru');
  getEvictPolicy?: () => 'reject' | 'evict_lru';
  enabled?: boolean | (() => boolean);
  getEnabled?: () => boolean;
  /** 是否向 root ctx.tools 注册全局 Slang 工具（默认 true） */
  registerGlobalTools?: boolean;
}

/**
 * 注册动态上下文段 (systemPrompt.context: napcat:slang, order: 45)
 */
export function registerSlangPromptContext(
  ctx: Context,
  storage: SlangStorage,
  getEnabled: () => boolean = () => true
): () => void {
  const systemPrompt = typeof (ctx as any).get === 'function' ? (ctx as any).get('systemPrompt') : undefined;
  if (!systemPrompt || typeof systemPrompt.context !== 'function') {
    return () => {};
  }

  return systemPrompt.context({
    name: 'napcat:slang',
    order: 45,
    text: () => {
      if (!getEnabled()) {
        return '';
      }
      const rawMarkdown = storage.getRawMarkdownSync();
      if (!rawMarkdown || !rawMarkdown.trim()) {
        return '';
      }
      return [
        '# 社群黑话与网络流行语知识库 (Slang & Memes)',
        '以下为社群中常见并跨会话沉淀的黑话、缩写与调侃用法（如果已经有对应条目的话，请先使用 query_slang 工具查询详细释义与例句）：',
        rawMarkdown.trim(),
      ].join('\n\n');
    },
  });
}

/**
 * 装配并启动 Slang 服务
 */
export function setupSlangService(
  ctx: Context,
  options: SlangServiceOptions = {}
): {
  storage: SlangStorage;
  tools: ToolDefinition[];
  dispose: () => void;
} {
  const effectiveDshHome = resolveDshPath(options.dshHome);
  const getMaxEntries = () =>
    options.getMaxEntries?.() ??
    (typeof options.maxEntries === 'function' ? options.maxEntries() : options.maxEntries) ??
    DEFAULT_SLANG_MAX_ENTRIES;

  const getEvictPolicy = () =>
    options.getEvictPolicy?.() ??
    (typeof options.evictPolicy === 'function' ? options.evictPolicy() : options.evictPolicy) ??
    DEFAULT_SLANG_EVICT_POLICY;

  const getEnabled = () =>
    options.getEnabled?.() ??
    (typeof options.enabled === 'function' ? options.enabled() : options.enabled) ??
    true;

  // 1. 初始化 Storage
  const storage = new SlangStorage(
    options.db || options.storagePath || DEFAULT_DATABASE_PATH,
    getMaxEntries,
    getEvictPolicy,
    effectiveDshHome
  );

  // 2. 存量旧版 Markdown 平滑迁移（若有且不删物理文件）
  try {
    migrateSlangStorage({
      db: storage.getDatabase(),
      dshHome: effectiveDshHome,
      storagePath: options.storagePath || DEFAULT_SLANG_STORAGE_PATH,
    });
  } catch {}

  const toolDefs = createSlangToolDefinitions(storage);
  const unregisters: Array<() => void> = [];

  // 3. 注册 Slang 工具到 DSH ctx.tools
  const doRegisterTools = (toolsService: any) => {
    if (!toolsService || typeof toolsService.register !== 'function') return;
    for (const def of toolDefs) {
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

  // 4. 注册 systemPrompt.context 动态黑话段
  const promptDisposer = registerSlangPromptContext(ctx, storage, getEnabled);
  unregisters.push(promptDisposer);

  return {
    storage,
    tools: toolDefs,
    dispose: () => {
      for (const unreg of unregisters) {
        try {
          unreg();
        } catch {}
      }
    },
  };
}
