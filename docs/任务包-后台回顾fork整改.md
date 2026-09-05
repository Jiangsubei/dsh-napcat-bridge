# 任务包：后台回顾 Fork 整改

> **项目**: dsh-napcat-bridge  
> **日期**: 2026-09-05  
> **前置**: 上一轮 BackgroundReviewManager 重构（commit beb9a26..cc576b0）  
> **问题**: 上轮 Agent 错误使用了 `agentsService.create()` (subagent) 而非 `sessions.fork()` (session fork)，导致 review agent 不继承主 session 历史，且 WebUI 上残留"正在加载子代理"。

---

## 1. 问题根因

上轮实现用 `agentsService.create({ seed: manuallyCopiedEvents })` 创建了一个 **subagent**（主 agent 的 child），而不是用 DSH 原生的 **session fork** 机制。

| 概念 | 行为 | 历史继承 | WebUI 展示 |
|---|---|---|---|
| **Subagent** (`agentsService.create()`) | 创建主 agent 的子代理 | ❌ 不继承 | "正在加载子代理"（卡住） |
| **Session Fork** (`sessions.fork()`) | fork 主 session 创建独立 session | ✅ 完整继承 | "在新对话中分支" |

**我们要的是 Session Fork，不是 Subagent。**

---

## 2. DSH 原生 Fork API

**源码位置**: `~/.dsh/profiles/node_modules/@deepseek-ai/dsh-session/lib/index.js`

```ts
// SessionStore.fork(source, boundary?, childSessionId?) → Session
sessions.fork(sourceSessionId)  // 最简调用：从源 session 最后一条事件 fork
sessions.fork(sourceSessionId, boundarySeq, childSessionId)  // 完整调用
```

**内部行为**:
1. `_resolveForkSource(source)` — 解析源 session
2. `_forkSeed(session, boundary)` — 从 `snapshotEvents(0, boundary+1)` 截取事件切片
3. 校验 boundary 不在 open turn 内（`OPEN_TURN` 错误）
4. 调 `this.create(childSessionId, { seed, inheritedEventCount, meta: { parentSession, isSeeded: true, cwd } })`
5. 返回新的 live Session 对象

**错误类型**: `SessionForkError`（`SESSION_ALREADY_EXISTS` / `INVALID_BOUNDARY` / `OPEN_TURN` / `SESSION_NOT_FOUND`）

---

## 3. 整改方案

### 3.1 核心修改：`src/memory/review.ts` → `runReview()`

**删除**当前的：
- 手动 `parentSession.snapshotEvents()` 截取 seed 逻辑（line 384-410）
- `agentsService.create({ seed, inheritedEventCount, ... })` 调用（line 443-461）

**替换为**：
```ts
// 1. 获取 sessions 服务
const sessions = this.ctx.get('sessions') || (this.ctx as any).sessions;

// 2. 用 DSH 原生 fork API 创建 review session
const liveSession = sessions.fork(parentSessionId);
// liveSession 是一个独立的 Session 对象，继承了主 session 的全部历史

// 3. 为 fork 出来的 session 创建 agent
const agentsService = this.ctx.get('agents') || (this.ctx as any).agents;
const agentHandle = await agentsService.create({
  sessionId: liveSession.id,
  model: reviewModelSelection?.model,
  maxIterations,
  meta: {
    isBackgroundReview: true,
    origin: 'fork',          // 注意：不是 'subagent'
    parentSession: parentSessionId,
    cwd: parentCwd,
    isSeeded: true,
    allowedTools: ALLOWED_MEMORY_REVIEW_TOOLS,
  },
});

// 4. 发送 review prompt
const agentObj = agentHandle?.agent || agentHandle;
await agentObj.followup(prompt);

// 5. 等待完成
if (typeof agentObj.whenIdle === 'function') {
  await agentObj.whenIdle();
}
```

**关键区别**:
- `sessions.fork()` 负责事件复制和 session 创建（DSH 原生保证正确）
- 不需要手动 `snapshotEvents()` 截取 seed
- `agentHandle` 是为 fork session 创建的 agent，不是 subagent

### 3.2 删除过时的代码

以下代码段应**完全删除**（不再需要）：

1. **手动 seed 截取**（review.ts line 384-410）：
   ```ts
   // 删除这段
   let seed: any[] | undefined = undefined;
   let inheritedEventCount: number | undefined = undefined;
   if (parentSession && typeof parentSession.snapshotEvents === 'function') { ... }
   ```

2. **prompt 兼容逻辑**（review.ts line 412-420）：
   ```ts
   // 删除这段（fork 后不再需要手动拼 history）
   if ((!seed || seed.length === 0) && Array.isArray(sessionContext.history) ...) { ... }
   ```

3. **`agentsService.create` 中的 seed 参数**（review.ts line 447）：
   ```ts
   // 删除 seed 相关参数
   ...(seed !== undefined ? { seed, inheritedEventCount } : {}),
   ```

4. **`parentSession` 相关的冗余逻辑**（review.ts line 344-353, 359-382）：
   - 不再需要手动从 `sessions.get()` 获取 parentSession（fork 直接用 sessionId）
   - 不再需要手动解析 workspace（fork 的 session 自带 cwd）

### 3.3 整改 `cleanupReviewSession()`

当前 cleanup 链路基本正确，但需要调整：

1. **步骤1**：`sessions.get(sessionId)` 应该能找到 fork 出来的 session（因为它被 `sessions.fork()` 注册了）
2. **步骤5**：`wsRegistry.headers.delete()` 可能不需要了——如果 fork session 没有通过 `attachSession` 注册到工作区，就不需要从工作区移除
3. **步骤6**：`subagentHandle.dispose()` 改为正确的 agent handle 清理

**注意**: `sessions.fork()` 创建的 session 是否自动注册到 workspace registry，需要在调研阶段确认。如果没有自动注册，cleanup 可以简化。

### 3.4 删除 `attachSession` 调用

当前代码在 fork 后调用：
```ts
if (parentWorkspace && typeof parentWorkspace.attachSession === 'function') {
  await parentWorkspace.attachSession(reviewSessionId);
}
```

**决策点**（需要调研确认）：
- 如果 `sessions.fork()` 自动注册到 workspace → 删除这段
- 如果 `sessions.fork()` 不自动注册 → 保留这段（让 review session 在 WebUI 可见），但 cleanup 时必须移除

### 3.5 `index.ts` 事件监听调整

当前代码传 `parentSession: session` 给 `onTurnFinished`。改用 `sessions.fork()` 后：
- `sessionContext.parentSession` 可能不再需要（fork 直接用 `sessionContext.sessionId`）
- `sessionContext.history` 不再需要（fork 自动继承）

简化 `ReviewSessionContext` 接口：
```ts
export interface ReviewSessionContext {
  peer?: string;
  sessionId?: string;    // 主 session ID（用于 fork 源）
  mainModel?: string;
  reviewModel?: string;
  // 删除: history, parentSession（fork 自动处理）
}
```

---

## 4. 实现任务拆解

### 任务 1：调研（必须先完成）

> **搞清楚 `sessions.fork()` 的真实行为**

**1.1** 确认 `sessions` 服务的获取方式：
- `ctx.get('sessions')` 是否返回 `SessionStore` 实例？
- `SessionStore` 上是否有 `fork` 方法？

**1.2** 确认 fork session 是否自动注册到 workspace：
- `sessions.fork()` 后，`workspaceRegistry.headers` 里是否有新 session？
- WebUI 是否自动显示 fork 出来的 session？

**1.3** 确认 fork session 的 agent 创建方式：
- `agentsService.create({ sessionId: forkSessionId })` 是否能绑定到已存在的 fork session？
- 还是需要用其他方式（如 `agents.get(forkSessionId)` + `followup`）？

**1.4** 确认 fork session 的清理方式：
- `sessions.get(forkSessionId)` 是否能找到？
- `sessions.flush()` / `sessions.detachEntered()` 是否适用？
- 物理文件路径是否可通过 `sessionPersistence.locate()` 获取？

**输出**: `docs/后台回顾fork整改-调研纪要.md`

### 任务 2：修改 `runReview()`

**2.1** 删除手动 seed 截取逻辑
**2.2** 改用 `sessions.fork(parentSessionId)` 创建 fork session
**2.3** 为 fork session 创建 agent（根据调研结果选择正确 API）
**2.4** 发送 prompt 并等待完成
**2.5** 简化 `ReviewSessionContext` 接口（去掉 history/parentSession）

### 任务 3：修改 `cleanupReviewSession()`

**3.1** 根据调研结果调整 cleanup 链路
**3.2** 确保 fork session 被正确清理（不留 WebUI 痕迹）
**3.3** 处理 `attachSession` 相关逻辑（根据调研结果决定保留或删除）

### 任务 4：修改 `index.ts` 事件监听

**4.1** 简化 `onTurnFinished` 调用参数（去掉 history 相关）
**4.2** 传入正确的 `parentSessionId`（用于 fork）

### 任务 5：更新测试

**5.1** 更新 `tests/contract/memory-review.test.ts` 中 mock 的 `sessions.fork()` 
**5.2** 新增 fork session 创建与清理的测试用例
**5.3** 确保所有现有测试不回归

---

## 5. 验收标准

| # | 验收项 | 验证方式 |
|---|---|---|
| A1 | Review session 通过 `sessions.fork()` 创建 | 代码审查确认 |
| A2 | Review agent 继承主 session 的完整对话历史 | 真机验证：review agent 首条回复非 "Nothing to save" |
| A3 | Review session 在 WebUI 上显示为"分支"而非"子代理" | WebUI 截图确认 |
| A4 | Review 完成后 session 被清理，不在 WebUI 留痕 | 完成后 WebUI 无残留条目 |
| A5 | 主 session 不受影响 | 主 session 对话正常 |
| A6 | 现有 27 套件 240 测试全绿 | `pnpm test` |

---

## 6. 关键文件索引

| 文件 | 改动 |
|---|---|
| `src/memory/review.ts` | 核心：`runReview()` + `cleanupReviewSession()` |
| `src/memory/index.ts` | 简化事件监听参数 |
| `tests/contract/memory-review.test.ts` | 更新 mock + 新增 fork 测试 |
| `~/.dsh/profiles/node_modules/@deepseek-ai/dsh-session/lib/index.js` | `SessionStore.fork()` 参考实现（line 1803） |
| `~/.dsh/profiles/node_modules/@deepseek-ai/dsh-session/lib/index.js` | `SessionStore.create()` 参考实现（line 1561） |

---

## 7. 约束

- **先调研再动手**，不要猜 API
- **不引入新依赖**
- **每个子任务原子提交**
- **如实汇报**调研中发现的问题
