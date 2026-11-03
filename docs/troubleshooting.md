# 故障排查

本文档列出常见问题现象、原因排查与恢复步骤。

---

## 1. 编译产物未更新导致修改未生效

- **现象**：修改了 `src/` 目录下的 TypeScript 代码后，重启 DSH 运行行为没有任何改变。
- **原因**：DSH 基于 `package.json` 的 `main: dist/index.js` 路径加载编译后的产物。单测（`vitest`）直接执行 TypeScript 文件，但真实生产装配加载的是 `dist/` 与构建期同步的 `cordis.patch.yml`。
- **处理步骤**：
  ```bash
  pnpm build
  ```
  执行构建并确认 `dist/index.js` 的生成时间已更新，然后重启 DSH。

---

## 2. 机器人控制台有推理输出，QQ 聊天中却无回复

- **现象**：观察 DSH 控制台或 Web UI，模型已经输出了大段文本甚至标记完成回合，但 QQ 用户完全收不到任何消息。
- **原因**：**用户侧静默原则（Outbound Silence）**。
  - 当前架构彻底废除了 assistant 文本推流机制，大模型的直接文本生成在 QQ 端默认静默拦截；
  - 机器人的纯文本出站必须显式调用 **`send_qq_message`** 工具；
  - 若模型直接生成文本而未调用该工具，QQ 用户将看不到任何内容。
- **排查步骤**：
  1. 确认当前会话是否使用了 `qq-session` 专属预设（该预设内置了对 `send_qq_message` 的强制指导和工具集）；
  2. 若会话创建于旧版预设生效前，在 QQ 聊天中使用管理员账号发送 `/新建`，重新创建与挂载最新预设的会话；
  3. 检查模型的人格与行为准则配置是否误删了工具调用指导。

---

## 3. NapCat 无法连接反向 WebSocket

- **现象**：NapCat 控制台输出连接拒绝 (`ECONNREFUSED`)、HTTP 401 鉴权拒绝，或 DSH 控制台未见连接握手成功日志。
- **排查步骤**：
  1. 检查 DSH 是否已正常启动，且控制台输出包含 `[GatewayServer] OneBot 11 反向 WS 服务端已监听 127.0.0.1:8080`；
  2. 确认端口冲突：使用 `netstat -ano | findstr :8080`（Windows）检查 `8080` 端口是否被其他进程占用；
  3. 检查 NapCat 客户端配置中的 URL 是否为本地环回 `ws://127.0.0.1:8080/`（**服务端默认仅安全绑定到本地环回地址 127.0.0.1**，避免暴露公网；若 NapCat 与 DSH 位于不同机器或容器，需配置安全隧道、反向代理或同机网络映射）；
  4. 检查鉴权 Token（`ws_token`）：**`ws_token` 为必填鉴权项**，未配置或 Token 不一致会导致服务端直接返回 `401 Unauthorized` 拒绝连接握手并关闭会话；必须确保 NapCat 配置的鉴权 Token 与插件 WebUI 设置中的 `ws_token` 完全一致（支持 NapCat 请求头 `Authorization: Bearer <token>` 或 URL Query `?access_token=<token>`）。

---

## 4. 群聊中发送消息机器人无响应

- **现象**：私聊可以正常回复，但在群聊中发送消息无任何反应。
- **排查步骤**：
  1. **检查 `bot_qq` 配置**：未配置或配错 `bot_qq` 时，插件无法判断当前消息是否 @ 了机器人，默认放弃唤醒；
  2. **检查唤醒方式**：默认策略下，群聊必须满足以下条件之一才会唤醒：
     - 显式 @机器人；
     - 消息以 `aliases` 中配置的别名开头；
     - 引用了机器人之前发出的消息；
     - 启用了主动回复 (`proactive_reply_enabled: true`) 且在轮询窗口期聚合了新消息，或达到潜水超时破冰条件；
  3. **检查夜间免打扰**：如果启用了主动回复且当前处于 23:00~08:00，系统会依配置处于免打扰静默期。

---

## 5. 表情包相关工具不生效或提示不存在

- **现象**：模型无法调用 `list_faces`、`send_face`、`collect_face` 或 `manage_faces` 工具。
- **原因**：表情包能力由配置项 `face_enabled` 门控（默认处于关闭 `false` 状态）。此外，由于预设配置在会话创建时注入，该开关保存后**仅对后续新建的会话生效**。
- **排查步骤**：
  1. 进入 Web UI 设置面板的「表情包」Tab，勾选启用 `face_enabled` 并保存；
  2. 在 QQ 聊天中使用管理员账号发送 `/新建` 指令重新生成会话，或新建群聊/私聊测试。

---

## 6. Web UI 常规会话中无法使用 QQ 专属工具

- **现象**：在 DSH Web UI 打开一个非 QQ 的常规会话，工具栏中找不到 `send_qq_message`、`poke_user` 等工具。
- **原因**：**工具预设隔离保护机制**。
  - 本插件的工具不再全局注册到根 `ctx.tools`，而是通过 `dsh-napcat-bridge/tools` 仅注入由 `qq-session` 预设创建的 QQ 会话；
  - 避免了非 QQ 会话被 QQ 专属工具污染，此为符合架构设计的正常保护行为。

---

## 7. 斜杠命令提示“权限不足”

- **现象**：发送 `/模型`、`/新建` 等指令时，收到回复 `权限不足：仅管理员允许执行指令`。
- **原因**：发送者 QQ 号不在插件配置的 `admins` 列表中。
- **处理步骤**：
  进入 DSH WebUI 设置卡片中的「连接身份」Tab，在 `admins` 字段中添加你的 QQ 号并保存配置。

---

## 8. 会话编号跳号或历史会话删除后状态异常

- **现象**：手动删除了 DSH 中的某个历史会话后，新收到的 QQ 消息依然尝试绑定旧会话 ID。
- **原因**：`SessionManager` 内部维护了 `peerId` 到 DSH 会话 ID 的映射缓存。
- **处理步骤**：
  - 在 QQ 聊天中使用管理员账号发送 `/新建` 命令，强制当前会话解绑并创建新会话；
  - 插件内置空缺填补机制（gap-filling），会自动寻找编号最小的空缺号位或生成短哈希避免碰撞。

---

## 9. 发送文件或图片失败

- **现象**：模型调用 `send_file` 工具后报错或 NapCat 未发出对应文件。
- **排查步骤**：
  1. 检查文件绝对路径是否存在且具有读取权限；
  2. NapCat 在容器环境（Docker）中运行时，宿主机路径与容器内路径不一致，需挂载共享数据卷；
  3. 确认文件类型是否受 QQ 协议端限制（部分可执行文件可能被 QQ 服务端拦截）。

---

## 10. DSH 桌面端启动弹窗报错 `desktop welcome: Web authentication failed`

- **现象**：启动 DeepSeek Harness 桌面端时弹出错误弹窗，提示 `DeepSeek Harness is unavailable` / `The application could not start or stopped unexpectedly.`，日志显示 `Error: desktop welcome: Web authentication failed at connectDesktopWelcome`。
- **原因**：**DSH 宿主临时端口鉴权 Cookie 堆积导致 HTTP 431 请求头溢出**。
  - DSH 宿主服务每次启动都会在随机临时端口监听，并通过 `@deepseek-ai/dsh-client-connection` 签发有效期 30 天的 `dsh-auth-<hash>` 认证 Cookie；
  - 根据 RFC 6265 规范，`127.0.0.1` 域名下的 Cookie 不区分端口，因此历次调试与重启遗留在 Electron 数据库中的 Cookie 不会被自动销毁；
  - 当累计重启达到 70 次左右时，`Cookie` 请求头尺寸将超过 **16,384 字节**（Node.js `http` 服务端的默认 `maxHeaderSize` 限制），导致 Host 直接向 Electron 返回 `431 Request Header Fields Too Large`，触发认证失败弹窗。
- **恢复步骤**：
  清理当前用户目录下的 Chromium Cookies 数据库（清理已废弃的历史端口认证 Cookie）：
  - 路径：`%APPDATA%\@deepseek-ai\dsh-desktop\Network\Cookies`
  - 使用 SQLite 工具执行 `DELETE FROM cookies WHERE name LIKE 'dsh-auth-%';` 或直接删除该文件（重新打开 DSH 会自动重新初始化）。

---

## 11. WebUI 保存配置返回 400 Bad Request

- **现象**：在 DSH 设置面板修改配置并点击保存时，控制台报错或弹窗提示 `400 Bad Request`（如 `WebSocket 鉴权 Token (ws_token) 为必填项，不能为空`）。
- **原因**：**保存端强校验非空防线**。
  - 为防止未鉴权空口令暴露反向 WebSocket，`ws_token` 为必填安全参数；
  - 若在 WebUI 保存时留空且系统中此前未保存过有效 Token，服务端配置接口（`POST /plugins/dsh-napcat-bridge/config`）直接拒绝保存并返回 400 状态码。
- **处理步骤**：
  进入 WebUI 设置卡片的「连接设置 (Connection)」Tab，在 `ws_token` 中填入强随机字符串作为鉴权凭证（NapCat 端需同步配置完全一致的 Token），然后重试保存。

---

## 12. 配置接口返回 403 Forbidden

- **现象**：在浏览器或客户端调用 `/plugins/dsh-napcat-bridge/config` 时，收到 `403 Forbidden` 或 `Forbidden: host connection authentication service unavailable` 错误。
- **原因**：**宿主 Connection 鉴权门控拦截（严格 Fail-Closed）**。
  - 插件配置 REST 路由全面接入宿主 `connection` 服务鉴权（`ctx.connection.requestRejection(req)`），用于防范跨站 CSRF、DNS Rebinding 及非授权配置篡改；
  - 遵循严格的 Fail-Closed 原则：当请求未携带有效宿主会话凭证、存在跨域/非法来源嫌疑，或当前宿主环境未能提供 `connection` 鉴权服务时，接口一律直接阻断并返回 403 Forbidden。
- **排查步骤**：
  1. 确认是否通过官方 DSH 桌面端或已鉴权的 DSH Web 前端正常进入设置面板；
  2. 避免通过未经认证的裸浏览器标签页、第三方调试脚本直接发起非授权跨站调用；
  3. 检查 DSH 宿主版本及 `connection` 基础服务状态是否正常。

---

## 13. DSH 工具调用报错 `value is not lossless JSON`

- **现象**：Agent 调用自定义工具（如黑话、表情包工具）时报错 `Error: tool "<tool_name>" returned invalid output: value is not lossless JSON`，即使底层数据已落盘，模型依然认为工具执行失败并陷入重复重试。
- **原因**：**DSH 微内核对 `defineTool` 返回值执行 `snapshotJsonValue` 无损校验**。
  - DSH 要求工具返回值必须能被无损序列化还原为纯粹的 JSON；
  - 若返回值对象中包含值为 `undefined` 的键（如未命中的可选字段 `{ evicted_term: undefined }`），JSON 规范不包含 `undefined`，校验器判定为“有损”并抛出致命错误。
- **恢复与开发规范**：
  - 构造返回值时避免产生 `{ key: undefined }`，优先采用 ES6 条件展开：`...(val ? { key: val } : {})`；
  - 工具返回前统一使用 `toLosslessJson(res)` 剥离所有 `undefined` 字段；
  - 为工具编写契约测试断言返回值绝不含 `undefined` 属性。

---

## 14. 加好友通过瞬间把申请验证附言当普通私聊消息唤醒回复

- **现象**：在手机 QQ 同意好友申请后，机器人立即私聊对方发送回复，回复内容误把对方此前申请时的验证消息（如“我是xxx”）当成了刚发来的聊天话语。
- **原因**：**QQNT 协议端在好友添加成功瞬间会将申请附言作为会话首条消息推送**。
  - NapCat 在 `notice.friend_add` 之后会紧跟一条 `sub_type: 'friend'` 的私聊历史消息，内容与加好友附言完全一致；
  - 旧版逻辑将该消息误判为常规私聊唤醒。
- **排查与解决步骤**：
  - 插件自 **v0.2.7** 起内置了 `FriendNoticeTracker` 状态机，自动监听捕获加好友请求附言，并在首条消息到达时精确消费并拦截唤醒（标记为系统提示），绝不误回复；
  - 检查当前插件版本（执行 `git log -n 1` 或 `package.json`），确保版本 `>= 0.2.7`；
  - 若正在调试源码，请务必执行 `pnpm build` 并重启 DSH。

