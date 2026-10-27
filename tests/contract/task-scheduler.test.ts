/**
 * 契约测试: TaskScheduler 调度引擎契约 (Task Scheduler Engine Contract)
 * 验证 Fail-Fast 校验、夜间 DND 拦截、时间范围限制、周期推演及唤醒分发契约。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { MessageDatabase } from '../../src/storage/database.js';
import { TaskScheduler } from '../../src/scheduler/index.js';
import type { WakeupPayload } from '../../src/types/index.js';

describe('契约测试: TaskScheduler 调度引擎契约', () => {
  let tmpDir: string;
  let dbPath: string;
  let db: MessageDatabase;
  let dispatchedPayloads: WakeupPayload[] = [];
  let scheduler: TaskScheduler;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-scheduler-test-'));
    dbPath = path.join(tmpDir, 'test.db');
    db = new MessageDatabase(dbPath);
    dispatchedPayloads = [];

    scheduler = new TaskScheduler({
      db,
      dispatchWakeup: async (payload: WakeupPayload) => {
        dispatchedPayloads.push(payload);
      },
      configGetter: () => ({
        proactive_night_dnd: true,
      }),
    });
  });

  afterEach(() => {
    scheduler.dispose();
    try {
      db.close();
    } catch {}
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('契约 1: 单次任务时间下限 10 秒，小于 10 秒抛错拒绝', async () => {
    await expect(
      scheduler.scheduleTask({
        peer: 'group_100',
        creator: '12345',
        prompt: '测试快速任务',
        delay_seconds: 9,
      })
    ).rejects.toThrow(/不能少于 10 秒/);
  });

  it('契约 2: 单次任务时间上限 48 小时 (172800 秒)，超过 48 小时抛错拒绝', async () => {
    await expect(
      scheduler.scheduleTask({
        peer: 'group_100',
        creator: '12345',
        prompt: '超长任务',
        delay_seconds: 172801,
      })
    ).rejects.toThrow(/不能超过 48 小时/);
  });

  it('契约 3: 群聊夜间免打扰 (23:00~08:00) Fail-Fast 拦截，创建时直接拒绝并报错', async () => {
    // 构造一个落在今天或明天凌晨 03:00 的精确时间
    const targetDate = new Date();
    targetDate.setHours(3, 0, 0, 0);
    if (targetDate.getTime() < Date.now()) {
      targetDate.setDate(targetDate.getDate() + 1);
    }
    const executeAtStr = `${targetDate.getFullYear()}-${String(targetDate.getMonth() + 1).padStart(2, '0')}-${String(targetDate.getDate()).padStart(2, '0')} 03:00:00`;

    await expect(
      scheduler.scheduleTask({
        peer: 'group_100',
        creator: '12345',
        prompt: '半夜提醒',
        execute_at: executeAtStr,
      })
    ).rejects.toThrow(/处于群聊夜间免打扰时段/);
  });

  it('契约 4: 私聊任务不受群聊夜间免打扰拦截，正常放行', async () => {
    const targetDate = new Date();
    targetDate.setHours(3, 0, 0, 0);
    if (targetDate.getTime() < Date.now()) {
      targetDate.setDate(targetDate.getDate() + 1);
    }
    const executeAtStr = `${targetDate.getFullYear()}-${String(targetDate.getMonth() + 1).padStart(2, '0')}-${String(targetDate.getDate()).padStart(2, '0')} 03:00:00`;

    const result = await scheduler.scheduleTask({
      peer: 'user_200',
      creator: '200',
      prompt: '私聊熬夜提醒',
      execute_at: executeAtStr,
    });

    expect(result.success).toBe(true);
    expect(result.task_id).toBeDefined();
  });

  it('契约 5: 单个 peer 最多允许 5 个 pending 任务，超过限制拒绝创建', async () => {
    // 假定当前时间是上午 10:00，避免命中 DND
    const baseHour = 10;
    const now = new Date();
    now.setHours(baseHour, 0, 0, 0);
    const fixedNow = now.getTime();

    // 先创建 5 个合法的 pending 任务（延迟 100s, 200s, ...）
    for (let i = 1; i <= 5; i++) {
      const res = await scheduler.scheduleTask({
        peer: 'group_quota_test',
        creator: '12345',
        prompt: `任务 ${i}`,
        delay_seconds: 100 * i,
      });
      expect(res.success).toBe(true);
    }

    // 第 6 个应被配额拦截
    await expect(
      scheduler.scheduleTask({
        peer: 'group_quota_test',
        creator: '12345',
        prompt: '第6个任务',
        delay_seconds: 600,
      })
    ).rejects.toThrow(/待执行任务数量已达上限/);
  });

  it('契约 6: 周期任务下一次时间计算 (daily, weekdays, weekends, custom)', () => {
    // 假设当前基准时间是周一 (2026-10-26 10:00:00)
    // 注意：2026-10-26 是周一
    const mockMonday = new Date(2026, 9, 26, 10, 0, 0, 0).getTime();

    // 1. daily 14:30 (今天尚未到达 14:30)
    const nextDailySameDay = scheduler.computeNextRunAt(
      { frequency: 'daily', time_of_day: '14:30' },
      mockMonday
    );
    const d1 = new Date(nextDailySameDay);
    expect(d1.getFullYear()).toBe(2026);
    expect(d1.getMonth()).toBe(9);
    expect(d1.getDate()).toBe(26);
    expect(d1.getHours()).toBe(14);
    expect(d1.getMinutes()).toBe(30);

    // 2. daily 08:30 (今天 08:30 已过，应安排在明天周二 08:30)
    const nextDailyNextDay = scheduler.computeNextRunAt(
      { frequency: 'daily', time_of_day: '08:30' },
      mockMonday
    );
    const d2 = new Date(nextDailyNextDay);
    expect(d2.getDate()).toBe(27);
    expect(d2.getHours()).toBe(8);
    expect(d2.getMinutes()).toBe(30);

    // 3. weekdays (周一测试下一个工作日)
    // 假设是周五 18:00 (2026-10-30 18:00:00)
    const mockFridayEvening = new Date(2026, 9, 30, 18, 0, 0, 0).getTime();
    const nextWeekday = scheduler.computeNextRunAt(
      { frequency: 'weekdays', time_of_day: '09:00' },
      mockFridayEvening
    );
    const d3 = new Date(nextWeekday);
    // 周五之后的工作日应为下周一 (2026-11-02)
    expect(d3.getMonth()).toBe(10); // 11月
    expect(d3.getDate()).toBe(2);
    expect(d3.getDay()).toBe(1); // 周一

    // 4. weekends (周六周日)
    // 假设是周日 20:00 (2026-11-01 20:00:00)
    const mockSundayEvening = new Date(2026, 10, 1, 20, 0, 0, 0).getTime();
    const nextWeekend = scheduler.computeNextRunAt(
      { frequency: 'weekends', time_of_day: '10:00' },
      mockSundayEvening
    );
    const d4 = new Date(nextWeekend);
    // 应推迟到下周六 (2026-11-07)
    expect(d4.getDate()).toBe(7);
    expect(d4.getDay()).toBe(6); // 周六
  });

  it('契约 7: 定时触发后分发 dispatchWakeup 且单次任务标记 completed', async () => {
    vi.useFakeTimers();
    try {
      const res = await scheduler.scheduleTask({
        peer: 'user_trigger_test',
        creator: '8888',
        prompt: '到期提醒我测试',
        delay_seconds: 15,
      });

      expect(res.success).toBe(true);
      const taskId = res.task_id!;

      // 快进 15 秒
      await vi.advanceTimersByTimeAsync(15500);

      // 断言 dispatchWakeup 被调用
      expect(dispatchedPayloads.length).toBe(1);
      const payload = dispatchedPayloads[0];
      expect(payload.trigger).toBe('scheduled');
      expect(payload.peer).toBe('user_trigger_test');
      expect(payload.content).toBe('到期提醒我测试');
      expect(payload.task_id).toBe(taskId);

      // 断言数据库状态已变成 completed
      const taskInDb = db.getScheduledTask(taskId);
      expect(taskInDb?.status).toBe('completed');
    } finally {
      vi.useRealTimers();
    }
  });

  it('契约 8: 周期任务触发后，任务保持 pending 且自动计算并更新下次 next_run_at', async () => {
    vi.useFakeTimers();
    try {
      // 设定一个 10 秒后触发的周期任务
      const now = Date.now();
      const firstRun = now + 10000;
      const res = await scheduler.scheduleTask({
        peer: 'user_rec_test',
        creator: '9999',
        prompt: '每日循环任务',
        execute_at: new Date(firstRun).toISOString(),
        recurring: {
          frequency: 'daily',
          time_of_day: '12:00',
        },
      });

      expect(res.success).toBe(true);
      const taskId = res.task_id!;

      // 快进 10.5 秒触发首次执行
      await vi.advanceTimersByTimeAsync(10500);

      expect(dispatchedPayloads.length).toBe(1);
      const taskInDb = db.getScheduledTask(taskId);
      expect(taskInDb?.status).toBe('pending');
      // 下次执行时间应大于首次执行时间
      expect(taskInDb?.next_run_at).toBeGreaterThan(firstRun);
    } finally {
      vi.useRealTimers();
    }
  });
});
