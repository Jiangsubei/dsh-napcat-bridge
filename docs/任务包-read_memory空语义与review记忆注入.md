# 任务包：read_memory 空语义修复 + review agent 记忆上下文注入

> **项目**: dsh-napcat-bridge  
> **日期**: 2026-09-06  
> **优先级**: P1  
> **一句话**: 两个相关修复——① read_memory 对不存在/空文件误报"成功读取"；② 让 Background Review Agent 通过主 agent 同一条 system prompt 动态段注入既有记忆/用户画像（含记忆偏好），而非追加到 review prompt。**硬边界：review agent 不得继承主 agent 的人格/行为准则。**

---

## 1. 根因（已确证）

### Fix 1：read_memory 空/不存在误报"成功读取"

`src/memory/tools.ts:334-342`：
```ts
render: (_args, value) => [{
  type: 'text',
  text: value.content ? `${value.message || '读取成功'}\n\n${value.content}` : (value.message || '记忆内容为空'),
}]
```
- 文件**有内容** → 显示 message + content ✅
- 文件**为空/不存在**（`value.content` 空）→ 走 `value.message`（=`"成功读取用户画像 (qq)"`，恒 truthy），**永不落到"记忆内容为空"** ❌
- agent 连续读多次、抱怨"不显示 content"、误以为有内容差点盲创建

### Fix 2：review agent 没有被注入既有记忆上下文

- review prompt（`review.ts:395-401`）只有：静态模板 + `## Context`(peer) + 对话历史。**无既有记忆/画像/记忆偏好**
- 用户 2415112980 画像中含**记忆偏好**："只记确定性事实，不记冗余；不写时间戳；尽量精简"——review agent 不知道 → 不遵循
- 主 agent 经 `systemPrompt.context` 动态段注入记忆；review agent **没有**。因为 `resolveContextPeerAndQQ`（`tools.ts:58-59`）对 `review-...` 会话返回 `peer='default'` → `memory/index.ts:63-64` 返回空，不注入
- 方案：`resolveContextPeerAndQQ` 把 `review-<源peer>-<ts>` 映射回源 peer，注入即走通（复用主 agent 同一条缓存友好的动态段，非追加到 prompt）

---

## 2. 修复设计（定稿）

### Fix 1：read_memory 空语义

目标：文件**空/不存在**时，返回与渲染都**明确说"不存在或为空 → 用 create_memory"**，不再报"成功读取"。

- `readMemory`（tools.ts:96-130）：当 `content` 为空（文件不存在或内容为空）时，`message` 改为
  `"该记忆文件不存在或内容为空。如需记录，请使用 create_memory 创建。"`
- `render`（tools.ts:334-342）空分支：保证即使 `message` 被改成空串也落到 `"记忆内容为空"`；优先明确渲染 `"（当前无内容）"` 提示
- **有内容时行为不变**（message + content）

### Fix 2：review→源 peer 映射（记忆注入）

`src/memory/tools.ts` `resolveContextPeerAndQQ` 的 `review-` 分支（line 58-59）：
```ts
} else if (trimmed.startsWith('review-')) {
  const inner = trimmed.slice('review-'.length);              // 去 review-
  const m = inner.match(/^(user_|group_)(\d+)-/);             // 源 peer 形如 user_2415112980-<ts>
  if (m) {
    peer = m[1] === 'user_' ? `user_${m[2]}` : `group_${m[2]}`;
    if (m[1] === 'user_') qq = m[2];
  } else {
    peer = 'default';
  }
}
```
- `reviewSessionId = review-${源peer}-${Date.now()}`（review.ts:342）已确证
- 效果：review agent 装配时，`napcat:memory` 动态段 resolve 到源 peer → `getPromptSnapshotSync(源peer, activeUsers)` 注入该用户画像（含记忆偏好）+ 会话记忆
- **额外收益**：review agent 记忆工具（read/create/edit）execute 里也 resolve 到源 peer → 不传显式 peer 也能作用于源 peer

### ⚠️ 硬边界：review agent 不得继承主 agent 人格/行为准则

| 动态段 | 文件 | 门控 | 对 review |
|---|---|---|---|
| `napcat:behavior_persona`（人格+行为准则） | `src/prompt/dynamic.ts:28-65` | 独立 `sessionId.startsWith('qq-')` | **必须保持不注入**（review id 是 `review-...`，天然被挡） |
| `napcat:memory`（记忆+画像） | `src/memory/index.ts:47` | `resolveContextPeerAndQQ`(本次修复) | **必须注入**（Fix 2 目标） |

- **禁止改动** `dynamic.ts` 的 `behavior_persona` 门控（保持 qq- 前缀判断）
- **禁止**让 review agent 变成主 agent 克隆
- 核实 `getPromptSnapshotSync`（storage.ts:231）只拼记忆/画像，**不含**人格/行为准则

---

## 3. 任务拆解（原子提交）

1. **Fix 1**：`tools.ts` `readMemory` message + render 空语义；更新 `memory-tools.test.ts`（新增/改断言：空文件 → message 含"不存在或内容为空"+ create_memory 引导；render 输出不含"成功读取"）
2. **Fix 2**：`tools.ts` `resolveContextPeerAndQQ` review→源 peer 映射；`memory/index.ts` 确认 `review-` 会话经映射后注入走通
3. **契约测试**：
   - resolveContextPeerAndQQ：`review-user_2415112980-<ts>` → `{peer:'user_2415112980', qq:'2415112980'}`；`review-group_646988881-<ts>` → 群 peer；无法解析 → default
   - Fix 1：read_memory 空 → message/render 明确"不存在或为空/create_memory"；有内容不变
   - （如可行）真实装配断言：对 bootDshNapcatBridge 装配后，构造 review 会话的 assembleCtx → napcat:memory 段注入源 peer 画像；napcat:behavior_persona 段对 review 会话仍为空
4. **真机验证**（必做，AGENTS.md 红线）：真实触发一次 review，导出 review session 的 system prompt，断言 **含**该用户画像/记忆偏好、**不含**人格/行为准则

## 4. 验收标准

| # | 验收项 | 验证 |
|---|---|---|
| A1 | read_memory 空/不存在 → message/render 明确"不存在或为空 + create_memory 指引" | 单测 |
| A2 | read_memory 有内容 → 行为不变（message + content） | 单测 |
| A3 | resolveContextPeerAndQQ 把 `review-user_xxx-<ts>`/`review-group_xxx-<ts>` 映射回源 peer+qq | 单测 |
| A4 | 无法解析的 review id → 回退 default（不崩） | 单测 |
| A5 | review agent 装配时 napcat:memory 注入源 peer 画像+记忆偏好 | 契约/真机 |
| A6 | review agent 装配时 napcat:behavior_persona 为空（不含人格/行为准则） | 契约/真机 |
| A7 | 人格/行为准则注入对**普通 QQ 会话**行为不变 | 单测回归 |
| A8 | 全量测试通过 + build 通过 + dist 含改动 | `pnpm test` + `pnpm build` |
| A9 | 未引入新 npm 依赖 | 检查 |

## 5. 关键文件

| 文件 | 改动 |
|---|---|
| `src/memory/tools.ts` | readMemory 空语义 message + render；resolveContextPeerAndQQ review→源 peer |
| `src/memory/index.ts` | 核实 review 会话注入走通（不改 behavior_persona） |
| `src/prompt/dynamic.ts` | **禁止改动**（硬边界） |
| `tests/contract/memory-tools.test.ts` | read_memory 空语义断言 |
| `tests/contract/*`（新增 resolve 或注入测试） | resolveContextPeerAndQQ / 装配断言 |