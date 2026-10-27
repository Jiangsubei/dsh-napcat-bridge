/**
 * dsh-napcat-bridge: 定时任务工具集定义与处理器
 * 包含 schedule_task 与 manage_scheduled_tasks 及其 DSH defineTool 声明。
 */

import { defineTool } from '@deepseek-ai/dsh-tools';
import type { TaskScheduler } from '../scheduler/index.js';
import type {
  ScheduleTaskParams,
  ScheduleTaskResult,
  ManageScheduledTasksParams,
  ManageScheduledTasksResult,
} from '../types/index.js';

export interface SchedulerToolContext {
  scheduler?: TaskScheduler | null;
  peer?: string;
  userId?: string;
}

export const SCHEDULE_TASK_DESCRIPTION =
  '为当前 QQ 会话创建并排期一个定时唤醒任务，支持相对延迟秒数、精确时间点或周期性循环（如每日、工作日、周末）。用于用户交代延迟提醒或未来备忘（如“半小时后提醒我出门”、“工作日早九点叫我打卡”），或者在群聊中发现有价值话题但当前发言节奏较慢、计划稍后主动回来看等需要跨回合自驱跟进的场景；排期成功后当前回合应正常结束，预定时间到达时系统会将你的任务说明作为提示词重新唤醒当前会话。切勿用于编程或本地开发流程中的短期命令执行与耗时等待（如等待构建、运行测试、拉取镜像或带 timeout 的 shell 脚本执行），该类短平快的命令与系统任务应使用具体的命令执行工具完成；亦切勿用于当前单轮内等待用户追加发言（等待用户补充输入请使用 wait_for_user_messages）。只有在当前会话回合可以彻底结束挂起、模型在此等待期间需要空闲出来正常响应其他用户消息、并在未来时刻由时钟重新唤醒你时，才应调用本工具。';

export const MANAGE_SCHEDULED_TASKS_DESCRIPTION =
  '查询、取消或修改当前 QQ 会话中已排期的定时任务。用于响应用户查询待执行备忘清单（如询问“晚点你有什么要提醒我的”时使用 list 动作）、用户明确取消某项提醒（如“刚才那个提醒不要了”时先 list 查出 task_id 再使用 cancel 动作），或调整原定提醒时间与要求（使用 update 动作）。切勿用于管理宿主操作系统底层的系统级计划任务（如 crontab 或系统守护服务），本工具仅用于维护当前 QQ 会话内由 schedule_task 创建的 Agent 业务定时任务；创建新的定时提醒请直接调用 schedule_task。';

export function normalizePeer(peer: string): string {
  const groupMatch = peer.match(/^qq-group-([^-]+)/);
  if (groupMatch) return `group_${groupMatch[1]}`;
  const userMatch = peer.match(/^qq-user-([^-]+)/);
  if (userMatch) return `user_${userMatch[1]}`;
  return peer;
}

export function createScheduleTaskTool(contextGetter: () => SchedulerToolContext) {
  return defineTool({
    name: 'schedule_task',
    description: SCHEDULE_TASK_DESCRIPTION,
    parameters: {
      prompt: {
        type: 'string',
        required: true,
        description: '任务内容或唤醒提示词。到达预定时间时，该内容将作为系统唤醒 Prompt 重新发送给你。',
      },
      delay_seconds: {
        type: 'number',
        description: '相对延迟秒数（单次任务，10 秒至 172800 秒 / 48 小时）。例如 30 分钟后填 1800。',
      },
      execute_at: {
        type: 'string',
        description: '精确触发时间点（格式 YYYY-MM-DD HH:mm:ss 或 ISO 8601）。',
      },
      recurring: {
        type: 'object',
        description: '周期规则对象。若不提供则为单次任务。',
        additionalProperties: false,
        properties: {
          frequency: {
            type: 'string',
            enum: ['daily', 'weekdays', 'weekends', 'custom'],
            description: '循环频次: daily(每日), weekdays(仅工作日周一至五), weekends(仅周末), custom(自定义指定星期几)',
          },
          time_of_day: {
            type: 'string',
            description: '每日触发时间点，格式 HH:mm，如 "09:30"',
          },
          days_of_week: {
            type: 'array',
            items: { type: 'number' },
            description: '当 frequency 为 custom 时生效，数字 1=周一至 7=周日，例如 [1, 3, 5]',
          },
        },
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => {
        const v = value as unknown as ScheduleTaskResult;
        return [
          {
            type: 'text',
            text: v.success
              ? `定时任务创建成功！任务ID: ${v.task_id}，预计触发时间: ${v.formatted_next_run}（${v.rule_description}）。`
              : `定时任务创建失败: ${v.error}`,
          },
        ];
      },
    },
    execute: async (args: ScheduleTaskParams, exec?: any): Promise<ScheduleTaskResult> => {
      const ctx = contextGetter();
      if (!ctx.scheduler) {
        return { success: false, error: '调度引擎未初始化。' };
      }
      let peer = ctx.peer;
      if (!peer && exec) {
        const session = (exec.agent as any)?.session;
        if (session?.id) peer = normalizePeer(session.id);
      }
      if (!peer) {
        return { success: false, error: '缺少当前会话 peer 上下文，无法创建定时任务。' };
      }

      try {
        return await ctx.scheduler.scheduleTask({
          ...args,
          peer,
          creator: ctx.userId || 'self',
        });
      } catch (err: any) {
        return {
          success: false,
          error: err?.message || String(err),
        };
      }
    },
  });
}

export function createManageScheduledTasksTool(contextGetter: () => SchedulerToolContext) {
  return defineTool({
    name: 'manage_scheduled_tasks',
    description: MANAGE_SCHEDULED_TASKS_DESCRIPTION,
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['list', 'cancel', 'update'],
        description: '操作类型: list(查询待触发任务列表), cancel(取消指定任务), update(修改任务内容或时间)',
      },
      task_id: {
        type: 'string',
        description: '目标任务 ID（action 为 cancel 或 update 时必填，通过 list 获取）',
      },
      prompt: {
        type: 'string',
        description: '新的任务说明/唤醒提示词（action 为 update 时可选）',
      },
      delay_seconds: {
        type: 'number',
        description: '调整后的相对延迟秒数（action 为 update 时可选）',
      },
      execute_at: {
        type: 'string',
        description: '调整后的精确触发时间点（action 为 update 时可选）',
      },
      recurring: {
        type: 'object',
        description: '调整后的周期规则对象（action 为 update 时可选）',
        additionalProperties: false,
        properties: {
          frequency: {
            type: 'string',
            enum: ['daily', 'weekdays', 'weekends', 'custom'],
          },
          time_of_day: { type: 'string' },
          days_of_week: { type: 'array', items: { type: 'number' } },
        },
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => {
        const v = value as unknown as ManageScheduledTasksResult;
        if (!v.success) {
          return [{ type: 'text', text: `操作失败: ${v.error}` }];
        }
        if (v.action === 'list') {
          if (!v.tasks || v.tasks.length === 0) {
            return [{ type: 'text', text: '当前会话没有正在等待触发的定时任务。' }];
          }
          const listText = v.tasks
            .map(
              (t, i) =>
                `${i + 1}. [${t.id}] ${t.formatted_next_run} (${t.rule_description}): "${t.prompt}"`
            )
            .join('\n');
          return [{ type: 'text', text: `当前会话待执行定时任务 (${v.tasks.length} 个):\n${listText}` }];
        }
        if (v.action === 'cancel') {
          return [{ type: 'text', text: `已成功取消定时任务 #${v.task?.id}` }];
        }
        if (v.action === 'update') {
          return [
            {
              type: 'text',
              text: `已成功更新定时任务 #${v.task?.id}，下次触发时间: ${v.task?.formatted_next_run} (${v.task?.rule_description})`,
            },
          ];
        }
        return [{ type: 'text', text: JSON.stringify(v) }];
      },
    },
    execute: async (args: ManageScheduledTasksParams, exec?: any): Promise<ManageScheduledTasksResult> => {
      const ctx = contextGetter();
      if (!ctx.scheduler) {
        return { success: false, action: args.action, error: '调度引擎未初始化。' };
      }
      let peer = ctx.peer;
      if (!peer && exec) {
        const session = (exec.agent as any)?.session;
        if (session?.id) peer = normalizePeer(session.id);
      }
      if (!peer) {
        return { success: false, action: args.action, error: '缺少当前会话 peer 上下文。' };
      }

      try {
        return await ctx.scheduler.manageTasks({
          ...args,
          peer,
        });
      } catch (err: any) {
        return {
          success: false,
          action: args.action,
          error: err?.message || String(err),
        };
      }
    },
  });
}
