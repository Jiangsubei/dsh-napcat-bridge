/**
 * dsh-napcat-bridge: 动态提示词与人格注入模块
 * 将插件配置的人格与行为准则注入 systemPrompt.context() 动态段，
 * 保护静态 KV Cache，并实现非空保底文本返回。
 */

import type { Context } from '@deepseek-ai/cordis';
import { DEFAULT_PERSONA, DEFAULT_BEHAVIOR, DEFAULT_MEMORY_GUIDANCE } from '../constants/index.js';
import type { MessageDatabase } from '../storage/database.js';

/**
 * 注册 QQ 会话专属动态提示词段 (napcat:qq_scenario)
 * AB 测试分支：清理关于如何发送消息的提示词，不注册该段。
 */
export function registerQQScenarioDynamicPrompt(_ctx: Context): () => void {
  return () => {};
}

export const registerNapCatQQScenarioPrompt = registerQQScenarioDynamicPrompt;

/**
 * 注册 NapCat 动态 System Prompt 上下文快照
 *
 * @param ctx Cordis 上下文
 * @param getPersona 读取当前助手人格配置的回调
 * @param getBehavior 读取当前行为准则配置的回调
 * @returns 注销该动态段的 Disposer 函数
 */
export function registerNapCatDynamicPrompt(
  ctx: Context,
  getPersona: () => string,
  getBehavior: () => string
): () => void {
  const systemPrompt = typeof (ctx as any).get === 'function' ? (ctx as any).get('systemPrompt') : undefined;
  if (!systemPrompt || typeof systemPrompt.context !== 'function') {
    return () => {};
  }

  return systemPrompt.context({
    name: 'napcat:behavior_persona',
    order: 50,
    text: (assembleCtx?: any) => {
      const agent = assembleCtx?.agent || assembleCtx?.scope || assembleCtx?.session;
      const sessionId =
        agent?.session?.id ||
        agent?.sessionId ||
        agent?.id ||
        (typeof agent === 'string' ? agent : '');

      const isQQSession = Boolean(
        sessionId &&
          (sessionId.startsWith('qq-group-') ||
            sessionId.startsWith('qq-user-') ||
            sessionId.startsWith('qq-'))
      );

      // Web UI normal conversation: do NOT inject QQ assistant persona/behavior
      if (sessionId && !isQQSession) {
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
 * 注册表情包动态 System Prompt 上下文锚点 (napcat:face_summary, order: 48)
 *
 * @param ctx Cordis 上下文
 * @param db 消息与表情数据库实例
 * @param getEnabled 读取当前是否开启表情包能力 (face_enabled) 的回调
 * @returns 注销该动态段的 Disposer 函数
 */
export function registerFacePromptContext(
  ctx: Context,
  db: MessageDatabase,
  getEnabled: () => boolean = () => true
): () => void {
  const systemPrompt = typeof (ctx as any).get === 'function' ? (ctx as any).get('systemPrompt') : undefined;
  if (!systemPrompt || typeof systemPrompt.context !== 'function') {
    return () => {};
  }

  return systemPrompt.context({
    name: 'napcat:face_summary',
    order: 48,
    text: (assembleCtx?: any) => {
      if (!getEnabled()) {
        return '';
      }

      const agent = assembleCtx?.agent || assembleCtx?.scope || assembleCtx?.session;
      const sessionId =
        agent?.session?.id ||
        agent?.sessionId ||
        agent?.id ||
        (typeof agent === 'string' ? agent : '');

      const isQQSession = Boolean(
        sessionId &&
          (sessionId.startsWith('qq-group-') ||
            sessionId.startsWith('qq-user-') ||
            sessionId.startsWith('qq-'))
      );

      // Web UI 普通会话或未识别 QQ 会话：不注入表情包动态段
      if (sessionId && !isQQSession) {
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


