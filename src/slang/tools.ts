/**
 * dsh-napcat-bridge: 黑话学习与管理 Agent 工具集
 * 实现 record_slang 与 manage_slang 及其 DSH defineTool 声明。
 */

import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { SlangStorage } from './storage.js';
import type {
  RecordSlangParams,
  RecordSlangResult,
  ManageSlangParams,
  ManageSlangResult,
} from '../types/index.js';

/**
 * 记录黑话核心函数
 */
export async function recordSlang(
  params: RecordSlangParams,
  storage: SlangStorage
): Promise<RecordSlangResult> {
  try {
    const res = await storage.recordEntry({
      term: params.term,
      definition: params.definition,
      example: params.example,
    });
    return {
      success: true,
      action: res.action,
      entry: res.entry,
      char_count: res.charCount,
      budget_chars: res.budgetChars,
      message:
        res.action === 'created'
          ? `成功收录黑话词条 "${res.entry.term}" (当前总占用 ${res.charCount}/${res.budgetChars} 字符)`
          : `成功更新黑话词条 "${res.entry.term}" (当前总占用 ${res.charCount}/${res.budgetChars} 字符)`,
    };
  } catch (err: any) {
    const stats = storage.getStats();
    return {
      success: false,
      action: 'created',
      char_count: stats.charCount,
      budget_chars: stats.budgetChars,
      error: err?.message || '收录黑话失败',
    };
  }
}

/**
 * 管理黑话核心函数 (list / edit / delete)
 */
export async function manageSlang(
  params: ManageSlangParams,
  storage: SlangStorage
): Promise<ManageSlangResult> {
  const action = params.action;
  const stats = storage.getStats();

  if (action === 'list') {
    const entries = await storage.listEntries(params.keyword || params.term);
    return {
      success: true,
      action: 'list',
      entries,
      total: entries.length,
      char_count: stats.charCount,
      budget_chars: stats.budgetChars,
      message: `查询到 ${entries.length} 条黑话词条 (当前总占用 ${stats.charCount}/${stats.budgetChars} 字符)`,
    };
  }

  if (action === 'edit') {
    if (!params.term || !params.term.trim()) {
      return {
        success: false,
        action: 'edit',
        error: '执行 edit 操作必须提供目标黑话词条名称 (term)',
      };
    }
    try {
      const updated = await storage.editEntry(params.term, {
        definition: params.definition,
        example: params.example,
      });
      const newStats = storage.getStats();
      return {
        success: true,
        action: 'edit',
        entry: updated,
        char_count: newStats.charCount,
        budget_chars: newStats.budgetChars,
        message: `成功更新黑话词条 "${updated.term}" (当前总占用 ${newStats.charCount}/${newStats.budgetChars} 字符)`,
      };
    } catch (err: any) {
      return {
        success: false,
        action: 'edit',
        error: err?.message || '编辑黑话词条失败',
      };
    }
  }

  if (action === 'delete') {
    if (!params.term || !params.term.trim()) {
      return {
        success: false,
        action: 'delete',
        error: '执行 delete 操作必须提供目标黑话词条名称 (term)',
      };
    }
    const deleted = await storage.deleteEntry(params.term);
    if (!deleted) {
      return {
        success: false,
        action: 'delete',
        error: `未找到黑话词条 "${params.term}"，无法删除`,
      };
    }
    const newStats = storage.getStats();
    return {
      success: true,
      action: 'delete',
      char_count: newStats.charCount,
      budget_chars: newStats.budgetChars,
      message: `成功删除黑话词条 "${params.term}" (当前总占用 ${newStats.charCount}/${newStats.budgetChars} 字符)`,
    };
  }

  return {
    success: false,
    action: action as any,
    error: `不支持的操作类型 "${action}"`,
  };
}

/**
 * 创建供 DSH 注册的黑话 ToolDefinition 列表
 */
export function createSlangToolDefinitions(storage: SlangStorage): ToolDefinition[] {
  return [
    defineTool({
      name: 'record_slang',
      description:
        '记录并收录跨会话通用的网络梗、社群黑话、圈内缩写或特色代称。适用于在交流或日常闲聊中捕捉到值得长期掌握的黑话表达、或刚聊明白的新词新梗时主动收录；黑话在所有群聊与私聊中全局生效复用。用户个人偏好或群专属规则请使用记忆工具，勿记入黑话。仅提取核心词条名称、凝练释义与典型例句，严禁记录对话琐事背景；已存在的黑话词条若需修改请使用 manage_slang。',
      parameters: {
        term: {
          type: 'string',
          required: true,
          description: '核心黑话/梗/代称名称（必填，如“牢大”、“电子阳痿”等，保持简短原生）',
        },
        definition: {
          type: 'string',
          required: true,
          description: '词条核心释义与含义（必填，用一两句话凝练概括，切勿写闲聊废话）',
        },
        example: {
          type: 'string',
          required: true,
          description: '典型的使用场景或代表性简短例句（必填，如在什么语境下说、如何造句）',
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
        return recordSlang(
          {
            term: String(args.term || ''),
            definition: String(args.definition || ''),
            example: String(args.example || ''),
          },
          storage
        ) as any;
      },
    }),
    defineTool({
      name: 'manage_slang',
      description:
        '管理与维护全局黑话知识库（支持检索 list、修改 edit、删除 delete）。适用于在交流中发现既有黑话含义演化、用法更新或用户指正时更新释义例句，在黑话过时、失效或用户要求遗忘时删除条目，或在准备修改前检索核对现有黑话列表。日常首次收录新黑话请直接使用 record_slang。',
      parameters: {
        action: {
          type: 'string',
          required: true,
          enum: ['list', 'edit', 'delete'],
          description: '操作类型：list (检索/列出已有黑话条目), edit (修改已有黑话的释义或例句), delete (删除指定黑话)',
        },
        term: {
          type: 'string',
          description: '目标黑话词条名称（action 为 edit 或 delete 时必填；action 为 list 时可选填用于精准匹配）',
        },
        definition: {
          type: 'string',
          description: '修改后的核心释义（仅当 action 为 edit 时提供；若不修改释义可留空）',
        },
        example: {
          type: 'string',
          description: '修改后的典型例句与语境（仅当 action 为 edit 时提供；若不修改例句可留空）',
        },
        keyword: {
          type: 'string',
          description: '模糊搜索关键词（仅当 action 为 list 时生效，用于按词条或释义关键词筛选黑话列表）',
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
        return manageSlang(
          {
            action: args.action,
            term: args.term ? String(args.term) : undefined,
            definition: args.definition ? String(args.definition) : undefined,
            example: args.example ? String(args.example) : undefined,
            keyword: args.keyword ? String(args.keyword) : undefined,
          },
          storage
        ) as any;
      },
    }),
  ];
}
