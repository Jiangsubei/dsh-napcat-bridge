/**
 * dsh-napcat-bridge: /停止 命令处理器
 */

import { safeGetService } from '../../gateway/session/agent-runner.js';
import type { CommandContext, CommandResult } from '../types.js';

export async function handleStopCommand(
  _args: string,
  context: CommandContext
): Promise<CommandResult> {
  const sessionController = safeGetService(context.ctx, 'sessionController');
  if (!sessionController?.cancel) {
    return {
      handled: true,
      success: false,
      error: 'sessionController 服务不可用',
    };
  }
  try {
    await sessionController.cancel({ sessionId: context.session.id });
    return {
      handled: true,
      success: true,
      reply: '已停止当前生成。',
    };
  } catch (err: any) {
    return {
      handled: true,
      success: false,
      error: `停止失败: ${err?.message || String(err)}`,
    };
  }
}
