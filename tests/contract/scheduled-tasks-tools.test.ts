/**
 * 契约测试: schedule_task 与 manage_scheduled_tasks 工具契约
 * 验证工具描述准确性、参数校验、任务创建、列表查询、更新与取消契约。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { MessageDatabase } from '../../src/storage/database.js';
import { TaskScheduler } from '../../src/scheduler/index.js';
import {
  createScheduleTaskTool,
  createManageScheduledTasksTool,
} from '../../src/tools/scheduler.js';

describe('契约测试: 定时任务工具集 (Tools Contract)', () => {
  let tmpDir: string;
  let dbPath: string;
  let db: MessageDatabase;
  let scheduler: TaskScheduler;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tools-test-'));
    dbPath = path.join(tmpDir, 'test.db');
    db = new MessageDatabase(dbPath);

    scheduler = new TaskScheduler({
      db,
      dispatchWakeup: async () => {},
      configGetter: () => ({ proactive_night_dnd: false }),
    });
  });

  afterEach(() => {
    scheduler.dispose();
    try {
      db.close();
    } catch {}
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('契约 1: 工具描述契约验证 (包含 When to use / When not to use，无标题一整段)', () => {
    const scheduleTool = createScheduleTaskTool(() => ({ scheduler, peer: 'group_test' }));
    const manageTool = createManageScheduledTasksTool(() => ({ scheduler, peer: 'group_test' }));

    expect(scheduleTool.name).toBe('schedule_task');
    expect(scheduleTool.description).toContain('为当前 QQ 会话创建并排期一个定时唤醒任务');
    expect(scheduleTool.description).toContain('切勿用于编程或本地开发流程中的短期命令执行与耗时等待');
    expect(scheduleTool.description).toContain('wait_for_user_messages');

    expect(manageTool.name).toBe('manage_scheduled_tasks');
    expect(manageTool.description).toContain('查询、取消或修改当前 QQ 会话中已排期的定时任务');
    expect(manageTool.description).toContain('切勿用于管理宿主操作系统底层的系统级计划任务');
  });

  it('契约 2: schedule_task 工具创建单次任务契约', async () => {
    const scheduleTool = createScheduleTaskTool(() => ({
      scheduler,
      peer: 'group_contract_1',
      userId: '10001',
    }));

    const result = await scheduleTool.execute({
      prompt: '半小时后提醒我出门',
      delay_seconds: 1800,
    });

    expect(result.success).toBe(true);
    expect(result.task_id).toBeDefined();
    expect(result.rule_description).toBe('单次任务');
    expect(result.formatted_next_run).toBeDefined();

    // 检查数据库中已真实落盘
    const inDb = db.getScheduledTask(result.task_id!);
    expect(inDb?.peer).toBe('group_contract_1');
    expect(inDb?.prompt).toBe('半小时后提醒我出门');
  });

  it('契约 3: manage_scheduled_tasks 工具 list 契约', async () => {
    const scheduleTool = createScheduleTaskTool(() => ({
      scheduler,
      peer: 'group_contract_2',
      userId: '10001',
    }));
    const manageTool = createManageScheduledTasksTool(() => ({
      scheduler,
      peer: 'group_contract_2',
    }));

    // 先创建一个任务
    await scheduleTool.execute({
      prompt: '测试任务 A',
      delay_seconds: 300,
    });

    // 调用 list
    const listResult = await manageTool.execute({
      action: 'list',
    });

    expect(listResult.success).toBe(true);
    expect(listResult.action).toBe('list');
    expect(Array.isArray(listResult.tasks)).toBe(true);
    expect(listResult.tasks?.length).toBe(1);
    expect(listResult.tasks?.[0].prompt).toBe('测试任务 A');
  });

  it('契约 4: manage_scheduled_tasks 工具 update 与 cancel 契约', async () => {
    const scheduleTool = createScheduleTaskTool(() => ({
      scheduler,
      peer: 'group_contract_3',
      userId: '10001',
    }));
    const manageTool = createManageScheduledTasksTool(() => ({
      scheduler,
      peer: 'group_contract_3',
    }));

    const createRes = await scheduleTool.execute({
      prompt: '最初任务',
      delay_seconds: 300,
    });
    const taskId = createRes.task_id!;

    // 1. update
    const updateRes = await manageTool.execute({
      action: 'update',
      task_id: taskId,
      prompt: '更新后的任务内容',
      delay_seconds: 600,
    });
    expect(updateRes.success).toBe(true);
    expect(updateRes.task?.prompt).toBe('更新后的任务内容');

    // 2. cancel
    const cancelRes = await manageTool.execute({
      action: 'cancel',
      task_id: taskId,
    });
    expect(cancelRes.success).toBe(true);
    expect(cancelRes.task?.status).toBe('cancelled');

    // 再次 list，活跃任务应为空
    const listAfterCancel = await manageTool.execute({ action: 'list' });
    expect(listAfterCancel.tasks?.length).toBe(0);
  });
});
