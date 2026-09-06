/**
 * dsh-napcat-bridge: 唤醒门控模块
 * 实现 OneBot 11 入方向消息与通知事件的唤醒条件判定与唤醒包组装。
 * （阶段 2 将具体实现业务逻辑）
 */

import type {
  BridgePluginConfig,
  OneBotMessageEvent,
  OneBotNoticeEvent,
  WakeupPayload,
  WakeupTriggerType,
} from '../types/index.js';
import type { ProactiveManager } from './proactive.js';

export interface WakeupOptions {
  bot_qq: string;
  bot_nickname?: string;
  aliases?: string[];
  isQuotingBot?: (replyMsgId: number) => Promise<boolean>;
  getQuotedMessage?: (replyMsgId: number) => Promise<{
    user_id: string;
    sender_name?: string;
    content: string;
    self?: number;
    images?: string[];
  } | null | undefined>;
  /** EN-001: 被@者昵称解析器（NapCat at 段只有 qq，昵称经 get_group_member_info 获取） */
  resolveNickname?: (groupId: number | string, qq: string) => Promise<string | undefined>;
  /** 主动回复插件配置 */
  proactive?: BridgePluginConfig;
  /** 主动回复管理器实例 */
  proactiveManager?: ProactiveManager;
}

export interface WakeupDecision {
  wakeup: boolean;
  trigger?: WakeupTriggerType | 'direct';
  payload?: WakeupPayload;
}

/**
 * EN-001: 把 at 段归一化文本中的裸 @QQ号 替换为 @昵称(QQ号)。
 * - 仅替换由 at 段产生的 "@<qq>" 字面（纯文本手敲的 "@昵称" 不含数字，保持原样）；
 * - 同一 qq 去重，一次解析多次替换；
 * - 解析器缺失/失败/查无昵称时保持裸 @QQ号，绝不中断或抛错。
 */
export async function resolveAtNicknames(
  content: string,
  atQQs: string[],
  groupId: number | string | undefined,
  resolveNickname?: (groupId: number | string, qq: string) => Promise<string | undefined>
): Promise<string> {
  if (!resolveNickname || !Array.isArray(atQQs) || atQQs.length === 0 || groupId === undefined) {
    return content;
  }
  let out = content;
  for (const qq of new Set(atQQs)) {
    try {
      const nickname = await resolveNickname(groupId, qq);
      if (nickname && nickname.trim() !== '') {
        out = out.split(`@${qq}`).join(`@${nickname.trim()}(${qq})`);
      }
    } catch {
      // 单次解析失败回退裸 @QQ号
    }
  }
  return out;
}

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

export function parseNormalizedContent(event: OneBotMessageEvent): {
  content: string;
  images: string[];
  replyId?: number;
  atQQs: string[];
} {
  const images: string[] = [];
  const atQQs: string[] = [];
  let replyId: number | undefined;

  if (Array.isArray(event.message) && event.message.length > 0) {
    const textParts: string[] = [];

    for (const seg of event.message) {
      if (!seg || typeof seg !== 'object') continue;
      const type = seg.type;
      const data = seg.data || {};

      switch (type) {
        case 'text':
          if (data.text) textParts.push(data.text);
          break;

        case 'at':
          if (data.qq !== undefined) {
            atQQs.push(String(data.qq));
            textParts.push(`@${data.qq}`);
          }
          break;

        case 'reply':
          if (data.id !== undefined) {
            replyId = Number(data.id);
          }
          break;

        case 'face':
          if (data.raw && data.raw.faceText) {
            textParts.push(`[表情:${data.raw.faceText}]`);
          } else if (data.id !== undefined) {
            textParts.push(`[表情:id=${data.id}]`);
          } else {
            textParts.push('[表情]');
          }
          break;

        case 'image': {
          const imgPath = data.local_path || data.file || data.url || '';
          if (imgPath) images.push(imgPath);
          if (data.sub_type === 1 || data.emoji_package_id) {
            if (data.local_path) {
              textParts.push(`[表情包:${data.summary || '表情'} 已保存: ${data.local_path}]`);
            } else {
              textParts.push(data.summary ? `[表情包:${data.summary}]` : `[表情包:${imgPath}]`);
            }
          } else {
            textParts.push(`[图片:${imgPath}]`);
          }
          break;
        }

        case 'file': {
          const fileName = data.file || data.file_name || data.file_id || '未知文件';
          const fileId = data.file_id ? ` (ID:${data.file_id})` : '';
          if ((event as any).message_type === 'group') {
            textParts.push(`[群文件:${fileName}${fileId}]`);
          } else if (data.local_path) {
            // PF-001: 私聊文件落盘成功 → 占位替换为真实路径（与图片 atomic 约定统一，任务包 §3.3）
            textParts.push(`[文件:${fileName} 已保存: ${data.local_path}]`);
          } else if (data.dl_failed) {
            // PF-001: 双失败 → 如实标注入站落盘失败（绝不返回占位假路径，任务包 §3.1）
            textParts.push(`[文件:${fileName} (入站落盘失败)]`);
          } else {
            textParts.push(`[文件:${fileName}]`);
          }
          break;
        }

        case 'forward':
          textParts.push(`[合并转发 (ID:${data.id || data.forward_id || ''})]`);
          break;

        case 'record':
          textParts.push('[语音]');
          break;

        case 'video':
          textParts.push('[视频]');
          break;

        case 'shake':
          textParts.push('[窗口抖动]');
          break;

        case 'poke':
          textParts.push('[戳一戳]');
          break;

        case 'json':
        case 'xml': {
          const card = extractCardContent(data, type);
          textParts.push(card.text);
          if (card.cover && !images.includes(card.cover)) {
            images.push(card.cover);
          }
          break;
        }

        case 'rps':
          textParts.push('[猜拳]');
          break;

        case 'dice':
          textParts.push('[骰子]');
          break;

        case 'lightapp':
        case 'share':
          textParts.push(data.title ? `[分享:${data.title}]` : '[分享卡片]');
          break;

        case 'music':
          textParts.push('[音乐分享]');
          break;

        case 'location':
          textParts.push(data.title ? `[位置:${data.title}]` : '[位置]');
          break;

        case 'contact':
          textParts.push('[联系人推荐]');
          break;

        case 'anonymous':
          textParts.push('[匿名消息]');
          break;

        default:
          if (data.text) {
            textParts.push(data.text);
          } else {
            // Spec v1.0 未列出的消息段类型：保留占位，防止静默丢段
            textParts.push(`[未知消息段:${type}]`);
          }
          break;
      }
    }

    return {
      content: textParts.join(''),
      images,
      replyId,
      atQQs,
    };
  }

  // Fallback to raw_message parsing if segments are not available
  const raw = event.raw_message || '';
  const atMatch = raw.match(/\[CQ:at,qq=(\d+)\]/g);
  if (atMatch) {
    for (const match of atMatch) {
      const qq = match.replace(/\[CQ:at,qq=(\d+)\]/, '$1');
      atQQs.push(qq);
    }
  }

  const replyMatch = raw.match(/\[CQ:reply,id=(\d+)\]/);
  if (replyMatch) {
    replyId = Number(replyMatch[1]);
  }

  return {
    content: raw,
    images,
    replyId,
    atQQs,
  };
}

/**
 * 判定群聊普通消息是否应排除主动概率唤醒。
 * 排除规则：
 * 1. 纯单个表情（纯 face、纯 mface/marketface、纯单个 sticker 表情包且无实质文字）；
 * 2. 包含视频 (video)；
 * 3. 包含语音 (record)；
 * 4. 结构化卡片或小组件 (json, xml, share, lightapp, music, location, contact, rps, dice)。
 * 注意：合并转发 (forward)、普通图片 (image)、文字+表情、图文混排、群文件等正常允许主动回复。
 */
export function isExcludedFromProactive(
  event: OneBotMessageEvent,
  onlyText = false
): boolean {
  const segments = Array.isArray(event.message) ? event.message : [];

  if (segments.length > 0) {
    // 0. 仅回复文本内容模式：任何含非文本段的消息一律排除（不主动回复）
    if (onlyText) {
      const hasNonTextSegment = segments.some(
        (seg) => seg && !['text', 'at', 'reply'].includes(seg.type)
      );
      if (hasNonTextSegment) return true;
    }

    // 1. 包含视频或语音
    const hasVideoOrRecord = segments.some(
      (seg) => seg && (seg.type === 'video' || seg.type === 'record')
    );
    if (hasVideoOrRecord) return true;

    // 2. 包含结构化卡片或互动小组件 (注意: forward 合并转发允许主动回复)
    const hasExcludedCard = segments.some(
      (seg) =>
        seg &&
        [
          'json',
          'xml',
          'share',
          'lightapp',
          'music',
          'location',
          'contact',
          'rps',
          'dice',
        ].includes(seg.type)
    );
    if (hasExcludedCard) return true;

    // 3. 纯单个表情判断（仅有表情且无实际文本与其他媒体）
    let totalText = '';
    const emojiSegs: any[] = [];
    const otherMediaSegs: any[] = [];

    for (const seg of segments) {
      if (!seg) continue;
      if (seg.type === 'text') {
        totalText += seg.data?.text || '';
      } else if (
        seg.type === 'face' ||
        seg.type === 'mface' ||
        seg.type === 'marketface' ||
        (seg.type === 'image' && (seg.data?.sub_type === 1 || seg.data?.emoji_package_id || seg.data?.emoji_id))
      ) {
        emojiSegs.push(seg);
      } else {
        otherMediaSegs.push(seg);
      }
    }

    if (totalText.trim().length === 0 && otherMediaSegs.length === 0 && emojiSegs.length > 0) {
      return true;
    }

    return false;
  }

  // 兜底基于 raw_message 的快速正则过滤
  const raw = (event.raw_message || '').trim();

  // 仅回复文本内容模式：raw_message 包含多模态 CQ 码一律排除
  if (onlyText) {
    if (
      raw.includes('[CQ:image') ||
      raw.includes('[CQ:face') ||
      raw.includes('[CQ:mface') ||
      raw.includes('[CQ:marketface') ||
      raw.includes('[CQ:file') ||
      raw.includes('[CQ:video') ||
      raw.includes('[CQ:record') ||
      /\[CQ:(?!at\b|reply\b)[^,\]]+/.test(raw)
    ) {
      return true;
    }
  }

  if (raw.includes('[CQ:video') || raw.includes('[CQ:record')) return true;
  if (
    raw.includes('[CQ:json') ||
    raw.includes('[CQ:xml') ||
    raw.includes('[CQ:share') ||
    raw.includes('[CQ:lightapp') ||
    raw.includes('[CQ:music') ||
    raw.includes('[CQ:location') ||
    raw.includes('[CQ:contact') ||
    raw.includes('[CQ:rps') ||
    raw.includes('[CQ:dice')
  ) {
    return true;
  }
  if (/^\[CQ:face,id=\d+\]$/.test(raw) || /^\[CQ:mface,[^\]]+\]$/.test(raw)) {
    return true;
  }

  return false;
}

export async function shouldWakeup(
  event: OneBotMessageEvent | OneBotNoticeEvent,
  options: WakeupOptions
): Promise<WakeupDecision> {
  const botQQ = String(options.bot_qq || '');

  // 1. 自循环防护: 过滤自身发出的消息或由 bot_qq 发出的事件
  if (event.post_type === 'message_sent') {
    return { wakeup: false };
  }

  const eventUserId = 'user_id' in event && event.user_id !== undefined ? String(event.user_id) : '';
  const senderUserId = 'sender' in event && event.sender?.user_id !== undefined ? String(event.sender.user_id) : '';

  if (botQQ && (eventUserId === botQQ || senderUserId === botQQ)) {
    return { wakeup: false };
  }

  const timestamp = event.time
    ? event.time < 10000000000
      ? event.time * 1000
      : event.time
    : Date.now();

  // 2. Notice 事件判定 (如 poke 戳一戳)
  if (event.post_type === 'notice') {
    const notice = event as OneBotNoticeEvent;
    if (notice.notice_type === 'notify' && notice.sub_type === 'poke') {
      const targetId = notice.target_id !== undefined ? String(notice.target_id) : '';
      if (botQQ && targetId === botQQ) {
        const fromUser = String(notice.user_id ?? notice.sender_id ?? '');
        const isGroup = Boolean(notice.group_id);
        const peer = isGroup ? `group_${notice.group_id}` : `user_${fromUser}`;
        let fromName = '';
        if (isGroup && notice.group_id && typeof options.resolveNickname === 'function') {
          try {
            fromName = (await options.resolveNickname(notice.group_id, fromUser)) || '';
          } catch {}
        }
        const payload: WakeupPayload = {
          trigger: 'poke',
          peer,
          from_user: fromUser,
          from_name: fromName,
          content: '[戳一戳]',
          timestamp,
        };
        return {
          wakeup: true,
          trigger: 'poke',
          payload,
        };
      }
    }
    return { wakeup: false };
  }

  // 3. Message 事件判定
  const msgEvent = event as OneBotMessageEvent;
  const fromUser = String(msgEvent.sender?.user_id ?? msgEvent.user_id ?? '');
  let fromName = msgEvent.sender?.card || msgEvent.sender?.nickname || '';
  const isGroup = msgEvent.message_type === 'group';
  const groupId = msgEvent.group_id;
  const peer = isGroup ? `group_${msgEvent.group_id}` : `user_${fromUser}`;

  // 若群聊消息中发送者昵称为空，尝试调用 resolveNickname 兜底拉取群名片/昵称
  if (isGroup && !fromName && groupId !== undefined && typeof options.resolveNickname === 'function') {
    try {
      fromName = (await options.resolveNickname(groupId, fromUser)) || '';
    } catch {}
  }

  const { content: rawContent, images, replyId, atQQs } = parseNormalizedContent(msgEvent);

  // 若消息完全无字符（长度为 0）且无图片/引用/at 等有效内容，直接过滤，不唤醒（如文件下载回执/空系统灰条）
  if (rawContent.length === 0 && images.length === 0 && replyId === undefined && atQQs.length === 0) {
    return { wakeup: false };
  }

  // EN-001: 群聊消息的 at 段统一归一化为 @昵称(QQ号)（唤醒包 content 与 from_name 同源格式）
  let content = rawContent;
  if (
    isGroup &&
    atQQs.length > 0 &&
    typeof options.resolveNickname === 'function' &&
    groupId !== undefined
  ) {
    content = await resolveAtNicknames(content, atQQs, groupId, options.resolveNickname);
  }

  // 3.0 异步统一解析被引用消息（若存在 replyId）
  let quoted: WakeupPayload['quoted'] = undefined;
  let isQuotingSelf = false;
  const combinedImages = [...images];

  if (replyId !== undefined) {
    if (options.getQuotedMessage) {
      try {
        const quotedMsg = await options.getQuotedMessage(replyId);
        if (quotedMsg) {
          isQuotingSelf = Boolean(
            quotedMsg.self === 1 ||
              (botQQ !== '' && String(quotedMsg.user_id) === botQQ)
          );
          quoted = {
            msg_id: replyId,
            user_id: String(quotedMsg.user_id || ''),
            from_name: quotedMsg.sender_name || (isQuotingSelf ? (options.bot_nickname || '') : ''),
            text: quotedMsg.content || '',
            images: quotedMsg.images && quotedMsg.images.length > 0 ? quotedMsg.images : undefined,
          };
          if (quotedMsg.images && Array.isArray(quotedMsg.images)) {
            for (const img of quotedMsg.images) {
              if (img && !combinedImages.includes(img)) {
                combinedImages.push(img);
              }
            }
          }
        } else {
          // 优雅降级占位保底
          quoted = {
            msg_id: replyId,
            user_id: '',
            from_name: '',
            text: '〔历史引用消息：内容已过期或无法获取〕',
          };
        }
      } catch {
        quoted = {
          msg_id: replyId,
          user_id: '',
          from_name: '',
          text: '〔历史引用消息：内容已过期或无法获取〕',
        };
      }
    } else if (options.isQuotingBot) {
      try {
        const isQuoting = await options.isQuotingBot(replyId);
        if (isQuoting) {
          isQuotingSelf = true;
          quoted = {
            msg_id: replyId,
            user_id: botQQ,
            from_name: options.bot_nickname || '',
            text: '',
          };
        }
      } catch {}
    }
  }

  // 3.1 私聊消息: 默认直接唤醒
  if (!isGroup) {
    const payload: WakeupPayload = {
      trigger: 'at', // default trigger type for private or handled by agent
      peer,
      from_user: fromUser,
      from_name: fromName,
      content,
      quoted,
      images: combinedImages.length > 0 ? combinedImages : undefined,
      timestamp,
    };
    return {
      wakeup: true,
      trigger: 'direct',
      payload,
    };
  }

  // 3.2 群聊唤醒判定
  // (1) @ 机器人
  if (botQQ && atQQs.includes(botQQ)) {
    const payload: WakeupPayload = {
      trigger: 'at',
      peer,
      from_user: fromUser,
      from_name: fromName,
      content,
      quoted,
      images: combinedImages.length > 0 ? combinedImages : undefined,
      timestamp,
    };
    return {
      wakeup: true,
      trigger: 'at',
      payload,
    };
  }

  // (2) 引用回复机器人
  if (isQuotingSelf && quoted) {
    const payload: WakeupPayload = {
      trigger: 'quote',
      peer,
      from_user: fromUser,
      from_name: fromName,
      content,
      quoted,
      images: combinedImages.length > 0 ? combinedImages : undefined,
      timestamp,
    };
    return {
      wakeup: true,
      trigger: 'quote',
      payload,
    };
  }

  // (3) 点名机器人昵称或别名
  const mentionTargets: string[] = [];
  if (options.bot_nickname && options.bot_nickname.trim() !== '') {
    mentionTargets.push(options.bot_nickname.trim());
  }
  if (Array.isArray(options.aliases)) {
    for (const alias of options.aliases) {
      if (alias && alias.trim() !== '') {
        mentionTargets.push(alias.trim());
      }
    }
  }

  const rawOrContent = `${msgEvent.raw_message || ''} ${content}`;
  for (const target of mentionTargets) {
    if (rawOrContent.includes(target)) {
      const payload: WakeupPayload = {
        trigger: 'mention',
        peer,
        from_user: fromUser,
        from_name: fromName,
        content,
        quoted,
        images: combinedImages.length > 0 ? combinedImages : undefined,
        timestamp,
      };
      return {
        wakeup: true,
        trigger: 'mention',
        payload,
      };
    }
  }

  // 3.3 群聊普通消息概率主动唤醒 (Proactive Random Wakeup)
  if (
    options.proactive?.proactive_reply_enabled &&
    options.proactive?.proactive_random_enabled
  ) {
    // 消息类型排除检查 (纯单表情、视频、语音、卡片小组件等；仅回复文本内容模式下非纯文本一律排除)
    const onlyText = Boolean(options.proactive?.proactive_only_text);
    if (isExcludedFromProactive(msgEvent, onlyText)) {
      return { wakeup: false };
    }

    // 夜间免打扰检查
    if (
      options.proactive.proactive_night_dnd !== false &&
      options.proactiveManager?.isNightDnd(timestamp)
    ) {
      return { wakeup: false };
    }

    // 冷却期检查
    const cooldownMins = options.proactive.proactive_cooldown_mins ?? 10;
    if (
      options.proactiveManager?.isCooldown(peer, cooldownMins, timestamp)
    ) {
      return { wakeup: false };
    }

    // 概率判定
    const probability = options.proactive.proactive_random_probability ?? 0.05;
    if (probability > 0 && Math.random() < probability) {
      const payload: WakeupPayload = {
        trigger: 'proactive',
        sub_trigger: 'random',
        peer,
        from_user: fromUser,
        from_name: fromName,
        content,
        quoted,
        images: combinedImages.length > 0 ? combinedImages : undefined,
        timestamp,
      };
      return {
        wakeup: true,
        trigger: 'proactive',
        payload,
      };
    }
  }

  return { wakeup: false };
}



