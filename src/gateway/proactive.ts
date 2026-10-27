/**
 * dsh-napcat-bridge: 群聊主动回复管理器 (Proactive Manager)
 * 管理群聊窗口期新消息聚合轮询、潜水超时定时巡检、夜间免打扰判定与防死循环。
 */

import type { BridgePluginConfig, WakeupPayload } from '../types/index.js';

export interface BufferedGroupMessage {
  timestamp: number;
  from_user: string;
  from_name: string;
  content: string;
  msg_id?: number;
  isTextOnly?: boolean;
}

export interface ProactiveCheckOptions {
  config: BridgePluginConfig;
  dispatchWakeup: (payload: WakeupPayload) => Promise<void>;
  isSessionBusy?: (peer: string) => boolean;
  now?: number;
  knownPeers?: () => string[];
}

export type IdleCheckOptions = ProactiveCheckOptions;

export class ProactiveManager {
  private humanMessageTimes = new Map<string, number>();
  private lastProactiveTimes = new Map<string, number>();
  private idleTriggered = new Set<string>();
  private bufferedMessages = new Map<string, BufferedGroupMessage[]>();
  private timer: NodeJS.Timeout | null = null;

  /**
   * 记录群聊接收到人类消息（self: 0）的时间戳
   * 收到新人类发言时，自动重置潜水单周期防死循环标记
   */
  recordHumanMessage(peer: string, timestamp = Date.now()): void {
    this.humanMessageTimes.set(peer, timestamp);
    this.idleTriggered.delete(peer);
  }

  /**
   * 收集并缓冲群聊普通消息
   */
  recordGroupMessage(
    peer: string,
    msg: BufferedGroupMessage,
    config: BridgePluginConfig
  ): void {
    if (!config.proactive_reply_enabled) {
      return;
    }
    if (config.proactive_only_text && msg.isTextOnly === false) {
      return;
    }

    this.recordHumanMessage(peer, msg.timestamp);

    const list = this.bufferedMessages.get(peer) || [];
    list.push(msg);
    // 单群最多保留 50 条最近消息，防止内存堆积
    if (list.length > 50) {
      list.splice(0, list.length - 50);
    }
    this.bufferedMessages.set(peer, list);
  }

  /**
   * 获取某群当前积攒的待读消息列表
   */
  getBufferedMessages(peer: string): BufferedGroupMessage[] {
    return this.bufferedMessages.get(peer) || [];
  }

  /**
   * 清空某群待读消息缓冲池
   */
  clearBufferedMessages(peer: string): void {
    this.bufferedMessages.delete(peer);
  }

  /**
   * 获取某群最后一次人类消息的时间戳
   */
  getHumanMessageTime(peer: string): number | undefined {
    return this.humanMessageTimes.get(peer);
  }

  /**
   * 记录某群触发了一次主动回复
   */
  recordProactiveReply(peer: string, timestamp = Date.now()): void {
    this.lastProactiveTimes.set(peer, timestamp);
  }

  /**
   * 判断某群当前是否处于主动回复冷却期（Cooldown）
   */
  isCooldown(peer: string, cooldownMins = 10, now = Date.now()): boolean {
    if (cooldownMins <= 0) return false;
    const lastTime = this.lastProactiveTimes.get(peer);
    if (!lastTime) return false;
    const cooldownMs = cooldownMins * 60 * 1000;
    return now - lastTime < cooldownMs;
  }

  /**
   * 判断当前时间是否处于夜间免打扰时段 (每日 23:00 ~ 08:00)
   */
  isNightDnd(now = Date.now()): boolean {
    const d = new Date(now);
    const hour = d.getHours();
    return hour >= 23 || hour < 8;
  }

  /**
   * 群聊主动回复与潜水超时集中巡检
   */
  async checkProactiveGroups(options: ProactiveCheckOptions): Promise<void> {
    const { config, dispatchWakeup } = options;
    const now = options.now ?? Date.now();

    // 1. 总控校验
    if (!config.proactive_reply_enabled) {
      return;
    }

    // 2. 夜间免打扰校验 (23:00~08:00)
    if (config.proactive_night_dnd !== false && this.isNightDnd(now)) {
      return;
    }

    // 3. 收集所有待检测的群 peer
    const peersToCheck = new Set<string>();
    for (const peer of this.humanMessageTimes.keys()) {
      peersToCheck.add(peer);
    }
    for (const peer of this.bufferedMessages.keys()) {
      peersToCheck.add(peer);
    }
    if (typeof options.knownPeers === 'function') {
      const extra = options.knownPeers();
      if (Array.isArray(extra)) {
        for (const p of extra) {
          if (p.startsWith('group_') || p.startsWith('qq-group-')) {
            peersToCheck.add(p);
          }
        }
      }
    }

    // 4. 逐群检测
    for (const peer of peersToCheck) {
      // 4.1 Busy 态检测：若 Agent 处于 Busy 态（比如有正在运行的 ReAct 循环或未完成的任务），直接丢弃本轮主动唤醒
      if (options.isSessionBusy?.(peer)) {
        this.clearBufferedMessages(peer);
        continue;
      }

      // 4.2 潜水超时唤醒判定
      const lastHumanTime = this.humanMessageTimes.get(peer);
      const idleEnabled = Boolean(config.proactive_idle_enabled);
      const timeoutMins = config.proactive_idle_timeout_mins ?? 120;
      const timeoutMs = timeoutMins * 60 * 1000;

      if (
        idleEnabled &&
        timeoutMins > 0 &&
        lastHumanTime &&
        now - lastHumanTime >= timeoutMs
      ) {
        if (!this.idleTriggered.has(peer)) {
          this.idleTriggered.add(peer);
          this.recordProactiveReply(peer, now);
          this.clearBufferedMessages(peer);

          const payload: WakeupPayload = {
            trigger: 'proactive',
            sub_trigger: 'idle',
            peer,
            from_user: '',
            from_name: '',
            content: '',
            timestamp: now,
          };

          try {
            await dispatchWakeup(payload);
          } catch {}
          continue;
        }
      }

      // 4.3 窗口期新消息聚合唤醒判定
      const buffered = this.bufferedMessages.get(peer);
      if (buffered && buffered.length > 0) {
        const messagesToSend = [...buffered];
        this.clearBufferedMessages(peer);
        this.recordProactiveReply(peer, now);

        const payload: WakeupPayload = {
          trigger: 'proactive',
          sub_trigger: 'polling',
          peer,
          from_user: '',
          from_name: '',
          content: '',
          buffered_messages: messagesToSend,
          timestamp: now,
        };

        try {
          await dispatchWakeup(payload);
        } catch {}
      }
    }
  }

  /**
   * 兼容方法：旧版潜水超时群聊集中巡检
   */
  async checkIdleGroups(options: IdleCheckOptions): Promise<void> {
    return this.checkProactiveGroups(options);
  }

  /**
   * 启动后台主动回复巡检定时器（每隔 intervalMs 检查一次，默认 60 秒）
   */
  startChecker(
    getOptions: () => ProactiveCheckOptions,
    intervalMs = 60000
  ): void {
    this.stopChecker();
    this.timer = setInterval(async () => {
      try {
        const opts = getOptions();
        await this.checkProactiveGroups(opts);
      } catch {}
    }, intervalMs);
    if (this.timer.unref) {
      this.timer.unref();
    }
  }

  /**
   * 兼容方法：启动后台潜水巡检定时器
   */
  startIdleChecker(
    getOptions: () => IdleCheckOptions,
    intervalMs = 60000
  ): void {
    this.startChecker(getOptions, intervalMs);
  }

  /**
   * 停止后台巡检定时器
   */
  stopChecker(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * 兼容方法：停止潜水定时器
   */
  stopIdleChecker(): void {
    this.stopChecker();
  }

  /**
   * 清理所有内存状态
   */
  dispose(): void {
    this.stopChecker();
    this.humanMessageTimes.clear();
    this.lastProactiveTimes.clear();
    this.idleTriggered.clear();
    this.bufferedMessages.clear();
  }
}
