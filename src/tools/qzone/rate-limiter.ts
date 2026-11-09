/**
 * QQ 空间基础设施：限流器、上下文与辅助函数
 */

import type { NapCatGatewayServer } from '../../gateway/server.js';
import type { MediaStorageManager } from '../../storage/media.js';
import type { QzoneCommentItem } from '../../types/index.js';

/**
 * 判定一条动态是否为真实好友动态
 * 1. 过滤广告/推广占位卡: uin <= 0 或 feed_id 带 advertisement_
 * 2. 过滤 QQ 空间官方账号: uin === 20050606 (空间上线日系统保留固定号，非好友关系链)
 */
export function isRealUserFeed(item: any, defaultUin = 0): boolean {
  const rawUin = item?.uin !== undefined ? Number(item.uin) : defaultUin;
  const uin = Number(rawUin) || 0;
  if (uin <= 0) return false;
  if (uin === 20050606) return false;
  const tid = String(item?.tid || item?.key || '');
  if (tid.startsWith('advertisement_')) return false;
  return true;
}

/**
 * QQ 空间风控限流器：防止频繁调用写操作触发腾讯滑块验证码或账号异常
 */
export class QzoneRateLimiter {
  private publishCooldownMs: number;
  private commentCooldownMs: number;
  private lastPublishTime = 0;
  private lastCommentTime = 0;

  constructor(publishCooldownMs = 60000, commentCooldownMs = 15000) {
    this.publishCooldownMs = publishCooldownMs;
    this.commentCooldownMs = commentCooldownMs;
  }

  checkPublish(): { allowed: boolean; remainingSecs: number } {
    const elapsed = Date.now() - this.lastPublishTime;
    if (elapsed < this.publishCooldownMs) {
      return { allowed: false, remainingSecs: Math.ceil((this.publishCooldownMs - elapsed) / 1000) };
    }
    return { allowed: true, remainingSecs: 0 };
  }

  recordPublish(): void {
    this.lastPublishTime = Date.now();
  }

  checkComment(): { allowed: boolean; remainingSecs: number } {
    const elapsed = Date.now() - this.lastCommentTime;
    if (elapsed < this.commentCooldownMs) {
      return { allowed: false, remainingSecs: Math.ceil((this.commentCooldownMs - elapsed) / 1000) };
    }
    return { allowed: true, remainingSecs: 0 };
  }

  recordComment(): void {
    this.lastCommentTime = Date.now();
  }
}

/** 默认单例限流器 */
export const defaultQzoneRateLimiter = new QzoneRateLimiter(60000, 15000);

export interface QzoneToolContext {
  gateway?: NapCatGatewayServer | null;
  mediaManager?: MediaStorageManager | null;
  botQq?: string | number | null;
  rateLimiter?: QzoneRateLimiter | null;
}

export function formatTimestamp(ts?: number): string {
  if (!ts) return new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  const d = new Date(ts * 1000 > 1e12 ? ts * 1000 : ts);
  return d.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
}

export function normalizeImageUri(img: string): string {
  if (!img) return '';
  const trimmed = img.trim();
  if (/^(file:\/\/|https?:\/\/|base64:\/\/)/i.test(trimmed)) {
    return trimmed;
  }
  // 本地文件路径转换为 file:/// URI
  const normalizedPath = trimmed.replace(/\\/g, '/');
  return normalizedPath.startsWith('/') ? `file://${normalizedPath}` : `file:///${normalizedPath}`;
}

export async function invokeGatewayAction(gateway: any, action: string, params: Record<string, any> = {}): Promise<any> {
  if (typeof gateway.sendAction === 'function') {
    return gateway.sendAction(action, params);
  }
  if (typeof gateway.callAction === 'function') {
    return gateway.callAction(action, params);
  }
  throw new Error('Gateway does not support sendAction or callAction');
}

/**
 * 统一获取单条说说的精简评论区（前 5 条）
 * 跨平台兼容垫片：若网关或环境不支持 get_qzone_msg_detail，静默降级为空数组，绝不打断主体列表
 */
export async function fetchFeedComments(
  gateway: any,
  feedId: string,
  authorUin: number,
  botUin: number
): Promise<QzoneCommentItem[]> {
  if (!feedId || !gateway) return [];
  try {
    const detailRes = await invokeGatewayAction(gateway, 'get_qzone_msg_detail', {
      tid: feedId,
      target_uin: authorUin,
    });
    const rawComments: any[] = detailRes?.data?.comments || [];
    const comments: QzoneCommentItem[] = [];
    for (const c of rawComments.slice(0, 5)) {
      const commentUin = Number(c.uin || c.user_id) || 0;
      comments.push({
        comment_id: String(c.id || c.comment_id || ''),
        author: {
          user_id: commentUin,
          nickname: String(c.name || c.nickname || ''),
        },
        content: String(c.content || ''),
        create_time: formatTimestamp(c.time),
        is_self: botUin > 0 && commentUin === botUin,
      });
    }
    return comments;
  } catch {
    return [];
  }
}
