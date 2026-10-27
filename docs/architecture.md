# 系统架构

本文档说明 dsh-napcat-bridge 的模块构成、生命周期装配、数据流转机制与存储设计。

---

## 1. 架构总览

dsh-napcat-bridge 作为 DeepSeek Harness (DSH) 的 Cordis 插件运行，在 QQ 协议端 (NapCat) 与 DSH 核心运行时之间构建消息中继与会话代理。

```
+-----------------------------------------------------------------------------------------+
|                                 DeepSeek Harness (DSH)                                  |
|   [Agent Engine] <---> [Session Service] <---> [qq-session 预设 (工作区/Shell/Tools)]   |
+-----------------------------------------------------------------------------------------+
                                             ^
                                             | (Cordis Lifecycle / Events / Tool Calls)
                                             v
+-----------------------------------------------------------------------------------------+
|                                  dsh-napcat-bridge                                      |
|                                                                                         |
|  +--------------------+  +----------------------+  +------------------+  +-----------+  |
|  |   SessionManager   |  | OutboundStreamBridge |  | MemoryService    |  | FaceStore |  |
|  | (Peer 映射 / 队列) |  | (静默拦截/出站驱动)  |  | (两层画像/顺手提炼) |  | (表情管理) |  |
|  +--------------------+  +----------------------+  +------------------+  +-----------+  |
|                                             ^                                           |
|                                             | (send_qq_message / send_file / 串行队列)  |
|                                             v                                           |
|  +-----------------------------------------------------------------------------------+  |
|  |                                PerPeerSerialSender                                 |  |
|  |                              (单对端出站串行化发送队列)                             |  |
|  +-----------------------------------------------------------------------------------+  |
|                                             ^                                           |
|                                             | (OneBot 11 JSON API)                      |
|                                             v                                           |
|  +-----------------------------------------------------------------------------------+  |
|  |                                NapCatGatewayServer                                 |  |
|  |                            (反向 WebSocket 服务端 :8080)                            |  |
|  +-----------------------------------------------------------------------------------+  |
+-----------------------------------------------------------------------------------------+
                                             ^
                                             | OneBot 11 协议 (WebSocket JSON)
                                             v
+-----------------------------------------------------------------------------------------+
|                                   NapCat (QQ 客户端)                                     |
+-----------------------------------------------------------------------------------------+
```

---

## 2. 插件生命周期与装配

插件入口位于 `src/index.ts`，导出符合 Cordis 标准的插件定义：

- `name`: 插件名称 `dsh-napcat-bridge`。
- `inject`: 声明依赖的服务，包含 `tools`、`systemPrompt`、`agents` 以及可选的 `settings`。
- `apply(ctx, config)`: 插件装配函数，依次执行以下初始化：
  1. **配置读取与合并**：依次合并启动参数、WebUI 设置与遗留配置，注册配置监听与 Reconciler 热对齐机制。
  2. **存储初始化**：初始化 SQLite 消息数据库 (`MessageDatabase`)、媒体存储管理器 (`MediaStorageManager`) 与表情包路径自愈迁移 (`migrateFaceStoragePaths`)。
  3. **网关服务端启动**：启动反向 WebSocket 服务端 (`NapCatGatewayServer`)，挂载消息等待收集器 (`MessageWaitRegistry`)。
  4. **对端管理与解析器**：初始化群成员缓存解析器 (`CachedGroupMemberResolver`)、主动回复管理器 (`ProactiveManager`) 与会话映射管理器 (`SessionManager`)。
  5. **两层记忆体系与人设注入**：挂载记忆服务 (`setupMemoryService`) 与动态提示词注入器 (`registerNapCatDynamicPrompt`)。
  6. **工具插件化与预设装配（SSOT）**：
     - 构建 `NapCatBridgeToolsProvider` 并挂载至 `dsh-napcat-bridge/tools`；
     - 工具不再全局暴露到根 `ctx.tools`，杜绝向 Web UI 常规会话泄露；
     - 通过单一真相源 (`src/constants/preset.ts`) 与 `agentPresets` 服务，动态注册 `qq-session` 专属预设，自动为 QQ 会话配置工具集、Shell（pwsh/bash）、工作区与技能系统。
  7. **出站桥接与串行下发**：启动出方向事件流桥接器 (`OutboundStreamBridge`) 与单对端串行发送器 (`PerPeerSerialSender`)。
  8. **审批与交互响应**：初始化审批瀑布流响应器 (`NapCatApprovalResponder`)。
  9. **WebUI 设置卡片与 REST 路由**：挂载插件设置路由与表情包管理端点。

---

## 3. 入站消息处理流

```
NapCat 上报
    │
    ▼
NapCatGatewayServer 接收并解析 JSON
    │
    ├─► 若为 Heartbeat / Lifecycle 事件: 维护连接活跃状态并应答
    │
    └─► 若为 Message 事件:
            │
            ├─► 消息持久化写入 SQLite (MessageDatabase)
            │
            ├─► 文本与卡片预处理 (提取 XML/JSON 卡片信息，下载私聊文件)
            │
            ├─► 检查是否被 wait_for_user_messages 挂起收集器捕获:
            │       └─► 若是: 存入待收集列表并直接返回，抑制唤醒
            │
            ├─► 检查是否为斜杠命令:
            │       └─► 若是: 校验发送者权限，执行命令并直接回出站消息，中断后续流程
            │
            ├─► 唤醒判定 (shouldWakeup):
            │       ├─ 私聊: 直接唤醒
            │       └─ 群聊: 判定 @机器人、别名点名、引用回复或主动回复策略 (随机概率/冷场潜水)
            │
            └─► 提交至 SessionManager:
                    │
                    ├─ 按 peerId（私聊 `user_<user_id>` / 群聊 `group_<group_id>`）分配或复用 DSH 会话
                    ├─ 会话编号映射：支持空缺填补（gap-filling）与防撞短哈希
                    ├─ 构造入站上下文标头：显式注入 `[消息ID: <id>]`，为出站引用提供锚点
                    └─ 排队推入 DSH 消息流 (DSH Turn)
```

---

## 4. 出站消息与用户侧静默原则

为保证交互的严谨性与多轮工具调用的完整性，系统贯彻**用户侧静默原则（Outbound Silence）**：

1. **废除纯文本直接推流**：
   - 大模型在 QQ 会话中生成的 assistant 文本流被底层桥接器静默拦截，不会直接作为 QQ 消息发送。
   - 杜绝了思考过程泄露、无效碎语以及未完成推理前的早退发信。
2. **工具显式出站 (`send_qq_message`)**：
   - 模型向 QQ 用户发言必须通过调用 `send_qq_message` 工具下发文本；
   - 发送图片、文件实体使用 `send_file` 工具；
   - 发送表情包使用 `send_face` 工具；
   - 发起结构化交互提问使用官方 `ask_user_question` 工具。
3. **工具与回合解耦（单 Agent 顺手维护）**：
   - 执行 `send_qq_message` 不会中断或强行结束当前回合（concludeTurn 解耦）；
   - 模型在调用工具把答案回复给用户后，可继续在同一回合中调用 `create_memory` / `edit_memory` 沉淀事实，或调用 `manage_faces` 维护表情库，随后自然完结。
4. **自主引用与艾特**：
   - 下线全局死板的自动引用与艾特开关；
   - 模型根据入站标头 `[消息ID: <id>]` 与上下文逻辑，在 `send_qq_message` 中自主传递 `reply_to`（数字 ID）与 `at_user`（QQ 号）。
5. **对端串行隔离 (`PerPeerSerialSender`)**：
   - 针对同一个 QQ 群或私聊用户，所有文本、文件、卡片出站统一排入同一个串行队列，严格按序发送，杜绝并发乱序。

---

## 5. 记忆体系与单 Agent 顺手维护

记忆系统在 `src/memory/` 实现，采用两层结构：

1. **群聊会话记忆**：
   - 存储路径：`.dsh/napcat/napcat_memory/groups/<group_id>.md`
   - 内容：该群的共识规则、讨论背景、群内专有事实。
2. **用户画像记忆（跨群互通）**：
   - 存储路径：`.dsh/napcat/napcat_memory/users/<user_id>.md`
   - 内容：针对特定用户的交互偏好、习惯与关键背景，在不同群聊与私聊间通用。
3. **容量预算治理**：
   - 区分 `group_memory_budget_chars`（群聊上限，默认 2200 字符）与 `private_memory_budget_chars`（私聊上限，默认 1500 字符），防止注入内容撑爆模型上下文。
4. **摒弃独立后台 Agent，单 Agent 顺手提炼**：
   - 彻底摒弃了易造成状态冲突与 Token 浪费的独立后台 Fork 回顾会话；
   - 主会话 Agent 在输出回复后，依托工具解耦机制在同轮次顺手提炼并更新记忆，轻量而稳定。

---

## 6. 表情包体系设计

当在配置中开启 `face_enabled: true` 时，激活表情包管理能力：

1. **存储架构**：
   - 表情图片物理文件存储于 `.dsh/napcat/faces/`；
   - 元数据（`face_id`、格式、标签 `tags`、情绪 `mood`、使用热度等）记录于 SQLite 数据库 `faces` 表中。
2. **闭环工具流**：
   - **查库**：`list_faces` 检索心仪表情包；
   - **发送**：`send_face` 下发表情消息；
   - **偷图/收藏**：`collect_face` 录入聊天中出现的好图并打标；
   - **维护与淘汰**：`manage_faces` 修改标签或在满额时按 LRU / 策略清理。

---

## 7. 数据存储路径总览

所有持久化数据均规范化锚定于用户环境的 `.dsh/napcat/` 目录下：

| 数据类型 | 本地绝对路径 | 说明 |
|---|---|---|
| **SQLite 数据库** | `.dsh/napcat/messages.db` | 记录消息流水、事件审计、表情元数据与会话状态 |
| **多媒体资源缓存** | `.dsh/napcat/media/` | 接收到的外来图片、语音、文档缓存（受 7 天 TTL 自动清理） |
| **本地表情库** | `.dsh/napcat/faces/` | 机器人收藏并维护的本地表情包文件库 |
| **两层记忆文件** | `.dsh/napcat/napcat_memory/` | Markdown 格式存储的群聊记忆 (`groups/`) 与用户画像 (`users/`) |
