# SnowLuma 协议端支持可行性与实测兼容性报告

> **调研日期**：2026-11-03  
> **实测环境**：SnowLuma v2.4.0-node（Windows x64 本地部署），NTQQ 真实协议端，反向 WebSocket（端口 3001，带 Bearer Token 鉴权），本地 HTTP 监听端口 3000。  
> **报告说明**：本报告记录基于真实部署环境的抓包、双向长连接鉴权及多项 OneBot 11 动作实测结果。根据隐私安全规范，所有个人敏感信息（QQ号、Token、群号）均已脱敏处理。

---

## 1. 核心实测环境与网络链路

- **协议端版本**：`SnowLuma v2.4.0-node`（`protocol_version: "v11"`）
- **反向 WebSocket 链路**：
  - SnowLuma 客户端配置为反向 WebSocket 模式，主动连接 `ws://127.0.0.1:3001/ws`；
  - 握手鉴权携带请求头：`Authorization: Bearer <WS_TOKEN>`；
  - **实测结果**：与 `dsh-napcat-bridge` 的 `NapCatGatewayServer` 鉴权门禁 100% 契合，握手成功并建立持久双向连接；
  - **元事件上报**：连接成功后依次上报 `lifecycle.connect`、`lifecycle.enable` 及常规 `heartbeat`；
  - **Action 回执**：完整支持 OneBot 11 标准 `echo` 异步回执分发。

---

## 2. 重点关注项：历史记录 API 实测表现

针对群聊与私聊历史消息拉取及分页漫游进行了多维度实测，结果如下：

### 2.1 群历史记录 (`get_group_msg_history`)
- **入参兼容性**：
  - 模式 1：仅传 `{ group_id, count }`，✅ 成功拉取最新 N 条消息；
  - 模式 2：传 `{ group_id, message_seq: 0, count }`，✅ 成功拉取；
  - 模式 3：传 `{ group_id, message_id: 0, count }`，✅ 成功拉取。
- **返回结构契约**：
  - `status: "ok"`, `retcode: 0`；
  - 消息列表位于 `data.messages` 数组（Array 格式）；
  - 每条消息对象完整包含核心字段：`time`, `message_id`, `message_seq`, `group_id`, `group_name`, `user_id`, `message`（消息段数组格式）, `raw_message`, `sender`（对象，包含昵称/群名片等）, `anonymous`, `real_id`；
  - **结论**：数据结构与 NapCat 的 `get_group_msg_history` **100% 一致**。

### 2.2 好友私聊历史记录 (`get_friend_msg_history`) 与分页漫游
- **入参兼容性**：
  - 传参 `{ user_id: <TEST_USER_QQ>, count: 5 }`，✅ 成功拉取真实私聊历史记录；
- **分页漫游能力（极其关键）**：
  - 传参 `{ user_id: <TEST_USER_QQ>, message_seq: <SEQ>, count: 5 }`，✅ 成功向前分页拉取到了历史漫游消息；
  - **结论**：SnowLuma 完整支持基于 `message_seq` 游标进行历史消息向前漫游，与 `dsh-napcat-bridge` 的 `OfflineMessageSyncer`（`sync.ts`）离线消息同步算法**完美契合**。

---

## 3. 消息收发、多媒体与进阶交互实测

在指定测试好友会话下进行了全链路闭环操作验证：

| 动作类型 | 调用接口与入参 | 实测返回与行为表现 | 兼容性结论 |
| :--- | :--- | :--- | :--- |
| **私聊发送** | `send_private_msg`（含文本） | `retcode: 0`, 成功生成 `message_id` | ✅ 完全支持 |
| **图片发送** | `send_private_msg`（含 `base64://...` 图片段） | `retcode: 0`, 成功发送多媒体图片并生成 ID | ✅ 完全支持 |
| **消息详情** | `get_msg`（带刚才生成的 `message_id`） | `retcode: 0`, 成功获取完整消息元信息 | ✅ 完全支持 |
| **消息撤回** | `delete_msg`（带刚才生成的 `message_id`） | `retcode: 0`, 成功在客户端完成撤回 | ✅ 完全支持 |
| **好友戳一戳** | `friend_poke`（`{ user_id: <TEST_USER_QQ> }`） | `retcode: 0, data: null`, 成功触发戳一戳 | ✅ 完全支持 |
| **表情回应** | `set_msg_emoji_like` | 返回 NTQQ OIDB `0x9082_2` 精确协议响应 | ✅ 底层协议已接线 |
| **用户信息查询** | `get_stranger_info`（`{ user_id: <TEST_USER_QQ> }`） | 返回完整 `nickname`, `sex`, `age`, `level` 等字段 | ✅ 完全支持 |

---

## 4. 关键差异点与注意事项

在实测中发现以下需要特别留意的环境与行为差异：

### 4.1 `get_recent_contact` 接口行为差异（需关注）
- **现象**：调用 `get_recent_contact` 时，SnowLuma 能够正常响应 `status: "ok"`, `retcode: 0`，但返回的联系人列表恒为**空数组 `data: []`**（而 NapCat 会返回带 `peerUin`, `chatType`, `msgTime` 的活跃列表）。
- **影响**：
  - 正常运行期间的实时消息收发与 SQLite 存储完全不受影响；
  - 但在插件刚启动或断线重连时，`dsh-napcat-bridge` 的离线消息补全引擎（`OfflineMessageSyncer`）依赖该接口探测最近活跃会话。若该接口返回空，离线同步逻辑会跳过自动补全，只依靠后续到来的实时消息。

### 4.2 戳一戳接口分发差异
- `send_poke` 在部分私聊/群场景可能返回 `retcode: 100`，而特定接口 `friend_poke` 则稳定成功；
- **现状保障**：本项目网关层（`server.ts`）此前已针对戳一戳实现了 `send_poke` -> `group_poke` / `friend_poke` 的三级自动降级 fallback，因此外部 Agent 调用 `poke_user` 工具时不受影响。

### 4.3 部署与账号配置
- SnowLuma 采用独立 WebUI（默认 5099 端口）与独立数据目录，多账号配置存放于 `config/onebot_<QQ>.json`；
- 配置反向 WebSocket 时，需在 WebUI 中指定目标为 Universal 角色，并配置对应 Token。

---

## 5. 总结与建议

实测证明：**SnowLuma 与 NapCat 在 OneBot 11 核心规范层面的兼容度极高**。  
`dsh-napcat-bridge` 可以在**无需修改任何现有核心代码**的前提下，直接通过反向 WebSocket 纳管 SnowLuma 实例，实现基础对话、图文多媒体收发、消息撤回、历史查询及表情/戳一戳交互。
