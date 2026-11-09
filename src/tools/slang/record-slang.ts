/**
 * dsh-napcat-bridge: 记录黑话工具 (record_slang)
 */

import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { SlangStorage } from '../../slang/storage.js';
import type { RecordSlangParams, RecordSlangResult } from '../../types/index.js';
import { toLosslessJson } from '../../utils/lossless-json.js';

export type { RecordSlangParams, RecordSlangResult };

/**
 * 记录黑话核心函数（强制四参数必填）
 */
export async function recordSlang(
  params: RecordSlangParams,
  storage: SlangStorage
): Promise<RecordSlangResult> {
  try {
    const res = await storage.recordEntry({
      term: params.term,
      tags: params.tags,
      definition: params.definition,
      example: params.example,
    });

    const evictedNotice = res.evictedTerm ? ` (容量满额自动按查淘汰最冷门词条: "${res.evictedTerm}")` : '';
    return {
      success: true,
      action: res.action,
      entry: res.entry,
      total: res.total,
      max_entries: res.maxEntries,
      ...(res.evictedTerm ? { evicted_term: res.evictedTerm } : {}),
      message:
        res.action === 'created'
          ? `成功收录黑话词条 "${res.entry.term}" (当前总容量 ${res.total}/${res.maxEntries} 条)${evictedNotice}`
          : `成功更新黑话词条 "${res.entry.term}" (当前总容量 ${res.total}/${res.maxEntries} 条)`,
    };
  } catch (err: any) {
    const stats = storage.getStats();
    return {
      success: false,
      action: 'created',
      total: stats.total,
      max_entries: stats.maxEntries,
      error: err?.message || '收录黑话失败',
    };
  }
}

/**
 * 创建 record_slang 工具声明
 */
export function createRecordSlangTool(storage: SlangStorage): ToolDefinition {
  return defineTool({
    name: 'record_slang',
    description:
      '记录并收录跨会话通用的网络梗、社群黑话、圈内缩写或特色代称。用户个人偏好或群专属规则请使用记忆工具，勿记入黑话。必须提供核心词条名称、触发情境与招牌句式、核心释义与典型例句四项参数；已收录词条若需修改请使用 manage_slang。',
    parameters: {
      term: {
        type: 'string',
        required: true,
        description: '核心黑话/梗/代称名称（必填，如“牢大”、“电子阳痿”等，保持简短原生）',
      },
      tags: {
        type: 'string',
        required: true,
        description:
          '触发情境与招牌句式（必填，记录该梗的标志性句式、口癖或触发情境，如“别人X而我X / 就很…懂吧”、“对方发长篇大论 / 敷衍阴阳”；严禁写抽象分类或空洞解释）',
      },
      definition: {
        type: 'string',
        required: true,
        description: '词条核心释义与完整含义（必填，用一两句话凝练概括，切勿写闲聊废话）',
      },
      example: {
        type: 'string',
        required: true,
        description: '典型的使用场景或代表性简短例句（必填，如在什么语境下说、如何造句，确保模型按需查 L2 时能准确掌握用法）',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value: any) => [
        {
          type: 'text',
          text: value?.message || (value?.success ? '操作成功' : `操作失败: ${value?.error || '未知错误'}`),
        },
      ],
    },
    async execute(args: any) {
      const res = await recordSlang(
        {
          term: String(args.term || ''),
          tags: String(args.tags || ''),
          definition: String(args.definition || ''),
          example: String(args.example || ''),
        },
        storage
      );
      return toLosslessJson(res) as any;
    },
  });
}
