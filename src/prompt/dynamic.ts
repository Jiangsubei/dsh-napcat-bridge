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
 * 注册 NapCat 动态 System Prompt 上下文快照 (委托至 SnapshotManager)
 */
export function registerNapCatDynamicPrompt(
  ctx: Context,
  getPersona: () => string,
  getBehavior: () => string
): () => void {
  const manager = new SnapshotManager(ctx);
  return manager.registerProvider({
    name: 'napcat:behavior_persona',
    order: 50,
    qqOnly: false,
    provide: (_session, assembleCtx) => {
      if (isExplicitNonQQSession(assembleCtx)) {
        return '';
      }

      const p = (getPersona() || '').trim();
      const b = (getBehavior() || '').trim();

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
}

/**
 * 注册表情包动态 System Prompt 上下文锚点 (委托至 SnapshotManager)
 */
export function registerFacePromptContext(
  ctx: Context,
  db: MessageDatabase,
  getEnabled: () => boolean = () => true,
  getFaceStoreMax?: () => number
): () => void {
  const manager = new SnapshotManager(ctx);
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
