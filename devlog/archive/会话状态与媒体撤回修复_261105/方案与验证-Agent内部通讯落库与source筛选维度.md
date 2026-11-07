# 方案与验证：Agent 内部通讯落库与 source 筛选维度

> 日期：2026-11-04　状态：已实现并验证（待真机验收）

## 1. 需求

Agent 之间的内部协同通讯（`send_agent_message` / `create_user_agent` 初始使命）此前只进入
目标 Agent 的运行时上下文，**不写 `messages` 表**。一旦会话发生上下文压缩，Agent 无法再通过
`read_chat_history` 找回「谁给我布置过什么任务 / 我给谁发过什么成果」。

要求：

1. 内部通讯也要落库，作为上下文资产；
2. 落库身份必须**独立且明确标注**为内部通讯（新增一个“角色”）；
3. `read_chat_history` 增加可筛选维度；
4. 目标会话与发送方会话各落一份（用户拍板）。

## 2. 设计

### 2.1 统一收口

内部通讯的唯一入口是 `SessionManager.dispatchWakeup(payload)` 且 `trigger === 'internal_agent'`
（`send_agent_message` 与 `create_user_agent` 均走此路径）。落库统一放在该方法的投递成功之后：

```
agentRunner.dispatchWakeup(payload)   // 投递（失败则抛错，不落库）
  ↓ 成功
persistInternalMessages(payload)      // 目标 + 发送方各一份，幂等写入
```

落库失败只记录告警，绝不影响消息投递主链路。

### 2.2 身份标识（新增“内部通讯”角色）

| 字段 | 值 |
|---|---|
| `sender_name` | `内部通讯`（固定，一眼可辨） |
| `user_id` | `agent:<来源 SessionID>`；来源缺失时 `agent:system` |
| `source` | `agent`（真实 QQ 消息为 `qq`） |
| `self` | `0`（不是机器人 QQ 发言） |
| `type` | `text` |
| `content` | 目标侧：`【内部协同】来源会话: <来源>\n<正文>`；发送侧：`【内部协同】发往会话: <peer>\n<正文>` |
| `msg_id` | 由 `(peer, 身份, 时间, 内容)` 派生 FNV-1a 稳定正整数，重复投递天然幂等 |

### 2.3 表结构

`messages` 新增列：

```sql
source TEXT NOT NULL DEFAULT 'qq'
CREATE INDEX idx_messages_peer_source_time ON messages (peer, source, time);
```

- 存量数据自动继承 `'qq'`（`ALTER TABLE ... DEFAULT 'qq'`）；
- 新建库直接带列；索引在 `ALTER TABLE` 之后创建，兼容老库；
- `MessageRecord.source` 可选，写入时缺省按 `'qq'` 处理，避免逐个改造既有插入点。

### 2.4 查询维度

`read_chat_history` 新增 `source` 参数（`'qq' | 'agent' | 'all'`）：

- **缺省等价 `'qq'`**：日常历史查询默认不展示内部通讯，避免协同消息被误认为群友/好友发言；
- `'agent'`：仅查看 Agent 内部协同通讯；
- `'all'`：两者都返回。

返回的每条消息摘要新增 `source` 字段。原有 `user_id` 过滤同样可用于
`agent:<来源SessionID>` 精确检索。

## 3. 验证

### 3.1 契约测试

`tests/contract/internal-message-record.test.ts`（11 项，全绿）：

- 纯函数：目标记录身份、发送方记录去向、来源不可解析回退、同会话去重、空内容/非内部触发不落库、
  稳定 msg_id 与字段无 `undefined`；
- 真实 SQLite：`source='agent' / 'qq' / 缺省` 三种筛选、按 `user_id`/`sender_name` 检索、
  存量消息默认 `qq`、重复投递幂等；
- **真实装配闭环**：`bootDshNapcatBridge` 挂载后调用 `dispatchWakeup(internal_agent)`，
  从插件真实数据库文件中读出双方各一条 `source='agent'`、`sender_name='内部通讯'` 的记录。

### 3.2 回归

`agent-ipc`、`outbound-self-record`、`read-chat-history-peer`、`storage-query`、`gateway-actions`、
`private-self-message`、`send-message-tool`、`send-message-quote`、`send-file`、`recall-message`、
`quote-assembly`、`negative-msg-id`、`assembly`、`aside-suppression-and-fallback`、
`offline-sync-storage`、`offline-sync-engine` 共 17 个文件 / 160 项全部通过。

### 3.3 附带修复：老库升级索引顺序

初版把 `CREATE INDEX ... (peer, source, time)` 与 `CREATE TABLE` 放在同一个 `db.exec()` 中，
对**已存在且没有 `source` 列的老库**，`CREATE TABLE IF NOT EXISTS` 不会补列，索引语句随即报
`no such column: source`，导致整个插件 apply 失败（表现为 `ctx.get('napcatBridgeTools')` 为
`undefined`）。修复为：建表阶段不建该索引，待 `ALTER TABLE ... ADD COLUMN source` 之后再创建。

同时 `bootDshNapcatBridge` 改为 `await ctx.plugin(...)`：
Cordis 的插件激活是微任务调度，不等待会让“boot 已返回但插件尚未 apply”的装配竞态被隐藏。
此改动让装配测试在插件真正就绪后再断言，也正是它把上述老库迁移错误暴露出来。

## 4. 已知边界

- 内部通讯不会产生 QQ 消息事件，也不会触发唤醒自循环；
- `source` 仅描述来源，不改变 `text/image/...` 的消息形态语义；
- 目标会话与发送方各一份是通过同一内容、不同 `peer` 与各自标注实现的，不是引用关系。
