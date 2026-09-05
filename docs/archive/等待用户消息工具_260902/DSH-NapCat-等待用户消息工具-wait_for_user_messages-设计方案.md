# DSH-NapCat 等待用户消息工具 wait_for_user_messages 设计方案 (EN-005)

> 状态: 设计方案（待用户审定后进入 TDD 契约测试与实现阶段）
> 日期: 2026-09-02
> 关联: EN-005 [中] wait_for_user_messages 挂起等待用户消息工具

---

## 1. 需求与目标

DSH 是单轮交互：Agent 被唤醒 → 跑完一轮 → 待机。用户说半句话（如"我想到三个好项目"）后，Agent 回复"我等你"就只能睡觉，用户后续消息必须再次 @ 才能唤醒。

本工具让 Agent 在**一轮内挂起**，收集一段时间内到达的当前会话新消息后返回，实现**单轮多消息交互**：

- 入参：`timeout`（number，等待秒数，Agent 自定，插件不限策略）、`user_id`（string，可选，群聊时指定等谁）
- 出参：`{ messages: Array<{ from, user_id, content, time }>, total }`
- Agent 可多次调用、反复等待；连续等不到时由 Agent 自行决定结束本轮

## 2. 现状调研与技术事实（源码实证）

### 2.1 工具 execute 可长时间阻塞 —— 机制成立

- `dsh-agent-loop` 在回合内 `await executeToolCalls(...)`（`dsh-agent-loop/lib/index.js:685`），工具 Promise 未 settle 前当前回合保持打开；settle 后的结果在同一回合回喂模型，模型继续推理。
- **结论**：`execute` 阻塞数秒~数分钟完全合法。收集到的消息以工具结果形式回到模型，同一轮内继续处理 → "单轮多消息"成立。

### 2.2 外部不会掐断长等待

- `dsh-tool-call-timeout-policy` 只在工具声明 `timeoutMs` 时计时（`dsh-tool-call-timeout-policy/lib/index.js:123-124`：`if (timeoutMs === void 0) return next();`）；dsh-base 装配虽挂载该 policy（`dsh-base/cordis.patch.yml:343`），但只对声明 `timeoutMs` 的工具生效。
- 本项目现有工具均未声明 `timeoutMs`，新工具**也不声明**（超时由 `timeout` 参数自管），亦**不得声明 `isConcurrencySafe`**（保持 exclusive 独占调度，避免同回合并行出多个长阻塞）。

### 2.3 不抑制唤醒就会双重投递（关键设计约束）

- `agent.followup()` 语义为"排队一个独立的新回合"（`dsh-agent/lib/types/runtime-types.d.ts` followup 注释：*"Queue an ordinary follow-up turn and wake the driver"*）。
- 等待期间同 peer 新消息若照常走 `index.ts → shouldWakeup → dispatchWakeup → followup`，会在当前回合结束后再作为新回合投给 Agent —— 与收集器返回的内容**重复**，Agent 会重复回复。
- **结论**：等待期间命中收集器的消息必须被"消耗"（跳过唤醒门控），只进收集器 + 入库。

### 2.4 入站流水线落点

`src/index.ts:287` `server.onMessage` 流水线顺序：

```
预处理/媒体下载 → parseNormalizedContent → 空消息过滤 → @昵称归一化
→ db.saveMessage → 斜杠命令 → 提问拦截 → 审批拦截 → 主动回复记录 → shouldWakeup → dispatchWakeup
```

- 在「审批拦截之后、`shouldWakeup` 之前」插入等待门控时，`peer`、`content`（已 @昵称归一化）、`senderName`、`timestamp`、`isSelf` 全部就绪 —— 注入点唯一正确。
- `outboundBridge.trackInboundContext(peer, {msg_id, from_user, is_group})` 是按 peer 覆写的 Map（`outbound/stream.ts:81-83`）—— 被收集消息可安全刷新回复锚点（@提问者/引用原消息锚定最后一条收集消息）。

## 3. 用户拍板结论（2026-09-02）

| # | 决策点 | 用户选择 |
|---|--------|----------|
| 1 | 等待结束条件 | **纯超时窗口**：从调用起算 `timeout` 秒，到点返回全部收集消息；无"静默提前返回"隐藏策略 |
| 2 | 等待期间处理范围 | **全抑制**：等待期间该 peer 所有新消息只落库 +（命中则）进收集器；**斜杠命令除外**（程序层负责，不属于 Agent 对话，照常执行）；其余（提问/审批/主动回复/唤醒）全部跳过 |
| 3 | user_id 校验口径 | **语法级校验**：非空 + 合法 QQ 号格式即通过，不做存在性 API 校验；查无此人/收不到 → 超时状态层报错，Agent 自推 |

## 4. 总体设计：数据流时序

```
Agent 回合内:
  wait_for_user_messages({timeout: 120, user_id?: "2000000001"})
  → tools/index.ts 参数校验（非法 → 状态层/依赖层报错即返回）
  → server.ts MessageWaitRegistry.wait(peer, {userId?, timeoutMs, signal})   [同步注册一次性收集器]
  → 阻塞:

  [等待窗口内] NapCat 上报 → server.onMessage 流水线:
     preprocess → 解析 → 空滤 → @归一化 → db.saveMessage(照常)
     → 斜杠命令?(程序层，照常执行并 return)
     → waitRegistry.isWaiting(peer)?
         ├─ 是: isSelf? → 跳过收集; 否则 tryDeliver(peer, {from,user_id,content,time})
         │     命中 → 追加收集 + trackInboundContext 刷新锚点
         │     未命中(群聊他人) → 仅抑制
         │     统一 return (跳过提问/审批/主动回复/唤醒)
         └─ 否: 原流水线(提问→审批→主动回复→shouldWakeup→dispatchWakeup)

  超时到期 / exec.signal 中止 / dispose:
  → 结算: 有消息 → { messages, total }；无消息 → 状态层报错；取消 → 状态层取消报错
  → 同一轮内工具结果回喂模型，Agent 就收集到的全部消息继续推理并正式回复
```

## 5. 详细设计

### 5.1 `src/gateway/server.ts` —— MessageWaitRegistry（入站消息事件桥接）

新增导出（独立类，不侵入 NapCatGatewayServer 本体）：

```ts
export interface WaitCollectedMessage {
  from: string;     // 发送者昵称/群名片（与唤醒包同源）
  user_id: string;  // 发送者 QQ
  content: string;  // 归一化文本（与唤醒包同源：@昵称(QQ号)、图片/文件占位等）
  time: number;     // 毫秒时间戳
}

export type MessageWaitResult =
  | { ok: true; messages: WaitCollectedMessage[] }
  | { ok: false; error: 'timeout' | 'cancelled' | 'wait-active'; message: string };

export class MessageWaitRegistry {
  /** 注册一次性收集器；同 peer 已有活动等待 → wait-active 状态层错误 */
  wait(peer: string, opts: {
    userId?: string;      // 可选过滤；缺省收集该 peer 全部用户消息
    timeoutMs: number;    // 等待窗口（毫秒），纯超时窗口语义
    signal?: AbortSignal; // Agent 回合取消信号
  }): Promise<MessageWaitResult>;

  /** 判活（index.ts 门控用，同步、O(1)） */
  isWaiting(peer: string): boolean;

  /** 尝试投递入站消息；命中(peer + user_id 过滤)并收集 → true，否则 false（不改状态） */
  tryDeliver(peer: string, msg: WaitCollectedMessage): boolean;

  /** dispose：结算全部活动等待为 cancelled */
  clear(): void;
}
```

内部状态机（每 peer 一个条目）：

```
registered(pending) --timeout timer 到期--
  ├─ messages.length === 0 → settle { ok:false, error:'timeout', message:'No messages received within the specified timeout' }
  └─ messages.length > 0   → settle { ok:true, messages }
registered --signal abort-- → settle { ok:false, error:'cancelled', message:'等待已中断（Agent 回合被取消）' }
settle → 清 timer、移除 registry 条目（一次性）、resolve
```

要点：
- **键空间**：peer 使用 `group_<gid>` / `user_<uid>`（与 `normalizePeer` 输出、`index.ts` 计算值一致）。
- **单线程竞态安全**：注册/投递/结算均为同步状态变更，消息事件与结算在同一事件循环内串行，无撕裂窗口；窗口结束瞬间的消息要么被收集、要么走正常流水线（条目已移除 → isWaiting false）。
- **user_id 过滤**：`String(opts.userId) === msg.user_id` 全等比较。
- **不收集自身消息**：`tryDeliver` 不感知 `isSelf`，由 5.2 门控在投递前排除（`isSelf` 判定在 index.ts 已有）。

### 5.2 `src/index.ts` —— 门控接线（装配点）

1. `apply()` 内实例化 `const waitRegistry = new MessageWaitRegistry();`
2. `registerAgentTools` options / `ToolExecutionContext` 增加 `waitRegistry` 字段透传。
3. `server.onMessage` 流水线在**斜杠命令分支之后、提问拦截之前**插入门控（命中即收集+抑制并 return，提问/审批/主动回复/唤醒全部不再执行）：

```ts
// —— 等待门控 (EN-005)：等待期间该 peer 所有新消息仅落库+进收集器；斜杠命令除外 ——
if (waitRegistry.isWaiting(peer)) {
  if (!isSelf && waitRegistry.tryDeliver(peer, {
    from: senderName, user_id: fromUser, content, time: timestamp,
  })) {
    const consumedMsgId = Number(event.message_id);
    if (consumedMsgId) {
      outboundBridge.trackInboundContext(peer, {
        msg_id: consumedMsgId, from_user: fromUser, is_group: isGroup,
      });
    }
  }
  return;
}
```

4. `server.onNotice` 的 poke 分支在 `dispatchWakeup` 前加同款抑制：`if (waitRegistry.isWaiting(peer)) return;`（poke 照常入库，不收集——收集器只收 message 事件，与需求"监听入站消息"一致；不触发新回合）。
5. `dispose` 块调用 `waitRegistry.clear()`（结算全部活动等待为 cancelled，防悬挂 Promise）。

### 5.3 `src/tools/index.ts` —— wait_for_user_messages 工具

**参数声明（defineTool）**：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `timeout` | number | 是 | 等待秒数，> 0 的有限秒数，Agent 自定（插件不做上限策略） |
| `user_id` | string | 否 | 群聊指定等待对象；私聊可省略（天然单用户） |

**执行逻辑**：

```ts
export async function waitForUserMessages(
  params: WaitForUserMessagesParams,
  context?: ToolExecutionContext
): Promise<WaitForUserMessagesResult> {
  // 1. 参数校验（状态层/依赖层）
  //    - timeout 缺失/非数字/<=0/非有限 → 状态层: '你需要指定有效的 timeout（等待秒数，>0）'
  //    - user_id 提供但格式非法(空串/非纯数字 QQ 号) → 依赖层: 'Unknown user_id, cannot wait for messages'
  //    - sessionId 无法解析出 qq peer（review-* 等）→ 状态层: '当前会话不是 QQ 会话，无法等待用户消息'
  //    - 私聊(user_*)且显式传入 user_id 且 ≠ 会话对方 → 依赖层: 'Unknown user_id, cannot wait for messages'
  //        （本地信息即可判定，零额外 API，符合"语法级校验"拍板）

  // 2. waitRegistry.wait(peer, { userId: params.user_id, timeoutMs: timeout*1000, signal: exec.signal })
  //    - 同 peer 已有活动等待 → 状态层: '当前会话已有一个进行中的消息等待，不能重复发起'

  // 3. settle 结果映射：
  //    ok:true  → { messages, total }（total = messages.length）
  //    timeout  → { success:false, error: 'No messages received within the specified timeout' }（不给建议）
  //    cancelled→ { success:false, error: '等待已中断（Agent 回合被取消）' }
}
```

**注册**：`registerAgentTools` 内新增第 7 个工具 `wait_for_user_messages`，`parameters` 如上表，`output.schema = { type:'json' }`，`render` 成功格式化消息列表文本 / 失败显示 error。peer 解析沿用 `exec.agent.session.id → normalizePeer`。**不声明 `timeoutMs`、不声明 `isConcurrencySafe`**（见 2.2）。

**两层报错原则落地**：

| 层级 | 触发 | 消息（按需求原文） |
|------|------|---------------------|
| 状态层 | 窗口到期且 0 条消息 | `No messages received within the specified timeout`（无建议，Agent 自推） |
| 依赖层 | user_id 非法/不存在（格式非法；私聊对象不符） | `Unknown user_id, cannot wait for messages` |
| 状态层(补充) | 参数缺失/非法、非 QQ 会话、同 peer 重复等待、回合取消 | 中文清晰文案（项目风格，见 5.3） |

### 5.4 异常路径与清理

- **Agent 回合取消**：`exec.signal` abort → 结算 cancelled → 状态层报错，工具正常返回（不抛未捕获异常）。
- **插件 dispose / 进程退出**：`waitRegistry.clear()` 结算全部活动等待；`server.stop()` 既有路径不变。
- **NapCat 断连**：等待与 NapCat 连接无关（消息来自 WS 事件），不需要额外分支；断连期间窗口照常到期。

## 6. 边界与竞态分析

| 场景 | 行为 |
|------|------|
| 窗口到期瞬间有消息在途 | 事件循环串行：先到收集、后到走正常流水线（条目已移除） |
| 等待期间用户发斜杠命令 (/clear 等) | 程序层照常执行并 return（不收集、不抑制之外），拍板 #2 明确除外 |
| 等待期间群聊他人发言/@机器人 | 抑制：仅落库不收集（user_id 过滤未命中）、不唤醒、不刷锚点 |
| 等待期间机器人自身消息回显 (message_sent) | 抑制 + 落库 + 跳过收集（isSelf）；原流水线本就不唤醒自身消息，无行为回归 |
| 等待期间被戳一戳 (poke) | 入库照常；不收集（非 message 事件）；跳过 dispatchWakeup |
| 同 peer 重复 wait（同一回合内理论不可达，防御性） | 状态层拒绝第二个；exclusive 调度保证同回合不并行 |
| user_id 合法但群里查无此人 | 语法级通过 → 窗口内自然收不到 → 超时状态层报错，Agent 自推 |
| 群聊不传 user_id | 收集该 peer 全部用户消息（自身消息除外） |
| 私聊不传 user_id | 收集会话对方全部消息（单用户） |
| 已收集消息后续的 read_chat_history | 照常可查（入库恒定），Agent 后续轮次上下文不丢 |

## 7. 测试策略（TDD 契约测试先行）

新增 `tests/contract/wait-for-messages.test.ts`，红线先行：

1. **Registry 收集**：wait 注册后 `tryDeliver` 命中 → settle 返回 `{messages,total}` 且字段完整（from/user_id/content/time）。
2. **超时无消息**：窗口到期 → 状态层 `'No messages received within the specified timeout'`，且无建议正文。
3. **user_id 过滤**：群聊 + userId → 仅该用户消息被收集（他人 tryDeliver=false 且不收集）。
4. **同 peer 重复等待** → `'wait-active'` 状态层拒绝。
5. **Abort 信号** → cancelled 结算（状态层取消文案），Promise 不悬挂。
6. **工具参数校验**：timeout 缺失/非法 → 状态层；user_id 格式非法 → 依赖层原文。
7. **私聊 user_id 对象不符** → 依赖层原文。
8. **工具执行**：直调 `toolDef.execute`（fake `exec.agent.session.id`），验证群聊/私聊 peer 解析与结果形态。
9. **装配闭环（bootDshNapcatBridge 真实装配）**：tools 注册表含 `wait_for_user_messages`；装配后经真实 WS 网关 + 模拟 NapCat 客户端推消息，验证门控行为——等待期间入站消息被抑制不产生唤醒（以"无重复 followup/唤醒"为断言面，参照 question-interception.test.ts 的装配模式）。
10. **清理**：`clear()` 结算活动等待；unregister 后 isWaiting=false。

> 红线测试先行，实现转绿走自然路径（AGENTS §3.4）；装配闭环不依赖 mock 桩替代（AGENTS §3.1）。

## 8. 提交与发布计划

1. `test: 增加 wait_for_user_messages 契约测试（红）` —— 仅契约测试文件
2. `feat: 实现 wait_for_user_messages 等待用户消息工具与消息桥接 (EN-005)` —— server.ts registry + tools/index.ts 工具 + index.ts 门控接线，契约转绿 + 装配闭环测试通过
3. 提交前 `pnpm typecheck` / `pnpm test` 全绿（仅相关用例），涉及真机路径按 PF-001 教训**必须 `pnpm build`** 并核对 dist 包含新工具（`grep -c wait_for_user_messages dist/tools/index.js`）

## 9. Out of Scope（不做）

- 静默间隔提前返回（拍板 #1 明确纯超时窗口）
- user_id 所在群的权威存在性 API 校验（拍板 #3 明确语法级）
- 收集 notice/poke/群文件上传等非 message 事件进收集器
- 等待期间提问/审批拦截保留（拍板 #2 明确全抑制）
- 对 timeout 做插件侧上限/下限策略（需求明确"插件不做限制策略"）