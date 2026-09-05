# dsh-napcat-bridge

DeepSeek Harness × NapCat QQ 接入插件 —— 让 DSH Agent 在 QQ 群聊 / 私聊中对话、检索历史、收发图片文件。

## ✨ 功能特性

- **QQ 群聊 / 私聊全场景接入**：基于 NapCat（OneBot 11 协议）反向 WebSocket 连接
- **多轮对话与上下文管理**：每个 QQ 会话（私聊 / 群聊）独立会话上下文
- **流式回复**：支持 DSH 流式输出实时推送到 QQ
- **出站消息精准绑定**：@提问者 / 引用原消息，回复不会串到错误的人
- **串行多题问答**：排队机制确保多条消息按序处理
- **卡片消息通用提取器**：自动提取 QQ 卡片（小程序、分享、音乐等）的标题与链接
- **群聊主动回复**：随机概率唤醒 + 潜水超时冒泡，让机器人更自然地参与群聊
- **两层记忆体系**：群聊记忆 + 用户画像，Markdown 文件存储，后台自动回顾提炼
- **文件收发**：私聊文件入站落盘 + 群文件列表查询
- **斜杠命令**：`/model`、`/clear`、`/help` 等管理员命令，权限白名单控制
- **WebUI 设置面板**：通过 DSH Web UI 配置所有插件参数，无需改配置文件
- **人格与行为定制**：可自定义助手人格设定与行为约束准则

## 📦 安装

### 前置条件

- [DeepSeek Harness](https://github.com/deepseek-ai/dsh) (`npm install -g @deepseek-ai/dsh`)
- [NapCat](https://github.com/NapNeko/NapCatQQ)（QQ 机器人协议端）
- Node.js ^22.19 或 >=24

### 克隆并安装

```bash
git clone https://github.com/Jiangsubei/dsh-napcat-bridge.git
cd dsh-napcat-bridge
# ① 构建：DSH 通过 package.json main → dist/ 加载编译产物，必须先 pnpm build 生成 dist/
pnpm install
pnpm build
# ② link 安装到 DSH
dsh plugin --profile web add link:.
```

### 配置与启动

安装完成后按顺序完成以下步骤：

```bash
# ③ 启动 DSH（Web UI 在 127.0.0.1:3080）
dsh --profile web
```

1. **构建**：完成上述 `pnpm install && pnpm build`（若已 clone 则直接进入下一步）
2. **Link 安装**：`dsh plugin --profile web add link:.` 将插件链接到 DSH
3. **NapCat 配置 WS 客户端**：在 NapCat 中新增「反向 WebSocket」客户端，地址指向插件监听的 WS 端口（默认 `8080`，见下面配置表），可用 Token 鉴权（对应 `ws_token`）
4. **DSH WebUI 设置插件**：在 DSH Web UI（127.0.0.1:3080）的 dsh-napcat-bridge 设置卡片中填写：
   - 机器人 QQ 号（`bot_qq`）
   - 管理员白名单（`admins`）
   - 对齐 NapCat 的 WebSocket 端口（`ws_port`，若改了默认值）
   - 其他可选参数（人格、主动回复、记忆等）

> 插件通过反向 WebSocket 被动接收 NapCat 连接，因此 NapCat 必须先连上，WebUI 才能看到实时消息。

## ⚙️ 配置

| 参数 | 说明 | 默认值 |
|---|---|---|
| `ws_port` | WebSocket 监听端口（NapCat 连接目标） | `8080` |
| `ws_token` | 连接鉴权 Token（留空不鉴权） | `''` |
| `bot_qq` | 机器人自身 QQ 号（自循环防护） | `''` |
| `admins` | 管理员 QQ 号白名单（斜杠命令授权） | `[]` |
| `aliases` | 助手点名别名（群聊点名唤醒） | `[]` |
| `at_questioner` | 群聊回复是否 @提问者 | `false` |
| `quote_original` | 群聊回复是否引用原消息 | `true` |
| `persona` | 助手人格设定 | 见源码 |
| `behavior` | 行为约束准则 | 见源码 |
| `proactive_reply_enabled` | 启用群聊主动回复 | `false` |
| `proactive_random_probability` | 随机唤醒概率 (0~1) | `0.05` |
| `proactive_idle_timeout_mins` | 潜水超时阈值（分钟） | `120` |
| `memory_storage_dir` | 记忆文件存储目录 | `.dsh/napcat/napcat_memory` |
| `memory_budget_chars` | 用户画像注入字符预算 | `2200` |
| `review_enabled` | 启用后台自动回顾 | `true` |

## 🛠️ 开发

```bash
git clone https://github.com/Jiangsubei/dsh-napcat-bridge.git
cd dsh-napcat-bridge
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

## 🧪 测试

本项目采用 TDD 驱动开发，27 套件 240+ 契约测试覆盖：

```bash
pnpm test          # 完整测试（先 build 再跑）
pnpm test:quick    # 快速测试（跳过 build）
```

## 📄 License

[MIT](LICENSE)
