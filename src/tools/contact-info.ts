/**
 * src/tools/contact-info.ts
 *
 * dsh-napcat-bridge: 社交关系链探查与群信息只读工具集
 *
 * 包含工具:
 * 1. get_friend_list: 分页查询好友列表 (支持 query 模糊匹配 nickname/remark，TTL 缓存)
 * 2. get_group_list: 分页查询加入的群聊列表 (支持 query 模糊匹配 group_name/group_remark，TTL 缓存)
 * 3. get_user_profile: 查询任意指定 QQ 用户的公开资料卡 (对接 get_stranger_info)
 * 4. get_group_info: 查询指定群的基础信息与元数据 (对接 get_group_info)
 * 5. get_group_notice: 查询指定群的群公告列表 (对接 _get_group_notice)
 *
 * 架构规范:
 * - 纯只读设计，严禁暴露写操作
 * - 严格遵循 DSH Lossless JSON 约束 (toLosslessJson 递归剥离所有 undefined)
 * - 字段极简降噪，杜绝大模型上下文爆炸
 */

import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools';
import type {
  FriendItem,
  GetFriendListParams,
  GetFriendListResult,
  GroupItem,
  GetGroupListParams,
  GetGroupListResult,
  GetUserProfileParams,
  GetUserProfileResult,
  GetGroupInfoParams,
  GetGroupInfoResult,
  GroupNoticeItem,
  GetGroupNoticeParams,
  GetGroupNoticeResult,
} from '../types/index.js';
import type { ToolExecutionContext } from './index.js';
import { toLosslessJson } from './member-info.js';

export { toLosslessJson };

const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000; // 默认 5 分钟缓存
const DEFAULT_PAGE_LIMIT = 20;
const MAX_PAGE_LIMIT = 50;

/**
 * 内存 TTL 缓存池基类
 */
class MemoryCachePool<T> {
  private cache = new Map<string, { expires: number; data: T }>();

  get(key: string): T | undefined {
    const entry = this.cache.get(key);
    if (entry && entry.expires > Date.now()) {
      return entry.data;
    }
    return undefined;
  }

  set(key: string, data: T, ttlMs = DEFAULT_CACHE_TTL_MS): void {
    this.cache.set(key, {
      expires: Date.now() + ttlMs,
      data,
    });
  }

  clear(key: string): void {
    this.cache.delete(key);
  }

  clearAll(): void {
    this.cache.clear();
  }
}

export const friendListCache = new MemoryCachePool<any[]>();
export const groupListCache = new MemoryCachePool<any[]>();

// ==================== 1. 好友列表查询 (get_friend_list) ====================

export const GET_FRIEND_LIST_DESCRIPTION =
  '分页查询当前机器人的 QQ 好友列表。支持通过 query 关键词模糊搜索好友的昵称或备注名。结果包含 QQ 号、昵称、备注、个性签名、性别、年龄及 QQ 等级等核心字段。用于查找好友 QQ、核对备注或寻找特定联系人。';

export async function queryFriendList(
  params: GetFriendListParams,
  ctx: ToolExecutionContext
): Promise<GetFriendListResult> {
  const gateway = ctx.gateway;
  if (!gateway) {
    return toLosslessJson({
      success: false,
      friends: [],
      total: 0,
      total_matched: 0,
      page: 1,
      limit: DEFAULT_PAGE_LIMIT,
      total_pages: 1,
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
          page: 1,
          limit: DEFAULT_PAGE_LIMIT,
          total_pages: 1,
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
        page: 1,
        limit: DEFAULT_PAGE_LIMIT,
        total_pages: 1,
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
    long_nick: String(raw.long_nick || ''),
    sex: String(raw.sex || 'unknown'),
    age: Number(raw.age) || 0,
    level: Number(raw.level) || 0,
  }));

  // 2. 模糊匹配 query (匹配 nickname 或 remark)
  let filtered = allFormatted;
  if (params.query && String(params.query).trim() !== '') {
    const kw = String(params.query).trim().toLowerCase();
    filtered = filtered.filter((f) => {
      return f.nickname.toLowerCase().includes(kw) || f.remark.toLowerCase().includes(kw);
    });
  }

  // 3. 安全分页
  const page = Math.max(1, Math.floor(Number(params.page) || 1));
  const limit = Math.min(MAX_PAGE_LIMIT, Math.max(1, Math.floor(Number(params.limit) || DEFAULT_PAGE_LIMIT)));
  const totalMatched = filtered.length;
  const totalPages = Math.max(1, Math.ceil(totalMatched / limit));
  const startIndex = (page - 1) * limit;
  const endIndex = Math.min(startIndex + limit, totalMatched);
  const sliced = startIndex < totalMatched ? filtered.slice(startIndex, endIndex) : [];
  const hasMore = page < totalPages;

  let message: string | undefined;
  if (totalMatched === 0) {
    message = '未找到符合条件的好友。';
  } else if (hasMore) {
    message = `当前展示第 ${startIndex + 1}~${endIndex} 位（第 ${page}/${totalPages} 页，共 ${totalMatched} 人）。若需继续浏览，请再次调用并传入 page: ${page + 1}。`;
  } else if (totalPages > 1) {
    message = `已展示至最后一页（第 ${page}/${totalPages} 页，共 ${totalMatched} 人）。`;
  }

  return toLosslessJson({
    success: true,
    friends: sliced,
    total: sliced.length,
    total_matched: totalMatched,
    page,
    limit,
    total_pages: totalPages,
    has_more: hasMore,
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
      page: {
        type: 'number',
        description: '分页页码，从 1 开始。默认为第 1 页。',
      },
      limit: {
        type: 'number',
        description: '每页返回条数 (默认 20，单次上限 50)。',
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
          `### 好友列表查询结果 (第 ${v.page}/${v.total_pages} 页，匹配 ${v.total_matched} 人，本页展示 ${v.total} 人)`,
        ];
        for (const f of v.friends) {
          const remarkPart = f.remark ? ` (备注: ${f.remark})` : '';
          lines.push(`- **${f.nickname}**${remarkPart} | QQ: \`${f.user_id}\``);
        }
        if (v.has_more) {
          lines.push(`\n> 提示：当前还有未展示的好友。可再次调用本工具并传入 \`page: ${v.page + 1}\` 继续浏览。`);
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

// ==================== 2. 群聊列表查询 (get_group_list) ====================

export const GET_GROUP_LIST_DESCRIPTION =
  '分页查询当前机器人加入的 QQ 群聊列表。支持通过 query 关键词模糊搜索群名称或群备注。结果包含群号、群名称、群备注、群人数、人数上限、群公告摘要及建群时间等元数据。用于定位特定群聊、核对群号。';

export async function queryGroupList(
  params: GetGroupListParams,
  ctx: ToolExecutionContext
): Promise<GetGroupListResult> {
  const gateway = ctx.gateway;
  if (!gateway) {
    return toLosslessJson({
      success: false,
      groups: [],
      total: 0,
      total_matched: 0,
      page: 1,
      limit: DEFAULT_PAGE_LIMIT,
      total_pages: 1,
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
          page: 1,
          limit: DEFAULT_PAGE_LIMIT,
          total_pages: 1,
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
        page: 1,
        limit: DEFAULT_PAGE_LIMIT,
        total_pages: 1,
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
    member_count: Number(raw.member_count) || 0,
    max_member_count: Number(raw.max_member_count) || 0,
    group_memo: String(raw.group_memo || ''),
    group_create_time: Number(raw.group_create_time) || 0,
  }));

  // 2. 模糊匹配 query (匹配 group_name 或 group_remark)
  let filtered = allFormatted;
  if (params.query && String(params.query).trim() !== '') {
    const kw = String(params.query).trim().toLowerCase();
    filtered = filtered.filter((g) => {
      return g.group_name.toLowerCase().includes(kw) || g.group_remark.toLowerCase().includes(kw);
    });
  }

  // 3. 安全分页
  const page = Math.max(1, Math.floor(Number(params.page) || 1));
  const limit = Math.min(MAX_PAGE_LIMIT, Math.max(1, Math.floor(Number(params.limit) || DEFAULT_PAGE_LIMIT)));
  const totalMatched = filtered.length;
  const totalPages = Math.max(1, Math.ceil(totalMatched / limit));
  const startIndex = (page - 1) * limit;
  const endIndex = Math.min(startIndex + limit, totalMatched);
  const sliced = startIndex < totalMatched ? filtered.slice(startIndex, endIndex) : [];
  const hasMore = page < totalPages;

  let message: string | undefined;
  if (totalMatched === 0) {
    message = '未找到符合条件的群聊。';
  } else if (hasMore) {
    message = `当前展示第 ${startIndex + 1}~${endIndex} 个（第 ${page}/${totalPages} 页，共 ${totalMatched} 个群）。若需继续浏览，请再次调用并传入 page: ${page + 1}。`;
  } else if (totalPages > 1) {
    message = `已展示至最后一页（第 ${page}/${totalPages} 页，共 ${totalMatched} 个群）。`;
  }

  return toLosslessJson({
    success: true,
    groups: sliced,
    total: sliced.length,
    total_matched: totalMatched,
    page,
    limit,
    total_pages: totalPages,
    has_more: hasMore,
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
      page: {
        type: 'number',
        description: '分页页码，从 1 开始。默认为第 1 页。',
      },
      limit: {
        type: 'number',
        description: '每页返回条数 (默认 20，单次上限 50)。',
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
          `### 群聊列表查询结果 (第 ${v.page}/${v.total_pages} 页，匹配 ${v.total_matched} 个群，本页展示 ${v.total} 个)`,
        ];
        for (const g of v.groups) {
          const remarkPart = g.group_remark ? ` (备注: ${g.group_remark})` : '';
          const memoPart = g.group_memo ? `\n  - 群介绍: ${g.group_memo}` : '';
          lines.push(
            `- **${g.group_name}**${remarkPart} | 群号: \`${g.group_id}\` | 人数: ${g.member_count}/${g.max_member_count}${memoPart}`
          );
        }
        if (v.has_more) {
          lines.push(`\n> 提示：当前还有未展示的群聊。可再次调用本工具并传入 \`page: ${v.page + 1}\` 继续浏览。`);
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

// ==================== 3. 个人公开资料卡查询 (get_user_profile) ====================

export const GET_USER_PROFILE_DESCRIPTION =
  '查询任意指定 QQ 用户的公开资料卡信息（好友与非好友均可查询）。返回昵称、备注、性别、年龄、QQ 等级、个性签名、QID 及注册时间戳等字段。用于了解陌生人身份或查询联系人资料。';

export async function queryUserProfile(
  params: GetUserProfileParams,
  ctx: ToolExecutionContext
): Promise<GetUserProfileResult> {
  if (!params || !params.user_id || String(params.user_id).trim() === '') {
    return toLosslessJson({
      success: false,
      error: '目标 QQ 号不能为空。请传入 user_id。',
    });
  }

  const gateway = ctx.gateway;
  if (!gateway) {
    return toLosslessJson({
      success: false,
      error: 'QQ 网关未连接或离线，暂时无法查询用户资料。',
    });
  }

  const userIdStr = String(params.user_id).trim();

  try {
    const res = await gateway.getStrangerInfo(userIdStr);
    if (res && res.status === 'ok' && res.data) {
      const d = res.data;
      return toLosslessJson({
        success: true,
        user_id: String(d.user_id || userIdStr),
        nickname: String(d.nickname || ''),
        remark: String(d.remark || ''),
        sex: String(d.sex || 'unknown'),
        age: Number(d.age) || 0,
        level: Number(d.level || d.qq_level || 0),
        long_nick: String(d.long_nick || ''),
        ...(d.qid ? { qid: String(d.qid) } : {}),
        ...(d.reg_time ? { reg_time: Number(d.reg_time) } : {}),
      });
    }

    return toLosslessJson({
      success: false,
      error: `获取用户资料失败: ${res?.message || '目标用户不存在或受隐私限制'}`,
    });
  } catch (err: any) {
    return toLosslessJson({
      success: false,
      error: `调用资料卡接口发生异常: ${err?.message || String(err)}`,
    });
  }
}

export function createGetUserProfileTool(
  contextGetter: () => ToolExecutionContext
): ToolDefinition {
  return defineTool({
    name: 'get_user_profile',
    description: GET_USER_PROFILE_DESCRIPTION,
    parameters: {
      user_id: {
        type: 'string',
        description: '目标用户的 QQ 号 (必填)',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => {
        const v = value as unknown as GetUserProfileResult;
        if (!v || !v.success) return [{ type: 'text', text: `查询失败: ${v?.error || '未知错误'}` }];
        const regTimeStr = v.reg_time ? new Date(v.reg_time * 1000).toLocaleDateString('zh-CN') : undefined;
        const lines: string[] = [
          `### QQ 个人公开资料卡`,
          `- **用户昵称**: ${v.nickname || '（未知）'}`,
          `- **QQ 账号**: \`${v.user_id}\``,
          ...(v.remark ? [`- **好友备注**: ${v.remark}`] : []),
          ...(v.qid ? [`- **QID**: ${v.qid}`] : []),
          `- **性别/年龄**: ${v.sex || '未知'} / ${v.age ?? 0} 岁`,
          `- **QQ 等级**: Lv.${v.level ?? 0}`,
          ...(regTimeStr ? [`- **注册时间**: ${regTimeStr}`] : []),
          `- **个性签名**: ${v.long_nick || '（无）'}`,
        ];
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    execute: async (args) => {
      const ctx = contextGetter();
      return queryUserProfile(args as GetUserProfileParams, ctx) as any;
    },
  });
}

// ==================== 4. 群基础信息查询 (get_group_info) ====================

export const GET_GROUP_INFO_DESCRIPTION =
  '查询指定 QQ 群的基础信息与元数据（如群名称、群备注、群人数、人数上限、群公告摘要及建群时间）。用于核实群规模与基本设置。';

export async function queryGroupInfo(
  params: GetGroupInfoParams,
  ctx: ToolExecutionContext
): Promise<GetGroupInfoResult> {
  if (!params || !params.group_id || String(params.group_id).trim() === '') {
    return toLosslessJson({
      success: false,
      error: '目标群号不能为空。请传入 group_id。',
    });
  }

  const gateway = ctx.gateway;
  if (!gateway) {
    return toLosslessJson({
      success: false,
      error: 'QQ 网关未连接或离线，暂时无法查询群信息。',
    });
  }

  const groupIdStr = String(params.group_id).trim();

  try {
    const res = await gateway.getGroupInfo(groupIdStr);
    if (res && res.status === 'ok' && res.data) {
      const d = res.data;
      return toLosslessJson({
        success: true,
        group_id: String(d.group_id || groupIdStr),
        group_name: String(d.group_name || ''),
        group_remark: String(d.group_remark || ''),
        member_count: Number(d.member_count) || 0,
        max_member_count: Number(d.max_member_count) || 0,
        group_memo: String(d.group_memo || ''),
        group_create_time: Number(d.group_create_time) || 0,
      });
    }

    return toLosslessJson({
      success: false,
      error: `获取群信息失败: ${res?.message || '目标群不存在或机器人未加群'}`,
    });
  } catch (err: any) {
    return toLosslessJson({
      success: false,
      error: `调用群信息接口发生异常: ${err?.message || String(err)}`,
    });
  }
}

export function createGetGroupInfoTool(
  contextGetter: () => ToolExecutionContext
): ToolDefinition {
  return defineTool({
    name: 'get_group_info',
    description: GET_GROUP_INFO_DESCRIPTION,
    parameters: {
      group_id: {
        type: 'string',
        description: '目标 QQ 群号 (必填)',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => {
        const v = value as unknown as GetGroupInfoResult;
        if (!v || !v.success) return [{ type: 'text', text: `查询失败: ${v?.error || '未知错误'}` }];
        const createTimeStr = v.group_create_time ? new Date(v.group_create_time * 1000).toLocaleDateString('zh-CN') : '未知';
        const lines: string[] = [
          `### 群基础信息详情`,
          `- **群名称**: ${v.group_name}`,
          `- **群号**: \`${v.group_id}\``,
          ...(v.group_remark ? [`- **群备注**: ${v.group_remark}`] : []),
          `- **群规模**: ${v.member_count} / ${v.max_member_count} 人`,
          `- **建群时间**: ${createTimeStr}`,
          `- **群介绍**: ${v.group_memo || '（无）'}`,
        ];
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    execute: async (args) => {
      const ctx = contextGetter();
      return queryGroupInfo(args as GetGroupInfoParams, ctx) as any;
    },
  });
}

// ==================== 5. 群公告列表查询 (get_group_notice) ====================

export const GET_GROUP_NOTICE_DESCRIPTION =
  '查询指定 QQ 群的历史公告列表。返回公告 ID、发布者 QQ、发布时间戳、纯文本公告内容、已阅人数及是否置顶。用于了解群内规约或最新群务动态。';

export async function queryGroupNotice(
  params: GetGroupNoticeParams,
  ctx: ToolExecutionContext
): Promise<GetGroupNoticeResult> {
  if (!params || !params.group_id || String(params.group_id).trim() === '') {
    return toLosslessJson({
      success: false,
      notices: [],
      total: 0,
      error: '目标群号不能为空。请传入 group_id。',
    });
  }

  const gateway = ctx.gateway;
  if (!gateway) {
    return toLosslessJson({
      success: false,
      notices: [],
      total: 0,
      error: 'QQ 网关未连接或离线，暂时无法查询群公告。',
    });
  }

  const groupIdStr = String(params.group_id).trim();

  try {
    const res = await gateway.getGroupNotice(groupIdStr);
    if (res && res.status === 'ok' && Array.isArray(res.data)) {
      const notices: GroupNoticeItem[] = res.data.map((raw: any) => {
        const textContent =
          typeof raw.message === 'string'
            ? raw.message
            : raw.message?.text
            ? String(raw.message.text)
            : '';

        return {
          notice_id: String(raw.notice_id || ''),
          sender_id: String(raw.sender_id || ''),
          publish_time: Number(raw.publish_time) || 0,
          content: textContent.trim(),
          read_num: Number(raw.read_num) || 0,
          pinned: Boolean(raw.pinned),
        };
      });

      return toLosslessJson({
        success: true,
        group_id: groupIdStr,
        notices,
        total: notices.length,
      });
    }

    return toLosslessJson({
      success: false,
      notices: [],
      total: 0,
      error: `获取群公告失败: ${res?.message || '目标群不存在或无权访问公告'}`,
    });
  } catch (err: any) {
    return toLosslessJson({
      success: false,
      notices: [],
      total: 0,
      error: `调用群公告接口发生异常: ${err?.message || String(err)}`,
    });
  }
}

export function createGetGroupNoticeTool(
  contextGetter: () => ToolExecutionContext
): ToolDefinition {
  return defineTool({
    name: 'get_group_notice',
    description: GET_GROUP_NOTICE_DESCRIPTION,
    parameters: {
      group_id: {
        type: 'string',
        description: '目标 QQ 群号 (必填)',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => {
        const v = value as unknown as GetGroupNoticeResult;
        if (!v || !v.success) return [{ type: 'text', text: `查询失败: ${v?.error || '未知错误'}` }];
        if (v.total === 0) return [{ type: 'text', text: `群 [${v.group_id}] 当前暂无群公告。` }];
        const lines: string[] = [
          `### 群公告列表 (群号: \`${v.group_id}\`，共 ${v.total} 条)`,
        ];
        for (const n of v.notices) {
          const timeStr = n.publish_time ? new Date(n.publish_time * 1000).toLocaleString('zh-CN') : '未知时间';
          lines.push(`#### [公告] ${timeStr} (发布者 QQ: \`${n.sender_id}\`)`);
          lines.push(n.content || '（纯图片或空内容）');
          lines.push('');
        }
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    execute: async (args) => {
      const ctx = contextGetter();
      return queryGroupNotice(args as GetGroupNoticeParams, ctx) as any;
    },
  });
}
