/**
 * dsh-napcat-bridge: 创建记忆工具 (create_memory)
 */

import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { MemoryType } from '../../memory/types.js';
import { resolveContextPeerAndQQ, type MemoryTools } from './common.js';
import { toLosslessJson } from '../../utils/lossless-json.js';

export interface CreateMemoryArgs {
  type: MemoryType;
  content: string;
  user_id?: string;
  qq?: string;
  peer?: string;
}

/**
 * 创建 create_memory 工具声明
 */
export function createCreateMemoryTool(tools: MemoryTools): ToolDefinition {
  return defineTool({
    name: 'create_memory',
    description:
      '首次创建跨场景通用的个人偏好画像（type=\'user\'），或当前会话专属的规则与文化（type=\'session\'）。适用于在交流或日常闲聊中发现用户确定性事实与长期偏好（如工作风格、技术栈习惯、人设与称呼偏好），或捕捉到群聊长期约定、群规与专属互动氛围时主动建立档案；亦在用户明确要求记住设定时调用。网络梗、词汇代称与社群黑话请使用专有黑话工具（record_slang），勿存入记忆；目标记忆已存在时勿重复创建，应使用 edit_memory 进行更新融合。严禁记录单次排查流水账、命令参数与操作手册、一次性跑分、临时报错、路过客套寒暄、单次复读摸鱼，以及因临时环境问题得出的负面断言。内容须保持紧凑高信号的单行陈述（如 "- 偏好：xxx" 或 "- 互动约定：xxx"），避免长篇叙事。',
    parameters: {
      type: {
        type: 'string',
        enum: ['session', 'user'],
        required: true,
        description: "记忆类型：'user' 表示创建用户跨场景稳定画像（群聊/私聊同一份）；'session' 表示创建当前会话专属规则与文化。",
      },
      content: {
        type: 'string',
        required: true,
        description: '要写入的完整记忆内容。必须为简练紧凑的 Markdown 条目（建议单条 <80 字），严禁流水账叙事。',
      },
      peer: {
        type: 'string',
        description: "目标会话 Peer（如 'group_xxx' 或 'user_xxx'，留空自动绑定当前会话）。",
      },
      user_id: {
        type: 'string',
        description: '目标用户的 QQ 号（仅当 type="user" 时有效，留空自动绑定当前对话者）。',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value: any) => [
        {
          type: 'text',
          text: value.message || `成功创建记忆 (${value.target})`,
        },
      ],
    },
    async execute(args: any, exec) {
      const resolved = resolveContextPeerAndQQ(exec);
      if (resolved.peer === 'default' && !args.peer && !args.user_id) {
        return toLosslessJson({
          success: false,
          message: '请显式传入 peer 参数（如 peer="group_xxx" 或 peer="user_xxx"）',
        }) as any;
      }
      const res = await tools.createMemory({
        type: args.type || 'session',
        content: args.content,
        user_id: args.user_id || resolved.qq,
        peer: args.peer || resolved.peer,
      });
      return toLosslessJson(res) as any;
    },
  });
}
