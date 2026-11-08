/**
 * dsh-napcat-bridge: 动态提示词与上下文注入模块
 * 统一委托至 SnapshotManager，全面贯彻 Fail-Closed 白名单防御。
 */

import type { Context } from '@deepseek-ai/cordis';
import type { MessageDatabase } from '../storage/database.js';
import {
  SnapshotManager,
  isExplicitNonQQSession,
  formatFaceLibraryContext,
  formatPersonaContext,
  formatBehaviorContext,
} from './snapshot.js';
import {
  DEFAULT_PERSONA,
  DEFAULT_BEHAVIOR,
  DEFAULT_MEMORY_GUIDANCE,
  DEFAULT_FACE_STORE_MAX,
} from '../constants/index.js';

export * from './snapshot.js';

/**
 * 注册 QQ 会话专属动态提示词段 (napcat:qq_scenario)
 * 保留空实现以兼容干净度契约断言 (不产生脏注入)
 */
export function registerQQScenarioDynamicPrompt(_ctx: Context): () => void {
  return () => {};
}

/**
 * 注册 NapCat 动态上下文快照 (委托至 SnapshotManager)
 */
export function registerNapCatDynamicPrompt(
  ctx: Context,
  getPersona: () => string,
  getBehavior: () => string,
  snapshotManager?: SnapshotManager
): () => void {
  const manager = snapshotManager || (ctx as any).snapshotManager || new SnapshotManager(ctx);
  if (typeof (ctx as any).reflect?.provide === 'function' && !(ctx as any).snapshotManager) {
    (ctx as any).reflect.provide('snapshotManager', manager);
  }
  const unreg1 = manager.registerProvider({
    name: 'napcat:persona',
    order: 30,
    qqOnly: false,
    provide: (_session: any, assembleCtx: any) => {
      if (isExplicitNonQQSession(assembleCtx)) return '';
      return formatPersonaContext((getPersona() || '').trim() || DEFAULT_PERSONA);
    },
  });
  const unreg2 = manager.registerProvider({
    name: 'napcat:behavior',
    order: 35,
    qqOnly: false,
    provide: (_session: any, assembleCtx: any) => {
      if (isExplicitNonQQSession(assembleCtx)) return '';
      let effectiveBehavior = (getBehavior() || '').trim() || DEFAULT_BEHAVIOR;
      if (
        !effectiveBehavior.includes('记忆工具规则') &&
        !effectiveBehavior.includes('create_memory')
      ) {
        effectiveBehavior = `${effectiveBehavior}\n${DEFAULT_MEMORY_GUIDANCE}`.trim();
      }
      return formatBehaviorContext(effectiveBehavior);
    },
  });
  return () => {
    unreg1();
    unreg2();
  };
}

/**
 * 注册表情包动态 System Prompt 上下文锚点 (委托至 SnapshotManager)
 */
export function registerFacePromptContext(
  ctx: Context,
  db: MessageDatabase,
  getEnabled: () => boolean = () => true,
  getFaceStoreMax?: () => number,
  snapshotManager?: SnapshotManager
): () => void {
  const manager = snapshotManager || (ctx as any).snapshotManager || new SnapshotManager(ctx);
  if (typeof (ctx as any).reflect?.provide === 'function' && !(ctx as any).snapshotManager) {
    (ctx as any).reflect.provide('snapshotManager', manager);
  }
  return manager.registerProvider({
    name: 'napcat:face_summary',
    order: 48,
    provide: () => {
      if (!getEnabled()) {
        return '';
      }

      const limit = typeof getFaceStoreMax === 'function' ? getFaceStoreMax() : DEFAULT_FACE_STORE_MAX;
      const activeFacesRes = db.getActiveFacesForContext(limit);
      return formatFaceLibraryContext(activeFacesRes.faces, activeFacesRes.total);
    },
  });
}
