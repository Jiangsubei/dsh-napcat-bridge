# 工具与命令

本文档说明 dsh-napcat-bridge 向 DSH 注册的 Agent 工具定义、装配机制，以及供管理员在 QQ 聊天中执行的斜杠命令。

---

## 1. Agent 工具集与装配机制

### 1.1 预设隔离装配（`qq-session`）

为了避免 QQ 专用工具泄露至非 QQ 会话（如 Web UI 常规对话），本插件不在根上下文全局注册 QQ 工具，而是通过 **`qq-session` 专属预设**（对应 `dsh-napcat-bridge/tools` 插件包）按需向 QQ 会话的 Agent 实例注入。

当 QQ 消息到达创建或唤醒会话时，Agent 会自动装载以下工具集（以及 DSH 基础工作区、Shell 与官方技能工具）。

---

### 1.2 出站与通信工具

> **用户侧静默原则（Outbound Silence）**：
> 大模型在 QQ 会话中的直接文本推流不会自动显示给 QQ 用户。要向用户发言、答复问题、同步进展或输出结论，**必须调用 `send_qq_message` 工具**。
> 执行 `send_qq_message` 发送消息不会强行终止回合推理，模型可在发送消息后在同一轮次中顺手调用记忆提炼或表情维护工具，自然平稳终结。

| 工具名称 | 功能描述 | 关键参数 |
|---|---|---|
| `send_qq_message` | 向当前 QQ 会话发送纯文本消息。是模型向 QQ 用户发言的唯一文本出站通道。 | `text` (string, 必填: 要发送的文本内容)<br>`reply_to` (number, 可选: 需要引用的目标消息数字 ID，来自入站标头 `[消息ID: <id>]` 或 `read_chat_history`)<br>`at_user` (string, 可选: 需要艾特的目标用户 QQ 号，仅群聊生效) |
| `send_file` | 向当前会话（群聊或私聊）发送本地磁盘上的生成文件、导出报告或图片实体产物。共用串行出站队列。 | `file_path` (string, 必填: 本地绝对路径、`file://` URI 或 URL)<br>`file_type` (string, 可选 `image`/`file`, 默认按扩展名自动推导) |
| `poke_user` | 主动在群内戳指定用户，或在私聊窗口向对方发送窗口抖动。 | `user_id` (string, 必填: 目标用户的 QQ 号) |
| `react_message` | 为群聊中的指定消息贴表情回应（轻量情绪表态，无需发文字）。**仅限群聊调用**。 | `emoji` (string, 必填: 25 种预设语义键如 `thumbs_up`, `heart`, `laugh`, `doge`, `ok`, `cat`, `thinking` 等)<br>`message_id` (number, 可选: 目标消息 ID，省略时自动绑定当前入站消息) |

---

### 1.3 历史与上下文检索工具

| 工具名称 | 功能描述 | 关键参数 |
|---|---|---|
| `read_chat_history` | 检索本地 SQLite 历史聊天记录。默认查询当前会话，也可通过 `peer` 指定目标群聊/私聊做只读查询（如在私聊中查看某个群的最新动态）。支持关键词、发言人、消息类型、消息来源、时间跨度、排除自身等全维度组合筛选。**默认只返回真实 QQ 消息**；Agent 内部协同通讯需显式传 `source='agent'` 才展示（`sender_name='内部通讯'`、`user_id='agent:<来源SessionID>'`），上下文压缩后可据此回溯任务来源。常用于追溯前情、复述发言、或捞取下游工具所需的 `message_id`。 | `peer` (string, 可选: 目标会话标识如 `group_8000000001` 或 `user_1000000001`，缺省为当前会话)<br>`keyword` (string, 关键词模糊搜索)<br>`sender_name` (string, 发送者昵称/群名片)<br>`user_id` (string, 发送者 QQ 号；内部通讯为 `agent:<来源SessionID>`)<br>`type` (string: `text`/`image`/`sticker`/`file`/`group_file`/`forward`/`poke`)<br>`source` (string: `qq` 真实 QQ 消息 / `agent` 内部协同通讯 / `all` 两者；缺省等价 `qq`)<br>`since` (string: 相对时间如 `30m`, `2h`, `7d` 或自然日期 `2026-08-30`)<br>`until` (string: 截止时间)<br>`relative` (string: 快捷时间窗口如 `1h`, `1d`)<br>`has_file` (boolean: 仅查媒体附件)<br>`reply_to` (number: 查引用了某消息的回复)<br>`exclude_self` / `self_only` (boolean: 排除/仅查机器人自身发言)<br>`limit` (number: 默认 20，上限 100)<br>`order` (string: `asc`/`desc`，默认 `desc` 取最新) |
| `fetch_chat_resource` | 根据资源 `file_id`（群文件需附带 `busid`）现拉外部文件或富媒体到本地磁盘，返回本地物理路径 `local_path` 供后续文件/图片工具消费。 | `file_id` (string, 必填: 资源 ID)<br>`busid` (number, 群文件专用 busid)<br>`file_name` (string, 保存文件名建议) |
| `expand_forward_message` | 展开聊天记录合并转发（多条消息聚合卡片）的内部真实对话。内层图片自动下载落盘并返回 `local_path`。 | `forward_id` (string, 必填: 合并转发 ID) |
| `list_group_files` | 获取当前群聊已上传的文件列表与索引清单（包含文件名、上传者、时间、`file_id` 和 `busid`）。检索后可传给 `fetch_chat_resource` 下载。 | `file_name` (string, 按群文件名模糊搜索)<br>`sender_name` (string, 按上传者昵称模糊搜索)<br>`user_id` (string, 按上传者 QQ 号筛选)<br>`since` / `until` (string, 时间范围)<br>`limit` (number: 默认 20，上限 100)<br>`order` (string: `asc`/`desc`，默认 `desc`) |

---

### 1.4 交互与等待工具

| 工具名称 | 功能描述 | 关键参数 |
|---|---|---|
| `wait_for_user_messages` | 临时挂起会话并等待用户继续发送消息，在指定窗口时间内收集到达的新消息后统一恢复执行。一般仅用于纯图片/排障截图且无文字说明、对方话没说完或只说了半句等明确需要等对方补充下文的场景，不包括斗图、刷表情包等场景。 | `timeout` (number, 必填: 等待秒数，插件不设死上限)<br>`user_id` (string, 可选: 群聊时指定只收集该 QQ 号的消息；私聊自动单用户) |
| `ask_user_question` *(DSH 官方核心工具)* | 官方标准交互提问工具。在需要用户澄清需求、提供缺失信息或从多选项中抉择确认时发起结构化提问。 | 由 DSH 官方规范定义，支持多选项与自由输入模式。 |

---

### 1.5 记忆管理工具

由 `setupMemoryService` 注册，用于读写 Markdown 记忆文件，支持单 Agent 顺手维护：

| 工具名称 | 功能描述 | 关键参数 |
|---|---|---|
| `read_memory` | 读取当前会话的规则与群文化记忆（`session`），或指定用户的跨场景个人画像（`user`）。 | `type` (string, 必填: `session`/`user`)<br>`peer` (string, 可选: 默认当前会话对端)<br>`qq` (string, 可选: 目标用户 QQ 号) |
| `create_memory` | 初始化创建用户跨场景稳定画像（`user`）或当前会话专属规则/文化（`session`）。内容受对应字符预算上限限制，超限时本次创建不落盘并要求精简后重试。 | `type` (string, 必填: `session`/`user`)<br>`content` (string, 必填: 精简单行陈述事实)<br>`peer` (string, 可选)<br>`qq` (string, 可选) |
| `edit_memory` | 定向修改或删减已有记忆。通过 `old_string` 精确匹配替换为 `new_string`；若 `new_string` 省略或为空则直接删除该片段。编辑后总长超预算时本次编辑不落盘，并返回还需缩减的字符数。 | `type` (string, 必填: `session`/`user`)<br>`old_string` (string, 必填: 精确匹配现有文本片段)<br>`new_string` (string, 可选: 替换内容，留空表示删除)<br>`peer` (string, 可选)<br>`qq` (string, 可选) |

---

### 1.6 表情包管理工具（受 `face_enabled: true` 门控）

当在设置中开启 `face_enabled`（表情包功能总开关）时，新建会话会自动装载以下 4 个表情包专用工具：

| 工具名称 | 功能描述 | 关键参数 |
|---|---|---|
| `list_faces` | 在机器人本地表情库中检索可用的表情包。支持按情绪（mood）、标签（tag）或自由关键词（query）查验可用库存；结果按收录时间倒序排列，支持 offset/limit 分页。返回合法 `face_id`、标签、情绪及本地路径。 | `query` (string, 综合模糊检索，同时匹配标签与情绪)<br>`mood` (string, 按情绪筛选，支持模糊包含匹配)<br>`tag` (string, 按画面元素筛选，支持模糊包含匹配)<br>`untagged` (boolean, 是否只查未打标表情)<br>`offset` (number: 起始序号偏移，默认 0，翻页直接回填 `next_offset`)<br>`limit` (number: 默认 100，上限 100) |
| `send_face` | 根据表情 ID 将一张本地表情包作为独立表情消息发送到聊天中。用于表达情绪、接梗斗图。 | `face_id` (string, 必填: 目标表情 ID，来自 `list_faces` 结果) |
| `collect_face` | 将聊天中的图片收录入本地表情库，并打上初始标签与情绪。用于用户要求“把这图存成表情”或聊天中出现好梗图时。 | `tags` (string[], 必填: 画面内容与文字标签列表)<br>`mood` (string, 必填: 情绪与语境意图)<br>`message_id` (number, 可选: 目标消息 ID，默认绑定当前入站消息) |
| `manage_faces` | 管理与维护本地表情包库：更新已有表情标签/情绪、删除表情、查询存储配额占用、或按 LRU 淘汰冷门表情。 | `action` (string, 必填: `update`/`delete`/`query_quota`/`evict`)<br>`face_id` (string, update 或 delete 时必填)<br>`tags` (string[], update 时可选)<br>`mood` (string, update 时可选)<br>`count` (number, evict 时可选淘汰数量) |

---

### 1.7 群成员感知工具（仅群聊生效）

| 工具名称 | 功能描述 | 关键参数 |
|---|---|---|
| `get_group_member_info` | 查询当前群聊的成员身份与名片信息（包含 QQ 号、群名片、昵称、角色 owner/admin/member 与加群时间），结果按 QQ 号升序排列。内置 5 分钟 TTL 本地缓存池，支持 offset/limit 分页。**仅限群聊调用**。 | `user_id` (string \| number, 可选: 目标成员 QQ 号，精确查询)<br>`query` (string, 可选: 按群名片或昵称模糊匹配搜索)<br>`role` (string, 可选: 按角色筛选 `owner`/`admin`/`member`)<br>`no_cache` (boolean, 可选: 强制穿透缓存刷新)<br>`offset` (number: 起始序号偏移，默认 0，翻页直接回填 `next_offset`)<br>`limit` (number: 默认 20，上限 50) |

---

### 1.8 定时任务调度工具

| 工具名称 | 功能描述 | 关键参数 |
|---|---|---|
| `schedule_task` | 安排定时单次延迟或周期 Cron 任务。到达时间后系统自动唤醒 Agent 并将设定的 prompt 注入会话执行。夜间免打扰时段自动顺延。 | `task_id` (string, 必填: 任务唯一标识符)<br>`type` (string, 必填: `once` 单次延迟 / `cron` 周期性任务)<br>`delay_seconds` (number, `once` 模式必填: 延迟触发秒数)<br>`cron` (string, `cron` 模式必填: 标准 5 段式 Cron 表达式如 `0 9 * * *`)<br>`prompt` (string, 必填: 触发时唤醒 Agent 的提示词内容)<br>`description` (string, 可选: 任务备注说明) |
| `manage_scheduled_tasks` | 查询、管理或取消已安排的定时任务。 | `action` (string, 必填: `list` 列出所有任务 / `cancel` 取消指定任务 / `get` 获取任务详情)<br>`task_id` (string, `cancel` 或 `get` 时必填: 目标任务 ID) |

---

### 1.9 黑话词库管理工具（受 `slang_enabled: true` 门控）

当在设置中开启 `slang_enabled`（黑话学习功能总开关）时，新建会话会自动装载以下 3 个黑话管理工具：

| 工具名称 | 功能描述 | 关键参数 |
|---|---|---|
| `query_slang` | 查询群聊黑话词条的详细释义、使用场景与真实例句。模型遇到上下文 L1 索引中存在的词条且前文尚未查询掌握时应调用本工具查明真实含义，前文已查询掌握则无需重复查询；禁止未查明即主观臆测；调用成功自动增加词条查阅热度。 | `term` (string, 必填: 待查询释义的目标黑话词条) |
| `record_slang` | 收录群聊中发现的新黑话、网络梗词或圈内行话。需提供四项规范字段以保证知识库质量。 | `term` (string, 必填: 词条名称，1~30字)<br>`definition` (string, 必填: 核心含义与深层梗意)<br>`context` (string, 必填: 适用语境、发言情绪与排他禁忌)<br>`example` (string, 必填: 地道群聊使用例句) |
| `manage_slang` | 管理与维护黑话词库：更新已有词条内容、删除词条、分页浏览或在满额时按 LRU 淘汰模型查阅最少的冷门词条。 | `action` (string, 必填: `update` / `delete` / `list` / `evict`)<br>`term` (string, `update` 或 `delete` 时必填)<br>`definition` / `context` / `example` (string, `update` 时可选)<br>`count` (number, `evict` 时可选淘汰数量) |

---

### 1.10 Agent 内部协同工具

用于 QQ Agent 之间的内部协同：先创建/唤醒目标 Agent，再通过内部总线投递任务与回执。内部消息不会发送到 QQ，真实用户完全不可见。

| 工具名称 | 功能描述 | 关键参数 |
|---|---|---|
| `list_active_agents` | 查询当前活跃或已实例化的 Agent 会话（Session ID、peer、目标类型与号码、是否繁忙），用于协同前寻址。 | `target_type` (string, 可选: `user` 仅私聊 / `group` 仅群聊) |
| `create_target_agent` | 为指定 QQ 用户或群聊创建并激活常驻 Agent，并注入初始使命。**必须显式指定 `target_type`**，避免把群号误当成 QQ 号建成私聊会话。仅当用户明确指定目标对象（谁 / 哪个群）且需要主动发起会话时调用，不要自行猜测或批量创建。目标已存在时只返回其 Session ID，不重复注入。 | `target_type` (string, 必填: `user` QQ 私聊用户含临时会话 / `group` QQ 群聊)<br>`target_id` (string, 必填: 目标 QQ 号或群号，纯数字)<br>`initial_message` (string, 必填: 初始使命或任务背景) |
| `send_agent_message` | 向指定 Session ID 的目标 Agent 发送内部协作消息（布置任务、同步上下文或回传成果）。目标会话必须已创建并激活；未激活时先调用 `create_target_agent`。协作遵循「回执即止」：被派发方回执一次即可，发起方收到回执后若无新的明确要求不再回复确认、致谢或追问。 | `target_session_id` (string, 必填: 形如 `qq-user-1000000001` 或 `qq-group-8000000001`)<br>`message` (string, 必填: 内部协作内容) |

---

---

### 1.11 社交关系链与 QQ 空间工具

好友 / 群 / 群成员列表统一采用 `offset + limit` 分页：`offset` 从 0 开始，作用于过滤后的结果集；翻页时直接回填返回的 `next_offset` 即可。渲染结果带跨页连续的全局序号，便于模型直接换算偏移量。

| 工具名称 | 功能描述 | 关键参数 |
|---|---|---|
| `get_friend_list` | 查询机器人 QQ 好友列表，按 QQ 号升序排列，支持昵称/备注模糊搜索。 | `query` (string, 可选)<br>`offset` (number: 默认 0)<br>`limit` (number: 默认 20，上限 50)<br>`no_cache` (boolean, 可选) |
| `get_group_list` | 查询机器人已加入的群聊列表，按群号升序排列，支持群名/群备注模糊搜索。 | `query` (string, 可选)<br>`offset` (number: 默认 0)<br>`limit` (number: 默认 20，上限 50)<br>`no_cache` (boolean, 可选) |
| `get_user_profile` | 查询任意 QQ 用户的公开资料卡。 | `user_id` (string \| number, 必填) |
| `get_group_info` | 查询指定群的基础信息与元数据。 | `group_id` (string \| number, 必填) |
| `get_group_notice` | 查询指定群的历史公告列表。 | `group_id` (string \| number, 必填) |
| `read_qzone_feeds` | 浏览 QQ 空间动态。好友动态流翻页**优先使用 `cursor`/`next_cursor`**；`offset` 仅在未传 `cursor` 时生效，查看自己/指定好友动态时直接映射底层位置偏移。 | `scope` (string: `friends` / `self` / `user`)<br>`target_qq` (string \| number, scope=user 时必填)<br>`limit` (number: 默认 5，上限 10)<br>`cursor` (string, 好友流翻页游标，优先于 offset)<br>`offset` (number, 兼容路径)<br>`after_feed_id` (string, 断点续读) |
| `publish_qzone_feed` | 发布一条 QQ 空间动态（内置 60 秒冷却）。 | `content` (string, 必填)<br>`images` (string[], 可选) |
| `comment_qzone_feed` | 评论指定 QQ 空间动态（内置 15 秒冷却）。 | `feed_id` (string, 必填)<br>`target_qq` (string \| number, 必填)<br>`content` (string, 必填) |
| `delete_qzone_feed` | 删除自己发布过的 QQ 空间动态。 | `feed_id` (string, 必填) |

---

## 2. QQ 斜杠命令

在聊天输入框中以 `/` 或全角 `／` 开头的消息被识别为斜杠命令。

### 2.1 权限控制与安全

- **管理员白名单校验**：只有发送者 QQ 存在于 `admins` 配置白名单中时，系统才会执行该命令；
- **越权拦截**：非白名单用户发送斜杠命令时，统一返回 `权限不足：仅管理员允许执行指令` 并直接阻断后续大模型推理流程，杜绝未授权调度；
- **全两字中文指令**：系统采用纯两字中文命令设计，不保留繁杂的英文命令，易记易用。

### 2.2 命令清单

| 指令 | 参数格式 | 功能说明 |
|---|---|---|
| `/帮助` | 无 | 输出所有可用斜杠命令的语法、参数说明与使用范例。 |
| `/状态` | 无 | 输出当前网关连接状态、进程运行时间、已加载的会话数与消息累计计数。 |
| `/用量` | 无 | 查询当前会话的 Token 消耗、累计调用轮次与统计指标。 |
| `/新建` | `[标题]` (可选) | 强制解绑当前对端的活跃会话并创建新 DSH 会话。支持通过空缺编号自动填补保持序列整齐。 |
| `/会话` | `[编号/ID]` | 切换当前对端绑定的历史 DSH 会话；若不带参数则列出当前对端可用的历史会话清单。 |
| `/停止` | 无 | 强行终止当前正在执行的 Agent 回合推理与工具调用链。 |
| `/权限` | `[只读/编辑/完全]` | 查询或切换当前会话的执行权限模式（只读: `read-only`, 编辑: `workspace-write`, 完全: `danger-full-access`）。 |
| `/模型` | `[-g] [模型名]` | 查询可用模型列表或切换当前会话的模型。添加 `-g` 或 `--全局` 标识时同步更新所有会话的默认模型。 |
| `/思考` | `[开启/关闭/低/中/高]` | 调整当前模型推理的 reasoning effort（思维链深度），支持开关与梯度配置（亦兼容 `off`/`low`/`high`/`max`）。 |
