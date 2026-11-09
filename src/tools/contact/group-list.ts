/**
 * 群聊列表查询工具 (get_group_list)
 */

import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { GroupItem, GetGroupListParams, GetGroupListResult } from '../../types/index.js';
import type { ToolExecutionContext } from '../common/context.js';
import { toLosslessJson } from '../../utils/lossless-json.js';
import {
  buildOffsetMessage,
  normalizeLimit,
  normalizeOffset,
  paginateByOffset,
  sortByNumericId,
} from '../pagination.js';
import {
  groupListCache,
  DEFAULT_LIST_LIMIT,
  MAX_LIST_LIMIT,
} from './cache.js';

export const GET_GROUP_LIST_DESCRIPTION =
  '按 offset 分页查询当前机器人加入的 QQ 群聊列表，结果按群号升序排列。支持通过 query 关键词模糊搜索群名称或群备注。每条结果返回连续行号、群号、群名称与群备注（如有）；群人数、人数上限、群介绍、建群时间等详细信息请使用 get_group_info 查询。用于定位特定群聊、核对群号。翻页时按已展示条数自行传入 offset（例如已展示 1~20，则传 offset: 20）。';

export async function queryGroupList(
  params: GetGroupListParams,
  ctx: ToolExecutionContext
): Promise<GetGroupListResult> {
  const offset = normalizeOffset(params?.offset);
  const limit = normalizeLimit(params?.limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
  const gateway = ctx.gateway;
  if (!gateway) {
    return toLosslessJson({
      success: false,
      groups: [],
      total: 0,
      total_matched: 0,
      offset,
      limit,
      has_more: false,
      error: 'QQ 网关未连接或离线，暂时无法查询群聊列表。',
    });
  }

  let rawGroups: any[] | undefined;
  const cacheKey = 'all_groups';
  if (!params.no_cache) {
    rawGroups = groupListCache.get(cacheKey);
  } else {
    groupListCache.clear(cacheKey);
  }

  if (!rawGroups) {
    try {
      const res = await gateway.getGroupList(Boolean(params.no_cache));
      if (res && res.status === 'ok' && Array.isArray(res.data)) {
        rawGroups = res.data;
        groupListCache.set(cacheKey, rawGroups);
      } else {
        return toLosslessJson({
          success: false,
          groups: [],
          total: 0,
          total_matched: 0,
          offset,
          limit,
          has_more: false,
          error: `获取群聊列表失败: ${res?.message || 'OneBot 响应异常'}`,
        });
      }
    } catch (err: any) {
      return toLosslessJson({
        success: false,
        groups: [],
        total: 0,
        total_matched: 0,
        offset,
        limit,
        has_more: false,
        error: `调用群列表接口发生异常: ${err?.message || String(err)}`,
      });
    }
  }

  // 1. 字段清洗并格式化为 GroupItem
  const allFormatted: GroupItem[] = rawGroups.map((raw: any) => ({
    group_id: String(raw.group_id),
    group_name: String(raw.group_name || ''),
    group_remark: String(raw.group_remark || ''),
  }));

  // 2. 模糊匹配 query (匹配 group_name 或 group_remark)
  let filtered = allFormatted;
  if (params.query && String(params.query).trim() !== '') {
    const kw = String(params.query).trim().toLowerCase();
    filtered = filtered.filter((g) => {
      return g.group_name.toLowerCase().includes(kw) || g.group_remark.toLowerCase().includes(kw);
    });
  }

  // 3. 确定性排序：按 group_id 数值升序，保证 offset 序号长期稳定
  filtered = sortByNumericId(filtered, (g) => g.group_id);

  // 4. 安全切片
  const page = paginateByOffset(filtered, { offset, limit }, {
    defaultLimit: DEFAULT_LIST_LIMIT,
    maxLimit: MAX_LIST_LIMIT,
  });

  let message: string | undefined;
  if (page.totalMatched === 0) {
    message = '未找到符合条件的群聊。';
  } else {
    message = buildOffsetMessage({
      offset: page.offset,
      returned: page.returned,
      totalMatched: page.totalMatched,
      hasMore: page.hasMore,
      ...(page.nextOffset !== undefined ? { nextOffset: page.nextOffset } : {}),
      unit: '个群',
    });
  }

  return toLosslessJson({
    success: true,
    groups: page.items,
    total: page.returned,
    total_matched: page.totalMatched,
    offset: page.offset,
    limit: page.limit,
    has_more: page.hasMore,
    ...(message ? { message } : {}),
  });
}

export function createGetGroupListTool(
  contextGetter: () => ToolExecutionContext
): ToolDefinition {
  return defineTool({
    name: 'get_group_list',
    description: GET_GROUP_LIST_DESCRIPTION,
    parameters: {
      query: {
        type: 'string',
        description: '模糊搜索关键词，匹配群名称或群备注 (不区分大小写)',
      },
      offset: {
        type: 'number',
        description: '起始序号偏移，从 0 开始（0 表示第 1 条）。翻页时按已展示条数自行推算，例如已展示 1~20 则传 20。',
      },
      limit: {
        type: 'number',
        description: '单次返回条数 (默认 20，单次上限 50)。',
      },
      no_cache: {
        type: 'boolean',
        description: '是否强制穿透 5 分钟缓存重新拉取最新群列表数据 (默认 false)。',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => {
        const v = value as unknown as GetGroupListResult;
        if (!v || !v.success) return [{ type: 'text', text: `查询失败: ${v?.error || '未知错误'}` }];
        if (v.total === 0) return [{ type: 'text', text: v.message || '未找到符合条件的群聊。' }];
        const lines: string[] = [
          `### 群聊列表查询结果（序号 ${v.offset + 1}~${v.offset + v.total} / 共 ${v.total_matched} 个群）`,
        ];
        for (let i = 0; i < v.groups.length; i++) {
          const g = v.groups[i];
          const remarkPart = g.group_remark ? ` (备注: ${g.group_remark})` : '';
          lines.push(
            `${v.offset + i + 1}. **${g.group_name}**${remarkPart} | 群号: \`${g.group_id}\``
          );
        }
        if (v.has_more) {
          lines.push(
            `\n> 还有 ${v.total_matched - v.offset - v.total} 个群未展示。继续浏览请传入 \`offset: ${v.offset + v.total}\`。`
          );
        } else if (v.message) {
          lines.push(`\n> ${v.message}`);
        }
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    execute: async (args) => {
      const ctx = contextGetter();
      return queryGroupList((args || {}) as GetGroupListParams, ctx) as any;
    },
  });
}
