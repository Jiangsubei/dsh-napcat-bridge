/**
 * dsh-napcat-bridge: 系统内部事件与统一唤醒领域模型契约
 * 
 * 严格区隔“外部真实用户输入”与“系统内部合成/触发事件”，从类型定义层面杜绝：
 * 1. 虚假系统名称进入 from_name 导致会话标题污染；
 * 2. 系统事件携带虚假 from_user 导致特权审批漏洞；
 * 3. 散装弱类型 Payload 导致的提示词格式脱节与出站上下文追踪失效。
 */

/** 系统事件类型辨识标签 */
export type SystemEventKind =
  | 'scheduled_task'    // 定时任务触发
  | 'agent_ipc'          // 跨 Agent 内部协作
  | 'proactive_lurk'     // 潜水超时唤醒 (idle)
  | 'proactive_polling'  // 主动回复未读消息聚合 (polling)
  | 'synthetic_notice';  // 协议通知合成事件 (如 poke)

/** 定时任务系统事件 */
export interface ScheduledTaskEvent {
  kind: 'scheduled_task';
  peer: string;
  taskId: string;
  taskType: 'once' | 'recurring';
  taskRule?: string;
  prompt: string;
  /** 任务创建者（仅作审计/日志用途，严禁充当当轮唤醒发起人） */
  creator?: string;
  timestamp?: number;
}

/** 跨 Agent IPC 协同事件 */
export interface AgentIpcEvent {
  kind: 'agent_ipc';
  targetPeer: string;
  fromSessionId: string;
  message: string;
  /** 是否为首次创建目标 Agent 注入的初始使命 */
  isInitialDirective?: boolean;
  timestamp?: number;
}

/** 潜水超时唤醒事件 */
export interface ProactiveLurkEvent {
  kind: 'proactive_lurk';
  peer: string;
  /** 连续无发言空闲时长（分钟），默认 120 */
  idleDurationMinutes?: number;
  timestamp?: number;
}

/** 主动关注未读聚合事件 */
export interface ProactivePollingEvent {
  kind: 'proactive_polling';
  peer: string;
  bufferedMessages: Array<{
    timestamp: number;
    from_user: string;
    from_name: string;
    content: string;
    msg_id?: number;
    replied?: boolean;
  }>;
  timestamp?: number;
}

/** 系统通知合成事件 (如戳一戳等非真实文本输入交互) */
export interface SyntheticNoticeEvent {
  kind: 'synthetic_notice';
  peer: string;
  noticeType: 'poke';
  operatorUser?: string;
  operatorName?: string;
  timestamp?: number;
}

/** 全量系统事件可辨识联合体 (Discriminated Union) */
export type SystemWakeupEvent =
  | ScheduledTaskEvent
  | AgentIpcEvent
  | ProactiveLurkEvent
  | ProactivePollingEvent
  | SyntheticNoticeEvent;
