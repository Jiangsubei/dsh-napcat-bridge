# 实测报告：NapCat 与 SnowLuma 视频消息底层协议考证

> **实测日期**：2026-11-08  
> **实测环境**：
> - 协议端 A：`NapCat.Onebot v4.18.42`（Node.js Windows 版）
> - 协议端 B：`SnowLuma v2.4.0-node`（Node.js Windows 版）
> - 网关架构：反向 WebSocket（`ws://127.0.0.1:3001` 与 `ws://127.0.0.1:3001/ws`）
> - 目标验证场景：群聊历史消息拉取、视频消息段解析、下载直链连通性测试、`get_file` 与群文件接口交叉验证

---

## 1. 探查背景与目标

当前系统中，入站消息中的视频段会被一律退化为死硬文本 `[视频]`，模型既看不到本地路径，也看不到任何远端资源标识。
本轮实测旨在深入探查 NapCat 与 SnowLuma 两个真实协议端在处理 QQ 视频消息时的底层报文结构与 API 契约，查清：
1. 视频段字段构成（是否存在 `file_id`、`file`、`url`、`file_size`）；
2. 腾讯多媒体 CDN 直链的有效性与 HTTP 下载行为；
3. `get_file`、`get_group_file_url` 等 OneBot 11 动作在视频场景下的真实行为与两端差异；
4. 支撑“群聊不默认下载（拼 ID 供按需拉取）”与“私聊即时落盘（带本地地址）”的可行性与实现路径。

---

## 2. 视频消息段（Video Segment）数据结构实证

在真实群聊（测试 Mock 群 `3000000000`）中拉取历史消息，分别抓取两端的视频段样本：

### 2.1 NapCat 样本
```json
{
  "type": "video",
  "data": {
    "file": "BV1o1HN6YExH-1.mp4",
    "url": "https://multimedia.nt.qq.com.cn/download?appid=1415&format=origin&orgfmt=t264&spec=0&rkey=CAISqAHT7D...",
    "file_size": "1199220"
  }
}
```

### 2.2 SnowLuma 样本
```json
{
  "type": "video",
  "data": {
    "file": "BV1o1HN6YExH-1.mp4",
    "url": "https://multimedia.nt.qq.com.cn/download?appid=1415&format=origin&orgfmt=t264&spec=0&rkey=CAISqAHT7D..."
  }
}
```

### 2.3 段结构分析与共性
1. **标识键名**：两端**均未提供 `file_id` 键名**，核心资源标识统一落在 `data.file` 上，表现为一个带后缀的文件名（如 `BV1o1HN6YExH-1.mp4`、`adad90e6bacb93d30a9f8e575542befc.mp4`、`cb6ec3bad197ce23_lc.mp4`）；
2. **下载直链**：两端均直接携带腾讯官方多媒体 CDN 下载直链 `data.url`（形如 `https://multimedia.nt.qq.com.cn/download?...&rkey=...`）；
3. **大小字段差异**：NapCat 附带 `"file_size": "1199220"` 字符串；SnowLuma 段内不带 `file_size`。

---

## 3. 直链 HTTP 下载行为验证

针对视频段携带的 `data.url` 进行网络连通性与下载测试：
- **`HEAD` 请求**：腾讯 CDN `FrontHttpd` 对 `HEAD` 请求返回 `400 Bad Request`，不支持仅查报头；
- **`GET` 请求**：标准 `GET` 请求（带或不带 UA）**100% 成功返回 `200 OK`**：
  - 响应头包含 `content-type: application/octet-stream`、`content-length: <实际大小>`、`accept-ranges: bytes`；
  - 数据流能稳定拉取到真实的 MP4 二进制分片数据；
  - 即使早前发送的消息，段内直链在数小时内依然保持有效可读。

---

## 4. 核心下载接口契约对比与重大差异

针对视频标识分别调用各个 OneBot 11 动作，实测行为对比如下：

| 接口调用 | 调用入参 | NapCat (v4.18.42) 实测结果 | SnowLuma (v2.4.0-node) 实测结果 | 架构分析与结论 |
|---|---|---|---|---|
| **`get_file`** | `{ file_id: data.file }` | `retcode: 0 (ok)`，返回动态刷新后带有全新有效 `rkey` 的 `url`、`file_name`、`file_size` | ❌ `retcode: 100`<br>`wording: "file_id not found in the image/voice cache. get_file only resolves cached image/voice ids; for group/normal files use get_group_file_url or get_private_file_url"` | ⚠️ **重大断裂差异**：<br>NapCat 支持用 `get_file` 动态换取视频直链；SnowLuma 将 `get_file` 限制在图片与语音缓存，**绝不能单靠 `get_file` 拉取群视频**。 |
| **`get_file`** | `{ file: data.file }` | `retcode: 0 (ok)`，同上 | ❌ `retcode: 100`，同上 | 参数别名行为与上述一致。 |
| **`get_group_file_url`** | `{ group_id, file_id: data.file, busid: 0 }` | ❌ `retcode: 1200`<br>`message: "sendGroupFileDownloadReq error: 文件不存在 (code=-103)"` | ❌ `retcode: 100`<br>`wording: "group file url failed: code=4294966993 msg=参数错误"` | **两端结论一致**：聊天流中的短视频属于普通富媒体消息，不是群文件系统条目，绝不能走群文件接口。 |

---

## 5. 双端兼容落地策略建议

为确保在 NapCat 为基准的同时，平滑兼容 SnowLuma，实现两端 100% 通杀，架构设计必须确立以下铁律：

1. **入站附件事实完整留存（`classify.ts`）**：
   - 提取 `fileId`（来自 `data.file`）的同时，**必须将段内自带的 `data.url` 保存在 `AttachmentRemoteMeta.url` 中**，并通过 `attachments` JSON 列固化入库；
2. **群聊按需拉取（`fetch_chat_resource`）双端策略**：
   - **首选直链通道**：从上下文或数据库记录中取出原始 `remote.url`，直接通过 HTTP GET 流式下载落盘。**NapCat 与 SnowLuma 均原生支持，零 API 往返与协议差异**；
   - **回退刷新通道**：若直链超时失效（HTTP 4xx），回退调用 `gateway.getFile(fileId)` 动态刷新。在 NapCat 下可成功获取最新有效直链；若在 SnowLuma 下返回错误，则提供友好提示垫片；
   - **群聊无 busid 放行**：在群聊上下文中，若资源为视频或普通媒体流（无 `busid`），不再强行拦截报错，而是放行至上述直链/`get_file` 下载流水线。
3. **私聊即时落盘**：
   - 入站拦截 `type === 'video'`，优先提取段内 `data.url` 执行落盘并记录 `local_path`，渲染为 `[视频 已保存: <local_path>]`。
