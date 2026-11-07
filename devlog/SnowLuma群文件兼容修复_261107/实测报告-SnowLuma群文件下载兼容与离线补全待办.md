# SnowLuma 群文件下载兼容修复与协议端实测报告

> **日期**: 2026-11-07
> **状态**: 代码修复与契约测试已完成（`pnpm typecheck`、`pnpm test:quick`、`pnpm build` 全绿）；真机链路待用户修复连接 Token 后验证
> **范围**: 本轮仅处理群文件下载与 `list_group_files` 去重；SnowLuma 离线消息补全只记录根因与待办，未改动 `src/gateway/sync.ts`
> **脱敏说明**: 本文所有 QQ 号、群号、Token、Cookie 均以 `1000000001`、`8000000001` 等标准 Mock ID 替代，不含真实隐私信息

---

## 1. 结论摘要

| 问题 | 结论 | 处理状态 |
|:---|:---|:---:|
| 群文件下载报 `参数错误`（busid=0） | 网关层显式发送 `busid: 0`，SnowLuma 不接受 0 | ✅ 已修复 |
| 群文件下载报 `文件 file_id 错误` | `group_upload` notice 落库为 32 位 hex，SnowLuma 只接受消息段 `/uuid` | ✅ 已修复（两级垫片） |
| `list_group_files` 同一文件出现两条 | 同一次上传同时产生 notice 与消息段记录 | ✅ 已修复（30s 窗口去重） |
| 私聊文件下载 | `<md5>_<uuid>` 主路径可用；`get_file` 兜底在 SnowLuma 恒失败 | ✅ 主路径不受影响，无需改动 |
| 离线消息补全 | SnowLuma 的 `get_recent_contact` 为恒空占位，历史分页锚点语义与 NapCat 不同 | ⏳ 未实施，已登记 TODO |

**NapCat 零回归保证**：所有兼容逻辑都只在“原始请求失败”或“读取/展示层合并”时触发；NapCat 首次请求成功的下载路径不会产生任何额外协议端请求。

---

## 2. 根因与实测证据

### 2.1 根因一：busid 不能显式传 0

SnowLuma 对 `get_group_file_url` 的 `busid` 处理为“缺省时默认 102”，但显式传 `0` 会返回：

```
group file url failed: code=4294966993 msg=参数错误
```

而 NapCat 的 `get_group_file_url` 实现并不消费 `busid`，因此对 NapCat 省略该字段无影响。

**修复**：`src/gateway/server.ts` 的 `getGroupFileUrl` 仅在 busid 为有效正数时透传；`undefined` / `null` / `0` 一律省略。

### 2.2 根因二：notice 的 32 位 hex file_id 不可用于取 URL

实测同一群文件存在两种记录：

| 来源 | file_id 形态 | `get_group_file_url` 结果 |
|:---|:---|:---|
| `group_upload` notice | 32 位 hex（如 `ae4d…b29`） | `msg=文件 file_id 错误` |
| 消息段 `type=file` | `/uuid`（如 `/820d…463`） | 正常返回下载 URL |

`/uuid` 搭配 `busid=102` 或**完全省略 busid** 均可成功；返回的 URL 用普通 HTTP `fetch` 可下载（200/206）。URL 内含 rkey，过期后 403，因此必须每次现取，不能缓存 URL。

**修复**：新增 `src/tools/group-file-resolve.ts`，仅在首次取 URL 失败后触发两级解析：

1. **本地兄弟记录优先**：读取失败记录所属 `peer`、文件名、时间，查 `MessageDatabase.findGroupFileSibling()`，找同一次上传的消息段 `/uuid`。此级命中时零额外协议端请求。
2. **群目录兜底**：调用 `get_group_root_files`，按文件名 + 大小 + 上传时间匹配；未命中再递归子目录（深度上限 3、目录数上限 30）。目录快照缓存 60 秒（实测根目录约 291 个文件、81 KB、耗时约 3.7 秒）。

命中后使用解析出的 `/uuid` 与正数 busid 重试一次；仍失败则保留协议端原始报错。

落盘时仍使用**原始 file_id** 作为 `mediaManager.downloadAndSave` 的去重与落库键，垫片只改变下载引用，不改变消息记录归属。

### 2.3 根因三：`list_group_files` 双记录重复

脱敏后的本地统计（测试群 `8000000001`）：

- `type='group_file'` 共 63 条 = 32 条 notice + 31 条消息段；
- 其中 28 对可按 ±3 秒配对，29 对可按文件名配对；
- 配对时间差绝大多数为 0~1 秒，最长 15 秒；
- 4 条旧 notice 暂无兄弟记录（后续可被群目录兜底解析）。

**修复**：`MessageDatabase.listGroupFiles` 改为“先全量查询 → 合并双记录 → 排序分页”。

去重规则：

- 同 peer、同文件名；
- 时间差 ≤ 30 秒（覆盖实测最长 15 秒）；
- 上传者兼容（双方均有 user_id 时必须一致）；
- 大小兼容（双方均有 size 时必须一致）。

合并策略：

- `msg_id` / `time` 保留首次出现（notice）记录，作为文件历史定位锚点；
- `file_id` 优先 `/uuid` 形态；
- `busid` 优先正数；
- `size` 缺失时由另一条补齐。

同名但跨时间上传的文件不会被误合并（契约测试覆盖）。

### 2.4 私聊文件（无需改动）

- 私聊消息段文件可直接用 `<md5>_<uuid>` 形态的 file_id 调 `get_private_file_url`，返回 URL 实测 HTTP 206；
- `get_file` 兜底在 SnowLuma 恒失败：`file_id not found in the image/voice cache...`；
- 主路径不依赖 `get_file`，因此私聊文件下载不受影响。

### 2.5 离线补全（本轮不实施）

- `get_recent_contact` 在 SnowLuma 中是恒返回 `[]` 的占位实现，无法探测最近会话；
- `get_group_msg_history` / `get_friend_msg_history` 只认 `message_id` + `reverse_order`（默认 `true`），忽略 `message_seq`；`message_id` 锚点语义为“锚点及更旧”的包含式分页；
- 模拟结果（pageSize=5）：现状仅 2 页 / 补入 5 条；仅改锚点且遇重即断仍为 5 条；改为“锚点 + 跳过重复”后可达 5 页 / 补入 21 条。

结论：现有 `OfflineMessageSyncer` 的“最近联系人探测 + 遇重即断”策略在 SnowLuma 上基本失效，需要按协议端能力矩阵单独设计，详见根目录 `TODO.md`。

---

## 3. 代码与契约测试

### 3.1 改动文件

| 文件 | 改动 |
|:---|:---|
| `src/gateway/server.ts` | `getGroupFileUrl` 仅在正数 busid 时透传；新增 `getGroupRootFiles`、`getGroupFilesByFolder` |
| `src/tools/group-file-resolve.ts` | 新增两级 file_id 解析器、60s 目录快照缓存、`clearGroupFileResolverCache()` |
| `src/tools/index.ts` | 群文件下载失败后解析并重试一次；落盘仍用原始 file_id |
| `src/storage/database.ts` | `listGroupFiles` 双记录合并与分页；新增 `findGroupFileSibling()`；抽出群文件行解析辅助函数 |

### 3.2 契约测试

| 测试 | 覆盖点 |
|:---|:---|
| `gateway-actions.test.ts` SnowLuma 兼容-契约 9 | busid 缺失/0 不发送；102 原样透传 |
| `resource-fetch.test.ts` SnowLuma-契约 8 | 本地兄弟记录优先，零根目录请求 |
| `resource-fetch.test.ts` SnowLuma-契约 9 | 本地无兄弟时走群根目录文件名匹配 |
| `resource-fetch.test.ts` SnowLuma-契约 10 | 首次成功绝不触发兜底（NapCat 零回归） |
| `resource-fetch.test.ts` SnowLuma-契约 11 | 双级均失败时保留协议端原始报错 |
| `list-group-files.test.ts` 契约 3.5 | notice + 消息段合并为一条，保留 `/uuid`、正数 busid、首次时间 |
| `list-group-files.test.ts` 契约 3.6 | 同名不同次上传不误合并 |

验证结果：

```
Test Files  111 passed (111)
Tests       953 passed | 3 skipped (956)
pnpm typecheck 通过
pnpm build 通过（dist 已包含本次改动）
```

---

## 4. 真机验证清单（待用户执行）

1. 修复 DSH 侧 `ws_token` 与 SnowLuma accessToken 不一致问题并重启；确认 3001 端口存在 `ESTABLISHED` 连接。
2. 用 `list_group_files` 查询测试群，确认同一文件不再重复出现。
3. 取一条 notice 来源记录的 file_id 调用 `fetch_chat_resource`，确认自动解析并落盘。
4. 取一条消息段 `/uuid` 记录调用，确认首次请求即成功，不额外请求群目录。
5. 在 NapCat 实例下回归一次群文件下载，确认参数与行为不变。

---

## 5. 风险与限制

- 群根目录列表在真机约 3.7 秒、81 KB，已加 60 秒缓存；冷启动首次兜底会有明显延迟。
- 本地兄弟记录与群目录均未命中时，仍会返回协议端原始错误，不会伪造成功。
- 去重窗口 30 秒基于实际数据分布；若同一用户 30 秒内重复上传同名同大小文件，存在被合并的理论可能。
- 子目录递归受深度与目录数上限约束，超限时仅能匹配已遍历部分。
- 旧群文件 URL 的 rkey 会过期（403），本实现每次取 URL，不缓存直链。
