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
    let nextCursor: string | undefined = undefined;

    if (scope === 'friends') {
      // 场景 A: 好友动态流 (支持 cursor 游标透传、多页自动补齐 Fill-to-Limit 与 after_feed_id)
      const validFeeds: any[] = [];
      let currentCursor: string | undefined = params.cursor ? String(params.cursor).trim() : undefined;
      let protoHasMore = true;
      let latestNextCursor: string | undefined = undefined;
      let fetchRounds = 0;
      const MAX_FETCH_ROUNDS = 3;

      // 当未传入显式游标时（默认拉取、offset 翻页或 after_feed_id 续读），启用自动多页聚合补齐 (Fill-to-Limit)；
      // 若调用方传入了显式 cursor，则遵守原生游标单页单步契约，不跨游标侵入
      const isExplicitCursor = Boolean(params.cursor);

      while (fetchRounds < MAX_FETCH_ROUNDS) {
        fetchRounds++;
        const actionPayload: Record<string, any> = {
          count: Math.max(limit * 2, 10), // 适度多拉几条以补偿被清洗的广告卡
        };
        if (currentCursor) {
          actionPayload.cursor = currentCursor;
        }

        const res = await invokeGatewayAction(ctx.gateway, 'get_qzone_feeds', actionPayload);
        const rawFeeds: any[] = res?.data?.feeds || [];
        const protoCursor = res?.data?.next_cursor || res?.data?.attach_info;
        latestNextCursor = protoCursor ? String(protoCursor) : undefined;
        protoHasMore = res?.data?.has_more !== undefined ? Boolean(res.data.has_more) : Boolean(protoCursor);

        // Filter-Before-Slice: 先清洗掉广告占位卡与官方空间号，避免占用用户 limit 配额
        const filtered = rawFeeds.filter((item) => isRealUserFeed(item));
        for (const item of filtered) {
          const fid = item.tid || item.key;
          if (!fid || !validFeeds.some((v) => (v.tid || v.key) === fid)) {
            validFeeds.push(item);
          }
        }

        // 若为显式游标模式，单轮即停止，保持游标单步幂等与 next_cursor 精确对应
        if (isExplicitCursor) {
          break;
        }

        // 计算当前有效条数是否已满足本次请求所需
        let targetNeeded = offset + limit;
        if (params.after_feed_id) {
          const targetId = params.after_feed_id.trim();
          const foundIdx = validFeeds.findIndex(
            (f) => (f.tid && f.tid === targetId) || (f.key && f.key === targetId)
          );
          if (foundIdx !== -1) {
            targetNeeded = foundIdx + 1 + limit;
          } else {
            // 尚未找到指定断点，需要继续拉取
            targetNeeded = validFeeds.length + limit;
          }
        }

        // 如果已经凑够所需条数，或者协议端明确没有下一页 / 没有游标，则结束补拉
        if (validFeeds.length >= targetNeeded || !protoHasMore || !latestNextCursor) {
          break;
        }

        // 继续下一轮游标拉取
        currentCursor = latestNextCursor;
      }

      // 支持 after_feed_id 续读定位
      let startIndex = offset;
      if (params.after_feed_id) {
        const targetId = params.after_feed_id.trim();
        const foundIdx = validFeeds.findIndex(
          (f) => (f.tid && f.tid === targetId) || (f.key && f.key === targetId)
        );
        if (foundIdx !== -1) {
          startIndex = foundIdx + 1;
        }
      }

      const sliced = validFeeds.slice(startIndex, startIndex + limit);

      // 判断是否有更多：
      // 1. 本地收集池中在当前切片后还有剩余数据；
      // 2. 协议端在最后一轮仍然明确还有更多且提供了 next_cursor。
      const hasRemainingInPool = validFeeds.length > startIndex + sliced.length;
      hasMore = hasRemainingInPool || (protoHasMore && Boolean(latestNextCursor));

      if (hasMore) {
        // 自适应严谨计算：严格按照实际交付条目数累加，严禁直接 + limit 跳号
        nextOffset = startIndex + sliced.length;
      }

      if (latestNextCursor) {
        nextCursor = latestNextCursor;
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

      // 清洗无效条目 (传入空间归属者的 targetUin)
      const validFeeds = rawList.filter((item) => isRealUserFeed(item, targetUin));

      // 支持 after_feed_id 续读定位
      let startIndex = 0;
      if (params.after_feed_id) {
        const targetId = params.after_feed_id.trim();
        const foundIdx = validFeeds.findIndex((f) => f.tid === targetId);
        if (foundIdx !== -1) {
          startIndex = foundIdx + 1;
        }
      }

      const sliced = validFeeds.slice(startIndex, startIndex + limit);
      const total = Number(res?.data?.total) || validFeeds.length;
      hasMore = total > offset + startIndex + sliced.length;
      if (hasMore) {
        nextOffset = offset + startIndex + sliced.length;
      }

      for (const item of sliced) {
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
      ...(nextCursor ? { next_cursor: nextCursor } : {}),
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
