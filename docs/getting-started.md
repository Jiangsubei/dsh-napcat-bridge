# 快速上手

本文档说明环境依赖、安装步骤、NapCat 反向 WebSocket 配置与初次运行流程。

---

## 1. 环境依赖

运行与构建本项目需要满足以下环境：

- **Node.js**: `>= 22.12.0`（推荐 `22.x` LTS）
- **pnpm**: `>= 9.0.0`
- **DeepSeek Harness (DSH)**: `>= 0.2.0`
- **NapCatQQ**: OneBot 11 协议端（桌面版、Shell 版或 Docker 版均可）

---

## 2. 编译与安装

DSH 通过 `package.json` 的 `main` 字段（指向 `dist/index.js`）加载插件，并通过 `dsh.bundle.patch` 加载 `cordis.patch.yml`。

在进行 link 安装前，**必须先执行构建命令**：

```bash
# 1. 克隆仓库
git clone https://github.com/Jiangsubei/dsh-napcat-bridge.git
cd dsh-napcat-bridge

# 2. 安装依赖并执行全套编译
# （该步骤会自动执行预设单一真相源同步 sync-patch、TypeScript 编译及 WebUI 客户端构建）
pnpm install
pnpm build

# 3. 将插件 link 链接到 DSH 的 web profile
dsh plugin --profile web add link:.
```

> [!IMPORTANT]
> **关于修改代码后的生效**：
> 若后续修改了 `src/` 源码，必须再次执行 `pnpm build` 更新 `dist/` 与 `cordis.patch.yml`，重启 DSH 后改动方可在生产路径中生效。

---

## 3. NapCat 反向 WebSocket 配置

插件启动后会在本地监听指定端口（默认 `8080`），作为反向 WebSocket 服务端接收 NapCat 的连接。

在 NapCat WebUI（默认 `http://127.0.0.1:6099/webui`）的网络配置中，添加反向 WebSocket 客户端：

- **URL**: `ws://127.0.0.1:8080/`（若更改了 `ws_port`，此处端口需保持一致）
- **Token**: 可选。若在插件配置中填写了 `ws_token`，此处填入完全一致的 Token；若插件未设置 Token，此处留空。
- **心跳周期**: `30000` 毫秒
- **重连间隔**: `3000` 毫秒

保存并启用该反向 WebSocket 客户端。

---

## 4. 启动 DSH 并配置参数

启动 DSH Web 实例：

```bash
dsh --profile web
```

打开浏览器访问 DSH WebUI（默认 `http://127.0.0.1:3080/`），进入设置页面中的 **dsh-napcat-bridge** 设置卡片，填写核心参数：

1. **`bot_qq`**（**必填项**）：机器人的 QQ 号。用于过滤自身发出的消息（防止死循环）并在群聊中作为判断是否 @机器人 的基准。未配置时控制台会在启动时告警。
2. **`admins`**：管理员 QQ 号列表（数组），只有列表中的 QQ 号才能在聊天中执行 `/模型`、`/新建`、`/权限` 等管理类斜杠命令。
3. **`ws_port`**：WebSocket 监听端口，默认为 `8080`。

保存配置后，设置即时通过 volatile 机制热更新生效（若修改了端口，服务端会自动热重启）。

---

## 5. 交互验证

1. **服务启动与连接检查**：
   观察 DSH 控制台输出，确认服务监听并建立连接：
   ```text
   [NapCat Bridge] OneBot 11 反向 WS 服务端已在端口 8080 成功启动
   [NapCat Bridge] NapCat client connected successfully
   ```
2. **私聊验证**：
   使用你的 QQ 私聊机器人，发送一条打招呼消息。
   - DSH 自动创建独立的私聊会话；
   - 模型在会话中推理并调用 `send_qq_message` 工具将回复下发至 QQ 私聊窗口。
3. **群聊验证**：
   在机器人所在的 QQ 群中发送 `@机器人 你好`。
   - 验证群聊上下文创建、消息排队；
   - 模型接收到包含 `[消息ID: <id>]` 标头的入站提示，并调用 `send_qq_message` 自主决定引用或回复。
4. **工具与能力验证**：
   - 在 QQ 群或私聊中向机器人发送 `/状态`，验证管理员白名单与斜杠命令执行；
   - 询问机器人记忆或发图，观察单 Agent 顺手提炼或多媒体发送能力。
