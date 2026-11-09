/**
 * 好友列表查询工具 (get_friend_list)
 */

import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { FriendItem, GetFriendListParams, GetFriendListResult } from '../../types/index.js';
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
  friendListCache,
  DEFAULT_LIST_LIMIT,
  MAX_LIST_LIMIT,
} from './cache.js';

export const GET_FRIEND_LIST_DESCRIPTION =
  '按 offset 分页查询当前机器人的 QQ 好友列表，结果按 QQ 号升序排列。支持通过 query 关键词模糊搜索好友的昵称或备注名。每条结果返回连续行号、QQ 号、昵称与备注（如有）；个性签名、性别、年龄、QQ 等级等详细资料请使用 get_user_profile 查询。用于查找好友 QQ、核对备注或寻找特定联系人。翻页时按已展示条数自行传入 offset（例如已展示 1~20，则传 offset: 20）。';

export async function queryFriendList(
  params: GetFriendListParams,
  ctx: ToolExecutionContext
): Promise<GetFriendListResult> {
  const offset = normalizeOffset(params?.offset);
  const limit = normalizeLimit(params?.limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
  const gateway = ctx.gateway;
  if (!gateway) {
    return toLosslessJson({
      success: false,
      friends: [],
      total: 0,
      total_matched: 0,
      offset,
      limit,
      has_more: false,
      error: 'QQ 网关未连接或离线，暂时无法查询好友列表。',
    });
  }

  let rawFriends: any[] | undefined;
  const cacheKey = 'all_friends';
  if (!params.no_cache) {
    rawFriends = friendListCache.get(cacheKey);
  } else {
    friendListCache.clear(cacheKey);
  }

  if (!rawFriends) {
    try {
      const res = await gateway.getFriendList();
      if (res && res.status === 'ok' && Array.isArray(res.data)) {
        rawFriends = res.data;
        friendListCache.set(cacheKey, rawFriends);
      } else {
        return toLosslessJson({
          success: false,
          friends: [],
          total: 0,
          total_matched: 0,
          offset,
          limit,
          has_more: false,
          error: `获取好友列表失败: ${res?.message || 'OneBot 响应异常'}`,
        });
      }
    } catch (err: any) {
      return toLosslessJson({
        success: false,
        friends: [],
        total: 0,
        total_matched: 0,
        offset,
        limit,
        has_more: false,
        error: `调用好友列表接口发生异常: ${err?.message || String(err)}`,
      });
    }
  }

  // 1. 字段清洗并格式化为 FriendItem
  const allFormatted: FriendItem[] = rawFriends.map((raw: any) => ({
    user_id: String(raw.user_id),
    nickname: String(raw.nickname || ''),
    remark: String(raw.remark || ''),
  }));

  // 2. 模糊匹配 query (匹配 nickname 或 remark)
  let filtered = allFormatted;
  if (params.query && String(params.query).trim() !== '') {
    const kw = String(params.query).trim().toLowerCase();
    filtered = filtered.filter((f) => {
      return f.nickname.toLowerCase().includes(kw) || f.remark.toLowerCase().includes(kw);
    });
  }

  // 3. 确定性排序：按 user_id 数值升序，保证 offset 序号长期稳定
  filtered = sortByNumericId(filtered, (f) => f.user_id);

  // 4. 安全切片
  const page = paginateByOffset(filtered, { offset, limit }, {
    defaultLimit: DEFAULT_LIST_LIMIT,
    maxLimit: MAX_LIST_LIMIT,
  });

  let message: string | undefined;
  if (page.totalMatched === 0) {
    message = '未找到符合条件的好友。';
  } else {
    message = buildOffsetMessage({
      offset: page.offset,
      returned: page.returned,
      totalMatched: page.totalMatched,
      hasMore: page.hasMore,
      ...(page.nextOffset !== undefined ? { nextOffset: page.nextOffset } : {}),
      unit: '人',
    });
  }

  return toLosslessJson({
    success: true,
    friends: page.items,
    total: page.returned,
    total_matched: page.totalMatched,
    offset: page.offset,
    limit: page.limit,
    has_more: page.hasMore,
    ...(message ? { message } : {}),
  });
}

export function createGetFriendListTool(
  contextGetter: () => ToolExecutionContext
): ToolDefinition {
  return defineTool({
    name: 'get_friend_list',
    description: GET_FRIEND_LIST_DESCRIPTION,
    parameters: {
      query: {
        type: 'string',
        description: '模糊搜索关键词，匹配好友昵称或备注名 (不区分大小写)',
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
        description: '是否强制穿透 5 分钟缓存重新拉取最新好友数据 (默认 false)。',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => {
        const v = value as unknown as GetFriendListResult;
        if (!v || !v.success) return [{ type: 'text', text: `查询失败: ${v?.error || '未知错误'}` }];
        if (v.total === 0) return [{ type: 'text', text: v.message || '未找到符合条件的好友。' }];
        const lines: string[] = [
          `### 好友列表查询结果（序号 ${v.offset + 1}~${v.offset + v.total} / 共 ${v.total_matched} 人）`,
        ];
        for (let i = 0; i < v.friends.length; i++) {
          const f = v.friends[i];
          const remarkPart = f.remark ? ` (备注: ${f.remark})` : '';
          lines.push(`${v.offset + i + 1}. **${f.nickname}**${remarkPart} | QQ: \`${f.user_id}\``);
        }
        if (v.has_more) {
          lines.push(
            `\n> 还有 ${v.total_matched - v.offset - v.total} 人未展示。继续浏览请传入 \`offset: ${v.offset + v.total}\`。`
          );
        } else if (v.message) {
          lines.push(`\n> ${v.message}`);
        }
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    execute: async (args) => {
      const ctx = contextGetter();
      return queryFriendList((args || {}) as GetFriendListParams, ctx) as any;
    },
  });
}
