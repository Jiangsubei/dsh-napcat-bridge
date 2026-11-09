/**
 * dsh-napcat-bridge: Token 与用量格式化工具
 */

import type { Context } from '@deepseek-ai/cordis';
import type { Session } from '@deepseek-ai/dsh-session';
import type { SessionManager } from '../../gateway/session.js';
import { safeGetService } from '../../gateway/session/agent-runner.js';

/**
 * 格式化 Token 数量为紧凑字符串（对齐 WebUI formatTokens：<1k 直接显示，<1M 显示 XXK，>=1M 显示 XXM）
 */
export function formatTokens(value: number): string {
  if (typeof value !== 'number' || isNaN(value) || value <= 0) return '0';
  const scaled = (candidate: number) =>
    candidate >= 100
      ? String(Math.round(candidate))
      : String(Math.round(candidate * 10) / 10);
  if (value < 1e3) return String(value);
  if (value < 1e6) return `${scaled(value / 1e3)}K`;
  return `${scaled(value / 1e6)}M`;
}

/**
 * 获取当前会话上下文用量简报（方案 B：~3.2K / 128K (2%) 或 ~3.2K）
 */
export async function getContextUsageBrief(
  ctx: Context,
  session: Session,
  sessionManager?: SessionManager
): Promise<string> {
  const tokenMeter = safeGetService(ctx, 'tokenMeter');
  if (!tokenMeter?.measure) return '0';
  let totalTokens = 0;
  try {
    const usage = tokenMeter.measure(session);
    totalTokens = usage?.totalTokens ?? 0;
  } catch {
    return '0';
  }

  let contextWindow: number | undefined;
  const sessionProjections = safeGetService(ctx, 'sessionProjections');
  if (sessionProjections && typeof sessionProjections.snapshot === 'function') {
    try {
      const snap = sessionProjections.snapshot(session, ['contextPressure']);
      if (snap?.values?.contextPressure?.contextWindow) {
        contextWindow = snap.values.contextPressure.contextWindow;
      }
    } catch {}
  }

  if (contextWindow === undefined) {
    try {
      const curSel = sessionManager?.getModelSelection(session.id);
      const provider = curSel?.provider || 'deepseek-official';
      const model = curSel?.model || 'deepseek-v4-flash';
      const llm = safeGetService(ctx, 'llm');
      if (llm && typeof llm.resolveModel === 'function') {
        const info = await llm.resolveModel(provider, model);
        if (info?.context?.contextWindow) contextWindow = info.context.contextWindow;
      }
    } catch {}
  }

  const fmt = (v: number) => (v > 0 ? `~${formatTokens(v)}` : '0');
  if (contextWindow && contextWindow > 0) {
    const percent = Math.min(100, Math.round((totalTokens / contextWindow) * 100));
    return `${fmt(totalTokens)} / ${formatTokens(contextWindow)} (${percent}%)`;
  }
  return fmt(totalTokens);
}
