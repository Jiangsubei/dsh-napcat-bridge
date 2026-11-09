/**
 * dsh-napcat-bridge: Agent 工具入参、出参及执行结果 Schema
 */

import type {
  MessageSource,
  RecurringRule,
  ScheduledTaskStatus,
  ScheduledTaskType,
  SlangEntry,
  FaceSummaryItem,
} from './storage.js';

// ==================== 1. 聊天历史与群文件检索 ====================

export interface ReadChatHistoryParams {
  /** 可选目标会话 peer (如 "group_8000000001" 或 "user_1000000001")，缺省时默认为当前会话 */
  peer?: string;
  /** 按指定发送者 QQ 号精确筛选 */
  user_id?: string;
  /** 按发送者昵称/群名片模糊匹配 (SQL LIKE %sender_name%) */
  sender_name?: string;
  /** 按消息内容关键词模糊匹配 (SQL LIKE %keyword%) */
  keyword?: string;
  /**
   * 按消息类型筛选，支持单类型或类型数组:
   * 'text' | 'image' | 'sticker' | 'file' | 'group_file' | 'forward' | 'record' | 'video' | 'poke' | 'reply' | 'emoji_like'
   */
  type?: string | string[];
  /** 起始时间: 支持毫秒数字、秒级数字、相对时间字符串 ("30m", "2h", "1d", "7d")、裸时间 ("19:00", "19:00:00") 或日期时间字符串 ("10-30 19:00", "2026-10-30 12:00:00") */
  since?: number | string;
  /** 截止时间: 支持毫秒数字、秒级数字、相对时间字符串、裸时间 ("20:00") 或日期时间字符串 */
  until?: number | string;
  /** 快捷相对时间窗口: 检索过去指定时间段内的消息 (如 "1h", "6h", "1d", "7d")，等效于 since = now - relative */
  relative?: string;
  /** 是否仅筛选带有文件/图片/多媒体附件的消息 (local_path 或 file_id 不为空) */
  has_file?: boolean;
  /** 查询指定 msg_id 消息的直接回复消息 (reply_to = ?) */
  reply_to?: number | string;
  /** 是否排除机器人自己发出的消息 (self = 0) */
  exclude_self?: boolean;
  /** 是否仅查询机器人自己发出的消息 (self = 1) */
  self_only?: boolean;
  /**
   * 按消息来源筛选: 'qq' = 真实 QQ 消息；'agent' = Agent 内部协同通讯；
   * 'all' = 不过滤（两者都返回）。缺省按 'qq' 处理（历史查询默认不展示内部通讯）。
   */
  source?: MessageSource | 'all' | Array<MessageSource | 'all'>;
  /** 起始序号偏移，从 0 开始 (默认 0) */
  offset?: number;
  /** 返回最大条数 (默认 20，上限 100) */
  limit?: number;
  /** 时间排序 (默认 'desc' 倒序，取最新消息) */
  order?: 'asc' | 'desc';
}

export interface ChatMessageSummary {
  msg_id: number;
  user_id: string;
  sender_name: string;
  time: number;
  formatted_time?: string;
  type: string;
  content: string;
  recalled: boolean;
  self: boolean;
  reply_to?: number | null;
  local_path?: string | null;
  file_id?: string | null;
  /** 统一附件描述符 JSON（与 MessageRecord.attachments 同源） */
  attachments?: string | null;
  /** 消息来源: 'qq' | 'agent' */
  source?: MessageSource;
}

export interface ReadChatHistoryResult {
  messages: ChatMessageSummary[];
  /** 本次实际返回条数 */
  total: number;
  /** 过滤后匹配的总条数 */
  total_matched: number;
  offset: number;
  limit: number;
  has_more: boolean;
  message?: string;
}

export interface ListGroupFilesParams {
  /** 按群文件名模糊搜索（如 ".pdf", "周报"） */
  file_name?: string;
  /** 按上传者昵称或群名片模糊搜索 */
  sender_name?: string;
  /** 按上传者 QQ 号精确筛选 */
  user_id?: string;
  /** 起始时间: 支持毫秒数字、秒级数字、相对时间 ("7d") 或日期时间字符串 */
  since?: number | string;
  /** 截止时间: 支持毫秒数字、秒级数字、相对时间或日期时间字符串 */
  until?: number | string;
  /** 起始序号偏移，从 0 开始 (默认 0) */
  offset?: number;
  /** 返回最大条数 (默认 20，上限 100) */
  limit?: number;
  /** 时间排序 (默认 'desc' 倒序，取最新上传的文件) */
  order?: 'asc' | 'desc';
}

export interface GroupFileInfo {
  msg_id: number;
  file_id: string;
  file_name: string;
  busid: number;
  sender_name: string;
  user_id: string;
  time: number;
  formatted_time: string;
  size?: number;
}

export interface ListGroupFilesResult {
  success?: boolean;
  files: GroupFileInfo[];
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

// ==================== 2. 资源下载与合并转发展开 ====================

export interface FetchResourceItem {
  file_id: string;
  busid?: number;
  file_name?: string;
}

export interface FetchChatResourceItemResult {
  file_id: string;
  file_name?: string;
  busid?: number;
  success: boolean;
  local_path?: string;
  error?: string;
}

export interface FetchChatResourceParams {
  file_id?: string;
  busid?: number;
  file_name?: string;
  files?: FetchResourceItem[];
}

export interface FetchChatResourceResult {
  success: boolean;
  local_path?: string;
  error?: string;
  total?: number;
  downloaded_count?: number;
  results?: FetchChatResourceItemResult[];
}

export interface ExpandForwardMessageParams {
  forward_id: string;
}

export interface ForwardNode {
  sender_name: string;
  user_id: string;
  time: number;
  content: string;
}

export interface ExpandForwardMessageResult {
  success: boolean;
  messages?: ForwardNode[];
  /** FC-1: 本次展开中成功落盘的内层图片数量（缺省表示无新增落盘） */
  images_downloaded?: number;
  error?: string;
}

// ==================== 3. 消息/文件发送与轻量互动 ====================

export interface SendFileParams {
  file_path: string;
  file_type?: 'image' | 'file';
}

export interface SendFileResult {
  success: boolean;
  message_id?: number;
  error?: string;
}

export interface SendQqMessageParams {
  text: string;
  reply_to?: number | string;
  at_user?: string | number;
}

export interface SendQqMessageResult {
  success: boolean;
  message_id?: number;
  error?: string;
  sent_preview?: string;
}

export interface PokeUserParams {
  user_id: string;
}

export interface PokeUserResult {
  success: boolean;
  error?: string;
}

export interface WaitForUserMessagesParams {
  timeout?: number;
  user_id?: string;
}

export interface ReactMessageParams {
  /** 表情语义键（对应 QQ 群消息回应表情） */
  emoji: string;
  /** 要回应的目标消息 ID。可省略，省略时自动绑定当前回合正在回复的入站消息 */
  message_id?: number | string;
}

export interface ReactMessageResult {
  success: boolean;
  message_id?: number;
  emoji?: string;
  emoji_id?: string;
  error?: string;
}

// ==================== 4. 表情包工具 ====================

export interface ListFacesParams {
  query?: string;
  tag?: string;
  mood?: string;
  untagged?: boolean;
  offset?: number;
  limit?: number;
}

export interface ListFacesResult {
  faces: FaceSummaryItem[];
  /** 本次实际返回条数 */
  total: number;
  /** 过滤后匹配的总条数 */
  total_matched: number;
  offset: number;
  limit: number;
  has_more: boolean;
  message?: string;
}

export interface SendFaceParams {
  face_id: string;
}

export interface SendFaceResult {
  success: boolean;
  message_id?: number;
  error?: string;
}

export interface CollectFaceParams {
  tags: string[];
  mood: string;
  message_id?: number | string;
}

export interface CollectFaceResult {
  success: boolean;
  duplicated?: boolean;
  face_id?: string;
  message?: string;
  error?: string;
}

export interface ManageFacesParams {
  action: 'update' | 'delete' | 'query_quota' | 'evict';
  face_id?: string;
  tags?: string[];
  mood?: string;
  count?: number;
}

export interface ManageFacesResult {
  success: boolean;
  action?: 'update' | 'delete' | 'query_quota' | 'evict';
  face_id?: string;
  total?: number;
  max_quota?: number;
  available?: number;
  total_bytes?: number;
  evicted_count?: number;
  message?: string;
  error?: string;
}

// ==================== 5. 定时任务工具 ====================

export interface ScheduleTaskParams {
  prompt: string;
  delay_seconds?: number;
  execute_at?: string;
  recurring?: RecurringRule;
}

export interface ScheduleTaskResult {
  [key: string]: any;
  success: boolean;
  task_id?: string;
  next_run_at?: number;
  formatted_next_run?: string;
  rule_description?: string;
  error?: string;
}

export interface ManageScheduledTasksParams {
  action: 'list' | 'cancel' | 'update';
  task_id?: string;
  prompt?: string;
  delay_seconds?: number;
  execute_at?: string;
  recurring?: RecurringRule;
}

export interface ScheduledTaskSummary {
  id: string;
  peer: string;
  creator: string;
  prompt: string;
  type: ScheduledTaskType;
  next_run_at: number;
  formatted_next_run: string;
  rule_description: string;
  status: ScheduledTaskStatus;
}

export interface ManageScheduledTasksResult {
  [key: string]: any;
  success: boolean;
  action: 'list' | 'cancel' | 'update';
  tasks?: ScheduledTaskSummary[];
  task?: ScheduledTaskSummary;
  error?: string;
}

// ==================== 6. 黑话工具 ====================

export interface QuerySlangParams {
  term: string;
}

export interface QuerySlangResult {
  [key: string]: any;
  success: boolean;
  entry?: SlangEntry;
  message?: string;
  error?: string;
}

export interface RecordSlangParams {
  term: string;
  tags: string;
  definition: string;
  example: string;
}

export interface RecordSlangResult {
  [key: string]: any;
  success: boolean;
  entry?: SlangEntry;
  action: 'created' | 'updated';
  total: number;
  max_entries: number;
  evicted_term?: string;
  message?: string;
  error?: string;
}

export interface ManageSlangParams {
  action: 'list' | 'edit' | 'delete';
  term?: string;
  new_term?: string;
  tags?: string;
  definition?: string;
  example?: string;
  keyword?: string;
  offset?: number;
  limit?: number;
}

export interface ManageSlangResult {
  [key: string]: any;
  success: boolean;
  action: 'list' | 'edit' | 'delete';
  entries?: SlangEntry[];
  entry?: SlangEntry;
  total?: number;
  total_matched?: number;
  offset?: number;
  limit?: number;
  has_more?: boolean;
  max_entries?: number;
  message?: string;
  error?: string;
}

// ==================== 7. QQ 空间动态互动契约 ====================

export interface QzoneImageItem {
  url: string;
  local_path?: string;
}

export interface QzoneCommentItem {
  comment_id?: string;
  author: {
    user_id: number;
    nickname: string;
  };
  content: string;
  create_time?: string;
  is_self: boolean;
}

export interface QzoneFeedItem {
  feed_id: string;
  author: {
    user_id: number;
    nickname: string;
  };
  publish_time: string;
  content: string;
  images: QzoneImageItem[];
  comments: QzoneCommentItem[];
  total_comment_count: number;
  like_count?: number;
}

export interface ReadQzoneFeedsParams {
  scope?: 'friends' | 'self' | 'user';
  target_qq?: string | number;
  limit?: number;
  offset?: number;
  cursor?: string;
  after_feed_id?: string;
}

export interface ReadQzoneFeedsResult {
  [key: string]: any;
  success: boolean;
  scope: 'friends' | 'self' | 'user';
  feeds: QzoneFeedItem[];
  has_more: boolean;
  next_cursor?: string;
  message?: string;
}

export interface PublishQzoneFeedParams {
  content: string;
  images?: string[];
}

export interface PublishQzoneFeedResult {
  [key: string]: any;
  success: boolean;
  feed_id?: string;
  message: string;
}

export interface CommentQzoneFeedParams {
  feed_id: string;
  target_qq: string | number;
  content: string;
}

export interface CommentQzoneFeedResult {
  [key: string]: any;
  success: boolean;
  comment_id?: string;
  message: string;
}

export interface DeleteQzoneFeedParams {
  feed_id: string;
}

export interface DeleteQzoneFeedResult {
  [key: string]: any;
  success: boolean;
  feed_id?: string;
  message: string;
}
