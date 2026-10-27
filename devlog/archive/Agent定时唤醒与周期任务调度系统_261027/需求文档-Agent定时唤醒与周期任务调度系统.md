# 需求文档：Agent 定时唤醒与周期任务调度系统 (Scheduled Tasks)

## 1. 背景与目标

目前 `dsh-napcat-bridge` 中 Agent 的唤醒依赖两类路径：
1. **外部被动触发**：收到 QQ 好友私聊、群聊被 @、群聊前缀命中或戳一戳等事件；
2. **系统被动巡检**：`ProactiveManager` 定时检测群聊潜水超时（Idle）并进行概率插话。

Agent 自身缺乏在当前会话回合中表达“**在未来特定时刻主动被重新唤醒并恢复上下文**”的能力。
典型场景包括：
- **用户延迟嘱托**：“半小时后提醒我出门”、“晚上 8 点帮我总结一下今天群里聊了什么”；
- **群聊社交节奏适应**：Agent 在群聊中看到感兴趣的话题，但当前群内发言节奏慢，Agent 计划过一段时间再主动回来看群动态（结合 `read_chat_history`）；
- **日常周期习惯**：工作日早晨定时发送晨报、打卡提醒或晚间复盘。

本系统旨在引入**定时唤醒与周期调度引擎**及配套的**两个工具**（`schedule_task` 与 `manage_scheduled_tasks`），使 Agent 能安全、可靠、持久化地自驱调度未来的唤醒动作。

---

## 2. 核心架构设计

### 2.1 整体组件交互图

```
┌─────────────────────────────────────────────────────────────┐
│                       Agent Session                         │
│                                                             │
│   调用 schedule_task / manage_scheduled_tasks               │
└───────────────┬─────────────────────────────────────────────┘
                │
                ▼
┌─────────────────────────────────────────────────────────────┐
│                 TaskScheduler (调度引擎)                    │
│                                                             │
│   1. Fail-Fast 校验 (时间范围 10s~48h, 夜间 DND 冲突, 配额)  │
│   2. 计算 next_run_at (单次/周期规则)                       │
│   3. 内存 Timer 管理 (最近到期队列)                         │
└───────────────┬───────────────────────────────┬─────────────┘
                │                               │
                ▼ (状态持久化)                  ▼ (定时触发)
┌───────────────────────────────┐ ┌───────────────────────────┐
│     MessageDatabase (SQLite)  │ │   SessionManager          │
│                               │ │   .dispatchWakeup         │
│   表: scheduled_tasks         │ │   (trigger: 'scheduled')  │
│   (跨进程重启自愈与生命周期)  │ └─────────────┬─────────────┘
└───────────────────────────────┘               │
                                                ▼
                                  ┌───────────────────────────┐
                                  │   OutboundStreamBridge    │
                                  │   (结果发送回 QQ 群/私聊)  │
                                  └───────────────────────────┘
```

---

## 3. 功能详细规格

### 3.1 时间边界与 Fail-Fast 校验规则

1. **单次任务时间边界**：
   - 最小下限：`10 秒`（防止微秒级死循环空转，且便于测试验收）；
   - 最大上限：`48 小时`（`172,800 秒`，覆盖绝大部分即时备忘与跨日事务，防止垃圾任务永久死锁）。
2. **夜间免打扰（DND）前置拦截（Fail-Fast）**：
   - 当任务目标为群聊（`peer` 为 `group_*` 或 `qq-group-*`）且插件配置 `proactive_night_dnd !== false` 时：
   - 若计算出的执行时间落入夜间免打扰时段（`23:00 ~ 08:00`），**在工具调用阶段立即拒绝创建并返回清晰错误**：
     - 避免夜间唤醒 Agent 消耗无效 Token；
     - 避免系统静默吞噬导致幽灵失效；
     - 赋予 Agent 当场与用户协商调整时间（如改为次日 08:30）的人机协同能力。
   - 私聊（`peer` 为 `user_*` 或 `qq-user-*`）默认不受夜间免打扰拦截（支持个人私密闹钟需求）。
3. **配额保护**：
   - 单个 `peer` 最多允许存在 `5` 个处于 `pending` 状态的活跃任务，超出时拒绝创建，防止 Prompt 注入或 Agent 陷入生成循环。

### 3.2 任务类型与周期规则 (Recurring Schedule)

1. **单次任务 (`type: 'once'`)**：
   - 参数提供 `delay_seconds`（相对时间，优先推荐）或 `execute_at`（精确时间字符串，`YYYY-MM-DD HH:mm:ss`）；
   - 执行完成后状态更新为 `completed`。
2. **周期任务 (`type: 'recurring'`)**：
   - 显式指定 `recurring` 对象：
     - `frequency`: `'daily'`（每天） | `'weekdays'`（工作日周一至周五） | `'weekends'`（周末周六日） | `'custom'`（自定义指定星期几）；
     - `time_of_day`: 每日触发时间，格式 `HH:mm`（如 `"09:30"`）；
     - `days_of_week`: 当 `frequency === 'custom'` 时传入数组 `[1, 3, 5]`（1=周一，7=周日）。
   - **执行与推进机制**：
     - 周期任务的 `next_run_at` 首次触发时间必须在合理周期内；
     - 触发唤醒后，任务状态保持 `pending`，调度器立即根据规则计算下一个 `next_run_at` 并更新落盘；
     - 任务持续有效，直到调用 `cancel` 动作。
   - **节假日处理**：第一版不内置硬编码法定节假日日历，依靠 LLM 在唤醒时自驱联网判断，保持系统轻量与免维护。

### 3.3 数据持久化规格 (SQLite Schema)

在 `MessageDatabase` 中创建 `scheduled_tasks` 表：

```sql
CREATE TABLE IF NOT EXISTS scheduled_tasks (
  id TEXT PRIMARY KEY,
  peer TEXT NOT NULL,
  creator TEXT NOT NULL,
  prompt TEXT NOT NULL,
  type TEXT NOT NULL,           -- 'once' | 'recurring'
  recurring_rule TEXT,          -- JSON 存储周期规则对象
  next_run_at INTEGER NOT NULL, -- 下次触发毫秒时间戳
  status TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'completed' | 'cancelled'
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tasks_pending_run ON scheduled_tasks(status, next_run_at);
CREATE INDEX IF NOT EXISTS idx_tasks_peer ON scheduled_tasks(peer, status);
```

- **启动自愈**：服务启动时，读取所有 `status = 'pending'` 的任务；
  - 若 `next_run_at <= now`（离线期间过期的任务）：单次任务若过期在 5 分钟内可补发或标记过期失效，周期任务自动推演到下一个周期点；
  - 若 `next_run_at > now`：重新加入内存计时调度队列。

### 3.4 唤醒 Prompt 契约

触发唤醒时，构造 `WakeupPayload`（`trigger: 'scheduled'`），经 `formatWakeupPrompt` 生成如下结构：

```markdown
[QQ群聊: 123456] [2026-10-27 15:30:00] [定时任务唤醒: #任务ID]
[任务类型: 周期任务 (工作日 09:30)]
（说明：这是此前设定的定时任务触发。如果是群聊场景，请先通过 read_chat_history 工具查看最近群聊动态再决定如何发言，发言内容应自然贴切，切勿透露内部 task_id 或系统事件代码等调试信息。）

任务要求/备注:
{自定义 prompt 文本}
```

---

## 4. 工具声明契约 (Tool Contract)

遵从项目规范：一整段自然语言、自然断句、无标题，自然融入 When to use 和 When not to use，严格区分短期命令等待与跨回合挂起释放。

### 4.1 `schedule_task`

- **名称**：`schedule_task`
- **描述**：
  > 为当前 QQ 会话创建并排期一个定时唤醒任务，支持相对延迟秒数、精确时间点或周期性循环（如每日、工作日、周末）。用于用户交代延迟提醒或未来备忘（如“半小时后提醒我出门”、“工作日早九点叫我打卡”），或者在群聊中发现有价值话题但当前发言节奏较慢、计划稍后主动回来看等需要跨回合自驱跟进的场景；排期成功后当前回合应正常结束，预定时间到达时系统会将你的任务说明作为提示词重新唤醒当前会话。切勿用于编程或本地开发流程中的短期命令执行与耗时等待（如等待构建、运行测试、拉取镜像或带 timeout 的 shell 脚本执行），该类短平快的命令与系统任务应使用具体的命令执行工具完成；亦切勿用于当前单轮内等待用户追加发言（等待用户补充输入请使用 wait_for_user_messages）。只有在当前会话回合可以彻底结束挂起、模型在此等待期间需要空闲出来正常响应其他用户消息、并在未来时刻由时钟重新唤醒你时，才应调用本工具。
- **参数**：
  - `prompt`: `string` (必填，唤醒提示词)
  - `delay_seconds`: `number` (可选，相对延迟秒数，10 ~ 172800)
  - `execute_at`: `string` (可选，精确时间，`YYYY-MM-DD HH:mm:ss`)
  - `recurring`: `object` (可选，周期规则)
    - `frequency`: `'daily' | 'weekdays' | 'weekends' | 'custom'`
    - `time_of_day`: `string` (`HH:mm`)
    - `days_of_week`: `number[]` (`1`=周一, `7`=周日)

### 4.2 `manage_scheduled_tasks`

- **名称**：`manage_scheduled_tasks`
- **描述**：
  > 查询、取消或修改当前 QQ 会话中已排期的定时任务。用于响应用户查询待执行备忘清单（如询问“晚点你有什么要提醒我的”时使用 list 动作）、用户明确取消某项提醒（如“刚才那个提醒不要了”时先 list 查出 task_id 再使用 cancel 动作），或调整原定提醒时间与要求（使用 update 动作）。切勿用于管理宿主操作系统底层的系统级计划任务（如 crontab 或系统守护服务），本工具仅用于维护当前 QQ 会话内由 schedule_task 创建的 Agent 业务定时任务；创建新的定时提醒请直接调用 schedule_task。
- **参数**：
  - `action`: `'list' | 'cancel' | 'update'` (必填)
  - `task_id`: `string` (cancel 或 update 时必填)
  - `prompt`: `string` (update 时可选)
  - `delay_seconds`: `number` (update 时可选)
  - `execute_at`: `string` (update 时可选)
  - `recurring`: `object` (update 时可选)
