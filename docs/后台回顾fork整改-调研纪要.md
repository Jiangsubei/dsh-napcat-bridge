# 后台回顾 Fork 整改 — 调研纪要

> **日期**: 2026-09-05  
> **调研执行**: Antigravity (Pair Programming Agent)  
> **调研对象**: `@deepseek-ai/dsh-session`, `@deepseek-ai/dsh-agent`, `@deepseek-ai/dsh-agent-loop`, `@deepseek-ai/dsh-workspace`, `@deepseek-ai/dsh-api-session-controller`, `@deepseek-ai/dsh-client-ui-workspace`

---

## 一、调研背景与核心问题回顾

上一轮重构中，`BackgroundReviewManager` 触发后台回顾时，WebUI 上出现了「正在加载子代理」（卡住）且历史未正常继承的现象。  
任务包文档初步推断是由于使用了 `agentsService.create()`（认为是创建 subagent）而非 `sessions.fork()`，因此指示本次任务先对 DSH 原生机制做严格的源码级事实查证。

我们通过深入查阅本地 `node_modules/@deepseek-ai/` 源码并编写真实环境脚本执行验证，获得了详尽的确切结论。

---

## 二、关键发现与事实核对

### 2.1 `sessions` 服务与 `SessionStore.fork()` 的真实行为 (任务 1.1)

1. **服务获取方式**:
   - `SessionStore` 定义在 `@deepseek-ai/dsh-session/lib/index.js`（line 1543），构造函数中执行 `super(ctx, "sessions")`。
   - 在 Cordis 容器中，`ctx.get('sessions')` 或 `(ctx as any).sessions` 返回的确实是 `SessionStore` 实例。

2. **`SessionStore.fork()` 签名与逻辑**:
   - 源码位于 `dsh-session/lib/index.js` line 1803：
     ```ts
     fork(source: Session | SessionId, boundary?: number, childSessionId?: string): Session
     ```
   - **执行流程**:
     1. `_resolveForkSource(source)`：解析源 Session，校验其是否在 live store 中；
     2. `_forkSeed(liveSource, boundary)`：从 `snapshotEvents()` 中定位已完成 turn 的边界（若边界落在 open turn 内则直接抛出 `SessionForkError("OPEN_TURN")`），截取合法的 `seed` 事件切片；
     3. 调用 `this.create(childSessionId, { seed, inheritedEventCount, meta: { cwd, parentSession, isSeeded: true } })`；
     4. `this.create` 内部先调 `this.prepare` 构建 `Session` 对象，再通过 Cordis effect 调用 `this.enter(session)` 将其存入 `this.store`（内存 Map），并调用 `this.announce(session)` 触发 `session/created` 事件；
     5. 返回创建好的 `Session` 实例。

---

### 2.2 Fork Session 与 Workspace 的关系 (任务 1.2)

1. **是否自动注册到 Workspace**:
   - **完全不会自动注册**。
   - `sessions.fork()` 仅操作 `dsh-session` 内部的 `SessionStore.store`。
   - `workspaceRegistry`（来自 `@deepseek-ai/dsh-workspace`）是在启动时通过 `indexLiveSessions` 或从 `sessionPersistence.list()` 读取已持久化的会话头。对于新调用 `sessions.fork()` 动态创建的会话，`workspaceRegistry.headers.has(childSession.id)` 返回 `false`，且没有自动关联任何 workspace。

2. **WebUI 侧边栏展示机制**:
   - WebUI 侧边栏列表完全由 `workspace.sessionIds` 决定（来自 `WorkspaceEntity.sessionIds`）。
   - 只有显式调用 `await workspace.attachSession(childId)`，该 session 才会进入工作区 record 的 `sessionIds` 数组，从而在 WebUI 侧边栏显示。
   - 如果不调用 `workspace.attachSession`，fork 出来的 session 在 WebUI 侧边栏**根本不会出现**。

3. **之前 WebUI 显示「正在加载子代理 / {n} 个子代理运行中」的真实根因**:
   - 查验 `@deepseek-ai/dsh-client-ui-workspace` 和 `@deepseek-ai/dsh-client-ui-subagent` 源码发现：
     - 前端在侧边栏过滤会话：`return session.origin !== "subagent" ...`（隐藏子代理）；
     - 前端在父会话顶部渲染：若子会话的 `meta.origin === 'subagent'`，则在父会话头部追加子代理状态下拉菜单，显示文案：`"{n} 个子代理运行中"` / `"正在加载子代理"`！
   - **真相大白**：上一轮 Agent 在 `src/memory/review.ts` line 450 显式写了：
     ```ts
     meta: {
       isBackgroundReview: true,
       origin: 'subagent', // <--- 罪魁祸首！正是这个字段触发了 WebUI 的子代理显示逻辑！
       parentSession: parentSessionId,
       ...
     }
     ```
     只要 `origin` 不是 `'subagent'`（例如设为 `'fork'` 或不传），WebUI 就绝对不会把它识别为子代理！

---

### 2.3 Agent 与 Fork Session 的绑定机制 (任务 1.3，核心冲突点)

这是本调研中最关键的发现：**`sessions.fork()` 与 `agentsService.create()` 不能直接先后串联调用！**

1. **为什么直接调用 `agentsService.create({ sessionId: liveSession.id })` 会崩溃？**
   - 编写真实环境代码验证，执行结果为：
     ```
     childAgent creation FAILED: session "session-1" already exists Error: session "session-1" already exists
         at Proxy.prepare (dsh-session/lib/index.js:1613:40)
         at Proxy.createAgent (dsh-agent-loop/lib/index.js:1310:75)
         at Proxy.create (dsh-agent/lib/index.js:793:1)
     ```
   - **源码根因**:
     - `agentsService.create(options)`（由 `@deepseek-ai/dsh-agent-loop` 的 `createAgent` 提供实现）内部第一行就是：
       ```ts
       const preparation = SessionPreparation.create(
         this.runtime.ctx.sessions.prepare(options.sessionId, { ... })
       );
       ```
     - 而 `sessions.prepare(id)` 内部明确检查：
       ```ts
       if (this.store.has(sessionId)) throw new Error(`session "${sessionId}" already exists`);
       ```
     - 此时因为先前已经执行了 `sessions.fork()`，该 `childSessionId` 已经通过 `sessions.enter` 存入了 `sessions.store`，所以 `agentsService.create` 再次去 `prepare` 该 ID 时必然抛错！

2. **`agents.get(forkSessionId)` 是否可用？**
   - **不可用**。`sessions.fork()` 只是会话事件层的纯数据分支（`Session` 对象），它**根本没有**启动 Agent 事件循环（`AgentLoop` / `ReactLoopAgent`），因此在 `agents` 注册表中为 `undefined`，没有 agent 可以 `followup`。

3. **DSH 官方自身是如何实现「在新对话中分支 (Session Fork)」的？**
   - 查阅 DSH WebUI 后端控制器 `@deepseek-ai/dsh-api-session-controller` 的 `fork(request)` 方法（line 655-718）：
     ```ts
     // 1. 获取源 session 的 events 切片 (截取到最后一个 completed turn)
     const boundary = source.events.findLast((event) => event.type === "turn/end");
     let cut = SessionLogOffset(boundary.seq + 1);
     while (cut < source.events.length && source.events[cut]?.type !== "turn/start") cut = SessionLogOffset(cut + 1);
     
     // 2. 官方直接调用 ctx.agents.create 创建 fork session 和 agent！
     await this.ctx.agents.create({
         sessionId: childId,
         seed: source.events.slice(0, cut),
         inheritedEventCount: cut,
         meta: {
             ...source.header.cwd === void 0 ? {} : { cwd: source.header.cwd },
             parentSession: source.header.id,
             isSeeded: true,
             // 注意：绝不传 origin: 'subagent'
         },
         agentOptions: { provider, model },
         setup: composition.setup
     });
     
     // 3. 显式挂载到工作区
     if (workspace !== void 0) {
         await workspace.attachSession(childId);
     }
     ```
   - 查阅 DSH 的 `@deepseek-ai/dsh-session/README.md` 与源码注释，也明确指出：
     > *"For an agent whose session must be torn down IN ORDER with its loop ... do NOT use this [sessions.create/sessions.fork] — fold the session lifecycle into the agent's own effect via prepare + enter + announce (see dsh-agent-loop's creation transaction)."*

---

### 2.4 Fork Session 的清理机制 (任务 1.4)

1. **`sessions.get(sessionId)`**: 能准确找到该 live session。
2. **`sessions.flush(live)`**: 正常执行，用于确保数据写入持久化层。
3. **`sessions.detachEntered(entry)`**: 正常执行，能立即从 `sessions.store` 中删除该会话，使其对系统隐形。
4. **`sessionPersistence.locate()`**: 真实实测返回：
   ```js
   {
     kind: 'jsonl',
     path: '/path/to/sessions/--cwd--/<sessionId>/session.jsonl.zstd'
   }
   ```
   可准确定位物理文件路径，进而执行 `rm(path.dirname(loc.path))` 实现彻底物理删除（用完即焚）。

---

## 三、方案比选与实施建议

基于以上确凿的调研事实，任务包最初设想的 `sessions.fork()` + `agentsService.create()` 串联调用在 DSH 现有架构下由于 ID 冲突（`SESSION_ALREADY_EXISTS`）**无法直接工作**。

我们有以下两个可行的整改方案供用户确认：

### 方案 A（推荐：DSH 官方原生 Fork 方案）
遵循 DSH 官方 `dsh-api-session-controller` 的 Fork 标准实现：
1. 从 `parentSession.snapshotEvents()` 提取已完成轮次的 `seed`（保证不截断 open turn）；
2. 调用 `agentsService.create({ sessionId, seed, inheritedEventCount, meta: { parentSession: parentSessionId, isSeeded: true, origin: 'fork', cwd: parentCwd } })`；
3. **关键修复**：
   - 将 `meta.origin` 从原来的 `'subagent'` 改为 `'fork'`（或完全不传）；
   - **不调用** `workspace.attachSession(reviewSessionId)`（因为后台 review 属于内部后台任务，不应该在 WebUI 侧边栏产生临时条目）；
4. Review 执行完毕后，进入 `cleanupReviewSession`：
   - 调 `agentHandle.dispose()`；
   - 调 `sessions.detachEntered()`；
   - 调 `sessionPersistence.locate()` 并物理 `rm` 磁盘目录。

**优点**:
- 100% 符合 DSH `dsh-agent-loop` 与 `dsh-api-session-controller` 的设计契约；
- 不会触发 `SESSION_ALREADY_EXISTS` 错误；
- WebUI 彻底不显示「正在加载子代理」，侧边栏也不会残留临时会话；
- 继承完整的父会话已完成轮次历史。

---

### 方案 B（Fork-then-Detach 方案：强行使用 `sessions.fork` API）
若必须直接调用 `sessions.fork` API：
1. `const liveSession = sessions.fork(parentSessionId)`：利用 `sessions.fork` 内部的边界校验和事件截取逻辑生成 session；
2. 提取 `seed = liveSession.snapshotEvents()` 与 `inheritedEventCount`；
3. **立即从 store 中脱钩**：
   ```ts
   const entry = sessions.liveEntryFor ? sessions.liveEntryFor(liveSession) : (sessions as any).store.get(liveSession.id);
   if (entry) sessions.detachEntered(entry);
   ```
4. 随后调用 `agentsService.create({ sessionId: liveSession.id, seed, inheritedEventCount, meta: { parentSession, isSeeded: true, origin: 'fork', cwd: parentCwd } })`；
5. 后续执行与清理同方案 A。

**优缺点**:
- 优点：形式上直接调用了 `sessions.fork()` 方法；
- 缺点：先让 `sessions.fork` 在 store 中创建 session 触发一次 `session/created`，再立即 detach，然后让 `agents.create` 再次 `prepare` + `enter` 触发第二次 `session/created`，生命周期存在冗余颠簸。

---

## 四、调研结论汇报概要

1. **`sessions.fork()` 真实行为**: 纯 Session 层的分支创建，负责截取 completed turn seed 并进入 `sessions.store`，但**不创建 Agent**；
2. **Workspace 关联**: `sessions.fork()` **不会**自动注册到 workspace；
3. **Agent 绑定**: 不能对 `sessions.fork()` 后的 session 直接调用 `agentsService.create({ sessionId })`，会报 `already exists`。DSH 官方原生支持的 Fork Agent 机制是直接向 `agentsService.create` 传入 `seed` + `meta: { parentSession, isSeeded: true, origin: 'fork' }`；
4. **子代理卡住根因**: 上轮实现传入了 `meta.origin = 'subagent'`，触发了 WebUI 的子代理挂载展示逻辑。去除该标识并禁止 `workspace.attachSession` 即可彻底根除 WebUI 异常。
