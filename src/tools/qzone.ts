/**
 * QQ 空间动态互动工具集实现 (Qzone Tools Implementation)
 * 支持读动态 (read_qzone_feeds)、发动态 (publish_qzone_feed)、评动态 (comment_qzone_feed)、删动态 (delete_qzone_feed)
 * 严格遵从 DSH Lossless JSON 约束与操作频率限制
 */

import type { NapCatGatewayServer } from '../gateway/server.js';
import type { MediaStorageManager } from '../storage/media.js';
import type {
  ReadQzoneFeedsParams,
  ReadQzoneFeedsResult,
  PublishQzoneFeedParams,
  PublishQzoneFeedResult,
  CommentQzoneFeedParams,
  CommentQzoneFeedResult,
  DeleteQzoneFeedParams,
  DeleteQzoneFeedResult,
  QzoneFeedItem,
  QzoneImageItem,
  QzoneCommentItem,
} from '../types/index.js';

export function toLosslessJson<T>(val: T): T {
  if (val === undefined || val === null) return val;
  return JSON.parse(JSON.stringify(val));
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

function formatTimestamp(ts?: number): string {
  if (!ts) return new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  const d = new Date(ts * 1000 > 1e12 ? ts * 1000 : ts);
  return d.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
}

function normalizeImageUri(img: string): string {
  if (!img) return '';
  const trimmed = img.trim();
  if (/^(file:\/\/|https?:\/\/|base64:\/\/)/i.test(trimmed)) {
    return trimmed;
  }
  // 本地文件路径转换为 file:/// URI
  const normalizedPath = trimmed.replace(/\\/g, '/');
  return normalizedPath.startsWith('/') ? `file://${normalizedPath}` : `file:///${normalizedPath}`;
}

async function invokeGatewayAction(gateway: any, action: string, params: Record<string, any> = {}): Promise<any> {
  if (typeof gateway.sendAction === 'function') {
    return gateway.sendAction(action, params);
  }
  if (typeof gateway.callAction === 'function') {
    return gateway.callAction(action, params);
  }
  throw new Error('Gateway does not support sendAction or callAction');
}

/**
 * 1. 读动态工具 (read_qzone_feeds)
 */
export async function readQzoneFeeds(
  params: ReadQzoneFeedsParams,
  ctx: QzoneToolContext
): Promise<ReadQzoneFeedsResult> {
  const scope = params.scope || 'friends';
  const limit = Math.min(Math.max(Number(params.limit) || 5, 1), 10);
  const offset = Math.max(Number(params.offset) || 0, 0);

  if (!ctx.gateway) {
    return toLosslessJson({
      success: false,
      scope,
      feeds: [],
      has_more: false,
      message: 'NapCat Gateway 未连接，无法读取空间动态',
    });
  }

  const botUin = ctx.botQq ? Number(ctx.botQq) : 0;

  try {
    const feedItems: QzoneFeedItem[] = [];
    let hasMore = false;
    let nextOffset: number | undefined = undefined;

    if (scope === 'friends') {
      // 场景 A: 好友动态流
      const res = await invokeGatewayAction(ctx.gateway, 'get_qzone_feeds', {
        attach_info: '',
      });

      const rawFeeds: any[] = res?.data?.feeds || [];
      const sliced = rawFeeds.slice(offset, offset + limit);
      hasMore = rawFeeds.length > offset + limit;
      if (hasMore) {
        nextOffset = offset + limit;
      }

      for (const item of sliced) {
        const feedId = item.tid || item.key || '';
        const authorUin = Number(item.uin) || 0;
        const authorNick = String(item.nickname || '');
        const content = String(item.content_complete || item.content || '');
        const timeStr = formatTimestamp(item.time);
        const commentCount = Number(item.comment_count) || 0;
        const likeCount = Number(item.like_count) || 0;

        // 图片多模态下载落地
        const images: QzoneImageItem[] = [];
        const rawImages: string[] = Array.isArray(item.images) ? item.images : [];
        for (const imgUrl of rawImages) {
          const imgItem: QzoneImageItem = { url: imgUrl };
          if (ctx.mediaManager && typeof imgUrl === 'string' && imgUrl.startsWith('http')) {
            try {
              const saveRes = await (ctx.mediaManager as any).downloadAndSave?.(imgUrl, { type: 'image' })
                || await (ctx.mediaManager as any).downloadAndCacheMedia?.(imgUrl, 'image');
              const localPath = typeof saveRes === 'string' ? saveRes : saveRes?.localPath;
              if (localPath) {
                imgItem.local_path = localPath;
              }
            } catch {
              // 容错降级
            }
          }
          images.push(imgItem);
        }

        // 尝试获取精简评论区
        const comments: QzoneCommentItem[] = [];
        if (feedId) {
          try {
            const detailRes = await invokeGatewayAction(ctx.gateway, 'get_qzone_msg_detail', {
              tid: feedId,
              target_uin: authorUin,
            });
            const rawComments: any[] = detailRes?.data?.comments || [];
            // 保留前 5 条评论
            for (const c of rawComments.slice(0, 5)) {
              const commentUin = Number(c.uin) || 0;
              comments.push({
                comment_id: c.id || c.comment_id || '',
                author: {
                  user_id: commentUin,
                  nickname: String(c.name || c.nickname || ''),
                },
                content: String(c.content || ''),
                create_time: formatTimestamp(c.time),
                is_self: botUin > 0 && commentUin === botUin,
              });
            }
          } catch {
            // 忽略评论获取异常
          }
        }

        feedItems.push({
          feed_id: feedId,
          author: {
            user_id: authorUin,
            nickname: authorNick,
          },
          publish_time: timeStr,
          content,
          images,
          comments,
          total_comment_count: commentCount,
          like_count: likeCount,
        });
      }
    } else {
      // 场景 B/C: 指定好友或自己
      const targetUin =
        scope === 'user'
          ? Number(params.target_qq) || 0
          : botUin;

      const actionParams: Record<string, any> = {
        num: limit,
        pos: offset,
      };
      if (targetUin > 0) {
        actionParams.target_uin = targetUin;
      }

      const res = await invokeGatewayAction(ctx.gateway, 'get_qzone_msg_list', actionParams);
      const rawList: any[] = res?.data?.msglist || [];
      const total = Number(res?.data?.total) || rawList.length;
      hasMore = total > offset + rawList.length;
      if (hasMore) {
        nextOffset = offset + rawList.length;
      }

      for (const item of rawList) {
        const feedId = item.tid || '';
        const authorUin = targetUin;
        const authorNick = item.name || item.nickname || (scope === 'self' ? '自己' : '');
        const content = String(item.content || '');
        const timeStr = formatTimestamp(item.time);
        const commentCount = Number(item.comment_num) || 0;

        const images: QzoneImageItem[] = [];
        const rawImages: string[] = Array.isArray(item.images) ? item.images : [];
        for (const imgUrl of rawImages) {
          const imgItem: QzoneImageItem = { url: imgUrl };
          if (ctx.mediaManager && typeof imgUrl === 'string' && imgUrl.startsWith('http')) {
            try {
              const saveRes = await (ctx.mediaManager as any).downloadAndSave?.(imgUrl, { type: 'image' })
                || await (ctx.mediaManager as any).downloadAndCacheMedia?.(imgUrl, 'image');
              const localPath = typeof saveRes === 'string' ? saveRes : saveRes?.localPath;
              if (localPath) {
                imgItem.local_path = localPath;
              }
            } catch {}
          }
          images.push(imgItem);
        }

        feedItems.push({
          feed_id: feedId,
          author: {
            user_id: authorUin,
            nickname: authorNick,
          },
          publish_time: timeStr,
          content,
          images,
          comments: [],
          total_comment_count: commentCount,
        });
      }
    }

    return toLosslessJson({
      success: true,
      scope,
      feeds: feedItems,
      has_more: hasMore,
      ...(nextOffset !== undefined ? { next_offset: nextOffset } : {}),
      message: `成功拉取到 ${feedItems.length} 条空间动态`,
    });
  } catch (err: any) {
    return toLosslessJson({
      success: false,
      scope,
      feeds: [],
      has_more: false,
      message: `读取空间动态失败: ${err?.message || String(err)}`,
    });
  }
}

/**
 * 2. 发布动态工具 (publish_qzone_feed)
 */
export async function publishQzoneFeed(
  params: PublishQzoneFeedParams,
  ctx: QzoneToolContext
): Promise<PublishQzoneFeedResult> {
  const content = (params.content || '').trim();
  if (!content) {
    return toLosslessJson({
      success: false,
      message: '发布失败: 动态文字正文不能为空',
    });
  }

  const limiter = ctx.rateLimiter || defaultQzoneRateLimiter;
  const check = limiter.checkPublish();
  if (!check.allowed) {
    return toLosslessJson({
      success: false,
      message: `空间发动态处于冷却保护中，请在 ${check.remainingSecs} 秒后再试，避免触发账号风控。`,
    });
  }

  if (!ctx.gateway) {
    return toLosslessJson({
      success: false,
      message: 'NapCat Gateway 未连接',
    });
  }

  try {
    const actionPayload: Record<string, any> = { content };
    if (params.images && params.images.length > 0) {
      actionPayload.images = params.images.map(normalizeImageUri);
    }

    const res = await invokeGatewayAction(ctx.gateway, 'send_qzone_msg', actionPayload);
    if (res && (res.status === 'ok' || res.retcode === 0)) {
      limiter.recordPublish();
      const tid = res.data?.tid || res.data?.id || '';
      return toLosslessJson({
        success: true,
        ...(tid ? { feed_id: tid } : {}),
        message: '动态已成功发布到 QQ 空间',
      });
    }

    const reason = res?.wording || res?.message || '发布动态失败';
    return toLosslessJson({
      success: false,
      message: `发布动态失败: ${reason}`,
    });
  } catch (err: any) {
    return toLosslessJson({
      success: false,
      message: `发布动态异常: ${err?.message || String(err)}`,
    });
  }
}

/**
 * 3. 评论动态工具 (comment_qzone_feed)
 */
export async function commentQzoneFeed(
  params: CommentQzoneFeedParams,
  ctx: QzoneToolContext
): Promise<CommentQzoneFeedResult> {
  const feedId = (params.feed_id || '').trim();
  const targetQq = Number(params.target_qq);
  const content = (params.content || '').trim();

  if (!feedId) {
    return toLosslessJson({
      success: false,
      message: '评论失败: 缺少目标动态 ID (feed_id)',
    });
  }
  if (!targetQq) {
    return toLosslessJson({
      success: false,
      message: '评论失败: 缺少目标动态作者 QQ 号 (target_qq)',
    });
  }
  if (!content) {
    return toLosslessJson({
      success: false,
      message: '评论失败: 评论内容不能为空',
    });
  }

  const limiter = ctx.rateLimiter || defaultQzoneRateLimiter;
  const check = limiter.checkComment();
  if (!check.allowed) {
    return toLosslessJson({
      success: false,
      message: `空间评论处于冷却保护中，请在 ${check.remainingSecs} 秒后再试，避免触发账号风控。`,
    });
  }

  if (!ctx.gateway) {
    return toLosslessJson({
      success: false,
      message: 'NapCat Gateway 未连接',
    });
  }

  try {
    const res = await invokeGatewayAction(ctx.gateway, 'comment_qzone', {
      tid: feedId,
      target_uin: targetQq,
      content,
    });

    if (res && (res.status === 'ok' || res.retcode === 0)) {
      limiter.recordComment();
      const commentId = res.data?.comment_id || res.data?.id || '';
      return toLosslessJson({
        success: true,
        ...(commentId ? { comment_id: commentId } : {}),
        message: '评论已成功发表到指定动态',
      });
    }

    const reason = res?.wording || res?.message || '评论发表失败';
    return toLosslessJson({
      success: false,
      message: `评论发表失败: ${reason}`,
    });
  } catch (err: any) {
    return toLosslessJson({
      success: false,
      message: `发表评论异常: ${err?.message || String(err)}`,
    });
  }
}

/**
 * 4. 删除动态工具 (delete_qzone_feed)
 */
export async function deleteQzoneFeed(
  params: DeleteQzoneFeedParams,
  ctx: QzoneToolContext
): Promise<DeleteQzoneFeedResult> {
  const feedId = (params?.feed_id || '').trim();
  if (!feedId) {
    return toLosslessJson({
      success: false,
      feed_id: '',
      message: '删除失败: 缺少目标动态 ID (feed_id)',
    });
  }

  if (!ctx.gateway) {
    return toLosslessJson({
      success: false,
      feed_id: feedId,
      message: 'NapCat Gateway 未连接',
    });
  }

  try {
    const res = await invokeGatewayAction(ctx.gateway, 'delete_qzone_msg', {
      tid: feedId,
    });

    if (res && (res.status === 'ok' || res.retcode === 0)) {
      return toLosslessJson({
        success: true,
        feed_id: feedId,
        message: `动态已成功从 QQ 空间彻底删除 (ID: ${feedId})`,
      });
    }

    const reason = res?.wording || res?.message || '删除动态失败';
    return toLosslessJson({
      success: false,
      feed_id: feedId,
      message: `删除动态失败: ${reason}`,
    });
  } catch (err: any) {
    return toLosslessJson({
      success: false,
      feed_id: feedId,
      message: `删除动态异常: ${err?.message || String(err)}`,
    });
  }
}
