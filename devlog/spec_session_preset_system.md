# 调研与方案设计：QQ 会话专属预设系统与 Agent 自修改演进机制

> **文档定位**：技术调研与架构方案设计草案（待用户决策）  
> **创建日期**：2026-10-22  
> **关联模块**：`src/gateway/session/`, `src/tools/`, `src/prompt/`, `@deepseek-ai/dsh-agent-presets`, `@deepseek-ai/dsh-system-prompt`, `@deepseek-ai/dsh-tools`

---

## 1. 现状剖析与问题识别

### 1.1 现状：全量继承 DSH 默认 Coding 预设
当前项目中，QQ 会话的 Agent 启动与装配逻辑位于 `src/gateway/session/agent-runner.ts`：
1. **预设挂载无差别**：在 `setupFn` 中调用 `presets.mount(agentCtx)` 时未传递 `id` 参数，因此默认挂载了 DSH 的内置预设（`standard` 编码预设）；
2. **提示词冗余膨胀**：DSH 默认的 System Prompt 包含全套针对软件工程编码（"You are a coding agent..."、Git 工作流、Shell 交互规范等），消耗大量不必要的 Context 预算；
3. **工具无隔离暴露**：
   - DSH 编码工具（`bash`, `pwsh`, `read_file`, `write_file`, `edit_file`, `fs_search`, `jobs`, `subagent` 等）全量对 QQ 暴露；
   - QQ 桥接工具（`read_chat_history`, `send_file`, `poke_user`, `wait_for_user_messages`, `react_message`, `list_group_files`）目前是全局 `ctx.tools` 注册；
   - 缺乏针对 QQ 群聊/私聊的工具白名单或按场景裁剪机制，在群聊中存在提示词注入（Prompt Injection）触发敏感系统工具的潜在风险；
4. **配置静态固定**：当前仅在全局 `config` 中有静态的 `persona` 和 `behavior`，所有 QQ 会话共享，且 Agent 无法自主调整或根据群氛围自我演进。

---

## 2. DSH 底层能力确切事实考证

基于对本地 `node_modules/@deepseek-ai/*` 的源码与类型定义查验，确认以下底层事实：

### 2.1 `@deepseek-ai/dsh-agent-presets` 机制
- **存储路径**：内置预设位于包内 `presets/{standard,minimal,ptc,cordis}`；用户自定义预设位于 `<dshHome>/.agent-presets/<preset-name>/`。
- **文件组成**：
  - `preset.yml`：名称 (`name`)、描述 (`description`)、顺序 (`order`)；
  - `agent.cordis.yml`：声明式加载的 Cordis 子插件列表。
- **运行特征**：
  - **进程级 Standing Mount**：预设是单例常驻挂载的（`mounted ONCE per preset under a standing scope`），不同 Agent 通过 scope 绑定加入；
  - **不适合 Per-peer 差异化**：若纯依赖 DSH 的 `agent.cordis.yml`，无法针对群聊 A 与群聊 B 做到细粒度、独立的动态工具与提示词隔离。

### 2.2 `@deepseek-ai/dsh-system-prompt` 机制
- **完全覆盖选项 (`complete: true`)**：
  ```ts
  agentCtx.systemPrompt.section({
    name: 'qq:complete_system_prompt',
    order: 0,
    text: effectivePromptText,
    complete: true, // 关键：直接将该 section 作为完整 System Prompt，屏蔽全局所有冗余 Coding 提示词
  });
  ```
- **Persona 替换插槽**：
  - 支持 `PERSONA_PREFIX_SECTION` ("deployment:persona-prefix") 与 `PERSONA_SUFFIX_SECTION`，在 Agent 作用域内注册同名 section 即可直接局部覆盖全局 Persona。

### 2.3 `@deepseek-ai/dsh-tools` 机制
- **精准工具限制 (`tools.restrict`)**：
  ```ts
  agentCtx.tools.restrict({
    allow: ['read_chat_history', 'send_file', 'poke_user', 'read_memory'],
    // 或 deny: ['tool_bash', 'tool_pwsh']
  });
  ```
  - 原生支持按 Agent 作用域（`agentCtx`）进行全局工具的白名单（`allow`）或黑名单（`deny`）裁剪；
  - 被 restricted 掉的工具不会出现在发给 LLM 的 tools 列表中，既省 token 又硬隔离。
- **执行前守卫 (`tools.guard`)**：
  - 支持在 `agentCtx` 级别注册同步守卫，动态拒绝未授权或不合规的工具调用。

---

## 3. 架构设计方案选型

针对用户的两个核心诉求：
1. **建立 QQ 会话专属预设（控制每一个工具、System Prompt）**；
2. **预设不写死，保留让 Agent 去修改的路径**。

我们提出以下三个设计方案供权衡：

---

### 方案 A：轻量受控文件预设系统（Session Profile System）+ 显式管理工具（推荐）

#### 核心设计
1. **预设存储结构**：
   - 存放在 `.dsh/napcat/presets/` 目录下，采用直观安全的 JSON/YAML 格式：
     - `default.json`（全局基础预设）；
     - `profiles/<peer>.json`（按群聊/私聊 peer 独立覆盖的预设，如 `group_123456.json`）。
   - 预设内容模型：
     ```json
     {
       "id": "qq_default",
       "name": "QQ 智能助手预设",
       "system_prompt": {
         "complete": true,
         "persona": "你是一个得力的 QQ 群聊与私聊智能助手...",
         "behavior": "严格使用纯文本结构排版，避免复杂 Markdown...",
         "extra_rules": []
       },
       "tools": {
         "mode": "whitelist", // "whitelist" | "blacklist" | "all"
         "allowed": [
           "read_chat_history", "fetch_chat_resource", "expand_forward_message",
           "send_file", "poke_user", "wait_for_user_messages", "react_message",
           "list_group_files", "read_memory", "create_memory", "edit_memory"
         ],
         "denied": ["tool_bash", "tool_pwsh", "edit_file", "write_file"]
       },
       "self_evolution": {
         "allow_persona_edit": true,
         "allow_tool_toggle": false // 默认不允许普通对话中随意开启危险工具
       }
     }
     ```
2. **运行包装配**：
   - 在 `agent-runner.ts` 的 `setupFn` 中：
     - 读取当前 peer 的有效预设（合并全局 default 与 peer 专属配置）；
     - 使用 `agentCtx.systemPrompt.section({ complete: true, text: assemblePrompt(...) })` 注入纯净的 QQ 专属 Prompt；
     - 使用 `agentCtx.tools.restrict({ allow: profile.tools.allowed })` 精确放行指定工具。
3. **Agent 修改路径**：
   - 提供一个显式工具 `manage_session_preset`：
     - `action: 'get' | 'update_persona' | 'add_rule' | 'toggle_tool'`
     - 结合安全鉴权：修改人设与对话规则允许直接自修改；修改工具权限需校验当前发言者是否在 `admins` 白名单中。
   - 修改后立即回写配置文件，并触发 `system-prompt/change` 或在下一个回合生效。

- **优势**：
  - 结构清晰，排查直观，格式严格受控；
  - 原生支持按群独立定制，群 A 的人设和工具不会污染群 B；
  - 硬安全隔离（Hard Security）：防止普通群友通过注入修改工具配置提权。
- **缺点**：
  - 需要新增 `PresetManager` 模块与配套测试。

---

### 方案 B：分层自治模式（Prompt 软演进 + 权限硬策略）—— 灵动拟人流

#### 核心设计
将"**人设与行为准则（Soft Soul）**"与"**系统工具与权限（Hard Policy）**"彻底解耦：
1. **工具权限层（Hard Policy）**：
   - 由插件配置及管理员控制，提供场景化工具预设模板：
     - `chat_safe`（纯聊天安全模式）：仅开启 QQ 交互工具 + 记忆工具；
     - `pro_assistant`（全能助手模式）：增加网页搜索 `web_search`、知识库检索；
     - `developer`（开发者模式）：在私聊或管理员群中开启文件读写与 shell。
   - 工具权限不轻易暴露给 Agent 自由开关，杜绝越狱风险。
2. **人设与 Prompt 自演进层（Soft Soul / Instructions）**：
   - 借鉴 Claude Code 体系中的 `CLAUDE.md` / `SOUL.md` 理念：
   - 为每个 peer 分配一个提示词指令文件：`.dsh/napcat/soul/<peer>.md`；
   - 启动时自动将 `SOUL.md` 注入到 `systemPrompt.context`；
   - **为 Agent 提供自我修订工具** `update_agent_soul`（或直接使用记忆工具）：
     - 当用户说"你以后语气要傲娇一点"、"遇到群友发链接不要点"时，Agent 可以调用该工具追加或修订自己的 `SOUL.md`；
     - Agent 的性格和习惯会随着对话自主演变，具有高度的"养成感"和记忆连贯性。

- **优势**：
  - 极度符合大语言模型交互的最佳实践（人设可自主演变，权限由系统栅栏保护）；
  - 体验非常灵动逼真，完全没有机械的"改配置感"；
  - 绝对安全，不会因为人设变化导致系统命令被提权。
- **缺点**：
  - Agent 无法直接开启之前被管理员封禁的系统级工具（若想开工具需要管理员介入）。

---

### 方案 C：DSH 原生 Preset 挂载 + 工作区配置文件联动模式

#### 核心设计
1. 在 DSH 层面创建原生的 Agent Preset 目录 `<dshHome>/.agent-presets/qq-agent/`：
   - 编写 `agent.cordis.yml`，在 DSH Web UI 端正式注册一个叫 `qq-agent` 的预设；
   - 内部仅装配精简的 persona 与 QQ 插件需要的组件。
2. 在每个会话的 `cwd` 下放置 `preset.config.json`：
   - 启动时读取该工作区下的配置文件；
   - Agent 凭借已有的文件读写工具（`read_file`, `write_file`, `edit_file`）直接读写该文件；
   - 运行时监听文件变化，实现热更新。

- **优势**：
  - 深度贴合 DSH 原生 Web 界面生态，Web 界面上能直接看到并切换该 preset；
  - Agent 使用原生文件编辑工具即可操作，无需新增专属管理工具。
- **缺点**：
  - 若 Agent 产生幻觉写坏了 JSON 文件，会导致后续解析崩溃；
  - 工作区必须开放 `write_file`/`edit_file` 工具，群聊安全性相对较低。

---

## 4. 推荐演进路径与设计要点总结

综合**安全性**、**灵活性**、**DSH 底层架构契合度**以及**长期易用性**，推荐采纳 **方案 A 与 方案 B 的融合方案**：

1. **预设管理中心（Preset Manager）**：
   - 统一管理预设定义（JSON/YAML），支持内置预设（如 `default`, `safe_chat`, `developer`）；
   - 支持全局默认与单个 peer 独立绑定。
2. **纯净 System Prompt 与工具裁切**：
   - 通过 `systemPrompt.section({ complete: true })` 彻底裁掉冗余的 DSH 编码提示词，只保留清晰精炼的 QQ 助手提示词；
   - 通过 `tools.restrict({ allow: [...] })` 精准控制暴露的工具列表。
3. **分层修改路径（Agent Self-Evolution Path）**：
   - **人设与对话规则**：开放给 Agent 自主修改，对话中用户要求调整性格、规则时，Agent 可通过工具直接持久化；
   - **工具开关与权限**：实施鉴权控制，仅管理员可授权调整工具集，兼顾趣味性与生产安全性。
