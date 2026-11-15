# DSH 0.2.2-rc.3 依赖升级与问题汇总

> 任务背景：将 `dsh-napcat-bridge` 的项目依赖从 `0.2.1-rc.5` 升级到 `0.2.2-rc.3`，先只汇总升级后暴露的问题，不修改业务代码。
>
> 验证时间：2026-11-15
> 对照基线：项目旧 commit `69da405`（`package.json` 锁 `0.2.1-rc.5`）→ 目标 `0.2.2-rc.3`（当前 Desktop 安装版本，已核对 `@deepseek-ai/dsh` 的 `package.json` 版本为 `0.2.2-rc.3`）。

---

## 1. 已执行的升级动作

### 1.1 `package.json` 版本变更

| 依赖 | 旧版本 | 新版本 |
| --- | --- | --- |
| `@deepseek-ai/cordis`（dev） | `~4.0.5` | `~4.1.0` |
| `@deepseek-ai/schemastery`（dev） | `~3.18.5` | `~3.19.0` |
| `@deepseek-ai/dsh*`（dev，已显式列出的 20 个） | `0.2.1-rc.5` | `0.2.2-rc.3` |

### 1.2 为跑通本地装配额外补全的依赖

首次仅升级已列出的 20 个 `@deepseek-ai/dsh*` 后，`pnpm install` 仍把一批 peer 自动装包解析到旧版本（`0.2.0-rc.2` / `0.2.1-rc.2`），且缺少 `@deepseek-ai/dsh-jobs`，导致 44 个真实装配测试文件在 boot 阶段整体失败。

因此本次在 `devDependencies` 中补齐以下直接依赖（版本统一 `0.2.2-rc.3`），原因均为项目 `cordis.patch.yml` 预设中实际使用、或 0.2.2 包链的硬性 peer：

- `@deepseek-ai/dsh-agent-instructions`
- `@deepseek-ai/dsh-agent-preset`
- `@deepseek-ai/dsh-persona`
- `@deepseek-ai/dsh-skill-filesystem`
- `@deepseek-ai/dsh-tool-bash`
- `@deepseek-ai/dsh-tool-fs`
- `@deepseek-ai/dsh-tool-pwsh`
- `@deepseek-ai/dsh-tool-skill`
- `@deepseek-ai/dsh-tool-web`
- `@deepseek-ai/dsh-tool-working-directory`
- `@deepseek-ai/dsh-tool-workspace-dependencies`
- `@deepseek-ai/dsh-jobs`（`@deepseek-ai/dsh-jobs-local` 0.2.2-rc.3 的强制 peer）

补全后本地 `node_modules` 已无 `0.2.0-rc.2` 混装：`cordis@4.1.0`、`schemastery@3.19.0`、`dsh-jobs@0.2.2-rc.3`，与 Desktop 安装内的实际版本一致。

> 说明：`peerDependencies` 与 `engines.dsh` 已按 Kujira 44c38a3 的对齐做法收紧为 `@deepseek-ai/cordis ^4.1.0`、`@deepseek-ai/dsh-* >=0.2.2-0`、`@deepseek-ai/schemastery ^3.19.0`、`engines.dsh >=0.2.2-0`；`devDependencies` 的显式补全保留，作为本地构建/测试基线。

---

## 2. 验证结果总览

| 检查项 | 结果 | 说明 |
| --- | --- | --- |
| `pnpm typecheck` | ❌ 失败（3 个错误） | 全部集中在模型选择 API，详见问题 P0 |
| `pnpm vitest run`（test:quick） | ⚠️ 114/116 文件通过 | 2 个文件失败，均为 `tools.execute` 旧调用签名，详见问题 P1-3 |
| `pnpm build` | ❌ 无法完成 | 被 `tsc` 的 P0 错误阻断 |
| 真实 boot 装配（测试内 `bootDshNapcatBridge`） | ✅ 通过 | 补全依赖后，此前 44 个 boot 失败全部恢复 |
| 与旧调研报告结论的差异 | ⚠️ 已过期 | 旧报告 《调研报告-DSH_0.2.1-rc.5至0.2.2-rc.1增量更新与插件适配分析.md》 基于 rc.1，结论为"零破坏性阻断"；该结论不适用于 rc.3 的模型选择 API |

---

## 3. 问题清单

### P0（阻断编译/buid）模型选择 API 在 0.2.2-rc.3 被重构，项目仍按旧契约编写

**现象**：`pnpm typecheck` 报 3 个错误：

```
src/gateway/session.ts(8,51): error TS2724: '"@deepseek-ai/dsh-agent"' has no exported member named 'ModelSelectionRef'. Did you mean 'ModelSelection'?
src/gateway/session/agent-runner.ts(599,41): error TS2554: Expected 1 arguments, but got 2.
src/gateway/session/model-selector.ts(7,31): error TS2724: '"@deepseek-ai/dsh-agent"' has no exported member named 'ModelSelectionRef'. Did you mean 'ModelSelection'?
```

**根因（已用旧版包对照确证）**：

- 旧版 `@deepseek-ai/dsh-agent@0.2.1-rc.5` 提供：
  - `ModelSelectionRef { current, assembled }` 类型；
  - `installModelSelection(agentCtx, selection)`：同时注册 `system-prompt/assemble`（注入 provider/model 变量）、`agent/request`（把 `selection.assembled` 的 provider/model/effort 应用到请求配置）与 `agent/pre-step`（切换通知）。切换由调用方改 `selection.current` 即时驱动。
- 0.2.2-rc.3 改为 **Agent 持有不可变 `agent.model: Model`**（`AgentModel`）+ Session 投影 `modelSelection`（`pending` / `lastUsed`），写入 `model/selection` 持久事件；`installModelSelection(agentCtx)` 只保留 `agent/pre-step` 的"模型已切换"通知，不再接收 `ModelSelectionRef`，也不再改写请求配置。
- `ModelSelectionRef` 类型已删除，`Agent` 上也不存在 `modelSelection` 属性（0.2.2 中 `Agent` 的模型入口是 `agent.model.current()` / `agent.model.select()`）。

**项目受影响位置**：

| 文件:行号 | 旧契约用法 | 0.2.2-rc.3 行为 |
| --- | --- | --- |
| `src/gateway/session.ts:8` | `import type { ModelSelectionRef }` | 类型已删除 |
| `src/gateway/session/model-selector.ts:7` | 同上 | 类型已删除 |
| `src/gateway/session/model-selector.ts:11,161-171` | `Map<string, ModelSelectionRef>`、`getOrCreateSelectionRef` | 类型已删除 |
| `src/gateway/session/agent-runner.ts:79,599` | `installModelSelection(agentCtx, selectionRef)` | 第二参数被忽略，且不再应用选择 |
| `src/gateway/session/agent-runner.ts:508,530,809` | `(agent as any).modelSelection = selectionRef` | 新 Agent 无该字段，运行时赋值无人读取 |
| `src/commands/model/model-handler.ts:262-266` | 直接改 `agent.modelSelection.current` | 无人读取，切换不落到请求 |
| `src/commands/model/think-handler.ts:156-158` | 直接改 `agent.modelSelection.current.reasoningEffort` | 无人读取 |
| `src/commands/system/status-handler.ts:29` | 读 `(agent as any)?.modelSelection?.current` 展示当前模型 | 读不到 DSH 的真实选择（仅项目自己挂的值） |

**影响评估**：

1. 编译/构建直接阻断（P0）。
2. 运行时模型切换路径依赖 `safeSyncSessionModel`（`src/commands/model/sync.ts:22` → `sessionController.selectModel`）兜底：0.2.2-rc.3 的 `selectModel` 内部会 `agent.model.select(selected)`，因此 `/model`、`/think` **在 `sessionController` 可用的 profile 下可能"看起来仍生效"**；但一旦该服务缺失或会话不可 resume，切换完全失效。
3. 全局切换（`/model -g`、`/think -g`）在 0.2.2 下会对每个已知会话调用 `selectModel`，而 `selectModel` 语义是"explicitly resuming the Session"——**离线会话会被逐个 resume**（旧版只改内存 ref，不拉起会话）。可能带来耗时、锁冲突与大量会话被唤醒的副作用；项目虽对每个 sid 做了 catch，但行为已与旧版不同。
4. 恢复会话时，0.2.2 的 `AgentModel.current()` 优先返回 Session 日志中记录的 `model/selection`（`pending ?? lastUsed`），`agentOptions` 仅是 fallback。项目把选择持久化在自己的 DB 并通过 `agentOptions` 传入，**可能与 session 日志中的旧记录分叉**，导致"DB 显示已切换、实际请求仍用旧模型"。
5. `installModelSelection` 旧版会向 `system-prompt/assemble` 注入 `provider` / `model` 变量；新版由 step 的 `modelSelection` 统一提供。项目预设提示词若依赖这两个变量，需要确认新版变量来源是否一致（当前未发现项目提示词显式引用，风险低）。

**注意（测试"假绿"）**：`tests/contract/session-restart-and-archive.test.ts:293` 断言 `restoredAgent.modelSelection.current.reasoningEffort`。该测试当前通过，是因为项目自己给 agent 挂了 `modelSelection` 属性（`agent-runner.ts:809`），测试读到的也是这个"项目自挂值"，**不能证明 DSH 真实使用了该选择**。

**迁移方向（待确认后实施，本次不改）**：

- 用项目自定义 `ModelSelectionRef` 接口（或直接 `ModelSelection`）替换 DSH 的 `ModelSelectionRef`；
- `installModelSelection(agentCtx)` 只负责切换通知；
- 创建/恢复 agent 后，通过 `agent.model.select(...)` 应用项目记录的选择；复用 live agent 时同样用 `select`，不再给 `agent.modelSelection` 赋值；
- 读取当前选择改为 `agent.model.current()`；状态命令、`/model`、`/think` 的展示与写入统一走该入口；
- 全局切换改为"更新默认 + 仅对 live agent 立即 select；离线会话下次 resume 时再 select"，避免逐个 resume；
- resume 后若 Session 已记录 `model/selection` 且与项目 DB 不一致，按产品预期显式 select 一次。

---

### P1 依赖链缺包导致真实装配整体失败（已通过补全依赖解决）

**现象**：仅升级已显式列出的 20 个包后，44 个真实 boot 装配测试文件失败，典型报错：

```
dsh-napcat-bridge: startup failed: 2 required plugins did not activate
timer: TypeError: Cannot read properties of undefined (reading 'entry')
llm: TypeError: Cannot read properties of undefined (reading 'entry')
...
Cannot find package '@deepseek-ai/dsh-jobs' imported from .../dsh-jobs-local/lib/index.js
```

**根因**：

- 0.2.2-rc.3 使用 `cordis ~4.1.0`（项目当时仍为 `4.0.5`），`cordis-plugin-loader@1.1.0` 与 `cordis@4.0.5` 组合下 `_resolveConfig` 读到 `undefined.entry`；
- `dsh-jobs-local@0.2.2-rc.3` 强制 peer `@deepseek-ai/dsh-jobs@0.2.2-rc.3`，但项目依赖清单未列、pnpm 也未自动安装；
- 一批 peer 自动装包（`dsh-tool-pwsh` 等）仍停在 `0.2.0-rc.2`，与 0.2.2 包链混装。

**处置**：补全 1.2 节的依赖后，44 个文件全部恢复，`vitest` 文件级失败降为 2 个（见 P1-3）。这是本次升级中必须保留的依赖修正。

---

### P1 `Tools.execute` 在 0.2.2-rc.3 仅接受批量调用，两个装配测试仍用单调用签名

**现象**：`tests/contract/assembly.test.ts`、`tests/contract/face-assembly.test.ts` 各 1 例失败：

```
ToolBatchExecutionError: Tool batch execution failed
    at executeToolBatch (.../@deepseek-ai/dsh-tools/lib/pipeline.js:60:9)
```

**根因**：

- 0.2.2-rc.3 的 `Tools.execute(input: ToolBatchInput)` 只接受 `{ calls: [...], agent?, signal? }` 批量输入（`dsh-tools/lib/types/index.d.ts:130`），内部直接 `toolCalls.map(...)`；
- 测试仍按旧版单调用传 `{ name: 'read_chat_history', arguments: {}, agent, signal }`（`assembly.test.ts:145-150`、`face-assembly.test.ts` 同型），`input.calls` 为 `undefined`，被包装成 `ToolBatchExecutionError`；
- 业务代码 `src/` 未直接调用 `tools.execute`（已 grep 确认），因此**不影响插件运行**，只影响测试对 DSH 工具执行接口的模拟方式。

**处置建议（需用户授权后改测试）**：测试改用 `{ calls: [{ id, name, arguments: JSON.stringify(args) }], agent, signal }` 的批量形态；按项目红线，测试用例不得由代理擅自修改，需先确认。

---

### P2 `sessionProjections.stateOf(session, key)` 在 0.2.2 已标记 deprecated

**位置**：`src/gateway/session/agent-runner.ts:785-786`

```ts
const sessionProjections: any = safeGetService(this.ctx, 'sessionProjections');
const currentPreset = sessionProjections?.stateOf?.(handle.agent.session, 'agentPreset');
```

**证据**：0.2.2-rc.3 `dsh-session-projection/lib/index.js:175-180` 明确标注 deprecated，调用会打印：

```
sessionProjections.stateOf(session, "agentPreset") is deprecated; read handle.stateOf(session) from an awaited registration, or use the owning domain service
```

**影响**：功能仍可用（`agentPreset` 投影 key 与事件 `agent-preset/selected` 未变），但每次调用产生告警日志；后续大版本可能移除。可迁移到 `agentPresets` 服务的注册句柄或领域读取。

---

### P2 `model-selector` 中 `llm.listModels()` 被同步使用（0.2.2 下为 Promise）

**位置**：`src/gateway/session/model-selector.ts:66-75`

```ts
const models = llm.listModels(p.id || p);
if (models.length > 0) {
  return { provider: p.id || p, model: models[0]?.id || models[0] };
}
```

**证据**：0.2.2-rc.3 `dsh-llm` 的 `listModels(provider): Promise<LlmModelInfo[]>`（`lib/types/index.d.ts:378`）。`discovery.ts:17` 已正确 `await`，此处漏了。

**影响**：该分支只在 `agentDefaultModel` 服务不可用时走到；`models.length` 为 `undefined`，条件恒 false，最终落回硬编码默认（`deepseek-official` / `deepseek-v4-flash`）。不会崩溃，但"跟随宿主首个可用模型"的兜底探测失效；且若旧版也曾是 Promise，则属既有问题而非本次回归，建议顺手修正为 `await`。

---

### P2 `apply_patch` 未纳入 QQ 会话的 coding tools 限制列表（预防性）

**位置**：`src/gateway/session/agent-runner.ts:579`

```ts
const potential = ['bash', 'pwsh', 'read', 'write', 'edit'];
```

**背景**：0.2.2-alpha.2 起 `dsh-base` 与 Web `standard` preset 的 `tool-fs` 默认开启 `applyPatch: true`；QQ 预设自身的 `tool-fs` 行未显式设置，0.2.2 中 `applyPatch` 默认仍为 `false`（`dsh-tool-fs/lib/index.js:2014`），因此**当前 QQ 会话不会暴露 `apply_patch`**。

**风险**：`codingToolsEnabled=false` 的限制逻辑按"名单"剔除，未覆盖 `apply_patch`。一旦后续在预设/配置中开启 `applyPatch`，QQ 会话将出现"文件写入工具被禁、但 `apply_patch` 可写"的缺口。建议将 `apply_patch` 加入 `potential` 列表（或改用允许名单）。

---

## 4. 升级指南逐项对照

已按 `references/upgrading.md` 的要求，以起始版本 `0.2.1-rc.5`、目标 `0.2.2-rc.3` 查阅了 `docs/upgrade-guide/README.md` 中 `v0.2.1-rc.5` 之后的相关章节（`v0.2.2-alpha.2`、`v0.2.2-alpha.3`、`v0.2.2-rc.1`，以及起始点之前的 `v0.2.1-rc.4` 条目）。

| 指南 | 与项目关系 | 结论 |
| --- | --- | --- |
| `v0.2.2-rc.1` 全部 18 项（account notification、account remote、archive worktrees、attachment error codes、CUA、dsh-doc、Forge、bundle update、runtime-context reminders、session.append 重载、subagent interrupt、terminal、web search billing、window drag regions） | 仅 `session.append` 与 `attachment error codes` 可能触及 | 项目只**调用** `session.append`（`agent-runner.ts:798,804`），未替换实现，单事件签名仍兼容；附件错误码变化属于 DSH 内部改进，项目未捕获 `AttachmentError`；其余无关 |
| `v0.2.2-alpha.3`（4 项：Chat ProcessActivity、office-kit、office 技能、subagent 按名寻址） | 无关 | 项目不使用 DSH subagent、Office、Chat 活动类型 |
| `v0.2.2-alpha.2`（22 项） | `fs-observation-policy` / `apply_patch`、`llm-error`、`llm-request-purpose`、projection、schedule、web search、context menu、session header menu 等 | `apply_patch` 已列 P2；`LlmError`/`purpose` 项目未构造辅助 LLM 请求；projection 只涉及 P2 `stateOf`；schedule 为项目自研工具（`schedule_task`），不使用 DSH Schedule 模型工具；web search 配置字段（`fetch`、`searchTimeoutMs`）在 0.2.2 的 `tool-web` schema 中仍存在且兼容；Client 菜单/会话头部菜单项目未使用 |
| `v0.2.1-rc.4`（3 项：模型列表自动刷新、Reasoning Body Slot、sandbox 错误） | 模型列表 | `discovery.ts` 已 `await llm.listModels()`，兼容；`model-selector.ts` 的同步误用见 P2 |
| 其余更早版本（`v0.2.1-rc.3` 及以前） | 早于起始版本 | 项目已在 `0.2.1-rc.5` 基线上，无需回溯 |

> **重要缺口**：0.2.2-rc.3 的模型选择 API 重构（`ModelSelectionRef` 删除、`installModelSelection` 语义收窄、`agent.model` 引入）**没有对应的升级指南条目**（`v0.2.2-rc.1`/`alpha.3`/`alpha.2` 均未列出）。本次是通过 `tsc --noEmit` 与新旧包源码对照发现的，属于"指南未覆盖的破坏性变更"。

---

## 5. 与既有调研文档的关系

`devlog/调研报告-DSH_0.2.1-rc.5至0.2.2-rc.1增量更新与插件适配分析.md` 的结论（"零破坏性阻断，可直接在 0.2.2-rc.1 下加载"）基于 `0.2.2-rc.1` 源码。

本次实测表明：**`0.2.2-rc.3` 的 `@deepseek-ai/dsh-agent` 已把模型选择重构为 `AgentModel` + Session 投影**，旧的 `installModelSelection(agentCtx, ref)` / `ModelSelectionRef` / `agent.modelSelection` 全部失效。该旧文档的"零破坏"结论不再适用于 rc.3，建议在本文档基础上更新/归档旧结论。

---

## 6. 当前改动状态与复现方式

- 工作区改动：`package.json`、`pnpm-lock.yaml`（依赖升级与补全）；本文档。
- 未提交、未修改业务代码、未重跑 `pnpm build`（被 typecheck 阻断）。

复现命令：

```powershell
pnpm install
pnpm typecheck                        # 预期 3 个 P0 错误
pnpm vitest run                       # 预期 114/116 文件通过，2 个 tools.execute 相关失败
```

证据文件：

- 新版模型选择类型：`node_modules/@deepseek-ai/dsh-agent/lib/types/model-selection.d.ts`
- 新版实现：`node_modules/@deepseek-ai/dsh-agent/lib/types/model-selection.js`
- 旧版对照：`tmp/dsh-agent-old/package/lib/types/model-selection.{d.ts,js}`（由 `pnpm view @deepseek-ai/dsh-agent@0.2.1-rc.5` 下载解压，仅本地临时对照，不入库）
- 批量工具接口：`node_modules/@deepseek-ai/dsh-tools/lib/types/index.d.ts:130`
- 测试报告：`tmp/vitest-report.json`（升级前，44 文件失败）、`tmp/vitest-report2.json`（补全依赖后，2 文件失败）

---

## 7. 待用户决策

1. 模型选择迁移方案是否按 P0 的"迁移方向"执行（涉及 `model-selector.ts`、`agent-runner.ts`、`model-handler.ts`、`think-handler.ts`、`status-handler.ts`、`session.ts` 多处改造）；
2. 是否授权修改 `assembly.test.ts`、`face-assembly.test.ts` 中 `tools.execute` 的旧调用签名（测试红线，需明确同意）；
3. `session-restart-and-archive.test.ts:293` 的"假绿"断言是否同步改为读取 `agent.model.current()`；
4. 依赖补全清单（1.2 节）是否接受作为本次升级的正式改动。

> 以上 4 项已于第二轮获得用户确认并实施，见第 8 节。

---

## 8. 实施结果（第二轮，2026-11-15 晚）

> 用户确认：按第 7 节方向执行、允许修改测试、补全依赖保留。

### 8.1 已完成改造

1. **模型选择核心**（`src/gateway/session/model-selector.ts`）：
   - 移除对 DSH `ModelSelectionRef` 的依赖，改为本项目 `SelectionLike` / `ModelSelectionRef`；
   - 新增 `readAgentSelection`（`agent.model.current()`）、`applySelectionToAgent`（`agent.model.select()`）、`syncLiveAgents`（仅同步 live QQ Agent）；
   - `getModelSelection` 改为「插件记录 → live Agent → 默认值」的读取顺序；
   - `setModelSelection` / `setNapcatDefaultModel` 在写 Map/DB 后同步 live Agent。
2. **Agent 生命周期**（`src/gateway/session/agent-runner.ts`）：
   - `installModelSelection(agentCtx)` 改为单参调用；
   - 移除 3 处 `(agent as any).modelSelection = ...`，改为创建/复用/恢复后 `applySelectionToAgent`；
   - `sessionProjections.stateOf` 迁移到 `snapshot(session, ['agentPreset']).values.agentPreset`；
   - `apply_patch` 纳入 coding tools 裁剪名单。
3. **命令层**：
   - `/模型`、`/思考` 移除自挂 `modelSelection` 写操作，读取优先 `agent.model.current()`；
   - 全局切换不再遍历所有历史会话执行 `selectModel`（避免逐个 resume），改为「更新默认 + 同步 live Agent + 仅同步当前会话宿主侧选择」；离线会话在下次恢复时生效；
   - `/状态` 读取 `agent.model.current()`。
4. **测试**：
   - `assembly.test.ts` / `face-assembly.test.ts` 改用 `tools.execute({ calls, agent, signal })` 批量签名，并断言 `results[0].result.isError`；
   - `session-restart-and-archive.test.ts` 断言改为 `agent.model.current()` 的 provider/model/effort。

### 8.2 实施中新发现并修复的问题

- **0.2.2 `tools.restrict({ deny })` 对未知工具名整体报错**：QQ 预设未启用 `apply_patch` 时，把 `apply_patch` 直接放入 deny 会导致整次 restrict 抛错、所有 coding 工具裁剪失效（`security-session-permission.test.ts` 抓出 pwsh 未被裁剪）。
  修复：先通过 `tools.view(agent).restrictableNames` 过滤出当前真实装载的工具名，再计算 deny；并对整次 restrict 失败做逐个工具的隔离重试兜底。

### 8.3 验证结果

| 检查 | 结果 |
| --- | --- |
| `pnpm typecheck` | ✅ 通过 |
| `pnpm typecheck:all` | ✅ 通过 |
| `pnpm build` | ✅ 通过（dist 已含 `applySelectionToAgent` / `syncLiveAgents` / `installModelSelection(agentCtx)`） |
| `pnpm vitest run` | ✅ 367 suites / 1021 tests：1018 passed，3 skipped，0 failed |
| `privacy-guard` | ✅ 包含在 vitest 全量中通过 |

### 8.4 未覆盖项

- 未做 NapCat 真机（WebSocket + QQ 账号）联调；建议在真机分别验证 `/模型`、`/思考`、`/模型 -g` 的端到端效果。
- 离线会话的模型选择在「下次 resume 时」生效，这一点已由 `session-restart-and-archive` 契约覆盖，但真实 QQ 会话首次消息的切换效果仍建议真机确认。

### 8.5 与 Kujira 44c38a3 的对照结论（2026-11-15 晚）

对照仓库 `F:\Project\Kujira` 的升级提交 `44c38a3 chore: 升级 DSH 依赖至 0.2.2-rc.3 并适配工具批量执行与模型选择契约`：

| 对照项 | Kujira 44c38a3 | dsh-napcat-bridge（本次） | 结论 |
| --- | --- | --- | --- |
| `tools.execute` 测试 | `calls: [{ type: 'tool-call', id, name, arguments: '{}' }]` + `results[0].result.isError` | 完全相同 | ✅ 一致 |
| `installModelSelection` | 改为单参 `installModelSelection(agentCtx)` | 相同 | ✅ 一致 |
| `ModelSelectionRef` 移除 | 自定义 `KujiraModelSelectionRef`（`current: ModelSelection`） | 自定义 `SelectionLike` / `ModelSelectionRef` | ✅ 等价 |
| `agent.modelSelection` 自挂赋值 | 保留（0.2.2 下 DSH 不再读取，靠 `sessionController.selectModel` 兜底） | 移除，改为创建/复用/恢复后 `agent.model.select()` 同步 | 本实现更完整（本项目 `/模型`、`/思考` 覆盖运行时切换） |
| 全局切换 | 遍历所有已知会话 `selectModel`（会逐个 resume 离线会话） | 更新默认 + 同步 live Agent + 仅当前会话同步宿主侧；离线会话下次恢复生效 | 行为等价且避免批量 resume |
| `sessionProjections.stateOf` | 保留 deprecated 调用 | 迁移到 `snapshot(session, ['agentPreset'])` | 本实现消除了告警 |
| `llm.listModels` 同步误用 | 保留（`model-selector.ts:83`） | 删除无效同步分支，回退内置默认 | 本实现消除隐患 |
| Coding 工具裁剪 | 无此功能 | 修复 0.2.2 `restrict()` 未知名称整次失败问题 | 本项目特有功能 |
| peer/engines 范围 | 收紧至 `>=0.2.2-0` / `cordis ^4.1.0` / `schemastery ^3.19.0` | 已同步收紧（见 1.2 节） | ✅ 一致 |
| 本地依赖基线 | 未显式列 optional peer，靠 pnpm auto-install peers 装齐 0.2.2-rc.3 | 显式补全 12 个 devDependencies | 本实现更稳定，功能等价 |

**Kujira 验证情况**：其仓库在 0.2.2-rc.3 下 `tests/contract/commands-model-sync.test.ts`、`assembly.test.ts`、`face-assembly.test.ts` 共 16 例全部通过；其 `/模型` 切换依赖的 `sessionController.selectModel` 通道与本项目 `safeSyncSessionModel` 兜底路径一致。该对照反证：升级后保留官方 `selectModel` 通道是正确做法，本次在此基础上补充的 `agent.model.select()` 只是让 live Agent 与插件状态在任意 profile 下都保持一致，没有破坏既有通道。

**结论**：两边升级思路一致，本次实现是 Kujira 适配范围的超集；无需要回退的差异。收紧后的版本范围与 Kujira 完全对齐，全量测试仍为 0 失败。