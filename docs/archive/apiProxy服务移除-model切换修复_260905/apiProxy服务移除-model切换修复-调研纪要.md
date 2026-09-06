# apiProxy 服务移除与 /model 切换失败 — 调研纪要

> **文档状态**：方案 A 已获用户确认并实施完成（typecheck / 246 项契约测试全绿 / dist 已重建），真机验证待执行
> **创建时间**：2026-09-05
> **关联归档**：`docs/archive/DSH升级0.1.2-rc.1_260904/`（升级探索文档，未覆盖本破坏点）

---

## 1. 问题现象

QQ 会话执行 `/model opencode-go deepseek-v4-flash -g`（以及任意带参 `/model` 切换）报错：

```
切换模型失败: cannot get property "apiProxy" without inject
```

- `/model` 无参查询、模型列表展示正常（走 `llm.listProviders/listModels`，不受影响）。

## 2. 根因定位（证据链）

1. **错误文案来源**：`cannot get property "X" without inject` 出自 `@deepseek-ai/cordis@4.0.2`
   `src/reflect.ts:144`（dist `lib/index.js:675`）。对 ctx Proxy 访问一个**未 provide /
   未 inject / 不在任何 fiber store** 上的属性时抛出。

2. **触发点**：`src/commands/index.ts:162` `safeSyncApiProxy`：
   ```ts
   const apiProxy = context.ctx.get('apiProxy') || (context.ctx as any).apiProxy;
   ```
   `ctx.get('apiProxy')` 返回 `undefined`（服务已不存在）→ 兜底 `(context.ctx as any).apiProxy`
   触发 cordis Proxy get 处理 → 抛错 → 被外层 try/catch（line 320/358）捕获 → 报「切换模型失败」。

3. **旧架构（0.1.1-rc.2）**：`@deepseek-ai/dsh-host-apiproxy` 以
   `super(ctx, "apiProxy")` 注册 host 服务 `ctx.apiProxy`（pnpm 缓存残留包
   `lib/index.js:5530` 证实），提供 `sessions.selectModel({ rpcId, payload: { sessionId, provider, model } })`
   —— 旧 wire 信封为 `{rpcId, payload}`。

4. **新架构（0.1.2-rc.1，当前 `dsh web` 运行时 /home/nyara/.local/bin/dsh）**：
   `dsh-host-apiproxy` 整体移除，改为 Typert Remote 架构：
   - `@deepseek-ai/dsh-api-session-controller` 的 `SessionController` 以
     `super(ctx, 'sessionController', { namespace: 'session' })` 注册
     （`lib/types/index.js:189`）→ 宿主服务键 **`sessionController`**，wire 命名空间 `session`。
   - 新签名：`selectModel(request: { sessionId, provider, model, reasoningEffort? }) → Promise<{ selected }>`
     （`lib/typert.host.js` schema 597-609；官方前端 `dsh-client-ui-model-selection/lib/client.js:158`
     同款直调，不再有 `{rpcId, payload}` 信封）。
   - 官方进程内访问范式：`dsh-tool-cordis` 目录面向 agent 生成的表达式为
     `ctx.get("sessionController")`（`lib/index.js:2085-2087, 8215`）。
   - **行为差异**：新 `selectModel` 内部会 `await this.ctx.agentDefaultModel.saveSelection(selected)`
     （写入宿主全局 settings `agentDefaultModel` 命名空间，见 `dsh-agent-default-model/lib/index.js:66-72`）。
     桥接侧已以 `defaultModelSvc.saveSelection = noop` 临时替换实现抑制
     （`src/commands/index.ts:165-184`）—— 该抑制逻辑需保留，以维持「/model 不污染 Web UI
     宿主全局默认」的既有 Spec 语义（§8.1 Per-Session 隔离）。

## 3. 影响面

- `apiProxy` 运行时访问：全仓库仅 `src/commands/index.ts:162` 一处；`src/index.ts:261` 仅为注释。
- `dist/commands/index.js` 含同样问题（真机加载 package.json `main → dist`）。
- 契约测试 `tests/contract/commands-permission.test.ts` **B4-契约 3d**（line 196-250）固定了旧契约：
  mock `(booted.ctx as any).apiProxy = mockApiProxy` 且断言
  `selectModelCalledWith.payload.sessionId / .payload.model`（旧 `{rpcId, payload}` 信封）。
  该测试在纯 mock 环境下仍绿（mock 对象没有 cordis Proxy 行为），但契约内容已与新版 DSH 不符。

## 4. 拟定修复方案（待用户确认）

### 方案 A（推荐）：最小改动，走官方 `sessionController` 服务
- `safeSyncApiProxy` 改为：
  ```ts
  const sessionController = context.ctx.get('sessionController');
  if (!sessionController?.selectModel) return;
  // 保留 agentDefaultModel.saveSelection 抑制 hack（防污染宿主全局默认）
  await sessionController.selectModel({ sessionId, provider, model });
  ```
- 同步更新 B4 契约测试：mock 换为 `sessionController.selectModel`，断言改用新直传 request
  形态（`selectModelCalledWith.sessionId / .model`）；保留两条关键断言：
  「命令执行期间宿主真实 saveSelection 不得被触发」+「拦截结束后原 saveSelection 已恢复」。
- `pnpm build` 重建 dist 后真机验证。
- 风险：`ctx.get('sessionController')` 依赖宿主 root ctx 提供该服务（与桥接侧既有
  `ctx.get('agents'/'llm'/'workspaceRegistry'/'agentDefaultModel')` 同一解析通道，置信度高）；
  仍需真机重启 `dsh web` 验证。

### 方案 B：移除宿主同步（不推荐）
- 删 `safeSyncApiProxy`，仅靠 SessionManager `installModelSelection` per-session 落位。
- 缺点：Web UI 侧该 QQ 会话的模型投影不更新，双通道不一致；失去 `llm.resolveCallConfig`
  模型可用性校验。

### 方案 C：自制底层调用（不推荐）
- 绕过 controller 直接调 `agents.selectForNextRequest` + 手动更新投影 —— 重造官方逻辑，脆弱。

## 5. 用户决策与实施记录

1. ✅ **已确认**：2026-09-05 用户拍板按**方案 A** 实施，并批准同步更新 B4 契约测试。
2. ✅ **已实施**：
   - `src/commands/index.ts`：`apiProxy` → `ctx.get('sessionController')`，请求改直传形态，保留 saveSelection 抑制；
   - `tests/contract/commands-permission.test.ts` B4-契约 3d：mock 换为 `ctx.provide('sessionController', mock)`（注：`ctx.get()` 读 cordis store，须用 `provide` 注入而非旧式属性赋值），断言改为直传 request 形态 + 无 `{rpcId,payload}` 信封 + 保留 saveSelection 两条关键断言；
   - `pnpm typecheck` ✅、全量 `vitest run` 27 文件 / 246 用例全绿 ✅（含 B4）、`pnpm build` ✅（dist 已含 sessionController 逻辑）；
   - `dist/commands/index.js` 已确认不再有 `apiProxy` 运行时访问（仅注释提及）。
3. ⏳ **待真机验证**：重启 `dsh web` 后，QQ 会话执行 `/model <供应商> <模型> [-g]` 应不再报错，且 Web UI 对应 QQ 会话的模型显示同步更新、宿主全局默认不受污染。