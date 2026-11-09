/**
 * dsh-napcat-bridge: 查询黑话工具 (query_slang)
 */

import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { SlangStorage } from '../../slang/storage.js';
import type { QuerySlangParams, QuerySlangResult } from '../../types/index.js';
import { toLosslessJson } from '../../utils/lossless-json.js';

export type { QuerySlangParams, QuerySlangResult };

/**
 * 查询黑话完整释义与例句
 */
export async function querySlang(
  params: QuerySlangParams,
  storage: SlangStorage
): Promise<QuerySlangResult> {
  const cleanTerm = (params.term || '').trim();
  if (!cleanTerm) {
    return {
      success: false,
      error: '查询黑话必须提供词条名称 (term)',
    };
  }

  const entry = await storage.queryEntry(cleanTerm);
  if (!entry) {
    return {
      success: false,
      error: `黑话知识库中未收录词条 "${cleanTerm}"，如需了解其含义可尝试联网搜索或向用户请教。`,
    };
  }

  const tagsDesc = entry.tags ? ` [标签: ${entry.tags}]` : '';
  const exDesc = entry.example ? `\n- 典型例句: ${entry.example}` : '';

  return {
    success: true,
    entry,
    message: `【${entry.term}】${tagsDesc}\n- 核心释义: ${entry.definition}${exDesc}`,
  };
}

/**
 * 创建 query_slang 工具声明
 */
export function createQuerySlangTool(storage: SlangStorage): ToolDefinition {
  return defineTool({
    name: 'query_slang',
    description:
      '【日常聊天查梗专用】查询指定社群黑话、网络流行语或缩写的完整释义与典型使用例句。当在常驻黑话索引中看到对应词条或对话涉及该梗、且前文尚未查询掌握时应调用本工具，以获取权威社群释义与真实语境，严禁在未查明前仅凭索引或通用印象臆测。若前文已查询掌握则无需重复查询；若未收录可尝试联网搜索。',
    parameters: {
      term: {
        type: 'string',
        required: true,
        description: '目标黑话名称（必填，如“牢大”、“开香槟”等）',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value: any) => [
        {
          type: 'text',
          text: value?.message || (value?.success ? '查询成功' : `查询失败: ${value?.error || '未知错误'}`),
        },
      ],
    },
    async execute(args: any) {
      const res = await querySlang(
        {
          term: String(args.term || ''),
        },
        storage
      );
      return toLosslessJson(res) as any;
    },
  });
}
