# 配置说明

本文档说明 dsh-napcat-bridge 的所有配置项、默认值与生效机制。

---

## 1. 配置途径

插件支持以下配置来源，按优先级从高到低合并：

1. **DSH WebUI 设置卡片**：在 `http://127.0.0.1:3080/` 设置面板中动态修改并实时保存至 DSH 配置存储。
2. **启动配置 (`apply` 传入对象)**：DSH 挂载插件时传入的配置。
3. **内置默认值**：定义于 `src/constants/index.ts`。

---

## 2. 配置项清单

### 2.1 网关与网络

| 参数 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `ws_port` | `number` | `8080` | 反向 WebSocket 服务端监听端口，NapCat 连接此端口。 |
| `ws_token` | `string` | `""` | 连接鉴权 Token。若填写，NapCat 必须在请求头或 URL 中携带相同的 Token。 |
| `bot_qq` | `string` | `""` | 机器人自身 QQ 号。用于过滤自身发出的消息，并作为群聊中判定 @机器人 的依据。 |
| `admins` | `string[]` | `[]` | 管理员 QQ 号列表。仅名单内的 QQ 号有权限触发管理类斜杠命令。 |
| `aliases` | `string[]` | `[]` | 助手在群聊中的别名列表。群消息以别名开头时可直接唤醒助手。 |

### 2.2 出站回复格式

| 参数 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `at_questioner` | `boolean` | `false` | 群聊回复时是否在文本前添加 `@提问者`。 |
| `quote_original` | `boolean` | `true` | 群聊回复时是否引用触发该轮回复的原消息。 |
| `image_ttl_days` | `number` | `7` | 接收到的外来图片与媒体文件在本地缓存保留天数，过期后由定时任务清理。 |

### 2.3 人设与行为

| 参数 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `persona` | `string` | *(内置)* | 助手的人格设定，拼接注入至动态 System Prompt 中。 |
| `behavior` | `string` | *(内置)* | 助手的行为准则与回复约束，拼接注入至动态 System Prompt 中。 |

### 2.4 主动回复策略（群聊）

| 参数 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `proactive_reply_enabled` | `boolean` | `false` | 群聊主动回复的总开关。 |
| `proactive_only_text` | `boolean` | `false` | 仅对纯文本消息判定主动回复。开启后，对于包含图片、视频、表情包等多模态消息不触发主动回复。 |
| `proactive_random_enabled` | `boolean` | `false` | 是否启用群聊普通消息的随机概率唤醒。 |
| `proactive_random_probability` | `number` | `0.05` | 普通消息随机唤醒概率（取值范围 0~1，0.05 即 5%）。 |
| `proactive_idle_enabled` | `boolean` | `false` | 是否启用群聊长时间冷场后的潜水超时唤醒。 |
| `proactive_idle_timeout_mins` | `number` | `120` | 潜水判定阈值（单位：分钟）。群聊静默超过此时长后触发主动发言。 |
| `proactive_cooldown_mins` | `number` | `10` | 主动回复后的冷却时间（单位：分钟）。冷却期内不重复主动触发。 |
| `proactive_night_dnd` | `boolean` | `true` | 夜间免打扰开关。每日 23:00 至次日 08:00 期间暂停所有主动回复判定。 |

### 2.5 记忆体系与预算控制

| 参数 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `memory_storage_dir` | `string` | `".dsh/napcat/napcat_memory"` | 记忆 Markdown 文件的根存储目录。 |
| `group_memory_budget_chars` | `number` | `2200` | 群聊场景下注入 System Prompt 的群规与群友画像字符总上限。 |
| `private_memory_budget_chars` | `number` | `1500` | 私聊场景下单用户画像注入与单次写入的字符上限。 |

### 2.6 表情包系统

| 参数 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `face_enabled` | `boolean` | `false` | 控制新建会话是否在预设中装载表情包工具集，保存后对后续新会话生效。 |
| `face_store_max` | `number` | `100` | 本地表情库可用表情容量上限。 |
| `face_store_dir` | `string` | `".dsh/napcat/faces"` | 本地表情图片文件存储目录。 |
| `face_sub_type` | `number` | `1` | OneBot 11 发送表情图片消息段使用的 sub_type 值。 |
| `face_evict_policy` | `string` | `"evict_lru"` | 容量满额时的淘汰策略（`"reject"` 拒绝新增 / `"evict_lru"` 淘汰最久未用）。 |
