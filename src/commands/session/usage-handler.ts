/**
 * dsh-napcat-bridge: /用量 命令处理器
 */

import { safeGetService } from '../../gateway/session/agent-runner.js';
import { formatTokens } from '../utils/usage.js';
import type { CommandContext, CommandResult } from '../types.js';

export async function handleUsageCommand(
  _args: string,
  context: CommandContext
): Promise<CommandResult> {
  const tokenMeter = safeGetService(context.ctx, 'tokenMeter');
  if (!tokenMeter?.measure) {
    return {
      handled: true,
      success: false,
      error: 'tokenMeter 服务不可用',
    };
  }

  let usage: any;
  try {
    usage = tokenMeter.measure(context.session);
  } catch (err: any) {
    return {
      handled: true,
      success: false,
      error: `计算上下文用量失败: ${err?.message || String(err)}`,
    };
  }

  const totalTokens = usage?.totalTokens ?? 0;
  let contextWindow: number | undefined;
  const sessionProjections = safeGetService(context.ctx, 'sessionProjections');
  let breakdown: any;

  if (sessionProjections && typeof sessionProjections.snapshot === 'function') {
    try {
      const snap = sessionProjections.snapshot(context.session, [
        'contextPressure',
        'contextBreakdown',
      ]);
      if (snap?.values?.contextPressure?.contextWindow) {
        contextWindow = snap.values.contextPressure.contextWindow;
      }
      if (snap?.values?.contextBreakdown) {
        breakdown = snap.values.contextBreakdown;
      }
    } catch {}
  }

  if (contextWindow === undefined) {
    try {
      const sm = context.sessionManager;
      const curSel = sm?.getModelSelection(context.session.id);
      const provider = curSel?.provider || 'deepseek-official';
      const model = curSel?.model || 'deepseek-v4-flash';
      const llm = safeGetService(context.ctx, 'llm');
      if (llm && typeof llm.resolveModel === 'function') {
        const info = await llm.resolveModel(provider, model);
        if (info?.context?.contextWindow) {
          contextWindow = info.context.contextWindow;
        }
      }
    } catch {}
  }

  let systemTokens = breakdown?.systemTokens ?? 0;
  let toolsTokens = breakdown?.toolsTokens ?? 0;
  let messageTokens = breakdown?.messageTokens ?? (usage?.surfaceTokens ?? 0);

  if (!breakdown && usage?.surfaceTokens !== undefined) {
    messageTokens = usage.surfaceTokens;
    if (usage.totalTokens > usage.surfaceTokens) {
      systemTokens = usage.totalTokens - usage.surfaceTokens;
    }
  }

  const fmt = (v: number) => (v > 0 ? `~${formatTokens(v)}` : '0');
  let lineHeader = `上下文已用：${fmt(totalTokens)}`;
  if (contextWindow && contextWindow > 0) {
    const percent = Math.min(100, Math.round((totalTokens / contextWindow) * 100));
    lineHeader += ` / ${formatTokens(contextWindow)} (${percent}%)`;
  }

  const lines = [lineHeader];
  const hasBreakdown =
    breakdown !== undefined ||
    systemTokens > 0 ||
    toolsTokens > 0 ||
    messageTokens > 0;

  if (hasBreakdown) {
    lines.push(`- 系统提示词：${fmt(systemTokens)}`);
    lines.push(`- 工具声明：${fmt(toolsTokens)}`);
    lines.push(`- 对话消息：${fmt(messageTokens)}`);
  }

  return {
    handled: true,
    success: true,
    reply: lines.join('\n'),
  };
}
