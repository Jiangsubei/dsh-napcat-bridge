/**
 * dsh-napcat-bridge: 斜杠命令门面模块
 * 管理员白名单门控与命令调度对外入口。
 */

import type { CommandContext, CommandResult } from './types.js';
import { dispatchCommand } from './router.js';

export type { CommandContext, CommandResult, CommandHandler } from './types.js';
export type { DiscoveredModelInfo, ModelReasoningMetadata } from './model/types.js';
export { getDiscoveredModels } from './model/discovery.js';
export { safeSyncSessionModel } from './model/sync.js';
export { getModelReasoningInfo } from './model/reasoning.js';
export { formatTokens, getContextUsageBrief } from './utils/usage.js';
export { COMPACT_FAIL_TEXT } from './session/compact-handler.js';

/**
 * 判断输入文本是否为斜杠命令（兼容全半角斜杠）
 */
export function isSlashCommand(text: string): boolean {
  if (typeof text !== 'string') return false;
  const trimmed = text.trim();
  return trimmed.startsWith('/') || trimmed.startsWith('／');
}

/**
 * 处理斜杠命令并执行管理员门控
 */
export async function handleSlashCommand(
  commandText: string,
  context: CommandContext
): Promise<CommandResult> {
  if (!isSlashCommand(commandText)) {
    return { handled: false };
  }

  const trimmed = commandText.trim().replace(/^／/, '/');
  const match = trimmed.match(/^\/([^\s]+)(?:\s+(.*))?$/s);
  if (!match) {
    return { handled: false };
  }

  const command = match[1];
  const args = (match[2] || '').trim();

  // 1. 管理员白名单权限门控
  const admins = (context.admins || []).map((a) => String(a).trim());
  const user = String(context.userId || '').trim();
  const isAdmin = admins.length > 0 && admins.includes(user);

  if (!isAdmin) {
    return {
      handled: true,
      success: false,
      error: '权限不足：仅管理员允许执行指令',
    };
  }

  // 2. 命令分发处理
  return await dispatchCommand(command, args, context);
}
