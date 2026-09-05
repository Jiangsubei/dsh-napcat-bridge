# NapCat (OneBot 11) 实机协议字段采样与分析纪要

> **采样时间**：2026-08-30
> **测试环境**：NapCat.Onebot `v4.18.19` (OneBot 11 反向 WebSocket)
> **采样来源**：`logs/probe/events.jsonl` (共捕获 94 帧完整事件)

---

## 1. 运行时与元事件采样 (Meta Events)

### 1.1 `get_version_info` 响应
```json
{
  "status": "ok",
  "retcode": 0,
  "data": {
    "app_name": "NapCat.Onebot",
    "protocol_version": "v11",
    "app_version": "4.18.19"
  },
  "echo": "probe_get_version_info"
}
```

### 1.2 `lifecycle:connect` 连接生命周期
```json
{
  "time": 1788045501,
  "self_id": 1000000001,
  "post_type": "meta_event",
  "meta_event_type": "lifecycle",
  "sub_type": "connect"
}
```

### 1.3 `heartbeat` 心跳事件
```json
{
  "time": 1788045506,
  "self_id": 1000000001,
  "post_type": "meta_event",
  "meta_event_type": "heartbeat",
  "status": {
    "online": true,
    "good": true
  },
  "interval": 5000
}
```

---

## 2. 消息事件采样 (Message Events)

### 2.1 私聊普通文本与 Emoji 消息
```json
{
  "self_id": 1000000001,
  "user_id": 2000000001,
  "time": 1788045610,
  "message_id": 1269389279,
  "message_seq": 1269389279,
  "real_id": 1269389279,
  "real_seq": "2917",
  "message_type": "private",
  "sender": {
    "user_id": 2000000001,
    "nickname": "UserB",
    "card": ""
  },
  "raw_message": "😏",
  "font": 14,
  "sub_type": "friend",
  "message": [
    {
      "type": "text",
      "data": {
        "text": "😏"
      }
    }
  ],
  "message_format": "array",
  "post_type": "message",
  "target_id": 2000000001
}
```

### 2.2 私聊小表情 (`face`)
```json
{
  "self_id": 1000000001,
  "user_id": 2000000001,
  "time": 1788045612,
  "message_id": 1690022359,
  "message_type": "private",
  "raw_message": "[CQ:face,id=317,raw={\"faceIndex\":317,\"faceText\":\"/菜汪\",\"faceType\":2}]",
  "message": [
    {
      "type": "face",
      "data": {
        "id": "317",
        "raw": {
          "faceIndex": 317,
          "faceText": "/菜汪",
          "faceType": 2
        }
      }
    }
  ],
  "post_type": "message"
}
```
> **确证结论**：`face` 段包含 `raw.faceText`（如 `"/菜汪"`），归一化文本优先使用 `[表情:/菜汪]`，缺失时回退为 `[表情:id=317]`。

### 2.3 私聊文件接收 (`file`)
```json
{
  "self_id": 1000000001,
  "user_id": 2000000001,
  "time": 1788045543,
  "message_id": 1335048259,
  "message_type": "private",
  "raw_message": "[CQ:file,file=illust_114794209_20240214_171138.png,file_id=14b3f38ff95b09df4de35ea1c783c368_06f8652c-a400-11f1-abd1-a97b01efb58e,file_size=317798]",
  "message": [
    {
      "type": "file",
      "data": {
        "file": "illust_114794209_20240214_171138.png",
        "file_id": "14b3f38ff95b09df4de35ea1c783c368_06f8652c-a400-11f1-abd1-a97b01efb58e",
        "file_size": "317798"
      }
    }
  ],
  "post_type": "message"
}
```
> **确证结论**：私聊文件直接携带 `file`（文件名）、`file_id`（稳定唯一 ID）、`file_size`。

### 2.4 群聊 @机器人 与多段图文拼接 (`at` + `image` + `text`)
```json
{
  "self_id": 1000000001,
  "user_id": 2000000001,
  "time": 1788045798,
  "message_id": 2145501030,
  "message_seq": 2145501030,
  "message_type": "group",
  "group_id": 3000000001,
  "group_name": "🌳🏠温馨树洞小屋🎉加油鸭",
  "sender": {
    "user_id": 2000000001,
    "nickname": "UserB",
    "card": "你醒了？你被基米单杀了",
    "role": "admin"
  },
  "raw_message": "[CQ:at,qq=1000000001] [CQ:image,file=C488F376DFD7D5FAE2EBB3638690DD35.png,sub_type=0,url=https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=...,file_size=537309] 拼接消息测试",
  "message": [
    {
      "type": "at",
      "data": {
        "qq": "1000000001"
      }
    },
    {
      "type": "text",
      "data": {
        "text": " "
      }
    },
    {
      "type": "image",
      "data": {
        "summary": "",
        "file": "C488F376DFD7D5FAE2EBB3638690DD35.png",
        "sub_type": 0,
        "url": "https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=...",
        "file_size": "537309"
      }
    },
    {
      "type": "text",
      "data": {
        "text": " 拼接消息测试"
      }
    }
  ],
  "post_type": "message"
}
```
> **确证结论**：
> - `at.data.qq` 为目标 QQ 字符串；
> - `image.data.url` 包含即时下载链接，`sub_type: 0` 为普通图片；
> - 多段消息按数组顺序排列，归一化 `content` 时须按顺序拼接。

### 2.5 群聊引用回复 (`reply` + `text`)
```json
{
  "self_id": 1000000001,
  "user_id": 2000000001,
  "time": 1788045814,
  "message_id": 2121574238,
  "message_type": "group",
  "group_id": 3000000001,
  "raw_message": "[CQ:reply,id=1262440370]1111",
  "message": [
    {
      "type": "reply",
      "data": {
        "id": "1262440370"
      }
    },
    {
      "type": "text",
      "data": {
        "text": "1111"
      }
    }
  ],
  "post_type": "message"
}
```
> **确证结论**：`reply.data.id` 为被回复消息的 `message_id`（对应前序消息 `1262440370`）。

### 2.6 合并转发消息 (`forward`)
```json
{
  "self_id": 1000000001,
  "user_id": 2000000001,
  "time": 1788045642,
  "message_id": 1414436573,
  "message_type": "private",
  "raw_message": "[CQ:forward,id=7679597626675748215]",
  "message": [
    {
      "type": "forward",
      "data": {
        "id": "7679597626675748215"
      }
    }
  ],
  "post_type": "message"
}
```

---

## 3. 通知事件采样 (Notice Events)

### 3.1 戳一戳通知 (`notify:poke`)
```json
{
  "time": 1788045714,
  "self_id": 1000000001,
  "post_type": "notice",
  "notice_type": "notify",
  "sub_type": "poke",
  "target_id": 1000000001,
  "user_id": 2000000001,
  "sender_id": 2000000001
}
```
> **确证结论**：
> - `target_id` 为被戳对象，`user_id` / `sender_id` 为发起人；
> - 私聊戳一戳无 `group_id`，群聊戳一戳包含 `group_id`。

### 3.2 消息撤回通知 (`group_recall`)
```json
{
  "time": 1788045829,
  "self_id": 1000000001,
  "post_type": "notice",
  "group_id": 3000000001,
  "user_id": 2000000001,
  "notice_type": "group_recall",
  "operator_id": 2000000001,
  "message_id": 2121574238
}
```
> **确证结论**：`message_id` 指向被撤回的消息，`operator_id` 为操作者 QQ 号。

---

## 4. 关键规范核对与结论

1. **时间戳精度**：NapCat 上报的 `event.time` 均为 10 位 UNIX 时间戳（秒级）。插件入库时统一转换为毫秒 `event.time * 1000`，保持与 JS `Date.now()` 一致。
2. **标识符类型**：`user_id`、`group_id`、`self_id` 在 JSON 中为 Number 类型，但在 CQ 码及部分段中为 String。插件层统一包装 `String(...)` 进行标识符比对与路由。
3. **表情包与普通图片判别**：`sub_type === 1` 或包含 `emoji_package_id` 时落盘至 `sticker/` 目录；`sub_type === 0` 或缺省时落盘至 `image/` 目录。
4. **与 Spec v1.0 契约 100% 契合**：本次实机采样捕获的所有字段与已定稿的 Spec 完全吻合，无任何破损或未预料结构。
