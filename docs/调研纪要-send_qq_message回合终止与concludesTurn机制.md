# 调研纪要：send_qq_message 回合终止机制与 concludesTurn 透传链路

> **项目**: dsh-napcat-bridge  
> **日期**: 2026-09-08  
> **阶段**: 阶段 0（调研先行）  
> **涉及需求**: `docs/需求文档-send_qq_message回合终止机制.md` (§6 待核实项)  
> **查证依据**: 本地 `node_modules` 中 `@deepseek-ai/dsh-tools@0.1.2-rc.1` 与 `@deepseek-ai/dsh-agent-loop@0.1.2-rc.1` 实际源码及 `.d.ts` 声明文件  

---

## 1. 调研问题 1：`concludesTurn` 透传路径核实

### 1.1 源码查证事实
我们在 `node_modules/@deepseek-ai/dsh-tools` 中深入追踪了工具调度的执行与结果规范化链路：

1. **执行参数注入（`dsh-tools/lib/index.js:3037-3061` & `3193`）**：
   在调度执行前，`dsh-tools` 为每次执行构建了 `ToolRunContext`（即 `exec` 对象）：
   ```javascript
   const concludingExecutions = this.concludingExecutions; // WeakSet
   const base = {
       token,
       callId,
       rootCallId,
       name,
       signal,
       deferContext(context) { deferredContexts.push(context); },
       concludeTurn() {
           concludingExecutions.add(this); // 将当前 execution 加入 WeakSet
       }
   };
   const execution = { ...base, arguments: deepFreeze(detached) };
   ```
   在 `dispatchToolBody` 中调用用户定义的工具主体：
   ```javascript
   const returned = await tool.execute(exec.arguments, exec);
   const result = this.createSuccessResult(exec, tool, returned);
   ```

2. **结果物化与 `concludesTurn` 注入（`dsh-tools/lib/index.js:3416-3445` & `3477-3484`）**：
   在 `createSuccessResult` 中：
   ```javascript
   const concludesTurn = this.concludingExecutions.has(exec);
   return this.markCanonical(exec, this.materializeFinalResult({
       isError: false,
       value,
       content,
       ...meta !== void 0 ? { meta } : {},
       ...concludesTurn ? { concludesTurn: true } : {}
   }));
   ```
   在 `materializeFinalResult` 中：
   ```javascript
   return deepFreeze({
       ...materializePresentation({
           isError: false,
           ...presentation,
           ...result.concludesTurn === true ? { concludesTurn: true } : {}
       }),
       value: result.value
   });
   ```

3. **官方类型声明与使用范式（`dsh-tools/lib/types/index.d.ts:292-301` & `ptc.js:473` / `index.js:1303`）**：
   在 `dsh-tools` 的核心类型定义 `ToolRunContext` 中：
   ```typescript
   export interface ToolRunContext extends ToolExecution {
       deferContext(context: UserMessage): void;
       /**
        * Mark a successful final result as terminal for the current agent turn.
        * The marker rides this execution's own result (`concludesTurn` exists only
        * on {@link ToolExecutionSuccess}); a composite that dispatches nested
        * calls forwards it from the nested result, exactly like
        * `additionalContexts`, so only an authoritative nested success can
        * conclude the enclosing run.
        */
       concludeTurn(): void;
   }
   ```
   在官方复合工具实现中（如 `run_code`，`dsh-tools/lib/index.js:1303`）：
   ```javascript
   if (result.concludesTurn) exec.concludeTurn();
   ```

### 1.2 调研结论
- **单纯返回普通对象不会透传顶层 `concludesTurn`**：若工具 `execute()` 仅在返回的普通对象（如 `{ success: true, message_id: 123, concludesTurn: true }`）中带上该字段，该字段仅存在于 `result.value` 内部，而 `createSuccessResult` 判定是否打上顶层 `concludesTurn: true` 的**唯一依据**是 `this.concludingExecutions.has(exec)`。
- **确切落地形态**：
  1. 底层核心发送函数 `sendQqMessage(params, context)` 在 `success: true` 且 `params.end === true` 时，在返回对象中附带 `concludesTurn: true`；
  2. 在 `defineTool` 的 `execute(args, exec)` 中，若 `res.success && res.concludesTurn`，必须显式调用 `exec?.concludeTurn?.()`；
  3. 如此双重保障，确保既能让 `dsh-tools` 将 `concludesTurn: true` 正确物化到最终的 `ToolExecutionSuccess` 顶层，又能让工具返回值保持自解释。

---

## 2. 调研问题 2：并行工具组 concluded 聚合时序核实

### 2.1 源码查证事实
我们在 `node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js` 中核对了工具并发调度的完整时序：

1. **组内并发与排水（`dsh-agent-loop:231-253`）**：
   ```javascript
   await fillPool();
   while (inFlight.size > 0) {
       const settledIndex = await Promise.race(inFlight.values());
       inFlight.delete(settledIndex);
       throwSchedulerFailure();
       await commitReady();
       throwSchedulerFailure();
       if (signal.aborted) aborted = true;
       await fillPool();
   }
   ```
   在 `runGroup` 中，无论单工具还是多工具并发，必须等池中所有正在运行的工具调用（`inFlight`）全部结算（`allSettled` / 排水完成）才退出。

2. **顺序提交与 `concluded` 标记（`dsh-agent-loop:178-189`）**：
   ```javascript
   const commitReady = async () => {
       while (committed < group.length) {
           const slot = slots[committed];
           if (slot === void 0) break;
           ...
           appendToolResult(session, turn, step, call.block, result, callSeqs[committed]);
           concluded ||= result.concludesTurn === true;
           committed++;
       }
   };
   ```
   `concluded` 只是一个布尔标记聚合（`concluded ||= result.concludesTurn === true`），在工具组执行期间**绝不会**主动触发 `signal.abort()`，也**绝不会杀死或丢弃同组的兄弟工具**。

3. **Step 结束与 Turn 终止（`dsh-agent-loop:692-693` & `560-576`）**：
   ```javascript
   const { concluded } = await executeToolCalls(this.loopCtx, turn, step, toolCalls, signal, ...);
   return concluded ? { kind: "completed" } : null;
   ```
   当并发组所有工具全部完成并提交后，若 `concluded === true`，当前 `step()` 返回 `{ kind: "completed" }`，主循环捕获后直接 break 退出，不再进入下一步，不再调度大模型生成多余终答。

### 2.2 调研结论
- **完全不砍兄弟工具**：模型若在同一条消息内同时发起了其他工具调用与 `send_qq_message(end: true)`，DSH 会安全等待所有工具执行完毕并写入结果后，在 step 边界正常完成回合，语义极其健壮。

---

## 3. 调研问题 3：与现有 C3 抑制机制（sendCount≥1 丢终答）无冲突核实

### 3.1 源码查证事实
我们在 `src/outbound/stream.ts:325-342` 中查看现有 C3 实现：
```typescript
const hasToolCall = contentBlocks.some((block) => block && (block as any).type === 'tool-call');
if (hasToolCall) {
    return; // 旁白结构性抑制
}
const sendCount = turnKey ? (this.turnSendMessageCounts.get(turnKey) || 0) : 0;
if (sendCount >= 1) {
    return; // 分支 B: sendCount >= 1，模型已主动发言，末尾纯文本回复不发送
}
```

### 3.2 机制对比与互补性分析
| 场景 | `end: true` + `concludesTurn` 路径 | `end: false / 省略` 路径（现有 C3 保底） |
|---|---|---|
| **执行层面** | DSH agent-loop 在工具返回后直接 break，**根本不调度模型生成下一条 assistant 消息** | DSH agent-loop 继续下一轮推理，模型生成无 tool-call 的终答文本 |
| **OutboundStreamBridge 表现** | 不会收到无 tool-call 的 `assistant/message` 事件，**根本不会走到 C3** | 收到终答 `assistant/message`，C3 检查 `sendCount >= 1`，抑制不发 QQ，留存 WebUI |
| **资源消耗** | 零多余 token，零多余推理时延，最干净快速退出 | 消耗 1 次模型推理与 token，依赖插件层防抖过滤 |
| **协同关系** | **上层根治**（阻止终答产生） | **下层安全网**（万一模型没设 end: true 时的保底） |

### 3.3 调研结论
- 两者无任何逻辑冲突，互为递进保障：
  - `end: true` 成功时直接在上层截断，连推理都不产生；
  - `end: false` 或遗漏时平滑回退到下层 C3 过滤，确保 QQ 侧永远恰好收到一条，绝无重复打扰。

---

## 4. 补充建议：动态段提示词 (§5.2)

在 `src/prompt/dynamic.ts` 中，现有的 `QQ_SCENARIO_PROMPT` 为：
```markdown
# 如何发送消息

你正在 QQ 聊天中与用户对话。

【如何把内容送达用户】
- 想向用户发送文字/答复，必须调用 send_qq_message 工具。
```

**建议**：采纳需求文档 §5.2 的提议，追加一行提示：
```markdown
- 任务完成发送最终答复时，以 end:true 调用 send_qq_message。
```
**理由**：
1. 提示极其简练，不影响 KV Cache 命中和推理开销；
2. 与 `send_qq_message` 的工具描述（参数文档）形成双向呼应，降低小模型遗漏 `end: true` 的概率；
3. 保持与现有原则一致：严禁告知 turn/end 兜底机制，只正面引导如何以最高效方式完结任务。

---

## 5. 阶段 1 实施方案规划

1. **类型定义（`src/types/index.ts`）**：
   - `SendQqMessageParams` 增加 `end?: boolean;`
   - `SendQqMessageResult` 增加 `concludesTurn?: boolean;`
2. **重试机制与参数处理（`src/tools/index.ts:sendQqMessage`）**：
   - 提取参数 `const isEnd = params?.end === true;`（非 true 即 false）；
   - 在向网关/串行队列发送时，封装内部重试循环：最多 5 次，失败等待 500ms 重试；
   - 成功即止；若 5 次重试全失败，返回失败错误，不带 `concludesTurn`；
   - 发送成功后，若 `isEnd === true`，返回 `{ success: true, message_id, sent_preview, concludesTurn: true }`。
3. **工具包装与 `concludeTurn`（`src/tools/index.ts:registerAgentTools`）**：
   - 更新工具描述（按 §5.1 要求）；
   - 在 `parameters` 中注册 `end: { type: 'boolean', description: '...' }`；
   - 在 `execute(args, exec)` 中执行 `const res = await sendQqMessage(args, ...)`；若 `res.success && res.concludesTurn`，调用 `exec?.concludeTurn?.()`；返回 `res`。
4. **动态段补充（`src/prompt/dynamic.ts`）**：
   - 在 `QQ_SCENARIO_PROMPT` 中追加一行。
5. **契约测试（`tests/contract/send-message-tool.test.ts`）**：
   - 包含真实装配 `bootDshNapcatBridge` 的 5 项核心契约验证。
