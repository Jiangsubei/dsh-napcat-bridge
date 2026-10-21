# 需求文档：好友与群管理工具 · 专用Session · 审计日志与群成员感知

> **项目**: dsh-napcat-bridge  
> **文档版本**: v0.2（整理自原 260906 草案，剔除已完成的表情回应与设置卡Tab，拓展常规群感知）  
> **状态**: 待用户审阅与决策  

---

## 0. 背景与目标

桥接插件目前已稳定支持日常消息收发、多维历史查询（`read_chat_history`）、文件收发、贴表情（`react_message`）与多层记忆。  
但在**QQ 社交关系链管理**、**群聊成员感知**与**管理性交互**上尚有明确能力缺口：
1. **加好友被动等待**：好友申请只能人工在手机 QQ 点击同意，Agent 无法基于与用户的历史互动画像自主处理好友申请；
2. **群管理能力缺失**：管理员无法授权 Agent 协助进行群维护（如禁言违规发言、处理加群审批）；
3. **【拓展】常规群成员感知受限**：Agent 在群聊中无法得知群成员全貌、潜水成员名片与管理员头衔，经常只能通过历史发言硬猜身份；
4. **【拓展】单条消息细节缺失**：针对复杂引用链或特定消息，缺少按 `message_id` 快速直查单条消息深度详情的轻量工具；
5. **审计追踪空白**：后台自治操作（加好友审批、后台回顾等）缺乏独立且不可篡改的审计日志。

---

## 1. 工具可见性与会话隔离矩阵（总纲）

为了杜绝安全提权（Confused Deputy）风险，不同会话类型采用严格的工具隔离策略：

| 工具分类 | 工具清单 | 普通群聊 Session | 普通私聊 Session | 加好友专用 Session |
| :--- | :--- | :---: | :---: | :---: |
| **常规群感知工具** *(拓展)* | `get_group_members`, `get_message_detail` | ✅ (常驻可用) | ❌ | ❌ |
| **群管理高危工具** | 禁言/踢人/加群审批/禁言列表 | ✅ (*需命中文本群白名单*) | ❌ | ❌ |
| **好友管理工具** | `get_friend_list`, `set_friend_add_request`, `delete_friend`, `get_stranger_info` | ❌ | ❌ | ✅ (*仅在此Session注册*) |
| **通用交互工具** | `read_chat_history`, `send_file`, `poke_user`, `react_message` 等 | ✅ | ✅ | ❌ (*沙箱隔离，不注册*) |
| **记忆工具** | `read_memory`, `create_memory`, `edit_memory` | ✅ | ✅ | ✅ (*仅读写用户画像*) |

---

## 2. 需求 A：【拓展】常规群成员与消息感知工具（低风险·日常可用）

### 2.1 获取群成员列表与名片 (`get_group_members`)
- **定位**：低风险只读工具。群聊 Session 默认注册。
- **签名**：
  ```ts
  get_group_members {
    group_id?: string | number, // 可选，省略时自动绑定当前群聊
    no_cache?: boolean          // 是否强制刷新本地缓存（默认使用 10 分钟缓存）
  }
  ```
- **返回数据**：成员列表数组（`user_id`, `nickname`, `card` 群名片, `role` owner/admin/member, `join_time`, `last_sent_time`）。
- **价值**：底层已有 `CachedGroupMemberResolver`，封装为工具后，Agent 可直接准确回答“群主是谁”、“帮我看看群里有哪些人”，不再产生幻觉。

### 2.2 单条消息深度透视 (`get_message_detail`)
- **定位**：低风险只读工具。
- **签名**：
  ```ts
  get_message_detail {
    message_id: number // 目标 QQ 消息 ID (必填)
  }
  ```
- **返回数据**：消息精准时间戳、发送者 QQ 与名片、完整富文本消息段、引用的原始父消息摘要与 ID。

---

## 3. 需求 B：群管理工具（按群白名单授权）

### 3.1 工具列表（基于 OneBot 11 成熟接口）
| 工具名称 | 对应 OneBot Action | 参数说明 | 权限与说明 |
| :--- | :--- | :--- | :--- |
| `set_group_ban` | `set_group_ban` | `user_id`, `duration` (秒，0 为解禁) | 禁言单人 |
| `set_group_whole_ban` | `set_group_whole_ban` | `enable` (boolean) | 全员禁言 |
| `set_group_kick` | `set_group_kick` | `user_id`, `reject_add_request` (boolean) | 移出群聊 |
| `set_group_add_request`| `set_group_add_request` | `flag`, `sub_type`, `approve`, `reason` | 加群/邀请申请审批 |
| `get_group_shut_list` | `get_group_shut_list` | 无 | 获取当前群被禁言人员清单 |

### 3.2 权限控制设计（白名单门控）
- **按群白名单制**：默认**全部关闭**。在设置卡「工具权限」Tab 中，必须由管理员显式将群号填入群管理白名单，该群的 Agent 才会注册群管理工具；
- 白名单外的群，工具完全不注册、不可见，彻底隔离提示词注入风险。

---

## 4. 需求 C：好友管理工具与加好友专用 Session

### 4.1 好友管理工具列表（仅加好友专用 Session 注册）
| 工具名称 | 对应 OneBot Action | 参数说明 |
| :--- | :--- | :--- |
| `get_friend_list` | `get_friend_list` | 可选分类分组 |
| `set_friend_add_request` | `set_friend_add_request` | `flag`, `approve` (boolean), `remark` (备注) |
| `delete_friend` | `delete_friend` | `user_id` |
| `get_stranger_info` | `get_stranger_info` | `user_id` |

### 4.2 加好友专用 Session 设计
1. **独立收件箱**：收到 OneBot `request.friend` 事件时，不打扰任何普通私聊或群聊，自动接入专用会话 `peer = "friend_requests"`；
2. **上下文注入**：自动提取申请者的 QQ 号、申请验证消息、以及通过 `read_memory` 检索申请者在其他群的历史发言与用户画像；
3. **决策准则（`friend_request_policy`）**：注入管理员配置的决策准则（例如：无明确来源/画像不认识者暂不通过；理由正当者同意）；
4. **阅后即焚（Ephemeral Session）**：决策完成并调用 `set_friend_add_request` 后，先持久化审计日志，随后自动销毁该临时 Session，不污染会话列表。

---

## 5. 需求 D：后台审计日志系统（Audit Log）

### 5.1 审计范围
- **加好友决策审计**：记录申请人、验证消息、参考画像、决策理由与结果；
- **后台记忆回顾审计**：记录 `BackgroundReviewManager` 触发时间、提炼前后对比与更新条目；
- **群管理执行审计**：记录触发禁言、踢人操作的时间、被操作人与原因。

### 5.2 存储与安全
- 日志文件落盘在 `.dsh/napcat/audit/audit_YYYYMM.jsonl`，采用追加模式原子写入；
- 提供开关 `audit_log_enabled`（默认开启）。

---

## 6. 需求 E：Web UI 设置卡「工具权限」Tab 落地

在设置卡现有的「工具权限」预留 Tab 中落地可视化配置：
1. **好友管理总开关**：`friend_management_enabled`（默认关）；
2. **好友添加准则**：`friend_request_policy` 多行文本输入框；
3. **群管理白名单配置**：
   - 允许开启群管理的群号列表（Tag 输入或多行文本）；
   - 针对白名单群的细分能力开关（禁言开关、踢人开关、加群审批开关）。
