/**
 * dsh-napcat-bridge: 消息段归一化模块
 * 专职 OneBot 消息段 AST 归一化、表情/附件渲染与 MD5 提取。
 */

import type { OneBotMessageEvent, FaceRecord } from '../types/index.js';
import { computeFileMd5 } from '../storage/media.js';
import { describeSegment, resolveLocalMediaPath } from '../attachment/classify.js';
import {
  formatFacePlaceholder as renderFacePlaceholder,
  renderAttachment,
  cleanStickerSummary,
} from '../attachment/render.js';
import { extractCardContent } from './card-parser.js';

export interface MatchedFaceInfo {
  id: string;
  mood?: string | null;
  tags?: string[] | null;
}

/**
 * 格式化已收藏表情包在聊天上下文中的语义占位符。
 * 格式示例：[表情包: face_12345678 (情绪: 嘲讽)] 或 [表情包: face_12345678]
 * 说明：SystemPrompt 中已全量注入表情库各 ID 对应的详细标签，入站仅需保留 face_id 与情绪意图，避免重复注入标签。
 */
export function formatFacePlaceholder(face: MatchedFaceInfo, localPath?: string | null): string {
  return renderFacePlaceholder(face, localPath);
}

export interface ParseNormalizedContentOptions {
  getFaceByMd5?: (md5: string) => FaceRecord | null | undefined;
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

/**
 * 推导图片段可用于表情库查询的 MD5：
 * 1. 段内显式 md5；
 * 2. 本地路径（含 file:/// URI）的字节 MD5；
 * 3. 纯 MD5 文件名（可带扩展名）。
 */
function resolveImageMd5(data: any): string | undefined {
  if (typeof data?.md5 === 'string' && data.md5.trim()) {
    return data.md5.trim().toLowerCase();
  }

  const localPath =
    resolveLocalMediaPath(data?.local_path) || resolveLocalMediaPath(data?.file);
  if (localPath) {
    const md5 = computeFileMd5(localPath);
    if (md5) return md5.toLowerCase();
  }

  if (typeof data?.file === 'string') {
    const base = data.file.split(/[\\/]/).pop() || '';
    const match = base.match(/^([a-fA-F0-9]{32})(?:\.[a-zA-Z0-9]+)?$/);
    if (match) return match[1].toLowerCase();
  }

  return undefined;
}

export function parseNormalizedContent(
  event: OneBotMessageEvent,
  options?: ParseNormalizedContentOptions
): {
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
    let pendingStickerSummary: string | null = null;
    const isGroup = (event as any).message_type === 'group' || Boolean((event as any).group_id);

    for (const seg of event.message) {
      if (!seg || typeof seg !== 'object') continue;
      const type = seg.type;
      const data = seg.data || {};

      if (type !== 'text') {
        pendingStickerSummary = null;
      }

      switch (type) {
        case 'text': {
          const rawText = data.text ? String(data.text) : '';
          if (rawText) {
            const cleanText = cleanStickerSummary(rawText);
            if (
              pendingStickerSummary &&
              pendingStickerSummary !== '表情' &&
              cleanText === pendingStickerSummary
            ) {
              // 属于紧随前序表情包之后的 NapCat 纯降级冗余文本段（如 [拿捏] / 拿捏），予以跳过
              pendingStickerSummary = null;
              break;
            }
            textParts.push(rawText);
          }
          pendingStickerSummary = null;
          break;
        }

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

          const descriptor = describeSegment(seg, { origin: 'inbound', isGroup })!;
          if (!descriptor.face && options?.getFaceByMd5) {
            const md5 = resolveImageMd5(data);
            if (md5) {
              const matched = options.getFaceByMd5(md5);
              if (matched && matched.enabled && !matched.deleted_at) {
                const face = {
                  id: matched.id,
                  ...(matched.mood ? { mood: matched.mood } : {}),
                  ...(matched.tags && matched.tags.length > 0 ? { tags: matched.tags } : {}),
                };
                descriptor.face = face;
                data.face = face;
              }
            }
          }

          if (descriptor.kind === 'sticker') {
            const rawSummary = descriptor.summary || data.summary;
            const clean = cleanStickerSummary(rawSummary);
            pendingStickerSummary = clean !== '表情' ? clean : null;
          } else {
            pendingStickerSummary = null;
          }

          textParts.push(renderAttachment(descriptor) ?? '[表情包]');
          break;
        }

        case 'file': {
          const descriptor = describeSegment(seg, { origin: 'inbound', isGroup })!;
          textParts.push(renderAttachment(descriptor) ?? '[文件]');
          break;
        }

        case 'forward':
          textParts.push(`[合并转发 (ID:${data.id || data.forward_id || ''})]`);
          break;

        case 'record':
          textParts.push('[语音]');
          break;

        case 'video':
          const descriptor = describeSegment(seg, { origin: 'inbound', isGroup })!;
          textParts.push(renderAttachment(descriptor) ?? '[视频]');
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
