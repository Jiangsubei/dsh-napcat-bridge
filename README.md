# dsh-napcat-bridge

DeepSeek Harness × NapCat QQ 接入插件 —— 让 DSH Agent 在 QQ 群聊 / 私聊中对话、检索历史、收发图片文件。

---

## ✨ 功能特性

- **QQ 群聊 / 私聊全场景接入**：基于 NapCat（OneBot 11 协议）反向 WebSocket 连接。
- **QQ 会话专属预设（`qq-session`）**：构建期与运行时单一真相源（SSOT）自动同步，专属注入 QQ 工具集，彻底杜绝工具向 Web UI 常规会话泄露；深度补齐工作区、跨平台 Shell（Windows pwsh / Linux bash）、Web 搜索、交互提问与技能系统，并抑制多余快照。
- **用户侧静默出站体系**：遵循「用户侧静默原则」，废除纯文本直接推流；文本出站统一由 **`send_qq_message`** 工具驱动，由模型根据入站标头 `[消息ID: <id>]` 与上下文逻辑自主决定是否引用原消息（`reply_to`）或艾特用户（`at_user`）。
- **工具与回合解耦（单 Agent 顺手维护）**：执行出站工具不强行终止回合，模型在回复用户后可在同一轮次中顺手调用记忆或表情管理工具，自然平稳终结。
- **两层记忆体系**：群聊会话记忆 + 用户跨群互通画像，Markdown 文件存储，提供 `read_memory`、`create_memory`、`edit_memory` 三大工具与群聊/私聊字符预算硬上限治理；彻底摒弃独立后台回顾 Agent。
- **表情包管理体系**：受 `face_enabled` 配置门控，提供查表情（`list_faces`）、发表情（`send_face`）、收录好图（`collect_face`）与库容维护/LRU 淘汰（`manage_faces`）闭环工具链；另有群聊 `react_message` 贴表情轻量表态。
- **串行发送与多媒体交互**：单对端串行出站队列，避免并发乱序；支持私聊文件入站自动落盘、群共享文件索引查询（`list_group_files`）、动态资源拉取（`fetch_chat_resource`）与合并转发展开（`expand_forward_message`）。
- **卡片消息通用提取器**：自动提取 QQ 卡片（小程序、分享、音乐等）的标题与链接。
- **群聊主动回复策略**：普通消息随机概率唤醒 + 潜水超时冒泡 + 夜间免打扰，另有「仅回复文本内容」开关（纯文本模型专用）。
- **纯两字中文斜杠命令**：`/新建`、`/会话`、`/用量`、`/停止`、`/模型`、`/权限`、`/思考`、`/状态`、`/帮助`，内置严格的管理员白名单权限隔离与 per-session 状态管理。
- **WebUI 设置面板**：通过 DSH Web UI 配置所有插件参数，5 大 Tab 分组（连接身份、人格与准则、主动回复、记忆、表情包），全部 24 项参数支持 volatile 动态热更新。

---

## 📦 安装与启动

### 前置条件

- [DeepSeek Harness](https://github.com/deepseek-ai/dsh) (`npm install -g @deepseek-ai/dsh`) `>= 0.2.0`
- [NapCat](https://github.com/NapNeko/NapCatQQ)（QQ 机器人协议端）
- Node.js `>= 22.12.0`（推荐 `22.x` LTS）
- pnpm `>= 9.0.0`

### 克隆并构建

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

1. **NapCat 添加反向 WebSocket 客户端**：
   在 NapCat WebUI（默认 `http://127.0.0.1:6099/webui`）的网络配置中新增反向 WebSocket 客户端：
   - **URL**：`ws://127.0.0.1:8080/`（需与插件 `ws_port` 对齐）
   - **Token**：与插件 `ws_token` 保持一致（若留空则此处留空）
   - **心跳周期**：`30000` ms，**重连间隔**：`3000` ms
2. **启动 DSH**：
   ```bash
   dsh --profile web
   ```
3. **DSH WebUI 配置核心参数**：
   访问 DSH Web UI（默认 `http://127.0.0.1:3080/`），进入 **dsh-napcat-bridge** 设置卡片：
   - **`bot_qq`**（**必填项**）：填写机器人的 QQ 号，用于过滤自身消息防死循环，并作为群聊识别 @机器人的基准。
   - **`admins`**：填写管理员 QQ 号，授权执行斜杠命令。
   - 其他可选参数（人设、主动回复、记忆预算、表情包开关等）按需调整，保存即时热更新生效。

---

## ⚙️ 运行时配置 (24 项)

配置卡片在 WebUI 中分为 5 个 Tab：

### 1. 连接身份 (Connection)
| 参数 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `ws_port` | `number` | `8080` | WebSocket 监听端口（NapCat 连接目标，变更时服务热重启） |
| `ws_token` | `string` | `""` | 连接鉴权 Token（留空不鉴权） |
| `bot_qq` | `string` | `""` | 机器人自身 QQ 号（**核心必填项**，自循环防护与识别锚点） |
| `admins` | `string[]` | `[]` | 管理员 QQ 号白名单（斜杠命令授权） |
| `aliases` | `string[]` | `[]` | 助手点名别名（群聊点名唤醒） |
| `image_ttl_days` | `number` | `7` | 外来图片与多媒体缓存本地保留天数（过期定时清理） |

### 2. 人格与准则 (Persona & Behavior)
| 参数 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `persona` | `string` | *(内置)* | 助手的人格设定（注入 System Prompt 动态段） |
| `behavior` | `string` | *(内置)* | 行为约束准则（注入 System Prompt 动态段） |

### 3. 主动回复 (Proactive)
| 参数 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `proactive_reply_enabled` | `boolean` | `false` | 启用群聊主动回复功能总开关 |
| `proactive_only_text` | `boolean` | `false` | 仅回复纯文本内容（多模态媒体消息不主动触发） |
| `proactive_random_enabled` | `boolean` | `false` | 启用普通消息随机概率唤醒 |
| `proactive_random_probability` | `number` | `0.05` | 随机唤醒概率 (0~1，0.05 即 5%) |
| `proactive_idle_enabled` | `boolean` | `false` | 启用潜水超时主动唤醒（冷场冒泡） |
| `proactive_idle_timeout_mins` | `number` | `120` | 潜水超时阈值（分钟） |
| `proactive_cooldown_mins` | `number` | `10` | 主动回复冷却时间（分钟，防止刷屏打扰） |
| `proactive_night_dnd` | `boolean` | `true` | 夜间免打扰 (每日 23:00~08:00 暂停主动回复) |

### 4. 记忆 (Memory)
| 参数 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `memory_storage_dir` | `string` | `".dsh/napcat/napcat_memory"` | 记忆 Markdown 文件根存储目录 |
| `group_memory_budget_chars` | `number` | `2200` | 群聊场景下注入 System Prompt 的群规与群友画像字符总上限 |
| `private_memory_budget_chars` | `number` | `1500` | 私聊场景下单用户画像注入与单次写入的字符上限 |

### 5. 表情包 (Face)
| 参数 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `face_enabled` | `boolean` | `false` | 控制新建会话是否在预设中装载表情包工具集（保存对后续新会话生效） |
| `face_store_max` | `number` | `100` | 本地表情库存储容量上限（张） |
| `face_store_dir` | `string` | `".dsh/napcat/faces"` | 本地表情库文件存储目录 |
| `face_sub_type` | `number` | `1` | OneBot 11 发送表情使用的 sub_type 字段值 |
| `face_evict_policy` | `string` | `"evict_lru"` | 库容满额淘汰策略 (`reject` 拒绝 / `evict_lru` 淘汰最久未用) |

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

本项目遵循严格的契约测试先行与真实装配验证规范，覆盖专属预设单一真相源同步、出站静默工具流、单 Agent 顺手提炼、表情包闭环、两层记忆体系与斜杠命令等场景（60 套件 500+ 测试用例）。

```bash
pnpm test          # 完整测试（先执行 pnpm build 再执行测试）
pnpm test:quick    # 快速执行测试（跳过 build）
```

---

## 📚 文档索引

面向使用者的标准开源文档统一存放于 `docs/` 目录：

- [快速上手 (docs/getting-started.md)](docs/getting-started.md)：环境依赖、安装步骤、NapCat WS 配置与验证指南。
- [系统架构 (docs/architecture.md)](docs/architecture.md)：模块总览、生命周期装配、用户侧静默出站体系、记忆与表情体系。
- [配置说明 (docs/configuration.md)](docs/configuration.md)：WebUI 5 大 Tab 完整配置项、默认值与迁移说明。
- [工具与命令 (docs/tools-and-commands.md)](docs/tools-and-commands.md)：`send_qq_message` 等 13 个 Agent 工具契约与 9 个纯两字中文斜杠命令。
- [故障排查 (docs/troubleshooting.md)](docs/troubleshooting.md)：出站静默未调用工具、预设隔离、连接异常等问题排查指引。

---

## 📄 License

[MIT](LICENSE)
