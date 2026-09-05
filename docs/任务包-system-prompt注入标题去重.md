# 任务包：System Prompt 注入标题去重

> **项目**: dsh-napcat-bridge  
> **日期**: 2026-09-05  
> **问题**: System Prompt 注入记忆时出现双重标题

---

## 1. 问题

注入到 System Prompt 的记忆内容出现双重标题：

```
### Session 记忆（group_646988881）     ← 插件注入层加的
# Session 记忆（group_646988881）        ← 文件内容自带的
```

用户画像同理。

## 2. 根因

两层代码各自加了标题：

| 层 | 位置 | 标题 |
|---|---|---|
| 存储层（文件创建） | `storage.ts` line 86, 133 | `# Session 记忆（peer）` / `# 用户画像（qq）` |
| 注入层（prompt 组装） | `storage.ts` line 219, 251 | `### Session 记忆（peer）` / `### 用户偏好与画像` |

## 3. 方案：方案 A — 插件侧统一标题职责

**去掉注入层的标题**，让文件内容的 `#` 标题自然作为注入内容的结构。

### 具体改动

**文件**: `src/memory/storage.ts` → `getPromptSnapshotSync()` 方法

**改动 1**（line 219）：
```ts
// 改前
parts.push(`### Session 记忆（${peer}）\n${sessionMemory}`);

// 改后：直接注入文件内容，文件自带的 # 标题就是结构
parts.push(sessionMemory);
```

**改动 2**（line 251）：
```ts
// 改前
parts.push(`### 用户偏好与画像\n${userBlocks.join('\n')}`);

// 改后：userBlocks 里的 profile 已经自带标题或结构，不需要外层包装
// 直接拼接各用户画像即可
parts.push(userBlocks.join('\n\n'));
```

**改动 3**（line 231）：
```ts
// 改前
userBlocks.push(`- ${targetName} (${targetQQ}): ${profile}`);

// 改后：profile 自带 # 标题时，保持原样注入
// profile 无标题时（旧格式），补一个简洁标识
if (profile.startsWith('#')) {
  userBlocks.push(profile);
} else {
  userBlocks.push(`### ${targetName} (${targetQQ})\n${profile}`);
}
```

群聊多用户同理（line 239）。

## 4. 验收标准

| # | 验收项 | 验证方式 |
|---|---|---|
| A1 | Session 记忆注入时只有一层标题（文件自带的 `#`） | 检查注入内容无 `### Session 记忆` 前缀 |
| A2 | 用户画像注入时每个 profile 独立显示，无 `### 用户偏好与画像` 包装 | 检查注入内容 |
| A3 | 旧格式文件（无 `#` 标题）仍能正常注入（补标识） | 读取不含标题的旧文件验证 |
| A4 | Agent 自发添加的子标题（`### 群友互动` 等）正常保留 | 读取 group_646988881.md 验证 |
| A5 | 现有测试全绿 | `pnpm test` |

## 5. 关键文件

| 文件 | 改动 |
|---|---|
| `src/memory/storage.ts` | `getPromptSnapshotSync()` 去掉注入层标题 |
