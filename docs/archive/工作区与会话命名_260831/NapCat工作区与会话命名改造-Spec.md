# NapCat 顶层工作区与会话标题命名改造设计规范 (Spec)

## 1. 背景与现状

在此前实现中，`src/gateway/session.ts` 为每个 QQ 聊天对象（Peer，如 `group_3000000001`、`user_2000000001`）分别分配了独立的 `cwd` 路径（`~/.dsh/workspace/napcat/<peer>`），并在 `workspaceRegistry` 中为每个 peer 注册了一个独立的工作区（`QQ: <peer>`）。

这导致在 DSH Web UI 的侧边栏工作区树中，每个 QQ 群和私聊好友都显示为一个独立的顶级 📁 文件夹（工作区），使得工作区列表被海量 QQ 聊天对象占据。

---

## 2. 改造目标与设计原则

1. **顶层统一分类**：
   * 在 DSH Web UI 侧边栏中，仅保留单一顶层工作区 📁 **`NapCat`**；
   * 所有 QQ 会话（无论是群聊还是私聊）均挂载在 `NapCat` 工作区下；
2. **会话标题规范命名（模式 B 专属未归档版本号）**：
   * **群聊**：`群聊: <群名称> <群号> #<会话编号>`（例如：`群聊: 摸鱼群 3000000001 #1`；若群名称未知则降级为 `群聊: 3000000001 #1`）；
   * **私聊**：`私聊: <用户昵称> <QQ号> #<会话编号>`（例如：`私聊: Nyara 2000000001 #1`；若昵称未知则降级为 `私聊: 2000000001 #1`）；
   * **会话编号计算**：采用模式 B（针对当前群/好友的专属未归档版本号），初次创建为 `#1`，执行 `/clear` 或原会话归档后递增为 `#2`、`#3` 等；
3. **免疫 LLM 自动总结标题覆盖**：
   * 通过 DSH 原生 `ctx.sessionTitle.rename(session, title)` 机制向会话写入 `source: 'user'` 的标题锁定事件，使该标题在 DSH 内置机制中进入 **Pinned 锁定态**，彻底屏蔽后续 LLM 对第一条消息的自动标题提取覆盖。

---

## 3. 详细架构与契约设计

### 3.1 CWD 目录与工作区注册统一
* **CWD 统一**：所有 QQ Agent 会话的 `meta.cwd` 统一指向 `path.resolve(dshHome, 'workspace/napcat')`；
* **工作区注册**：`SessionManager.registerWorkspace` 仅向 `workspaceRegistry` 注册一个工作区：
  * `path`: `~/.dsh/workspace/napcat`
  * `title`: `NapCat`
* **会话挂载**：每次创建/唤醒会话时，调用 `ws.attachSession(sessionId)` 确保会话归属于 `NapCat`。

### 3.2 会话标题生成算法
```ts
export function formatSessionTitle(
  peer: string,
  sessionId: string,
  name?: string
): string {
  const versionMatch = sessionId.match(/-(\d+)$/);
  const versionNum = versionMatch ? versionMatch[1] : '1';
  const tag = `#${versionNum}`;

  if (peer.startsWith('group_')) {
    const groupId = peer.slice(6);
    const displayName = name ? `${name} ` : '';
    return `群聊: ${displayName}${groupId} ${tag}`;
  } else if (peer.startsWith('user_')) {
    const userId = peer.slice(5);
    const displayName = name ? `${name} ` : '';
    return `私聊: ${displayName}${userId} ${tag}`;
  } else {
    const displayName = name ? `${name} ` : '';
    return `QQ: ${displayName}${peer} ${tag}`;
  }
}
```

### 3.3 群名称与用户昵称解析器
* 群名称通过 OneBot 11 `get_group_info` API 获取并缓存在内存；
* 私聊用户昵称优先从入站消息的 `sender.nickname` 获取，或通过 `get_stranger_info` 获取并缓存；
* 当获取到更完善的群名/昵称时，动态更新并 pin 会话标题。

---

## 4. 契约测试矩阵

| 序号 | 测试用例 | 预期断言 |
| :--- | :--- | :--- |
| **C-01** | 会话标题格式化单测（群聊带名称、群聊无名称、私聊带昵称、私聊无昵称、带版本号） | 输出格式严格符合 `群聊: <群名> <群号> #<版本>` 及 `私聊: <昵称> <QQ> #<版本>` |
| **C-02** | 工作区注册装配断言 | `registerWorkspace` 注册单一 `NapCat` 工作区，`resolveCwd` 统一返回根目录 |
| **C-03** | 会话挂载契约断言 | `agents.create` 创建的会话成功通过 `attachSession` 关联至 `NapCat` 工作区 |
| **C-04** | 标题锁定契约断言 | `getOrCreateAgent` 或 `dispatchWakeup` 成功调用 `sessionTitle.rename` 锁定标题 |
