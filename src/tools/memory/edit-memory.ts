/**
 * dsh-napcat-bridge: 编辑记忆工具 (edit_memory)
 */

import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { MemoryType } from '../../memory/types.js';
import { resolveContextPeerAndQQ, type MemoryTools } from './common.js';
import { toLosslessJson } from '../../utils/lossless-json.js';

export interface EditMemoryArgs {
  type: MemoryType;
  old_string: string;
  new_string?: string;
  user_id?: string;
  qq?: string;
  peer?: string;
}

/**
 * 创建 edit_memory 工具声明
 */
export function createEditMemoryTool(tools: MemoryTools): ToolDefinition {
  return defineTool({
    name: 'edit_memory',
    description:
      '定向修改、更新、合并或精简已有的长期记忆条目。通过唯一匹配 old_string 替换为 new_string（若 new_string 省略或为空字符串则直接删除匹配片段）。适用于在交流与闲聊中捕捉到用户习惯演化、新事实补充时主动更新已有记忆，或在条目冗余时主动精简合并、删减失效过时的琐碎内容，使记忆持续保持高信号；亦在用户明确要求纠正、变更或删除设定时调用。维护词条级黑话请使用 manage_slang；切勿记录临时排查流水账或偶然分歧。内容保持单行精简陈述，调用前可结合 read_memory 确保 old_string 文本唯一准确。',
    parameters: {
      type: {
        type: 'string',
        enum: ['session', 'user'],
        required: true,
        description: "记忆类型：'user' 表示修改用户跨场景稳定画像；'session' 表示修改当前会话专属规则。",
      },
      old_string: {
        type: 'string',
        required: true,
        description: '待替换或删除的既有内容片段，必须在目标文件中唯一出现。',
      },
      new_string: {
        type: 'string',
        description: '替换后的新内容（保持精炼单行）；省略或为空字符串则直接删除匹配的 old_string 片段。',
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
          text: value.message || `成功编辑记忆 (${value.target})：${value.preview}`,
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
      const res = await tools.editMemory({
        type: args.type || 'session',
        old_string: args.old_string,
        new_string: args.new_string,
        user_id: args.user_id || resolved.qq,
        peer: args.peer || resolved.peer,
      });
      return toLosslessJson(res) as any;
    },
  });
}
