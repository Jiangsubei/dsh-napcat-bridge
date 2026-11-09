/**
 * dsh-napcat-bridge: /新建 命令处理器
 */

import type { CommandContext, CommandResult } from '../types.js';

export async function handleNewCommand(
  _args: string,
  context: CommandContext
): Promise<CommandResult> {
  if (!context.sessionManager) {
    return {
      handled: true,
      success: false,
      error: '执行 /新建 失败: 当前环境缺少 SessionManager 服务',
    };
  }
  try {
    context.sessionManager.markSessionCleared(context.session.id);
    return {
      handled: true,
      success: true,
      reply: '已开启新会话（原会话已保留归档，新消息将计入新会话）。',
    };
  } catch (err: any) {
    return {
      handled: true,
      success: false,
      error: `执行 /新建 失败: ${err?.message || String(err)}`,
    };
  }
}
