/**
 * dsh-napcat-bridge: 富媒体卡片解析模块
 * 专职 XML/JSON 富媒体卡片解析、字段提取与 URL/协议规范化。
 */

export interface ExtractedCardInfo {
  text: string;
  title: string;
  link?: string;
  cover?: string;
}

export function unescapeXml(str: string): string {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(Number(dec)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

/**
 * 归一化卡片链接与封面 URL：
 * 1. 还原转义斜杠 \/ -> /
 * 2. 补全 // 开头的协议相对路径 -> https://...
 * 3. 自动为 m.q.qq.com/xxx 或 b23.tv/xxx 等裸域名补全 https:// 协议头
 */
export function normalizeUrl(url?: string): string | undefined {
  if (!url || typeof url !== 'string') return undefined;
  const trimmed = url.trim().replace(/\\\//g, '/');
  if (!trimmed) return undefined;
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://') || trimmed.startsWith('file://')) {
    return trimmed;
  }
  if (trimmed.startsWith('//')) {
    return `https:${trimmed}`;
  }
  // 匹配类似 m.q.qq.com/xxx 或 b23.tv/xxx 的裸域名结构
  if (/^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}(\/.*)?$/.test(trimmed)) {
    return `https://${trimmed}`;
  }
  return trimmed;
}

export function extractFromJsonCard(rawPayload: unknown): ExtractedCardInfo {
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

  const metaObjects: any[] = [];
  const otherObjects: any[] = [];
  const visited = new Set<any>();

  function collectObjects(obj: any, isMetaChild = false, depth = 0) {
    if (!obj || typeof obj !== 'object' || depth > 6 || visited.has(obj)) return;
    visited.add(obj);

    if (isMetaChild) {
      metaObjects.push(obj);
    } else if (obj !== parsed) {
      otherObjects.push(obj);
    }

    if (obj.meta && typeof obj.meta === 'object') {
      if (Array.isArray(obj.meta)) {
        for (const item of obj.meta) {
          collectObjects(item, true, depth + 1);
        }
      } else {
        for (const val of Object.values(obj.meta)) {
          collectObjects(val, true, depth + 1);
        }
      }
    }

    for (const [k, val] of Object.entries(obj)) {
      if (k !== 'meta' && val && typeof val === 'object') {
        collectObjects(val, isMetaChild, depth + 1);
      }
    }
  }

  collectObjects(parsed);
  // 优先级顺序：meta 子对象 -> 其他嵌套对象 -> 根对象
  const candidateObjects = [...metaObjects, ...otherObjects, parsed];

  // 1. 提取链接 (优先级: qqdocurl -> jumpUrl -> url -> link/targetUrl/actionData)
  let rawLink: string | undefined;
  for (const obj of candidateObjects) {
    if (typeof obj.qqdocurl === 'string' && obj.qqdocurl.trim()) {
      rawLink = obj.qqdocurl.trim();
      break;
    }
  }
  if (!rawLink) {
    for (const obj of candidateObjects) {
      if (typeof obj.jumpUrl === 'string' && obj.jumpUrl.trim()) {
        rawLink = obj.jumpUrl.trim();
        break;
      }
    }
  }
  if (!rawLink) {
    for (const obj of candidateObjects) {
      if (typeof obj.url === 'string' && obj.url.trim()) {
        rawLink = obj.url.trim();
        break;
      }
    }
  }
  if (!rawLink) {
    for (const obj of candidateObjects) {
      const otherUrl =
        obj.link ||
        obj.targetUrl ||
        (typeof obj.actionData === 'string' && (obj.actionData.startsWith('http') || obj.actionData.startsWith('//'))
          ? obj.actionData
          : undefined);
      if (typeof otherUrl === 'string' && otherUrl.trim()) {
        rawLink = otherUrl.trim();
        break;
      }
    }
  }
  const link = normalizeUrl(rawLink);

  // 2. 提取标题 (针对小程序 app 与 desc 结构进行智能适配)
  // 很多小程序卡片 meta.detail_1.title 为纯应用名 (如 "哔哩哔哩", "QQ经典农场")，而真实标题在 desc 且被包裹在 prompt 中
  let metaTitle: string | undefined;
  let metaDesc: string | undefined;
  for (const obj of candidateObjects) {
    if (!metaTitle && typeof obj.title === 'string' && obj.title.trim()) {
      metaTitle = obj.title.trim();
    }
    if (!metaDesc && typeof obj.desc === 'string' && obj.desc.trim()) {
      metaDesc = obj.desc.trim();
    }
  }

  const promptText = typeof parsed.prompt === 'string' ? parsed.prompt.trim() : undefined;

  let title: string | undefined;
  if (metaTitle && promptText && metaDesc && promptText.includes(metaDesc) && !promptText.includes(metaTitle)) {
    // 命中 B站/农场 等小程序卡片：prompt 携带了真实标题 (如 "[QQ小程序]我讨厌黑色...")，而 metaTitle 仅为 "哔哩哔哩"
    title = promptText;
  } else {
    title = metaTitle || promptText || metaDesc;
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
  let rawCover: string | undefined;
  for (const obj of candidateObjects) {
    const candidateCover =
      obj.preview || obj.icon || obj.image || obj.cover || obj.pic;
    if (typeof candidateCover === 'string' && candidateCover.trim()) {
      rawCover = candidateCover.trim();
      break;
    }
  }
  const cover = normalizeUrl(rawCover);

  const baseText = link
    ? `[卡片消息:${resolvedTitle}](${link})`
    : `[卡片消息:${resolvedTitle}]`;
  const text = cover ? `${baseText} [封面:${cover}]` : baseText;

  return { text, title: resolvedTitle, link, cover };
}

export function extractFromXmlCard(xmlContent: string): ExtractedCardInfo {
  if (!xmlContent || typeof xmlContent !== 'string') {
    return { text: '[卡片消息:卡片消息]', title: '卡片消息' };
  }

  // 1. 提取链接 (qqdocurl -> jumpUrl -> url -> actionData)
  let rawLink: string | undefined;
  const qqdocMatch = xmlContent.match(/qqdocurl=["']([^"']+)["']/i);
  const jumpMatch = xmlContent.match(/jumpUrl=["']([^"']+)["']/i);
  const urlMatch = xmlContent.match(/\burl=["']([^"']+)["']/i);
  const actionDataMatch = xmlContent.match(/actionData=["'](https?:\/\/[^"']+)["']/i);

  if (qqdocMatch?.[1]) rawLink = unescapeXml(qqdocMatch[1].trim());
  else if (jumpMatch?.[1]) rawLink = unescapeXml(jumpMatch[1].trim());
  else if (urlMatch?.[1]) rawLink = unescapeXml(urlMatch[1].trim());
  else if (actionDataMatch?.[1]) rawLink = unescapeXml(actionDataMatch[1].trim());

  const link = normalizeUrl(rawLink);

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

  // 3. 提取封面图 (cover -> preview -> icon -> src)
  let rawCover: string | undefined;
  const coverMatch = xmlContent.match(/cover=["']([^"']+)["']/i);
  const previewMatch = xmlContent.match(/preview=["']([^"']+)["']/i);
  const iconMatch = xmlContent.match(/icon=["']([^"']+)["']/i);
  const srcMatch = xmlContent.match(/\bsrc=["']([^"']+)["']/i);

  if (coverMatch?.[1]) rawCover = unescapeXml(coverMatch[1].trim());
  else if (previewMatch?.[1]) rawCover = unescapeXml(previewMatch[1].trim());
  else if (iconMatch?.[1]) rawCover = unescapeXml(iconMatch[1].trim());
  else if (srcMatch?.[1]) rawCover = unescapeXml(srcMatch[1].trim());

  const cover = normalizeUrl(rawCover);

  const baseText = link
    ? `[卡片消息:${resolvedTitle}](${link})`
    : `[卡片消息:${resolvedTitle}]`;
  const text = cover ? `${baseText} [封面:${cover}]` : baseText;

  return { text, title: resolvedTitle, link, cover };
}

export function extractCardContent(
  data: any,
  type: 'json' | 'xml' | 'share' | 'lightapp'
): ExtractedCardInfo {
  if (type === 'share' || type === 'lightapp') {
    const rawLink = data?.url || data?.jumpUrl || data?.link;
    const link = normalizeUrl(rawLink);
    const rawCover = data?.image || data?.preview || data?.icon || data?.cover;
    const cover = normalizeUrl(rawCover);
    const title = data?.title || data?.content || (type === 'share' ? '分享卡片' : '小程序卡片');
    const baseText = link ? `[卡片消息:${title}](${link})` : `[卡片消息:${title}]`;
    const text = cover ? `${baseText} [封面:${cover}]` : baseText;
    return { text, title, link, cover };
  }

  let cardInfo: ExtractedCardInfo;
  if (type === 'json') {
    cardInfo = extractFromJsonCard(data?.data ?? data);
  } else {
    cardInfo = extractFromXmlCard(
      typeof data?.data === 'string'
        ? data.data
        : typeof data === 'string'
          ? data
          : data?.xml || data?.text || ''
    );
  }

  // 若段外层明确带了 data.title 且解析未命中明确 title，则允许外层 title 兜底
  if (data?.title && (!cardInfo.title || cardInfo.title === '卡片消息')) {
    cardInfo.title = data.title;
    const baseText = cardInfo.link
      ? `[卡片消息:${data.title}](${cardInfo.link})`
      : `[卡片消息:${data.title}]`;
    cardInfo.text = cardInfo.cover ? `${baseText} [封面:${cardInfo.cover}]` : baseText;
  }

  return cardInfo;
}
