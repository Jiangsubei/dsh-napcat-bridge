# 快速上手

本文档说明环境依赖、安装步骤、NapCat 反向 WebSocket 配置与初次运行流程。

---

## 1. 环境依赖

运行与构建本项目需要满足以下环境：

- Node.js: `>= 22.12.0`
- pnpm: `>= 9.0.0`
- DeepSeek Harness (DSH): `>= 0.2.1`
- NapCatQQ: OneBot 11 协议端

---

## 2. 编译与安装

DSH 通过 `package.json` 的 `main` 字段（指向 `dist/index.js`）加载插件。使用本地源码前需执行构建。

```bash
# 克隆仓库
git clone https://github.com/Jiangsubei/dsh-napcat-bridge.git
cd dsh-napcat-bridge

# 安装依赖并编译产物
pnpm install
pnpm build

# 链接到 DSH 的 web profile
dsh plugin --profile web add link:.
```

若修改了 `src/` 代码，需重新执行 `pnpm build` 更新 `dist/`。

---

## 3. NapCat 反向 WebSocket 配置

插件启动后在本地监听指定端口（默认 `8080`），作为反向 WebSocket 服务端接收 NapCat 的连接。

在 NapCat WebUI（默认 `http://127.0.0.1:6099/webui`）中添加反向 WebSocket 客户端：

- URL: `ws://127.0.0.1:8080/`
- Token: 可选，填入的字符串需与插件配置 `ws_token` 相同
- 心跳周期: `30000` 毫秒
- 重连间隔: `3000` 毫秒

保存并启用配置。

---

## 4. 启动 DSH 并配置参数

启动 DSH Web 实例：

```bash
dsh --profile web
```

访问 WebUI（默认 `http://127.0.0.1:3080/`），进入设置页面中的 NapCat QQ 插件卡片，填写基本参数：

- `bot_qq`: 机器人的 QQ 号，用于过滤自身消息以及判断群聊点名。
- `admins`: 管理员 QQ 号列表，用于执行管理类斜杠命令。
- `ws_port`: WebSocket 监听端口，需与 NapCat 配置一致，默认为 `8080`。

保存配置后设置即时生效。

---

## 5. 交互验证

1. 观察 DSH 控制台输出，确认服务监听并建立连接：
   - `[NapCat Bridge] WebSocket server listening on port 8080`
   - `[NapCat Bridge] NapCat client connected successfully`
2. 私聊验证：向机器人 QQ 发送测试消息，验证 DSH 产出回复并回传至 QQ。
3. 群聊验证：在机器人所在的群中发送 `@机器人 测试`，验证群聊上下文创建、消息排队与出站引用逻辑。
