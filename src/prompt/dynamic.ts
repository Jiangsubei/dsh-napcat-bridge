/**
 * dsh-napcat-bridge: 动态提示词与人格注入模块
 * 将插件配置的人格与行为准则注入 systemPrompt.context() 动态段，
 * 保护静态 KV Cache，并实现非空保底文本返回。
 */

import type { Context } from '@deepseek-ai/cordis';
import { DEFAULT_PERSONA, DEFAULT_BEHAVIOR } from '../constants/index.js';

/**
 * 定稿 QQ 会话专属动态段提示词内容 (需求 B §2.2)
 *
 * 引导大模型在 QQ 会话中主动调用 send_qq_message 工具回复用户。
 * 口径要求：只提如何回复，必须调用该工具，请勿直接在回复正文中回复；
 * 不提 Web UI，严禁告知 turn/end 兜底机制（隐形安全网）。
 */
export const QQ_SCENARIO_PROMPT = `# 如何发送消息

你正在 QQ 聊天中与用户对话。

【如何把内容送达用户】
- 想向用户发送文字/答复，必须调用 send_qq_message 工具。`;

/**
 * 判断指定 ID 是否为合法普通 QQ 会话标识符（群聊 / 私聊）
 */
function isQQSessionIdentifier(id: string): boolean {
  if (!id || typeof id !== 'string') return false;
  const s = id.trim();
  // 排除 review 等后台沙箱环境
  if (s.startsWith('review-')) return false;
  return (
    s.startsWith('qq-group-') ||
    s.startsWith('qq-user-') ||
    s.startsWith('group_') ||
    s.startsWith('user_')
  );
}

/**
 * 从 assemble 上下文中检测是否属于普通 QQ 会话
 * 支持 session.id, sessionId, peer, agent 等常见注入结构
 */
export function isQQSessionContext(assembleCtx?: any): boolean {
  if (!assembleCtx) return false;

  // 1. 显式 peer
  if (typeof assembleCtx.peer === 'string' && isQQSessionIdentifier(assembleCtx.peer)) {
    return true;
  }

  // 2. agent / scope / session 嵌套对象
  const agent = assembleCtx.agent || assembleCtx.scope || assembleCtx.session;
  const rawId =
    agent?.session?.id ||
    agent?.sessionId ||
    agent?.id ||
    assembleCtx.sessionId ||
    assembleCtx.session?.id ||
    (typeof agent === 'string' ? agent : '') ||
    (typeof assembleCtx.scope === 'string' ? assembleCtx.scope : '');

  if (typeof rawId === 'string' && isQQSessionIdentifier(rawId)) {
    return true;
  }

  return false;
}

/**
 * 注册 QQ 会话专属动态提示词段 (napcat:qq_scenario)
 *
 * order 设为 10（排在动态段最前，位于记忆段 40、人格段 50 之前）。
 * 过滤条件：仅对 QQ 会话（qq-group-* / qq-user-* / group_* / user_*）返回段文本；
 * 非 QQ 会话（如 Web UI、沙箱）返回空字符串 ''。
 *
 * @param ctx Cordis 上下文
 * @returns 注销该动态段的 Disposer 函数
 */
export function registerQQScenarioDynamicPrompt(ctx: Context): () => void {
  const systemPrompt = ctx.get('systemPrompt') || (ctx as any).systemPrompt;
  if (!systemPrompt || typeof systemPrompt.context !== 'function') {
    return () => {};
  }

  return systemPrompt.context({
    name: 'napcat:qq_scenario',
    order: 10,
    text: (assembleCtx?: any) => {
      if (!isQQSessionContext(assembleCtx)) {
        return '';
      }
      return QQ_SCENARIO_PROMPT;
    },
  });
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
  const systemPrompt = ctx.get('systemPrompt') || (ctx as any).systemPrompt;
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
      const effectiveBehavior = b || DEFAULT_BEHAVIOR;

      const parts: string[] = [];
      if (effectivePersona) parts.push(effectivePersona);
      if (effectiveBehavior) parts.push(effectiveBehavior);

      const result = parts.join('\n\n').trim();
      return result || DEFAULT_BEHAVIOR;
    },
  });
}

