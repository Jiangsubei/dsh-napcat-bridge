/**
 * 出站附件描述符构造。
 *
 * 发送路径允许通过方法可选参数旁路传入描述符（不塞进发给 NapCat 的消息段，
 * 避免依赖「NapCat 忽略未知字段」这一未证实假设）。未提供时从消息段推导。
 */

import { describeSegments } from './classify.js';
import type { AttachmentDescriptor } from './types.js';
import type { FaceRecord } from '../types/index.js';

export function isGroupPeer(peer: string): boolean {
  return peer.startsWith('group_') || peer.startsWith('qq-group-');
}

/** 把出站 payload（纯文本或 OneBot 消息段数组）归一化为消息段数组。 */
export function normalizeOutboundSegments(message: unknown): Array<Record<string, any>> {
  if (typeof message === 'string') {
    return message.trim() !== '' ? [{ type: 'text', data: { text: message } }] : [];
  }
  if (Array.isArray(message)) {
    return message.filter(
      (seg): seg is Record<string, any> => Boolean(seg) && typeof seg === 'object'
    );
  }
  return [];
}

/** 从出站消息段构造描述符（无旁路信息时的回退路径）。 */
export function buildOutboundAttachments(
  message: unknown,
  options: { peer: string }
): AttachmentDescriptor[] {
  const segments = normalizeOutboundSegments(message);
  if (segments.length === 0) return [];
  return describeSegments(segments, {
    origin: 'outbound',
    isGroup: isGroupPeer(options.peer),
  });
}

/** 由已收藏表情构造出站描述符（face 元信息直接来自本地事实）。 */
export function buildOutboundFaceAttachment(
  face: FaceRecord,
  localPath: string,
  subType: number
): AttachmentDescriptor {
  const tags = Array.isArray(face.tags) && face.tags.length > 0 ? face.tags : undefined;

  return {
    kind: subType === 1 ? 'sticker' : 'image',
    origin: 'outbound',
    local: {
      path: localPath,
      ...(face.format ? { format: face.format } : {}),
      ...(face.size ? { size: face.size } : {}),
      ...(face.md5 ? { md5: face.md5 } : {}),
    },
    face: {
      id: face.id,
      ...(face.mood ? { mood: face.mood } : {}),
      ...(tags ? { tags } : {}),
    },
  };
}
