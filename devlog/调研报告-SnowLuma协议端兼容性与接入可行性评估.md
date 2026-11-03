# SnowLuma 协议端支持可行性与兼容性调研报告

> **调研日期**：2026-11-03  
> **调研目标**：探查并评估 [SnowLuma](https://github.com/SnowLuma/SnowLuma) 项目的定位、官方文档对 NapCat 的兼容性说明，以及 `dsh-napcat-bridge` 接入支持 SnowLuma 的可行性与潜在差异点。

---

## 1. SnowLuma 项目概况与官方定位

### 1.1 核心仓库与基础设施
- **GitHub 组织**：`SnowLuma`
- **核心主仓**：[`SnowLuma/SnowLuma`](https://github.com/SnowLuma/SnowLuma)
  - **定位声明**：*Next Remote Protocol Framework*（下一代远程协议框架）。
  - **技术实现**：面向 QQ 客户端的 TypeScript 互操作运行时（基于真实 NTQQ 桌面客户端/核心进程，通过 Hook 与底层协议解析），将原生会话解析并转换为标准的 **OneBot v11** 规范动作（Actions）与事件（Events）。
  - **架构形态**：基于 pnpm workspace 的 Monorepo 结构，包含 Core、Bridge、Protocol、OneBot 适配、SQLite 存储、WebUI，以及开发者 SDK（`@snowluma/sdk`）和 MCP 服务（`@snowluma/mcp`）。
- **官方文档站仓**：[`SnowLuma/SnowLumaDocs`](https://github.com/SnowLuma/SnowLumaDocs)
  - 采用 Fumadocs / Rspress 构建，包含快速开始、部署指南、网络传输配置以及自动生成的 OneBot API 动作目录。
- **容器与部署仓**：[`SnowLuma/SnowLuma.Docker.Framework`](https://github.com/SnowLuma/SnowLuma.Docker.Framework)
  - 提供 Linux 环境下的 Docker 镜像（集成 Linux QQ、Xvfb、VNC 与 Node.js 运行时）。

---

## 2. 官方文档中与 NapCat 的兼容性声明考证

通过对 `SnowLuma/SnowLuma` 主仓、`SnowLuma/SnowLumaDocs` 文档站源码、Commit 历史及 Issue 的深入考证，结论如下：

### 2.1 官方文档层面：无独立的 "NapCat 兼容层" 专章
- **考证事实**：在 `SnowLumaDocs` 的正式文档（`.md`/`.mdx`）中，**并没有专门设立名为“NapCat 兼容性”、“NapCat 迁移指南”或“兼容 NapCat 模式”的独立章节或专有配置项**。
- **官方定位原则**：SnowLuma 官方将其定位为**独立的、标准 OneBot v11 协议端实现**。它的对外暴露接口严格围绕 OneBot v11 规范（提供正向/反向 WebSocket、HTTP API/上报）。官方文档强调的是对 OneBot 11 标准契约的遵循，而非声明自己是某一个特定软件（如 NapCat 或 go-cqhttp）的衍生分支。

### 2.2 实际研发与生态层面：以 NapCat 作为成熟参照基准（De-facto Benchmark）
虽然官方文档没有挂出“兼容 NapCat”的宣传标语，但在实际生态和研发中，两者存在极其深度的交集与事实对齐：
1. **统一管理工具双后端支持**：
   - NapCat 官方维护的桌面管理客户端 [`NapNeko/NapCatQQ-Desktop`](https://github.com/NapNeko/NapCatQQ-Desktop) 中，直接内置了对 **NapCat** 和 **SnowLuma** 两个协议端的并列管理支持，用户可在同一界面内创建、配置和切换两者。
2. **下游机器人生态并列适配**：
   - 现代 QQ 机器人框架（如 MaiBot、AstrBot 等）已推出双端适配器（如 `MaiBot-SnowLuma-Adapter`），将 NapCat 和 SnowLuma 并列为当前主流的两大 NTQQ OneBot 11 协议驱动端。
3. **Issue 与代码对齐事实**：
   - 在 SnowLuma 仓库的多个关键 Action 实现与 bug 修复中（如 `create_group_file_folder` 返回值结构、`set_group_search`、`get_stranger_info` 的 `relationFlags` 拓展透传、表情回应 `set_msg_emoji_like` 等），开发者与社区均明确以 NapCat 的行为和返回契约作为参照进行对齐，以最大程度保障上层机器人在切换协议端时的无缝迁移。

---

## 3. 架构与运行机制对比

| 对比维度 | NapCat (NapCatQQ) | SnowLuma |
| :--- | :--- | :--- |
| **底层介入机制** | 通常作为插件深度注入在 NTQQ 内部进程运行 | 独立的 TypeScript 互操作远程运行时，通过专有 Hook 与会话桥接层挂载 NTQQ |
| **对外通信协议** | OneBot v11（WebSocket / HTTP） | OneBot v11（WebSocket / HTTP）+ 官方 MCP (`@snowluma/mcp`) |
| **多账号管理** | 通常多开需启动独立实例或配合 Desktop 管理 | 运行时内核原生支持多账号集中管理与独立会话路由 |
| **应用名称自报 (`get_version_info`)** | `app_name: "NapCat.Onebot"` | `app_name: "SnowLuma"` |
| **配置与管理界面** | 内置 WebUI，常用 `napcat.json` 等配置 | 自带独立 WebUI（默认 5099 端口）与 SQLite 存储 |
| **登录凭据复用** | 使用自身 `data/qq` 目录结构 | 数据缓存结构独立，**无法直接复制 NapCat 凭据，需首次扫码登录** |

---

## 4. `dsh-napcat-bridge` 接入 SnowLuma 的可行性评估

结合 `dsh-napcat-bridge` 的当前实现代码进行全链路推演：

### 4.1 核心链路兼容性（开箱即用度：100%）
1. **反向 WebSocket 握手与鉴权**：
   - 本项目通过 `NapCatGatewayServer` 监听 `ws://127.0.0.1:8080`（支持配置端口与 `ws_token`）。
   - SnowLuma 的 OneBot 配置支持标准反向 WebSocket 客户端模式，支持填入目标 URL 与 `access_token`。
   - 握手鉴权遵循标准 HTTP Authorization 头与 Token 校验，**无需任何改动即可成功握手连接**。
2. **入站消息与事件处理流**：
   - 本项目的 `onMessage` 接收标准的 OneBot 11 JSON 结构：
     - `post_type: 'message'`，`message_type: 'group' | 'private'`；
     - 消息段支持标准 Array（`[{ type: 'text', data: { text } }, { type: 'image', ... }]`）与 CQ 码文本解析；
   - 引用回复（`reply`）、图片（`image`）、表情（`face`）、@（`at`）等基础消息类型与 SnowLuma 输出契约一致。
3. **出站基础发送**：
   - `send_group_msg` 与 `send_private_msg` 为 OneBot 11 规范核心动作，SnowLuma 完整实现，调用方式与返回值（`message_id`）完全契合。

### 4.2 扩展功能与高级 API 兼容性核验

| 涉及模块 / 接口 | 本项目调用动作 | SnowLuma 支持情况 | 兼容性评估与建议 |
| :--- | :--- | :--- | :--- |
| **消息撤回与详情** | `delete_msg`, `get_msg` | 完整支持 | ✅ 完全兼容 |
| **表情回应** | `set_msg_emoji_like` | 已支持（对应 NTQQ Trpc 协议 `0x9082_1`） | ✅ 完全兼容 |
| **戳一戳** | `send_poke` / `group_poke` / `friend_poke` | 支持 | ✅ 完全兼容（本项目已有智能 fallback 机制） |
| **合并转发详情** | `get_forward_msg` | 完整支持 | ✅ 完全兼容 |
| **群信息与成员列表** | `get_group_info`, `get_group_member_list` 等 | 完整支持 | ✅ 完全兼容 |
| **陌生人信息查询** | `get_stranger_info` | 完整支持（已对齐 NapCat 扩展字段） | ✅ 完全兼容 |
| **历史记录拉取** | `get_group_msg_history`, `get_friend_msg_history` | 支持（需注意分页入参是 `message_seq` 还是 `message_id`） | ⚠️ 需真机注意分页游标字段细节 |
| **最近联系人** | `get_recent_contact` | NapCat 专属扩展 API，SnowLuma 是否实现暂未在公开文档列出 | ⚠️ 建议保持优雅降级（该接口目前非核心阻断项） |
| **多媒体本地直读** | `InboundMediaResolver` (NTQQ 本地目录扫描) | 取决于底层 NTQQ 客户端数据路径 | 💡 若同机运行且 NTQQ 缓存目录相同则直读命中；若未命中则自动降级为 URL 下载，不影响功能 |

---

## 5. 调研结论与后续建议

1. **结论**：
   - **SnowLuma 在协议层面与 NapCat 高度同构，且均以 OneBot v11 为核心规范**。
   - `dsh-napcat-bridge` 原生以标准 OneBot 11 反向 WebSocket 服务端架构设计，**未与 NapCat 进行不可解耦的专有私有协议硬绑定**。
   - 因此，**`dsh-napcat-bridge` 完全具备直接支持 SnowLuma 的技术可行性**。用户只需在 SnowLuma WebUI 中配置反向 WebSocket，指向 Bridge 的端口并配置相同的 Token，即可无缝驱动核心消息收发与 AI 对话。
2. **后续建议（若未来计划正式官宣支持或增加专门的方言兼容）**：
   - **无需改动核心代码即可先行实验**：由于当前代码没有校验 `app_name === 'NapCat.Onebot'`，任何 OneBot 11 标准客户端均可直接接入测试；
   - **文档层引导完善**：可以在 `docs/configuration.md` 中增加一节关于 SnowLuma 的反向 WebSocket 填报示例（设置 URL 为 `ws://127.0.0.1:8080` 及 Token）；
   - **非核心扩展动作的优雅防御**：对 `get_recent_contact` 等 NapCat 特有动作增加调用失败容错（当前代码基本均有 try-catch 兜底）。
