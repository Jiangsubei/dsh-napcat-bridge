# dsh-napcat-bridge

[![npm version](https://img.shields.io/npm/v/dsh-napcat-bridge.svg)](https://www.npmjs.com/package/dsh-napcat-bridge)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-%3E%3D0.2.0%20(up%20to%200.2.2)-4f46e5)](https://github.com/deepseek-ai/dsh)

DeepSeek Harness × OneBot 11 QQ 接入插件 —— 既是随叫随到的专业助手，也是懂梗斗图、能学黑话、主动冒泡的灵魂群友。让 DSH Agent 在 QQ 群聊 / 私聊中开箱即用。

---

## ✨ 功能特性

- **QQ 群聊 / 私聊全场景接入**：基于 OneBot 11 协议标准反向 WebSocket 连接，开箱支持 NapCat 与 SnowLuma 等协议端。
- **QQ 会话专属预设（`qq-session`）**：构建期与运行时单一真相源（SSOT）自动同步，专属注入 QQ 工具集，彻底杜绝工具向 Web UI 常规会话泄露；深度补齐工作区、跨平台 Shell（Windows pwsh / Linux bash）、Web 搜索、交互提问与技能系统，并抑制多余快照。
- **用户侧静默出站体系**：遵循「用户侧静默原则」，废除纯文本直接推流；文本出站统一由 **`send_qq_message`** 工具驱动，由模型根据入站标头 `[消息ID: <id>]` 与上下文逻辑自主决定是否引用原消息（`reply_to`）或艾特用户（`at_user`）。
- **工具与回合解耦（单 Agent 顺手维护）**：执行出站工具不强行终止回合，模型在回复用户后可在同一轮次中顺手调用记忆或表情管理工具，自然平稳终结。
- **消息撤回机制**：支持大模型自主撤回指定消息（`recall_message`），当发错内容、产生严重幻觉、收到用户撤回要求或在群聊中处置违规内容时可安全自愈（受 QQ 平台 2 分钟时限与权限约束）。
- **社交关系链与群聊画像感知**：支持好友列表（`get_friend_list`）、群列表（`get_group_list`）、用户资料卡（`get_user_profile`）、群基础信息（`get_group_info`）与群历史公告（`get_group_notice`）只读探查，全场景支持规范化的 `offset + limit` 分页。
- **跨 Agent 内部协同总线**：支持活跃 Agent 状态检索（`list_active_agents`）、定向创建激活常驻 Agent（`create_target_agent`）以及内部通讯总线（`send_agent_message`），实现多 peer / 跨会话任务分派与成果回执，内部消息全链路落库且对 QQ 用户完全不可见。
- **QQ 空间动态互动生态**：开箱支持浏览好友动态流（`read_qzone_feeds`，支持游标分页与断点续读）、图文动态发布（`publish_qzone_feed`，内置 60 秒防风控冷却）、说说评论互动（`comment_qzone_feed`，结合用户画像精准回复）与自主删说说（`delete_qzone_feed`）。
- **统一系统事件中枢（`SystemEventHub`）**：收敛定时任务唤醒、加好友附言、戳一戳、内部协同回执等后台事件流，以统一规范标头注入大模型上下文，彻底杜绝系统事件被误当作普通聊天回复导致的幻觉。
- **两层记忆体系**：群聊会话记忆 + 用户跨群互通画像，Markdown 文件存储，提供 `read_memory`、`create_memory`、`edit_memory` 三大工具；写入侧按“用户画像 / Session 规则 / 群聊画像总预算”三个独立字符预算硬拒绝超限落盘，注入侧保持文件内容原子；彻底摒弃独立后台回顾 Agent。
- **表情包管理体系**：受 `face_enabled` 配置门控，提供查表情（`list_faces`）、发表情（`send_face`）、收录好图（`collect_face`）与库容维护/LRU 淘汰（`manage_faces`）闭环工具链；另有群聊 `react_message` 贴表情轻量表态。
- **串行发送与多媒体交互**：单对端串行出站队列，避免并发乱序；支持私聊文件入站自动落盘、群共享文件索引查询（`list_group_files`）、动态资源拉取（`fetch_chat_resource`）与合并转发展开（`expand_forward_message`）。
- **黑话学习系统**：基于 SQLite 存储的群聊黑话词库，提供 `query_slang`、`record_slang`、`manage_slang` 工具闭环，动态提示词注入 L1 索引，支持 LRU 淘汰冷门词条。
- **群成员感知与定时任务**：支持查询群成员名片与角色（`get_group_member_info`），支持单次与周期定时唤醒调度（`schedule_task`、`manage_scheduled_tasks`）。
- **卡片消息通用提取器**：自动提取 QQ 卡片（小程序、分享、音乐等）的标题与链接。
- **群聊主动回复策略**：普通消息窗口期聚合轮询 + 潜水超时破冰 + Agent 繁忙丢弃 + 夜间免打扰，支持运行中新消息行为模式（`steer` 及时插话 vs `queue` 加入队列），支持「仅回复文本内容」过滤并赋予 Agent [结束] 静默决策权。
- **纯两字中文斜杠命令**：`/新建`、`/会话`、`/用量`、`/停止`、`/模型`、`/权限`、`/思考`、`/状态`、`/帮助`，内置严格的管理员白名单权限隔离与 per-session 状态管理。
- **发言黑名单与权限安全防线**：支持私聊与群聊发言黑名单（入库留存审计但永不唤醒与回复，管理员亦不豁免）；支持新建会话默认权限（私聊默认 `workspace-write`、群聊默认 `read-only`）及针对指定 QQ 号/群号的权限例外表；支持 Coding 工程工具组（bash/pwsh/read/write/edit）按私聊/群聊及例外表裁剪硬隔离（只读工具 `read_image` 与 `working_directory` 始终保留）。
- **WebUI 设置面板**：通过 DSH Web UI 配置所有插件参数，7 大 Tab 分组（连接设置、人格与准则、回复配置、权限与安全、记忆、表情包、黑话学习），全部 40 项参数支持 volatile 动态热更新。

---

## 📦 安装与启动

### 前置条件

- [DeepSeek Harness](https://github.com/deepseek-ai/dsh) (`npm install -g @deepseek-ai/dsh`) `>= 0.2.0`（官方全版本兼容，已全面测试适配至 `0.2.2-rc.1+`）
- **QQ 机器人协议端（二选一）**：
  - [NapCat](https://github.com/NapNeko/NapCatQQ)（基准环境，经过大量测试验证）
  - [SnowLuma](https://github.com/snowluma/snowluma)（实测核心功能完全兼容）
- Node.js `>= 22.12.0`（受 `better-sqlite3` 原生依赖约束，低于此版本无法加载）
- pnpm `>= 9.0.0`（仅源码安装需要）

### 方式一：从 npm 安装（推荐）

```bash
# 安装到 DSH 的 web profile
dsh plugin --profile web add dsh-napcat-bridge

# 或安装到全局默认环境
dsh plugin add dsh-napcat-bridge
```

> [!NOTE]
> **Desktop 版**没有 `dsh` CLI，请在 DSH「插件 → 添加插件」里直接输入包名 `dsh-napcat-bridge` 安装。

npm 包已内置编译产物与 `cordis.patch.yml`，安装后重启 DSH 即生效，无需本地构建。`better-sqlite3` 自带 8 平台预编译二进制，常规安装不触发 node-gyp 编译。

### 方式二：从源码安装（开发 / 调试）

> [!IMPORTANT]
> DSH 通过 `package.json` 的 `main -> dist/index.js` 与 `dsh.bundle.patch` 加载插件。**在执行 link 之前必须先运行 `pnpm build` 生成编译产物与预设同步补丁**。

```bash
git clone https://github.com/Jiangsubei/dsh-napcat-bridge.git
cd dsh-napcat-bridge

# 安装依赖并编译（内置 sync-patch 预设同步、tsc 编译与客户端面板构建）
pnpm install
pnpm build

# link 安装到 DSH 的 web profile
dsh plugin --profile web add link:.
```

### 配置与运行

1. **协议端添加反向 WebSocket 客户端（二选一）**：
   - **NapCat 用户**：在 NapCat WebUI（默认 `http://127.0.0.1:6099/webui`）的「网络配置」中新增反向 WebSocket 客户端。
   - **SnowLuma 用户**：在 SnowLuma WebUI（默认 `http://127.0.0.1:5099/`）中新增反向 WebSocket 客户端。
   - **客户端连接参数（两端完全一致）**：
     - **URL**：`ws://127.0.0.1:8080/`（插件显式绑定本地环回地址 `127.0.0.1`，端口需与插件 `ws_port` 对齐）
     - **Token**：**必填项**，必须与插件 `ws_token` 保持一致（严禁留空；若未配置或两端不一致，网关握手将直接拒绝连接并返回 401 Unauthorized）
     - **心跳周期**：`30000` ms，**重连间隔**：`3000` ms

> [!NOTE]
> **SnowLuma 兼容性说明**：SnowLuma 在反向 WS 握手、Token 鉴权、文本/图片收发、撤回、历史消息分页漫游、表情回应与戳一戳等核心功能上均已实测 100% 兼容。唯一细节是其 `get_recent_contact` 接口暂返回空列表，因此在服务断线重连瞬间的离线消息主动探测补全会跳过，完全依赖后续到来的实时消息。

2. **启动 DSH**：
   ```bash
   dsh --profile web
   ```
3. **DSH WebUI 配置核心参数**：
   访问 DSH Web UI（默认 `http://127.0.0.1:3080/`），进入 **dsh-napcat-bridge** 设置卡片（标有 `*` 的为必填字段）：
   - **`ws_token`**（**核心必填项**）：协议端连接鉴权 Token（NapCat / SnowLuma）。用于网关握手安全鉴权，留空时网关将直接拒绝连接并产生警告；WebUI 保存时服务端亦会强校验拦截空 Token（返回 400 Bad Request）。
   - **`bot_qq`**（**核心必填项**）：填写机器人的 QQ 号，用于过滤自身消息防死循环，并作为群聊识别 @机器人的基准。
   - **`admins`**：填写管理员 QQ 号，授权执行斜杠命令，并作为审批请求的唯一放行身份（私聊按对方 QQ、群聊按本轮唤醒者判定：同轮 steer 插话与群友刷屏不会覆盖，排队轮次各自独立归属）。非管理员或系统触发的审批会被直接拒绝，不弹出审批消息。
   - 其他可选参数（人设、主动回复、记忆预算、表情包开关等）按需调整，保存即时热更新生效。

---

## ⚙️ 运行时配置 (40 项)

配置卡片在 WebUI 中分为 7 个 Tab：

### 1. 连接设置 (Connection)
| 参数 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `ws_port` | `number` | `8080` | WebSocket 监听端口（协议端连接目标，变更时服务热重启） |
| `ws_token` | `string` | `""` | 连接鉴权 Token（必填项，空着直接拒绝连接） |
| `bot_qq` | `string` | `""` | 机器人自身 QQ 号（**核心必填项**，自循环防护与识别锚点） |
| `admins` | `string[]` | `[]` | 管理员 QQ 号白名单（斜杠命令授权与审批放行） |
| `aliases` | `string[]` | `[]` | 助手点名别名（群聊点名唤醒） |
| `image_ttl_days` | `number` | `7` | 外来图片与多媒体缓存本地保留天数（过期定时清理） |

### 2. 人格与准则 (Persona & Behavior)
| 参数 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `persona` | `string` | *(内置)* | 助手的人格设定（注入 System Prompt 动态段） |
| `behavior` | `string` | *(内置)* | 行为约束准则（注入 System Prompt 动态段） |

### 3. 回复配置 (Proactive)
| 参数 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `proactive_buffer_size` | `number` | `10` | 群聊滑动窗口队列保留条数，为被动唤醒与主动回复共同提供短程前序上下文 |
| `new_message_behavior` | `'steer' \| 'queue'` | `'steer'` | 运行中收到新消息的行为模式（`steer` 及时插话 vs `queue` 加入队列） |
| `proactive_reply_enabled` | `boolean` | `false` | 启用群聊主动回复功能总开关 |
| `proactive_interval_mins` | `number` | `3` | 主动回复轮询窗口期（分钟，期间有新消息才聚合唤醒 Agent 研读并决策是否回复） |
| `proactive_only_text` | `boolean` | `false` | 仅回复纯文本内容（多模态媒体消息不主动触发） |
| `proactive_idle_enabled` | `boolean` | `false` | 启用潜水超时主动唤醒（冷场破冰冒泡） |
| `proactive_idle_timeout_mins` | `number` | `120` | 潜水超时阈值（分钟） |
| `proactive_night_dnd` | `boolean` | `true` | 夜间免打扰 (每日 23:00~08:00 暂停主动回复) |

### 4. 权限与安全 (Security)
| 参数 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `private_blacklist` | `BlacklistItem[]` | `[]` | 私聊发言黑名单列表（命中则不唤醒、不回复，管理员亦不例外） |
| `group_blacklist` | `BlacklistItem[]` | `[]` | 群聊发言黑名单列表（命中则不唤醒、不回复，管理员亦不例外） |
| `session_permission_private_default` | `string` | `"workspace-write"` | 私聊新建会话初始权限模式（`workspace-write` / `read-only` / `danger-full-access`） |
| `session_permission_group_default` | `string` | `"read-only"` | 群聊新建会话初始权限模式（`read-only` / `workspace-write` / `danger-full-access`） |
| `session_permission_overrides` | `SessionPermissionOverride[]` | `[]` | 针对特定 QQ 号或群号的新建会话初始权限例外覆盖表 |
| `coding_tools_private_default` | `boolean` | `true` | 私聊新建会话是否默认装载 Coding 编码工具组 |
| `coding_tools_group_default` | `boolean` | `false` | 群聊新建会话是否默认装载 Coding 编码工具组（默认关闭，安全推荐） |
| `coding_tools_overrides` | `CodingToolsOverride[]` | `[]` | 针对特定 QQ 号或群号的 Coding 工具组装载例外覆盖表 |

### 5. 记忆 (Memory)
| 参数 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `memory_storage_dir` | `string` | `".dsh/napcat/napcat_memory"` | 记忆 Markdown 文件根存储目录 |
| `user_profile_budget_chars` | `number` | `2200` | 单个用户画像文件的写入上限（跨群聊/私聊通用） |
| `session_memory_budget_chars` | `number` | `2200` | 单个 Session 规则文件的写入上限（群聊/私聊统一） |
| `group_memory_total_budget_chars` | `number` | `8000` | 群聊注入时所有活跃群友画像合计的字符预算；Session 规则不计入 |

### 6. 表情包 (Face)
| 参数 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `face_enabled` | `boolean` | `false` | 控制新建会话是否在预设中装载表情包工具集（保存对后续新会话生效） |
| `face_store_max` | `number` | `100` | 本地表情库存储容量上限（张） |
| `face_store_dir` | `string` | `".dsh/napcat/faces"` | 本地表情库文件存储目录 |
| `face_sub_type` | `number` | `1` | OneBot 11 发送表情使用的 sub_type 字段值 |
| `face_evict_policy` | `string` | `"evict_lru"` | 库容满额淘汰策略 (`reject` 拒绝 / `evict_lru` 淘汰最久未用) |

### 7. 黑话学习 (Slang)
| 参数 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `slang_enabled` | `boolean` | `true` | 控制新建会话是否装载黑话工具集与注入黑话上下文（保存对后续新会话生效） |
| `slang_max_entries` | `number` | `300` | 黑话知识库条数容量上限 (默认 300 条) |
| `slang_evict_policy` | `'reject' \| 'evict_lru'` | `'reject'` | 黑话满额策略（`reject`: 拒绝新增, `evict_lru`: 淘汰模型查阅最少词条） |
| `slang_storage_path` | `string` | `".dsh/napcat/slang/slang.md"` | 存量旧版黑话 Markdown 迁移源路径 (仅启动时迁移，不删原文件) |

> **配置下线说明**：群聊强制引用/艾特死配置（`group_reply_quote`、`group_reply_at`）及空回复行为面板已下线。出站回复遵循「用户侧静默原则」，是否引用与艾特统一由大模型通过 `send_qq_message` 工具参数（`reply_to`、`at_user`）自主决策。独立后台 Agent 参数也已清退下线。

---

## 🛠️ 开发与构建

```bash
git clone https://github.com/Jiangsubei/dsh-napcat-bridge.git
cd dsh-napcat-bridge
pnpm install
pnpm typecheck
pnpm test:quick    # 快速单测
pnpm build         # 同步预设、类型编译与构建 WebUI 产物
```

---

## 🧪 测试

本项目遵循严格的契约测试先行与真实装配验证规范，覆盖专属预设单一真相源同步、出站静默工具流、单 Agent 顺手提炼、表情包闭环、两层记忆体系与斜杠命令等场景（88 套件 720+ 测试用例）。

```bash
pnpm test          # 完整测试（先执行 pnpm build 再执行测试）
pnpm test:quick    # 快速执行测试（跳过 build）
```

---

## 📚 文档索引

面向使用者的标准开源文档统一存放于 `docs/` 目录：

- [快速上手 (docs/getting-started.md)](docs/getting-started.md)：环境依赖、安装步骤、NapCat WS 配置与验证指南。
- [系统架构 (docs/architecture.md)](docs/architecture.md)：模块总览、生命周期装配、用户侧静默出站体系、记忆与表情体系。
- [配置说明 (docs/configuration.md)](docs/configuration.md)：WebUI 7 大 Tab 完整配置项、默认值与迁移说明。
- [工具与命令 (docs/tools-and-commands.md)](docs/tools-and-commands.md)：`send_qq_message` 等 22 个 Agent 工具契约与 9 个纯两字中文斜杠命令。
- [故障排查 (docs/troubleshooting.md)](docs/troubleshooting.md)：出站静默未调用工具、预设隔离、连接异常等问题排查指引。

---

## 📄 License

[MIT](LICENSE)
