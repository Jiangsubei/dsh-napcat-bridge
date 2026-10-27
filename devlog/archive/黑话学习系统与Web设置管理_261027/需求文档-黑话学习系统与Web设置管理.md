# 需求文档：黑话学习系统与 Web 设置管理 (Slang Learning & Management)

## 1. 背景与目标

在社群交流（QQ 群聊与私聊）中，网络热梗、圈内缩写、特定调侃及代称（统称“黑话”）演化迅速、使用广泛，且大多数基座 LLM 缺乏实时或特定圈层的最新知识。
现有的 `Memory` 套件主要面向**单会话规则**（`session/<peer>.md`）与**单用户画像**（`user/<qq>.md`），二者均具备强隔离性。然而，社群黑话天然具有**跨会话可复用**与**全域泛化**的特征：一旦 Agent 习得某一黑话条目，在所有群聊与私聊中均应能够理解并恰当使用。

为满足这一需求，本项目引入与 `Memory` 并列的原生套件——**黑话学习系统（Slang Suite）**，包括：
1. **纯 Markdown 存储与原子落盘**：持久化保存于单一全局文件（默认 `.dsh/napcat/slang/slang.md`），保证人机同构与磁盘透明可查；
2. **结构化参数约束**：通过代码模板强收敛词条、释义与例句，硬性剔除闲聊废话；
3. **字符预算与防爆管理**：默认提供 5000 字符预算，并在写入超额时实施硬拦截；
4. **会话级生命周期门控**：对齐 `face_enabled` 模式，开关 `slang_enabled` 作用于新会话工具装配；
5. **动态上下文注入**：以 `systemPrompt.context` 注册 `napcat:slang`，跟随会话按需全量注入；
6. **Web UI 可视化管理与人工兜底**：在设置面板新增黑话管理卡片，复用现有编辑/删除组件与 REST API，支持条目列表展示、行内编辑与一键删除，形成“Agent 自由学习 + 人工可视化治理”的闭环。

---

## 2. 核心架构设计

### 2.1 整体架构与数据流图

```
┌─────────────────────────────────────────────────────────────┐
│                       Agent Session                         │
│                                                             │
│   调用 record_slang / manage_slang                          │
└───────────────┬─────────────────────────────────────────────┘
                │ (结构化参数: term, definition, example)
                ▼
┌─────────────────────────────────────────────────────────────┐
│                 SlangStorage (存储管理器)                   │
│                                                             │
│   1. 双向转换: Markdown 文本 <-> SlangEntry 结构化数组      │
│   2. 字符预算硬约束 (默认 5000 字符, 超额拒绝写入并提示)     │
│   3. 并发锁 (Promise Lock) + 原子落盘 (atomicWriteFile)      │
└───────────────┬───────────────────────────────┬─────────────┘
                │                               │
                ▼ (写入/读取)                   ▼ (动态段装配)
┌───────────────────────────────┐ ┌───────────────────────────┐
│       .dsh/napcat/slang/      │ │    systemPrompt.context   │
│           slang.md            │ │       (napcat:slang)      │
│   (人类可读的紧凑 Markdown)   │ └─────────────┬─────────────┘
└───────────────▲───────────────┘               │
                │                               ▼
                │ (REST API: 查询/编辑/删除)    ┌───────────────────────────┐
┌───────────────┴───────────────┐               │     LLM 运行时 Context     │
│   Slang HTTP REST Routes      │               └───────────────────────────┘
│   /plugins/dsh-napcat-bridge/ │
│           slang               │
└───────────────▲───────────────┘
                │ (Fetch / JSON)
┌───────────────┴───────────────┐
│     Web UI 设置面板 (Card)    │
│     SettingsTabId: 'slang'    │
│  (复用 IconEdit / IconTrash)   │
└───────────────────────────────┘
```

---

## 3. 功能详细规格

### 3.1 词条格式与存储契约
单条黑话在 Markdown 文件中采用严格的紧凑格式存储：
```markdown
- **{term}**：{definition}（例：{example}）
```
- **格式规范**：
  - 每条独立成行，无多余空行；
  - 词条名通过 `**{term}**` 加粗包裹；
  - 冒号为全角中文冒号 `：`；
  - 例句包裹在中文括号 `（例：{example}）` 中；
- **存储文件路径**：
  - 默认路径：`.dsh/napcat/slang/slang.md`（支持通过 `slang_storage_path` 配置覆盖，遵循 `resolveDshPath` 规则）。

### 3.2 字符预算控制
- **配置项**：`slang_budget_chars`（默认 `5000` 字符）；
- **预算硬拦截**：
  - 当添加或修改词条导致整个文件总字符数超过预算上限时，工具执行抛出明确错误：
    `黑话知识库已达字符预算上限 (${current}/${limit})，请先使用 manage_slang 删除过时条目或合并简化现有条目后再添加。`
- **动态 Prompt 注入**：
  - 注入前进行安全截断或完整注入（5000 字符以内全量注入）。

### 3.3 配置项定义 (BridgeConfigSchema)
在 `src/config/schema.ts` 扩充以下字段：
1. `slang_enabled: z.boolean().default(true).volatile().description('控制新建会话是否装载黑话工具集与注入黑话上下文，对后续新会话生效')`
2. `slang_budget_chars: z.number().default(5000).volatile().description('黑话知识库字符预算上限 (默认 5000 字符)')`
3. `slang_storage_path: z.string().default('.dsh/napcat/slang/slang.md').volatile().description('黑话 Markdown 文档保存路径 (默认 .dsh/napcat/slang/slang.md)')`

---

## 4. Agent 工具集规格

### 4.1 `record_slang`（记录黑话）
- **工具名称**：`record_slang`
- **工具描述**：
  > 记录并收录跨会话通用的网络梗、社群黑话、圈内缩写或特色代称。用于在用户主动解释某个新词新梗的含义、纠正认知，或在交流中发现值得长期记住的高频黑话表达时调用；黑话跨所有群聊与私聊全局复用。仅需提取最核心的词条名称、凝练释义与简短例句，严禁记录闲聊流水账、对话背景琐事或多余修饰，保持极高信息密度与紧凑度。已存在的黑话词条若需修改请使用 manage_slang。
- **参数规格**：
  - `term` (string, required): 核心黑话/梗/词条名称（必填，如“牢大”、“电子阳痿”、“开香槟”等，保持简短原生）
  - `definition` (string, required): 词条核心释义与含义（必填，用一两句话凝练概括，切勿写闲聊废话）
  - `example` (string, required): 典型的使用场景或代表性简短例句（必填，如在什么语境下说、如何造句）
- **行为**：
  - 若 `term` 已存在，返回提示引导使用 `manage_slang` 或自动更新；
  - 校验预算；写入并原子更新 `slang.md`。

### 4.2 `manage_slang`（管理黑话）
- **工具名称**：`manage_slang`
- **工具描述**：
  > 管理与维护全局黑话知识库。用于在用户指正黑话理解有误或补充新用法时更新释义例句、在黑话过时/被用户要求遗忘/出现错误信息时删除条目，或在准备修改前查询检索已有黑话列表以核对词条原名与现有内容。日常普通收录请使用 record_slang。
- **参数规格**：
  - `action` (string, required, enum: `['list', 'edit', 'delete']`): 操作类型：list (列出/检索已有黑话条目), edit (修改已有黑话的释义或例句), delete (删除指定黑话)
  - `term` (string, optional): 目标黑话词条名称（action 为 edit 或 delete 时必填；action 为 list 时可选填用于精确指定）
  - `definition` (string, optional): 修改后的核心释义（仅当 action 为 edit 时提供；若不修改释义可留空）
  - `example` (string, optional): 修改后的典型例句与语境（仅当 action 为 edit 时提供；若不修改例句可留空）
  - `keyword` (string, optional): 模糊搜索关键词（仅当 action 为 list 时生效，用于按词条或释义关键词筛选黑话列表）
- **行为**：
  - `action === 'list'`: 返回黑话列表、总条目数、当前字符用量与预算上限；支持按 `keyword` 过滤；
  - `action === 'edit'`: 定位指定 `term`，更新 `definition` 和/或 `example`，校验预算并落盘；
  - `action === 'delete'`: 删除指定 `term` 条目并原子落盘。

---

## 5. Web UI 与 HTTP REST API 契约

### 5.1 REST API 规范
前缀：`/plugins/dsh-napcat-bridge/slang`
1. `GET /plugins/dsh-napcat-bridge/slang`
   - 响应：`{ ok: true, entries: Array<{ term: string, definition: string, example: string }>, total: number, char_count: number, budget_chars: number }`
2. `POST /plugins/dsh-napcat-bridge/slang/edit`
   - 请求体：`{ term: string, new_term?: string, definition?: string, example?: string }`
   - 响应：`{ ok: true, entry: { term, definition, example }, char_count: number }`
3. `POST /plugins/dsh-napcat-bridge/slang/delete`
   - 请求体：`{ term: string }`
   - 响应：`{ ok: true, char_count: number }`

### 5.2 Web UI 设置卡设计
- 在 `src/client/card.tsx` 中增加 `SettingsTabId: 'slang'`；
- 顶部显示状态栏：总词条数、字符用量进度条与上限展示（如 `当前占用: 1820 / 5000 字符`）；
- 列表渲染：每行展示词条名、释义、例句；
- 操作按钮：复用 `IconEdit`（铅笔）与 `IconTrash`（垃圾桶）；
- 行内编辑：点击铅笔切换为行内输入框，支持编辑词条、释义、例句并提交保存。
