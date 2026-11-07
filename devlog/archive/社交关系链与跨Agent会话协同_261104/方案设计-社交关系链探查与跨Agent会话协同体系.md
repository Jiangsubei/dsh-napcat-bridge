# 方案设计：社交关系链探查与跨 Agent 会话协同体系

> **项目**: dsh-napcat-bridge  
> **文档版本**: v1.0  
> **文档定位**: 核心技术方案与契约设计规范（对内技术演进与设计基线）  
> **状态**: 方案重构完毕，待用户评审验收  

---

## 0. 背景与设计哲学

### 0.1 现状与痛点：会话孤岛（Context-bound）
目前 dsh-napcat-bridge 插件已稳定支持单会话内的高级交互（文本收发、超长自动分段、多维历史查询、表情包与贴表情、群文件下载、多层记忆等）。  
然而，所有交互均被**严格局限在当前触发的单一会话（`ctx.peer`）沙箱内**：
1. **拓扑失明**：Agent 无法获知当前 QQ 账号的好友列表、加入了哪些群聊，也无法主动查询某个陌生人/群友的基础资料卡（个人等级、个性签名等）；
2. **缺乏跨会话沟通能力**：在群聊中接到“私下找某人核实”或“向另一个群同步”的任务时，Agent 无法在外部会话发起协同；
3. **查群工具会话耦合**：现有群成员查询工具（`get_group_member_info`）与群历史强依赖隐式继承当前群上下文，在私聊中无法作为全功能个人助理查询群状态。

### 0.2 核心架构哲学与设计红线

1. **`send_qq_message` 保持纯粹，坚决不做跨 Peer 飞线出站**：
   - `send_qq_message` 职责单一且纯粹：**永远只向当前入站会话发送 QQ 消息**；
   - 严禁通过给 `send_qq_message` 加 `target_peer` 搞“跨会话直接发消息”。因为跨 Peer 直接飞线会破坏会话边界，导致目标用户在私聊回复时触发失忆的本土 Agent，造成严重的人格分裂与上下文断层。
2. **跨会话沟通统一收敛为 Multi-Agent 内部协作（Agent IPC）**：
   - 跨 Peer 的沟通，在应用架构上**统一提升为 Agent 之间的内部通信**；
   - 每个 QQ 用户拥有其天然专属的常驻 Agent 会话（`qq-user-<userId>`）；
   - 无论何时，**面向真人的 QQ 消息永远出自该用户/群专属的“本土 Agent”**，保持长期记忆、人设口吻与上下文的自洽统一。
3. **只读探查，严禁暴露关系链写操作**：
   - 范围严格限定在“查好友/群列表、查资料卡、查群信息与公告”；
   - **加好友申请、同意加好友、删除好友、加群审批等写操作坚决不暴露为 Agent 工具，彻底保留在人类手中**，杜绝提示词注入（Prompt Injection）导致的“诱骗加好友”或“恶意删好友”风险。
4. **拒绝过早优化，原生复用底层并发配置**：
   - 放弃复杂的无状态临时沙箱（如 `btw`）；
   - DSH 底层天然提供 `new_message_behavior: 'steer' | 'queue'`。目标 Agent 正在执行时，突发消息自动按配置进行插话（`steer`）或排队（`queue`），简单、可靠、零额外状态竞争。

---

## 1. 跨 Agent 协同三件套（Inter-Agent IPC）

```text
 ┌─────────────────────────────────────────────────────────────┐
 │                  【工作区 A】(群聊 Agent)                   │
 └──────────────┬───────────────────────────────┬──────────────┘
                │                               │
        [send_agent_message]             [send_qq_message]
        (内部协作信道，QQ用户不可见)       (面向群聊真人群友出站)
                │                               │
                ▼                               ▼
       SessionManager.dispatchWakeup       群聊 A 界面
      (trigger: 'internal_agent')
                │
                ▼
 ┌─────────────────────────────────────────────────────────────┐
 │            【工作区 B】(小明的专属常驻 Agent)              │
 │ 拥有小明的全部历史偏好、长期画像与私聊记忆                  │
 └──────────────┬───────────────────────────────┬──────────────┘
                │                               │
        [send_agent_message]             [send_qq_message]
        (向工作区 A 交付任务成果)         (以熟悉口吻私聊小明)
                                                │
                                                ▼
                                           小明手机私聊
```

### 1.1 查询活跃 Agent：`list_active_agents`
* **工具名称**: `list_active_agents`
* **功能描述**: 查询当前网关中处于活跃/已实例化的 Agent 会话列表，获取其 Session ID、绑定的用户/群号及当前繁忙状态。
* **参数 Schema**: 无必填参数（支持可选过滤）。
  ```ts
  interface ListActiveAgentsParams {
    /** 可选类型过滤: 'user' | 'group' */
    target_type?: 'user' | 'group';
  }
  ```
* **返回数据**:
  ```json
  [
    {
      "session_id": "qq-user-1000000001",
      "peer": "user_1000000001",
      "target_type": "user",
      "target_id": "1000000001",
      "is_busy": false
    },
    {
      "session_id": "qq-group-8000000001",
      "peer": "group_8000000001",
      "target_type": "group",
      "target_id": "8000000001",
      "is_busy": true
    }
  ]
  ```
* **业务价值**: 消除寻址盲区。Agent 在需要协同前，可先检索目标用户是否已有活着的 Agent。

### 1.2 创建/激活用户 Agent：`create_user_agent`
* **工具名称**: `create_user_agent`
* **功能描述**: 为指定 QQ 用户创建或激活其专属的常驻 Agent 会话，注入初始使命或背景信息，并返回其 Session ID。
* **参数 Schema**:
  ```ts
  interface CreateUserAgentParams {
    /** 目标用户的 QQ 号 (必填) */
    user_id: string | number;

    /** 初始指令或任务背景说明 (必填，将作为系统级协作提示注入目标 Agent 上下文) */
    initial_message: string;
  }
  ```
* **底层实现与执行流程**:
  1. 将 `user_id` 标准化映射为 Peer `user_<user_id>` 与 Session ID `qq-user-<user_id>`；
  2. 调用 `sessionManager.getOrCreateAgent(peer)`：
     - 若该用户此前未曾建立会话，自动初始化专属常驻 Agent；
     - 若已存在，自动复用；
  3. 通过 `sessionManager.dispatchWakeup` 投递初始消息（携带 `trigger: 'internal_agent'` 与 `from_session: ctx.sessionId`）；
  4. 返回结果：
     ```json
     {
       "success": true,
       "session_id": "qq-user-1000000001",
       "peer": "user_1000000001",
       "user_id": "1000000001",
       "message": "用户专属 Agent 已就绪并唤醒。"
     }
     ```

### 1.3 Agent 间内部通信：`send_agent_message`
* **工具名称**: `send_agent_message`
* **功能描述**: 向指定 Session ID 的目标 Agent 发送内部协作消息（布置任务、补充信息或回传成果）。该信道为系统内部总线，**外部 QQ 真人完全不可见、零打扰**。
* **参数 Schema**:
  ```ts
  interface SendAgentMessageParams {
    /** 目标 Agent 的 Session ID (必填，如 "qq-user-1000000001" 或 "qq-group-8000000001") */
    target_session_id: string;

    /** 内部消息内容 (必填，清晰说明协同意图、上下文或交付成果) */
    message: string;
  }
  ```
* **底层唤醒机制**:
  - 底层调用 `dispatchWakeup`，自动从当前上下文提取来源并构建结构化提示注入目标上下文：
    ```text
    【内部协同消息】
    来源会话 Session ID: <from_session>
    消息内容: <message>
    提示: 这是来自其他 Agent 的内部协作消息，QQ 真实用户不可见。请根据上述内容推进，并在有结果时直接调用 send_agent_message 回复上述 Session ID。
    ```
  - 若目标 Agent 正在运行，借力底层的 `resolveNewMessageBehavior()`，自动按用户的配置执行 `steer`（插话引导）或 `queue`（排队等待），平滑无冲突。

---

## 2. 社交只读探查工具链（只读，防注入）

所有只读探查工具严格遵从 **Lossless JSON 规范**，返回数据经过清洗与字段瘦身，杜绝大模型 Token 爆炸。

### 2.1 好友列表查询：`get_friend_list`
* **工具名称**: `get_friend_list`
* **功能描述**: 分页查询当前机器人的 QQ 好友列表，支持按关键词模糊搜索昵称或备注名。
* **参数 Schema**:
  ```ts
  interface GetFriendListParams {
    /** 搜索关键词 (可选，模糊匹配昵称或备注名) */
    query?: string;
    /** 当前页码 (可选，从 1 开始，默认 1) */
    page?: number;
    /** 单页返回条数限制 (可选，默认 20，最大 50) */
    limit?: number;
    /** 是否强制旁路 5 分钟 TTL 缓存重新拉取最新数据 (可选，默认 false) */
    no_cache?: boolean;
  }
  ```
* **返回数据结构与字段精简**:
  ```json
  {
    "success": true,
    "friends": [
      {
        "user_id": "1000000001",
        "nickname": "张三",
        "remark": "老张(财务组)",
        "long_nick": "潜心技术，追求卓越",
        "sex": "male",
        "age": 28,
        "level": 56
      }
    ],
    "total": 1,
    "total_matched": 1,
    "page": 1,
    "limit": 20,
    "total_pages": 1,
    "has_more": false,
    "message": "已展示至最后一页（第 1/1 页，共 1 人）。"
  }
  ```

### 2.2 群聊列表查询：`get_group_list`
* **工具名称**: `get_group_list`
* **功能描述**: 分页查询当前机器人加入的群聊列表，支持按关键词模糊搜索群名称。
* **参数 Schema**:
  ```ts
  interface GetGroupListParams {
    /** 搜索关键词 (可选，模糊匹配群名称或群备注) */
    query?: string;
    /** 当前页码 (可选，从 1 开始，默认 1) */
    page?: number;
    /** 单页返回条数限制 (可选，默认 20，最大 50) */
    limit?: number;
    /** 是否强制旁路 5 分钟 TTL 缓存重新拉取最新数据 (可选，默认 false) */
    no_cache?: boolean;
  }
  ```
* **返回数据结构与字段精简**:
  ```json
  {
    "success": true,
    "groups": [
      {
        "group_id": "8000000001",
        "group_name": "核心研发群",
        "group_remark": "",
        "member_count": 86,
        "max_member_count": 200,
        "group_memo": "欢迎各位开发者交流",
        "group_create_time": 1585055594
      }
    ],
    "total": 1,
    "total_matched": 1,
    "page": 1,
    "limit": 20,
    "total_pages": 1,
    "has_more": false,
    "message": "已展示至最后一页（第 1/1 页，共 1 群）。"
  }
  ```

### 2.3 个人公开资料卡查询：`get_user_profile`
* **工具名称**: `get_user_profile`
* **功能描述**: 查询指定 QQ 用户的公开资料卡（对接 OneBot 11 `get_stranger_info`，好友与非好友均通用）。
* **参数 Schema**:
  ```ts
  interface GetUserProfileParams {
    /** 目标 QQ 号 (必填) */
    user_id: string | number;
  }
  ```
* **返回字段**:
  ```json
  {
    "success": true,
    "user_id": "1000000001",
    "nickname": "张三",
    "remark": "老张(财务组)",
    "sex": "male",
    "age": 28,
    "level": 56,
    "long_nick": "潜心技术，追求卓越",
    "qid": "mock_alias_1001",
    "reg_time": 1104594376
  }
  ```

### 2.4 群基础信息与公告查询
1. **`get_group_info`（群元数据）**:
   - 参数：`group_id: string | number`；
   - 底层对接 OneBot 11 `get_group_info(group_id)`；
   - 返回：群号、群名称、群主 QQ、成员数、最大成员上限、群公告摘要、创建时间等。
2. **`get_group_notice`（群公告列表）**:
   - 参数：`group_id: string | number`；
   - 底层对接 OneBot 11 / NapCat `_get_group_notice(group_id)`（实测标准 Action `get_group_notice` 报 1404，底层必须使用带下划线的 `_get_group_notice`）；
   - 返回结构化公告列表：`notice_id`, `sender_id`, `publish_time`, `content`（从原始 `message.text` 扁平化清洗提取）, `read_num`, `pinned`。

---

## 3. 现有查群工具链解耦改造

为了让 Agent 在私聊场景下也能作为私人助理查询任意群状态，解除现有工具的会话硬绑定：

1. **`get_group_member_info`（群成员信息）**:
   - 新增可选参数 `group_id?: string | number`；
   - 行为：若显式传入 `group_id`，直接按该群拉取成员信息；若缺省且在群聊中，自动回退到当前群；若缺省且在私聊中，报错提示“私聊中查询需显式指定 group_id”。
2. **`read_chat_history`（聊天记录读取）**:
   - Schema 开放可选参数 `peer?: string`；
   - 价值：主人在私聊中下达指令“帮我总结一下群 8000000001 今天的讨论要点”，Agent 可合法拉取目标群历史并生成摘要。

---

## 4. 完整业务交互生命周期推演（End-to-End）

### 典型场景：群聊中主人委托 Agent 找群友私下索要报销发票

```text
 1. 【群聊 A 的 Agent】收到主人指令："帮我问下小明发票开好了没，开好了把单号发群里"
      │
      ├─► 1.1 调用 list_active_agents()
      │       └── 发现小明目前没有活跃 Agent
      │
      ├─► 1.2 调用 get_friend_list(query="小明") 或 lookup
      │       └── 获取到小明的 QQ 号 "1000000001"
      │
      ├─► 1.3 调用 create_user_agent(
      │             user_id="1000000001", 
      │             initial_message="群聊 A 主人需要报销发票单号，请礼貌向小明询问开票情况并把单号回传给群聊 A。"
      │           )
      │       └── 系统创建并初始化小明的常驻 Agent (session_id="qq-user-1000000001")，触发唤醒
      │
      └─► 1.4 调用 send_qq_message(text="好的，已安排小明的专属助手前去跟进。") 
              └── (群聊 A 当前轮次礼貌结束)

 2. 【小明的常驻 Agent】被内部唤醒
      │
      ├─► 2.1 接收到初始使命："群聊 A 主人需要报销发票单号..."
      │       结合对小明的长期偏好记忆，生成拟人化私聊措辞
      │
      └─► 2.2 调用 send_qq_message(text="小明，今天开会的发票开好了吗？如果好了把单号告诉我一下哈~")
              └── (面向小明手机 QQ 私聊出站)

 3. 小明在手机 QQ 私聊回复："开了，单号是 FP-20261104-889"
      │
      ▼
 4. 【小明的常驻 Agent】收到小明的私聊回复
      │
      ├─► 4.1 调用 send_qq_message(text="收到，这就帮你同步给群聊！") (私聊闭环)
      │
      └─► 4.2 调用 send_agent_message(
                    target_session_id="qq-group-群A",
                    message="小明的发票已开具，单号为：FP-20261104-889"
                  )
              └── (内部总线投递，小明手机端不可见)

 5. 【群聊 A 的 Agent】被内部消息唤醒
      │
      └─► 5.1 调用 send_qq_message(text="小明的发票已成功开具，单号为：FP-20261104-889。")
              └── (群聊 A 内向主人交付成果，全流程闭环！)
```

---

## 5. 架构边界与安全红线合规核对

| 规范红线 | 本方案落地策略 | 状态 |
| :--- | :--- | :---: |
| **禁止跨 Peer 飞线出站** | `send_qq_message` 坚决不加 `target_peer`，严格锁定当前会话出站 | ✅ 遵从 |
| **无写权限（防注入）** | 关系链工具纯只读（查好友/查群/查资料），坚决不暴露申请/同意/删除好友 | ✅ 遵从 |
| **Lossless JSON 规范** | 所有工具返回前统一调用 `toLosslessJson` 清洗，严禁任何 `undefined` 字段 | ✅ 遵从 |
| **并发与打断** | 砍掉繁重脆弱的 `btw` 瞬时沙箱，原生借力 `new_message_behavior`（`steer` / `queue`） | ✅ 遵从 |
| **装配闭环验证** | 交付前需通过真实 `bootDshNapcatBridge` 挂载验证，测试契约覆盖工具注册与无损 JSON | ✅ 遵从 |
