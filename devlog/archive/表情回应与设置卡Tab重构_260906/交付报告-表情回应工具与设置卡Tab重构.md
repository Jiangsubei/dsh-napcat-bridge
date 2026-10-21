# 交付报告：表情回应工具（react_message）与 Web UI 设置卡 Tab 重构

- **归档日期**：2026-10-22（原开发日期：2026-09-06）
- **功能范围**：
  1. 贴表情回应工具（`react_message`）
  2. Web UI 设置卡 Tab 分区重构
- **交付状态**：已交付并稳定运行，从活跃待办中剥离归档

---

## 1. 贴表情（Reaction）工具（`react_message`）

### 实现要点
1. **工具签名**：
   - 工具名：`react_message`
   - 参数：`{ message_id?: number, emoji: enum[语义键] }`
   - 描述：「收到消息时可调用本工具，以表情回应。」
2. **入站绑定**：
   - `message_id` 省略时默认自动绑定当前回合正在回复的那条入站消息；
3. **语义键映射**：
   - 内部维护 `EMOJI_MAP`（包含 `thumbs_up`, `heart`, `laugh`, `doge`, `ok` 等 26 个语义表情键），映射为 NapCat 的 `set_msg_emoji_like` 真实 `emoji_id`；
4. **会话门控**：
   - 仅群聊注册并可见，私聊不注册；
   - 无全局开关，由 Agent 依据行为准则自决。

---

## 2. Web UI 设置卡 Tab 分区重构

### 实现要点
1. **单卡 + Tab 布局**：
   - 复用 DSH 官方 Web UI 原生组件（`ValueField`, `Multiline`, `SwitchField`），放弃单列长表单；
   - 顶部提供 Tab 切换，底部提供全局统一「保存全部」（单次 `settingsScope.mutate`）；
2. **Tab 分区划分**：
   - **连接身份**：`ws_port`, `ws_token`, `bot_qq`, `admins`, `aliases`, `image_ttl_days`
   - **回复行为**：`quote_original`, `at_questioner`
   - **人格与准则**：`persona`, `behavior`
   - **主动回复**：`proactive_*` 8 项参数
   - **记忆与回顾**：`memory_*`, `review_*`
   - **工具权限**：留空或预留给后续权限配置
3. **兼容性与持久化**：
   - 默认值与字段存储语义保持 100% 兼容不变。
