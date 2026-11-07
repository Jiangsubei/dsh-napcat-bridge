# Checklist：系统事件与统一唤醒中枢 (SystemEventHub) 实施清单

> 对应方案文档：[devlog/方案设计-系统事件与统一唤醒中枢SystemEventHub_261107.md](file:///f:/Project/dsh-napcat-bridge/devlog/方案设计-系统事件与统一唤醒中枢SystemEventHub_261107.md)  
> 状态：已全量完成并通过回归测试与构建（待真机验收）

---

## 阶段一：领域类型与核心中枢构建 (Phase 1: Types & Core Hub)

- [x] **1.1 定义系统事件强类型领域模型**
  - [x] 新建 `src/types/system-event.ts`
  - [x] 定义 `SystemEventKind`、`ScheduledTaskEvent`、`AgentIpcEvent`、`ProactiveLurkEvent`、`ProactivePollingEvent`、`SyntheticNoticeEvent`
  - [x] 在 `src/types/index.ts` 导出并扩展 `WakeupPayload` 增加 `is_system?: boolean` 和可选强类型关联
- [x] **1.2 实现 `SystemEventHub` 统一分发中枢**
  - [x] 新建 `src/gateway/system-event-hub.ts`
  - [x] 实现针对各类系统事件的门面分发方法 (`dispatchScheduledTask`, `dispatchAgentIpc`, `dispatchProactiveLurk`, `dispatchProactivePolling`, `dispatchSyntheticNotice`)
  - [x] 封装标准的系统事件提示词格式化函数（统一头部标识、渠道、时间戳与 `[结束]` / `[回执]` 边界引导，双换行分段，原本精心打磨的行为引导 100% 完整保留置底）
  - [x] 确保由 Hub 转换输出的底层 `WakeupPayload` 具备 `is_system: true`，且 `from_name` 彻底留空，绝不向底层传入任何系统伪昵称
- [x] **1.3 将 `SystemEventHub` 挂载至主应用生命周期**
  - [x] 在 `src/index.ts` 中完成实例化，注入 `sessionManager` 与 `logger`
  - [x] 将 Hub 挂载到 `sessionManager`、Cordis context 供后续模块与工具注入

---

## 阶段二：契约测试先行 (Phase 2: TDD Contract Tests)

- [x] **2.1 编写 `SystemEventHub` 核心契约测试**
  - [x] 新建 `tests/contract/system-event-hub.test.ts`
  - [x] **断言 1 (标题防污染)**：测试定时任务、IPC、潜水唤醒、戳一戳经由 Hub 派发，产生的底层 Payload 绝不含系统伪昵称，且无法触发私聊会话重命名
  - [x] **断言 2 (零特权审批)**：测试系统事件派发后，唤醒发起人 `initiator` 严格被认定为 `null`，严禁借壳提权
  - [x] **断言 3 (提示词格式与规范)**：断言各类系统事件生成的 Prompt 格式符合标准模板，包含明确的结束引导，不含底层调试泄漏
  - [x] **断言 4 (出站上下文自动标记)**：断言系统事件能自动完成 `OutboundBridge` 的合成上下文挂载，且出站 trigger 正确映射

---

## 阶段三：生产端业务模块迁移改造 (Phase 3: Module Migration)

- [x] **3.1 改造定时任务调度器 (TaskScheduler)**
  - [x] 改造 `src/scheduler/index.ts` 中的 `triggerTask`
  - [x] 移除手写的 `from_name: '系统定时任务'` 与弱类型 Payload
  - [x] 切换为优先调用 `systemEventHub.dispatchScheduledTask(...)`，兼容老链路
- [x] **3.2 改造跨 Agent 协同 IPC (AgentIPC)**
  - [x] 改造 `src/tools/agent-ipc.ts` 中的 `createTargetAgentTool` 与 `sendAgentMessageTool`
  - [x] 移除手写的 `from_name: '系统协作总线'` / `'协同 Agent'`
  - [x] 切换为优先调用 `systemEventHub.dispatchAgentIpc(...)`，兼容老链路
- [x] **3.3 改造潜水唤醒与群聊主动回复 (ProactiveManager)**
  - [x] 改造 `src/gateway/proactive.ts` 中的 `checkProactiveGroups`
  - [x] 潜水超时冒泡切换为优先调用 `systemEventHub.dispatchProactiveLurk(...)`
  - [x] 消息聚合轮询切换为优先调用 `systemEventHub.dispatchProactivePolling(...)`
- [x] **3.4 改造通知与合成事件处理 (NoticeHandler)**
  - [x] 改造 `src/index.ts` 中的 `notify.poke` 处理逻辑
  - [x] 切换为调用 `systemEventHub.dispatchSyntheticNotice(...)`，消除手动组装 `blankContext` 的割裂代码

---

## 阶段四：底座防御精简与兼容性收敛 (Phase 4: Runtime Clean-up)

- [x] **4.1 联动 `SessionAgentRunner` 与 `is_system`**
  - [x] 在 `src/gateway/session/agent-runner.ts` 中优先判断 `payload.is_system`，若为系统事件一律跳过标题检查
  - [x] 保持现存的 `REAL_SENDER_TRIGGERS` 与历史污染自愈清理机制向后兼容
  - [x] 优化 `isNoMessageWakeup`，当 `payload.is_system` 时直接确认为非外部消息事件，审批发起人认定为 `null`
- [x] **4.2 统一提示词入口收敛**
  - [x] 在 `src/gateway/session/agent-runner.ts` 中，若为系统事件优先使用 `formatSystemEventPrompt(payload.system_event)`

---

## 阶段五：回归验证与交付 (Phase 5: Verification & Delivery)

- [x] **5.1 历史契约测试全量回归**
  - [x] 运行 `tests/contract/scheduled-title-guard.test.ts` 确保历史标题防污染测试 100% 保持通过 (4/4 passed)
  - [x] 运行 `tests/contract/system-event-hub.test.ts` 确保新中枢契约测试 100% 通过 (9/9 passed)
  - [x] 运行 `tests/contract/agent-ipc.test.ts` 跨 Agent IPC 契约全量通过 (20/20 passed)
  - [x] 运行 `tests/contract/proactive-*.test.ts` 主动回复契约全量通过 (34/34 passed)
  - [x] 运行 `pnpm test:quick` 确保全量核心测试全绿 (110 文件，938 项测试通过)
- [x] **5.2 静态类型与编译检查**
  - [x] 执行 `pnpm typecheck` 确认零类型报错
  - [x] 执行 `pnpm build` 确认产物 `dist/` 正常生成并包含新逻辑 (`dist/gateway/system-event-hub.js`)
- [x] **5.3 编制交付报告与用户验收确认**
  - [x] 撰写阶段交付总结并呈报用户
