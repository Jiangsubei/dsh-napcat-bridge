# DSH 0.2.1-rc.5 至 0.2.2-rc.1 增量更新与插件适配分析报告

> 调研基准：`deepseek-ai/deepseek-harness` 官方仓库标签 `dsh-v0.2.1-rc.5`（`b830ec9`）与 `dsh-v0.2.2-rc.1`（`66491b0`）的完整增量代码比对与官方升级指南。

---

## 1. 核心架构与版本全景

DSH 从 `0.2.1-rc.5` 到 `0.2.2-rc.1` 跨越了多个内部版本迭代（`v0.2.2-alpha.1` ~ `alpha.3`、`v0.2.2-rc.1`），包含了基础框架升级、插件系统健壮性、工具调度解耦、Client UI 扩展点以及多平台适配等重要改进。

### 1.1 Vendor 基础依赖升级
- **Cordis 核心升级**：从 `4.0.0-rc.7` 升级至 `4.0.0-rc.11`，对外发布为 `@deepseek-ai/cordis@4.1.0`（对应 `cosmokit@1.9.0`）。
- **Loader 升级**：从 `1.0.0-rc.5` 升级至 `1.0.0-rc.8`（对外发布为 `1.1.0`）。
- **Include 升级**：从 `1.0.4` 升级至 `1.1.1`（对外发布为 `1.1.0`）。
- **Schemastery 升级**：升级至 `3.19.0`。
- **Timer 升级**：升级至 `1.2.0`。

---

## 2. 七大核心子系统增量变更深度拆解

### 2.1 基础框架与持久化（Cordis / Loader / Include）
1. **EntryTree 变更报告机制**：
   - 废弃并移除了 `EntryTree.write()`，改为通过 `commit(change: EntryChange)` 同步接收每个条目的创建、更新、移动、删除与 explicit fiber 保存。
   - `applyEntryPatches(data, patches, warn)` 现在始终返回克隆后的 entries，调用方不再能通过原地修改直接渗透原配置对象。
2. **Include Journal 协同持久化**：
   - Include 引入 Journal 机制协调运行时配置变更。对 patch 所拥有的字段和插入行的运行时修改，现在统一持久化到父级 patch，而不会污染子配置文件；
   - 根 Include 在重启后不再保留对 bundle 插入行的覆写修改（避免配置雪崩）。

### 2.2 启动与插件系统（App-Boot & Plugin-Manager）
1. **官方预设与 Bundles 解耦**：
   - `DEFAULT_PROFILE_BUNDLES`、`OPTIONAL_BUNDLES`、`ON_DEMAND_BUNDLES` 等从 `app-boot` 中移出，降低基础引导包的耦合度。
2. **平台支持声明（`bundle-platform`）**：
   - 新增 `dsh.bundle.platforms` 元数据校验（支持 `win32`、`linux`、`darwin` 等 Node.js platform 名称）。如果宿主操作系统不匹配，引导阶段将明确抛出 `UnsupportedBundlePlatformError`，避免非当前平台的原生插件静默启动失败。
3. **启动失败诊断快照（`startup-diagnostics`）**：
   - 新增 `captureStartupComposition(ctx)`：在应用启动失败销毁插件前，自动抓取最多 256 行插件状态（active/pending/failed）及缺失服务的提供方归属，极大提升排障诊断效率。

### 2.3 工具系统与执行器（Tools / Execution Pipeline）
1. **条件工具机制（Conditional Tools）**：
   - 新增 `ctx.tools.register(definition, { when })`，支持按每个模型 turn 步骤同步或异步动态求值 `{ agent, modelSelection, signal }`。若返回 `false`，该工具将自动从该轮 prompt 组装、PTC 绑定与执行列表中隐藏。
2. **原生与 PTC 执行器解耦**：
   - 将 PTC 运行时代码（`run_code` 生成、SDK 拼装）从核心 `tools` 模块完全抽离为独立的执行器插件，底层仅保留统一的 pipeline 分发。
3. **文件系统修改与 `apply_patch` 演进**：
   - `fs-observation-policy` 默认以 `disabled: true` 交付，不再强制要求模型在 `write`/`edit` 前必须先调用 `read`。
   - 新增 `apply_patch` 工具：在 0.2.2-rc.1 最终发布中，官方提交 `e1609fe164` 暂时在默认预设中将 `applyPatch` 设为 `false`，保持策略平稳。
4. **Lossless JSON 铁律持续严格**：
   - 工具参数校验与返回值处理依然严格执行 Lossless JSON，严禁 `undefined` 字段。

### 2.4 WebUI 客户端与扩展插槽（Client UI Slots）
1. **自定义设置页面导航图标（PR #7624）**：
   - 新增 `settings.section.icon` 插槽！
   - 插件在注册独立的 `settings.section`（如我们的 `'napcat'`）后，可同时通过该 slot 提供专属的导航图标（React 组件，接收 `{ size, active }`）。未注册时由 UI Shell 回退到默认图标。
2. **统一右键菜单扩展（PR #6951 & #6210）**：
   - 将 `MenuTarget` 规范化为 `ContextMenuTarget`；
   - 注入源与 hook 规范化为 `contextMenuTarget` 和 `useContextMenuTarget`；
   - 图标由直接传 React 节点改为通过 keyed Slot `contextMenu.icon` 解析 `{ key, src? }`。
3. **UI 原语增强（`ui-primitives`）**：
   - 新增 `UserMessageBubble`、`AnimatedRows`、`ZoomControls`、`DetailDocument`、`QuotePreview` 等原子组件；
   - 优化移动端触屏适配与侧边栏响应式布局。

### 2.5 调度系统重构（Schedule）
1. **宿主全域任务化**：
   - Schedule 工具从"仅管理当前 Session 提醒"重构为面向宿主全部任务的调度系统；
   - 工具集变更为：`schedule_create`、`schedule_list`、`schedule_view`、`schedule_edit`（移除旧版 `schedule_update` 和 `schedule_delete`）；
   - 时间表达统一采用规范的 **RRULE** 语法（`DTSTART` + `RRULE`）；
   - 明确限制：被委派的 subagent 调用 Schedule 工具时会返回 `subagent_session` 拦截。

### 2.6 会话与事件流（Session Projections）
1. **批量 Projection 帧优化（PR #7587）**：
   - `session/control` 与 `session/observeProjections` 流由单 key 帧改为批量帧：`{ type: 'projection', sessionId, seq, changes: [{ key, val }] }`，大幅降低高频状态变更时的帧数量。
2. **已释放单元保留在 Checkpoint（PR #7754）**：
   - `ctx.sessionProjections.checkpoint(session)` 为已有 Session 保留释放前的最后值，修复正常关停或插件热重载时 WebUI 丢失上下文折叠数据的问题。

### 2.7 LLM 与安全机制
1. **LLM 辅助请求用途声明（Purpose Map）**：
   - `GenerateOptions.purpose` 改为由各模块通过 `declare module '@deepseek-ai/dsh-llm/types'` 扩展 `LlmRequestPurposeMap`，禁止未声明的散装字符串用途。
2. **pi-ai 路由图片数量防护**：
   - 增加 `maxRequestImages`（默认 50 张）和 `imageOffloadCountQuantum`（默认 10 张），超限时自动将老旧图片替换为占位文本，防止超出提供商上限。

---

## 3. 对 `dsh-napcat-bridge` 插件的适配影响评估

### 3.1 破坏性影响与兼容性判定
- **零破坏性阻断（100% 保持向前兼容）**：
  - **Cordis / Boot 兼容性**：我们 `src/boot.ts` 使用官方 `boot()` 和 `loadOverlayPatches()`，未侵入改写 `EntryTree.write()`，天然兼容 Loader 1.0.0-rc.8 和 Cordis 4.1.0。
  - **Tool 定义兼容性**：我们的所有自定义工具（`memory`, `slang`, `qzone`, `contact-info`, `agent-ipc`）均严格采用 `defineTool` 规范与 `toLosslessJson` 清洗，完全契合 0.2.2 的 pipeline 约束。
  - **审批与提问（Approval & User Questions）**：我们的 `NapCatQuestionProvider` 消费的标准结构 `AskUserQuestionRequest` 在 0.2.2 中完全保持稳定。
  - **Client UI 设置页兼容性**：现有的 `settings.section` 插槽声明未受破坏，旧版仅注册 section 的插件在 0.2.2 中会自动使用默认图标，正常渲染。

### 3.2 建议推进的适配改造项

#### ① 体验增强项：适配设置页面导航图标（`settings.section.icon`）
- **现状**：目前在 `src/client/index.tsx` 中仅注册了 `settings.section`（标题文字为 `"QQ NapCat"`），在 DSH 设置侧边栏中显示为默认占位图标。
- **适配方案**：
  在 `src/client/index.tsx` 中增加 `settings.section.icon` 注册，挂载一个矢量 QQ 企鹅 SVG 图标，提升在 DSH WebUI 中的视觉品质。
  ```tsx
  ctx.slots.inject('settings.section.icon', function* () {
    yield ctx.slots.register(
      {
        name: 'settings.section.icon',
        id: 'napcat',
      },
      ({ size, active }: { size: number; active: boolean }) => (
        <NapCatNavIcon size={size} active={active} />
      )
    );
  });
  ```

#### ② 依赖与元数据对齐
- **PeerDependencies**：
  - 当前 `@deepseek-ai/cordis: ^4.0.2`（语义化版本覆盖 `4.1.0`）；
  - 当前 `@deepseek-ai/schemastery: ^3.18.2`（覆盖 `3.19.0`）；
  - 当前 `@deepseek-ai/dsh-*: >=0.2.0-0`（覆盖 `0.2.2-rc.1`）。
  - **结论**：外部 peerDependencies 范围无需收窄，天然满足；当准备正式切到 0.2.2 构建时，可将 `devDependencies` 升级至 `0.2.2-rc.1`。
- **跨平台声明（可选）**：
  - 我们的插件纯 JS/TS + WebSocket 实现，支持全部主流系统。如果希望显式声明，可在 `package.json` 的 `dsh.bundle` 中加入 `platforms: ["win32", "linux", "darwin"]`。

#### ③ 预设与工具（Preset & Tools）
- **`tool-fs` 与 `apply_patch`**：
  - 我们的预设中挂载了 `@deepseek-ai/dsh-tool-fs`。由于 0.2.2-rc.1 默认将 `applyPatch` 设为 `false`，若希望未来模型支持 patch 编辑能力，可在需要时手动开启；目前保持默认即可。
- **条件工具能力（可探索）**：
  - 0.2.2 提供的 `ctx.tools.register(def, { when })` 可以用于按群聊/私聊动态控制部分工具（例如空间动态发布工具仅在具备对应权限时呈现），后续可按需接入。

---

## 4. 总结与行动建议
1. **现状很健康**：当前 `dsh-napcat-bridge` 代码在 DSH 0.2.2-rc.1 下**没有任何阻断性编译或运行时错误**，可以直接在 0.2.2-rc.1 环境下稳定加载。
2. **推荐的下一步**：
   - 为 WebUI 设置面板添加 `settings.section.icon`，让插件在 0.2.2 的侧边栏有漂亮的 QQ 企鹅图标；
   - 在后续版本迭代中，将 devDependencies 升级到 `0.2.2-rc.1` 并完成一次全量构建验证。
