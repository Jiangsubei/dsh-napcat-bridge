/**
 * dsh-napcat-bridge: SQLite 持久化表契约与存储模型
 */

/** 消息来源：qq = 真实 QQ 收发；agent = Agent 内部协同通讯（QQ 用户不可见） */
export type MessageSource = 'qq' | 'agent';

export interface MessageRecord {
  msg_id: number;
  peer: string;
  user_id: string;
  sender_name: string;
  time: number; // 毫秒时间戳
  type: string;
  content: string;
  raw: string; // 原始 JSON 字符串
  file_id: string | null;
  busid: number | null;
  local_path: string | null;
  fingerprint: string | null;
  recalled: number; // 0 | 1
  self: number; // 0 | 1
  reply_to: number | null;
  /** 消息来源，缺省视为 'qq'（存量数据同值） */
  source?: MessageSource;
  /** 统一附件描述符 JSON（精简数组，不含原始段；raw 已保存原始段） */
  attachments?: string | null;
}

export interface FaceRecord {
  id: string;
  file_path: string;
  md5: string;
  added_at: number;
  source: 'curate' | 'manual' | 'collect';
  tags: string[];
  mood?: string;
  enabled: boolean;
  size: number;
  format: string; // 'png' | 'jpg' | 'gif' | 'webp'
  last_used_at?: number;
  use_count: number;
  deleted_at?: number | null; // 软删除时间戳（7 天后悔期保留），null/undefined 表示活跃
}

export interface FaceMoodSummary {
  total: number;
  moods: Array<{ mood: string; count: number }>;
}

export interface FaceQueryOptions {
  query?: string;
  tag?: string;
  mood?: string;
  untagged?: boolean;
  enabledOnly?: boolean;
  includeDeleted?: boolean;
  limit?: number;
  offset?: number;
  cursor?: string;
  orderBy?: 'added_at' | 'last_used_at' | 'use_count';
  order?: 'asc' | 'desc';
}

export interface FaceSummaryItem {
  id: string;
  tags: string[];
  mood?: string;
  format: string;
  file_path?: string;
}

export type ScheduledTaskStatus = 'pending' | 'completed' | 'cancelled';
export type ScheduledTaskType = 'once' | 'recurring';
export type RecurringFrequency = 'daily' | 'weekdays' | 'weekends' | 'custom';

export interface RecurringRule {
  frequency: RecurringFrequency;
  /** 每日触发时间点，格式 HH:mm，如 '09:30' */
  time_of_day?: string;
  /** 自定义星期几：1=周一, 7=周日 */
  days_of_week?: number[];
}

export interface ScheduledTaskRecord {
  id: string;
  peer: string;
  creator: string;
  prompt: string;
  type: ScheduledTaskType;
  recurring_rule?: RecurringRule | null;
  next_run_at: number; // 毫秒时间戳
  status: ScheduledTaskStatus;
  created_at: number;
  updated_at: number;
}

export interface SlangEntry {
  id?: number;
  term: string;
  tags?: string;
  definition: string;
  example?: string;
  query_count?: number;
  last_queried_at?: number | null;
  created_at?: number;
  updated_at?: number;
}

export interface SessionStateRecord {
  peer: string;
  current_session_id: string;
  cleared_round: number;
  cleared_version: number;
  updated_at: number;
  model_provider?: string;
  model_name?: string;
  model_reasoning_effort?: string;
}
