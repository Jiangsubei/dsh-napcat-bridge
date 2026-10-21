# 工具与命令

本文档说明 dsh-napcat-bridge 向 DSH 注册的 Agent 工具定义，以及供管理员在 QQ 聊天中执行的斜杠命令。

---

## 1. Agent 工具集

插件通过 `registerAgentTools` 向 DSH 的 `ctx.tools` 注册工具，大模型可自主决策调用：

### 1.1 历史与上下文检索

| 工具名称 | 功能描述 | 关键参数 |
|---|---|---|
| `read_chat_history` | 查询 SQLite 本地消息库历史。支持按关键字、发送者 QQ、群号、时间范围多维过滤。 | `keyword` (string), `sender_id` (string), `group_id` (string), `limit` (number, 默认 20) |
| `fetch_chat_resource` | 获取指定消息中引用的资源详情（如卡片消息提取后的 URL、私聊接收到的本地文件绝对路径）。 | `message_id` (number) |
| `expand_forward_message` | 展开并解析 QQ 合并转发消息内容节点。 | `res_id` (string) |

### 1.2 交互与多媒体

| 工具名称 | 功能描述 | 关键参数 |
|---|---|---|
| `send_file` | 主动向当前会话（群聊或私聊）发送本地文件、图片或文档。与当前对端共用串行出站队列。 | `file_path` (string), `file_type` (string, 可选 `image`/`file`), `name` (string, 可选) |
| `poke_user` | 戳一戳指定群成员或私聊好友（发送 QQ 戳一戳或窗口抖动）。 | `user_id` (string, 私聊可省略) |
| `list_group_files` | 获取指定群聊的文件列表与根目录/子文件夹信息。 | `group_id` (string/number), `folder_id` (string, 可选) |
| `react_message` | 为群聊中的指定消息贴表情回应（基于 OneBot 11 `set_msg_emoji_like` API）。 | `message_id` (number, 可选，默认绑定当前入站消息), `emoji_id` (number) |
| `wait_for_user_messages` | 回合内等待用户补充消息，挂起当前 Agent 执行直到满足超时或收到特定消息。 | `timeout_ms` (number), `expected_count` (number) |

### 1.3 记忆管理工具

由 `setupMemoryService` 注册，用于读写 Markdown 记忆文件：

| 工具名称 | 功能描述 | 关键参数 |
|---|---|---|
| `read_memory` | 读取当前群聊记忆或指定用户的画像内容。 | `target` (string, 可选 `group` 或 `user`), `user_id` (string, 可选) |
| `create_memory` | 初始化创建群聊记忆或用户画像 Markdown 文件。 | `target` (string), `content` (string), `user_id` (string, 可选) |
| `edit_memory` | 对既有记忆文件进行局部精准替换或追加。受字符预算上限限制。 | `target` (string), `target_text` (string), `replacement_text` (string) |

---

## 2. QQ 斜杠命令

以 `/` 或全角 `／` 开头的消息被识别为斜杠命令。

### 2.1 权限控制
- 只有发送者 QQ 存在于 `admins` 配置白名单中时，插件才执行命令；
- 非白名单用户发送斜杠命令时，返回 `权限不足：仅管理员允许执行指令` 并拦截后续消息处理流程。

### 2.2 命令列表（两字中文指令）

| 指令 | 参数 | 说明 |
|---|---|---|
| `/帮助` | 无 | 输出所有可用命令的语法与简要说明。 |
| `/状态` | 无 | 输出当前网关连接状态、运行时间、已加载的会话数与消息计数。 |
| `/用量` | 无 | 查询当前会话的 Token 消耗、累计调用轮次与统计指标。 |
| `/新建` | `[标题]` (可选) | 强制结束当前对端的关联会话，并创建新 DSH 会话。支持通过空缺编号自动填补保持会话序列连续。 |
| `/会话` | `[编号/ID]` | 切换当前对端绑定的 DSH 会话，或列出当前对端可用的历史会话。 |
| `/停止` | 无 | 强行终止当前正在执行的 Agent 回合推理与工具调用链。 |
| `/权限` | `[只读/编辑/完全]` | 查询或切换当前会话的执行权限模式（只读: `read-only`, 编辑: `workspace-write`, 完全: `danger-full-access`）。 |
| `/模型` | `[-g] [模型名]` | 查询可用模型列表或切换当前会话的模型。添加 `-g` 或 `--全局` 标识时同步更新所有会话的默认模型。 |
| `/思考` | `[开启/关闭/低/中/高]` | 调整当前模型推理的 reasoning effort（思维链深度），支持开关与梯度配置。 |

---

## 3. 四斜杠管理命令 (`////`)

以 `////` 开头的消息为系统级管理通道：
- 仅管理员在私聊会话中可用；
- 直接穿透会话逻辑，将指令下发给 DSH 内部指令执行器或排查内部状态。
