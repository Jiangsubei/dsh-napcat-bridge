# 探查记录：QQ 空间 API 真实契约与功能测试

> **测试时间**: 2026-11-04  
> **协议端版本**: SnowLuma v2.4.0-node (OneBot v11)  
> **网关架构**: 反向 WebSocket (连接桥接 127.0.0.1:3001)  
> **隐私保护**: 真实 QQ、昵称与 Token 已统一替换为 Mock 数据（如 `1000000000`, `1000000001`）

---

## 1. 协议端连接与基础能力探查

通过启动轻量级反向 WebSocket 服务端，成功完成与 SnowLuma 协议端的握手与 Bearer Token 认证：
- `get_login_info`: 成功获取登录账号基础信息；
- `get_version_info`: 返回 `app_name: "SnowLuma"`, `app_version: "2.4.0-node"`, `protocol_version: "v11"`。

---

## 2. QQ 空间 Actions 支持性总览

通过向协议端派发缺失参数请求，区分 **1400 (参数缺失，说明 action 存在)** 与 **1404 (unknown action，说明 action 不存在)**，得到确切支持清单：

| Action 名称 | 支持状态 | 状态码与行为 | 核心参数要求 |
| :--- | :---: | :--- | :--- |
| `get_qzone_feeds` | ✅ 支持 | `retcode: 0, status: ok` | `attach_info?: string` |
| `get_qzone_msg_list` | ✅ 支持 | `retcode: 0, status: ok` | `target_uin: number, num?: number, pos?: number` |
| `get_qzone_msg_detail` | ✅ 支持 | `retcode: 0, status: ok` | `tid: string, target_uin?: number` |
| `send_qzone_msg` | ✅ 支持 | `retcode: 1400` (content required) | `content: string, images?: string[]` |
| `delete_qzone_msg` | ✅ 支持 | `retcode: 1400` (tid required) | `tid: string` |
| `comment_qzone` | ✅ 支持 | `retcode: 1400` (tid, content required) | `tid: string, content: string, target_uin?: number` |
| `like_qzone` | ✅ 支持 | `retcode: 1400` (tid required) | `tid: string, target_uin?: number` |
| `unlike_qzone` | ✅ 支持 | `retcode: 1400` (tid required) | `tid: string, target_uin?: number` |
| `edit_qzone_msg` | ❌ 不存在 | `retcode: 1404` (unknown action) | 腾讯 QQ 空间底层不支持编辑已发布说说 |

> **针对用户关注的“编辑与删除”问题结论**：
> 1. **删除自身动态**：**完全支持**，Action 为 `delete_qzone_msg`，入参为 `tid`；
> 2. **编辑自身动态**：**不存在**，底层 QQ 空间业务逻辑本身不允许对已发布的说说做编辑修改（官方 Web/App 端亦只能“删除后重发”）。

---

## 3. 读动态真实响应数据结构

### 3.1 好友动态流 (`get_qzone_feeds`)
```json
{
  "status": "ok",
  "retcode": 0,
  "data": {
    "feeds": [
      {
        "uin": 1000000001,
        "nickname": "测试好友",
        "time": 1793741330,
        "appid": 311,
        "key": "bf5981561352ea6a39890000",
        "tid": "bf5981561352ea6a39890000",
        "content": "动态文字正文...",
        "content_complete": "完整正文...",
        "images": [
          "https://photonjmaz.photo.store.qq.com/psc?/..."
        ],
        "like_count": 0,
        "comment_count": 0,
        "html": "<li class=\"f-single...\" ...>...</li>"
      }
    ],
    "attach_info": "..."
  }
}
```
**关键发现**：协议端已在上游将 `tid`、`content`、`images`、`like_count`、`comment_count` 解析为清晰的结构化字段，无需在下游自行正则提取 HTML！

### 3.2 指定用户动态列表 (`get_qzone_msg_list`)
```json
{
  "status": "ok",
  "retcode": 0,
  "data": {
    "total": 500,
    "msglist": [
      {
        "tid": "bf5981561352ea6a39890000",
        "content": "说说正文内容...",
        "time": 1793741330,
        "comment_num": 0,
        "is_private": false,
        "images": [
          "https://photonjmaz.photo.store.qq.com/psc?/..."
        ]
      }
    ]
  }
}
```
> 注：若查询当前登录号自己且空间尚未发表过说说时，`msglist` 会返回 `null`，桥接需做 `msglist || []` 空值保底。

### 3.3 动态详情与评论 (`get_qzone_msg_detail`)
```json
{
  "status": "ok",
  "retcode": 0,
  "data": {
    "tid": "bf5981561352ea6a39890000",
    "content": "说说正文内容...",
    "comment_num": 0,
    "comments": []
  }
}
```
可进一步获取单条动态的评论列表。

---

## 4. 下一步发动态真实测试报备

根据用户要求，**发测试动态需先向用户报备确认**：
- 测试发动态参数提议：
  - 内容：`"dsh-napcat-bridge 空间互动测试 - " + new Date().toLocaleString()`
  - 附件：暂不带图（纯文本测试）或带 1 张公开测试图
  - 测试完后可立即调用 `delete_qzone_msg` 将其删除，验证“发动态 + 删动态”全流程闭环。
