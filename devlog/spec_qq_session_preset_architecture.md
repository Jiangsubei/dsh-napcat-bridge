# 任务规格(Spec)与实施清单：QQ 会话专属预设与工具胶水代码清理

> **文档定位**：功能规格说明书与装配实施清单（活跃推进中）  
> **创建日期**：2026-10-26  
> **关联模块**：`cordis.patch.yml`, `package.json`, `src/index.ts`, `src/tools/`, `src/gateway/session/agent-runner.ts`, `src/boot.ts`

---

## 1. 目标与背景

### 1.1 现状与问题
1. **系统提示词冗余膨胀**：QQ 会话默认全量继承 DSH 的 `standard` 编码预设，注入了大量面向编码的规则（"You are a coding agent..."、Git 工作流、Shell 语法规则等），消耗大量不必要的上下文预算；
2. **工具隔离胶水代码繁重**：
   - 呈现侧：在 `src/index.ts` 中通过 `system-prompt/assemble` waterfall 钩子动态过滤非 QQ 会话中的 NapCat 工具；
   - 执行侧：在 `src/index.ts` 中通过 `toolsSvc.guard` 拦截非 QQ 会话调用 NapCat 工具；
   - 本质原因：工具在根 Context 上全局注册，必须通过两道运行时拦截防止污染 Web 端普通会话。

### 1.2 重构目标
1. **建立专属单预设 (`qq-session`)**：
   - 提示词：使用 `@deepseek-ai/dsh-persona` (`complete: true`) 注入纯净的专属提示词（初期为 `当前会话是 qq 会话。`，后续拓展）；
   - 工具集：
     - DSH 官方工作区与文件工具：`@deepseek-ai/dsh-tool-fs` (`read`, `write`, `edit`, `read_image`)
     - DSH 官方工作区路径工具：`@deepseek-ai/dsh-tool-working-directory` (`working_directory`)
     - DSH 官方工作区依赖工具：`@deepseek-ai/dsh-tool-workspace-dependencies` (`load_workspace_dependencies`)
     - DSH 官方跨平台 Shell：`@deepseek-ai/dsh-tool-pwsh` (Windows) / `@deepseek-ai/dsh-tool-bash` (macOS/Linux)
     - DSH 官方联网检索：`@deepseek-ai/dsh-tool-web` (`web_search`, `web_fetch`)
     - NapCat 专属工具组：`dsh-napcat-bridge/tools`（通过标准 Cordis 插件导出，挂载全部 13 个 QQ 交互工具）
2. **清理防御性胶水代码**：
   - 移除 `src/index.ts` 中的 `system-prompt/assemble` 过滤器；
   - 移除 `src/index.ts` 中的 `toolsSvc.guard` 拦截器；
3. **闭环装配**：
   - 会话创建与恢复（`agent-runner.ts`）在 `setupFn` 中装配 `qq-session` 预设；
   - 编写装配契约测试，验证预设的定义、挂载与工具可用性。

---

## 2. 详细技术方案

### 2.1 子插件导出与服务绑定
- `package.json` 添加 exports: `"./tools": "./dist/tools/plugin.js"`
- `src/tools/plugin.ts` 实现为标准 Cordis 插件：
  - `name`: `'napcat-tools'`
  - `inject`: `['tools']`
  - 通过注入/绑定的宿主上下文获取 NapCat bridge 实例，调用 `registerAllTools(ctx, bridge)`。

### 2.2 预设声明 (`cordis.patch.yml`)
在 `cordis.patch.yml` 中声明 `preset-qq-session`，使用 `@deepseek-ai/dsh-agent-preset`：
```yaml
- insert:
    - id: preset-qq-session
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: qq-session
        name: QQ 智能助手
        description: QQ 会话专属预设，包含工作区文件与跨平台 Shell、官方 Web 搜索与 NapCat QQ 交互能力
        order: 10
        plugins:
          - id: persona
            name: '@deepseek-ai/dsh-persona'
            config:
              prefix: 当前会话是 qq 会话。
              complete: true
              includeRuntimeContext: false
          - id: tool-fs
            name: '@deepseek-ai/dsh-tool-fs'
          - id: tool-working-directory
            name: '@deepseek-ai/dsh-tool-working-directory'
          - id: tool-workspace-dependencies
            name: '@deepseek-ai/dsh-tool-workspace-dependencies'
            disabled: !!js "!(process.env.DSH_PRIMARY_RUNTIME ?? process.env.DSH_BUNDLED_PRIMARY_RUNTIME)"
            config:
              source: !!js "process.getBuiltinModule('node:path').resolve(process.env.DSH_PRIMARY_RUNTIME ?? process.env.DSH_BUNDLED_PRIMARY_RUNTIME ?? '')"
          - id: tool-bash
            name: '@deepseek-ai/dsh-tool-bash'
            disabled: !!js process.platform === 'win32'
          - id: tool-pwsh
            name: '@deepseek-ai/dsh-tool-pwsh'
            disabled: !!js process.platform !== 'win32'
          - id: tool-web
            name: '@deepseek-ai/dsh-tool-web'
            config:
              fetch: true
              searchTimeoutMs: 30000
          - id: napcat-tools
            name: 'dsh-napcat-bridge/tools'
```

### 2.3 会话装配运行时接线 (`src/gateway/session/agent-runner.ts`)
在 `setupFn` 中：
```ts
if (presets?.mount) {
  return presets
    .mount(agentCtx, 'qq-session')
    .then(() => undefined)
    .catch((err: any) => { ... });
}
```

---

## 3. 实施与验收 Checklist

- [x] **Step 1**: 创建 `src/tools/plugin.ts` 并更新 `package.json` exports
- [x] **Step 2**: 更新 `cordis.patch.yml` 声明 `qq-session` 预设
- [x] **Step 3**: 在 `src/index.ts` 提供宿主服务供子插件注入，并注销/移除 `system-prompt/assemble` 与 `toolsSvc.guard` 胶水代码
- [x] **Step 4**: 在 `src/gateway/session/agent-runner.ts` 中挂载 `'qq-session'` 预设
- [x] **Step 5**: 在 `src/boot.ts` 中建立 profile node_modules 软链接，确保单测与契约环境能够解析 `dsh-napcat-bridge/tools`
- [x] **Step 6**: 编写契约测试 `tests/contract/qq-session-preset.test.ts` 验证端到端装配闭环（4 个契约测试 100% 绿色通过）
- [x] **Step 7**: `pnpm typecheck` 通过
- [x] **Step 8**: `pnpm build` 确认 `dist/` 编译产物更新（包含 `dist/tools/plugin.js`）
