# 验收清单（Checklist）：send_message 主动发言工具 · QQ 动态段 · 出站旁白抑制 · 回合锚定修复

> **项目**: dsh-napcat-bridge
> **关联需求**: docs/需求文档-send_message主动发言工具.md（v0.1）
> **日期**: 2026-09-07
> **用法**: 每阶段/最终验收如实勾选；未完成项保持 `- [ ]` 空着，留给后续。

---

## A. send_message 工具

- [ ] A1 新增 `send_message { text: string }`（v1 仅单文本参数）
- [ ] A2 注册范围：**仅普通 QQ 会话**（qq-group-*/qq-user-*）；非 QQ 会话（WebUI）、Background Review、加好友专用 Session **不注册**
- [ ] A3 群聊 + 私聊均可使用（区别于 react_message 仅群聊）
- [ ] A4 走现有串行队列 + stripMarkdown；超长自动分段；成功返回 message_id
- [ ] A5 报错分支：空文本→"发送内容不能为空。"；NapCat 发送失败→"消息发送失败: {retcode/wording}"；无 QQ 会话→防御守卫；成功→{success, message_id, sent_preview}
- [ ] A6 工具描述按需求文档 §1.5

## B. QQ 会话动态段

- [ ] B1 新增动态段（如 napcat:qq_scenario），order 取最低（记忆 40/人格 50 之前，~10），排在动态段最前
- [ ] B2 仅 QQ 会话（qq-group-*/qq-user-*）返回内容；非 QQ 返回空串
- [ ] B3 段文本 = 需求文档 §2.2 定稿（"# 如何发送消息…必须调用 send_message 工具"）
- [ ] B4 不告知 turn/end 兜底（隐形安全网）

## C. 出站旁白抑制 + turn/end 兜底

- [ ] C1 与 tool-call 同条 assistant/message 的文本块**永不自动发送**（结构抑制，只留 Web UI）
- [ ] C2 每轮跟踪 send_message 调用次数；**0 次** → turn/end 自动补发终答（路径与现状一致）
- [ ] C3 **≥1 次** → 不自动补发，模型自管理输出
- [ ] C4 取舍接受：先 send 报进度后纯文本写终答 → 末尾文字不补发（Web UI 保留）
- [x] C5 实现前已核实：agent-loop 无工具文本=回合结束？终答取法；send_message 计数事件类型

## D. send_message 首调引用/艾特规则（本批新增）

- [ ] D1 **一轮内多次调用 send_message，仅首次调用**携带本轮锚定消息的引用（quote）/艾特（at）前缀
- [ ] D2 后续调用为**纯文本**，不再重复引用/艾特
- [ ] D3 单次调用场景行为不变（该次即首次，带前缀）

## E. 回合锚定修复（顺手修的 bug，本批必做）

- [x] E1 **回合锚点 = 本轮刚开始时的那条真实入站消息**，回合中途不被噪音覆盖
- [x] E2 emoji_like（贴表情）等 notice/合成 id 记录**不得成为引用对象**（修复"引用该消息不支持"）
- [x] E3 模型调 react_message 后回传的 group_msg_emoji_like 事件不覆盖本轮锚点
- [x] E4 终答/首次 send_message 引用的是**锚定消息**的 msg_id，绝不引用 emoji_like 合成 id
- [x] E5 锚定机制实现前已核实（事件路径：入站→turn 锚定→出站取锚点，emoji_like 在哪一步串扰）

## F. 契约测试与收尾

- [ ] F1 send_message：注册范围断言（QQ 会话可见/非 QQ 与沙箱不可见）、空文本/发送失败、成功含 message_id、走串行队列
- [ ] F2 动态段：QQ 会话出现该段文本 / 非 QQ 为空；order 位于最前
- [ ] F3 旁白抑制：带 tool-call 的文本不发出；纯终答发出
- [ ] F4 兜底：0 次 send → 终答补发；≥1 次 → 不补发
- [ ] F5 首调引用：同轮多次 send_message 仅首条带引用/艾特
- [x] F6 锚定修复：emoji_like 事件入站后，回复引用的仍是回合起始消息（真实装配测试）
- [ ] F7 pnpm test 全绿 + pnpm build 通过 + dist 含改动；未引入新 npm 依赖
- [ ] F8 真机验证项（如实标注未做/待验）：QQ 群实测多次 send 引用行为 + 贴表情后回复引用正常