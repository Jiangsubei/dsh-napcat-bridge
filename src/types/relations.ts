/**
 * dsh-napcat-bridge: 社交关系链（好友、群、群成员、公告）与跨 Agent 协作模型
 */

export interface FriendItem {
  user_id: string;
  nickname: string;
  remark: string;
}

export interface GetFriendListParams {
  query?: string;
  offset?: number;
  limit?: number;
  no_cache?: boolean;
}

export interface GetFriendListResult {
  success: boolean;
  friends: FriendItem[];
  total: number;
  total_matched: number;
  offset: number;
  limit: number;
  has_more: boolean;
  message?: string;
  error?: string;
}

export interface GroupItem {
  group_id: string;
  group_name: string;
  group_remark: string;
}

export interface GetGroupListParams {
  query?: string;
  offset?: number;
  limit?: number;
  no_cache?: boolean;
}

export interface GetGroupListResult {
  success: boolean;
  groups: GroupItem[];
  total: number;
  total_matched: number;
  offset: number;
  limit: number;
  has_more: boolean;
  message?: string;
  error?: string;
}

export interface GetUserProfileParams {
  user_id: string | number;
}

export interface GetUserProfileResult {
  success: boolean;
  user_id?: string;
  nickname?: string;
  remark?: string;
  sex?: string;
  age?: number;
  level?: number;
  long_nick?: string;
  qid?: string;
  reg_time?: number;
  error?: string;
}

export interface GetGroupInfoParams {
  group_id: string | number;
}

export interface GetGroupInfoResult {
  success: boolean;
  group_id?: string;
  group_name?: string;
  group_remark?: string;
  member_count?: number;
  max_member_count?: number;
  group_memo?: string;
  group_create_time?: number;
  error?: string;
}

export interface GroupNoticeItem {
  notice_id: string;
  sender_id: string;
  publish_time: number;
  content: string;
  read_num: number;
  pinned: boolean;
}

export interface GetGroupNoticeParams {
  group_id: string | number;
  /** 起始序号偏移，从 0 开始 (默认 0) */
  offset?: number;
  /** 单次返回数量 (默认 20，范围 1~50) */
  limit?: number;
}

export interface GetGroupNoticeResult {
  success: boolean;
  group_id?: string;
  notices: GroupNoticeItem[];
  /** 本次实际返回条数 */
  total: number;
  /** 过滤后匹配的总条数 */
  total_matched: number;
  offset: number;
  limit: number;
  has_more: boolean;
  message?: string;
  error?: string;
}

export interface GroupMemberRawItem {
  group_id: number;
  user_id: number | string;
  nickname: string;
  card?: string;
  sex?: string;
  age?: number;
  area?: string;
  level?: string;
  qq_level?: number;
  join_time: number;
  last_sent_time: number;
  title_expire_time?: number;
  unfriendly?: boolean;
  card_changeable?: boolean;
  is_robot?: boolean;
  shut_up_timestamp?: number;
  role: 'owner' | 'admin' | 'member';
  title?: string;
  [key: string]: unknown;
}

export interface QueryGroupMemberParams {
  /** 目标群号 (可选，若显式传入则直接查询该群成员；在私聊中查询必须显式传入此参数) */
  group_id?: string | number;
  /** 目标成员的 QQ 号（精确匹配） */
  user_id?: string;
  /** 目标成员的昵称或群名片模糊搜索关键词 */
  query?: string;
  /** 按群身份角色筛选 ('owner' 群主, 'admin' 管理员, 'member' 普通成员, 'all' 全部) */
  role?: 'owner' | 'admin' | 'member' | 'all';
  /** 是否强制穿透缓存刷新群成员数据 (默认 false) */
  no_cache?: boolean;
  /** 起始序号偏移，从 0 开始 (默认 0) */
  offset?: number;
  /** 单次返回数量 (默认 20，范围 1~50) */
  limit?: number;
}

export interface FormattedGroupMember {
  user_id: string;
  display_name: string;
  nickname: string;
  card: string;
  role: string;
  title: string;
  join_time: string;
  last_sent_time: string;
  level: string;
  status: string;
  is_robot: boolean;
}

export interface QueryGroupMemberResult {
  success: boolean;
  group_id?: string | number;
  members: FormattedGroupMember[];
  total: number;
  total_matched?: number;
  offset?: number;
  limit?: number;
  has_more?: boolean;
  error?: string;
  message?: string;
}

export interface ListActiveAgentsParams {
  target_type?: 'user' | 'group';
  /** 起始序号偏移，从 0 开始 (默认 0) */
  offset?: number;
  /** 单次返回数量 (默认 20，范围 1~50) */
  limit?: number;
}

export interface ActiveAgentInfo {
  session_id: string;
  peer: string;
  target_type: 'user' | 'group';
  target_id: string;
  is_busy: boolean;
  name?: string;
}

export interface ListActiveAgentsResult {
  success: boolean;
  agents: ActiveAgentInfo[];
  /** 本次实际返回条数 */
  total: number;
  /** 过滤后匹配的总条数 */
  total_matched: number;
  offset: number;
  limit: number;
  has_more: boolean;
  message?: string;
  error?: string;
}

/**
 * 创建/激活目标 Agent 的参数。
 * target_type 必须显式声明，避免把群号误当作 QQ 号建成私聊会话。
 */
export interface CreateTargetAgentParams {
  target_type: 'user' | 'group';
  target_id: string | number;
  initial_message: string;
}

export interface CreateTargetAgentResult {
  success: boolean;
  created?: boolean;
  session_id?: string;
  peer?: string;
  target_type?: 'user' | 'group';
  target_id?: string;
  message?: string;
  error?: string;
}

export interface SendAgentMessageParams {
  target_session_id: string;
  message: string;
}

export interface SendAgentMessageResult {
  success: boolean;
  delivered?: boolean;
  target_session_id?: string;
  message?: string;
  error?: string;
}
