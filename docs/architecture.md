# 系统架构

本文档说明 dsh-napcat-bridge 的模块构成、生命周期装配、数据流转机制与存储设计。

---

## 1. 架构总览

dsh-napcat-bridge 作为 DeepSeek Harness (DSH) 的 Cordis 插件运行，在 QQ 协议端 (NapCat) 与 DSH 核心运行时之间构建消息中继与会话代理。

```
+-------------------------------------------------------------------+
|                        DeepSeek Harness (DSH)                     |
|  [Agent Engine] <---> [Session Service] <---> [Tools / Prompts]   |
+-------------------------------------------------------------------+
                                  ^
                                  | (Cordis Lifecycle / Events / APIs)
                                  v
+-------------------------------------------------------------------+
|                       dsh-napcat-bridge                           |
|                                                                   |
|  +--------------------+  +------------------+  +---------------+  |
|  |   SessionManager   |  |  OutboundQueue   |  | MemoryService |  |
|  | (Peer 映射 / 队列) |  | (串行发送 / 绑定)|  | (两层画像/回顾)|  |
|  +--------------------+  +------------------+  +---------------+  |
|                                  ^                                |
|                                  | (事件分发与 API 调用)          |
|                                  v                                |
|  +-------------------------------------------------------------+  |
|  |                     NapCatGatewayServer                     |  |
|  |                 (反向 WebSocket 服务端 :8080)               |  |
|  +-------------------------------------------------------------+  |
+-------------------------------------------------------------------+
                                  ^
                                  | OneBot 11 协议 (WebSocket JSON)
                                  v
+-------------------------------------------------------------------+
|                         NapCat (QQ 客户端)                         |
+-------------------------------------------------------------------+
```

---

## 2. 插件生命周期与装配

插件入口位于 `src/index.ts`，导出符合 Cordis 标准的插件定义：

- `name`: 插件名称 `dsh-napcat-bridge`。
- `inject`: 声明依赖的服务，包含 `tools`、`systemPrompt`、`agents` 以及可选的 `settings`。
- `apply(ctx, config)`: 插件装配函数，依次执行以下初始化：
  1. 读取并合并配置（环境变量、配置文件与 WebUI 设置）。
  2. 初始化 SQLite 消息数据库 (`MessageDatabase`) 与多媒体存储管理器 (`MediaStorageManager`)。
  3. 启动反向 WebSocket 服务端 (`NapCatGatewayServer`)。
  4. 初始化群成员缓存解析器 (`CachedGroupMemberResolver`) 与会话管理器 (`SessionManager`)。
  5. 注册出站消息桥接与单对端串行发送队列 (`PerPeerSerialSender`)。
  6. 注册记忆服务 (`setupMemoryService`) 与动态提示词注入器 (`registerNapCatDynamicPrompt`)。
  7. 注册交互提问通道与审批响应器 (`NapCatApprovalResponder`)。
  8. 注册供大模型调用的 Agent 工具集 (`registerAgentTools`)。
  9. 挂载 WebUI 设置面板描述与配置路由。

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
            ├─► 检查是否为斜杠命令:
            │       └─► 若是: 校验发送者权限，执行命令并直接回出站消息，中断后续流程
            │
            ├─► 唤醒判定 (shouldWakeup):
            │       ├─ 私聊: 直接唤醒
            │       └─ 群聊: 判定 @机器人、别名点名、引用回复或主动回复判定
            │
            └─► 提交至 SessionManager:
                    │
                    ├─ 按 peerId（私聊 `user_<user_id>` / 群聊 `group_<group_id>`）分配或复用 DSH 会话
                    ├─ 会话编号映射：支持空缺填补（gap-filling）与防撞短哈希
                    └─ 排队推入 DSH 消息流 (DSH Turn)
```

---

## 4. 出站消息与串行发送

出站消息通过 `OutboundStreamBridge` 接收模型生成的文本或工具调用结果：

- **对端串行隔离 (`PerPeerSerialSender`)**：针对同一个 QQ 群或私聊用户，确保消息按生成顺序依次发送，避免乱序。
- **引用与 @ 绑定**：群聊场景下，根据设置自动添加 `@提问者` 或引用触发回合的原消息 ID (`reply_to`)。
- **长文本分片**：针对超过单条 QQ 消息字符限制的内容，按照段落与行边界进行分片发送。
- **多媒体处理**：本地文件路径转换为 NapCat 支持的 `file://` 或 CQ 码格式发往 QQ 端。

---

## 5. 记忆体系设计

记忆系统在 `src/memory/` 实现，分为两层：

1. **群聊会话记忆**：
   - 存储路径：`.dsh/napcat/napcat_memory/groups/<group_id>.md`
   - 内容：该群的公共讨论背景、项目偏好与共性事实。
2. **用户画像记忆（跨群互通）**：
   - 存储路径：`.dsh/napcat/napcat_memory/users/<user_id>.md`
   - 内容：针对特定用户的交互偏好、习惯与历史关键信息，在不同群聊与私聊中通用。
3. **容量预算治理**：
   - 每次生成 System Prompt 时，将记忆 Markdown 注入上下文；
   - 区分 `group_memory_budget_chars`（群聊上限，默认 2200 字符）与 `private_memory_budget_chars`（私聊上限，默认 1500 字符），防止超出模型上下文预算。
4. **单 Agent 统筹顺手维护**：
   - 彻底摒弃独立的后台 Fork 回顾会话，由主会话 Agent 在出站回复用户后，在同轮次内顺手调用 `create_memory` / `edit_memory` 提炼沉淀核心事实，自然平稳终结。

---

## 6. 数据存储路径

所有持久化数据均存放于用户环境的 `.dsh/napcat/` 目录下：

- **SQLite 数据库**：`.dsh/napcat/messages.db`（记录消息流水、事件审计与贴表情记录）
- **附件存储**：`.dsh/napcat/media/`（接收到的图片、语音、文件与本地生成的表情）
- **记忆存储**：`.dsh/napcat/napcat_memory/`（Markdown 格式的群聊记忆与用户画像）
