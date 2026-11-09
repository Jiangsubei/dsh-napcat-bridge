/**
 * dsh-napcat-bridge: /压缩 命令处理器
 */

import { safeGetService } from '../../gateway/session/agent-runner.js';
import { formatTokens, getContextUsageBrief } from '../utils/usage.js';
import type { CommandContext, CommandResult } from '../types.js';

/**
 * /压缩 失败文案映射表（对齐 DSH 官方 ManualCompactionErrorCode 语义）
 */
export const COMPACT_FAIL_TEXT: Record<string, string> = {
  'no-target': '未选中控制目标。',
  unavailable: '压缩服务不可用：当前会话未挂载压缩能力。',
  agent: '无法接管该会话的 agent，压缩未执行。',
  busy: '本进程已有压缩在进行，或该会话不空闲；请等当前回合结束后重试。',
  cancelled: '压缩已取消。',
  changed: '待压缩的历史在压缩前被改动，会话未变更。',
  summary: '压缩未能产出有效摘要，会话未变更。',
  commit: '压缩未正常收尾，部分历史可能已变更，请先检查会话状态再重试。',
  persistence: '压缩已完成，但会话保存失败。',
  error: '压缩失败（未分类错误）。',
};

export async function handleCompactCommand(
  args: string,
  context: CommandContext
): Promise<CommandResult> {
  if (args) {
    return {
      handled: true,
      success: false,
      error: '『/压缩』不接受参数。',
    };
  }

  const agents = safeGetService(context.ctx, 'agents');
  let agent = context.agent || agents?.get?.(context.session.id);
  if (!agent && context.sessionManager) {
    try {
      const peer = context.sessionManager.sessionIdToPeer(context.session.id);
      agent = await context.sessionManager.getOrCreateAgent(peer);
    } catch {}
  }

  if (!agent) {
    return {
      handled: true,
      success: false,
      error: COMPACT_FAIL_TEXT.agent,
    };
  }

  // 官方 READ 寻址：优先从 agentPresets.serviceFor(agent, 'compaction') 读取，回退 host 平面
  let scopedEngine: any;
  const agentPresets = safeGetService(context.ctx, 'agentPresets');
  if (agent?.ctx && agentPresets) {
    try {
      scopedEngine = agentPresets.serviceFor?.(agent, 'compaction');
    } catch (presetErr: any) {
      context.ctx.logger?.('dsh-napcat-bridge')?.warn?.(
        '[Command] 读取 agentPresets.serviceFor(agent, "compaction") 失败:',
        presetErr?.message || presetErr
      );
    }
  }

  const hostEngine = safeGetService(context.ctx, 'compaction');
  const engine = scopedEngine ?? hostEngine;

  if (!engine || typeof engine.compactNow !== 'function') {
    return {
      handled: true,
      success: false,
      error: COMPACT_FAIL_TEXT.unavailable,
    };
  }

  const runCompact = async (): Promise<string> => {
    try {
      // 不可中断 signal 保证压缩过程原子收敛
      const result = await engine.compactNow(agent, new AbortController().signal);
      if (result === null) {
        return '没有可压缩的历史（会话未变更）。';
      }
      const shadowedCount = Array.isArray(result.shadowedSeqs) ? result.shadowedSeqs.length : 0;
      const shadowedTokens = typeof result.shadowedTokenCount === 'number' ? result.shadowedTokenCount : 0;
      const usageBrief = await getContextUsageBrief(context.ctx, context.session, context.sessionManager);
      return [
        `已压缩 ${shadowedCount} 条历史（约 ${formatTokens(shadowedTokens)} tokens）。`,
        `当前上下文：${usageBrief}`,
      ].join('\n');
    } catch (err: any) {
      const code = err?.code;
      if (code && typeof code === 'string' && COMPACT_FAIL_TEXT[code]) {
        return `压缩失败：${COMPACT_FAIL_TEXT[code]}`;
      }
      return `压缩失败：${err?.message || String(err)}`;
    }
  };

  return {
    handled: true,
    success: true,
    reply: '正在压缩会话历史…',
    followUp: runCompact,
  };
}
