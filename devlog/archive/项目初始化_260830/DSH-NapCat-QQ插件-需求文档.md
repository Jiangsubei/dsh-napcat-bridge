# DSH × NapCat QQ 接入插件 — 需求文档（v0.4.1 草稿）

> 文档性质：前期需求调研与功能设计。本文中所有"协议/API 行为"均来自 **2026-08-30 前的公开文档与 OneBot 11 / NapCat 协议实测片段**的调研结论，**不保证与执行期目标版本完全一致**。执行期（开工前）必须深入本机 `~/.dsh/profiles/node_modules/@deepseek-ai/*` 源码、NapCat 实际运行日志与 OneBot 11 标准重新核实每一处带 ⚠️ 标记的结论，拿到确定性事实后再动手。本文档只定义"做什么"与"验收什么"，不规定实现方式；实现方案由执行方（框架/子代理）自行设计并就关键接口向用户确认拍板。
>
> v0.2 变化：吸收用户 8 处批注 + 2 处澄清——版本策略改为本地 link 安装随 DSH 升级、工作区路径固化、去掉多实例、补充开工前最小 WS 探针验证、群聊回复改双配置开关、群文件下载路径、出方向整段发送、白名单走设置卡片。
>
> v0.3 变化：用户拍板清零全部待决项并定稿总体设计准则——① 设计准则（赋能不替 agent 决策，报错即信息）；② `/model` `/think` 限管理员；③ 断线丢消息可接受；④ 读记录支持多条件组合；⑤ 取文件失败工具报清晰错误、由 agent 自决；⑥ 消息类型处理矩阵 + 戳一戳唤醒 + `poke_user` 工具 + 展开转发工具 + 出方向 QQ 号寻址约定。
>
> v0.3 修订（本轮）：补充出方向机制——只发正式回复（DSH 渲染即发、分段即时、无状态不处理错误），修正 §6.1/§1.2 的"整段发送"表述，标题版本号对齐 v0.3。
>
> v0.4 变化：① 人格/行为注入走 System Prompt **动态段**（用户 WebUI 可配，限制勿发 Markdown 等）；② 出站 Markdown **插件自渲染兜底**（strip→纯文本），不做开关；③ 卡片/提问/审批作为消息纳入 v1 且**必须走 DSH 官方 provider 注册**（规避 nyagent 坑：时序 await+共享 seq、状态孤岛致 Web UI 卡片不关）；④ 借鉴 nyagent QQ 网关整改经验。新增 §6.5/§6.6，补充 §0.0/§7.4/§11。
>
> v0.4.1 变化：插件配置的 UI 组件使用 DSH **官方 Web UI 组件库**，保持视觉风格统一，不自造不统一样式组件。

## 0.0 总体设计准则（用户定稿，贯穿全文）— 赋能但不替 Agent 做决定

- **插件只负责"如实告知 + 工具化赋能"，从不建议或强制 agent 该怎么做；一切以 agent 自己的 ReAct 循环思考为准。**
- **报错是信息，不是终止**：工具失败返回清晰可读的报错（如"下载失败"），让 agent 理解发生了什么、自行决定下一步（重试/换方案/告知用户/放弃），而非替它终结任务。
- **工具参数能不给默认就不给**：涉及决策的参数要求 agent 明确给出（如 `poke_user(user_id)` 必填），逼 agent 明确意图，工具不替它猜。
- **给足能力不设限**：工具筛选维度自由组合（如读记录多条件），agent 按需构造，插件只收窄到"当前 session 的 peer"这类硬边界，不做"主观优雅"过滤。
- **全量入库、不替 agent 挑拣**：所有消息原样入库（含噪音），是否唤醒走触发门控；不因"看着没用"过滤，避免丢失 agent 需要的上下文。
- **出方向只发正式回复、无状态**：只把 DSH 渲染出的正式回复转发到 QQ；工具调用/思考/过程日志不发；若未产出正式回复（失败/中断）插件不报错、不兜底、不管——那是 DSH 自己的事，插件无状态（§6.1）。
- **出站内容 NapCat 可读优先**：NapCat 普通 QQ 消息不支持 Markdown 消息类型，出站正文统一由插件自渲染为纯文本（§6.6），不依赖专用消息类型。

---

## 0. 背景与目标

为 **DeepSeek Harness（DSH，本机已装 `@deepseek-ai/dsh` 全局版，版本 `0.1.1-rc.2`，cordis `4.0.1`）** 做一个**单插件**，通过 **NapCat**（把个人 QQ 号模拟成 NTQQ 客户端、对外暴露 OneBot 11 协议的本地桥）接入 **QQ 群聊与私聊**。

目标：让 DSH 里的 agent 能
- 在群聊/私聊里被"叫醒"并对话；
- 按需检索群聊/私聊的历史消息记录；
- 接收并读取图片/文件；
- 把生成的产物（文档、小玩具等）通过 QQ 发回给用户。

### 0.1 项目形态与安装方式（用户批注定稿）
- **独立项目**（独立 repo），给框架写插件，**不改 DSH 核心**。
- **不锁死版本**：DSH 是 developer preview，rc 阶段契约会变；插件作为独立项目随 DSH 升级持续维护，而不是把 DSH 锁某个 rc 版本。
- **本地开发链接安装（DSH 官方推荐方式）**：
  ```
  dsh plugin --profile web add link:.<本地插件目录>
  ```
  该命令经 pnpm 的 `link:` 协议把本地插件软链进 profile 的 `node_modules`，DSH 升级后插件随之生效，无需重新发包。⚠️ 执行期需用 `dsh plugin --help` 核实该子命令的当前参数形态（本机 `dsh --help` 已确认存在 `dsh plugin` 转发到 pnpm）。

---

## 1. 整体架构与链路模型

### 1.1 统一链路原则
- **群聊与私聊走同一套处理链路**，区别仅在于"触发方式"与"群聊特有的唤醒条件"。
- 一个 **群 / 一个 私聊 = 一个 DSH session**（session 常驻，cwd/记忆/上下文基底随 session 保留）。
- **工作区路径（用户定）**：session 的工作区放在 `.dsh/workspace/napcat/<session_id>`，例如：
  - 群聊：`.dsh/workspace/napcat/group_123456`
  - 私聊：`.dsh/workspace/napcat/user_123456`
  - 即 DSH session 的 `cwd` 用此目录，agent 本地产物落此处。
- DSH 自身为**单轮交互**：被唤醒 → agent 跑完一轮 → 待机。**session 不销毁**，仅交互节奏回到待机。插件**不自己维护对话状态机**——这是 DSH 的契约。

### 1.2 双向能力矩阵（功能轮廓）

| 方向 | 能力 | 形态 |
|---|---|---|
| 入 | 唤醒（@ / 点名 / 引用 / 戳一戳）+ 带指向关系的唤醒包 | 推模式 |
| 入 | 读消息记录工具（按人 / 时间 / 倒序多条件筛选，含撤回与自我标记） | 拉模式 |
| 入 | 取文件工具（file_id [+busid] 现拉，图片 / 群文件 / 私聊文件） | 拉模式 |
| 出 | 发文本（回群 / 回私聊，只发正式回复、分段即时发送） | 推模式 |
| 出 | 发文件 / 图片（专用工具，走消息附件） | 推模式 |
| 出 | 人格/行为注入（WebUI 可配，System Prompt 动态段） | 推模式 |
| 出 | 卡片/提问/审批作为消息（走官方 provider 注册） | 推模式 |
| 存储 | 图片/表情落盘 + 指纹去重；私聊文件落盘；群文件仅记元数据懒载 | — |

### 1.3 连接拓扑（v1 单实例）
- **NapCat 侧**：OneBot 11 **WebSocket 客户端**（用户定）。
- **DSH 插件侧**：**WebSocket 服务端**，监听配置端口，接收 NapCat 推送的事件、并向 NapCat 发 action。
- **v1 单 QQ 号、单 NapCat、单 WS server**（用户明确：暂不做多实例）。去掉 `self_id` 多实例路由设计；session key = peer（group_id 或私聊 user_id）。
- ⚠️ 执行期需核实：NapCat WS 适配器事件字段、鉴权（token）与重连行为。
- **开工前最小验证（用户补充）**：先写一个最小可执行程序起 WS 服务端，连上 NapCat 收几条不同类型消息（文本/图片/@/引用/撤回/群文件上传）存日志，看真实字段长什么样，再据此定 schema。这应作为执行期第 0 步。

---

## 2. 入方向：消息接收与唤醒

### 2.1 私聊
- 私聊消息**直接推**给对应 session 的 agent（走 DSH `agent.followup()` 或等价入口）。
- 私聊也维护一套原始消息记录（与群聊共用存储与工具），agent 可同样用"读记录"工具补充上下文。

### 2.2 群聊 — 两种处理
- **静默记录**：群内普通消息进"原始消息记录"，**不唤醒** agent。
- **唤醒推送**：满足以下条件之一时，将该消息作为唤醒包推给 agent（与私聊同链路）：
  1. **被 @**（CQ:at 指向机器人 QQ）；
  2. **被点名**：消息文本中出现"NapCat 登录的 QQ 昵称"或"插件内设置的助手昵称/别名"；
  3. **消息被引用**：有人引用了 agent 之前发的某条消息。
  4. **被戳**：收到 `poke`（群聊戳一戳 notice 事件）或 `shake`（私聊窗口抖动 message 段），带"哪个用户戳/抖动了你"。唤醒包 `trigger: 'poke'`，content 可为占位（如"X 戳了你一下"）；agent 自行决定如何回复（含是否戳回，见 §6.2）。
     - ⚠️ 群聊 `poke` 是 **notice 事件**（`notice_type: poke`，含 `group_id`/`user_id`/`target_id`），唤醒判定需在 notice 流做；私聊 `shake` 是 message 段，走 message 流。

### 2.3 唤醒包的语义结构（⚠️ 字段名待执行期按 DSH `session/event` 与 OneBot 事件核实）

| 触发方式 | 唤醒包内容 |
|---|---|
| 被 @ | 哪个用户 @了它 + 消息内容 |
| 被点名 | 哪个用户 提到了它 + 消息内容 |
| 被引用 | 哪个用户 引用了它的哪条 + **被引用那条原文** + 消息内容 |
| 被戳 | 哪个用户 戳/抖动了它（content 可为占位） |

建议数据结构（草案）：
```
{
  trigger: 'at' | 'mention' | 'quote' | 'poke',
  from_user: <QQ 号>,
  from_name: <当时昵称>,
  content: <纯文本，CQ 已解析>,
  quoted?: { msg_id, text },          // 仅 quote 时有
  images?: [ <本地落盘路径> ]          // 唤醒消息自带图片时
}
```
> 注：`from_user` 为 **QQ 号（稳定标识）**，`from_name` 仅作展示（让 agent 知道"是谁"）。agent 后续指定人（如戳回）一律用 `from_user` 的 QQ 号，昵称不参与寻址（见 §6.2）。

### 2.4 点名匹配规则（v1 简化）
- 匹配源：**QQ 全局昵称** + **插件内配置的助手昵称/别名**。
- **不使用群昵称（card）**作为匹配源（v1 简化）。
- **精确匹配**（子串/模糊匹配留后续版本）。
- ⚠️ 执行期需确认：OneBot 消息事件 `sender` 字段里"全局昵称"是哪个键（`nickname` 还是其他）、个人号是否有稳定的"自身昵称"可配；插件内别名配置如何注入与热更新（见 §7.4 走设置卡片）。

### 2.5 自循环防护（P0，必须）
- NapCat 会把机器人**自己发出的消息**以 `message_sent` 事件回推。插件**必须屏蔽自身消息触发唤醒**，否则会自我唤醒 → 死循环。
- 机制：消息记录里 agent 自身消息标记 `self: true`（sender = 机器人 QQ），但**不进入唤醒判定**。
- 注意：自身消息**仍进原始记录**（见 §4），只是不触发唤醒。

### 2.6 群聊回复样式（用户定稿：双配置开关）
- 出方向回复提供两个**独立配置开关**（用户批注定稿）：
  - `at_questioner`：是否 @提问者 —— **默认关**；
  - `quote_original`：是否引用原消息 —— **默认开（群聊内）**。
- 私聊不 @（无意义）；引用在私聊无意义可忽略。
- **演进方向（v2，非 v1）**：把"是否@ / 是否引用"做成 agent 发消息工具的参数，让 agent 自行决定。v1 先只做配置开关。

### 2.7 消息类型处理矩阵（全量入库原则，用户定稿）
**总原则（用户明确）**：群聊充满噪音，**所有消息原样入库**，"是否唤醒 agent"走 §2.2 触发条件门控——**入库与唤醒是两件事**，绝不为"干净"而过滤消息，否则 agent 读历史会丢失上下文。

**存储模型**：一条 QQ 消息 = 一行（segment 数组不拆行，保持顺序与语境）。每行含：
- `type`：消息主类型标签（筛选/展示路由用）
- `content`：**归一化展示文本**（agent 读历史看到的，见下表，多段按**原顺序拼接**）
- `raw`：**原始 segment 数组 JSON**（保真，未来能力如水印卡片解析/STT 可重新水化；**不进读记录默认返回**，agent 如需深读某条原文走独立"读 raw"工具）
- `file_id`/`busid`/`local_path`/`fingerprint`：富媒体用
- 其余 `user_id`/`time`/`recalled`/`self`/`reply_to` 同 §4.1

**逐类型处理（A 入库进唤醒内容 / B 落盘或记元数据+占位 / C 记原文或占位不深解析 / 入库不忽略 统一适用）**：

| 段类型 | 含义 | content 展示 | 落盘/raw | 唤醒判定 |
|---|---|---|---|---|
| `text` | 纯文本 | 原文 | — | 参与（点名/引用载体） |
| `face` | 小表情 | `[表情:id=123]` | raw 留 id，不落盘 | 否 |
| `mface` | 大表情包 | `[表情包]` 或下载后 `[表情包:/path]` | 落 `sticker/`，两级去重（§4.2） | 否 |
| `image` | 图片 | `[图片]` 或 `[图片:/path]` | 落 `image/`，两级去重（§4.2） | 否 |
| `at` | @某人 | `@<昵称或QQ>`（内联原序） | raw 留 qq | **是**（@机器人则唤醒） |
| `reply` | 引用回复 | 借 `reply_to` + 引用原文（§2.3） | — | **是**（引用机器人则唤醒） |
| `record` | 语音 | `[语音]` | 记 file_id，不转写（预留 STT） | 否 |
| `video` | 视频 | `[视频]` | 记 file_id，不解析（预留视频模型） | 否 |
| `file` | 文件 | `[文件:name]` 或 `[文件:/path]` | 群文件记 file_id+busid 懒载；私聊落 `files/`（§4.3/§4.4） | 否 |
| `forward` | 合并转发 | `[合并转发]` + 独立展开工具（§5.4） | 记 forward id，懒拉 `get_forward_msg` | 否 |
| `json` | JSON 卡片 | `[卡片:小程序]` 或提取 title | raw 留完整 JSON | 否 |
| `lightapp` | 小程序卡片 | `[小程序]` 或提取标题 | raw 留完整 ark | 否 |
| `xml` | XML 消息 | `[XML卡片]` | raw 留 | 否 |
| `share` | 链接分享 | `[链接:title url]` | raw 留 url | 否 |
| `music` | 音乐分享 | `[音乐:title]` | raw 留 | 否 |
| `location` | 位置 | `[位置:...]` | raw 留 | 否 |
| `contact` | 推荐好友/群 | `[推荐:好友/群 xxx]` | raw 留 | 否 |
| `poke` | 戳一戳 | `[戳一戳]` | 入库（notice 事件） | **是**（§2.2.4） |
| `shake` | 窗口抖动 | `[窗口抖动]` | 入库（message 段） | **是**（§2.2.4） |
| `rps` | 猜拳 | `[猜拳]` | 入库 | 否 |
| `dice` | 骰子 | `[骰子]` | 入库 | 否 |
| `anonymous` | 匿名消息 | `[匿名]内容` | 入库 | 否 |

- **噪音类（poke/shake/rps/dice/anonymous）全部入库不忽略**，仅以方括号占位展示，保证 agent 读历史时语境连续、不编造。
- ⚠️ `mface` 与 `image` 在 NapCat 均以 `image` 段上报、靠子类型区分；执行期需核实子类型字段名以正确路由到 `image/` 或 `sticker/`。
- ⚠️ `forward` 合并转发内容可能极深/多人，v1 **不自动展开**，仅记 id 并提供展开工具（与文件懒载同思路）。
- ⚠️ `record`/`video` 多数模型不支持直接理解，v1 仅占位+file_id 预留；STT / 视频模型留未来。

### 2.8 出方向"指定人"的标识约定
- agent 在对话中拿到的是**唤醒包里的 QQ 号（`from_user`）+ 昵称（`from_name`）**；昵称仅展示，**所有出方向"指定人"工具一律用 QQ 号寻址**，昵称不参与解析。
- 若未来 NapCat `user_id` 非 QQ 号，工具内部再做"QQ号↔外部user_id"桥接；v1 不实现，仅预留（OneBot 标准下 `user_id` 即为 QQ 号）。

---

## 3. 入方向：读消息记录工具

### 3.1 功能
向 agent 暴露工具，让其在"上下文不够"时主动检索历史。群聊/私聊**共用**同一工具，按当前 session 的 peer 自动隔离（**不能跨 session 读其他群/私聊**）。

### 3.2 筛选维度（用户已定）
- 支持**多条件自由组合**（v1，用户定稿）：`{ user_id?, since?, until?, limit, order? }` 各维度可任意组合——
  - `user_id`：按某人筛
  - `since` / `until`：按时间段筛
  - `limit` + `order('desc')`：按时间倒序取最近 N 条
  - 例：`{ user_id: '123', since: ..., until: ..., limit: 50 }` = 某人在某时间段的最近 50 条。
- 符合 §0.0"给足能力不设限"，agent 按需构造查询；仅收窄到当前 session peer 硬边界。

### 3.3 返回内容（草案）
每条消息至少含：
- `user_id`（QQ 号，稳定标识）
- `sender_name`（展示用昵称，可变更）
- `time`（NapCat 时间戳，排序/时间段基准）
- `type`（text / image / file / group_file / at / reply / recall 等）
- `content`（CQ 解析后的纯文本；图片/文件为占位描述 + 本地路径或 file_id）
- `recalled`（布尔）
- `self`（布尔，标记是否 agent 自身消息）
- `reply_to`（被回复消息的 message_id，有则带）

返回中**包含撤回标记**，使 agent 能识别上下文缺口，不编造。

### 3.4 容量与分页
- 群聊历史可能很大。工具返回建议带 `limit` 上限与分页/游标（⚠️ 具体分页形式执行期定）。
- 用户判断：文本原始数据体量小，存储不是问题（见 §4）。

---

## 4. 存储设计

### 4.1 消息记录存储
- 格式：**SQLite**（用户定，与 nyagent 已用 `dsh-session-query-sqlite` / `dsh-storage-domain` 生态一致）。
- 建议表（草案，v1 单实例去掉 self_id）：
```
messages(
  msg_id,          -- OneBot message_id（撤回/引用对齐锚）
  peer,            -- group_id 或 私聊 user_id
  user_id,         -- 发送者 QQ
  sender_name,     -- 当时昵称
  time,            -- NapCat 时间戳
  type,            -- 消息类型
  content,         -- 纯文本/占位
  file_id,         -- 图片/文件稳定 ID
  busid,           -- 群文件专用（图片无）
  local_path,      -- 已落盘资源的本地路径（无则空）
  fingerprint,     -- 图片内容指纹（去重用）
  recalled,        -- 布尔
  self,            -- 布尔（agent 自身消息）
  reply_to         -- 被回复 msg_id
)
```
- 索引建议：`(peer, user_id, time)` 支撑筛选/分页。
- ⚠️ 具体 schema 执行期按工具 DSL / storage-domain 能力定稿。

### 4.1.1 外部资源落盘目录约定（用户定稿）
所有**从 QQ 拉取的外来资源**（收到的图片/表情、群文件、私聊文件）统一落到下载根，按"资源类型 / session"两级分目录；**agent 自身产物**仍留各自 session 工作区（§1.1）。
- 根目录：`.dsh/workspace/napcat_download/`
- 层级：`<根>/<资源类型>/<session_id>/<文件>`
  - `session_id` 复用 `group_<id>` / `user_<id>`（与 §1.1 工作区命名一致，可互相映射）
- 资源类型子目录：
  - `image/`   —— 收到的图片/表情包中的**图片**（入方向收到的图）
  - `sticker/` —— **表情**（为未来 agent 自行收藏/发送表情预留命名空间）
  - `files/`   —— 群文件现拉 + 私聊文件（入方向收到的文件）
- 示例：`.dsh/workspace/napcat_download/image/group_123456/test.png`、`.dsh/workspace/napcat_download/sticker/user_987654/qq.png`、`.dsh/workspace/napcat_download/files/group_123456/report.pdf`
- 7 天清理脚本统一扫此根（见 §4.2 / §4.5）。
- ⚠️ 仅收"入方向收到的"外部资源；agent 经 `send_file` 发出的图/文件来自 session 工作区，不进此根。

### 4.2 图片 / 表情（归为一类）
- **收到即落盘**（NapCat 图片直链约 2 小时过期，必须早落）。
- **落盘前去重（两级）**：先比 `file_id`（O(1)），miss 再比**内容指纹**（sha256 或感知哈希）；命中则不重复落盘。
- 落盘后，消息记录里图片的 `content` 替换为**真实本地路径**；唤醒包含图时也走同一替换。
- 落盘路径：图片 → `napcat_download/image/<session_id>/`；表情 → `napcat_download/sticker/<session_id>/`（为未来 agent 收藏/发表情预留）。
- **清理**：落盘目录中 >7 天的图片/表情定时清理（插件内用 `ctx.effect` 包 setInterval，卸载自动清）。
- **预留（v1 不接）**：未来可能支持 agent 自行收藏某些表情（从 `sticker/` 标记为"已收藏"），被收藏的表情**不参与 7 天清理**，长期保留。v1 不做收藏功能，但清理脚本与目录结构需为此预留（即清理时跳过被标记收藏的项；标记机制留待 v2 设计）。

### 4.3 私聊文件
- 私聊直接发送的文件：**直接落盘**到 `napcat_download/files/user_<id>/`（与群文件同源，统一外来资源体系），唤醒包/记录里附本地路径，agent 直接可读取。

### 4.4 群文件（group_file）
- **不落盘**，仅记元数据： `{ file_id, busid, name, size }`（⚠️ 群文件下载必须 `file_id + busid` 两字段，仅存 file_id 会失败）。
- agent 读记录发现群文件 → 调"取文件工具"用 `file_id + busid` 现拉。
- **群文件下载落盘路径（用户定）**：`napcat_download/files/<session_id>/`（见 §4.1.1 总览）。

### 4.5 撤回处理
- 收到 `notice_type: group_recall` / `friend_recall`：事件含 `message_id`（**不含原文**）。
- 用 `message_id` 在消息记录里精确匹配该条 → 标记 `recalled: true`，内容就地清空或占位"〔已撤回〕"。
- 不反查/不保存原文（OneBot 撤回事件不附正文，且不可依赖实现拿原文）。
- ⚠️ 极端 case：撤回通知在消息尚未入库的瞬间到达，可能匹配不到；v1 忽略或记孤儿撤回日志。
- **清理脚本**一并扫 `napcat_download/` 根，删除 > `image_ttl_days`（默认 7）天的图片/表情/文件（⚠️ 群文件是否同 7 天清理待执行期定，或按类型分别配置 TTL）。

---

## 5. 入方向：取文件工具

### 5.1 功能
agent 凭 `file_id`（群文件加 `busid`）向 NapCat 现拉资源到本地，返回可读取路径。群文件落 `.dsh/workspace/napcat_download/files`（§4.4），图片/私聊文件按各自落盘规则。

### 5.2 协议能力（前期调研，⚠️ 执行期核实）
- 图片：`get_image` / `get_file`（参数 `file` = file_id，推荐传 `NapCatOneBot-` 开头的稳定 id）。
- 群文件：`get_group_file_url`（`file_id` + `busid`）或 `get_file`。
- 私聊文件：`get_private_file_url`（`file_id`）。
- 音频：`get_record`（silk，可转 mp3）。
- ⚠️ 已知坑：NapCat `get_image` 偶发 `file not found` / 频繁失败（社区 issue #313 / #976）；失败需**重试 + 退化为 `get_msg` 重拿 url**。取文件工具需把"可能失败"作为显式契约返回（见 §9 F，报清晰错误由 agent 自决）。

### 5.3 落盘与去重
- 取回的资源也走 §4.2 的指纹去重，避免重复落盘。

### 5.4 展开转发工具（用户定稿，懒加载）
- agent 凭消息记录中 `forward` 类型的 `forward_id` 调 `get_forward_msg` 现拉合并转发的完整内容（可能含多人多轮）。
- 返回结构化的转发消息树（每条含发送者/时间/片段），与原消息记录同归一化格式，落库或仅返回由执行期定。
- 与文件懒载同思路：**v1 不自动展开**，仅记 id 并提供此工具，避免巨量内容无谓灌入上下文。
- ⚠️ 执行期需核实 `get_forward_msg` 返回结构与字段名（NapCat 对 forward 的 `content` 形态）。

---

## 6. 出方向：agent → 用户

### 6.1 文本回复（用户定稿：只发正式回复，分段即时发送，无状态）
- **边界判定不靠自己猜**：DSH 对"正式回复"有明确的渲染事件（对应 Web UI 界面渲染的正式回复块）。⚠️ 具体是 `session/event` 中哪个事件，执行期由 agent 探明后按之对接（见 §11），不预先定死。
- **只发正式回复**：仅将 DSH 渲染出的**正式回复块**转发到 QQ（按 peer 回群/回私聊）；**工具调用结果、模型思考内容（reasoning）、过程日志一律不发**（本地工具内部产物，群聊侧不可见）。
- **分段即时发送**：Web UI 每渲染出一段正式回复，插件**立刻发一条 QQ 消息**（不等待本轮结束合并）。ReAct 循环中可出现**多条正式回复**（如"好的我准备调用工具"→工具→"结果报告"），每条各发一条，工具调用是两条之间的边界。这样更实时，群里不会觉得 agent 卡住。
- **无状态、不处理错误**：若某轮到最后**没有产出正式回复**（连接超时/重置失败/中断等），插件**不报错、不兜底、不静默标记**——那是 DSH 自己的事，插件不去管。用户要查详情去 DSH Web UI 看。插件是"渲染即发"的无状态转发。
- 回复样式按 §2.6 的双开关（`at_questioner` / `quote_original`）处理。

### 6.2 文件交付（专用工具，用户已定）
- agent 通过**专用工具**（如 `send_file(path)`）主动交付文件/图片。
- 工具参数至少：本地路径（支持 `file:///` 本地路径 / URL / Base64 三种形态，避免跨机部署写死本地路径）。
- 走 **OneBot 消息附件**（`send_group_msg` / `send_private_msg` 的 `message` 数组里 `type: file` / `type: image`，`data.file` = 路径/URL/Base64）。
- 目标回写同 §6.1（群聊回群、私聊回私聊）。
- ⚠️ 群文件"上传到群文件系统"（`upload_group_file`）作为 v2 可选能力，v1 统一走消息附件。

### 6.3 戳一戳工具（用户定稿，出方向交互）
- agent 可通过**专用工具** `poke_user(user_id)` 主动戳/抖某人。
- 参数 `user_id`：**必填，为 QQ 号（见 §2.8 标识约定）**；**缺省（不传）直接返回报错"你需要指定 User ID"**，不默认戳唤醒者，避免刷屏。
- 下发：QQ 号原样传给 NapCat 的 poke action（群戳 `target_id` / 私聊抖 `user_id`）。
- **昵称不参与寻址**：agent 从唤醒包拿 QQ 号传入；若未来 NapCat `user_id` ≠ QQ 号，工具内部做桥接（§2.8，v1 不实现）。
- 该工具产生的 poke 事件是 agent 主动发出，非"被戳"，不触发自唤醒。

### 6.4 单实例发送
- v1 单 NapCat 实例，出方向直接发往该实例对应 peer，无需 `self_id` 路由。

### 6.5 人格 / 行为注入（用户定稿：WebUI 可配，System Prompt 动态段）
- **功能**：用户可在 DSH Web UI 配置 agent 的人格、行为准则、以及"勿发 Markdown 语法"等约束。
- **注入方式**：走 DSH **System Prompt 动态段**（`systemPrompt.context()` / 等价动态贡献），**按需动态更新**；同一段变化时**取代旧快照**（DSH 支持动态更新）。
- ⚠️ **执行红绿灯（用户强调）**：插件注入**必须进动态段（dynamic context），绝不能进静态段（static）**——否则提示词缓存（KV cache）会炸。执行期须核实 DSH System Prompt 的静态/动态段划分 API，动态注入每次重算、不进静态缓存。
- ⚠️ 空文本段会被过滤（nyagent 踩坑）：行为的 text 即便未配置也需返回非空引导段，避免被 DSH 过滤掉（见 deepseek-harness-extension 技能 pitfall）。
- 目标：让 agent 把人格/准则当作"自我设定"（放 System Prompt 语义正确），而非伪造成 User 消息（那会污染对话历史、模型会误当用户请求）。
- 关联：此配置可要求 agent"回复用纯文本不用 Markdown"，与 §6.6 出站自渲染兜底叠加。

### 6.6 卡片/提问/审批作为消息 + 出站 Markdown 自渲染（用户定稿，纳入 v1）
**背景**：nyagent 踩坑已趟，本条按经验定稿避免重蹈覆辙。

**6.6.1 卡片/提问/审批作为消息 走官方 provider 注册（必须）**
- DSH 的提问（`UserQuestionService` / approval / plan-review 等）会生成 Web UI 交互卡片。QQ 场景需**在 QQ 侧作为消息推给用户**（用户应答后，仍走官方状态机广播关闭 Web UI 卡片）。
- **必须通过 DSH 官方 `registerProvider()` / answerer 正式注册**（QQ provider 负责"把问题推 QQ + 等用户回复"并 resolve），**状态机 pending→resolved 走官方广播**。
- **禁止**：wrap + `Promise.race` 旁路自建 pendingMap（会导致 Web UI 卡片永不关闭——nyagent 坑）。
- **时序（坑 B）**：卡片/提问的发送须 **await 完成** 且与正文回复**共享同一 seq 计数器 / 串行化**，避免同 turn 竞发乱序；发送须复用正文的发送通道与顺序源。
- 真机验证：① QQ 侧提问/审批正常收发；② 用户作答后 **Web UI 卡片自动关闭**；③ 与正文到达顺序一致。
- ⚠️ 执行期核实：DSH `registerProvider` / answerer 契约（UserQuestionService、ApprovalService），最简 provider 形状。

**6.6.2 出站 Markdown → 插件自渲染纯文本（兜底）**
- NapCat 走**普通 QQ 消息**，**不支持 Markdown 消息类型**（区别于官方 Bot API 的 `QQ_MSG_TYPE_MARKDOWN`）。
- **插件出站前把 Markdown 渲染为纯文本**（strip 语法：标题/加粗/斜体/列表/代码块/表格 → 可读纯文本或列表行），保证 QQ 群/私聊用户可读。
- **不做开关**（不加复杂度）；用户亦可经 §6.5 行为准则配置"勿用 Markdown 语法"减少源端输出，两者叠加。
- 渲染对象：§6.1 正式回复正文、§6.6.1 卡片内容（标题/问题/选项）、§2.7 归一化 content 中的富文本占位。
- ⚠️ 执行期核实：NapCat 普通消息对 markdown 的实际显示（是否裸显 `**`），确定 strip 规则边界（代码块/表格尤其要处理好，别把缩进/列表拆碎）。

---

## 7. 权限与配置

### 7.1 三种权限模式（沿用 DSH 自身）
DSH 原生三模式（前期调研命名）：**readonly（只读）/ edit（可编辑）/ yolo（完全放行）**。
- 默认模式：**edit（可读写）**。
- 切换通过 DSH 的 `permissionPresets` 服务（`set(session, name)`），per-session 生效（A 群切不影响 B 群/私聊）。

### 7.1.1 配置 UI 组件（用户定稿：用 DSH 官方 Web UI 组件库）
- 插件在 DSH Web UI 的配置界面，**一律使用 DSH 官方 Web UI 组件库**（`dsh-client-ui-*` / `dsh-settings` 提供的标准组件），**不自造不统一样式的组件**，保证与 DSH 整体视觉风格一致。
- 适用范围：§7.2 管理员白名单卡片、§7.4 全部配置项（含 §6.5 人格/行为、§6.6 相关项）、以及插件所需的任何设置 UI。
- ⚠️ 执行期核实：DSH 官方 Web UI 组件库的暴露组件（settings 卡片、表单控件等）及其用法。

### 7.2 管理员白名单（用户定稿：设置卡片）
- 插件在 **DSH Web UI 的插件设置卡片**里维护一个 **`admins` 数组字段**（QQ 号列表，全局生效）。
- 白名单内的管理员可用**斜杠命令**。
- 实现：走 `installSettingsSection`（与 nyagent 同机制），在设置 UI 填写，不手改 yaml 文本。

### 7.3 斜杠命令
- 识别规则：**以 `/` 开头的消息即识别为命令，不进入 agent 对话**。
- 群聊里 `/` 开头即命令（不要求额外 @）。
- v1 命令集（草案）：
  - `/mode <readonly|edit|yolo>` — 切换当前 session 权限模式（管理员）
  - `/model <id>` — 切换模型（**限管理员，已定**，per-session）
  - `/think <level>` — 切换思考等级（**限管理员，已定**，per-session）
  - `/help` — 列出可用命令
- 所有命令均限白名单管理员（§7.2）；`/mode` `/model` `/think` 为 per-session 生效（管理员在哪个群发切哪个群）。

### 7.4 插件配置项（草案，走设置卡片）
- `ws_port`：WS 服务端监听端口
- `ws_token`：NapCat 连接鉴权 token
- `admins`：管理员 QQ 号列表（设置卡片填写）
- `aliases`：助手昵称/别名列表（点名匹配用）
- `bot_qq`：机器人自身 QQ（自循环防护 + 自身消息标记）
- `at_questioner`：群聊回复是否 @提问者（默认 false）
- `quote_original`：群聊回复是否引用原消息（默认 true）
- `image_ttl_days`：图片保留天数（默认 7）
- `persona` / `behavior`：**人格 / 行为准则文本**（WebUI 可配，§6.5 注入 System Prompt 动态段；可含"勿用 Markdown 语法"等约束）
- ⚠️ 具体配置 schema 执行期按 `dsh-settings` / `installSettingsSection` 能力定。

---

## 8. 连接与健壮性（P2，v1 可简）

- **消息去重**：NapCat 推送 at-least-once，重连可能重推；用 `message_id` 去重防重复入库。
- **WS 断线**：NapCat 重连后**不补发断线期消息**，丢失即丢失（**用户确认可接受**）。
- **出方向节流**：个人号高频发/拉可能触发验证码/限流；v1 视情况加简单节流。
- **多实例**：v1 不做（见 §1.3）。

---

## 9. 决策已闭合记录（v0.4 全部拍板）

| # | 决策点 | 定稿 |
|---|---|---|
| A | 群聊回复样式：@提问者 / 引用原消息 | 双开关，`at_questioner` 默认关、`quote_original` 默认开(群聊)；agent 自控留 v2 |
| B | 管理员白名单来源 | DSH 设置卡片里的插件 config `admins` 数组字段（QQ 号，全局） |
| C | `/model` `/think` 是否也限管理员 | **限管理员**（否则人人可乱切），per-session 生效 |
| D | WS 断线期消息丢失是否可接受 | **接受**（不补发，丢失即丢失） |
| E | 读记录工具是否支持多条件组合筛选 | **v1 就支持多条件自由组合**（§3.2） |
| F | 取文件失败时的 agent 侧表现 | 工具报**清晰错误**（如"下载失败"），由 agent 自决下一步，插件不替它决定（§0.0） |
| G | 人格/行为注入方式 | **System Prompt 动态段**（WebUI 可配），**严禁静态段**（否则 KV 缓存炸）；用于注入人格、行为准则、"勿用 Markdown"等（§6.5） |
| H | 出站 Markdown 处理 | **插件自渲染兜底**（strip→纯文本），不做开关；用户可另在行为准则配置"勿用 Markdown"（§6.6） |
| I | 卡片/提问/审批作为消息 | **纳入 v1**，必须走 DSH 官方 `registerProvider()`/answerer 正式注册，禁 wrap+Promise.race 旁路；时序 await+共享 seq（§6.6） |

> A–I 已全部闭合，无待拍板项。功能需求定稿，可转规格文档。

---

## 10. 验收底线（草案）

1. 群聊里 @机器人 / 点名（QQ昵称或别名）/ 引用机器人消息，agent 被唤醒且拿到带指向关系的唤醒包；**自身消息不触发唤醒**（无自循环）。
2. agent 能调"读记录"工具，按人/时间段/倒序正确检索当前 session 历史，且能看到 `recalled` / `self` 标记。
3. 图片收到即落盘、指纹去重；7 天后清理；唤醒包与读记录里图片为本地路径。
4. 群文件仅记 `file_id+busid`，下载落 `.dsh/workspace/napcat_download/files`，agent 能按需现拉成功（含失败重试）。
5. agent 能调专用工具发文件/图片回群/回私聊，目标正确；群聊回复样式受 `at_questioner` / `quote_original` 开关控制。
6. 管理员（设置卡片填写的 QQ）可用 `/mode` 切换当前 session 权限模式；非管理员被拒。
7. 工作区按 `.dsh/workspace/napcat/{group|user}_<id>` 隔离；session 常驻，压缩后 agent 仍能经读记录工具看到自身历史。
8. 读记录支持多条件组合（人+时间段+limit）正确检索。
9. `poke_user` 缺省（不带 user_id）返回清晰报错；agent 携带 QQ 号成功戳某人。
10. 人格/行为配置注入 System Prompt **动态段**并生效；改配置后替换旧快照；出站 markdown 被插件渲染为纯文本、NapCat 用户可读。
11. 提问/审批卡片在 QQ 侧推送；用户作答后 **Web UI 卡片自动关闭**；与正文到达顺序一致（无乱序）。
12. 插件配置界面使用 DSH 官方 Web UI 组件库，视觉风格与 DSH 一致，无自造不统一样式组件。

---

## 11. 执行期必须核实的事实清单（⚠️ 动手前）

- [ ] **第 0 步（用户建议）**：起最小 WS 服务端连 NapCat，收文本/图片/@/引用/撤回/群文件上传等样本存日志，确认真实字段形状，再定 schema。
- [ ] **探明 DSH 出方向事件**：`session/event` 中哪个事件对应"Web UI 渲染正式回复"（§6.1 边界判定依据）；工具调用/思考/日志分别对应哪些事件形态，以便只转正式回复。
- [ ] **DSH System Prompt 动态段 API**：静态/动态段如何划分、`systemPrompt.context()` 是否动态贡献、注入动态段的准确用法（§6.5 红绿灯）。
- [ ] **DSH 卡片/提问 provider 契约**：`registerProvider` / answerer 最简形状（UserQuestionService、ApprovalService），确认走官方广播、禁 wrap 旁路（§6.6）。
- [ ] **NapCat 普通消息对 Markdown 的实际显示**：是否裸显 `**`，strip 规则边界（代码块/表格尤其），确定出站渲染规则（§6.6）。
- [ ] 本机 `~/.dsh/profiles/node_modules/@deepseek-ai/dsh-agent` / `dsh-system-prompt` / `dsh-user-approval` / `dsh-settings` / `dsh-storage-domain` 的**真实导出与类型**（对照本文 `session/event`、唤醒入口、`permissionPresets`、`installSettingsSection`、storage-domain 用法）。
- [ ] OneBot 11 / NapCat 当前版本的事件字段（`sender.nickname` vs `card`、`message_sent` 结构、`group_recall`/`group_upload` 字段、`file_id` 格式）。
- [ ] NapCat WebSocket 服务端对接方式、鉴权、重连语义（以实际 NapCat 版本文档为准）。
- [ ] 图片 `get_image` 失败率与 `get_msg` 退化路径的真实可用性。
- [ ] `dsh plugin --profile web add link:.<path>` 子命令的当前参数形态（本机 `dsh --help` 已确认 `dsh plugin` 存在）。
- [ ] DSH `0.1.1-rc.2` 是否仍为当前锁定版本；升级时重跑上述核实。

---

*文档版本：v0.4.1 草稿（功能需求定稿，待转规格）*
*生成日期：2026-08-30*
*性质：前期需求调研，事实结论待执行期用源码/协议核实后定稿*
