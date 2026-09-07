# Todo：send_message 主动发言工具 · QQ 动态段 · 出站旁白抑制 · 回合锚定修复

> **项目**: dsh-napcat-bridge
> **关联需求**: docs/需求文档-send_message主动发言工具.md（v0.1）
> **关联清单**: docs/Checklist-send_message主动发言工具.md
> **日期**: 2026-09-07
> **用法**: 每阶段如实打勾；未完成项保持 `- [ ]` 空着。

---

## 阶段 0：调研核实（先行，写调研纪要进 docs）

- [x] 0.1 核实 DSH agent-loop：无工具调用的 assistant 文本消息是否 = 回合结束（决定终答识别）
- [x] 0.2 核实回合锚定机制现状：turnContexts/inboundContexts 如何被入站事件更新；emoji_like notice 入库后在哪一步串扰/覆盖锚点（E2/E3 根因）
- [x] 0.3 核实 send_message 计数可用事件（tool/call name 判定）与终答文本取法
- [x] 0.4 调研纪要落盘 docs/（含锚定 bug 根因定位）

## 阶段 1：回合锚定修复（先修 bug，独立原子提交）

- [x] 1.1 回合锚点 = 本轮开始时的真实入站消息，回合中途锁定不被覆盖
- [x] 1.2 emoji_like / notice 合成记录不得成为引用对象
- [x] 1.3 react_message 回传的 group_msg_emoji_like 事件不覆盖锚点
- [x] 1.4 契约测试：贴表情后回复仍引用回合起始消息（真实装配）

## 阶段 2：QQ 会话动态段

- [x] 2.1 新增动态段（order ~10 最前，仅 QQ 会话，非 QQ 空串）
- [x] 2.2 段文本 = §2.2 定稿
- [x] 2.3 契约测试：QQ 会话含该段 / 非 QQ 为空 / order 最前

## 阶段 3：send_message 工具
 
- [x] 3.1 工具实现（单 text 参数、走串行队列 + stripMarkdown、超长分段、返回 message_id）
- [x] 3.2 注册范围：仅普通 QQ 会话（群+私）；沙箱/非 QQ 不注册
- [x] 3.3 报错三分支 + 防御守卫；工具描述 §1.5
- [x] 3.4 契约测试（注册范围/报错/成功/队列）

## 阶段 4：出站旁白抑制 + turn/end 兜底

- [x] 4.1 与 tool-call 同块文本永不自动发送（结构抑制）
- [x] 4.2 每轮 send_message 计数；0 次 → turn/end 补发终答（路径与现状一致）；≥1 → 不补发
- [x] 4.3 契约测试：旁白不发出 / 兜底两分支

## 阶段 5：send_message 首调引用规则

- [x] 5.1 一轮多次 send_message：仅首次带锚定消息引用/艾特前缀，后续纯文本
- [x] 5.2 单次调用行为不变
- [x] 5.3 契约测试：多调场景仅首条带前缀

## 阶段 6：收尾验收

- [x] 6.1 全量 pnpm test 绿 + pnpm build 通过 + dist 含改动
- [x] 6.2 逐项对照 Checklist A-F 勾选；未做项空着
- [x] 6.3 汇报：调研纪要、锚定 bug 根因与修复、实现项、测试/构建、真机待验项

---

> **注（2026-09-07 工具更名解耦）**：工具名正式确立为 `send_qq_message`，彻底消除与 DSH 内置子代理工具的命名冲突，无需对全局工具表进行 hack 拦截或删除。