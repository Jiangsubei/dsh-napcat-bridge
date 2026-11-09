/**
 * dsh-napcat-bridge: /帮助 命令处理器
 */

import type { CommandContext, CommandResult } from '../types.js';

export async function handleHelpCommand(
  _args: string,
  _context: CommandContext
): Promise<CommandResult> {
  const helpText = [
    '【快捷指令帮助】',
    '- /状态 : 查看当前运行状态、模型、权限与上下文总览',
    '- /模型 [模型名] : 查看或切换当前使用的模型',
    '- /权限 [只读|编辑|完全] : 查看或切换权限模式',
    '- /思考 [档位] : 查看或设置深度思考等级（如 off, low, high, max）',
    '- /会话 [序号|标题] : 列出历史会话或进行切换',
    '- /新建 : 开启全新会话（保留历史）',
    '- /用量 : 查看会话上下文用量明细',
    '- /压缩 : 整理并压缩会话历史，释放上下文空间',
    '- /停止 : 中断当前正在生成的回复',
    '- /帮助 : 查看本帮助说明',
  ].join('\n');

  return {
    handled: true,
    success: true,
    reply: helpText,
  };
}
