/**
 * dsh-napcat-bridge: 读取记忆工具 (read_memory)
 */

import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { MemoryType } from '../../memory/types.js';
import { resolveContextPeerAndQQ, type MemoryTools } from './common.js';
import { toLosslessJson } from '../../utils/lossless-json.js';

export interface ReadMemoryArgs {
  type?: MemoryType;
  user_id?: string;
  qq?: string;
  peer?: string;
}

/**
 * 创建 read_memory 工具声明
 */
export function createReadMemoryTool(tools: MemoryTools): ToolDefinition {
  return defineTool({
    name: 'read_memory',
    description:
      '读取当前会话（type=\'session\'）的规则与文化记忆，或指定用户（type=\'user\'）的个人画像。适用于在日常交流或协助任务中，主动查阅以掌握用户深层偏好、习惯风格或确认群专属约定与互动氛围；当上下文快照提示画像未完全展示时按需查阅，或作为调用 edit_memory 精简修改前获取最新内容与唯一 old_string 的前置工具。日常对话若上下文中已有清晰背景则无需频繁调用。',
    parameters: {
      type: {
        type: 'string',
        enum: ['session', 'user'],
        required: true,
        description: "记忆类型：'session' 表示群聊/私聊规则与文化；'user' 表示个人用户画像。",
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
          text: value?.content?.trim()
            ? `${value.message || '读取成功'}\n\n${value.content}`
            : (value?.message || '记忆内容为空（当前无内容）'),
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
      const res = await tools.readMemory({
        type: args.type || 'session',
        user_id: args.user_id || resolved.qq,
        peer: args.peer || resolved.peer,
      });
      return toLosslessJson(res) as any;
    },
  });
}
