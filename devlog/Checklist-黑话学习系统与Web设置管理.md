# Checklist: 黑话学习系统与 Web 设置管理

本文档追踪黑话学习系统与 Web 设置管理套件的交付进度，严格遵循 TDD、红线契约测试先行与生产装配验证规范。

---

## 阶段一：契约测试与数据层设计 (TDD Contract First)
- [x] **1.1 类型定义与配置扩展**
  - [x] 在 `src/types/index.ts` 补充 `SlangEntry`, `RecordSlangParams`, `ManageSlangParams`, `SlangListResult`, `BridgePluginConfig` 扩展字段
  - [x] 在 `src/config/schema.ts` 扩充 `slang_enabled`, `slang_budget_chars`, `slang_storage_path` 配置项定义
- [x] **1.2 存储层契约测试 (`tests/contract/slang-storage.test.ts`)**
  - [x] 编写 Markdown 解析器（`parseSlangMarkdown`）与序列化器（`formatSlangMarkdown`）测试用例
  - [x] 编写 `SlangStorage` 增删改查、原子落盘、并发锁契约测试
  - [x] 编写预算硬拦截（5000 字符上限拒绝超额写入）契约测试 (13/13 passed)
- [x] **1.3 实现存储层 `src/slang/storage.ts`**
  - [x] 实现 `SlangStorage`，确保契约测试全部通过

---

## 阶段二：Agent 工具集与上下文注入 (Tools & Prompt Context)
- [x] **2.1 工具契约测试 (`tests/contract/slang-tools.test.ts`)**
  - [x] `record_slang` 工具注册、自然语言描述、参数结构校验与写入契约测试
  - [x] `manage_slang` (list, edit, delete) 工具行为与关键词模糊检索契约测试
  - [x] 工具调用超预算时的友好报错与引导契约测试 (12/12 passed)
- [x] **2.2 实现工具层 `src/slang/tools.ts`**
  - [x] 实现 `recordSlang` 与 `manageSlang` 处理函数，创建 `createSlangToolDefinitions`
- [x] **2.3 动态 Prompt 注入与装配实现 (`src/slang/index.ts`)**
  - [x] 实现 `registerSlangPromptContext` 注入 `napcat:slang`，order: 45
  - [x] 实现 `setupSlangService`，集成存储、工具与上下文注册

---

## 阶段三：HTTP REST API 路由与 Web UI 卡片 (Routes & Client Card)
- [x] **3.1 HTTP REST 路由契约测试 (`tests/contract/slang-routes.test.ts`)**
  - [x] 编写 `GET /plugins/dsh-napcat-bridge/slang` 列表查询测试
  - [x] 编写 `POST /plugins/dsh-napcat-bridge/slang/edit` 条目修改测试
  - [x] 编写 `POST /plugins/dsh-napcat-bridge/slang/delete` 条目删除测试 (4/4 passed)
- [x] **3.2 实现 REST 路由 `src/server/slang-routes.ts`**
  - [x] 挂载到应用服务路由表中，支持跨域与状态上报
- [x] **3.3 Web UI 设置卡扩充 (`src/client/card.tsx`)**
  - [x] 在 `SettingsTabId` 增加 `'slang'` Tab
  - [x] 渲染黑话词条列表、容量进度条，复用 `IconEdit` 与 `IconTrash` 进行行内编辑与删除 (`tests/contract/slang-settings-tab.test.ts` 3/3 passed)

---

## 阶段四：系统装配与全量验证 (Assembly & Verification)
- [x] **4.1 运行时装配接线与会话生命周期门控**
  - [x] 在 `src/tools/index.ts` 中根据 `slang_enabled` 门控装配 `record_slang` 与 `manage_slang`
  - [x] 在 `src/index.ts` 中初始化 `setupSlangService`，注册 REST API 路由与插件销毁清理
- [x] **4.2 装配闭环契约测试 (`tests/contract/slang-assembly.test.ts`)**
  - [x] 验证会话工具装配路径可达与开关生效 (3/3 passed)
  - [x] 验证 `systemPrompt.context` 真实注册 `napcat:slang` (order: 45) 且内容实时同步
- [x] **4.3 编译与构建验证**
  - [x] `pnpm typecheck` 编译无报错
  - [x] 35 个相关黑话契约测试 100% 通过
  - [x] `pnpm build` 确认产物 `dist/` 包含最新逻辑与 Client UI 产物
