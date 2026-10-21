# 已完成验收清单：表情回应（react_message）与设置卡 Tab 重构

> **归档日期**: 2026-10-22  
> **说明**: 原 `Checklist-表情回应与好友群管理工具及设置卡重构.md` 中的已打勾完成项，在此独立归档保存。

---

## A. 贴表情（Reaction）工具（已全部交付）

- [x] A1 开工前已与用户协调确认真实可用 emoji_id 参考集
- [x] A2 新增 Agent 工具 `react_message`：签名 `{ message_id?, emoji: enum[语义键] }`
- [x] A3 `message_id` 省略时默认 = 当前回合正在回复的那条入站消息
- [x] A4 `emoji` 为语义键枚举，内部映射为 NapCat `set_msg_emoji_like` 的 `emoji_id`
- [x] A5 工具描述忠实：「收到消息时可调用本工具，以表情回应。」
- [x] A6 仅群聊注册：私聊 Session 不注册、不可见
- [x] A7 无设置卡开关；是否使用由 Agent 依行为准则自决
- [x] A8 契约测试：仅群聊注册 / 私聊不注册、语义键映射、默认 message_id 绑定通过
- [x] A9 dist 已 build 且含 react_message

---

## E. Web UI 设置卡 Tab 重构（已全部交付）

- [x] E1 复用 DSH Web UI 现有组件，仅改布局，不自行设计新组件
- [x] E2 单卡 + 顶部 Tab 分区 + 底部全局「保存全部」
- [x] E3 Tab·连接身份：ws_port / ws_token / bot_qq / admins / aliases / image_ttl_days
- [x] E4 Tab·回复行为：quote_original / at_questioner
- [x] E5 Tab·人格与准则：persona / behavior
- [x] E6 Tab·主动回复：全部 proactive_*（8 项）
- [x] E7 Tab·记忆与回顾：memory_* / review_*
- [x] E8 Tab·工具权限：预留占位
- [x] E9 现有全部设置项迁移到对应 Tab，默认值不变、开关语义不变
- [x] E10 保存行为正确（改字段→保存落盘→重读生效）
- [x] E11 契约与 UI 测试全绿
- [x] E12 dist 已 build 且含重构
