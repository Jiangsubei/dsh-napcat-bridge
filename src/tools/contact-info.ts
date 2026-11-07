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
import {
  buildOffsetMessage,
  normalizeLimit,
  normalizeOffset,
  paginateByOffset,
  sortByNumericId,
} from './pagination.js';

export { toLosslessJson };

/**
 * 解码 HTML 实体编码文本（如 &#10; 换行、&nbsp; 空格、&lt;、&gt; 等）
 */
export function decodeHtmlEntities(str: string): string {
  if (!str) return '';
  return str
    .replace(/&#(\d+);/g, (_, dec) => {
      const code = Number(dec);
      return Number.isSafeInteger(code) ? String.fromCodePoint(code) : _;
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
      const code = parseInt(hex, 16);
      return Number.isSafeInteger(code) ? String.fromCodePoint(code) : _;
    })
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'");
}

const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000; // 默认 5 分钟缓存
const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 50;

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

// ==================== 2. 群聊列表查询 (get_group_list) ====================

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
      let groupCreateTime = Number(d.group_create_time ?? d.groupCreateTime ?? d.create_time) || 0;
      let groupMemo = String(d.richFingerMemo || d.fingerMemo || d.group_memo || d.groupMemo || d.memo || '');

      // 双轨兼容垫片：若发现建群时间为 0 或群介绍为空（如 NapCat 默认精简 6 字段），尝试升阶调用 get_group_detail_info 获取完整详情
      if (groupCreateTime === 0 || !groupMemo) {
        try {
          const detailRes = typeof (gateway as any).getGroupDetailInfo === 'function'
            ? await (gateway as any).getGroupDetailInfo(groupIdStr)
            : typeof (gateway as any).sendAction === 'function'
            ? await (gateway as any).sendAction('get_group_detail_info', { group_id: groupIdStr })
            : undefined;

          if (detailRes && detailRes.status === 'ok' && detailRes.data) {
            const dd = detailRes.data;
            if (groupCreateTime === 0) {
              groupCreateTime = Number(dd.group_create_time ?? dd.groupCreateTime ?? dd.create_time) || 0;
            }
            if (!groupMemo) {
              groupMemo = String(dd.richFingerMemo || dd.fingerMemo || dd.group_memo || dd.groupMemo || dd.memo || '');
            }
          }
        } catch {
          // 升阶异常静默降级，保留既有基础信息
        }
      }

      return toLosslessJson({
        success: true,
        group_id: String(d.group_id || d.groupCode || groupIdStr),
        group_name: String(d.group_name || d.groupName || ''),
        group_remark: String(d.group_remark || d.remarkName || ''),
        member_count: Number(d.member_count ?? d.memberNum) || 0,
        max_member_count: Number(d.max_member_count ?? d.maxMemberNum) || 0,
        group_memo: groupMemo,
        group_create_time: groupCreateTime,
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
  '按 offset 分页查询指定 QQ 群的历史公告列表。每条结果返回连续行号、公告 ID、发布者 QQ、发布时间戳、纯文本公告内容、已阅人数及是否置顶。用于了解群内规约或最新群务动态。翻页时按已展示条数自行传入 offset。';

export async function queryGroupNotice(
  params: GetGroupNoticeParams,
  ctx: ToolExecutionContext
): Promise<GetGroupNoticeResult> {
  const offset = normalizeOffset(params?.offset);
  const limit = normalizeLimit(params?.limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
  const baseResult = { total: 0, total_matched: 0, offset, limit, has_more: false };

  if (!params || !params.group_id || String(params.group_id).trim() === '') {
    return toLosslessJson({
      success: false,
      notices: [],
      ...baseResult,
      error: '目标群号不能为空。请传入 group_id。',
    });
  }

  const gateway = ctx.gateway;
  if (!gateway) {
    return toLosslessJson({
      success: false,
      notices: [],
      ...baseResult,
      error: 'QQ 网关未连接或离线，暂时无法查询群公告。',
    });
  }

  const groupIdStr = String(params.group_id).trim();

  try {
    const res = await gateway.getGroupNotice(groupIdStr);
    if (res && res.status === 'ok' && Array.isArray(res.data)) {
      const allNotices: GroupNoticeItem[] = res.data.map((raw: any) => {
        const textContent =
          typeof raw.message === 'string'
            ? raw.message
            : raw.message?.text
            ? String(raw.message.text)
            : '';

        const decodedContent = decodeHtmlEntities(textContent).trim();

        return {
          notice_id: String(raw.notice_id || ''),
          sender_id: String(raw.sender_id || ''),
          publish_time: Number(raw.publish_time) || 0,
          content: decodedContent,
          read_num: Number(raw.read_num) || 0,
          pinned: Boolean(raw.pinned),
        };
      });

      const page = paginateByOffset(allNotices, { offset, limit }, {
        defaultLimit: DEFAULT_LIST_LIMIT,
        maxLimit: MAX_LIST_LIMIT,
      });

      const message =
        page.totalMatched === 0
          ? '该群当前暂无群公告。'
          : buildOffsetMessage({
              offset: page.offset,
              returned: page.returned,
              totalMatched: page.totalMatched,
              hasMore: page.hasMore,
              ...(page.nextOffset !== undefined ? { nextOffset: page.nextOffset } : {}),
              unit: '条公告',
            });

      return toLosslessJson({
        success: true,
        group_id: groupIdStr,
        notices: page.items,
        total: page.returned,
        total_matched: page.totalMatched,
        offset: page.offset,
        limit: page.limit,
        has_more: page.hasMore,
        ...(message ? { message } : {}),
      });
    }

    return toLosslessJson({
      success: false,
      notices: [],
      ...baseResult,
      error: `获取群公告失败: ${res?.message || '目标群不存在或无权访问公告'}`,
    });
  } catch (err: any) {
    return toLosslessJson({
      success: false,
      notices: [],
      ...baseResult,
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
      offset: {
        type: 'number',
        description: '起始序号偏移，从 0 开始（0 表示第 1 条）。翻页时按已展示条数自行推算。',
      },
      limit: {
        type: 'number',
        description: '单次返回条数 (默认 20，单次上限 50)。',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => {
        const v = value as unknown as GetGroupNoticeResult;
        if (!v || !v.success) return [{ type: 'text', text: `查询失败: ${v?.error || '未知错误'}` }];
        if (v.total === 0) {
          return [{ type: 'text', text: v.message || `群 [${v.group_id}] 当前暂无群公告。` }];
        }
        const lines: string[] = [
          `### 群公告列表 (群号: \`${v.group_id}\`，序号 ${v.offset + 1}~${v.offset + v.total} / 共 ${v.total_matched} 条)`,
        ];
        for (let i = 0; i < v.notices.length; i++) {
          const n = v.notices[i];
          const timeStr = n.publish_time ? new Date(n.publish_time * 1000).toLocaleString('zh-CN') : '未知时间';
          lines.push(`${v.offset + i + 1}. [公告] ${timeStr} (发布者 QQ: \`${n.sender_id}\`)`);
          lines.push(n.content || '（纯图片或空内容）');
          lines.push('');
        }
        if (v.has_more) {
          lines.push(
            `> 还有 ${v.total_matched - v.offset - v.total} 条未展示。继续浏览请传入 \`offset: ${v.offset + v.total}\`。`
          );
        } else if (v.message) {
          lines.push(`> ${v.message}`);
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
