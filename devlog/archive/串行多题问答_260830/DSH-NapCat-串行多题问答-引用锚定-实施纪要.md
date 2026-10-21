# 实施纪要 — QQ 提问渠道：串行多题问答状态机 + 群聊引用锚定 + 卡片分场景展示

> **性质**：实施纪要（implementation memo），随本批次整改落地。
> **关联代码**：`src/approval/responder.ts`（`NapCatQuestionProvider` 串行状态机）、`src/index.ts`（入站拦截接线）。
> **契约测试**：`tests/contract/question-serial.test.ts`（10 例）、`tests/contract/question-interception.test.ts`（装配级 1 例）、
> `tests/contract/questions-approval.test.ts` / `tests/contract/serial-queue.test.ts`（依新契约修订）。

---

## 1. 背景与根因（用户实测 + 已定位）

1. **QQ 私聊提问不回**：composite provider 正常下发卡片，但用户回数字序号时消息未被
   `NapCatQuestionProvider` 消费（`src/index.ts` 入站链 `questionProvider.handleInboundReply` 从未被调用，
   仅审批拦截在链上），提问 promise 长期 pending，数字被当普通消息进等待队列。根因：提问拦截是
   「单测通、装配断」的孤岛。
2. **Web UI 自定义答案恒在场**：官方协议层（`dsh-user-questions/types`）答案结构
   `{id, selected: string[], custom?: string}` 恒支持自定义，工具参数无「允许自定义」开关 →
   底层永远允许自定义（用户拍板：不做「有无自定义」判定，恒带自定义标记项）。

## 2. 需求规格（用户已拍板，实施严格照此）

### 2.1 串行多题问答状态机（核心重构）
- agent 一次传 N 道题 → 只渲染第 1 题卡片，挂起等该题答案；
- 答完当前题 → **不 resolve 不丢 agent**，缓存该题 answer，立即渲染下一题；
- 逐题推进，最后一道答完 → 一次性 `resolve({answers:[题1…题N]})` 交回 agent；
- 全程 agent 只等待一次；abort signal 任一节点 → 清理 pending + reject。

### 2.2 回复解析（越界数字不判定，当自定义）
- 单选：纯数字串命中 `[1,选项数]` → `selected=[label_N]`；否则整体当 `custom`；
- 多选（multiSelect）：英文逗号分隔；数字段命中区间 → 各进 `selected`；非数字/越界段 → 拼接 `custom`；
- 越界数字不提示重答、不做判定（自定义恒在场，`5` 是合法输入）；
- 单选/多选/纯自定义输入框（无 options）三态全覆盖。

### 2.3 卡片分场景展示（2 档，恒带自定义）
- 私聊：`【请回答问题】` + 题文 + `detail` + `选项:`逐行 + 恒拼「自定义回答」标记项 +
  `请直接回复数字序号选择对应选项，或输入你的答案`；
- 群聊：同上，操作提示换 `请引用本消息并回复数字序号选择对应选项，或输入你的答案`；
- 「自定义回答」标记项**参与展示但不参与数字匹配**（不占数字位）。

### 2.4 群聊引用锚定（用户选 A 方案）
- 群聊：只有「引用**当前提问卡片那条消息**」的回复才 resolve 当前题；否则当普通消息
  （可进唤醒/队列）；多题串行每题各自锚定自己的卡片；
- 实现：`ask()` 下发单题卡片后缓存该题消息的 QQ `message_id`，入站用引用 id 精确匹配；
- 私聊不需要引用锚定，直接回数字。

### 2.5 拦截顺序（用户拍板）
存库 → 斜杠命令（命令优先不被吞）→ **提问拦截**（命中返回 true 直接 return）→ 审批 y/n → 唤醒判定。

## 3. 实现设计

### 3.1 `NapCatQuestionProvider` 串行状态机（`src/approval/responder.ts`）
- `PendingSerialQuestion`：`{request, peer, isGroup, cardMessageId, answers[], index, resolve, reject}`；
  `pendingByPeer` 维持 per-peer 单挂起语义。
- `ask()`：校验（aborted / peer / gateway / questions 非空）→ 构造 pending 先入表（快速回复不错失）
  → 下发第 1 题卡片；发送失败/群聊拿不到 message_id → reject（绝不永久 pending，B4）。
- `sendCurrentCard()`：每次只发当前题卡片，经共享 per-peer 串行队列（Spec §7.3），
  缓存 `resp.data.message_id`；**群聊拿不到 message_id 视为下发失败**（宁可 reject 不静默挂起）。
- `handleInboundReply(peer, text, {replyId})`：群聊先做引用锚定匹配
  （未引用 / 引用非当前卡片 → `false`，当普通消息），再对当前题解析；答完最后一道 → 一次性 resolve；
  否则推进 `index` 并串行发下一题；中间任何一题下发失败 → reject 整个串行。
- `formatQuestionCard(q, isGroup)`（static）：2 档卡片拼接，恒拼「自定义回答」标记项。
- `parseAnswerForQuestion(q, text)`（static）：单选/多选/纯自定义三态解析（纯数字串匹配，越界当自定义）。

### 3.2 入站链接线（`src/index.ts`）
在斜杠命令拦截之后、审批拦截之前插入：

```ts
const questionConsumed = questionProvider.handleInboundReply(peer, content, { replyId: replyId ?? undefined });
if (questionConsumed) { logger.info(...); return; }
```

异常兜底：拦截抛错仅记日志，不吞消息、不误答（继续走审批/唤醒正常流转）。

### 3.3 装配可达性
headless boot 下插件经官方 `registerProvider` 注册 `NapCatQuestionProvider`（TD-001 既有接线），
装配测试直接以 `booted.ctx.userQuestions.provider` 为被拦截实体做真实 WS 全链路验证。

## 4. 测试覆盖（全部引用 src 真实模块）

| 文件 | 覆盖点 |
|---|---|
| `question-serial.test.ts` | 3 题逐题答完一次性 resolve 3 答案（每次只发当前题卡片）；群聊未引用/引用错误/引用当前卡片三分支；每题锚定自己的卡片；abort 串行中途 reject + pending 清理；群聊缺 message_id reject；单选序号命中/越界当 custom；多选分段（命中+越界+非数字混合，越界数字当自定义）；纯自定义输入框；私聊/群聊 2 档卡片 + 自定义标记不占数字位；无选项卡片 |
| `question-interception.test.ts` | **装配级**：boot 挂插件 → 真实 WS 网关 + 模拟 NapCat 客户端，群聊引用锚定 message_id 缓存+匹配、串行 2 题经真实消息流逐题推进、负例（未引用/引用错误卡片不发下一张、不 resolve） |
| `questions-approval.test.ts` B4/A3-契约 4 | 修订为群聊新契约：未引用不 consume + 引用卡片 message_id 闭环 |
| `serial-queue.test.ts` A3-契约 4 | 修订为群聊新契约：正文→提问→审批保序中提问回复带引用锚定 |

## 5. 需真机 `dsh web`+NapCat 验证（如实标注，未声称已验）

1. **群聊引用锚定真机表现**：NapCat 侧「引用本消息回复」是否按预期解析出 reply 段
   （OneBot 11 reply 段 `data.id` 与发送返回 `message_id` 的数值形态一致性）；
2. **串行多题真机表现**：3 道题逐题卡片下发/引用/答完，agent 端一次性收到 3 答案；
3. **私聊免引用直答**真机验证；
4. **卡片排版**：私聊/群聊两档文案在 QQ 客户端的实际显示。