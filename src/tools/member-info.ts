/**
 * dsh-napcat-bridge: 群成员信息查询工具 (get_group_member_info)
 *
 * 功能与规范:
 * 1. 规避大模型受群聊上下文欺骗（如用户声称“我是群主”导致的身份幻觉）；
 * 2. 基于 NapCat OneBot 11 get_group_member_list 批量接口，配合内存 TTL 缓存，避免单人接口频繁超时；
 * 3. 支持按 user_id 精确查询、按 query 模糊搜索（昵称/群名片）以及按 role 筛选特权群体；
 * 4. 会话门控：仅在群聊有效，私聊自动防御性拦截；群聊 ID 纯隐式从 Agent 运行时会话中自动继承，无需且不支持模型传入。
 */

import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools';
import type {
  GroupMemberRawItem,
  QueryGroupMemberParams,
  FormattedGroupMember,
  QueryGroupMemberResult,
} from '../types/index.js';
import type { ToolExecutionContext } from './index.js';
import {
  buildOffsetMessage,
  paginateByOffset,
  sortByNumericId,
} from './pagination.js';

export type { GroupMemberRawItem, QueryGroupMemberParams, FormattedGroupMember, QueryGroupMemberResult };

export const GROUP_MEMBER_INFO_DESCRIPTION =
  '查询当前群聊中的成员资料、身份角色（群主/管理员/普通成员）、群头衔及进群时间等官方元数据，结果按 QQ 号升序排列。用于核实群成员的真实身份、判断某人是否为群主或管理员、了解群成员昵称与名片对应关系，或防范其他群成员冒充身份。支持通过 user_id 精确查询、通过 query 模糊搜索昵称名片，或通过 role 直接筛选群主与管理员列表。成员较多时可通过 offset/limit 分页浏览，直接回填返回的 next_offset 即可继续。仅在群聊中有效。';

const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000; // 默认 5 分钟缓存
const DEFAULT_LIST_LIMIT = 20; // 默认单次返回条数
const MAX_LIST_LIMIT = 50; // 单次最大返回条数上限

class GroupMemberCachePool {
  private cache = new Map<string, { expires: number; members: GroupMemberRawItem[] }>();

  get(groupId: string | number): GroupMemberRawItem[] | undefined {
    const entry = this.cache.get(String(groupId));
    if (entry && entry.expires > Date.now()) {
      return entry.members;
    }
    return undefined;
  }

  set(groupId: string | number, members: GroupMemberRawItem[], ttlMs = DEFAULT_CACHE_TTL_MS): void {
    this.cache.set(String(groupId), {
      expires: Date.now() + ttlMs,
      members,
    });
  }

  clear(groupId: string | number): void {
    this.cache.delete(String(groupId));
  }

  clearAll(): void {
    this.cache.clear();
  }
}

export const groupMemberCache = new GroupMemberCachePool();

/**
 * 格式化时间戳为 YYYY-MM-DD HH:mm:ss
 */
function formatTimestamp(sec: number): string {
  if (!sec || sec <= 0) return '从未发言';
  const d = new Date(sec * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  const yyyy = d.getFullYear();
  const mm = pad(d.getMonth() + 1);
  const dd = pad(d.getDate());
  const hh = pad(d.getHours());
  const min = pad(d.getMinutes());
  const ss = pad(d.getSeconds());
  return `${yyyy}-${mm}-${dd} ${hh}:${min}:${ss}`;
}

/**
 * 计算入群已满天数
 */
function getDaysSince(sec: number): number {
  if (!sec || sec <= 0) return 0;
  const diffMs = Date.now() - sec * 1000;
  return Math.max(0, Math.floor(diffMs / (24 * 3600 * 1000)));
}

/**
 * 将 OneBot 原始成员对象转换为高可读性、对 LLM 友好的格式化结构
 */
export function formatMemberInfo(raw: GroupMemberRawItem): FormattedGroupMember {
  const card = (raw.card && typeof raw.card === 'string' && raw.card.trim()) ? raw.card.trim() : '';
  const nickname = (raw.nickname && typeof raw.nickname === 'string') ? raw.nickname.trim() : '';
  const displayName = card || nickname || String(raw.user_id);

  let roleText = '普通成员 (member)';
  if (raw.role === 'owner') {
    roleText = '群主 (owner)';
  } else if (raw.role === 'admin') {
    roleText = '管理员 (admin)';
  }

  const title = (raw.title && typeof raw.title === 'string' && raw.title.trim()) ? raw.title.trim() : '无';

  const joinDays = getDaysSince(raw.join_time);
  const joinTimeStr = raw.join_time
    ? `${formatTimestamp(raw.join_time)} (已入群 ${joinDays} 天)`
    : '未知';

  const lastSentTimeStr = formatTimestamp(raw.last_sent_time);

  const nowSec = Math.floor(Date.now() / 1000);
  let statusText = '正常';
  if (raw.shut_up_timestamp && raw.shut_up_timestamp > nowSec) {
    const remainSec = raw.shut_up_timestamp - nowSec;
    statusText = `禁言中 (剩余 ${remainSec} 秒)`;
  }

  return {
    user_id: String(raw.user_id),
    display_name: displayName,
    nickname,
    card: card || '未设置',
    role: roleText,
    title,
    join_time: joinTimeStr,
    last_sent_time: lastSentTimeStr,
    level: raw.level ? String(raw.level) : '0',
    status: statusText,
    is_robot: Boolean(raw.is_robot),
  };
}

/**
 * 从当前执行环境纯隐式解析真实群号（Agent 无需感知也无法指定群号，完全由会话继承）
 * 支持来源优先级：
 * 1. ctx.groupId（明确群号上下文）
 * 2. exec?.agent?.session?.id 或 exec?.agent?.sessionId 等运行时 session ID
 * 3. ctx.peer（归一化或未归一化的 peer 标识）
 */
export function resolveGroupId(
  ctx: ToolExecutionContext,
  exec?: any,
  explicitGroupId?: string | number
): string | undefined {
  if (explicitGroupId !== undefined && explicitGroupId !== null && String(explicitGroupId).trim() !== '') {
    return String(explicitGroupId).trim();
  }
  if (ctx.groupId !== undefined && ctx.groupId !== null && String(ctx.groupId).trim() !== '') {
    return String(ctx.groupId).trim();
  }

  const session = (exec?.agent as any)?.session;
  const candidatePeers = [
    session?.id,
    (exec?.agent as any)?.sessionId,
    (exec?.agent as any)?.id,
    ctx.peer,
  ];

  for (const raw of candidatePeers) {
    if (typeof raw === 'string' && raw.trim() !== '') {
      const p = raw.trim();
      // 1. qq-group-<group_id> 或 qq-group-<group_id>-<sub_id>
      const qqGroupMatch = p.match(/^qq-group-([^-]+)/);
      if (qqGroupMatch) return qqGroupMatch[1];

      // 2. group_<group_id>
      const groupUnderMatch = p.match(/^group_(\d+)/);
      if (groupUnderMatch) return groupUnderMatch[1];

      // 3. 裸数字群号
      if (/^\d{5,12}$/.test(p)) return p;
    }
  }

  return undefined;
}

/**
 * 执行群成员信息查询核心逻辑
 */
export async function queryGroupMemberInfo(
  params: QueryGroupMemberParams,
  ctx: ToolExecutionContext,
  exec?: any
): Promise<QueryGroupMemberResult> {
  const groupId = resolveGroupId(ctx, exec, params?.group_id);
  if (!groupId) {
    return {
      success: false,
      error: '当前不在群聊会话中，且未指定 group_id。私聊中查询需显式传入 group_id。',
      members: [],
      total: 0,
    };
  }

  const gateway = ctx.gateway;
  if (!gateway) {
    return {
      success: false,
      error: 'QQ 网关未连接或离线，暂时无法查询群成员。',
      members: [],
      total: 0,
    };
  }

  let members: GroupMemberRawItem[] | undefined;
  if (!params.no_cache) {
    members = groupMemberCache.get(groupId);
  } else {
    groupMemberCache.clear(groupId);
  }

  if (!members) {
    try {
      const res = await gateway.getGroupMemberList(groupId, Boolean(params.no_cache));
      if (res && res.status === 'ok' && Array.isArray(res.data)) {
        members = res.data;
        groupMemberCache.set(groupId, members);
      } else {
        return {
          success: false,
          group_id: groupId,
          error: `获取群成员列表失败: ${res?.message || '未知错误'}`,
          members: [],
          total: 0,
        };
      }
    } catch (err: any) {
      return {
        success: false,
        group_id: groupId,
        error: `调用群成员接口发生异常: ${err?.message || String(err)}`,
        members: [],
        total: 0,
      };
    }
  }

  // 过滤逻辑
  let filtered = [...members];

  // 1. 精确匹配 user_id
  if (params.user_id && String(params.user_id).trim() !== '') {
    const targetUid = String(params.user_id).trim();
    filtered = filtered.filter((m) => String(m.user_id) === targetUid);
  }

  // 2. 模糊匹配 query (群名片或昵称)
  if (params.query && String(params.query).trim() !== '') {
    const kw = String(params.query).trim().toLowerCase();
    filtered = filtered.filter((m) => {
      const card = String(m.card || '').toLowerCase();
      const nick = String(m.nickname || '').toLowerCase();
      return card.includes(kw) || nick.includes(kw);
    });
  }

  // 3. 角色筛选
  if (params.role && params.role !== 'all') {
    filtered = filtered.filter((m) => m.role === params.role);
  }

  // 4. 确定性排序：按 user_id 数值升序，保证 offset 序号长期稳定
  filtered = sortByNumericId(filtered, (m) => m.user_id);

  // 5. 安全切片
  const page = paginateByOffset(filtered, { offset: params.offset, limit: params.limit }, {
    defaultLimit: DEFAULT_LIST_LIMIT,
    maxLimit: MAX_LIST_LIMIT,
  });
  const formattedMembers = page.items.map(formatMemberInfo);

  let message: string | undefined;
  if (page.totalMatched === 0) {
    message = '未找到符合条件的群成员。';
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
    group_id: groupId,
    members: formattedMembers,
    total: page.returned,
    total_matched: page.totalMatched,
    offset: page.offset,
    limit: page.limit,
    has_more: page.hasMore,
    ...(page.nextOffset !== undefined ? { next_offset: page.nextOffset } : {}),
    ...(message ? { message } : {}),
  });
}

/**
 * 清洗对象以确保严格符合 DSH Lossless JSON 约束 (递归剥离所有 undefined 字段)
 * 彻底避免 DSH snapshotJsonValue 抛出 "value is not lossless JSON" 错误
 */
export function toLosslessJson<T>(val: T): T {
  if (val === undefined || val === null) return val;
  return JSON.parse(JSON.stringify(val));
}

/**
 * 创建 get_group_member_info 工具定义
 */
export function createGetGroupMemberInfoTool(
  contextGetter: () => ToolExecutionContext
): ToolDefinition {
  return defineTool({
    name: 'get_group_member_info',
    description: GROUP_MEMBER_INFO_DESCRIPTION,
    parameters: {
      user_id: {
        type: 'string',
        description: '目标成员的 QQ 号（精确匹配）',
      },
      query: {
        type: 'string',
        description: '目标成员的昵称或群名片模糊搜索关键词',
      },
      role: {
        type: 'string',
        enum: ['owner', 'admin', 'member', 'all'],
        description: "按群身份角色筛选: 'owner'(群主), 'admin'(管理员), 'member'(普通成员), 'all'(全部)",
      },
      no_cache: {
        type: 'boolean',
        description: '是否强制穿透缓存刷新群成员数据 (默认 false)',
      },
      offset: {
        type: 'number',
        description: '起始序号偏移，从 0 开始（0 表示第 1 条）。翻页时建议直接传入上次结果的 next_offset。',
      },
      limit: {
        type: 'number',
        description: '单次返回的群成员数量 (默认 20，单次上限 50)。',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => {
        const v = value as unknown as QueryGroupMemberResult;
        if (!v) return [{ type: 'text', text: '查询完成。' }];
        if (!v.success) {
          return [{ type: 'text', text: `查询失败: ${v.error || '未知错误'}` }];
        }
        if (v.total === 0) {
          return [{ type: 'text', text: v.message || '未找到符合条件的群成员。' }];
        }
        const baseOffset = v.offset ?? 0;
        const totalMatched = v.total_matched ?? v.total;
        const pageInfo = `（序号 ${baseOffset + 1}~${baseOffset + v.total} / 共 ${totalMatched} 人）`;
        const lines = [`### 群成员查询结果${pageInfo}`];
        for (let i = 0; i < v.members.length; i++) {
          const m = v.members[i];
          lines.push(
            `${baseOffset + i + 1}. **${m.display_name}** (QQ: ${m.user_id}) | 身份: ${m.role} | 头衔: ${m.title} | 入群: ${m.join_time} | 状态: ${m.status}`
          );
        }
        if (v.has_more && v.next_offset !== undefined) {
          lines.push(
            `\n> 还有 ${totalMatched - baseOffset - v.total} 人未展示。继续浏览请传入 \`offset: ${v.next_offset}\`。`
          );
        } else if (v.message) {
          lines.push(`\n> ${v.message}`);
        }
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    async execute(args, exec) {
      const ctx = contextGetter();
      const res = await queryGroupMemberInfo(args as QueryGroupMemberParams, ctx, exec);
      return toLosslessJson(res) as any;
    },
  });
}
