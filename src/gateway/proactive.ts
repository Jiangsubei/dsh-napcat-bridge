/**
 * dsh-napcat-bridge: 群聊主动回复管理器 (Proactive Manager)
 * 管理群聊滑动窗口消息队列、Per-Group 观测计时重置、潜水超时定时巡检、夜间免打扰与已审阅标记流转。
 */

import type { BridgePluginConfig, WakeupPayload } from '../types/index.js';

export interface WindowGroupMessage {
  timestamp: number;
  from_user: string;
  from_name: string;
  content: string;
  msg_id?: number;
  replied: boolean;
  isTextOnly?: boolean;
}

export type BufferedGroupMessage = WindowGroupMessage;

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
  private windowMessages = new Map<string, WindowGroupMessage[]>();
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
   * 收集并存入群聊普通消息到滑动窗口队列
   */
  recordGroupMessage(
    peer: string,
    msg: Omit<WindowGroupMessage, 'replied'>,
    config: BridgePluginConfig
  ): void {
    if (!config.proactive_reply_enabled) {
      return;
    }
    if (config.proactive_only_text && msg.isTextOnly === false) {
      return;
    }

    this.recordHumanMessage(peer, msg.timestamp);

    const list = this.windowMessages.get(peer) || [];
    list.push({
      ...msg,
      replied: false,
    });

    const maxLimit = Math.max(1, config.proactive_buffer_size ?? 10);
    while (list.length > maxLimit) {
      list.shift();
    }
    this.windowMessages.set(peer, list);
  }

  /**
   * 记录发生了一次即时直接唤醒 (如 @、戳一戳、引用)
   * 顺延/重置该群的主动回复观测计时，并将直接唤醒消息标记为 replied: true 存入滑动窗口
   */
  recordDirectWakeup(
    peer: string,
    timestamp = Date.now(),
    msg?: { from_user: string; from_name: string; content: string; msg_id?: number }
  ): void {
    this.recordHumanMessage(peer, timestamp);
    this.lastProactiveTimes.set(peer, timestamp);

    if (msg) {
      const list = this.windowMessages.get(peer) || [];
      list.push({
        ...msg,
        timestamp,
        replied: true,
      });
      const maxLimit = 10;
      while (list.length > maxLimit) {
        list.shift();
      }
      this.windowMessages.set(peer, list);
    }
  }

  /**
   * 获取某群当前滑动窗口中的消息列表
   */
  getWindowMessages(peer: string): WindowGroupMessage[] {
    return this.windowMessages.get(peer) || [];
  }

  /**
   * 兼容方法：获取缓冲池消息
   */
  getBufferedMessages(peer: string): WindowGroupMessage[] {
    return this.getWindowMessages(peer);
  }

  /**
   * 清空某群消息队列
   */
  clearBufferedMessages(peer: string): void {
    this.windowMessages.delete(peer);
  }

  /**
   * 获取某群最后一次人类消息的时间戳
   */
  getHumanMessageTime(peer: string): number | undefined {
    return this.humanMessageTimes.get(peer);
  }

  /**
   * 记录某群触发了一次主动回复并重置该群计时
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
    for (const peer of this.windowMessages.keys()) {
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
      // 4.1 Busy 态检测：若 Agent 处于 Busy 态，保留消息队列流转，跳过本轮避免冲突
      if (options.isSessionBusy?.(peer)) {
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

      // 4.3 Per-Group 观测计时检查
      const intervalMins = config.proactive_interval_mins ?? 3;
      const intervalMs = intervalMins * 60 * 1000;
      const lastTrigger = this.lastProactiveTimes.get(peer);
      if (intervalMs > 0 && lastTrigger && now - lastTrigger < intervalMs) {
        continue;
      }

      // 4.4 滑动窗口未回复消息聚合判定
      const list = this.windowMessages.get(peer) || [];
      const unreplied = list.filter((m) => !m.replied);

      if (unreplied.length > 0) {
        // 关键流转：将未回复消息标记为已审阅
        for (const m of list) {
          m.replied = true;
        }
        this.recordProactiveReply(peer, now);

        const payload: WakeupPayload = {
          trigger: 'proactive',
          sub_trigger: 'polling',
          peer,
          from_user: '',
          from_name: '',
          content: '',
          buffered_messages: [...unreplied],
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
    this.windowMessages.clear();
  }
}
