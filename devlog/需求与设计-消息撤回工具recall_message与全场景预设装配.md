# 需求与设计规范：消息撤回工具 recall_message 与全场景预设装配

## 1. 背景与目标

当前 `dsh-napcat-bridge` 拥有丰富的出站表达能力（`send_qq_message`、`send_file`、`send_face`、`react_message` 等），但缺乏出站消息撤回能力。当发生以下场景时，Bot 无法及时自纠或协助管理：
1. **自我纠错**：Bot 生成了包含幻觉、排版错乱、隐私信息或事实性严重错误的消息；
2. **用户指令响应**：用户发现 Bot 回答有误或发错群，明确发出指令“撤回你刚才说的”；
3. **群管场景**：在具备群管理员/群主身份的群聊中，Bot 需代为撤回群员的违规刷屏、广告发言。

目标：提供统一、纯粹且轻量的 `recall_message` 工具，接入 OneBot 11 底层 `delete_msg`，装配至全场景 QQ 会话预设，并如实透传底层校验结果。

---

## 2. 设计原则与平台契约

### 2.1 极简纯粹与平台鉴权信任 (KISS 原则)
- **动作唯一性**：OneBot 11 无论撤回自己还是群员的消息，底层动作均为 `delete_msg({ message_id: number })`。
- **不设冗余防御**：不在客户端做繁琐脆弱的预校验（如发送者身份校验、时间戳计算等）。QQ 协议端与 NapCat 服务端自身具备权威、严密的权限与时效（2 分钟）判定规则。
- **如实反馈**：执行成功时返回成功提示；平台拦截报错时（如超时、无权限、消息不存在等），将错误原因如实返回给模型。

### 2.2 串行化保障 (Serial Sending)
- 撤回动作经由 `PerPeerSerialSender` 队列调度，确保同会话内的“发信 $\rightarrow$ 撤回”严格按序到达网关，避免异步网络竞态导致撤回抢先于发信。

### 2.3 Lossless JSON 红线
- 严格遵循 DSH Lossless JSON 约束，使用 `toLosslessJson` 清洗输出，严禁包含 `undefined` 字段。

---

## 3. 详细接口设计

### 3.1 Gateway 网关层
`NapCatGatewayServer` 增加方法：
```ts
async deleteMsg(messageId: number | string): Promise<OneBotActionResponse>;
```
底层发送 action: `'delete_msg'`，参数 `{ message_id: Number(messageId) }`。

### 3.2 工具层契约
- **工具名称**：`recall_message`
- **入参定义**：
  ```ts
  export interface RecallMessageParams {
    message_id: number | string;
  }
  ```
- **出参定义**：
  ```ts
  export interface RecallMessageResult {
    success: boolean;
    message?: string;
    error?: string;
  }
  ```
- **参数校验**：
  - 校验 `message_id` 非空且能被解析为合法安全整数 (`Number.isSafeInteger`)；
  - 校验 Gateway 已连接；
  - 校验必须在有效会话上下文或提供 target peer。

### 3.3 预设与 Prompt 接入
- `dsh-napcat-bridge/tools` 包含 `recall_message`；
- 更新 `DEFAULT_BEHAVIOR`（`src/constants/index.ts`），声明 `recall_message` 的使用规范；
- 更新 `QQ_PRESET_PERSONA_PREFIX`（`src/constants/preset.ts`），并在构建阶段由 `scripts/sync-patch.ts` 同步至 `cordis.patch.yml`。
