# 验收清单（Checklist）：表情回应 · 好友/群管理工具 · 加好友Session · 审计日志 · 设置卡Tab重构

> **项目**: dsh-napcat-bridge
> **关联需求**: docs/需求文档-表情回应与好友群管理工具及设置卡重构.md（v0.1 定稿）
> **日期**: 2026-09-06
> **用法**: 每阶段/最终验收时如实勾选；**未完成项保持 `- [ ]` 空着，留给后续批次**，不伪造完成。

> **本批范围**：仅「贴表情工具」+「设置卡重构」。好友/群管理、加好友Session、审计 为后续批次（`- [ ]` 保留，本批不做）。

---

## A. 贴表情（Reaction）工具 —— 本批

- [x] A1 开工前已与用户协调确认**真实可用 emoji_id 参考集**（不得自行猜测/探针定死）
- [x] A2 新增 Agent 工具 `react_message`：签名 `{ message_id?, emoji: enum[语义键] }`
- [x] A3 `message_id` 省略时默认 = 当前回合正在回复的那条入站消息
- [x] A4 `emoji` 为语义键枚举（用户确认的参考集），内部映射为 NapCat `set_msg_emoji_like` 的 `emoji_id`
- [x] A5 工具描述忠实：「收到消息时可调用本工具，以表情回应。」
- [x] A6 仅群聊注册：私聊 Session 不注册、不可见（经 tools.guard / 会话类型注册层）
- [x] A7 无设置卡开关；是否使用由 Agent 依行为准则自决
- [x] A8 契约测试：仅群聊注册 / 私聊不注册、语义键映射、默认 message_id 绑定
- [x] A9 dist 已 build 且含 react_message

## B. 好友管理 / 群管理工具（含开关）—— 后续批次（本批不实现）

- [ ] B1 好友管理工具：好友列表查询 `get_friend_list` / `get_friends_with_category`
- [ ] B2 好友管理工具：同意/拒绝好友请求 `set_friend_add_request`
- [ ] B3 好友管理工具：删除好友 `delete_friend`
- [ ] B4 好友管理工具：查询陌生人信息 `get_stranger_info`
- [ ] B5 好友管理全局总开关 + 细分开关（`friend_management_enabled`），默认关，关=工具不注册
- [ ] B6 群管理工具：禁言/解除 `set_group_ban`
- [ ] B7 群管理工具：全员禁言 `set_group_whole_ban`
- [ ] B8 群管理工具：踢人 `set_group_kick`
- [ ] B9 群管理工具：同意/拒绝加群请求 `set_group_add_request`
- [ ] B10 群管理工具：群成员列表 `get_group_member_list`
- [ ] B11 群管理工具：禁言列表 `get_group_shut_list`
- [ ] B12 群管理**按群白名单**配置：`group_management` 每群 enabled + 细分 tools；白名单外不注册
- [ ] B13 不做运行时审批（开关前置门控）；默认全关

## C. 加好友专用 Session —— 后续批次（本批不实现）

- [ ] C1 好友请求（request 事件）走独立专用 Session（peer 形如 `friend_requests` 单一收件箱）
- [ ] C2 阅后即焚：处理完删除临时 Session（同 Background Review）
- [ ] C3 会话工具白名单（沙箱，类似 `ALLOWED_MEMORY_REVIEW_TOOLS`）：仅好友管理工具 + `read_memory`；**不注册**通用工具
- [ ] C4 决策上下文注入：请求者跨场景 User Profile + `friend_request_policy`
- [ ] C5 `friend_request_policy` Web UI 多行输入框；**默认兜底两条核心原则**（无画像一般不加/理由合理可加；不因冲突拒除非画像显式标不可信）
- [ ] C6 应用层不做决策兜底（赋能不代决），只忠实记录
- [ ] C7 决策行动：Agent 调 `set_friend_add_request(flag, approve)`
- [ ] C8 暂不做同意时填备注

## D. 后台审计日志 —— 后续批次（本批不实现）

- [ ] D1 Background Review 会话可后台审计（Agent 干了什么/决策）
- [ ] D2 加好友专用 Session 可后台审计
- [ ] D3 日志存放 `napcat` 顶层目录（如 `napcat/audit/`，与 `napcat_memory` 同级）
- [ ] D4 阅后即焚时序：决策日志先持久落盘、再销毁临时 Session
- [ ] D5 日志格式/记录字段（待细化）
- [ ] D6 审计开关 `audit_log_enabled`（默认值待定）

## E. Web UI 设置卡 Tab 重构 —— 本批

- [x] E1 复用 DSH Web UI 现有组件（ValueField/Multiline/SwitchField），仅改布局，不自行设计新组件
- [x] E2 单卡 + 顶部 Tab 分区 + 底部全局「保存全部」（跨 Tab 一次 settingsScope.mutate）
- [x] E3 Tab·连接身份：ws_port / ws_token / bot_qq / admins / aliases / image_ttl_days
- [x] E4 Tab·回复行为：quote_original / at_questioner
- [x] E5 Tab·人格与准则：persona / behavior
- [x] E6 Tab·主动回复：全部 proactive_*（8 项）
- [x] E7 Tab·记忆与回顾：memory_* / review_*
- [x] E8 Tab·工具权限：本批无实际内容——不渲染或留空占位（是否留由实现者判断并汇报，倾向不渲染）
- [x] E9 现有全部设置项迁移到对应 Tab，**默认值不变、开关语义不变**
- [x] E10 保存行为正确（改字段→保存落盘→重读生效）
- [x] E11 契步骤/UI 测试：Tab 切换、字段迁移、保存
- [x] E12 dist 已 build 且含重构

---

## F. 通用验收（每批收尾）

- [x] F1 相关契约测试全部通过
- [x] F2 `pnpm test` 全绿
- [x] F3 `pnpm build` 通过，dist 含本次改动
- [x] F4 未引入新 npm 依赖
- [x] F5 无与本次无关的改动混入提交