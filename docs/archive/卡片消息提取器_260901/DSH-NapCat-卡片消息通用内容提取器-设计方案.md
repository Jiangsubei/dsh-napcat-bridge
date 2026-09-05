# EN-004 卡片消息通用内容提取器 — 调研与设计方案

> **状态**：待用户审查与确认  
> **涉及模块**：`src/gateway/wakeup.ts` (`parseNormalizedContent`)  
> **需求编号**：EN-004 [中] 卡片消息通用内容提取器  

---

## 1. 背景与现状分析

### 1.1 现状痛点
在当前的 `src/gateway/wakeup.ts` 中，`parseNormalizedContent` 处理 `json` 与 `xml` 类型的卡片消息时逻辑较为简陋：
```typescript
case 'json':
case 'xml': {
  let title = data.title;
  if (!title && typeof data.data === 'string') {
    try {
      const parsed = JSON.parse(data.data);
      title =
        parsed.prompt ||
        parsed.meta?.detail_1?.title ||
        parsed.meta?.news?.title ||
        parsed.desc ||
        '卡片消息';
    } catch {
      title = '卡片消息';
    }
  }
  textParts.push(`[卡片消息:${title || '卡片消息'}]`);
  break;
}
```

### 1.2 存在的问题
1. **链接丢失**：未提取卡片携带的原始链接或跳转 URL，Agent 看到 `[卡片消息:标题]` 无法获取真实链接，亦无法调用 `web_extract` 抓取详情；
2. **硬编码路径**：仅检查了 `meta.detail_1` 与 `meta.news`，其他小程序/应用（如 `meta.miniapp`、`meta.music`、`meta.game` 等）无法正确命中；
3. **封面图丢失**：卡片中的封面图 (`preview` / `icon` / `image`) 未进入 `images` 列表，导致多模态模型无法感知卡片封面视觉信息；
4. **XML 卡片完全失效**：XML 卡片直接尝试 `JSON.parse` 必然抛错回退至 `[卡片消息:卡片消息]`。

---

## 2. 真实数据特征与字段优先级规则

### 2.1 真实数据样本结构分析

#### A. Bilibili / 小程序 JSON 卡片 (样本 1)
```json
{
  "app": "com.tencent.miniapp",
  "desc": "",
  "view": "...",
  "prompt": "[分享]哔哩哔哩",
  "meta": {
    "detail_1": {
      "appid": "1109937557",
      "title": "【深度学习】Transformer 从零手写实现",
      "desc": "视频简介内容",
      "preview": "https://i0.hdslb.com/bfs/archive/xxxx.jpg",
      "url": "https://m.q.qq.com/a/s/xxx",
      "qqdocurl": "https://b23.tv/av123456"
    }
  }
}
```
- **关键特征**：`qqdocurl` 是 B站原始短链 (`https://b23.tv/...`)，`url` 是 QQ 小程序中转链 (`https://m.q.qq.com/...`)。必须首选 `qqdocurl`。

#### B. QQ 超级会员 / 服务号小程序 JSON 卡片 (样本 2)
```json
{
  "app": "com.tencent.miniapp",
  "prompt": "[QQ小程序]超级会员",
  "meta": {
    "miniapp": {
      "title": "腾讯视频 VIP 年卡 5 折特惠",
      "desc": "限时特惠，先到先得",
      "preview": "https://imgcache.qq.com/vip/banner.png",
      "jumpUrl": "https://vip.qq.com/act/xxx"
    }
  }
}
```
- **关键特征**：无 `qqdocurl`，链接存储在 `jumpUrl`。

#### C. QQ音乐 / 网易云音乐 JSON 卡片 (样本 3)
```json
{
  "app": "com.tencent.music",
  "prompt": "[QQ音乐] 周杰伦 - 晴天",
  "meta": {
    "music": {
      "title": "晴天",
      "desc": "周杰伦 · 叶惠美",
      "preview": "http://y.gtimg.cn/music/photo_new/xxx.jpg",
      "jumpUrl": "https://i.y.qq.com/v8/playsong.html?songmid=xxx"
    }
  }
}
```

#### D. XML 富媒体卡片 (样本 4)
```xml
<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<msg serviceID="1" templateID="1" action="web" brief="[分享] 晴天" url="https://i.y.qq.com/v8/playsong.html?songmid=xxx">
  <item layout="2">
    <picture cover="http://y.gtimg.cn/music/photo_new/xxx.jpg" />
    <title>晴天</title>
    <summary>周杰伦</summary>
  </item>
</msg>
```

---

### 2.2 核心字段提取优先级规则

无论 JSON 还是 XML 卡片，按以下优先级阶梯提取：

| 维度 | 优先级阶梯 (由高到低) | 描述 |
| :--- | :--- | :--- |
| **链接 (URL)** | `qqdocurl` → `jumpUrl` → `url` → `link` → `targetUrl` → `actionData` | `qqdocurl` 是直链（最高优），`jumpUrl` 次之，`url` 再次之（通常为中转页） |
| **标题 (Title)** | `title` → `prompt` → `desc` → `summary` | 首选明确的标题 `title`；无 `title` 时使用外层或元数据 `prompt`；无 `prompt` 时使用简介 `desc` |
| **封面图 (Cover)** | `preview` → `icon` → `image` → `cover` → `pic` | 提取首选清晰预览图，支持合入 `images` 多模态输入 |

### 2.3 输出格式规范

1. **有标题 + 有链接**：
   ```markdown
   [卡片消息:标题](链接)
   ```
   *示例*：`[卡片消息:[分享] bilibili](https://b23.tv/xxxxx)` 或 `[卡片消息:【深度学习】Transformer](https://b23.tv/av123456)`

2. **有标题 + 无链接**：
   ```markdown
   [卡片消息:标题]
   ```
   *示例*：`[卡片消息:系统维护通知]`

3. **无标题（全缺省）+ 有链接**：
   ```markdown
   [卡片消息:卡片消息](链接)
   ```

4. **无标题 + 无链接**：
   ```markdown
   [卡片消息:卡片消息]
   ```

---

### 2.4 唤醒提示词 (Wakeup Prompt) 包含封面图的渲染示例与备选方案

当收到携带封面图的卡片消息时，发给 Agent 的完整 Wakeup Prompt 的呈现形态有以下备选方案：

#### 【方案 A】（紧凑 Markdown 链接 + payload.images 纯净多模态传入 —— 推荐）：
- **卡片文本**：`[卡片消息:【深度学习】Transformer 从零手写实现](https://b23.tv/av123456)`
- **多模态传递**：封面图 URL 压入 `WakeupPayload.images: ['https://i0.hdslb.com/...']`
- **群聊 @机器人 唤醒 Prompt 示例**：
  ```
  [QQ群聊: 3000000001] [2026-09-01 16:20:00] 发送者: 张三 (QQ: 2000000001)
  @机器人 [卡片消息:【深度学习】Transformer 从零手写实现](https://b23.tv/av123456)
  ```
- **群聊引用卡片回复 Prompt 示例**：
  ```
  [QQ群聊: 3000000001] [2026-09-01 16:20:00] 发送者: 李四 (QQ: 3344556677)
  [引用回复 张三 (QQ: 2000000001): "[卡片消息:【深度学习】Transformer 从零手写实现](https://b23.tv/av123456)"]
  @机器人 帮我总结一下这个视频的核心内容
  ```

#### 【方案 B】（显式文本占位标记 `[封面:URL]`）：
- **卡片文本**：`[卡片消息:【深度学习】Transformer 从零手写实现](https://b23.tv/av123456) [封面:https://i0.hdslb.com/bfs/archive/xxxx.jpg]`
- **群聊 @机器人 唤醒 Prompt 示例**：
  ```
  [QQ群聊: 3000000001] [2026-09-01 16:20:00] 发送者: 张三 (QQ: 2000000001)
  @机器人 [卡片消息:【深度学习】Transformer 从零手写实现](https://b23.tv/av123456) [封面:https://i0.hdslb.com/bfs/archive/xxxx.jpg]
  ```

#### 【方案 C】（Markdown 图片语法）：
- **卡片文本**：`[卡片消息:【深度学习】Transformer 从零手写实现](https://b23.tv/av123456) ![封面](https://i0.hdslb.com/bfs/archive/xxxx.jpg)`
- **群聊 @机器人 唤醒 Prompt 示例**：
  ```
  [QQ群聊: 3000000001] [2026-09-01 16:20:00] 发送者: 张三 (QQ: 2000000001)
  @机器人 [卡片消息:【深度学习】Transformer 从零手写实现](https://b23.tv/av123456) ![封面](https://i0.hdslb.com/bfs/archive/xxxx.jpg)
  ```


---

## 3. 详细设计与代码实现方案

### 3.1 `extractCardContent` 提取算法

在 `src/gateway/wakeup.ts` 中实现通用的卡片提取函数：

```typescript
export interface ExtractedCardInfo {
  text: string;
  title: string;
  link?: string;
  cover?: string;
}

/**
 * 递归搜索对象或数组中的卡片字段
 */
function extractFromJsonCard(rawPayload: unknown): ExtractedCardInfo {
  let parsed: any = rawPayload;
  if (typeof rawPayload === 'string') {
    try {
      parsed = JSON.parse(rawPayload);
    } catch {
      return { text: '[卡片消息:卡片消息]', title: '卡片消息' };
    }
  }

  if (!parsed || typeof parsed !== 'object') {
    return { text: '[卡片消息:卡片消息]', title: '卡片消息' };
  }

  // 收集所有待检索对象：根对象、meta 及其所有子对象/深层嵌套对象
  const candidateObjects: any[] = [];
  const visited = new Set<any>();

  function collectObjects(obj: any, depth = 0) {
    if (!obj || typeof obj !== 'object' || depth > 5 || visited.has(obj)) return;
    visited.add(obj);
    candidateObjects.push(obj);
    if (obj.meta && typeof obj.meta === 'object') {
      collectObjects(obj.meta, depth + 1);
    }
    for (const val of Object.values(obj)) {
      if (val && typeof val === 'object') {
        collectObjects(val, depth + 1);
      }
    }
  }

  collectObjects(parsed);

  // 1. 提取链接 (优先级: qqdocurl -> jumpUrl -> url -> link -> targetUrl -> actionData)
  let link: string | undefined;
  for (const obj of candidateObjects) {
    if (typeof obj.qqdocurl === 'string' && obj.qqdocurl.trim()) {
      link = obj.qqdocurl.trim();
      break;
    }
  }
  if (!link) {
    for (const obj of candidateObjects) {
      if (typeof obj.jumpUrl === 'string' && obj.jumpUrl.trim()) {
        link = obj.jumpUrl.trim();
        break;
      }
    }
  }
  if (!link) {
    for (const obj of candidateObjects) {
      if (typeof obj.url === 'string' && obj.url.trim()) {
        link = obj.url.trim();
        break;
      }
    }
  }
  if (!link) {
    for (const obj of candidateObjects) {
      const otherUrl = obj.link || obj.targetUrl || (typeof obj.actionData === 'string' && obj.actionData.startsWith('http') ? obj.actionData : undefined);
      if (typeof otherUrl === 'string' && otherUrl.trim()) {
        link = otherUrl.trim();
        break;
      }
    }
  }

  // 2. 提取标题 (优先级: title -> prompt -> desc -> summary)
  let title: string | undefined;
  for (const obj of candidateObjects) {
    if (typeof obj.title === 'string' && obj.title.trim()) {
      title = obj.title.trim();
      break;
    }
  }
  if (!title) {
    for (const obj of candidateObjects) {
      if (typeof obj.prompt === 'string' && obj.prompt.trim()) {
        title = obj.prompt.trim();
        break;
      }
    }
  }
  if (!title) {
    for (const obj of candidateObjects) {
      if (typeof obj.desc === 'string' && obj.desc.trim()) {
        title = obj.desc.trim();
        break;
      }
    }
  }
  if (!title) {
    for (const obj of candidateObjects) {
      if (typeof obj.summary === 'string' && obj.summary.trim()) {
        title = obj.summary.trim();
        break;
      }
    }
  }
  const resolvedTitle = title || '卡片消息';

  // 3. 提取封面图 (优先级: preview -> icon -> image -> cover -> pic)
  let cover: string | undefined;
  for (const obj of candidateObjects) {
    const candidateCover = obj.preview || obj.icon || obj.image || obj.cover || obj.pic;
    if (typeof candidateCover === 'string' && candidateCover.trim() && (candidateCover.startsWith('http://') || candidateCover.startsWith('https://') || candidateCover.startsWith('file://'))) {
      cover = candidateCover.trim();
      break;
    }
  }

  // 格式化输出
  const text = link ? `[卡片消息:${resolvedTitle}](${link})` : `[卡片消息:${resolvedTitle}]`;
  return { text, title: resolvedTitle, link, cover };
}
```

### 3.2 XML 卡片正则提取器

```typescript
function unescapeXml(str: string): string {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(Number(dec)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function extractFromXmlCard(xmlContent: string): ExtractedCardInfo {
  if (!xmlContent || typeof xmlContent !== 'string') {
    return { text: '[卡片消息:卡片消息]', title: '卡片消息' };
  }

  // 1. 提取链接 (qqdocurl -> jumpUrl -> url -> actionData)
  let link: string | undefined;
  const qqdocMatch = xmlContent.match(/qqdocurl=["']([^"']+)["']/i);
  const jumpMatch = xmlContent.match(/jumpUrl=["']([^"']+)["']/i);
  const urlMatch = xmlContent.match(/\burl=["']([^"']+)["']/i);
  const actionDataMatch = xmlContent.match(/actionData=["'](https?:\/\/[^"']+)["']/i);

  if (qqdocMatch?.[1]) link = unescapeXml(qqdocMatch[1].trim());
  else if (jumpMatch?.[1]) link = unescapeXml(jumpMatch[1].trim());
  else if (urlMatch?.[1]) link = unescapeXml(urlMatch[1].trim());
  else if (actionDataMatch?.[1]) link = unescapeXml(actionDataMatch[1].trim());

  // 2. 提取标题 (<title> -> brief -> <summary> -> <desc>)
  let title: string | undefined;
  const titleTagMatch = xmlContent.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const briefAttrMatch = xmlContent.match(/brief=["']([^"']+)["']/i);
  const summaryTagMatch = xmlContent.match(/<summary[^>]*>([\s\S]*?)<\/summary>/i);
  const descTagMatch = xmlContent.match(/<desc[^>]*>([\s\S]*?)<\/desc>/i);

  if (titleTagMatch?.[1]) title = unescapeXml(titleTagMatch[1].trim());
  else if (briefAttrMatch?.[1]) title = unescapeXml(briefAttrMatch[1].trim());
  else if (summaryTagMatch?.[1]) title = unescapeXml(summaryTagMatch[1].trim());
  else if (descTagMatch?.[1]) title = unescapeXml(descTagMatch[1].trim());

  const resolvedTitle = title || '卡片消息';

  // 3. 提取封面图 (cover -> preview -> icon)
  let cover: string | undefined;
  const coverMatch = xmlContent.match(/cover=["']([^"']+)["']/i);
  const previewMatch = xmlContent.match(/preview=["']([^"']+)["']/i);
  const iconMatch = xmlContent.match(/icon=["']([^"']+)["']/i);
  if (coverMatch?.[1]) cover = unescapeXml(coverMatch[1].trim());
  else if (previewMatch?.[1]) cover = unescapeXml(previewMatch[1].trim());
  else if (iconMatch?.[1]) cover = unescapeXml(iconMatch[1].trim());

  const text = link ? `[卡片消息:${resolvedTitle}](${link})` : `[卡片消息:${resolvedTitle}]`;
  return { text, title: resolvedTitle, link, cover };
}
```

### 3.3 `parseNormalizedContent` 中的集成接线

在 `src/gateway/wakeup.ts` 的 `parseNormalizedContent` 中：

```typescript
case 'json':
case 'xml': {
  let cardInfo: ExtractedCardInfo;
  if (type === 'json') {
    cardInfo = extractFromJsonCard(data.data ?? data);
  } else {
    cardInfo = extractFromXmlCard(typeof data.data === 'string' ? data.data : (data.xml || data.text || ''));
  }

  // 外部 segment 显式声明的 title (若有) 兜底覆盖保底 title
  if (data.title && (!cardInfo.title || cardInfo.title === '卡片消息')) {
    cardInfo.title = data.title;
    cardInfo.text = cardInfo.link ? `[卡片消息:${data.title}](${cardInfo.link})` : `[卡片消息:${data.title}]`;
  }

  textParts.push(cardInfo.text);
  if (cardInfo.cover && !images.includes(cardInfo.cover)) {
    images.push(cardInfo.cover);
  }
  break;
}
```

---

## 4. 契约测试与验收用例设计 (TDD)

在 `tests/contract/wakeup.test.ts` 中新增/扩展针对卡片消息解析的契约测试套件：

1. **契约 1: Bilibili 小程序卡片（meta.detail_1 结构）**
   - 输入：含 `meta.detail_1.qqdocurl`（B站短链）、`url`（小程序中转）、`title`、`preview`
   - 预期输出：`content` 包含 `[卡片消息:标题](https://b23.tv/xxx)`，`images` 包含 preview 链接。
2. **契约 2: QQ超级会员小程序卡片（meta.miniapp 结构）**
   - 输入：含 `meta.miniapp.jumpUrl`、`title`、`preview`
   - 预期输出：`content` 包含 `[卡片消息:标题](https://vip.qq.com/xxx)`。
3. **契约 3: 仅 prompt 无 title 的分享卡片**
   - 输入：根 `prompt: "[分享] bilibili"`，`meta.detail_1.qqdocurl: "https://b23.tv/abc"`，无 `title`
   - 预期输出：`content` 包含 `[卡片消息:[分享] bilibili](https://b23.tv/abc)`。
4. **契约 4: 无链接纯公告卡片**
   - 输入：含 `title` / `desc`，无任何 url 字段
   - 预期输出：`content` 输出 `[卡片消息:标题]`（不带括号）。
5. **契约 5: XML 音乐分享卡片解析**
   - 输入：XML 字符串包含 `<title>`、`<summary>`、`picture cover`、`url`
   - 预期输出：`content` 包含 `[卡片消息:晴天](https://i.y.qq.com/...)`，`images` 包含封面图。
6. **契约 6: XML 实体反转义与脏数据防护**
   - 输入：XML 包含 `&amp;`, `&quot;`, `&#39;` 以及损坏的 JSON 字符串
   - 预期输出：优雅降级不抛错，特殊字符正确还原。

---

## 5. 影响面与兼容性评估

1. **Agent 抓取能力与对话理解**：
   - 变更后，Agent 可以在对话中感知卡片内的直达 URL，并能主动调用 `web_extract(url)` 工具提取页面内容，解决之前因缺乏 URL 无法分析卡片内容的问题；
2. **多模态感知**：
   - 卡片提取的封面图自动合入 `images`，多模态模型可以直接看到视频/音乐封面图；
3. **既有防骚扰机制不受影响**：
   - 群聊主动概率回复排除规则 `isExcludedFromProactive` 依然通过 `seg.type === 'json' || seg.type === 'xml'` 拦截，不会因内容格式变化产生误触；
4. **数据库与引用恢复**：
   - `content` 格式直接入库 SQLite，后续引用该消息或查询历史记录均可完整展示 Markdown 链接格式。
