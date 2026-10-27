/**
 * dsh-napcat-bridge: 定时任务与周期调度引擎 (Task Scheduler Engine)
 * 负责任务的 Fail-Fast 校验、夜间 DND 拦截、生命周期持久化与精准唤醒分发。
 */

import type { MessageDatabase } from '../storage/database.js';
import { formatDateTime } from '../storage/database.js';
import type {
  BridgePluginConfig,
  ScheduledTaskRecord,
  ScheduledTaskType,
  RecurringRule,
  ScheduleTaskParams,
  ScheduleTaskResult,
  ManageScheduledTasksParams,
  ManageScheduledTasksResult,
  ScheduledTaskSummary,
  WakeupPayload,
} from '../types/index.js';

export const MIN_DELAY_SECONDS = 10;
export const MAX_DELAY_SECONDS = 48 * 3600; // 48 小时 = 172800 秒
export const MAX_PENDING_TASKS_PER_PEER = 5;

export interface TaskSchedulerOptions {
  db: MessageDatabase;
  dispatchWakeup: (payload: WakeupPayload) => Promise<void>;
  configGetter?: () => BridgePluginConfig;
  logger?: any;
}

export function formatRuleDescription(task: {
  type: ScheduledTaskType;
  recurring_rule?: RecurringRule | null;
  delay_seconds?: number;
}): string {
  if (task.type === 'once') {
    return '单次任务';
  }
  const rule = task.recurring_rule;
  if (!rule) return '周期任务';
  const time = rule.time_of_day || '09:00';
  switch (rule.frequency) {
    case 'daily':
      return `每天 ${time}`;
    case 'weekdays':
      return `工作日 (周一至周五) ${time}`;
    case 'weekends':
      return `周末 (周六周日) ${time}`;
    case 'custom': {
      const days = (rule.days_of_week || []).map((d) => {
        const map: Record<number, string> = { 1: '一', 2: '二', 3: '三', 4: '四', 5: '五', 6: '六', 7: '日' };
        return `周${map[d] || d}`;
      });
      return `${days.join('、')} ${time}`;
    }
    default:
      return `周期任务 (${time})`;
  }
}

export class TaskScheduler {
  private db: MessageDatabase;
  private dispatchWakeup: (payload: WakeupPayload) => Promise<void>;
  private configGetter: () => BridgePluginConfig;
  private logger: any;
  private timers = new Map<string, NodeJS.Timeout>();
  private sweepTimer: NodeJS.Timeout | null = null;
  private isDisposed = false;

  constructor(options: TaskSchedulerOptions) {
    this.db = options.db;
    this.dispatchWakeup = options.dispatchWakeup;
    this.configGetter = options.configGetter || (() => ({}));
    this.logger = options.logger || console;
  }

  /**
   * 启动调度器：从数据库恢复所有 pending 任务并挂载定时器
   */
  start(): void {
    if (this.isDisposed) return;
    const pendingTasks = this.db.getPendingScheduledTasks(Number.MAX_SAFE_INTEGER);
    for (const task of pendingTasks) {
      this.armTimer(task);
    }

    // 60秒巡检兜底，防止系统休眠或进程时钟漂移
    this.sweepTimer = setInterval(() => {
      this.sweepDueTasks();
    }, 60 * 1000);
  }

  private sweepDueTasks(): void {
    if (this.isDisposed) return;
    const now = Date.now();
    const dueTasks = this.db.getPendingScheduledTasks(now);
    for (const task of dueTasks) {
      if (!this.timers.has(task.id)) {
        this.armTimer(task);
      }
    }
  }

  /**
   * 判断目标是否处于群聊夜间免打扰时段 (23:00 ~ 08:00)
   */
  private isNightDnd(timestamp: number): boolean {
    const d = new Date(timestamp);
    const hour = d.getHours();
    return hour >= 23 || hour < 8;
  }

  /**
   * 计算周期任务的下一次触发时间戳
   */
  computeNextRunAt(rule: RecurringRule, fromTimestamp: number = Date.now()): number {
    const timeOfDay = rule.time_of_day || '09:00';
    const [hhStr, mmStr] = timeOfDay.split(':');
    const targetHour = Number(hhStr) || 0;
    const targetMinute = Number(mmStr) || 0;

    const baseDate = new Date(fromTimestamp);

    // 探查未来最多 14 天
    for (let dayOffset = 0; dayOffset <= 14; dayOffset++) {
      const candidate = new Date(
        baseDate.getFullYear(),
        baseDate.getMonth(),
        baseDate.getDate() + dayOffset,
        targetHour,
        targetMinute,
        0,
        0
      );

      const candidateTime = candidate.getTime();
      if (candidateTime <= fromTimestamp) {
        continue;
      }

      const dayOfWeek = candidate.getDay(); // 0 is Sunday, 1 is Monday ... 6 is Saturday
      const isoDayOfWeek = dayOfWeek === 0 ? 7 : dayOfWeek; // 1=Mon ... 7=Sun

      if (rule.frequency === 'daily') {
        return candidateTime;
      } else if (rule.frequency === 'weekdays') {
        if (isoDayOfWeek >= 1 && isoDayOfWeek <= 5) {
          return candidateTime;
        }
      } else if (rule.frequency === 'weekends') {
        if (isoDayOfWeek === 6 || isoDayOfWeek === 7) {
          return candidateTime;
        }
      } else if (rule.frequency === 'custom') {
        if (Array.isArray(rule.days_of_week) && rule.days_of_week.includes(isoDayOfWeek)) {
          return candidateTime;
        }
      }
    }

    // 兜底回退：次日同一时间
    return fromTimestamp + 86400 * 1000;
  }

  /**
   * 校验任务时间与夜间免打扰 Fail-Fast
   */
  private validateTaskTime(
    nextRunAt: number,
    peer: string,
    isRecurring: boolean,
    now: number = Date.now()
  ): void {
    const deltaSeconds = Math.round((nextRunAt - now) / 1000);

    if (!isRecurring) {
      if (deltaSeconds < MIN_DELAY_SECONDS) {
        throw new Error(`定时任务执行延迟时间不能少于 ${MIN_DELAY_SECONDS} 秒（当前为 ${deltaSeconds} 秒）。`);
      }
      if (deltaSeconds > MAX_DELAY_SECONDS) {
        throw new Error(
          `单次定时任务执行时间不能超过 48 小时 (172800 秒)（当前为 ${deltaSeconds} 秒）。`
        );
      }
    } else {
      if (deltaSeconds < 0) {
        throw new Error(`周期任务下次执行时间必须在当前时间之后。`);
      }
    }

    // 夜间免打扰 (DND) 拦截：仅针对群聊且开启配置生效
    const isGroup = peer.startsWith('group_') || peer.startsWith('qq-group-');
    const config = this.configGetter();
    if (isGroup && config.proactive_night_dnd !== false) {
      if (this.isNightDnd(nextRunAt)) {
        const timeStr = formatDateTime(nextRunAt);
        throw new Error(
          `创建失败：目标执行时间 ${timeStr} 处于群聊夜间免打扰时段 (23:00 ~ 08:00)。请将执行时间调整在白天时段（08:00 之后），或向用户解释原因。`
        );
      }
    }
  }

  /**
   * 创建并排期任务
   */
  async scheduleTask(
    params: ScheduleTaskParams & { peer: string; creator?: string; now?: number }
  ): Promise<ScheduleTaskResult> {
    const now = params.now ?? Date.now();
    const peer = params.peer;
    const creator = params.creator || 'self';

    if (!params.prompt || !params.prompt.trim()) {
      throw new Error('创建定时任务必须提供非空的 prompt 说明。');
    }

    // 配额校验
    const pendingTasks = this.db.listScheduledTasks(peer, 'pending');
    if (pendingTasks.length >= MAX_PENDING_TASKS_PER_PEER) {
      throw new Error(
        `当前会话的待执行任务数量已达上限 (${MAX_PENDING_TASKS_PER_PEER} 个)，无法创建新任务。请先调用 manage_scheduled_tasks 取消不需要的旧任务。`
      );
    }

    const isRecurring = Boolean(params.recurring);
    let nextRunAt: number;

    if (params.delay_seconds !== undefined && params.delay_seconds !== null) {
      nextRunAt = now + Math.round(Number(params.delay_seconds) * 1000);
    } else if (params.execute_at) {
      const parsed = Date.parse(params.execute_at);
      if (Number.isNaN(parsed)) {
        throw new Error(`无法识别的时间格式: ${params.execute_at}，请使用 YYYY-MM-DD HH:mm:ss 或 ISO 格式。`);
      }
      nextRunAt = parsed;
    } else if (isRecurring && params.recurring) {
      nextRunAt = this.computeNextRunAt(params.recurring, now);
    } else {
      throw new Error('创建单次任务时，必须提供 delay_seconds 或 execute_at 之一。');
    }

    this.validateTaskTime(nextRunAt, peer, isRecurring, now);

    const taskId = `task_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const taskRecord: ScheduledTaskRecord = {
      id: taskId,
      peer,
      creator,
      prompt: params.prompt.trim(),
      type: isRecurring ? 'recurring' : 'once',
      recurring_rule: params.recurring || null,
      next_run_at: nextRunAt,
      status: 'pending',
      created_at: now,
      updated_at: now,
    };

    this.db.createScheduledTask(taskRecord);
    this.armTimer(taskRecord);

    const ruleDesc = formatRuleDescription(taskRecord);
    return {
      success: true,
      task_id: taskId,
      next_run_at: nextRunAt,
      formatted_next_run: formatDateTime(nextRunAt),
      rule_description: ruleDesc,
    };
  }

  /**
   * 任务管理 (list, cancel, update)
   */
  async manageTasks(
    params: ManageScheduledTasksParams & { peer: string; now?: number }
  ): Promise<ManageScheduledTasksResult> {
    const { action, peer } = params;
    const now = params.now ?? Date.now();

    if (action === 'list') {
      const pendingList = this.db.listScheduledTasks(peer, 'pending');
      const summaries: ScheduledTaskSummary[] = pendingList.map((t) => ({
        id: t.id,
        peer: t.peer,
        creator: t.creator,
        prompt: t.prompt,
        type: t.type,
        next_run_at: t.next_run_at,
        formatted_next_run: formatDateTime(t.next_run_at),
        rule_description: formatRuleDescription(t),
        status: t.status,
      }));
      return {
        success: true,
        action: 'list',
        tasks: summaries,
      };
    }

    if (action === 'cancel') {
      if (!params.task_id) {
        throw new Error('执行 cancel 操作必须提供 task_id。');
      }
      const existing = this.db.getScheduledTask(params.task_id);
      if (!existing || existing.peer !== peer) {
        throw new Error(`找不到 ID 为 ${params.task_id} 的任务，或该任务不属于当前会话。`);
      }
      this.clearTimer(params.task_id);
      this.db.cancelScheduledTask(params.task_id);
      return {
        success: true,
        action: 'cancel',
        task: {
          id: existing.id,
          peer: existing.peer,
          creator: existing.creator,
          prompt: existing.prompt,
          type: existing.type,
          next_run_at: existing.next_run_at,
          formatted_next_run: formatDateTime(existing.next_run_at),
          rule_description: formatRuleDescription(existing),
          status: 'cancelled',
        },
      };
    }

    if (action === 'update') {
      if (!params.task_id) {
        throw new Error('执行 update 操作必须提供 task_id。');
      }
      const existing = this.db.getScheduledTask(params.task_id);
      if (!existing || existing.peer !== peer) {
        throw new Error(`找不到 ID 为 ${params.task_id} 的任务，或该任务不属于当前会话。`);
      }

      let nextRunAt = existing.next_run_at;
      const isRecurring = Boolean(params.recurring ?? existing.recurring_rule);

      if (params.delay_seconds !== undefined && params.delay_seconds !== null) {
        nextRunAt = now + Math.round(Number(params.delay_seconds) * 1000);
      } else if (params.execute_at) {
        const parsed = Date.parse(params.execute_at);
        if (Number.isNaN(parsed)) {
          throw new Error(`无法识别的时间格式: ${params.execute_at}`);
        }
        nextRunAt = parsed;
      } else if (params.recurring) {
        nextRunAt = this.computeNextRunAt(params.recurring, now);
      }

      this.validateTaskTime(nextRunAt, peer, isRecurring, now);

      const updates: Partial<ScheduledTaskRecord> = {};
      if (params.prompt) updates.prompt = params.prompt.trim();
      if (nextRunAt !== existing.next_run_at) updates.next_run_at = nextRunAt;
      if (params.recurring !== undefined) updates.recurring_rule = params.recurring;

      this.db.updateScheduledTask(params.task_id, updates);
      const updated = this.db.getScheduledTask(params.task_id)!;
      this.armTimer(updated);

      return {
        success: true,
        action: 'update',
        task: {
          id: updated.id,
          peer: updated.peer,
          creator: updated.creator,
          prompt: updated.prompt,
          type: updated.type,
          next_run_at: updated.next_run_at,
          formatted_next_run: formatDateTime(updated.next_run_at),
          rule_description: formatRuleDescription(updated),
          status: updated.status,
        },
      };
    }

    throw new Error(`不支持的操作类型: ${(params as any).action}`);
  }

  /**
   * 挂载计时器
   */
  private armTimer(task: ScheduledTaskRecord): void {
    if (this.isDisposed || task.status !== 'pending') return;

    this.clearTimer(task.id);

    const now = Date.now();
    const delay = Math.max(0, task.next_run_at - now);

    const timer = setTimeout(async () => {
      this.timers.delete(task.id);
      await this.triggerTask(task.id);
    }, delay);

    this.timers.set(task.id, timer);
  }

  private clearTimer(taskId: string): void {
    const existing = this.timers.get(taskId);
    if (existing) {
      clearTimeout(existing);
      this.timers.delete(taskId);
    }
  }

  /**
   * 触发执行任务
   */
  private async triggerTask(taskId: string): Promise<void> {
    if (this.isDisposed) return;
    const task = this.db.getScheduledTask(taskId);
    if (!task || task.status !== 'pending') return;

    try {
      const ruleDesc = formatRuleDescription(task);
      const payload: WakeupPayload = {
        trigger: 'scheduled',
        peer: task.peer,
        from_user: task.creator,
        from_name: '系统定时任务',
        content: task.prompt,
        task_id: task.id,
        task_type: task.type,
        task_rule: ruleDesc,
        timestamp: Date.now(),
      };

      await this.dispatchWakeup(payload);

      if (task.type === 'once') {
        this.db.completeScheduledTask(task.id);
      } else if (task.type === 'recurring' && task.recurring_rule) {
        const nextRun = this.computeNextRunAt(task.recurring_rule, Date.now());
        this.db.completeScheduledTask(task.id, nextRun);
        task.next_run_at = nextRun;
        this.armTimer(task);
      }
    } catch (err) {
      this.logger?.warn?.(`[TaskScheduler] 触发定时任务 ${taskId} 失败:`, err);
    }
  }

  /**
   * 释放资源与定时器
   */
  dispose(): void {
    this.isDisposed = true;
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }
}
