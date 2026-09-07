# 调研纪要：DSH agent-loop、回合锚定机制与 send_message 事件流

> **项目**: dsh-napcat-bridge
> **日期**: 2026-09-07
> **阶段**: 阶段 0（调研先行）
> **涉及文档**: docs/需求文档-send_message主动发言工具.md, docs/Checklist-send_message主动发言工具.md, docs/todo-send_message主动发言工具.md

---

## 1. 调研问题 1：DSH agent-loop 无工具调用的 assistant 文本消息是否 = 回合结束

### 1.1 源码查证事实
我们在 `node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js`（基于 `@deepseek-ai/dsh-agent-loop@0.1.2-rc.1`）中对 Agent 主执行循环进行了深入源码查证：

1. **单 Step 终态检查（`step()` 方法第 690-694 行）**：
   ```javascript
   const toolCalls = message.content.filter((block) => block.type === "tool-call");
   if (toolCalls.length === 0) return { kind: "completed" };
   const { concluded } = await executeToolCalls(this.loopCtx, turn, step, toolCalls, signal, (context) => this.inbox.splice("next-step", this.inbox.nextStep.length, 0, [context]));
   return concluded ? { kind: "completed" } : null;
   ```
2. **Turn 循环终止判断（主循环第 560-576 行）**：
   ```javascript
   const stepEnd = await this.step(decision.assembly, decision.startsRequestSeries === true);
   if (turnEnds === null || turnEnds.kind !== "max-tokens") turnEnds = stepEnd;
   ...
   if (turnEnds && this.inbox.nextStep.length === 0) {
       await this.dispatch.serial("agent/turn-stopping", { turn, signal });
       signal.throwIfAborted();
   }
   if (turnEnds && this.inbox.nextStep.length === 0) break;
   ```
3. **Turn 结束事件触发（主循环第 597-600 行）**：
   ```javascript
   this.session.append("turn/end", {
       turn,
       reason: turnEnds
   });
   ```

### 1.2 调研结论
- **确凿结论**：DSH agent-loop 严格遵循「无工具调用即完成」逻辑。当模型的某一次输出（AssistantMessage）中不包含任何 `tool-call` 类型块时，`step()` 明确返回 `{ kind: "completed" }`，循环随即中断并触发 `turn/end`。
- **终答判定依据**：一个 Turn 内，若一条 `assistant/message` 的 `content` 中没有任何 `tool-call`，则该条消息中的文本**必然是本轮次的最终答复文本（终答文本）**。

---

## 2. 调研问题 2：回合锚定机制现状与 group_msg_emoji_like 串扰 bug 根因

### 2.1 现状调用链路梳理
`OutboundStreamBridge` 维护了三套上下文映射：
1. `inboundContexts`: `Map<peer, InboundReplyContextInput>`（Peer 级全局保底映射）
2. `pendingMessageContexts`: `Map<messageId, { peer, context }>`（待激活唤醒消息映射）
3. `turnContexts`: `Map<peer, Map<turn, InboundReplyContextInput>>`（Turn 级精确绑定映射）

**更新点分布：**
- `src/index.ts:750`: 正常消息唤醒时，`trackInboundContext(payloadPeer, replyContext)` 更新 `inboundContexts`；在 `onMessageCreated` 中 `trackPendingMessage(userMsg.id, payloadPeer, replyContext)`。
- `src/outbound/stream.ts:188 & 209`: 在收到 `turn/start` 或 `user/message` 事件时，从 `pendingMessageContexts` 取出并锁定到 `turnContexts.get(peer).set(turn, entry.context)`。
- `src/index.ts:581-582`: `wait_for_user_messages` 收到消息时刷新 `inboundContexts` 和 `updateActiveTurnContext`。
- `src/index.ts:958 / 994`: 戳一戳与潜水主动唤醒时注册 `blankContext`（`msg_id: undefined`）。
- `src/index.ts:808`: 贴表情事件 `group_msg_emoji_like` 计算合成 ID（`syntheticMsgId = stableNoticeMsgId(...)`）并落库。

### 2.2 “终答引用：该消息不支持”根因剖析
在 QQ 协议中，若向 NapCat 发送引用消息 `[CQ:reply,id=<ID>]`，当 `<ID>` 是本地合成的虚假消息 ID（如 `stableNoticeMsgId` 生成的 hash 数值），或者该 ID 对应的并非支持引用的普通消息时，QQ 客户端由于服务端查无此消息或协议不支持，会向用户显示灰条：**“该消息不支持”**。

产生串扰与覆盖的深层根因如下：
1. **`turnContexts` 在 `turn/end` 被过早删除**：
   在 `stream.ts:219` 中：
   ```typescript
   if (event.type === 'turn/end') {
     this.turnContexts.get(peer)?.delete(turn);
     ...
   }
   ```
   若终答是在 `turn/end` 时补发，此时 `turnContexts` 已经被 delete，若回退到全局单值的 `inboundContexts`，极易发生跨轮次串扰。
2. **`inboundMsgIdGetter` 查的是单值 `inboundContexts` 而非当前活跃 Turn**：
   在 `src/index.ts:169` 中：
   ```typescript
   inboundMsgIdGetter: (peer: string) => {
     const inboundCtx = (outboundBridge as any).inboundContexts?.get?.(peer);
     return inboundCtx?.msg_id;
   }
   ```
   如果在回合中途 `inboundContexts` 受到任何其他事件干扰，会导致工具或出站获取到错误的 `msg_id`。
3. **缺乏合成 ID 过滤防线**：
   目前无论是 `buildMessagePayload` 还是 `trackInboundContext`，都没有对 `syntheticMsgId` / notice 事件进行类型校验与白名单过滤。如果任何 notice 的 `msg_id` 漏入，就会直接组装成 `[CQ:reply,id=syntheticMsgId]` 导致真实 QQ 群显示“该消息不支持”。
4. **中途锁定保护缺失**：
   回合锚点必须以**本轮开始时的那条真实入站消息**为准。当一个 Turn 正在执行时，任何外界 notice 事件（包括贴表情回传的 `group_msg_emoji_like`、戳一戳等），**绝对不得覆盖该 Turn 已绑定的锚点**。

### 2.3 修复方案（阶段 1 落实）
1. **生命周期锁定**：
   在 `OutboundStreamBridge` 中，Turn 的上下文在 `turn/start` 绑定后，中途锁定不可被非收集操作修改；在 `turn/end` 时，延迟清理（或由 `turn/end` 处理器在完成终答补发后再行清理），确保 `turn/end` 时依然能精准获取到本轮绑定的真实上下文。
2. **合成 ID 强拦截**：
   在 `buildMessagePayload` 与上下文设置处增加防御机制：判断 `msg_id` 是否为合法真实入站消息 ID；严禁任何 notice 记录（`emoji_like`、`poke`、`group_upload` 等合成 ID）成为引用对象；若检测到非法/合成 ID，强制降级为纯文本回复，杜绝下发无效 reply 导致 QQ 客户端报错。
3. **`group_msg_emoji_like` 纯落库隔离断言**：
   在 `server.onNotice` 中，明确断言 `group_msg_emoji_like` 绝不调用 `trackInboundContext`，且在真实装配测试中验证：入站贴表情后，后续回复引用的仍是回合起始真实消息的 `msg_id`。

---

## 3. 调研问题 3：send_message 计数可用事件与终答文本取法

### 3.1 `send_message` 调用计数事件
在 DSH 的 SessionEvent 流中：
- 每次模型发起工具调用，Session 会发出 `event.type === 'tool/call'` 事件。
- 其 payload 包含：`{ turn: number, step: number, callId: string, name: string, arguments: string }`。
- **计数策略**：
  在 `OutboundStreamBridge` 中：
  - 维护 `turnSendMessageCounts = new Map<string, number>()`（键为 `${peer}:${turn}`）。
  - 当收到 `event.type === 'tool/call'` 且 `(event.data as any)?.name === 'send_message'` 时，将该 Turn 的计数自增 `+1`。
  - 同时在 `turn/start` 时初始化为 0，`turn/end` 消费完毕后清理。

### 3.2 终答文本取法与出站旁白抑制
在处理 `event.type === 'assistant/message'` 时：
1. **结构化旁白抑制**：
   检查 `msgData.message.content`：
   - 若包含 `block.type === 'tool-call'`：说明该条消息伴随工具调用，其中的文本块纯属模型思考旁白或工具间隙溢出，**结构性抑制，绝对不向 QQ 发送**，仅保留在 Session / Web UI 中。
   - 若不包含任何 `tool-call`：提取其中的文本块（经 `stripMarkdown` 后的纯文本），将其暂存为当前 Turn 的**终答候选文本**（`turnFinalAnswers.set(turnKey, plainText)`）。
2. **`turn/end` 兜底补发规则**：
   当收到 `event.type === 'turn/end'` 时：
   - 读取该 Turn 的 `sendCount = turnSendMessageCounts.get(turnKey) || 0`；
   - **分支 A（`sendCount === 0`）**：模型未主动调用 `send_message`，此时触发安全兜底，自动将暂存的终答候选文本发送给 QQ Peer，并沿用当前首段引用（CQ:reply）与艾特（CQ:at）前缀逻辑；
   - **分支 B（`sendCount >= 1`）**：模型已通过 `send_message` 主动发过言，信任模型自管理，终答候选文本**不再自动补发**，防重复打扰与静默。

### 3.3 首调引用/艾特规则（阶段 5）
- 在 `send_message` 工具执行向 QQ 发送消息时：
  - 检查该 Turn 是否为首次调用（或记录该 Turn 首次 send 已发送状态）。
  - **首次调用**：携带本轮锚定消息的引用（quote）与艾特（at）前缀（若为群聊且配置开启）；
  - **后续调用**：降级为纯文本，不再重复携带引用与艾特前缀。

---

## 4. 下一步行动

调研结论已明确，方案闭环无歧义。
待用户确认本调研纪要后，立即推进：
- **阶段 1**：回合锚定修复（先修 bug，独立原子提交，更新 Checklist E 与 todo 阶段 1）；
- **阶段 2**：QQ 会话动态段（order ~10，系统提示词最前）；
- **阶段 3**：send_message 工具实现与装配；
- **阶段 4**：出站旁白抑制 + turn/end 兜底；
- **阶段 5**：send_message 首调引用规则；
- **阶段 6**：收尾验收与真实装配契约测试。
