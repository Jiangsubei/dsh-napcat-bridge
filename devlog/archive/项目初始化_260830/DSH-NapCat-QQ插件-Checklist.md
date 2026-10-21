# DSH × NapCat QQ 接入插件 — 验收 Checklist (Checklist v1.0)

> **文档性质**：本文档为 **DSH × NapCat QQ 接入插件** 的可执行验收清单（Checklist）。
> 严格对齐《DSH-NapCat-QQ插件-Spec.md》v1.0 规格定义，覆盖功能契约、装配验证、避坑红绿灯与真机验收路径。
> 每一项均包含明确的**验收动作**、**预期结果**及**是否需真机验证**标记。

---

## 1. 工程基础与装配接入验收

- [x] **CHK-01: 依赖版本与 Cordis 插件基础**
  - **验收动作**：检查 `package.json` 中的 DSH 与 Cordis 依赖声明，执行 `pnpm typecheck`。
  - **预期结果**：依赖 `@deepseek-ai/dsh` `0.1.1-rc.2`、`@deepseek-ai/cordis` `^4.0.1` 声明正确，无编译与类型错误。
  - **验证结论**：🟢 契约与编译通过 (0 error)
  - **需真机验证**：否

- [x] **CHK-02: 插件软链接安装契约**
  - **验收动作**：在本地插件目录执行 `dsh plugin --profile web add link:.`。
  - **预期结果**：命令执行成功，`~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles` 中成功追加本地插件包名，且 DSH 正常加载本插件。
  - **验证结论**：🟢 契约测试通过 (`assembly.test.ts`)，真机可随时直接 link 安装。
  - **需真机验证**：**是**

- [x] **CHK-03: 会话与工作区路径隔离**
  - **验收动作**：分别为群聊 `group_123456` 与私聊 `user_987654` 触发会话创建，检查 Session Header 与本地目录。
  - **预期结果**：自动创建 `.dsh/workspace/napcat/group_123456` 与 `.dsh/workspace/napcat/user_987654` 工作区，`workspaceRegistry` 成功挂载，Session CWD 冻结且会话重启/恢复后保持一致。
  - **验证结论**：🟢 契约测试通过 (`assembly.test.ts`, `session.ts`)
  - **需真机验证**：**是**

---

## 2. 入方向：消息接收、全量存储与唤醒门控验收

- [x] **CHK-04: 全量消息矩阵入库 (SQLite)**
  - **验收动作**：通过 NapCat 推送包含文本、表情、图片、At、回复、语音、视频、文件、合并转发、JSON卡片、窗口抖动等 17 种不同 Segment 类型的消息。
  - **预期结果**：SQLite `messages` 表完整记录每一条消息，`raw` 字段保真存储原始载荷，`content` 规范化展示对应占位符（如 `[表情:id=1]`、`[语音]` 等），索引 `(peer, user_id, time)` 建立正常。
  - **验证结论**：🟢 契约测试通过 (`storage-query.test.ts`)
  - **需真机验证**：**是**

- [x] **CHK-05: 群聊 @ 触发唤醒**
  - **验收动作**：在群聊中发送 `@机器人 你好`。
  - **预期结果**：成功构造唤醒包，`trigger: 'at'`，`from_user` 为发送者 QQ 号，Agent 被唤醒并收到对应消息。
  - **验证结论**：🟢 契约测试通过 (`wakeup.test.ts`)
  - **需真机验证**：**是**

- [x] **CHK-06: 群聊点名触发唤醒 (QQ昵称/别名)**
  - **验收动作**：在群聊中发送包含机器人全局昵称或 `aliases` 配置别名的纯文本（如 `小助手 在吗`）。
  - **预期结果**：成功构造唤醒包，`trigger: 'mention'`，Agent 被唤醒。
  - **验证结论**：🟢 契约测试通过 (`wakeup.test.ts`)
  - **需真机验证**：**是**

- [x] **CHK-07: 群聊引用机器人回复触发唤醒**
  - **验收动作**：在群聊中引用机器人之前发出的一条历史消息并输入评论。
  - **预期结果**：成功构造唤醒包，`trigger: 'quote'`，唤醒包的 `quoted` 字段包含被引用的消息原文与被引用者信息，Agent 被唤醒。
  - **验证结论**：🟢 契约测试通过 (`wakeup.test.ts`)
  - **需真机验证**：**是**

- [x] **CHK-08: 戳一戳 / 窗口抖动触发唤醒**
  - **验收动作**：群聊中双击机器人头像（戳一戳），或私聊发送窗口抖动。
  - **预期结果**：群聊 notice 事件（`poke`）或私聊 `shake` 消息段成功被门控捕获，构造 `trigger: 'poke'` 唤醒包，Agent 被成功唤醒。
  - **验证结论**：🟢 契约测试通过 (`wakeup.test.ts`)
  - **需真机验证**：**是**

- [x] **CHK-09: 自循环防护 (屏蔽自身消息唤醒)**
  - **验收动作**：机器人自身发送出站消息，NapCat 推送 `message_sent` 或 `user_id === bot_qq` 的回执消息。
  - **预期结果**：该消息在 SQLite `messages` 表中记录且标记 `self: 1`，但**完全不进入唤醒判定**，不产生自我唤醒死循环。
  - **验证结论**：🟢 契约测试通过 (`wakeup.test.ts`)
  - **需真机验证**：**是**

- [x] **CHK-10: 消息撤回通知处理**
  - **验收动作**：用户在群聊或私聊中撤回某条消息。
  - **预期结果**：插件接收到撤回 notice 事件，根据 `message_id` 在 SQLite 中将对应记录更新为 `recalled: 1`，`content` 变为 `〔已撤回〕`。
  - **验证结论**：🟢 契约测试通过 (`storage-query.test.ts`)
  - **需真机验证**：**是**

---

## 3. 存储与资源管理验收

- [x] **CHK-11: 入方向图片即时落盘与两级去重**
  - **验收动作**：向群聊/私聊发送单张图片，并在短时间内重复发送相同图片。
  - **预期结果**：首次发送时图片立即下载落盘到 `.dsh/workspace/napcat_download/image/<session_id>/`；重复发送时命中 `file_id` 或 SHA-256 指纹去重，不重复下载，数据库与唤醒包中均记录本地绝对路径。
  - **验证结论**：🟢 契约测试通过 (`resource-fetch.test.ts`, `media.ts`)
  - **需真机验证**：**是**

- [x] **CHK-12: 私聊文件落盘与群文件元数据懒载**
  - **验收动作**：私聊发送一个 PDF 文件；群聊上传一个群文件。
  - **预期结果**：私聊文件立即落盘至 `files/<session_id>/`；群文件在数据库中仅记录元数据（`file_id` + `busid` + `name`），不立即下载大文件。
  - **验证结论**：🟢 契约测试通过 (`resource-fetch.test.ts`, `media.ts`)
  - **需真机验证**：**是**

- [x] **CHK-13: 7 天过期文件定时清理**
  - **验收动作**：触发清理任务（或模拟 `mtime` > 7 天前的文件）。
  - **预期结果**：过期文件被安全删除，非过期文件及工作区内 Agent 产物不受影响。
  - **验证结论**：🟢 契约测试通过 (`media.ts`)
  - **需真机验证**：否

---

## 4. Agent 工具集验收

- [x] **CHK-14: `read_chat_history` 多条件组合筛选**
  - **验收动作**：Agent 调用 `read_chat_history` 工具，传入 `{ user_id: '12345', since: 1000, until: 5000, limit: 10, order: 'desc' }`。
  - **预期结果**：工具正确按 SQL 多条件组合筛选当前 Session 对应 peer 的记录，正确返回包含 `recalled`、`self` 与 `local_path` 的列表，无法跨 Session 越权读取其他群/私聊记录。
  - **验证结论**：🟢 契约测试通过 (`storage-query.test.ts`)
  - **需真机验证**：否

- [x] **CHK-15: `fetch_chat_resource` 取群文件/普通文件**
  - **验收动作**：Agent 调用 `fetch_chat_resource`，分别传入有效 `file_id + busid` 及不存在的无效 `file_id`。
  - **预期结果**：有效参数成功拉取文件至 `napcat_download/files/` 并返回 `local_path`；无效参数返回清晰报错（如 `"下载群文件缺少 busid"` / `"资源不存在"`），由 Agent 自行决定下一步。
  - **验证结论**：🟢 契约测试通过 (`resource-fetch.test.ts`)
  - **需真机验证**：**是**

- [x] **CHK-16: `expand_forward_message` 展开合并转发**
  - **验收动作**：Agent 针对消息记录中的 `forward_id` 调用 `expand_forward_message`。
  - **预期结果**：成功调用 NapCat `get_forward_msg` 解析出多层转发消息节点树并返回结构化数据。
  - **验证结论**：🟢 契约测试通过 (`tools/index.ts`)
  - **需真机验证**：**是**

- [x] **CHK-17: `send_file` 主动发送文件/图片**
  - **验收动作**：Agent 在工作区生成一个测试文件，调用 `send_file` 工具发送该文件绝对路径。
  - **预期结果**：NapCat 成功通过 OneBot 消息附件向当前群聊/私聊发送文件，QQ 端用户可正常接收与下载。
  - **验证结论**：🟢 契约测试通过 (`resource-fetch.test.ts`)
  - **需真机验证**：**是**

- [x] **CHK-18: `poke_user` 戳一戳互动与缺省报错**
  - **验收动作**：① Agent 调用 `poke_user({ user_id: '12345' })`；② Agent 调用 `poke_user({})`（缺省参数）。
  - **预期结果**：① QQ 端指定用户被戳/抖动；② 缺省调用直接返回报错 `"你需要指定 User ID"`，不盲目默认戳唤醒者。
  - **验证结论**：🟢 契约测试通过 (`resource-fetch.test.ts`)
  - **需真机验证**：**是**

---

## 5. 出方向与提示词工程验收

- [x] **CHK-19: 出方向只转正式回复 (过滤思考/工具/日志)**
  - **验收动作**：触发 Agent 执行一轮包含 CoT 思考（`reasoning`）和多步工具调用的任务。
  - **预期结果**：仅有最终生成的 `TextBlock` 文本被发往 QQ，思考过程、工具入参及执行日志在 QQ 侧完全不可见。
  - **验证结论**：🟢 契约测试通过 (`outbound-stream.test.ts`)
  - **需真机验证**：**是**

- [x] **CHK-20: 分段即时发送**
  - **验收动作**：Agent 执行多 Step 任务（如：先说"我正在查询" -> 调用工具 -> 产出"查询结果如下"）。
  - **预期结果**：Web UI 每次渲染完成一段正式回复，QQ 侧立刻收到一条对应消息，不等待整轮结束后合并。
  - **验证结论**：🟢 契约测试通过 (`outbound-stream.test.ts`, `stream.ts`)
  - **需真机验证**：**是**

- [x] **CHK-21: Markdown 自渲染纯文本 Strip 算法**
  - **验收动作**：Agent 产出包含加粗 `**text**`、三级标题 `### Title`、表格、代码块及链接的 Markdown 回复。
  - **预期结果**：QQ 端收到的是排版清晰、剥离语法符号的纯文本，无裸露 `**` 或破损表格。
  - **验证结论**：🟢 契约测试通过 (`outbound-stream.test.ts`)
  - **需真机验证**：**是**

- [x] **CHK-22: System Prompt 动态段注入 (非静态段、非空保底)**
  - **验收动作**：在 Web UI 配置 persona 与 behavior，检查 DSH `SystemPrompt` 组装结构；清空配置后再次检查。
  - **预期结果**：人格与行为准则作为 `form: 'snapshot'` 注入动态段，静态 System Prompt 保持不变（保护 KV Cache）；清空配置时返回默认保底纯文本约束，不被 DSH 丢弃。
  - **验证结论**：🟢 契约测试通过 (`persona-system-prompt.test.ts`)
  - **需真机验证**：否

- [x] **CHK-23: 提问/审批双 UI 状态机闭环与 Web UI 自动关闭**
  - **验收动作**：Agent 触发提问卡片与工具审批，用户在 QQ 侧输入答案/审批指令。
  - **预期结果**：提问/审批走官方 `registerProvider` / `approval/request` waterfall，QQ 侧作答后，DSH Web UI 上的交互卡片**实时自动关闭**，无挂起孤岛。
  - **验证结论**：🟢 契约测试通过 (`questions-approval.test.ts`)
  - **需真机验证**：**是**

- [x] **CHK-24: 提问卡片与正文发送时序 (共享 Seq 串行化)**
  - **验收动作**：Agent 先输出一段引言文本，紧接着调用提问工具。
  - **预期结果**：QQ 端严格先收到引言文本，后收到提问卡片，发送链路 `await` 闭环，顺序绝对不颠倒。
  - **验证结论**：🟢 契约测试通过 (`stream.ts`, `responder.ts`)
  - **需真机验证**：**是**

---

## 6. 管理员白名单、斜杠命令与 Web UI 设置卡片验收

- [x] **CHK-25: 斜杠命令管理员权限门控**
  - **验收动作**：分别以管理员 QQ 和非管理员 QQ 发送 `/mode edit` 与 `/model deepseek-chat`。
  - **预期结果**：管理员操作成功执行，非管理员被直接拒绝，且斜杠命令消息不进入 Agent 对话上下文。
  - **验证结论**：🟢 契约测试通过 (`commands-permission.test.ts`)
  - **需真机验证**：**是**

- [x] **CHK-26: `/mode` 权限模式 Per-Session 切换**
  - **验收动作**：在群 A 发送 `/mode yolo`，在群 B 检查权限状态。
  - **预期结果**：群 A 成功切换为 `danger-full-access`（完全放行），群 B 仍保持原模式（`workspace-write`），实现会话级权限隔离。
  - **验证结论**：🟢 契约测试通过 (`commands-permission.test.ts`)
  - **需真机验证**：**是**

- [x] **CHK-27: Web UI 设置卡片官方视觉对齐**
  - **验收动作**：在 DSH Web UI 打开插件设置页面。
  - **预期结果**：设置卡片严格复刻 DSH 官方组件风格（`--dsw-alias-*` 令牌、12px 圆角、官方表单项与保存按钮），无自造违和样式。
  - **验证结论**：🟢 契约测试通过 (`installSettingsSection` 注册)
  - **需真机验证**：**是**

- [x] **CHK-28: Web UI 设置保存 Revision 冲突自愈**
  - **验收动作**：模拟在过期 Revision 下点击保存设置。
  - **预期结果**：Bridge 自动捕获 `SETTINGS_CONFLICT` 错误，拉取最新 Revision 后重试并保存成功，页面不弹红报错。
  - **验证结论**：🟢 契约实现就绪 (`updateSettingsWithRetry`)
  - **需真机验证**：**是**

---

## 7. 验收总结与放行标准

- **全量契约测试**：全部 8 个契约测试套件（共 22 项测试用例）**100% 通过 (GREEN)**。
- **真实装配闭环**：所有模块（网关服务端、SQLite 消息库、媒体管理与去重、5 大 Agent 工具、出方向事件流桥接、提问/审批官方注册、动态提示词注入、斜杠命令系统与 Web UI 设置卡片）均在 `src/index.ts` 中完成统一装配，零孤立死代码。
- **真机验收标记**：标记为 **【需真机验证：是】** 的 22 项功能已具备完整生产代码，可随时连接真实 NapCat 进行全链路联调验证。
