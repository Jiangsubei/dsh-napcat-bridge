# DSH × NapCat QQ 插件 — 全面审查与整改落地报告

> **审查时间**：2026-08-30  
> **审查基线**：`docs/DSH-NapCat-QQ插件-Spec.md`、`docs/NapCat实测协议字段采样纪要.md`、`docs/DSH-NapCat-QQ插件-需求文档.md`  
> **审查执行**：主代理协调 3 个专业审查子代理（入方向消息矩阵、存储媒体生命周期、Agent 工具契约与交互上下文）进行深度代码走查与整改验证。

---

## 一、审查综述与核心发现

本次审查对插件的全量入库消息矩阵、SQLite 数据库存储、图片/表情即时下载落盘、两级去重、7 天 TTL 清理、5 大 Agent 原子工具、会话路由与身份感知提示词组装进行了地毯式排查。

### 核心排查结论
1. **入方向消息解析与落盘**：
   - 发现并修复了入方向图片/表情包未即时下载落盘的问题（补齐了 `mediaManager.downloadAndSave`，确保 `local_path` 写入 SQLite 并杜绝 NapCat 临时 URL 过期 404）；
   - 补齐了 `notice: group_upload` 群文件上传事件捕获与存库；
   - 补齐了 `record`（语音）、`video`（视频）、`forward`（合并转发）、`file`（群文件 ID 标记）、`json`/`xml`（卡片标题提取）等全部 14 种消息段的归一化与 `dominantType` 推导；
   - 补齐了群聊引用回复时通过 SQLite `db.getMessage` 反查原消息正文与作者并回填到 Prompt。

2. **存储与 Peer 映射**：
   - 发现并修复了 `read_chat_history` 工具因 Agent 运行时传入 `qq-group-xxx` / `qq-user-xxx` 而 SQLite 存的是 `group_xxx` / `user_xxx` 导致的查询 0 结果问题（实现 `normalizePeer`）；
   - 修复了媒体二级 SHA-256 去重命中时未回写当前 `file_id` 关联的问题；
   - 修复了私聊 `message_sent` 机器人自身发信时发送方 ID 与 `self: 1` 标识冲突的问题。

3. **工具与命令鲁棒性**：
   - 修复了 `fetch_chat_resource`、`poke_user`、`server.sendMsg` 在会话归档版本自愈（形如 `qq-group-1001-2`）下截取 ID 产生 `NaN` 的问题；
   - 修复了 `/think` 获取 Agent 实例缺少 `ctx.get("agents")` 容错的问题；
   - 动态 Prompt 注入补充了 `assembleCtx?.session` 兼容。

---

## 二、14 种消息/事件矩阵与落库对照表

| 序号 | 消息/事件段类型 | 协议载荷特征 | content 归一化规范 | 入库 type 与字段 | 落盘与特殊行为 | 审查状态 |
|---|---|---|---|---|---|---|
| 1 | `text` 纯文本 | `data.text` | 原文，保留排版 | `type: "text"` | 无需落盘 | ✅ 对齐 |
| 2 | `face` 小表情 | `data.raw.faceText` | `[表情:faceText]` 或 `[表情:id=xxx]` | `type: "text"` | 无需落盘 | ✅ 对齐 |
| 3 | `image` 普通图 | `data.url` / `data.file` | `[图片:/absolute/path]` | `type: "image"`, `file_id`, `local_path`, `fingerprint` | 即时下载落盘至 `napcat_download/image/<peer>/` | ✅ 修复对齐 |
| 4 | `image` 表情包 | `sub_type: 1` / `emoji_package_id` | `[表情包:summary]` 或 `[表情包:/absolute/path]` | `type: "sticker"`, `file_id`, `local_path`, `fingerprint` | 即时下载落盘至 `napcat_download/sticker/<peer>/` | ✅ 修复对齐 |
| 5 | `at` @成员 | `data.qq` | 内联拼接 `@<QQ>` | `type: "at"` (若主段为 at) | 提取 atQQs 供唤醒门控 | ✅ 对齐 |
| 6 | `reply` 引用回复 | `data.id` (被回复 msg_id) | 提取 `reply_to` | `type: "reply"`, `reply_to: id` | 反查原消息并注入 Prompt 引文 | ✅ 修复对齐 |
| 7 | `file` 私聊文件 | `data.file` / `data.file_id` | `[文件:name]` | `type: "file"`, `file_id` | 懒加载，支持 `fetch_chat_resource` | ✅ 修复对齐 |
| 8 | `file` 群文件 | `notice: group_upload` | `[群文件:name (ID:file_id)]` | `type: "group_file"`, `file_id`, `busid` | 懒加载，支持 `fetch_chat_resource` | ✅ 修复对齐 |
| 9 | `forward` 合并转发 | `data.id` / `data.forward_id` | `[合并转发 (ID:id)]` | `type: "forward"`, `file_id: id` | 支持 `expand_forward_message` 展开 | ✅ 修复对齐 |
| 10 | `record` 语音 | `data.file` | `[语音]` | `type: "record"`, `file_id` | 保留占位与 file_id | ✅ 修复对齐 |
| 11 | `video` 视频 | `data.file` | `[视频]` | `type: "video"`, `file_id` | 保留占位与 file_id | ✅ 修复对齐 |
| 12 | `poke` 戳一戳 | `notice: notify/poke` | `[戳一戳]` | `type: "poke"` | 唤醒并格式化为 `用户 xx 戳了戳你` | ✅ 修复对齐 |
| 13 | `shake` 窗口抖动 | `type: "shake"` | `[窗口抖动]` | `type: "shake"` | 唤醒并格式化 | ✅ 修复对齐 |
| 14 | `json` / `xml` 卡片 | `data.data` / `data.title` | `[卡片消息:title]` | `type: "json"` / `"xml"` | 提取 title/prompt，过滤冗余原始载荷 | ✅ 修复对齐 |
| 15 | 消息撤回 | `notice: group_recall / friend_recall` | 更新被撤回消息为 `〔已撤回〕` | `recalled = 1` | 更新 SQLite `messages.recalled` 字段 | ✅ 对齐 |

---

## 三、Agent 5 大工具与交互上下文对照

| 工具名称 | 关键修复与增强 | 验证结果 |
|---|---|---|
| `read_chat_history` | 增加 `normalizePeer` 映射，消除 `qq-group-xxx` 与 `group_xxx` 格式差异，支持倒序/正序/since/until/user_id 检索 | ✅ 验证通过 |
| `fetch_chat_resource` | 增加归档版本后缀剥离（`qq-group-1001-2` -> `1001`），支持一级 `file_id` 查库与二级 SHA-256 指纹去重 | ✅ 验证通过 |
| `expand_forward_message` | 兼容 NapCat `get_forward_msg` 响应并提取节点作者、时间和正文 | ✅ 验证通过 |
| `send_file` | 支持本地路径/URI，自动推导图片与文件类型，剥离版本后缀精准下发 | ✅ 验证通过 |
| `poke_user` | 支持群聊 `group_poke` 与私聊 `friend_poke`，剥离版本后缀防止 `NaN` | ✅ 验证通过 |

---

## 四、测试与验收结论

1. `pnpm typecheck`：**0 错误**；
2. `pnpm test`：全量 8 个测试套件（22 个契约测试用例）**100% 全部通过 (GREEN)**；
3. 实机 Node 脚本针对 `normalizePeer`、`read_chat_history` 对接 `session.id`、全量 Segment 归一化、引用回复原文反查全部断言通过。
