/**
 * dsh-napcat-bridge: 黑话学习套件核心模块
 * 组合 SlangStorage, SlangTools 与 SystemPrompt 动态段注入。
 */

import type { Context } from '@deepseek-ai/cordis';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import { SlangStorage } from './storage.js';
import { createSlangToolDefinitions } from './tools.js';
import { DEFAULT_SLANG_BUDGET_CHARS, DEFAULT_SLANG_STORAGE_PATH } from '../constants/index.js';
import { resolveDshPath } from '../utils/path.js';

export * from './storage.js';
export * from './tools.js';

export interface SlangServiceOptions {
  storagePath?: string;
  dshHome?: string;
  budgetChars?: number | (() => number);
  getBudgetChars?: () => number;
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
        '以下为社群中常见并跨会话沉淀的黑话、缩写与调侃用法，请在理解群友发言与交流时自如参考：',
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
  const getBudget = () =>
    options.getBudgetChars?.() ??
    (typeof options.budgetChars === 'function' ? options.budgetChars() : options.budgetChars) ??
    DEFAULT_SLANG_BUDGET_CHARS;

  const getEnabled = () =>
    options.getEnabled?.() ??
    (typeof options.enabled === 'function' ? options.enabled() : options.enabled) ??
    true;

  const storage = new SlangStorage(options.storagePath || DEFAULT_SLANG_STORAGE_PATH, getBudget, effectiveDshHome);
  const toolDefs = createSlangToolDefinitions(storage);

  const unregisters: Array<() => void> = [];

  // 1. 注册 Slang 工具到 DSH ctx.tools
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

  // 2. 注册 systemPrompt.context 动态黑话段
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
