# Checklist: Agent 定时唤醒与周期任务调度系统

本文档追踪 Agent 定时唤醒与周期任务调度系统的交付进度，严格遵循 TDD、红线测试与生产装配验证规范。

---

## 阶段一：契约测试与数据层设计 (TDD Contract First)
- [x] **1.1 类型定义与接口声明**
  - [x] 在 `src/types/index.ts` 补充 `ScheduledTaskRecord`, `ScheduleTaskParams`, `ManageScheduledTasksParams`, `WakeupPayload.trigger: 'scheduled'` 类型定义
- [x] **1.2 SQLite 数据持久化契约测试 (`tests/contract/scheduled-tasks-storage.test.ts`)**
  - [x] 编写表创建、任务持久化插入、按 peer 查询、状态更新、周期任务 `next_run_at` 推进契约测试 (7/7 passed)
  - [x] 实现 `MessageDatabase` 任务增删改查方法，验证单测通过
- [x] **1.3 调度引擎核心契约测试 (`tests/contract/task-scheduler.test.ts`)**
  - [x] 单次任务 10s~48h 时间范围校验（边界值 9s 拒绝，10s 允许，172800s 允许，172801s 拒绝）
  - [x] 群聊夜间免打扰 (23:00~08:00) Fail-Fast 拦截契约（群聊命中拒绝并报错，私聊放行）
  - [x] 周期任务（每天、工作日、周末、自定义星期）计算契约
  - [x] 单 peer 配额（上限 5 个 pending 任务）校验契约
  - [x] 任务触发与回调分发契约（`dispatchWakeup` 触发）(8/8 passed)

---

## 阶段二：工具集实现与 Prompt 注入
- [x] **2.1 工具定义与描述契约 (`tests/contract/scheduled-tasks-tools.test.ts`)**
  - [x] `schedule_task` 工具注册与参数校验 (4/4 passed)
  - [x] `manage_scheduled_tasks` (list, cancel, update) 工具注册与业务行为
  - [x] 工具描述符合无标题自然语言、融入 When to use / When not to use 约束，杜绝编程耗时等待歧义
- [x] **2.2 唤醒 Prompt 格式化与上下文注入**
  - [x] `formatWakeupPrompt` 增加对 `trigger === 'scheduled'` 的格式化输出
  - [x] 包含时间戳、任务 ID、周期说明、群聊行为建议与任务备注

---

## 阶段三：系统装配与运行时接线闭环 (Integration & Boot)
- [x] **3.1 运行时装配接线**
  - [x] `src/index.ts` (主插件) 中实例化 `TaskScheduler`，注入 `MessageDatabase`、`SessionManager.dispatchWakeup` 与配置项并启动 `scheduler.start()`
  - [x] 在 `registerAgentTools` 挂载 `schedule_task` 与 `manage_scheduled_tasks`
  - [x] 在插件 `dispose` 时优雅清理所有定时器 `taskScheduler.dispose()`
- [x] **3.2 契约装配闭环测试 (`tests/contract/scheduled-tasks-assembly.test.ts`)**
  - [x] 验证 `registerAgentTools` 装配后 tools 注册表包含 `schedule_task` 与 `manage_scheduled_tasks` (2/2 passed)
  - [x] 验证 `exec.agent.session.id` 生产上下文自动解析 peer 闭环
- [x] **3.3 全量验证与构建验证**
  - [x] 契约测试全部通过 (21/21 passed)
  - [x] `pnpm typecheck` 编译无报错通过
  - [x] 运行 `pnpm build` 确认产物 `dist/` 包含最新调度逻辑与工具导出
