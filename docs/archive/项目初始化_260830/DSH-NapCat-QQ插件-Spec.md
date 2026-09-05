# DSH × NapCat QQ 接入插件 — 规格文档 (Spec v1.0)

> **文档性质**：本文档为 **DSH × NapCat QQ 接入插件** 的正式规格定义（Specification）。
> 基于需求文档 v0.4.1、本机 DeepSeek Harness 源码（`~/.dsh/profiles/node_modules/@deepseek-ai/*`，DSH `0.1.1-rc.2` + Cordis `4.0.1`）确证事实以及 `nyagent` 项目历史踩坑考证统稿。
> 本文档将所有草案、建议与 ⚠️ 待决项全部敲定为**确定性、可执行、可契约化验证的工程规格**。
>
> **确定性等级标注说明**：
> - **[已核实]**：已通过本机 DSH 源码、`.d.ts` 类型签名、NapCat 官方/OneBot 11 协议标准或 `nyagent` 历史代码充分查证，事实确凿无歧义。
> - **[需真机验证]**：框架与插件契约已确立，但其与外部实体（如 NapCat 实时协议服务端、NTQQ 客户端实际表现）的交互行为需在功能实现后于真实部署环境下复核确认。

---

## 0. 核心设计准则与架构总览

### 0.1 总体设计准则 [已核实]
1. **赋能但不替 Agent 决策**：插件定位为"事实告知者与底层能力提供者"，负责忠实搬运协议事件并提供原子工具，严禁在插件层臆测或干预 Agent 的 ReAct 思考循环。
2. **报错即信息**：所有工具调用失败时均返回清晰可读的结构化错误信息（如`"下载失败: 资源已过期或不存在"`），让 Agent 自行决策重试、降级或向用户解释。
3. **参数显式化**：涉及业务决策的工具参数（如 `poke_user(user_id)`）必须要求 Agent 显式提供，严禁插件私自猜测默认值。
4. **全量入库、触发门控分离**：所有收到的 QQ 消息（含表情包、撤回通知、卡片等噪音）全量原样存入本地 SQLite 数据库；是否唤醒 Agent 独立走触发门控判定。
5. **出方向无状态、只发正式回复**：插件仅转发 DSH 渲染的正式回复文本（`TextBlock`），过滤思考过程（`ReasoningBlock`）、工具调用（`ToolCallBlock`）及内部过程日志；若一轮交互未产生正式回复，插件不报错、不兜底。
6. **出站 Markdown 自渲染纯文本**：NapCat 普通 QQ 消息不支持 Markdown 渲染，插件在消息出站前统一通过内置 Strip 引擎渲染为干净易读的纯文本排版。

### 0.2 依赖基线与安装模式 [已核实]
- **DSH 版本基线**：`@deepseek-ai/dsh` `0.1.1-rc.2`、`@deepseek-ai/cordis` `^4.0.1`。
- **项目组织**：独立 Git 仓库（`dsh-napcat-bridge`），作为 DSH 的外部插件运行，不修改 DSH 核心代码。
- **本地开发链接安装**：
  ```bash
  dsh plugin --profile web add link:.
  ```
  源码查证（`dsh/lib/plugin-9h8shc4d.js:80-127`）：`dsh plugin` 会将相对路径 `link:.` 转换为绝对路径 `link:/path/to/dsh-napcat-bridge`，并在 `~/.dsh/profiles/web` 目录下执行 `pnpm add`，成功后自动将包名追加至 profile `package.json` 的 `dsh.profile.bundles` 中。

---

## 1. 架构拓扑与链路模型

### 1.1 连接拓扑 (v1 单实例模型) [已核实]
```
+-------------------+      Reverse WebSocket       +------------------------------------+
|                   |  ------------------------->  |       dsh-napcat-bridge Plugin     |
|   NapCat (NTQQ)   |       (OneBot 11 WS)         |   (WebSocket Server, 监听 ws_port)  |
|   (WS Client)     |  <-------------------------  |                                    |
+-------------------+     Actions / API Call       +-----------------+------------------+
                                                                     |
                                                       Cordis Services & Events
                                                                     v
                                                   +------------------------------------+
                                                   |       DeepSeek Harness (DSH)       |
                                                   |  (Session, Agent, LLM, SystemPrompt)|
                                                   +------------------------------------+
```
- **NapCat 侧**：作为 OneBot 11 **WebSocket 客户端（反向 WebSocket）**，主动连接插件暴露的 WS 端口。
- **插件侧**：作为 **WebSocket 服务端**，监听配置项 `ws_port`（默认 `8080`），校验 HTTP Header / Query 中的 `ws_token`（若配置）。
- **单实例路由**：v1 仅支持单 QQ 机器人实例，无需 `self_id` 路由；Session Key 统一由 Peer（`group_<group_id>` 或 `user_<user_id>`）确定。

### 1.2 会话与工作区映射 [已核实]
- **会话持久化模型**：
  - 一个群聊 / 一个私聊 = 一个持久常驻的 DSH Session。
  - Session ID 格式：群聊 `qq-group-<group_id>`，私聊 `qq-user-<user_id>`。
- **工作区路径（CWD）固化**：
  - 群聊工作区：`.dsh/workspace/napcat/group_<group_id>`
  - 私聊工作区：`.dsh/workspace/napcat/user_<user_id>`
  - 源码实证（`dsh-session/lib/types/types.d.ts:40` `SessionHeader`）：Session 创建时的 `cwd` 被深度冻结（`readonly cwd?: string`），创建后**不可变更**。插件在首次创建 Session 时通过 `ctx.agents.create({ sessionId, meta: { cwd } })` 写入，并在 `workspaceRegistry` 中注册挂载。

---

## 2. DSH 核心服务查证与接入规范 [已核实]

### 2.1 出方向事件面 (`session/event`) [已核实]
源码实证（`@deepseek-ai/dsh-session`、`@deepseek-ai/dsh-llm`）：
- DSH 在 Agent 执行期间通过 `ctx.on('session/event', (session, event) => {})` 广播事件流。
- 事件类型映射表：

| 事件 `event.type` | Payload 结构 | 出站处理策略 |
|---|---|---|
| `assistant/chunk` | `{ turn, step, chunk: StreamChunk }` | 当 `chunk.type === 'text-delta'` 时即时提取增量文本；`reasoning-delta` / `tool-call-delta` 直接丢弃 |
| `assistant/message` | `{ turn, step, message: AssistantMessage, usage? }` | 提取 `message.content` 中所有 `type === 'text'` 的 `TextBlock`；过滤 `reasoning`、`tool-call`、`tool-result` |
| `tool/call` | `{ turn, step, callId, name, arguments }` | **绝对不发**往 QQ（内部工具调用） |
| `tool/result` | `{ turn, step, message, error?, meta? }` | **绝对不发**往 QQ（内部工具结果） |
| `turn/start` / `turn/end` | `{ turn, reason? }` | 轮次生命周期边界标识，用于重置/清空当前轮序号与队列 |
| `step/start` / `step/end` | `{ turn, step }` | 步长生命周期边界标识，作为分段即时发送的切分点 |

### 2.2 System Prompt 动态段注入 (`systemPrompt.context`) [已核实]
源码实证（`@deepseek-ai/dsh-system-prompt/lib/types/index.d.ts`）：
- **静态段** `systemPrompt.section(section)`：直接参与 LLM 系统提示词组装，进入模型前缀 KV 缓存。**严禁插件动态配置注入静态段**，否则每次配置修改都会导致 KV Cache 整体失效。
- **动态段** `systemPrompt.context(context)`：
  ```ts
  ctx.systemPrompt.context({
    name: 'napcat:behavior_persona',
    order: 50,
    text: (assembleCtx) => getDynamicPersonaText(assembleCtx),
  });
  ```
  - 动态段在每轮组装时动态求值，并在会话历史中物化为 `user-role` 的 `form: 'snapshot'` 运行时上下文快照。
  - **避坑红线**：空文本 `text: ""` 会被 DSH 内部 `joinContextSections` 过滤忽略。插件必须保证即使未配置 persona 也返回非空保底约束（如引导 Agent 勿输出 Markdown）。

### 2.3 提问与审批 Provider 规范 (`UserQuestionService` / `ApprovalService`) [已核实]
源码实证（`@deepseek-ai/dsh-user-questions`、`@deepseek-ai/dsh-user-approval`）：
1. **用户提问 (`ctx.userQuestions`)**：
   - 必须通过 `userQuestionsSvc.registerProvider(provider)` 注册：
     ```ts
     interface UserQuestionProvider {
       ask(request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer>;
     }
     ```
   - 双 UI 场景下构建 Composite Provider：若请求来自 QQ Session，由 QQ Provider 负责推送问题至 QQ 并等待用户应答；用户应答后 Promise resolve，**官方状态机统一广播关闭 Web UI 提问卡片**。
   - **红线**：严禁 wrap `ask` 或使用 `Promise.race` 搞旁路状态。
2. **工具审批 (`ctx.approval`)**：
   - 接入 Cordis `approval/request` waterfall 钩子：
     ```ts
     ctx.on('approval/request', async (req, next) => {
       if (!isQQSession(req.agent?.session?.id)) return next();
       return await qqApprovalResponder.requestApproval(req); // 返回 'allowed-once' | 'rejected'
     });
     ```
   - 结果返回后由官方 `ApprovalService` 自动向 Session 追加 `approval/asked` 与 `approval/decided` 事件，Web UI 审批卡片同步关闭。

### 2.4 权限预设与模式切换 (`permissionPresets`) [已核实]
源码实证（`@deepseek-ai/dsh-permission-presets/lib/types/index.d.ts`）：
- DSH 内置预设：
  - `workspace-write`（可读写，默认值）：沙箱为 `workspace-write`，审批策略为 `ask`。
  - `danger-full-access`（完全放行，对应 yolo）：沙箱为 `danger-full-access`，审批策略为 `never`。
  - `readonly`（只读）：沙箱为只读。
- 切换 API：`ctx.permissionPresets.set(session, presetName)`。
- 斜杠命令 `/mode <readonly|edit|yolo>` 在当前 Session 上直接调用该 API，实现 per-session 权限隔离。

---

## 3. NyAgent 踩坑考证与红绿灯清单 [已核实]

根据 `~/nyagent` 77 次提交历史及 `docs/archive/` 归档深度复盘，整理本插件必须遵守的红绿灯清单：

| 坑位编号 | 现象与历史教训 | 根本原因 | 本插件必须执行的规范 (绿灯) |
|---|---|---|---|
| **P-01** | Web UI 提问卡片永不关闭 | 自建 `pendingMap` 并 wrap 官方 `ask` 搞 `Promise.race` 丢弃了官方状态机通知 | 必须走 `UserQuestionService.registerProvider`，状态流转全权交由官方 service 广播 |
| **P-02** | 提问卡片与普通文本回复乱序 | 提问发送 `ask()` 内部未 `await`，且提问与正文通道独立、序号未同步 | 提问/卡片发送必须 `await` 完成后再进入 pending，且与正文共享 `msg_seq` 串行队列 |
| **P-03** | 出站消息裸显 `**`、`#` 乱码 | NapCat 普通 QQ 消息不支持 Markdown 渲染 | 出站前经 Strip 引擎转换为纯文本；不依赖 QQ 平台 Markdown 消息类型 |
| **P-04** | 模型提示词缓存 (KV Cache) 剧烈抖动 | 将人格/配置注入到了 `systemPrompt.section()` 静态段 | 必须使用 `systemPrompt.context()` 动态段注入运行时快照 |
| **P-05** | 动态上下文约束完全失效 | 动态段配置未填写时返回了空字符串 `""` 被 DSH 整体丢弃 | 无论是否配置，动态段必须返回非空文本（提供默认保底指引） |
| **P-06** | Web UI 设置保存报 409 Revision Conflict | `settingsScope` 乐观锁冲突未重试 | 捕获冲突后重新读取最新 revision 并自动重试一次更新 |
| **P-07** | 会话工作区路径漂移 | 试图在 Session 运行中动态修改 CWD | CWD 在 SessionHeader 中冻结，每个 Session 固化独立目录并自动挂载 |
| **P-08** | 图片链接 2 小时后 404 失效 | 依赖 NapCat 远程临时 URL | 收到图片/表情后**立即落盘**并以本地绝对路径持久化入库 |
| **P-09** | 群文件下载报错失败 | 下载群文件 API 仅传了 `file_id` 遗漏了 `busid` | 消息表必须同时存储 `file_id` 与 `busid`，取文件工具支持传递 `busid` |
| **P-10** | 机器人自身发消息触发死循环唤醒 | NapCat 回推自身消息 `message_sent` 未过滤 | 消息入库标记 `self: true`，唤醒门控彻底屏蔽 `self === true` 的消息 |
| **P-11** | 模型切换 Web UI 显示不同步 | `/model` `/effort` 仅改本地变量未同步官方 service | 必须联动调用官方 `agentDefaultModel` 写入 API |

---

## 4. 入方向：消息矩阵、存储与唤醒规范

### 4.1 全量入库消息矩阵 [已核实（经 NapCat 实机探针采样确证）]
所有 OneBot 11 消息段（Segment）均以一条完整记录存入 SQLite，多段消息在 `content` 中按原始顺序拼接为归一化文本，`raw` 字段保存完整 JSON。

| Segment 类型 | NapCat (OneBot 11) 实测字段结构 | `content` 归一化展示规范 | 存储与落盘动作 | 唤醒判定 |
|---|---|---|---|---|
| `text` | `{ type: 'text', data: { text } }` | `text` 原文 | 直接入库 | 参与点名/引用匹配 |
| `face` | `{ type: 'face', data: { id, raw: { faceIndex, faceText } } }` | 优先 `[表情:faceText]`（如 `[表情:/菜汪]`），缺省 `[表情:id=317]` | raw 保留 ID 与 raw，不落盘 | 否 |
| `image` (普通图) | `{ type: 'image', data: { file, url, sub_type: 0, file_size } }` | `[图片:/absolute/path/to/img.png]` | 凭 `url` 即时下载落盘至 `image/`，两级去重 | 否 |
| `image` (表情包) | `{ type: 'image', data: { file, url, sub_type: 1 \| emoji_package_id, summary } }` | `[表情包:/absolute/path/to/stk.png]` 或 `[表情包:summary]` | 凭 `url` 即时下载落盘至 `sticker/`，两级去重 | 否 |
| `at` | `{ type: 'at', data: { qq } }` | `@<昵称或QQ>`（内联原序） | raw 保留 target QQ 号 | **是**（`qq === bot_qq` 触发） |
| `reply` | `{ type: 'reply', data: { id } }` | 关联 `reply_to: id` 并反查原文 | 记录 `reply_to: id`（对齐原 `msg_id`） | **是**（引用机器人则触发） |
| `file` (私聊文件) | `{ type: 'file', data: { file, file_id, file_size } }` | `[文件:/absolute/path/to/file]`（或 `[文件:name]`） | 凭 `file_id` 即时下载落盘至 `files/` | 否 |
| `file` (群文件) | 上报群文件元数据 / `notice: group_upload` | `[群文件:name (ID:file_id)]` | 仅存元数据 `file_id + busid`，懒加载 | 否 |
| `forward` | `{ type: 'forward', data: { id } }` | `[合并转发 (ID:id)]` | 仅存 `forward_id`，提供独立展开工具 | 否 |
| `record` | `{ type: 'record', data: { file } }` | `[语音]` | 记录 file_id，预留 STT | 否 |
| `video` | `{ type: 'video', data: { file } }` | `[视频]` | 记录 file_id，预留多模态 | 否 |
| `poke` (戳一戳) | `notice: notify/poke` (`target_id`, `user_id`, `group_id?`) | `[戳一戳]` | 入库 notice 事件 | **是**（`target_id === bot_qq`） |
| `shake` (私聊抖动) | `{ type: 'shake' }` | `[窗口抖动]` | 入库 | **是**（私聊抖动触发） |
| `json` / `xml` | `{ type: 'json'\|'xml', data: { data } }` | `[卡片消息:title]` | raw 留存完整载荷 | 否 |
| `rps` / `dice` | `{ type: 'rps'|'dice' }` | `[猜拳]` / `[骰子]` | 入库 | 否 |
| 撤回通知 | `notice: group_recall` / `friend_recall` (`message_id`, `operator_id`) | 更新被撤回消息为 `〔已撤回〕` | 根据 `message_id` 标记 `recalled: 1` | 否 |

### 4.2 唤醒门控与唤醒包契约 [已核实]
- **私聊**：所有非自身发出的消息均直接触发 Agent。
- **群聊唤醒条件**（满足任一即触发）：
  1. `@机器人`（CQ:at 中的 QQ 等于 `bot_qq`）；
  2. `点名`：消息文本精确包含机器人的 QQ 昵称或 `aliases` 别名；
  3. `引用回复`：`reply_to` 指向机器人此前发出的消息；
  4. `被戳`：收到群聊 `poke` 且 `target_id === bot_qq`，或私聊收到 `shake`。
- **自循环严禁触发**：`user_id === bot_qq` 或 `self === true` 的消息坚决不入唤醒判定。

**唤醒包数据结构 (Wakeup Payload)**：
```ts
export interface WakeupPayload {
  trigger: 'at' | 'mention' | 'quote' | 'poke';
  peer: string;                      // 例如 "group_123456" 或 "user_987654"
  from_user: string;                 // 发送者 QQ 号 (用于出方向寻址的稳定唯一标识)
  from_name: string;                 // 发送者当时昵称 (仅作展示)
  content: string;                   // 归一化展示文本 (CQ码已替换，图片已替换为本地路径)
  quoted?: {
    msg_id: number;
    user_id: string;
    from_name: string;
    text: string;
  };
  images?: string[];                 // 唤醒消息携带的本地落盘图片绝对路径
  timestamp: number;                 // 毫秒时间戳
}
```

---

## 5. 存储系统与本地资源目录规范 [已核实]

### 5.1 SQLite 消息表完整 Schema [已核实]
```sql
CREATE TABLE IF NOT EXISTS messages (
  msg_id INTEGER PRIMARY KEY,           -- OneBot message_id
  peer TEXT NOT NULL,                  -- group_<id> 或 user_<id>
  user_id TEXT NOT NULL,               -- 发送者 QQ 号
  sender_name TEXT NOT NULL,           -- 发送者昵称
  time INTEGER NOT NULL,               -- 消息时间戳 (毫秒)
  type TEXT NOT NULL,                  -- 消息主类型 (text/image/file/group_file/at/reply/poke/etc.)
  content TEXT NOT NULL,               -- 归一化文本内容
  raw TEXT NOT NULL,                   -- 原始 OneBot segment 数组 JSON
  file_id TEXT,                        -- 资源稳定 ID
  busid INTEGER,                       -- 群文件专用 busid
  local_path TEXT,                     -- 本地落盘绝对路径 (无则为 NULL)
  fingerprint TEXT,                    -- 内容 SHA-256 指纹 (用于去重)
  recalled INTEGER NOT NULL DEFAULT 0, -- 是否已撤回 (0/1)
  self INTEGER NOT NULL DEFAULT 0,     -- 是否机器人自身发出 (0/1)
  reply_to INTEGER                     -- 被引用的 msg_id
);

CREATE INDEX IF NOT EXISTS idx_messages_peer_user_time ON messages (peer, user_id, time);
CREATE INDEX IF NOT EXISTS idx_messages_peer_time ON messages (peer, time);
CREATE INDEX IF NOT EXISTS idx_messages_file_id ON messages (file_id);
CREATE INDEX IF NOT EXISTS idx_messages_fingerprint ON messages (fingerprint);
```

### 5.2 资源落盘目录与 7 天清理机制 [已核实]
- **下载根目录**：`.dsh/workspace/napcat_download/`
- **分级目录规范**：
  - 图片：`.dsh/workspace/napcat_download/image/<session_id>/<sha256>.<ext>`
  - 表情：`.dsh/workspace/napcat_download/sticker/<session_id>/<sha256>.<ext>`
  - 文件（私聊文件 + 群文件现拉）：`.dsh/workspace/napcat_download/files/<session_id>/<filename>`
- **两级去重算法**：
  1. 一级：以 `file_id` 查库，若已有 `local_path` 且文件存在直接复用；
  2. 二级：计算下载数据流的 SHA-256 哈希指纹，查库若命中同指纹记录则建立硬链接或复用路径，避免重复写盘。
- **定时清理任务**：
  - 启动定时器（通过 Cordis `ctx.effect` 挂载 `setInterval`，插件卸载时自动销毁）；
  - 每天扫描 `.dsh/workspace/napcat_download/`，删除 `mtime` 超过 `image_ttl_days`（默认 7 天）的文件，并同步清理数据库孤儿路径。

---

## 6. Agent 工具集契约规格 [已核实]

所有工具均通过 `@deepseek-ai/dsh-tools` 或 `ctx.tools` 向 Agent 暴露，自动限定在当前 Session 的 `peer` 作用域内。

### 6.1 读历史记录工具 (`read_chat_history`) [已核实]
- **描述**：检索当前群聊或私聊的历史聊天记录，支持多维度组合筛选。
- **入参 Schema**：
  ```ts
  {
    user_id?: string;     // 按指定发送者 QQ 号筛选
    since?: number;       // 起始时间戳 (毫秒)
    until?: number;       // 截止时间戳 (毫秒)
    limit?: number;       // 返回最大条数 (默认 20，上限 100)
    order?: 'asc'|'desc'; // 时间排序 (默认 'desc' 倒序，取最新消息)
  }
  ```
- **出参 Schema**：
  ```ts
  {
    messages: Array<{
      msg_id: number;
      user_id: string;
      sender_name: string;
      time: number;
      type: string;
      content: string;
      recalled: boolean;
      self: boolean;
      reply_to?: number;
      local_path?: string;
    }>;
    total: number;
  }
  ```

### 6.2 抓取文件/资源工具 (`fetch_chat_resource`) [已核实]
- **描述**：凭 `file_id`（群文件附带 `busid`）现拉外部文件到本地，返回可读取路径。
- **入参 Schema**：
  ```ts
  {
    file_id: string;      // 资源 ID (必填)
    busid?: number;       // 群文件专用 busid (群文件必填)
    file_name?: string;   // 保存文件名建议
  }
  ```
- **出参 Schema**：
  ```ts
  {
    success: boolean;
    local_path?: string;  // 成功时返回本地绝对文件路径
    error?: string;       // 失败时返回清晰错误原因 (如 "文件不存在或下载超时")
  }
  ```

### 6.3 展开合并转发工具 (`expand_forward_message`) [已核实]
- **描述**：根据 `forward_id` 调 NapCat `get_forward_msg` 展开合并转发消息内容。
- **入参 Schema**：
  ```ts
  {
    forward_id: string;   // 合并转发 ID (必填)
  }
  ```
- **出参 Schema**：
  ```ts
  {
    success: boolean;
    messages?: Array<{
      sender_name: string;
      user_id: string;
      time: number;
      content: string;
    }>;
    error?: string;
  }
  ```

### 6.4 主动发送文件/图片工具 (`send_file`) [已核实]
- **描述**：Agent 主动向当前会话发送本地生成的文件、报告或图片产物。
- **入参 Schema**：
  ```ts
  {
    file_path: string;            // 本地绝对路径、file:// URI 或 URL (必填)
    file_type?: 'image' | 'file'; // 文件类型 (默认按扩展名自动推导)
  }
  ```
- **出参 Schema**：
  ```ts
  {
    success: boolean;
    message_id?: number;          // OneBot 发送成功返回的消息 ID
    error?: string;
  }
  ```

### 6.5 戳一戳互动工具 (`poke_user`) [已核实]
- **描述**：主动在群内戳指定用户或在私聊窗口抖动用户。
- **入参 Schema**：
  ```ts
  {
    user_id: string;  // 目标用户的 QQ 号 (必填；缺省直接报错 "你需要指定 User ID")
  }
  ```
- **出参 Schema**：
  ```ts
  {
    success: boolean;
    error?: string;
  }
  ```

---

## 7. 出方向：消息生成、Markdown Strip 与发送时序 [已核实]

### 7.1 分段即时发送机制 [已核实]
- 针对 Agent 的单轮 ReAct 循环，Web UI 每次产生一个独立的 `TextBlock` 段落（或 step 结束），插件**立刻向 QQ 下发一条独立消息**。
- 不做整轮回复的强行等待与合并，确保群聊即时性与交互流畅度。
- 群聊回复样式由双配置开关控制：
  - `at_questioner`（默认 `false`）：是否在首段 @ 提问者；
  - `quote_original`（默认 `true`）：是否引用唤醒原消息。

### 7.2 Markdown 自渲染纯文本 Strip 算法规格 [已核实]
出站正文统一调用 `stripMarkdownToPlainText(content)` 转换后再下发：
1. **标题**：`#+ Title` -> `【Title】` 或行首加粗标识；
2. **强调与斜体**：`**text**` / `*text*` / `__text__` / `_text_` -> `text`；
3. **行内代码**：`` `code` `` -> `code`；
4. **多行代码块**：```` ```lang\ncode\n``` ```` -> 保持代码缩进，去除首尾反引号标记，以分割线包裹；
5. **超链接**：`[title](url)` -> `title (url)`，纯 URL 保留；
6. **无序/有序列表**：`- item` / `1. item` -> 保留列表前缀缩进；
7. **表格**：解析为对齐文本行或 `Key: Value` 键值行，严禁出现破碎的 `|---|---|` 原始管道符；
8. **删除线**：`~~text~~` -> `text`。

### 7.3 全局时序控制与 `msg_seq` 串行队列 [已核实]
- 为彻底根治"提问卡片先于正文到达"的竞发乱序问题（见 P-02）：
  - 每个 Session 维护单一的串行 Promise 链（`sendSerializedMessage`）与自增 `msg_seq` 计数器；
  - 正式回复、提问卡片、审批通知、主动发文件均进入此串行队列；
  - 提问与审批消息的发送必须 `await` 完成后，方允许对应的状态机进入挂起等待状态。

---

## 8. 权限门控、斜杠命令与配置管理 [已核实]

### 8.1 管理员白名单与斜杠命令 [已核实]
- **管理员名单**：来自插件配置卡片的 `admins` 字符串数组（QQ 号白名单）。
- **命令识别**：以 `/` 开头的消息直接被命令分发器拦截，**不进入 Agent 对话历史**。
- **命令集定义**：

| 命令格式 | 功能说明 | 权限要求 | 生效范围 |
|---|---|---|---|
| `/mode <readonly\|edit\|yolo>` | 切换当前会话权限预设 | 仅白名单管理员 | Per-Session |
| `/model <model_id>` | 切换当前会话绑定的 LLM 模型 | 仅白名单管理员 | Per-Session |
| `/think <off\|low\|medium\|high>` | 切换当前会话思考深度 | 仅白名单管理员 | Per-Session |
| `/help` | 列出可用命令与当前会话状态 | 仅白名单管理员 | 当前用户 |

### 8.2 Web UI 设置卡片与 Schema 规格 [已核实]
使用 DSH 官方 `installSettingsSection` 注册命名空间 `dsh-napcat-bridge`：
```ts
export const BridgeConfigSchema = z.object({
  ws_port: z.number().default(8080).description('WebSocket 服务端监听端口'),
  ws_token: z.string().default('').description('NapCat 连接鉴权 Token (留空不鉴权)'),
  bot_qq: z.string().required().description('机器人自身 QQ 号 (自循环防护与识别锚)'),
  admins: z.array(z.string()).default([]).description('管理员 QQ 号白名单 (斜杠命令授权)'),
  aliases: z.array(z.string()).default([]).description('助手点名别名列表 (群聊点名唤醒)'),
  at_questioner: z.boolean().default(false).description('群聊回复是否 @提问者'),
  quote_original: z.boolean().default(true).description('群聊回复是否引用原消息'),
  image_ttl_days: z.number().default(7).description('外来图片/资源本地缓存保留天数'),
  persona: z.string().default('你是一个得力的 QQ 群聊助手，请友好、精炼地回答用户。').description('助手人格设定 (注入 SystemPrompt 动态段)'),
  behavior: z.string().default('请严格使用纯文本排版进行回复，避免产生复杂的 Markdown 语法。').description('行为约束准则 (注入 SystemPrompt 动态段)'),
});
```
- **官方 UI 视觉对齐**：使用官方 Web UI 组件库标准卡片容器与字段样式（`--dsw-alias-*` 设计令牌、12px 圆角、官方按钮与输入框）。
- **Revision 冲突自愈**：在保存时若遇到 `SETTINGS_CONFLICT` 错误，前端 Bridge 自动重新获取最新 Revision 并在后台重试一次更新。

---

## 9. 确定性汇总与交付边界

| 模块 / 契约 | 规格定稿结论 | 确定性等级 |
|---|---|---|
| DSH 依赖与安装 | `0.1.1-rc.2` + Cordis `4.0.1`，通过 `dsh plugin --profile web add link:.` 安装 | **[已核实]** |
| 出方向事件面 | 监听 `session/event`，仅提取 `assistant/message` 中的 `TextBlock` | **[已核实]** |
| 动态段提示词 | 通过 `systemPrompt.context()` 注入 `form: 'snapshot'`，非空保底 | **[已核实]** |
| 提问/审批状态机 | 通过 `UserQuestionService.registerProvider` 与 `approval/request` waterfall 对齐官方广播 | **[已核实]** |
| 权限模式控制 | 通过 `permissionPresets.set(session, name)` per-session 切换 | **[已核实]** |
| Markdown Strip | 出方向强制剥离 Markdown 语法转纯文本，适应 NapCat 展现 | **[已核实]** |
| SQLite 存储模型 | `messages` 表全量入库，索引 `(peer, user_id, time)`，两级去重 | **[已核实]** |
| 外部资源落盘规范 | `.dsh/workspace/napcat_download/{image,sticker,files}/<session>/` + 7 天清理 | **[已核实]** |
| 工具集定义 | 5 项工具（读记录、取文件、展开转发、发文件、戳一戳）入参出参固化 | **[已核实]** |
| NapCat 实时协议对接 | Reverse WS 握手、消息段解析、Action 响应格式 | **[需真机验证]** |
| Web UI 卡片双向关闭 | QQ 作答后 DSH Web UI 提问/审批卡片实时关闭 | **[需真机验证]** |
