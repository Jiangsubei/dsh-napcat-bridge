/**
 * dsh-napcat-bridge: 唤醒包与会话驱动契约
 */

import type { SystemWakeupEvent } from './system-event.js';

export type WakeupTriggerType = 'at' | 'mention' | 'quote' | 'poke' | 'proactive' | 'scheduled' | 'internal_agent';

export interface WakeupPayload {
  msg_id?: number;
  trigger: WakeupTriggerType | 'direct';
  /** 主动回复触发子类型: random (普通消息概率插话) | idle (潜水超时冒泡) */
  sub_trigger?: 'polling' | 'idle' | 'random';
  /** 聚合的主动关注消息列表 (当 sub_trigger === 'polling' 时提供) */
  buffered_messages?: Array<{
    timestamp: number;
    from_user: string;
    from_name: string;
    content: string;
    msg_id?: number;
    replied?: boolean;
  }>;
  /** 定时任务 ID (当 trigger === 'scheduled' 时提供) */
  task_id?: string;
  /** 定时任务说明/规则描述 (当 trigger === 'scheduled' 时提供) */
  task_rule?: string;
  /** 定时任务类型 (当 trigger === 'scheduled' 时提供) */
  task_type?: 'once' | 'recurring';
  peer: string;
  from_user: string;
  from_name: string;
  content: string;
  quoted?: {
    msg_id: number;
    user_id: string;
    from_name: string;
    text: string;
    images?: string[];
  };
  images?: string[];
  /** 内部 Agent 协作来源会话 ID (当 trigger === 'internal_agent' 时提供) */
  from_session?: string;
  /** 内部 Agent 协作成果回传目标会话 ID (当 trigger === 'internal_agent' 时提供) */
  reply_to_session?: string;
  /** 是否为系统内部生成的事件（定时任务/IPC/主动回复/协议通知等，非真实用户消息） */
  is_system?: boolean;
  /** 对应的强类型系统事件实体（由 SystemEventHub 统一注入） */
  system_event?: SystemWakeupEvent;
  timestamp: number;
}
