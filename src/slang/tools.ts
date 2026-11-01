/**
 * dsh-napcat-bridge: 黑话学习与管理 Agent 工具集
 * 实现 query_slang, record_slang 与 manage_slang 及其 DSH defineTool 声明。
 * 遵循四参数体系：标题 (term) + 标签 (tags) + 释义 (definition) + 例句 (example)。
 */

import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { SlangStorage } from './storage.js';
import type {
  QuerySlangParams,
  QuerySlangResult,
  RecordSlangParams,
  RecordSlangResult,
  ManageSlangParams,
  ManageSlangResult,
} from '../types/index.js';

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
      evicted_term: res.evictedTerm,
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
 * 管理黑话核心函数 (list / edit / delete)
 */
export async function manageSlang(
  params: ManageSlangParams,
  storage: SlangStorage
): Promise<ManageSlangResult> {
  const action = params.action;
  const stats = storage.getStats();

  if (action === 'list') {
    const entries = await storage.listEntries(params.keyword || params.term, params.limit);
    return {
      success: true,
      action: 'list',
      entries,
      total: entries.length,
      max_entries: stats.maxEntries,
      message: `查询到 ${entries.length} 条黑话词条 (当前总容量 ${stats.total}/${stats.maxEntries} 条)`,
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
        new_term: params.new_term,
        tags: params.tags,
        definition: params.definition,
        example: params.example,
      });
      const newStats = storage.getStats();
      return {
        success: true,
        action: 'edit',
        entry: updated,
        total: newStats.total,
        max_entries: newStats.maxEntries,
        message: `成功更新黑话词条 "${updated.term}" (当前总容量 ${newStats.total}/${newStats.maxEntries} 条)`,
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
      total: newStats.total,
      max_entries: newStats.maxEntries,
      message: `成功删除黑话词条 "${params.term}" (当前总容量 ${newStats.total}/${newStats.maxEntries} 条)`,
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
      name: 'query_slang',
      description:
        '【日常聊天查梗专用】查询指定社群黑话、网络流行语或缩写的完整释义与典型使用例句。当在常驻黑话索引中看到词条但仅凭标题和标签无法确定其具体含义或深层语境时调用本工具。若未收录可尝试联网搜索。',
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
        return querySlang(
          {
            term: String(args.term || ''),
          },
          storage
        ) as any;
      },
    }),
    defineTool({
      name: 'record_slang',
      description:
        '记录并收录跨会话通用的网络梗、社群黑话、圈内缩写或特色代称。适用于在交流或日常闲聊中捕捉到值得长期掌握的黑话表达、或刚聊明白的新词新梗时主动收录；黑话在所有群聊与私聊中全局生效复用。用户个人偏好或群专属规则请使用记忆工具，勿记入黑话。必须提供核心词条名称、几个词的简要概述标签、核心释义与典型例句四项参数，确保 L2 可被准确查阅；已存在的黑话词条若需修改请使用 manage_slang。',
      parameters: {
        term: {
          type: 'string',
          required: true,
          description: '核心黑话/梗/代称名称（必填，如“牢大”、“电子阳痿”等，保持简短原生）',
        },
        tags: {
          type: 'string',
          required: true,
          description: '几个词的简要概述标签（必填，如“提前庆祝、反转被打脸”，作为 L1 常驻上下文索引的语义钩子）',
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
        return recordSlang(
          {
            term: String(args.term || ''),
            tags: String(args.tags || ''),
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
        '【知识库管理维护专用】管理与修缮全局黑话知识库（支持检索 list、修改 edit、删除 delete）。模型在准备修改 (edit) 或删除 (delete) 某个词条前，应先通过 list 检索查看其当前内容与已有标签。keyword 支持按标题、标签特征词或释义关键词进行检索与反查。日常首次收录新黑话请直接使用 record_slang。',
      parameters: {
        action: {
          type: 'string',
          required: true,
          enum: ['list', 'edit', 'delete'],
          description: '操作类型：list (检索/列出已有黑话条目内容), edit (修改已有黑话的标签、释义或例句), delete (删除指定黑话)',
        },
        term: {
          type: 'string',
          description: '目标黑话词条名称（action 为 edit 或 delete 时必填；action 为 list 时可选填用于匹配特定词条）',
        },
        new_term: {
          type: 'string',
          description: '修改后的词条名称（仅当 action 为 edit 时生效）',
        },
        tags: {
          type: 'string',
          description: '修改或补齐后的简要概述标签（仅当 action 为 edit 时生效）',
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
          description: '模糊搜索关键词（仅当 action 为 list 时生效，支持按标题、标签特征词或释义/例句关键词全文反查）',
        },
        limit: {
          type: 'number',
          description: '本次检索返回的最大条目数量限制（可选，默认不限全部列出）',
        },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value: any) => {
          if (!value?.success) {
            return [{ type: 'text', text: `操作失败: ${value?.error || '未知错误'}` }];
          }

          // 当 action 为 list 时，不仅返回统计，还要将条目的完整内容列表直接渲染给模型
          if (value?.action === 'list' && Array.isArray(value?.entries)) {
            if (value.entries.length === 0) {
              return [{ type: 'text', text: value?.message || '未查询到任何匹配的黑话词条' }];
            }
            const lines: string[] = [
              value?.message || `查询到 ${value.entries.length} 条黑话词条：`,
              '',
            ];
            for (let i = 0; i < value.entries.length; i++) {
              const item = value.entries[i];
              const tagStr = item.tags ? ` [标签: ${item.tags}]` : '';
              const exStr = item.example ? `\n   - 例句: ${item.example}` : '';
              lines.push(`${i + 1}. 【${item.term}】${tagStr}\n   - 释义: ${item.definition}${exStr}`);
            }
            return [{ type: 'text', text: lines.join('\n') }];
          }

          return [{ type: 'text', text: value?.message || '操作成功' }];
        },
      },
      async execute(args: any) {
        return manageSlang(
          {
            action: args.action,
            term: args.term ? String(args.term) : undefined,
            new_term: args.new_term ? String(args.new_term) : undefined,
            tags: args.tags ? String(args.tags) : undefined,
            definition: args.definition ? String(args.definition) : undefined,
            example: args.example ? String(args.example) : undefined,
            keyword: args.keyword ? String(args.keyword) : undefined,
            limit: typeof args.limit === 'number' ? args.limit : undefined,
          },
          storage
        ) as any;
      },
    }),
  ];
}
