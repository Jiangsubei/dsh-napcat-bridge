/**
 * dsh-napcat-bridge: 会话级消息并发等待收集器
 * 专供 Agent 工具 wait_for_user_messages 挂起等待并收集入站消息。
 */

/**
 * EN-005: 等待收集的一条入站消息（字段与唤醒包同源：from 昵称 / user_id QQ /
 * content 归一化文本 / time 毫秒时间戳）
 */
export interface WaitCollectedMessage {
  msg_id?: number;
  from: string;
  user_id: string;
  content: string;
  time: number;
  reply_to?: number | null;
  quoted?: {
    msg_id?: number;
    user_id?: string;
    from_name?: string;
    text?: string;
    images?: string[];
  } | null;
}

/**
 * EN-005: 等待结算结果。
 * - ok:true     → 窗口结束返回已收集消息（纯超时窗口，用户拍板）
 * - timeout     → 状态层报错（0 条消息，不给建议，Agent 自己推理下一步）
 * - cancelled   → Agent 回合取消 / 插件 dispose
 * - wait-active → 同 peer 已有活动等待（防御性拒绝）
 */
export type MessageWaitResult =
  | { ok: true; messages: WaitCollectedMessage[] }
  | { ok: false; error: 'timeout' | 'cancelled' | 'wait-active'; message: string };

export interface ActiveWait {
  peer: string;
  userId?: string;
  messages: WaitCollectedMessage[];
  timer: NodeJS.Timeout;
  settle: (result: MessageWaitResult) => void;
}

/**
 * EN-005: 入站消息等待收集器（一次性消息收集器桥接）。
 * peer 键控（group_* 与 user_*，与 normalizePeer / index.ts 流水线同一键空间）；
 * 纯超时窗口语义：注册起算 timeoutMs 毫秒，到点返回已收集消息，0 条则状态层超时
 * 报错。可通过 AbortSignal 取消（Agent 回合中断）。单线程事件循环内注册/投递/结算
 * 同步串行，无撕裂窗口。
 */
export class MessageWaitRegistry {
  private waits = new Map<string, ActiveWait>();

  /**
   * 注册一次性消息收集器并挂起等待。
   * 同 peer 已有活动等待 → wait-active 拒绝（防御：同会话工具串行调用下理论不可达）；
   * 传入已中止的 signal → 立即 cancelled。
   */
  wait(peer: string, opts: { userId?: string; timeoutMs: number; signal?: AbortSignal }): Promise<MessageWaitResult> {
    if (this.waits.has(peer)) {
      return Promise.resolve({
        ok: false,
        error: 'wait-active',
        message: '当前会话已有一个进行中的消息等待，不能重复发起',
      });
    }
    if (opts.signal?.aborted) {
      return Promise.resolve({
        ok: false,
        error: 'cancelled',
        message: '等待已中断（Agent 回合被取消）',
      });
    }

    return new Promise<MessageWaitResult>((resolve) => {
      let settled = false;
      const messages: WaitCollectedMessage[] = [];
      let onAbort: () => void;

      const cleanup = () => {
        clearTimeout(entry.timer);
        if (opts.signal) {
          opts.signal.removeEventListener('abort', onAbort);
        }
        if (this.waits.get(peer) === entry) {
          this.waits.delete(peer);
        }
      };

      const settle = (result: MessageWaitResult) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      };

      onAbort = () => {
        settle({ ok: false, error: 'cancelled', message: '等待已中断（Agent 回合被取消）' });
      };

      const entry: ActiveWait = {
        peer,
        userId: opts.userId,
        messages,
        timer: setTimeout(() => {
          if (messages.length === 0) {
            settle({ ok: false, error: 'timeout', message: 'No messages received within the specified timeout' });
          } else {
            settle({ ok: true, messages });
          }
        }, Math.max(0, opts.timeoutMs)),
        settle,
      };

      if (opts.signal) {
        opts.signal.addEventListener('abort', onAbort, { once: true });
      }
      this.waits.set(peer, entry);
    });
  }

  /** 判活（index.ts 等待门控用，同步、O(1)） */
  isWaiting(peer: string): boolean {
    return this.waits.has(peer);
  }

  /** 尝试投递入站消息；命中（peer + user_id 过滤）并收集 → true，否则 false（不改状态） */
  tryDeliver(peer: string, msg: WaitCollectedMessage): boolean {
    const entry = this.waits.get(peer);
    if (!entry) return false;
    if (entry.userId !== undefined && String(entry.userId) !== String(msg.user_id)) return false;
    entry.messages.push(msg);
    return true;
  }

  /** 插件 dispose：结算全部活动等待为 cancelled（清空收集器，防悬挂 Promise） */
  clear(): void {
    for (const entry of this.waits.values()) {
      entry.settle({ ok: false, error: 'cancelled', message: '等待已中断（Agent 回合被取消）' });
    }
  }
}
