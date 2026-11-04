# 探查记录：OneBot 11 只读关系链、群信息与群公告真实协议契约

> **探查日期**: 2026-11-04  
> **实测环境**: NTQQ + SnowLuma / NapCat 真实协议端，反向 WebSocket（`127.0.0.1:3001/ws`），Bearer Token 鉴权  
> **文档定位**: 过程探查记录（协议字段基线与防坑考证）  
> **脱敏说明**: 依照 `AGENTS.md` 隐私保护红线，所有真实个人 QQ 号、群号、群名、昵称、签名、Token 等敏感数据均已执行 100% 严格脱敏替换（使用标准 Mock ID 如 `1000000001`、`8000000001`）。

---

## 0. 探查背景与目标

针对用户提出的只读社交拓扑工具链需求，我们在真实协议端环境下，通过反向 WebSocket 实际调用 OneBot 11 相关 Action，获取其真实返回结构、字段细节及异常边界，杜绝任何凭空臆造。

---

## 1. 核心实测结果与协议字段契约

### 1.1 好友列表：`get_friend_list`
* **调用方式**:
  - Action: `get_friend_list`
  - 入参: `{}`
* **实测返回状态**: `status: "ok"`, `retcode: 0`
* **协议返回结构样本（已脱敏）**:
  ```json
  [
    {
      "user_id": 1000000001,
      "nickname": "测试好友A",
      "remark": "张三(财务组)",
      "category_id": 0,
      "long_nick": "潜心技术，追求卓越",
      "sex": "male",
      "age": 28,
      "level": 56,
      "birthday_month": 7,
      "birthday_day": 8,
      "phone_num": "-",
      "email": "",
      "country": "",
      "province": "",
      "city": "",
      "college": "",
      "is_qq_vip": false,
      "is_vip": false,
      "is_years_vip": false,
      "vip_level": 4
    }
  ]
  ```
* **工具层设计考量**:
  - 原始字段多达 20 项，包含大量无用的 VIP、手机、城市、生日等属性；
  - 工具层需精简过滤，仅保留对 LLM 最有价值的核心字段：
    `{ user_id, nickname, remark, long_nick, sex, age, level }`；
  - `remark`（备注名）权重极高，支持 `query` 模糊匹配 `nickname` 与 `remark`。

---

### 1.2 群聊列表：`get_group_list`
* **调用方式**:
  - Action: `get_group_list`
  - 入参: `{}`
* **实测返回状态**: `status: "ok"`, `retcode: 0`
* **协议返回结构样本（已脱敏）**:
  ```json
  [
    {
      "group_id": 8000000001,
      "group_name": "核心技术交流群",
      "group_remark": "",
      "member_count": 58,
      "max_member_count": 200,
      "group_create_time": 1585055594,
      "group_level": 0,
      "group_memo": "欢迎各位开发者交流，提问前请查阅置顶公告",
      "group_description": "dsh-napcat-bridge 核心开发者交流社区",
      "group_all_shut": 0
    }
  ]
  ```
* **工具层设计考量**:
  - 核心保留字段：`group_id`, `group_name`, `group_remark`, `member_count`, `max_member_count`, `group_memo`, `group_create_time`；
  - 支持 `query` 模糊匹配 `group_name` 与 `group_remark`。

---

### 1.3 用户公开资料卡：`get_stranger_info`
* **调用方式**:
  - Action: `get_stranger_info`
  - 入参: `{ "user_id": 1000000001 }`（支持好友与陌生人通用）
* **实测返回状态**: `status: "ok"`, `retcode: 0`
* **协议返回结构样本（已脱敏）**:
  ```json
  {
    "user_id": 1000000001,
    "uid": "",
    "qid": "mock_alias_1001",
    "nickname": "测试好友A",
    "remark": "张三(财务组)",
    "sex": "male",
    "age": 28,
    "long_nick": "潜心技术，追求卓越",
    "level": 56,
    "qq_level": 56,
    "reg_time": 1104594376,
    "birthday_month": 7,
    "birthday_day": 8,
    "status": 40,
    "ext_status": 0
  }
  ```
* **工具层设计考量**:
  - 核心保留字段：`user_id`, `nickname`, `remark`, `sex`, `age`, `level`, `long_nick`（签名）, `reg_time`（注册时间戳），以及 `qid`。

---

### 1.4 群基础信息：`get_group_info`
* **调用方式**:
  - Action: `get_group_info`
  - 入参: `{ "group_id": 8000000001 }`
* **实测返回状态**: `status: "ok"`, `retcode: 0`
* **协议返回结构样本（已脱敏）**:
  ```json
  {
    "group_id": 8000000001,
    "group_name": "核心技术交流群",
    "group_remark": "",
    "member_count": 58,
    "max_member_count": 200,
    "group_create_time": 1585055594,
    "group_level": 0,
    "group_memo": "欢迎各位开发者交流，提问前请查阅置顶公告",
    "group_description": "dsh-napcat-bridge 核心开发者交流社区",
    "group_all_shut": 0
  }
  ```

---

### 1.5 群公告查询：`_get_group_notice` 踩坑与关键发现 ⚠️

* **重大发现与避坑点**:
  - **`get_group_notice`（标准 Action）**:
    实测返回 `{ status: "failed", retcode: 1404, data: null }`（404 接口不存在）；
  - **`_get_group_notice`（带前导下划线的扩展 Action）**:
    实测返回 `status: "ok", retcode: 0`，返回完整的公告数组！
* **协议返回结构样本（已脱敏）**:
  ```json
  [
    {
      "notice_id": "62972841000000008dfca16a7cb60800",
      "sender_id": 1000000002,
      "publish_time": 1789000845,
      "message": {
        "text": "本周版本发布计划与维护公告...",
        "image": [],
        "images": []
      },
      "settings": {
        "is_show_edit_card": 0,
        "remind_ts": 0,
        "tip_window_type": 0,
        "confirm_required": 0
      },
      "read_num": 11,
      "type": 6,
      "pinned": 0,
      "send_to_new_members": false
    }
  ]
  ```
* **工具层设计考量**:
  - **底层 Action 映射必须使用 `_get_group_notice`**；
  - `message` 字段在 OneBot 返回中为复合对象 `{ text, image, images }`，工具返回给 Agent 时应提炼为直接的纯文本 `content: message.text`，避免大模型混淆。

---

## 2. 大规模好友与群列表的成熟工程架构设计

参考本项目已有的成熟群成员工具（`src/tools/member-info.ts`）设计模式，对 `get_friend_list` 与 `get_group_list` 落地以下四项成熟机制：

1. **TTL 内存缓存池（Memory TTL Cache Pool）**:
   - 默认 5 分钟（`300,000 ms`）缓存，避免频繁向 OneBot 协议端重复发送全量大包拉取请求；
   - 支持参数 `no_cache: true` 主动旁路缓存拉取最新列表；
2. **多维模糊过滤（Fuzzy Query Matching）**:
   - 好友列表：支持对 `nickname` 与 `remark` 统一执行小写模糊子串匹配；
   - 群聊列表：支持对 `group_name` 与 `group_remark` 模糊匹配；
3. **安全分页游标（Pagination Guard）**:
   - 参数：`page`（从 1 开始，默认 1），`limit`（默认 20，最大 50）；
   - 返回标准分页元数据：`total_matched`, `page`, `limit`, `total_pages`, `has_more`；
   - 携带引导性上下文友好提示 `message`（如：`当前展示第 1~20 条（第 1/3 页，共 58 个群）。若需继续浏览，请再次调用并传入 page: 2。`）；
4. **DSH Lossless JSON 严格脱水**:
   - 返回前必须经过 `toLosslessJson` 清洗，杜绝任何 `undefined` 字段。
