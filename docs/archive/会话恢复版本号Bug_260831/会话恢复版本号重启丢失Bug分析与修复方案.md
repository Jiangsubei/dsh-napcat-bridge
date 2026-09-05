# DeepSeek Harness 重启后会话恢复回退 Bug 原因分析与修复方案

## 1. 问题现象与背景

### 1.1 现象复现
- 用户在 QQ 私聊/群聊中原本在编号为 `#2`（或更高版本 `#N`，如 `qq-user-123456-2`）的会话中进行对话（例如通过 `/clear` 开启了新会话）。
- 当 DeepSeek Harness (DSH) 服务或进程重启后，收到该用户的下一条消息时，系统恢复的却是最初的编号为 `#1`（`qq-user-123456`）的基础会话，导致用户在 `#2` 中的上下文断链丢失。

---

## 2. Bug 根因分析 (Root Cause)

经过对 `src/gateway/session.ts` 及 DSH 底层服务装配链路的审查，定位到以下两个关键缺陷：

### 2.1 缺陷 1：会话版本与活跃状态未持久化（内存丢失）
- 在 `SessionManager` 中，记录清空版本与当前活跃会话 ID 的数据结构为内存中的 Map：
  - `clearedVersions = new Map<string, number>()`
  - `peerCurrentSessionId = new Map<string, string>()`
- DSH 重启后，这两个 Map 全部被重置清空，进程失去了对「该 peer 曾经推进到哪个版本」的认知。

### 2.2 缺陷 2：`peerToSessionId` 会话寻址采用「从 #1 盲选」静态策略
- 观察 `peerToSessionId(peer)` 的实现逻辑：
  ```typescript
  // 若基础会话未被归档，优先使用基础会话
  if (!this.isSessionArchived(baseId)) {
    this.peerCurrentSessionId.set(peer, baseId);
    return baseId; // 永远返回 #1（即 qq-user-123456）
  }
  ```
- **核心逻辑冲突**：
  - 根据项目规格（Spec §8.1），`/clear` 指令的语义是**「直接开启新对话，不归档旧会话（旧会话保留供查阅）」**；
  - 因此旧的 `#1` 会话在 Web UI 中处于**未归档**状态（`isSessionArchived(baseId)` 为 `false`）；
  - 重启后，`peerToSessionId` 缺少内存中的 `clearedVersions` 记录，直接命中 `!this.isSessionArchived(baseId)` 分支，**无条件返回基础会话 `#1`**；
  - 随后调用 `agents.resume({ resumeSessionId: baseId })`，成功从磁盘拉起了 `#1` 会话，导致消息错误分发至旧会话。

---

## 3. 修复方案设计

为了彻底解决重启后的会话路由问题，并兼顾 Web UI 归档、`/clear` 语义及历史回溯能力，提出以下修复方案：

### 3.1 方案核心原则
1. **最高未归档版本优先（Highest Active Version）**：
   - 寻址 peer 对应的活跃会话时，不再无脑优先选 `#1`，而是**自动扫描并选取该 peer 已存在的所有未归档版本中的最大版本（Highest Active Version）**。
   - 例：若存在 `#1`（未归档）和 `#2`（未归档），则重启后自动恢复最新活跃的 `#2`；
   - 例：若用户在 Web UI 把 `#1`、`#2` 都归档了，则自动递增新建 `#3`。
2. **多重数据源感知（DSH Workspace + 本地 SQLite 持久化）**：
   - **数据源 A（DSH 运行时）**：从 DSH 官方 `workspaceRegistry.headers`（启动时自动由 DSH 加载全量持久化 session header）中动态检索匹配该 peer 的所有版本；
   - **数据源 B（本地 SQLite 持久化）**：在本地 `messages.sqlite` 中新增轻量级 `session_states` 表，持久化记录每个 peer 的 `cleared_version` 与 `latest_session_id`，确保即使未创建 agent 立即重启也不会丢失 `/clear` 动作；
   - **保底（纯单测/无服务环境）**：兼容无 sqlite 或无 workspaceRegistry 的边界情况，保障健壮性与单测通过率。

---

## 4. 具体改造范围

1. **`src/storage/database.ts`**：
   - 在 `init()` 中新增 `session_states` 表：
     ```sql
     CREATE TABLE IF NOT EXISTS session_states (
       peer TEXT PRIMARY KEY,
       current_session_id TEXT NOT NULL,
       cleared_version INTEGER NOT NULL DEFAULT 1,
       updated_at INTEGER NOT NULL
     );
     ```
   - 增加 `getSessionState(peer)` / `saveSessionState(peer, sessionId, clearedVersion)` 方法。

2. **`src/gateway/session.ts`**：
   - `SessionManager` 构造函数接收可选的 `db?: MessageDatabase`；
   - `peerToSessionId(peer)` 实现「已存在未归档版本中的最大版本号（Highest Active Version）」智能寻址算法；
   - `markSessionCleared(peerOrSessionId)` 推进版本号时同步写入 `session_states` 表与内存缓存。

3. **`src/index.ts`**：
   - 将已初始化的 `db` 传递给 `new SessionManager(ctx, dshHome, db)`。

4. **契约测试 (`tests/contract/`)**：
   - 新增针对「DSH 重启后（模拟 dispose + 重新 boot）会话恢复保持在最新 #2 / #N 会话」的真实装配契约测试，确保 100% 覆盖。

---

## 5. 待用户决策

请您审阅上述分析与方案。您确认同意后，我将立即按照 TDD 流程开展测试用例编写、功能改造与全量契约测试验证。
