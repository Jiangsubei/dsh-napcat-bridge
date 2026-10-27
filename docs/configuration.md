# 配置说明

本文档说明 dsh-napcat-bridge 的所有配置项、默认值与生效机制。

---

## 1. 配置途径与优先级

插件支持以下配置来源，按优先级从高到低合并：

1. **DSH WebUI 设置卡片**：在 `http://127.0.0.1:3080/` 设置面板中动态修改并实时保存至 DSH 配置存储（全部字段均标记为 `.volatile()`，支持即时热更新）。
2. **启动配置 (`apply` 传入对象)**：DSH 挂载插件时传入的配置。
3. **内置默认值**：定义于 `src/constants/index.ts` 与 `src/config/schema.ts`。

---

## 2. WebUI 设置 Tab 分组与配置项清单

WebUI 设置卡片分为 5 个分组 Tab，共包含 24 项有效运行时配置：

### 2.1 Tab 1: 连接身份 (Connection)

| 参数 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `ws_port` | `number` | `8080` | 反向 WebSocket 服务端监听端口，NapCat 连接此端口。端口变更时触发服务自动热重启。 |
| `ws_token` | `string` | `""` | 连接鉴权 Token。若填写，NapCat 必须在请求头或 URL 中携带相同的 Token。 |
| `bot_qq` | `string` | `""` | **核心必填项**。机器人自身 QQ 号，用于过滤自身发出的消息（自循环防护）并作为群聊中判定 @机器人 的基准。 |
| `admins` | `string[]` | `[]` | 管理员 QQ 号白名单。仅名单内的 QQ 号有权限触发管理类斜杠命令。 |
| `aliases` | `string[]` | `[]` | 助手在群聊中的别名列表。群消息以别名开头时可直接唤醒助手。 |
| `image_ttl_days` | `number` | `7` | 接收到的外来图片与多媒体缓存文件保留天数，过期后由定时任务自动清理。 |

---

### 2.2 Tab 2: 人格与准则 (Persona & Behavior)

| 参数 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `persona` | `string` | *(内置)* | 助手的人格设定，拼接注入至动态 System Prompt 中。 |
| `behavior` | `string` | *(内置)* | 助手的行为准则与回复约束，拼接注入至动态 System Prompt 中。 |

---

### 2.3 Tab 3: 主动回复 (Proactive)

| 参数 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `proactive_reply_enabled` | `boolean` | `false` | 群聊主动回复的总开关。 |
| `proactive_interval_mins` | `number` | `3` | 主动回复巡检窗口期（单位：分钟）。定时检查群聊期间新消息，有新消息才聚合唤醒 Agent 研读并决策是否回复。 |
| `proactive_only_text` | `boolean` | `false` | 仅对纯文本消息判定主动回复。开启后，包含图片、视频、表情包等多模态消息不缓冲入待读池。 |
| `proactive_idle_enabled` | `boolean` | `false` | 是否启用群聊长时间冷场后的潜水超时唤醒。 |
| `proactive_idle_timeout_mins` | `number` | `120` | 潜水判定阈值（单位：分钟）。群聊静默超过此时长后由轮询周期对齐触发主动破冰。 |
| `proactive_night_dnd` | `boolean` | `true` | 夜间免打扰开关。每日 23:00 至次日 08:00 期间暂停主动回复与潜水冒泡。 |

---

### 2.4 Tab 4: 记忆 (Memory)

| 参数 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `memory_storage_dir` | `string` | `".dsh/napcat/napcat_memory"` | 记忆 Markdown 文件的根存储目录。 |
| `group_memory_budget_chars` | `number` | `2200` | 群聊场景下注入 System Prompt 的群规与群友画像字符总上限。 |
| `private_memory_budget_chars` | `number` | `1500` | 私聊场景下单用户画像注入与单次写入的字符上限。 |

---

### 2.5 Tab 5: 表情包 (Face)

| 参数 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `face_enabled` | `boolean` | `false` | 控制新建会话是否在预设中装载表情包工具集，保存后对后续新会话生效。 |
| `face_store_max` | `number` | `100` | 本地表情库可用表情容量上限。 |
| `face_store_dir` | `string` | `".dsh/napcat/faces"` | 本地表情图片文件存储目录。 |
| `face_sub_type` | `number` | `1` | OneBot 11 发送表情图片消息段使用的 sub_type 值。 |
| `face_evict_policy` | `string` | `"evict_lru"` | 容量满额时的淘汰策略（`"reject"` 拒绝新增 / `"evict_lru"` 淘汰最久未用）。 |

---

## 3. 已下线配置说明与迁移指引

在近期架构重构中，为贯彻轻量化单 Agent 架构与规范出站机制，以下历史配置已下线：

1. **群聊引用与艾特死配置 (`group_reply_quote`, `group_reply_at`)**：
   - **下线原因**：旧版通过全局开关强制引用或 @ 发送者，行为过于机械刻板。
   - **现状与迁移**：出站消息遵循「用户侧静默原则」，全部经由 `send_qq_message` 工具出站。大模型根据入站消息标头 `[消息ID: <id>]` 与语境推理，自主决定是否传递 `reply_to`（数字 ID）与 `at_user`（QQ 号），不再需要全局死板开关。
2. **空回复行为配置 (`empty_reply_behavior`, `empty_reply_text`)**：
   - **下线原因**：模型回复完全由 `send_qq_message` 工具调用驱动，不再依赖 assistant 文本推流降级。
3. **独立后台 Agent 配置 (`bg_agent_*`, `face_organizer_*`)**：
   - **下线原因**：全面下线独立后台 Agent，改为单主 Agent 会话内顺手提炼记忆与维护表情，杜绝并发竞争与无谓 Token 损耗。

4. **群聊普通消息概率插话与固定冷却配置 (`proactive_random_enabled`, `proactive_random_probability`, `proactive_cooldown_mins`)**：
   - **下线原因**：旧版单条消息即时概率插话缺乏完整话题上下文，易造成断章取义、突兀插话；
   - **现状与迁移**：升级为窗口期新消息聚合轮询（由 `proactive_interval_mins` 窗口期统一调度）。普通消息自动存入缓冲池并在周期到达时打包输入，同时赋予 Agent 自主回复或输出 `[结束]` 保持静默的决策权，不再需要死板的概率插话与冷却时间配置。