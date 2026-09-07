# 需求文档：send_qq_message 回合终止机制（end 信号 + 透明重试 + concludesTurn）

> **项目**: dsh-napcat-bridge
> **文档版本**: v0.1（草稿，待审阅批注）
> **日期**: 2026-09-08
> **状态**: 设计收敛，待用户审阅批注后定稿

---

## 0. 背景与问题

### 0.1 问题
DSH 的 agent-loop 是**结构性回合终止**（`dsh-agent-loop/lib/index.js:690-691`）：
```js
const toolCalls = message.content.filter((b) => b.type === "tool-call");
if (toolCalls.length === 0) return { kind: "completed" };   // 回合在此结束
```
- 只要模型一条消息里含 `tool-call` 块，loop 必然继续，让模型再产一条。
- 因此模型调用 `send_qq_message` 后**无法立即结束回合**，被迫再产一条无 tool-call 的终答文本。
- 提示词引导换不来结构改变——这是 harness 的终止模型，不是模型能选择的。

### 0.2 解法：利用 DSH 原生 `concludesTurn` 机制
DSH 提供给工具的"动作即终点"能力（`dsh-tool` / `dsh-agent-loop` 实证）：
- 工具执行结果顶层带 `concludesTurn: true` → `dsh-agent-loop:186` 聚合 `concluded` → `:693` `return concluded ? completed : null` → **立即结束回合，不生成终答文本**。
- 纯插件实现，无需 fork harness。

---

## 1. 需求 A：`send_qq_message` 增加 `end` 参数

### 1.1 签名
```
send_qq_message { text: string, end?: boolean }
```
- **`end` 必须显式传 `true` 才生效为"结束本轮"**；不写 / 其它值一律视为 `false`（非 true 即 false，不隐式推断）。
- 默认 `false`：保持 loop 继续（进度汇报/需要等待等中途发言场景）。

### 1.2 语义
- `end: true` = 这是本轮**最后一条**消息，发送成功后立即结束本轮，不产生多余总结文本。
- `end: false / 省略` = 继续任务，用于中途发言。

### 1.3 安全（只进不退）
- `end: true` + 成功 → loop 直接 break，连终答文本都不产生（干净）。
- `end: false / 忽略` → loop 继续 → 模型产终答 → 现有 C3 抑制（sendCount≥1 丢终答）→ **仍是恰好一条**（等于当前正确行为，不退化）。

---

## 2. 需求 B：透明重试（框架层，模型无感）

- `execute()` 内部对发送做**最多 5 次重试**，每次间隔 **500ms**（共约 2.5s）。
- 重试在工具内同步进行，**对模型完全屏蔽，不消耗模型推理轮次**。
- 首次成功即可继续走第 3 节逻辑；重试期间任意一次成功皆算成功。
- v1 不区分瞬时/硬性错误，一律重试（窗口短，可接受；后续可作为细分优化）。

---

## 3. 需求 C：`concludesTurn` 透传（最晚收到 break）

- `send_qq_message` 执行成功 **且** `end === true` 时，工具返回结果顶层带 **`concludesTurn: true`**。
- DSH loop 据此聚合 `concluded: true` → 立即结束本轮。
- 实现需经 `dsh-tool` 输出契约把 `concludesTurn` 带进 `ToolExecutionSuccess`（见 §6 待核实）。

---

## 4. 需求 D：失败降级（不硬 break）

- 5 次重试后仍失败（网络 / 参数等）→ 返回**错误结果，不带 `concludesTurn`** → loop 不 break。
- 模型在上下文看到"发送失败"的明确报错，自主判断是否补发 / 生成最终文本，随后依赖结构式"无 tool-call 自然结束"退出。
- 应用层不替模型决定收尾方案。

---

## 5. 引导与边界

### 5.1 工具描述补充
```text
send_qq_message: 向当前 QQ 会话（群聊/私聊）主动发送一条文本给用户。
- 长任务进行中：向用户汇报进度（end:false 或省略，任务继续）
- 任务完成发送最终答复：请以 end:true 调用，成功后本轮结束，无需再产出总结文本
- 每条 text 为一条独立 QQ 消息，过长自动分段
```

### 5.2 动态段（可选补一行，待定）
```
- 任务完成发送最终答复时，以 end:true 调用 send_qq_message。
```

### 5.3 边界 / caveat
| # | 场景 | 处理 |
|---|---|---|
| 1 | 模型把 `end:true` 的调用和别的工具塞**同一条消息** | DSH 会先跑完同组所有工具再 concluded，不会砍兄弟工具；描述提示"收尾的 end:true 尽量单独一条消息" |
| 2 | 小模型误把 end:true 用在进度消息上 | 提前终止本轮——靠描述/准则强调"end:true 仅用于最终答复"，接受为显式信号的固有风险 |
| 3 | end 不写/写非 true | 一律视为 false，不隐式推断 |
| 4 | 重试期全失败 + end=true | 不 concludesTurn，报错给模型，结构式兜底 |

---

## 6. 实现前待核实（调研先行，写纪要）

1. **`concludesTurn` 透传路径**：`defineTool` 的 `execute()` 返回普通对象（`{success, message_id, ...}`）时，顶层 `concludesTurn: true` 是否被 `dsh-tool` 的 `normalizeDispatchResult`（`dsh-tools/lib/index.js:3481`）正确透传进 `ToolExecutionSuccess`；若需特定返回形态（如 `{ value, concludesTurn }` wrapper）或 `exec.concludeTurn()` 路径（`:1303`），以源码确认为准。
2. 并行工具组的 concluded 聚合时序（同组全部执行完才 concluded，确认不砍兄弟工具）。
3. `concludesTurn` 与现有 C3（sendCount≥1 丢终答）无冲突（end:true 时根本不会走到 C3）。

---

## 7. 验收清单（草案）

- [ ] A1 `end?: boolean` 参数，非 true 即 false（不隐式推断）
- [ ] A2 成功 + end=true → 返回带 `concludesTurn: true`
- [ ] B1 execute 内 5 次重试 × 500ms，成功即止，模型无感
- [ ] B2 全失败 → 返回错误、无 concludesTurn
- [ ] D1 失败后模型可自行补发/收尾（结构式结束路径）
- [ ] C1 契约测试：end:true 成功 → 回合立即结束（断言在 real 装配下无后续终答生成）；end:false → loop 继续；全失败 → 不结束
- [ ] C2 现有测试全绿 + pnpm build + dist 含改动
- [ ] C3 真机验证项：群/私聊用 end:true 发终答 → QQ 只收到一条、WebUI 无重复终答