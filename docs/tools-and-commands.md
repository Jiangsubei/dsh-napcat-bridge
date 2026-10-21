# 工具与命令

本文档说明 dsh-napcat-bridge 向 DSH 注册的 Agent 工具定义，以及供管理员在 QQ 聊天中执行的斜杠命令。

---

## 1. Agent 工具集

插件通过 `registerAgentTools` 向 DSH 的 `ctx.tools` 注册工具，大模型可自主决策调用：

### 1.1 历史与上下文检索

| 工具名称 | 功能描述 | 关键参数 |
|---|---|---|
| `read_chat_history` | 检索当前群聊或私聊的历史聊天记录，支持关键词、发送者昵称、消息类型、时间跨度等多维度组合筛选。 | `keyword` (string), `sender_name` (string), `user_id` (string), `type` (string: `text`/`image`/`sticker`/`file`/`group_file`/`forward`/`poke`), `since` (string: 相对时间如 `7d` 或自然日期), `until` (string), `limit` (number, 默认 20, 上限 100) |
| `fetch_chat_resource` | 凭 `file_id`（群文件附带 `busid`）现拉外部文件到本地，返回可读取路径。 | `file_id` (string, 必填), `busid` (number, 群文件专用), `file_name` (string, 保存文件名建议) |
| `expand_forward_message` | 根据 `forward_id` 展开合并转发消息内容。内层图片自动下载落盘并返回 `local_path`。 | `forward_id` (string, 必填) |

### 1.2 交互与多媒体

| 工具名称 | 功能描述 | 关键参数 |
|---|---|---|
| `send_file` | 主动向当前会话（群聊或私聊）发送本地生成的文件、报告或图片产物。与当前对端共用串行出站队列。 | `file_path` (string, 必填), `file_type` (string, 可选 `image`/`file`, 默认按扩展名推导) |
| `poke_user` | 主动在群内戳指定用户或在私聊窗口抖动用户。 | `user_id` (string, 必填，目标用户 QQ 号) |
| `list_group_files` | 获取当前群聊历史上传文件列表与本地索引，返回包含文件名、上传者、时间、`file_id` 和 `busid` 的清单。 | `file_name` (string, 模糊搜索), `sender_name` (string), `user_id` (string), `since` (string), `until` (string), `limit` (number, 默认 50, 上限 100) |
| `react_message` | 为群聊中的指定消息贴表情回应。 | `emoji` (string, 必填，25 种预设语义键如 `thumbs_up`, `heart`, `laugh`, `doge`, `ok` 等), `message_id` (number, 可选，默认绑定当前入站消息) |
| `wait_for_user_messages` | 挂起等待当前会话的新用户消息：设置等待窗口（`timeout` 秒），收集窗口内到达的消息后一次性返回。 | `timeout` (number, 必填，等待秒数), `user_id` (string, 可选，群聊指定过滤特定发言者 QQ) |

### 1.3 记忆管理工具

由 `setupMemoryService` 注册，用于读写 Markdown 记忆文件：

| 工具名称 | 功能描述 | 关键参数 |
|---|---|---|
| `read_memory` | 读取当前会话的规则与群文化记忆（`session`），或指定用户的个人画像（`user`）。 | `type` (string, 必填: `session`/`user`), `peer` (string, 可选，默认当前会话), `qq` (string, 可选，目标用户 QQ) |
| `create_memory` | 初始化创建用户跨场景稳定画像（`user`）或当前会话专属规则/文化（`session`）。单条限制极度精简，受字符预算上限限制。 | `type` (string, 必填: `session`/`user`), `content` (string, 必填，精简单行陈述), `peer` (string, 可选), `qq` (string, 可选) |
| `edit_memory` | 定向修改或删减已有记忆。通过 `old_string` 精确匹配替换为 `new_string`；若 `new_string` 省略或为空则直接删除该片段。 | `type` (string, 必填: `session`/`user`), `old_string` (string, 必填，精确匹配现有文本), `new_string` (string, 可选，留空为删除), `peer` (string, 可选), `qq` (string, 可选) |

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


