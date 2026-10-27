/**
 * 契约测试: 定时任务工具真实装配闭环契约 (Assembly Contract)
 * 验证 registerAgentTools 装配下 schedule_task 与 manage_scheduled_tasks 的注册与调用闭环。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Context } from '@deepseek-ai/cordis';
import { MessageDatabase } from '../../src/storage/database.js';
import { MediaStorageManager } from '../../src/storage/media.js';
import { TaskScheduler } from '../../src/scheduler/index.js';
import { registerAgentTools } from '../../src/tools/index.js';

describe('契约测试: 定时任务工具真实装配闭环 (Assembly Contract)', () => {
  let tmpDir: string;
  let dbPath: string;
  let db: MessageDatabase;
  let mediaManager: MediaStorageManager;
  let scheduler: TaskScheduler;
  let ctx: Context;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tasks-assembly-'));
    dbPath = path.join(tmpDir, 'test.db');
    db = new MessageDatabase(dbPath);
    db.init();

    mediaManager = new MediaStorageManager({
      dshHome: tmpDir,
      db,
      ttlDays: 7,
    });

    scheduler = new TaskScheduler({
      db,
      dispatchWakeup: async () => {},
      configGetter: () => ({ proactive_night_dnd: false }),
    });

    ctx = new Context();
  });

  afterEach(() => {
    scheduler.dispose();
    try {
      db.close();
    } catch {}
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('契约 1: registerAgentTools 装配后 tools 注册表必须包含 schedule_task 与 manage_scheduled_tasks', () => {
    const registeredTools = new Map<string, any>();
    (ctx as any).tools = {
      register: (toolDef: any) => {
        registeredTools.set(toolDef.name, toolDef);
        return () => registeredTools.delete(toolDef.name);
      },
      get: (name: string) => registeredTools.get(name),
    };

    const unregister = registerAgentTools(ctx, {
      db,
      mediaManager,
      scheduler,
      dshHome: tmpDir,
    });

    // 验证 schedule_task 已注册
    const scheduleTaskTool = registeredTools.get('schedule_task');
    expect(scheduleTaskTool).toBeDefined();
    expect(scheduleTaskTool.name).toBe('schedule_task');
    expect(scheduleTaskTool.description).toContain('为当前 QQ 会话创建并排期一个定时唤醒任务');

    // 验证 manage_scheduled_tasks 已注册
    const manageTool = registeredTools.get('manage_scheduled_tasks');
    expect(manageTool).toBeDefined();
    expect(manageTool.name).toBe('manage_scheduled_tasks');
    expect(manageTool.description).toContain('查询、取消或修改当前 QQ 会话中已排期的定时任务');

    // 验证销毁闭环
    unregister();
    expect(registeredTools.has('schedule_task')).toBe(false);
    expect(registeredTools.has('manage_scheduled_tasks')).toBe(false);
  });

  it('契约 2: 装配工具支持通过 exec.agent.session.id 自动解析 peer 并创建任务', async () => {
    const registeredTools = new Map<string, any>();
    (ctx as any).tools = {
      register: (toolDef: any) => {
        registeredTools.set(toolDef.name, toolDef);
        return () => registeredTools.delete(toolDef.name);
      },
      get: (name: string) => registeredTools.get(name),
    };

    registerAgentTools(ctx, {
      db,
      mediaManager,
      scheduler,
      dshHome: tmpDir,
    });

    const scheduleTool = registeredTools.get('schedule_task');
    const manageTool = registeredTools.get('manage_scheduled_tasks');

    // 模拟 DSH 生产运行时的 exec 参数，携带 session.id = 'qq-group-8000000002'
    const mockExec = {
      agent: {
        session: {
          id: 'qq-group-8000000002',
        },
      },
    };

    // 1. 创建任务
    const createRes = await scheduleTool.execute(
      {
        prompt: '10分钟后提醒看群消息',
        delay_seconds: 600,
      },
      mockExec
    );

    expect(createRes.success).toBe(true);
    expect(createRes.task_id).toBeDefined();

    // 2. 查询列表，验证 peer 已被自动归一化为 group_8000000002
    const listRes = await manageTool.execute({ action: 'list' }, mockExec);
    expect(listRes.success).toBe(true);
    expect(listRes.tasks.length).toBe(1);
    expect(listRes.tasks[0].peer).toBe('group_8000000002');
    expect(listRes.tasks[0].prompt).toBe('10分钟后提醒看群消息');
  });
});
