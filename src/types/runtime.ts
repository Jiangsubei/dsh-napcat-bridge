/**
 * dsh-napcat-bridge: 运行时出站队列与入站上下文契约
 */

/**
 * 触发一次唤醒的入站消息上下文 (Spec §7.1 / 决策 A)
 * 供出方向透传 @提问者 与 引用原消息 原始凭据。
 */
export interface InboundReplyContext {
  /** 唤醒源消息的 message_id (用于 CQ:reply 引用) */
  msg_id: number;
  /** 提问者 QQ 号 (用于 CQ:at) */
  from_user: string;
  /** 是否为群聊消息 (私聊不 @ 不引用) */
  is_group: boolean;
}

/**
 * Shared per-peer 串行发送器契约 (Spec §7.3)
 * 正文、提问、审批、主动发文件均须经同一串行队列下发，保证同 peer 内发送顺序。
 */
export interface SerialSender {
  enqueue<T>(peer: string, task: () => Promise<T>): Promise<T>;
}
