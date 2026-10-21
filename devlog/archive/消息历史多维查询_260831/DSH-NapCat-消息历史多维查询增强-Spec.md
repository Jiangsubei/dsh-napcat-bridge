# DSH-NapCat 消息历史多维查询增强规格说明书 (Spec)

## 1. 目标与背景

当前 `read_chat_history` 工具仅支持 `peer`（当前会话隔离）+ `user_id`（指定 QQ 号）+ `since/until`（纯毫秒时间戳）+ `limit/order`。
在实际 Agent 对话与历史检索场景中，存在以下严重痛点：
1. **无法关键词检索**：用户询问特定话题时，Agent 无法通过关键词搜索，只能分页盲拉，极度消耗 Token 且超出上限便查不到；
2. **无法按消息类型筛选**：表中已记录 `type`（`image`、`file`、`group_file`、`text`、`poke` 等），但 Agent 无法只查发过的文件或图片；
3. **无法按昵称查询**：用户以群昵称/名片称呼提问者时，Agent 无法在未知 QQ 号情况下按昵称检索；
4. **时间参数不友好**：仅支持 Unix 毫秒时间戳，大模型推算时间戳极易出现时区错误或算错，需支持相对时间（如 `"2h"`, `"3d"`）与自然日期字符串（如 `"2026-08-30"`）；
5. **缺少回复关系与附件过滤**：缺少 `reply_to` 关系链检索与 `has_file` 附件快速筛选能力；
6. **出参缺少可读时间**：出参仅有数字毫秒时间戳，增加 Agent 理解成本，需扩充 `formatted_time`（`YYYY-MM-DD HH:mm:ss`）。

---

## 2. 类型与 Schema 契约设计

### 2.1 入参 `ReadChatHistoryParams` 扩充契约

```typescript
export interface ReadChatHistoryParams {
  /** 按指定发送者 QQ 号精确筛选 */
  user_id?: string;
  /** 按发送者昵称/群名片模糊匹配 (SQL LIKE %sender_name%) */
  sender_name?: string;
  /** 按消息内容关键词模糊匹配 (SQL LIKE %keyword%) */
  keyword?: string;
  /**
   * 按消息类型筛选，支持单个类型字符串或类型数组:
   * 'text' | 'image' | 'sticker' | 'file' | 'group_file' | 'forward' | 'record' | 'video' | 'poke' | 'reply'
   */
  type?: string | string[];
  /** 起始时间: 支持毫秒数字、秒级数字、相对时间字符串 ("30m", "2h", "1d", "7d") 或日期时间字符串 ("2026-08-30", "2026-08-30 12:00:00") */
  since?: number | string;
  /** 截止时间: 支持毫秒数字、秒级数字、相对时间字符串或日期时间字符串 */
  until?: number | string;
  /** 快捷相对时间窗口: 检索过去指定时间段内的消息 (如 "1h", "6h", "1d", "7d")，等效于 since = now - relative */
  relative?: string;
  /** 是否仅筛选带有文件/图片/多媒体附件的消息 (local_path 或 file_id 不为空) */
  has_file?: boolean;
  /** 查询指定 msg_id 消息的直接回复消息 (reply_to = ?) */
  reply_to?: number;
  /** 是否排除机器人自己发出的消息 (self = 0) */
  exclude_self?: boolean;
  /** 是否仅查询机器人自己发出的消息 (self = 1) */
  self_only?: boolean;
  /** 返回最大条数 (默认 20，上限 100) */
  limit?: number;
  /** 时间排序 (默认 'desc' 倒序，取最新消息) */
  order?: 'asc' | 'desc';
}
```

### 2.2 出参 `ChatMessageSummary` 增强契约

```typescript
export interface ChatMessageSummary {
  msg_id: number;
  user_id: string;
  sender_name: string;
  time: number; // 毫秒时间戳 (保持向后兼容)
  formatted_time?: string; // 人类可读时间 "YYYY-MM-DD HH:mm:ss"
  type: string;
  content: string;
  recalled: boolean;
  self: boolean;
  reply_to?: number | null;
  local_path?: string | null;
  file_id?: string | null;
}
```

---

## 3. 核心算法与行为细节

### 3.1 人性化时间解析器 (`parseTimeValue` / `formatDateTime`)
1. **相对时间解析**：
   - 匹配正则：`/^(\d+)\s*(s|m|h|d|w|y|秒|分|小时|天|周|年)$/i`
   - 计算：`Date.now() - count * unitMs`
2. **日期时间字符串解析**：
   - `"YYYY-MM-DD"`：解析为对应日期 00:00:00 毫秒时间戳（`until` 若为纯日期则解析为 23:59:59.999 或当日结束）；
   - `"YYYY-MM-DD HH:mm:ss"` / `"YYYY-MM-DD HH:mm"`：解析为对应本地时间戳；
   - ISO 8601 字符串：调用 `Date.parse()`；
   - 容错：非法字符串静默忽略，不抛出异常破坏查询。
3. **数字时间戳解析**：
   - `< 10000000000`（10 位）：识别为秒级时间戳，乘以 1000；
   - `>= 10000000000`：识别为毫秒级时间戳。
4. **快捷 `relative` 参数优先级**：
   - 若传入 `relative` 且未提供 `since`，自动推导 `since = parseTimeValue(relative)`。

### 3.2 SQL 动态构建逻辑
所有条件均以参数化绑定方式安全构建：
- `peer = ?`（核心会话隔离，必选）
- `user_id = ?`（若提供）
- `sender_name LIKE ?`（`%${name}%`，若提供）
- `content LIKE ?`（`%${keyword}%`，若提供）
- `type IN (?, ?...)` 或 `type = ?`（若提供）
- `time >= ?`（若 `since` 有效）
- `time <= ?`（若 `until` 有效）
- `(local_path IS NOT NULL OR file_id IS NOT NULL)`（若 `has_file === true`）
- `reply_to = ?`（若提供）
- `self = 0`（若 `exclude_self === true`）
- `self = 1`（若 `self_only === true`）

---

## 4. 契约测试与验收标准

1. **关键词检索测试**：断言通过 `keyword: '部署'` 能精准过滤包含该字样的消息；
2. **发送者昵称检索测试**：断言通过 `sender_name: '测试'` 能模糊匹配昵称为“测试用户”的消息；
3. **消息类型筛选测试**：断言 `type: 'image'` 只返回图片，`type: ['image', 'file']` 返回图片和文件；
4. **友好时间解析测试**：
   - 相对时间：`since: '1h'` 或 `relative: '2h'` 仅查出近两小时内的消息；
   - 日期字符串：`since: '2026-08-30'` 正确解析起始毫秒并筛选；
5. **附件存在性测试**：断言 `has_file: true` 仅筛选 `local_path` 或 `file_id` 不为空的消息；
6. **机器人消息过滤测试**：断言 `exclude_self: true` 过滤掉 `self = 1` 的消息；`self_only: true` 仅返回 `self = 1` 的消息；
7. **回复链测试**：断言 `reply_to: 1001` 仅返回引用了 1001 的消息；
8. **出参时间格式化测试**：断言返回的消息包含 `formatted_time`（匹配 `^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$`）；
9. **工具端到端调用测试**：断言通过 `read_chat_history` 工具入口调用上述各参数执行正常。
