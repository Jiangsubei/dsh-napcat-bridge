/**
 * dsh-napcat-bridge: 主动回复排除规则模块
 * 专职判定群聊普通消息是否应排除主动概率唤醒（表情/卡片/视频/语音过滤）。
 */

import type { OneBotMessageEvent } from '../types/index.js';
import { cleanStickerSummary } from '../attachment/render.js';

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

    let pendingStickerSummary: string | null = null;
    for (const seg of segments) {
      if (!seg) continue;
      const isSticker =
        seg.type === 'face' ||
        seg.type === 'mface' ||
        seg.type === 'marketface' ||
        (seg.type === 'image' && (seg.data?.sub_type === 1 || seg.data?.emoji_package_id || seg.data?.emoji_id));

      if (isSticker) {
        emojiSegs.push(seg);
        const clean = cleanStickerSummary(seg.data?.summary);
        pendingStickerSummary = clean !== '表情' ? clean : null;
      } else if (seg.type === 'text') {
        const text = seg.data?.text || '';
        const cleanText = cleanStickerSummary(text);
        if (
          pendingStickerSummary &&
          pendingStickerSummary !== '表情' &&
          cleanText === pendingStickerSummary
        ) {
          // 紧随表情包之后的降级冗余文本，不计入 totalText
          pendingStickerSummary = null;
        } else {
          totalText += text;
          pendingStickerSummary = null;
        }
      } else {
        otherMediaSegs.push(seg);
        pendingStickerSummary = null;
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
