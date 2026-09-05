/**
 * dsh-napcat-bridge: 群聊主动回复管理器 (Proactive Manager)
 * 管理群聊主动回复的全局/Per-Group 冷却时间、夜间免打扰判定、
 * 人类发言时间戳跟踪、潜水超时定时巡检与单周期防死循环标记。
 */

import type { BridgePluginConfig, WakeupPayload } from '../types/index.js';

export interface IdleCheckOptions {
  config: BridgePluginConfig;
  dispatchWakeup: (payload: WakeupPayload) => Promise<void>;
  now?: number;
  knownPeers?: () => string[];
}

export class ProactiveManager {
  private humanMessageTimes = new Map<string, number>();
  private lastProactiveTimes = new Map<string, number>();
  private idleTriggered = new Set<string>();
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
   * 获取某群最后一次人类消息的时间戳
   */
  getHumanMessageTime(peer: string): number | undefined {
    return this.humanMessageTimes.get(peer);
  }

  /**
   * 记录某群触发了一次主动回复（无论是概率插话还是潜水超时冒泡）
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
   * 潜水超时群聊集中巡检
   */
  async checkIdleGroups(options: IdleCheckOptions): Promise<void> {
    const { config, dispatchWakeup } = options;
    const now = options.now ?? Date.now();

    // 1. 总控与潜水子开关校验
    if (!config.proactive_reply_enabled || !config.proactive_idle_enabled) {
      return;
    }

    // 2. 夜间免打扰校验
    if (config.proactive_night_dnd !== false && this.isNightDnd(now)) {
      return;
    }

    const timeoutMins = config.proactive_idle_timeout_mins ?? 120;
    if (timeoutMins <= 0) {
      return; // 0 代表不限制/不启用潜水
    }
    const timeoutMs = timeoutMins * 60 * 1000;
    const cooldownMins = config.proactive_cooldown_mins ?? 10;

    // 3. 收集所有待检测的群 peer
    const peersToCheck = new Set<string>();
    for (const peer of this.humanMessageTimes.keys()) {
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
      // 潜水防死循环：当前周期已冒泡过且无新人类发言，跳过
      if (this.idleTriggered.has(peer)) {
        continue;
      }

      // 冷却期检查
      if (this.isCooldown(peer, cooldownMins, now)) {
        continue;
      }

      const lastHumanTime = this.humanMessageTimes.get(peer);
      if (!lastHumanTime) {
        continue;
      }

      if (now - lastHumanTime >= timeoutMs) {
        // 标记已触发潜水冒泡，并记录主动回复时间
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
      }
    }
  }

  /**
   * 启动后台潜水巡检定时器（每隔 intervalMs 检查一次，默认 60 秒）
   */
  startIdleChecker(
    getOptions: () => {
      config: BridgePluginConfig;
      dispatchWakeup: (payload: WakeupPayload) => Promise<void>;
      knownPeers?: () => string[];
    },
    intervalMs = 60000
  ): void {
    this.stopIdleChecker();
    this.timer = setInterval(async () => {
      try {
        const opts = getOptions();
        await this.checkIdleGroups(opts);
      } catch {}
    }, intervalMs);
    if (this.timer.unref) {
      this.timer.unref();
    }
  }

  /**
   * 停止后台巡检定时器
   */
  stopIdleChecker(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * 清理所有内存状态
   */
  dispose(): void {
    this.stopIdleChecker();
    this.humanMessageTimes.clear();
    this.lastProactiveTimes.clear();
    this.idleTriggered.clear();
  }
}
