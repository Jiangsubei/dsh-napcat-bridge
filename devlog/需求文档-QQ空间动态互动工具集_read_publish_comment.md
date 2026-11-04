# 需求文档：QQ 空间动态互动工具集（读动态 · 发说说 · 评动态）

> **项目**: dsh-napcat-bridge  
> **文档版本**: v1.0  
> **状态**: 待用户审阅与决策  
> **相关模块**: `src/tools/`, `src/types/`, `src/gateway/server.ts`, `src/storage/media.ts`

---

## 0. 背景与目标

当前 `dsh-napcat-bridge` 的交互场景主要聚焦在 QQ 单聊与群聊的“即时消息对话”维度。虽然已具备历史记录检索（`read_chat_history`）、文件收发（`send_file`）、表情回应（`react_message`）以及定时任务调度（`scheduler`）等能力，但 Agent 仍缺乏在 **QQ 社交圈（QQ 空间 / QZone）** 中的感知与表达通道：

1. **社交圈感知缺失**：Agent 无法主动获取好友的日常生活动态或分享的照片，在开启话题时无法结合好友近期动态产生共鸣；
2. **主动分享缺位**：Agent 具备定时任务与记忆沉淀能力，但无法将一天的见闻、生成的绘画或总结性思考以“发布动态”的形式对外展示；
3. **互动形式单一**：无法参与好友说说的点赞与评论互动，限制了拟人化好友的人格真实感。

**核心目标**：  
依托 NapCatQQ / SnowLuma 提供的 QQ 空间扩展 Action，设计并落地 **3 个高可用、高契约安全度的 Agent 工具**（读动态、发动态、评动态），并配套完善的多模态图片本地缓存、Token 上下文风控控制与操作频率保护机制。

---

## 1. 协议底座与可行性基线

根据对 NapCatQQ 及 SnowLuma 扩展协议的查证：
- **发布说说**：`send_qzone_msg`（支持正文 `content`、图片列表 `images` 及查看权限）；
- **动态列表与好友流**：`get_qzone_msg_list`（指定用户说说列表，支持分页 `pos`/`num`）与 `get_qzone_home_feeds` / `get_qzone_feeds`（好友动态流）；
- **动态详情与评论**：`get_qzone_msg_detail`；
- **发表评论**：`comment_qzone`（入参需要目标说说归属者 `target_uin`、动态 ID `tid`、内容 `content`）。

**网络架构路径**：  
无需引入外部 Web 爬虫或模拟登录，直接沿用现有 `NapCatGatewayServer` 的 WebSocket / HTTP 客户端连接通道向协议端下发 OneBot Action 并接收结构化响应。

---

## 2. 工具集架构与职责分工

为了确保 LLM 在工具选择和参数填入时的准确率，避免由于多意图合一导致参数混乱或必填校验失效，明确拆分为 **3 个职责单一、Schema 严格定义** 的工具：

```mermaid
flowchart TD
    Agent["DSH Agent 核心"]
    
    subgraph Tools["QQ 空间工具集"]
        T1["read_qzone_feeds<br/>(刷/读动态)"]
        T2["publish_qzone_feed<br/>(发动态/说说)"]
        T3["comment_qzone_feed<br/>(发表说说评论)"]
    end
    
    subgraph Infra["桥接基础设施"]
        MediaMgr["MediaStorageManager<br/>(图片下载缓存至本地)"]
        RateLimiter["QzoneRateLimiter<br/>(风控与操作冷却窗口)"]
        Lossless["toLosslessJson<br/>(DSH 无损 JSON 清洗)"]
        Gateway["NapCatGatewayServer<br/>(OneBot Action 通信)"]
    end
    
    Agent --> T1
    Agent --> T2
    Agent --> T3
    
    T1 --> Gateway
    T1 --> MediaMgr
    T1 --> Lossless
    
    T2 --> RateLimiter
    T2 --> Gateway
    T2 --> Lossless
    
    T3 --> RateLimiter
    T3 --> Gateway
    T3 --> Lossless
```

---

## 3. 工具详细规格设计

### 3.1 工具 1：`read_qzone_feeds`（刷/读动态）

#### 3.1.1 工具定位
只读工具。允许 Agent 查看好友动态流、指定好友的历史动态或自身的历史动态。

#### 3.1.2 输入参数（Params Schema）
```typescript
interface ReadQzoneFeedsParams {
  /**
   * 查看范围
   * - 'friends': 默认值，查看好友动态流（类似于手机 QQ 空间主页）
   * - 'self': 查看机器人/当前登录账号自己发表的历史动态
   * - 'user': 查看指定某个 QQ 好友的历史动态
   */
  scope?: 'friends' | 'self' | 'user';

  /**
   * 目标用户的 QQ 号。当 scope 为 'user' 时必填；为 'friends' 或 'self' 时自动忽略
   * 支持数字或纯数字字符串格式
   */
  target_qq?: string | number;

  /**
   * 获取动态条数。默认 5 条，最小 1 条，最大限制 10 条（严格防止上下文膨胀）
   */
  limit?: number;

  /**
   * 分页偏移量（起始位置），默认为 0。用于连续翻页查看
   */
  offset?: number;
}
```

#### 3.1.3 返回数据（Result Schema）
```typescript
interface QzoneImageItem {
  url: string;             // 远端原始图片 URL
  local_path?: string;     // 本地缓存绝对路径（由 MediaStorageManager 自动下载落盘），便于多模态视觉模型读取
}

interface QzoneCommentItem {
  comment_id: string;      // 评论唯一 ID
  author: {
    user_id: number;       // 评论者 QQ 号
    nickname: string;      // 评论者昵称
  };
  content: string;         // 评论内容
  create_time: string;     // 格式化时间字符串
  is_self: boolean;        // 是否为当前登录 AI 账号自身发表的评论
}

interface QzoneFeedItem {
  feed_id: string;         // 动态唯一 ID (tid)
  author: {
    user_id: number;       // 发布者 QQ 号
    nickname: string;      // 发布者昵称
  };
  publish_time: string;    // 发布时间文本（如 "2026-11-04 10:30:00"）
  content: string;         // 动态正文文本
  images: QzoneImageItem[];// 图片附件列表（若有）
  comments: QzoneCommentItem[]; // 评论区精简摘要（默认前 3~5 条高价值评论）
  total_comment_count: number;  // 该动态总评论数
  like_count?: number;     // 点赞数量（若上游协议提供）
}

interface ReadQzoneFeedsResult {
  success: boolean;
  scope: 'friends' | 'self' | 'user';
  feeds: QzoneFeedItem[];
  has_more: boolean;       // 是否仍有更早的动态
  next_offset?: number;    // 下一页的建议 offset
  message?: string;        // 辅助说明或异常提示
}
```

---

### 3.2 工具 2：`publish_qzone_feed`（发动态/说说）

#### 3.2.1 工具定位
写入工具。允许 Agent 发布带有文字正文与图片附件的 QQ 空间说说。

#### 3.2.2 输入参数（Params Schema）
```typescript
interface PublishQzoneFeedParams {
  /**
   * 动态文字正文（必填）
   */
  content: string;

  /**
   * 图片附件路径或 URL 列表（可选）
   * 支持：
   * 1. 绝对文件路径（如 DSH 沙箱生成图、表情包库绝对路径）
   * 2. HTTP/HTTPS 网络图片 URL
   */
  images?: string[];
}
```

#### 3.2.3 返回数据（Result Schema）
```typescript
interface PublishQzoneFeedResult {
  success: boolean;
  feed_id?: string;        // 发布成功后的动态 ID（tid，若上游协议返回）
  message: string;         // 发布结果描述（例如 "动态发布成功" 或 拦截错误原因）
}
```

---

### 3.3 工具 3：`comment_qzone_feed`（发表说说评论）

#### 3.3.1 工具定位
写入与互动工具。允许 Agent 在指定的说说下方发表评论。

#### 3.3.2 输入参数（Params Schema）
```typescript
interface CommentQzoneFeedParams {
  /**
   * 目标动态唯一 ID (tid，必填)
   */
  feed_id: string;

  /**
   * 目标说说发布者的 QQ 号（必填，底层 QZone 路由协议关键定位参数）
   * 支持数字或纯数字字符串格式
   */
  target_qq: string | number;

  /**
   * 评论文字正文（必填）
   */
  content: string;
}
```

#### 3.3.3 返回数据（Result Schema）
```typescript
interface CommentQzoneFeedResult {
  success: boolean;
  comment_id?: string;     // 评论成功后的 comment ID（若上游协议返回）
  message: string;         // 结果状态说明
}
```

---

## 4. 关键工程联动与系统保障

### 4.1 多模态图片本地化流水线
- **现状机制**：DSH 运行时查看图像多模态输入时，最可靠的形式是本地文件路径；
- **执行逻辑**：
  1. `read_qzone_feeds` 收到协议端返回的包含图片 URL 的说说条目；
  2. 利用 `mediaManager.downloadAndCacheMedia(url, 'image')` 进行异步并发下载并缓存至本地临时目录（默认 10 秒超时保底）；
  3. 成功下载的填充 `local_path`，若下载失败则保留原始 `url`，确保工具即使在网络较慢时也不会卡死。

### 4.2 上下文与 Token 膨胀控制
- **问题**：QQ 空间动态可能包含大量表情符号、长文本与楼中楼评论，一次性拉取过多会严重浪费 Token 并冲垮 Agent 记忆窗口；
- **保护措施**：
  1. `limit` 强制设定硬上限：最高不得超过 10 条，缺省默认 5 条；
  2. 评论区做精简截断：每条说说至多保留最新的 3~5 条评论；
  3. 优先保留 `is_self === true` 的评论，让 Agent 清楚知道自己是否已经回复过该动态，避免重复评论。

### 4.3 腾讯空间风控与速率限制（Rate Limiting）
- **风险分析**：QQ 空间接口的风控严苛程度高于即时消息。高频连续调用 `send_qzone_msg` 或 `comment_qzone` 极易触发腾讯滑块验证码或 `network busy` 封禁；
- **防范策略**：
  1. **发布动态冷却**：同一机器人账号两次发布动态之间强制设置 **冷却时间**（建议默认 60 秒）；
  2. **发表评论冷却**：同一机器人账号发表评论强制设置 **冷却时间**（建议默认 15 秒）；
  3. **冷却未满直接拦截**：若 Agent 短时间内再次发起写操作，工具内部直接返回 `success: false, message: "空间操作过于频繁，处于冷却保护中，请在 X 秒后再试"`，避免请求发送到腾讯端触发风控封禁。

### 4.4 DSH Lossless JSON 输出红线
- 严格贯彻项目 `AGENTS.md` 第 6 条规定：
  - 严禁向 DSH 返回包含 `undefined` 字段的对象；
  - 所有工具在 `execute` 返回前，统一使用 `toLosslessJson()` 递归清洗；
  - 编写契约测试验证字段合法性。

---

## 5. 推进计划与落地里程碑

| 阶段 | 任务目标 | 核心产出物 | 验证手段 |
| :--- | :--- | :--- | :--- |
| **M1: 需求与契约对齐** *(当前)* | 确认工具命名、入参出参及风控规则 | 本需求文档 | 用户确认批准 |
| **M2: 真机接口探查与契约捕获** | 使用实机 NapCat 探测空间 Action 真实入参出参数据结构 | 探查记录落盘 | 运行探查脚本拿到真实 JSON 结构 |
| **M3: 契约测试先行 (TDD)** | 编写针对三工具的 Mock 契约测试与 Lossless JSON 测试 | `test/qzone-tools.spec.ts` | 测试用例呈红状态并验证断言 |
| **M4: 核心逻辑实现与装配** | 实现 `qzone.ts` 工具逻辑、速率限制与图片本地化 | `src/tools/qzone.ts`<br/>`src/tools/index.ts` | 契约测试全部转绿 |
| **M5: 编译构建与真机验收** | 接入运行时、执行 `pnpm build` 并进行实际空间读写验收 | 交付报告与 Git 提交 | 真机刷动态、发说说、发评论验证闭环 |
