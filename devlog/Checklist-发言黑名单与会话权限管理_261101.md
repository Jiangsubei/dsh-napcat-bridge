# Checklist：发言黑名单、新建会话权限与 Coding 工具组控制

> **文档定位**：开发与验收清单 (Checklist)  
> **创建日期**：2026-11-01  
> **关联 Spec**：[`devlog/规格设计-发言黑名单与会话权限管理_261101.md`](./规格设计-发言黑名单与会话权限管理_261101.md)

---

## 一、 契约测试先行阶段 (TDD Red)

- [x] **CHK-01: 配置契约与 Schema 对齐测试**
  - [x] 验证 `BridgeConfigSchema`、`src/server/routes.ts`、`src/client/card.tsx` 中新增 8 项配置键；
  - [x] 验证全量字段均配置 `.volatile()`；
  - [x] 更新 `tests/contract/settings-schema-alignment.test.ts` 使字段数与全等断言通过。
- [x] **CHK-02: 设置卡 Tab 分区契约测试**
  - [x] `SETTINGS_TABS` 增加 `security`（权限与安全），总 Tab 数量从 6 变更为 7；
  - [x] 更新 `tests/contract/settings-tabs.test.ts`，断言 `security` Tab 的按钮与面板渲染；
  - [x] 编写专门的 `tests/contract/security-settings-tab.test.ts` 契约测试用例。
- [x] **CHK-03: 发言黑名单门控契约测试**
  - [x] 编写私聊黑名单命中测试：消息落库（`db.saveMessage`）但后续中断、不唤醒、不回复；
  - [x] 编写群聊黑名单命中测试：消息落库但后续中断、不唤醒、主动回复静默；
  - [x] 编写管理员落入黑名单测试：即使为 `admins` 管理员，命中黑名单也一律阻断（管理员不豁免）。
- [x] **CHK-04: 新建会话权限模式装配契约测试**
  - [x] 编写私聊新建会话默认权限测试（默认 `workspace-write`）；
  - [x] 编写群聊新建会话默认权限测试（默认 `read-only`）；
  - [x] 编写自定义例外表覆盖测试（指定群/用户优先采用例外模式）；
  - [x] 验证会话 resume 恢复时不覆盖已有权限模式。
- [x] **CHK-05: Coding 工具组装载与硬隔离契约测试**
  - [x] 编写关闭 Coding 工具组会话测试：验证 `agentCtx.tools.restrict({ deny: [...] })` 被正确调用；
  - [x] 验证被裁剪工具（`bash`, `pwsh`, `read`, `write`, `edit`, `read_image`, `working_directory`）在 SystemPrompt assemble 的 tools 列表中不存在；
  - [x] 编写开启 Coding 工具组会话测试：验证 7 个 Coding 工具正常保留；
  - [x] 验证例外表覆盖逻辑在新建会话中生效。

---

## 二、 后端核心实现与装配阶段 (Green)

- [x] **CHK-06: 常量、类型与配置 Schema 落地**
  - [x] `src/constants/index.ts` 增加默认值常量；
  - [x] `src/types/index.ts` 增加黑名单、权限与工具组数据结构定义；
  - [x] `src/config/schema.ts` 定义 8 项新增配置字段。
- [x] **CHK-07: 入站发言黑名单门控接线**
  - [x] 在 `src/index.ts` 消息入库后插入黑名单拦截判定；
  - [x] 支持对象格式 `{ id, remark }` 与历史裸字符串兼容比对；
  - [x] 确保管理员同样严格拦截。
- [x] **CHK-08: 会话权限装配与 Coding 工具裁剪逻辑实现**
  - [x] 在 `src/gateway/session/agent-runner.ts` 中实现权限预设解析辅助函数；
  - [x] 在 `setupFn` 中装配 `tools.restrict`（当 Coding 开关关闭时）；
  - [x] 在 `agents.create` 成功后应用 `permissionPresets.set`。

---

## 三、 Web UI 客户端落地与全量验证

- [x] **CHK-09: Web UI 设置卡片与样式实现**
  - [x] `src/client/model.ts` 支持新增数组与枚举字段的 dirty/reset 跟踪；
  - [x] `src/client/card.tsx` 实现 `security` 分区 UI 面板；
  - [x] 实现黑名单列表组件、权限模式下拉框及例外表格组件。
- [x] **CHK-10: 契约测试 100% 转绿与生产构建闭环**
  - [x] 运行 `pnpm test`，确保相关契约测试 100% 全绿；
  - [x] 运行 `pnpm typecheck` 确认 TypeScript 类型无报错；
  - [x] 运行 `pnpm build` 并核验 `dist/` 编译产物，完成交付。
