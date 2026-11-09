/**
 * dsh-napcat-bridge: 管理黑话工具 (manage_slang)
 */

import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { SlangStorage } from '../../slang/storage.js';
import {
  buildOffsetMessage,
  normalizeLimit,
  normalizeOffset,
} from '../pagination.js';
import type {
  ManageSlangParams,
  ManageSlangResult,
} from '../../types/index.js';
import { toLosslessJson } from '../../utils/lossless-json.js';

export type { ManageSlangParams, ManageSlangResult };

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
    const keyword = params.keyword || params.term;
    const offset = normalizeOffset(params.offset);
    const limit = normalizeLimit(params.limit, 20, 100);
    const { entries: allEntries, total: totalMatched } = await storage.listEntriesPage(
      keyword,
      offset,
      limit
    );

    const message =
      totalMatched === 0
        ? '未查询到任何匹配的黑话词条。'
        : buildOffsetMessage({
            offset,
            returned: allEntries.length,
            totalMatched,
            hasMore: offset + allEntries.length < totalMatched,
            ...(offset + allEntries.length < totalMatched
              ? { nextOffset: offset + allEntries.length }
              : {}),
            unit: '条黑话词条',
          });

    return {
      success: true,
      action: 'list',
      entries: allEntries,
      total: allEntries.length,
      total_matched: totalMatched,
      offset,
      limit,
      has_more: offset + allEntries.length < totalMatched,
      max_entries: stats.maxEntries,
      ...(message ? { message } : {}),
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
 * 创建 manage_slang 工具声明
 */
export function createManageSlangTool(storage: SlangStorage): ToolDefinition {
  return defineTool({
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
        description: '修改或补齐后的触发情境与招牌句式（记录标志句式、口癖或触发情境，严禁写抽象分类）',
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
      offset: {
        type: 'number',
        description: '起始序号偏移，从 0 开始（仅当 action 为 list 时生效）。翻页时按已展示条数自行推算。',
      },
      limit: {
        type: 'number',
        description: '本次检索返回的最大条目数量（仅当 action 为 list 时生效，默认 20，上限 100）',
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
          const baseOffset = typeof value.offset === 'number' ? value.offset : 0;
          for (let i = 0; i < value.entries.length; i++) {
            const item = value.entries[i];
            const tagStr = item.tags ? ` [标签: ${item.tags}]` : '';
            const exStr = item.example ? `\n   - 例句: ${item.example}` : '';
            lines.push(`${baseOffset + i + 1}. 【${item.term}】${tagStr}\n   - 释义: ${item.definition}${exStr}`);
          }
          if (value.has_more) {
            const totalMatched = typeof value.total_matched === 'number' ? value.total_matched : value.entries.length;
            lines.push(
              `\n> 还有 ${totalMatched - baseOffset - value.entries.length} 条未展示。继续浏览请传入 \`offset: ${baseOffset + value.entries.length}\`。`
            );
          }
          return [{ type: 'text', text: lines.join('\n') }];
        }

        return [{ type: 'text', text: value?.message || '操作成功' }];
      },
    },
    async execute(args: any) {
      const res = await manageSlang(
        {
          action: args.action,
          term: args.term ? String(args.term) : undefined,
          new_term: args.new_term ? String(args.new_term) : undefined,
          tags: args.tags ? String(args.tags) : undefined,
          definition: args.definition ? String(args.definition) : undefined,
          example: args.example ? String(args.example) : undefined,
          keyword: args.keyword ? String(args.keyword) : undefined,
          offset: typeof args.offset === 'number' ? args.offset : undefined,
          limit: typeof args.limit === 'number' ? args.limit : undefined,
        },
        storage
      );
      return toLosslessJson(res) as any;
    },
  });
}
