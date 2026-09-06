# Todo：表情回应 · 好友/群管理工具 · 加好友Session · 审计日志 · 设置卡Tab重构

> **项目**: dsh-napcat-bridge
> **关联需求**: docs/需求文档-表情回应与好友群管理工具及设置卡重构.md（v0.1 定稿）
> **关联清单**: docs/Checklist-表情回应与好友群管理工具及设置卡重构.md
> **日期**: 2026-09-06
> **用法**: 每阶段如实打勾；未完成项保持 `- [ ]` 空着留给后续批次。

> **本批范围**：阶段 0-2 + 阶段 9（贴表情 + 设置重构）。阶段 3-8（好友/群/审计）为后续批次，本批不动。

---

## 阶段 0：表情 id 协调（本批 · 硬性门控）

- [x] 0.1 向用户汇报计划采用的「语义键 → emoji_id」候选集（含来源依据）
- [x] 0.2 等用户确认/提供实测可用的真实 emoji_id
- [x] 0.3 用户确认前不写死任何 emoji_id 映射

## 阶段 1：贴表情（Reaction）工具（本批）

- [x] 1.1 定义 `react_message` 工具 schema（message_id? / emoji 语义键枚举）
- [x] 1.2 语义键 → `emoji_id` 映射（用户确认的参考集）→ `set_msg_emoji_like`
- [x] 1.3 工具描述：「收到消息时可调用本工具，以表情回应。」
- [x] 1.4 仅群聊注册：经 tools.guard / 会话类型注册层，私聊不注册不可见
- [x] 1.5 message_id 默认绑定当前回合入站消息
- [x] 1.6 契约测试（仅群聊注册/私聊不注册、映射、默认绑定）
- [x] 1.7 typecheck + test + build；勾 A8/A9

## 阶段 2：Web UI 设置卡 Tab 重构（本批）

- [x] 2.1 改造 card.tsx：单卡 + Tab 分区 + 全局保存（复用 DSH 现有组件，不改样式）
- [x] 2.2 Tab·连接身份（6 项）
- [x] 2.3 Tab·回复行为（2 项）
- [x] 2.4 Tab·人格与准则（persona / behavior）
- [x] 2.5 Tab·主动回复（proactive_* 8 项）
- [x] 2.6 Tab·记忆与回顾（memory_* / review_*）
- [x] 2.7 Tab·工具权限：不渲染或空占位（判断并汇报）
- [x] 2.8 全部设置项迁移对应 Tab，默认值/语义不变
- [x] 2.9 保存行为验证 + 契约测试
- [x] 2.10 typecheck + test + build；勾 E1-E12

## 阶段 3：好友管理工具（后续批次，本批不做）

- [ ] 3.1 4 个好友管理工具（get_friend_list / set_friend_add_request / delete_friend / get_stranger_info）
- [ ] 3.2 好友管理全局总开关 + 细分；默认关

## 阶段 4：群管理工具（后续批次，本批不做）

- [ ] 4.1 6 个群管理工具（ban / whole_ban / kick / add_request / member_list / shut_list）
- [ ] 4.2 群管理按群白名单配置；默认全关；白名单外不注册

## 阶段 5：加好友专用 Session（后续批次，本批不做）

- [ ] 5.1 独立收件箱 Session + 阅后即焚
- [ ] 5.2 会话工具白名单沙箱（好友工具 + read_memory）
- [ ] 5.3 决策上下文注入（User Profile + friend_request_policy）
- [ ] 5.4 friend_request_policy 配置 + 默认两条原则

## 阶段 6：审计日志（后续批次，本批不做）

- [ ] 6.1 审计记录 Background Review + 加好友 Session 决策
- [ ] 6.2 存储 napcat/audit；阅后即焚先落盘再销毁
- [ ] 6.3 审计开关 + 格式定稿

## 阶段 7：friend_request_policy 输入框落 UI（后续批次，本批不做）

- [ ] 7.1 人格与准则 Tab 内加 friend_request_policy 多行输入框

## 阶段 8：工具权限 Tab（后续批次，本批不做）

- [ ] 8.1 好友管理（全局总开关+细分）
- [ ] 8.2 群管理（按群白名单：新增群 + 每群开关+细分）

## 阶段 9：收尾验收（本批）

- [x] 9.1 相关契约测试通过
- [x] 9.2 `pnpm test` 全绿、`pnpm build` 通过、dist 含改动
- [x] 9.3 逐项对照 Checklist A / E 勾选；B/C/D 保持未勾
- [x] 9.4 汇报：表情 id 协调结果、react_message 实现、设置卡 Tab 结构、测试/构建、未做项