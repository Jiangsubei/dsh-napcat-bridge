# Checklist: 消息撤回工具 recall_message 与全场景预设装配

## 阶段 1: 契约测试先行 (TDD)
- [x] 1.1 网关层契约测试：在 `tests/contract/gateway-actions.test.ts` 中补充 `deleteMsg` 发送 `delete_msg` action 的契约用例
- [x] 1.2 工具层与装配契约测试：创建 `tests/contract/recall-message.test.ts`
  - [x] 1.2.1 真实装配断言：群聊与私聊会话均可成功装配 `recall_message` 工具；WebUI 会话安全排除
  - [x] 1.2.2 基础功能契约：正常传入数字/字符串数字，成功调用 gateway 并返回无损 JSON
  - [x] 1.2.3 异常校验契约：缺少参数、非法 ID、网关断开、底层平台报错（如超时/无权限）正确反馈
  - [x] 1.2.4 串行队列保证：调用通过 `PerPeerSerialSender` 调度
  - [x] 1.2.5 Lossless JSON 检验：输出结果完全无 `undefined` 字段

## 阶段 2: 核心代码实现
- [x] 2.1 网关层：在 `src/gateway/server.ts` 中实现 `deleteMsg(messageId)`
- [x] 2.2 工具层：在 `src/tools/index.ts` 中定义 `RecallMessageParams`、`RecallMessageResult`、`recallMessage` 函数及 `defineTool` 注册
- [x] 2.3 预设与提示词：
  - [x] 更新 `src/constants/index.ts` 中的 `DEFAULT_BEHAVIOR`
  - [x] 更新 `src/constants/preset.ts` 中的提示词或预设描述
  - [x] 运行 `scripts/sync-patch.ts` 同步 `cordis.patch.yml`

## 阶段 3: 验证与交付
- [x] 3.1 运行契约测试，确认由红转绿
- [x] 3.2 运行全量 `pnpm typecheck`
- [x] 3.3 运行相关契约测试验证通过性 (5 个测试套件，41 项断言 100% 绿灯)
- [x] 3.4 运行 `pnpm build` 并核验 `dist/` 产物包含 `recall_message`
- [x] 3.5 Git 原子化规范提交
