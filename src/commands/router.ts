/**
 * dsh-napcat-bridge: 斜杠命令分发路由模块
 */

import type { CommandContext, CommandHandler, CommandResult } from './types.js';
import { handlePermissionCommand } from './system/permission-handler.js';
import { handleModelCommand } from './model/model-handler.js';
import { handleThinkCommand } from './model/think-handler.js';
import { handleStopCommand } from './session/stop-handler.js';
import { handleNewCommand } from './session/new-handler.js';
import { handleSessionCommand } from './session/session-handler.js';
import { handleUsageCommand } from './session/usage-handler.js';
import { handleCompactCommand } from './session/compact-handler.js';
import { handleStatusCommand } from './system/status-handler.js';
import { handleHelpCommand } from './system/help-handler.js';

const commandRegistry: Record<string, CommandHandler> = {
  权限: handlePermissionCommand,
  模型: handleModelCommand,
  思考: handleThinkCommand,
  停止: handleStopCommand,
  新建: handleNewCommand,
  会话: handleSessionCommand,
  用量: handleUsageCommand,
  压缩: handleCompactCommand,
  状态: handleStatusCommand,
  帮助: handleHelpCommand,
};

/**
 * 分发执行斜杠命令
 */
export async function dispatchCommand(
  command: string,
  args: string,
  context: CommandContext
): Promise<CommandResult> {
  const handler = commandRegistry[command];
  if (handler) {
    return await handler(args, context);
  }

  return {
    handled: true,
    success: false,
    error: `未知指令：/${command}，输入 /帮助 查看可用指令`,
  };
}
