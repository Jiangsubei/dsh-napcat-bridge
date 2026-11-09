/**
 * dsh-napcat-bridge: /状态 命令处理器
 */

import { parseSessionId } from '../../gateway/session.js';
import { safeGetService } from '../../gateway/session/agent-runner.js';
import { formatTokens } from '../utils/usage.js';
import { getModelReasoningInfo } from '../model/reasoning.js';
import type { CommandContext, CommandResult } from '../types.js';

export async function handleStatusCommand(
  _args: string,
  context: CommandContext
): Promise<CommandResult> {
  const sm = context.sessionManager;
  const peer = sm ? sm.sessionIdToPeer(context.session.id) : context.session.id;
  const activeTurn = sm?.getActiveTurn?.(peer);
  const isBusy = activeTurn !== undefined || sm?.isSessionBusy?.(context.session.id);

  let statusStr = '空闲';
  if (activeTurn !== undefined) {
    statusStr = `正在运行（轮次 #${activeTurn}）`;
  } else if (isBusy) {
    statusStr = '正在运行';
  }

  const agents = safeGetService(context.ctx, 'agents');
  const agent = agents?.get?.(context.session.id);
  const curSel = sm?.getModelSelection(context.session.id) || (agent as any)?.modelSelection?.current;
  const curProv = curSel?.provider || (agent as any)?.options?.provider || 'deepseek-official';
  const curMod = curSel?.model || (agent as any)?.options?.model || 'deepseek-v4-flash';
  const curEffort = curSel?.reasoningEffort;

  const reasoningInfo = await getModelReasoningInfo(context.ctx, curProv, curMod, curEffort);
  let effortStr = '不支持';
  if (reasoningInfo.supported) {
    const matched = reasoningInfo.efforts.find((e) => e.id === reasoningInfo.currentEffort);
    effortStr = matched ? `${matched.id} (${matched.name})` : (reasoningInfo.currentEffort || '默认');
  } else {
    effortStr = '当前模型不支持';
  }

  const permissionPresets = safeGetService(context.ctx, 'permissionPresets');
  const rawMode = permissionPresets?.current?.(context.session) || 'workspace-write';
  let zhMode = '编辑';
  if (rawMode === 'danger-full-access' || rawMode === 'yolo') zhMode = '完全';
  else if (rawMode === 'readonly' || rawMode === 'read-only') zhMode = '只读';

  let ctxUsageStr = '0';
  const tokenMeter = safeGetService(context.ctx, 'tokenMeter');
  if (tokenMeter?.measure) {
    try {
      const usage = tokenMeter.measure(context.session);
      const totalTokens = usage?.totalTokens ?? 0;
      let contextWindow: number | undefined;
      const sessionProjections = safeGetService(context.ctx, 'sessionProjections');
      if (sessionProjections && typeof sessionProjections.snapshot === 'function') {
        try {
          const snap = sessionProjections.snapshot(context.session, ['contextPressure']);
          if (snap?.values?.contextPressure?.contextWindow) {
            contextWindow = snap.values.contextPressure.contextWindow;
          }
        } catch {}
      }
      if (contextWindow === undefined) {
        const llm = safeGetService(context.ctx, 'llm');
        if (llm && typeof llm.resolveModel === 'function') {
          try {
            const info = await llm.resolveModel(curProv, curMod);
            if (info?.context?.contextWindow) contextWindow = info.context.contextWindow;
          } catch {}
        }
      }
      const fmt = (v: number) => (v > 0 ? `~${formatTokens(v)}` : '0');
      if (contextWindow && contextWindow > 0) {
        const percent = Math.min(100, Math.round((totalTokens / contextWindow) * 100));
        ctxUsageStr = `${fmt(totalTokens)} / ${formatTokens(contextWindow)} (${percent}%)`;
      } else {
        ctxUsageStr = fmt(totalTokens);
      }
    } catch {}
  }

  const parsed = parseSessionId(context.session.id);
  const versionStr = parsed ? ` (版本: ${parsed.version})` : '';
  const sessionIdent = `${context.session.id}${versionStr}`;

  const lines = [
    '【当前会话状态】',
    `运行状态：${statusStr}`,
    `当前模型：${curProv} / ${curMod}`,
    `思考等级：${effortStr}`,
    `权限模式：${zhMode}`,
    `上下文用量：${ctxUsageStr}`,
    `会话标识：${sessionIdent}`,
  ];

  return {
    handled: true,
    success: true,
    reply: lines.join('\n'),
  };
}
