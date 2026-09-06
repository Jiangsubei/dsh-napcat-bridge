# 任务包：Memory 工具 Peer 映射修复 + Read-Before-Write 保护

> **项目**: dsh-napcat-bridge  
> **日期**: 2026-09-05  
> **优先级**: P0 — 阻塞开源发布  
> **关联**: 后台回顾功能修复后暴露的新问题

---

## 1. 背景

后台回顾修复后（fork 正确绑定），review agent 通过 `append_memory` / `update_memory` 写入记忆文件。但发现两个问题：

1. **Review agent 写入了错误的文件**：文件名带 `review-` 前缀（如 `session/review-default-1788595929622.md`），而前台 Agent 写的是 `session/group_123456789.md`。同一份记忆被拆成两个文件。
2. **Agent 编辑文件前不读取**：直接 `append_memory` / `update_memory` 可能写入重复或冲突内容。

---

## 2. 问题 1：Review Agent Peer 映射错误

### 根因

`resolveContextPeerAndQQ()` 从 session ID 解析 peer：

```ts
// tools.ts line 46-59
const groupMatch = trimmed.match(/^(?:qq-group-|group_)(\d+)/);  // review-default 不匹配
const userMatch = trimmed.match(/^(?:qq-user-|user-|qq-)(\d+)/); // review-default 不匹配
// 都不匹配 → peer = 'default'
```

Review session ID 是 `review-default-<timestamp>`，不匹配任何 QQ session 模式，fallback 到 `'default'`。

### 修复方案

Review agent 调用 memory 工具时需要传入正确的 peer。两层修复：

**A. 工具层（必须）**：`append_memory` / `update_memory` / `read_memory` 的 `execute` 函数中，如果解析出的 peer 是 `'default'` 且参数中没有显式指定 peer，返回错误提示要求传入 peer 参数。

**B. Prompt 层（推荐）**：Review prompt 中明确告诉 review agent 当前操作的 peer 是什么：

```
你正在为 peer group_123456789 执行后台回顾。
调用 memory 工具时必须显式传入 peer='group_123456789'。
```

这样 review agent 会在工具调用中显式传入正确 peer，绕过 session ID 解析问题。

### 具体改动

**`src/memory/review.ts`**：
- `runReview()` 中组装 prompt 时，追加 peer 提示段：
  ```ts
  const prompt = `${MEMORY_REVIEW_PROMPT_TEMPLATE}\n\n## Context\nYou are reviewing peer: ${peer}\nWhen calling memory tools, always pass peer='${peer}' explicitly.`;
  ```

**`src/memory/tools.ts`**：
- `resolveContextPeerAndQQ()` 或各工具的 `execute` 函数中，当 peer 为 `'default'` 且未传显式 peer 时，返回错误：
  ```ts
  if (resolved.peer === 'default' && !args.peer && !args.qq) {
    return { success: false, message: '请显式传入 peer 参数（如 peer="group_xxx" 或 peer="user_xxx"）' };
  }
  ```

---

## 3. 问题 2：Read-Before-Write 保护

### 设计

参照 DSH 官方 Edit 工具的乐观并发控制模式：

| 操作 | 行为 |
|---|---|
| `read_memory` | 读文件，把当前内容存入 `lastReadContent: Map<cacheKey, string>` |
| `append_memory` | 检查缓存：① 是否 read 过？② 文件当前内容是否和缓存一致？ |
| `update_memory` | 同上 |
| **未 read 过** | 拒绝：`"You must read the file first"` |
| **内容已变更**（被其他进程改过） | 拒绝：`"File has been modified since last read, please re-read first"` |

### Cache 设计

```ts
class MemoryTools {
  // 新增：per-tool-instance 的 read 缓存
  private lastReadContent = new Map<string, string>();  // key = `${type}:${peer_or_qq}`

  // read_memory 时写入缓存
  async readMemory(args) {
    const content = await this.storage.readSessionMemory(peer) / readUserProfile(qq);
    const cacheKey = `${type}:${type === 'user' ? qq : peer}`;
    this.lastReadContent.set(cacheKey, content);
    return { success: true, content, ... };
  }

  // append_memory / update_memory 时校验
  async appendMemory(args) {
    const cacheKey = `${type}:${type === 'user' ? qq : peer}`;

    // 1. 检查是否 read 过
    if (!this.lastReadContent.has(cacheKey)) {
      return { success: false, message: 'You must read the file first before editing.' };
    }

    // 2. 检查文件是否被外部修改
    const currentContent = await this.storage.readSessionMemory(peer) / readUserProfile(qq);
    const cachedContent = this.lastReadContent.get(cacheKey)!;
    if (currentContent !== cachedContent) {
      return { success: false, message: 'File has been modified since last read, please re-read first.' };
    }

    // 3. 执行追加，更新缓存
    await this.storage.appendSessionMemory(peer, content);
    const newContent = await this.storage.readSessionMemory(peer);  // 读回追加后的内容
    this.lastReadContent.set(cacheKey, newContent);  // 更新缓存
    return { success: true, message: `已更新...`, content };
  }

  // update_memory 同理
}
```

### 缓存生命周期

- **Per tool instance**：`MemoryTools` 实例在 `setupMemoryService()` 中创建一次，全局共享
- **Per session 不感知**：当前实现不区分 session——前台 agent 和 review agent 共用同一个 `MemoryTools` 实例，共用缓存
  - **这恰好是正确的**：因为它们编辑的是同一组文件，共享缓存确保了一致性
  - 如果前台 read 了，review 也能看到缓存（虽然 review 自己也会 read）
  - 如果 review 修改了文件，前台下次 append 时会检测到"文件已变更"并要求 re-read

### 关于 review agent 的特殊处理

Review agent 在一轮 review 中会先 read 再 write，流程是：
1. `read_memory(type='session', peer='group_xxx')` → 缓存写入
2. `append_memory(type='session', peer='group_xxx', content='...')` → 缓存命中，内容一致，写入成功
3. 可能再次 `append_memory` → 缓存仍命中（因为只有自己在写），继续成功

这是正确的行为——同一轮内的连续编辑不需要每次都 re-read。

### 边界情况

| 场景 | 行为 |
|---|---|
| Agent 直接 `append_memory` 不 read | ❌ 拒绝，提示先 read |
| Agent `read` → `append` → `append` | ✅ 第二次 append 缓存命中（内容没被外部改） |
| Agent A `read` → Agent B `append` → Agent A `append` | ❌ Agent A 第二次 append 检测到内容变更，要求 re-read |
| Review agent `read` → `append` | ✅ 正常流程 |
| 文件不存在（首次创建） | `read_memory` 返回空字符串，缓存存 `''`；`append_memory` 检测当前内容也是 `''`，一致，允许写入 |

---

## 4. 任务拆解

### 任务 1：Peer 映射修复

**1.1** 修改 `src/memory/review.ts`：
- `runReview()` 中组装 prompt 时追加 peer 提示段

**1.2** 修改 `src/memory/tools.ts`：
- 各工具 `execute` 中，当 `resolveContextPeerAndQQ()` 返回 `peer === 'default'` 且无显式参数时，返回错误提示

### 任务 2：Read-Before-Write 保护

**2.1** 修改 `src/memory/tools.ts` → `MemoryTools` 类：
- 新增 `lastReadContent: Map<string, string>` 字段
- `readMemory()` 写入缓存
- `appendMemory()` / `updateMemory()` 校验缓存

**2.2** 处理文件不存在（首次创建）的边界：
- `read_memory` 文件不存在时返回空字符串 `''`，同时缓存存 `''`
- `append_memory` 检测当前内容 `''` === 缓存 `''`，允许写入

### 任务 3：更新测试

**3.1** 更新 `tests/contract/memory-tools.test.ts`：
- 新增 read-before-write 保护的测试用例
- 新增 peer 映射错误的测试用例
- 新增文件不存在时首次创建的测试用例

**3.2** 更新 `tests/contract/memory-review.test.ts`：
- 确认 review prompt 中包含 peer 提示

**3.3** 确保所有现有测试不回归

---

## 5. 验收标准

| # | 验收项 | 验证方式 |
|---|---|---|
| A1 | Review agent 写入正确的 peer 文件（不带 review- 前缀） | 检查 `napcat_memory/session/` 下无 `review-*.md` |
| A2 | Agent 不 read 就 append 时被拒绝 | 日志或工具返回 "You must read the file first" |
| A3 | Agent read → append → append 正常工作 | 连续编辑不被误拒 |
| A4 | 外部修改文件后，缓存检测到变更并要求 re-read | 模拟外部修改后 append 被拒 |
| A5 | 文件不存在时 read 返回空、append 正常创建 | 首次创建流程通过 |
| A6 | 现有 27 套件 241 测试全绿 | `pnpm test` |

---

## 6. 关键文件索引

| 文件 | 改动 |
|---|---|
| `src/memory/tools.ts` | 核心：MemoryTools 类 + read-before-write + peer 校验 |
| `src/memory/review.ts` | prompt 追加 peer 提示段 |
| `tests/contract/memory-tools.test.ts` | 新增 read-before-write 测试 |
| `tests/contract/memory-review.test.ts` | 确认 prompt 包含 peer |
