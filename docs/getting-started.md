# 快速上手

本文档说明环境依赖、安装步骤、NapCat 反向 WebSocket 配置与初次运行流程。

---

## 1. 环境依赖

运行与构建本项目需要满足以下环境：

- **Node.js**: `>= 22.12.0`（推荐 `22.x` LTS）
- **pnpm**: `>= 9.0.0`
- **DeepSeek Harness (DSH)**: `>= 0.2.0`
- **QQ 机器人协议端（二选一）**:
  - [NapCatQQ](https://github.com/NapNeko/NapCatQQ)：基准环境，经过大量测试验证（桌面版、Shell 版或 Docker 版均可）
  - [SnowLuma](https://github.com/snowluma/snowluma)：实测核心功能完全兼容

---

## 2. 安装插件

DSH 通过 `package.json` 的 `main` 字段（指向 `dist/index.js`）加载插件，并通过 `dsh.bundle.patch` 加载 `cordis.patch.yml`。

### 方式一：从 npm 安装（推荐）

npm 包已内置编译产物与 `cordis.patch.yml`，无需本地构建：

```bash
# 安装到 DSH 的 web profile
dsh plugin --profile web add dsh-napcat-bridge

# 或安装到全局默认环境
dsh plugin add dsh-napcat-bridge
```

> [!NOTE]
> **Desktop 版**没有 `dsh` CLI，请在 DSH「插件 → 添加插件」里直接输入包名 `dsh-napcat-bridge` 安装。

### 方式二：从源码编译安装（开发 / 调试）

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

## 3. 协议端反向 WebSocket 配置（NapCat / SnowLuma）

插件启动后会显式绑定到本地环回地址 `127.0.0.1` 监听指定端口（默认 `8080`），作为反向 WebSocket 服务端接收协议端的连接，避免全网暴露带来的安全隐患。

根据所使用的协议端，在对应 WebUI 中添加反向 WebSocket 客户端：
- **NapCat 用户**：在 NapCat WebUI（默认 `http://127.0.0.1:6099/webui`）的「网络配置」中添加反向 WebSocket 客户端；
- **SnowLuma 用户**：在 SnowLuma WebUI（默认 `http://127.0.0.1:5099/`）中添加反向 WebSocket 客户端。

连接配置参数（两端完全一致）：
- **URL**: `ws://127.0.0.1:8080/`（需与插件 `ws_port` 端口保持一致）
- **Token**: **必填**。必须在协议端与插件两端配置完全一致的 Token。若未配置 Token，服务端握手将直接返回 `401 Unauthorized` 拒绝连接。
- **心跳周期**: `30000` 毫秒
- **重连间隔**: `3000` 毫秒

> [!NOTE]
> **SnowLuma 兼容性说明**：SnowLuma 在反向 WS 握手、Token 鉴权、文本/图片收发、撤回、历史消息分页漫游、表情回应与戳一戳等核心链路均已实测 100% 兼容。唯一细节是其 `get_recent_contact` 接口暂返回空列表，因此在服务断线重连瞬间的离线消息主动探测补全会跳过，完全依赖后续到来的实时消息。

保存并启用该反向 WebSocket 客户端。

---

## 4. 启动 DSH 并配置参数

启动 DSH Web 实例：

```bash
dsh --profile web
```

打开浏览器访问 DSH WebUI（默认 `http://127.0.0.1:3080/`），进入设置页面中的 **dsh-napcat-bridge** 设置卡片（前端标注 `*` 为必填项），填写核心参数：

1. **`ws_token`**（**必填项**，标注 `*`）：协议端连接鉴权 Token（NapCat / SnowLuma）。用于保障反向 WS 网关安全连接；若未配置，服务端启动会输出黄色 Warning 警告并在握手阶段拒绝连接；同时在 WebUI 面板保存时服务端会进行强校验拦截，空 Token 将直接返回 `400 Bad Request` 拒绝保存。
2. **`bot_qq`**（**必填项**，标注 `*`）：机器人的 QQ 号。用于过滤自身发出的消息（防止死循环）并在群聊中作为判断是否 @机器人 的基准。未配置时控制台会在启动时告警。
3. **`admins`**：管理员 QQ 号列表（数组），只有列表中的 QQ 号才能在聊天中执行 `/模型`、`/新建`、`/权限` 等管理类斜杠命令。
4. **`ws_port`**：WebSocket 监听端口，默认为 `8080`（显式绑定本地 `127.0.0.1` 环回接口）。

保存配置后，设置即时通过 volatile 机制热更新生效（若修改了端口，服务端会自动热重启）。

---

## 5. 交互验证

1. **服务启动与连接检查**：
   观察 DSH 控制台输出，确认服务监听并建立连接：
   ```text
   [NapCat Bridge] OneBot 11 反向 WS 服务端已在端口 8080 成功启动
   [NapCat Bridge] NapCat client connected successfully
   ```
   > [!NOTE]
   > 若在启动或握手阶段看到 `[GatewayServer] 鉴权失败` 并在客户端收到 `401 Unauthorized` 报错，代表 NapCat 未携带 Token 或两端 Token 不匹配，需检查对齐 NapCat 与插件设置卡片中的 `ws_token`。
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
