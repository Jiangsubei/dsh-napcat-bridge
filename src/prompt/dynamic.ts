/**
 * dsh-napcat-bridge: 动态提示词与上下文注入模块
 * 统一委托至 SnapshotManager，全面贯彻 Fail-Closed 白名单防御。
 */

import type { Context } from '@deepseek-ai/cordis';
import type { MessageDatabase } from '../storage/database.js';
import { SnapshotManager, isExplicitNonQQSession } from './snapshot.js';
import {
  DEFAULT_PERSONA,
  DEFAULT_BEHAVIOR,
  DEFAULT_MEMORY_GUIDANCE,
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

      const parts: string[] = [];
      if (effectivePersona) parts.push(effectivePersona);
      if (effectiveBehavior) parts.push(effectiveBehavior);

      const result = parts.join('\n\n').trim();
      return result || DEFAULT_BEHAVIOR;
    },
  });
}

/**
 * 注册表情包动态 System Prompt 上下文锚点 (委托至 SnapshotManager)
 */
export function registerFacePromptContext(
  ctx: Context,
  db: MessageDatabase,
  getEnabled: () => boolean = () => true
): () => void {
  const manager = new SnapshotManager(ctx);
  return manager.registerProvider({
    name: 'napcat:face_summary',
    order: 48,
    provide: () => {
      if (!getEnabled()) {
        return '';
      }

      const summary = db.getFaceMoodSummary(8);
      if (summary.total === 0) {
        return '[本地表情库概览：当前库为空。若聊天中出现有趣的梗图或表情，可调用 collect_face 进行收录打标。]';
      }

      const moodParts = summary.moods.map((m) => `${m.mood}(${m.count})`);
      const moodText = moodParts.length > 0 ? `当前可用情绪：${moodParts.join(', ')}。` : '';

      return `[本地表情库概览：共 ${summary.total} 张表情包。${moodText}表达相应情绪时，可直接使用对应 mood 调用 list_faces 查询并配合 send_face 发送。]`;
    },
  });
}
