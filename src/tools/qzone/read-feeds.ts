/**
 * QQ 空间读动态工具 (read_qzone_feeds)
 */

import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools';
import type {
  ReadQzoneFeedsParams,
  ReadQzoneFeedsResult,
  QzoneFeedItem,
  QzoneImageItem,
} from '../../types/index.js';
import {
  type ContextSource,
  resolveToolContext,
} from '../common/context.js';
import { toLosslessJson } from '../../utils/lossless-json.js';
import {
  type QzoneToolContext,
  isRealUserFeed,
  formatTimestamp,
  invokeGatewayAction,
  fetchFeedComments,
} from './rate-limiter.js';

export type { ReadQzoneFeedsParams, ReadQzoneFeedsResult };

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
      // 若调用方传入了显式 cursor，则遵守原生游标单页单步契约，不跨游标侵入，且 offset 不参与切片（cursor 优先）
      const isExplicitCursor = Boolean(params.cursor);
      const effectiveOffset = isExplicitCursor ? 0 : offset;

      while (fetchRounds < MAX_FETCH_ROUNDS) {
        fetchRounds++;
        const actionPayload: Record<string, any> = {
          count: Math.max(limit * 2, 10), // 适度多拉几条以补偿被清洗的广告卡
        };
        if (currentCursor) {
          actionPayload.cursor = currentCursor;
        }

        const res = await invokeGatewayAction(ctx.gateway, 'get_qzone_feeds', actionPayload);
        if (res && (res.status === 'failed' || (res.retcode !== undefined && res.retcode !== 0))) {
          if (fetchRounds === 1) {
            const reason = res.message || res.wording || '获取好友动态流失败';
            return toLosslessJson({
              success: false,
              scope,
              feeds: [],
              has_more: false,
              message: `读取空间动态失败: ${reason}`,
            });
          }
          break;
        }
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
        let targetNeeded = effectiveOffset + limit;
        if (params.after_feed_id && !isExplicitCursor) {
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

      // 支持 after_feed_id 续读定位（显式 cursor 模式下以 cursor 为准，不叠加 offset / after_feed_id）
      let startIndex = effectiveOffset;
      if (params.after_feed_id && !isExplicitCursor) {
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
        const comments = await fetchFeedComments(ctx.gateway, feedId, authorUin, botUin);

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
      if (res && (res.status === 'failed' || (res.retcode !== undefined && res.retcode !== 0))) {
        const errorMsg = String(res.message || res.wording || '');
        // 跨平台空态容错垫片：当空间说说被删光或无动态时，腾讯接口返回的 msglist 为 null：
        // 1. NapCat 会因 msglist 为 null 抛出"QQ空间兼容说说列表响应不完整"错误；
        // 2. SnowLuma 会抛出"无法获取空间说说列表（响应结构异常）"错误。
        // 此时应视作正常空态返回 0 条动态，避免中断上层业务
        const isQzoneEmptyStateError =
          errorMsg.includes('QQ空间兼容说说列表响应不完整') ||
          errorMsg.includes('说说列表响应不完整') ||
          errorMsg.includes('响应不完整') ||
          errorMsg.includes('响应结构异常') ||
          (errorMsg.includes('无法获取空间说说列表') && errorMsg.includes('结构异常'));
        if (isQzoneEmptyStateError) {
          return toLosslessJson({
            success: true,
            scope,
            feeds: [],
            has_more: false,
            message: '成功拉取到 0 条空间动态',
          });
        }
        const reason = errorMsg || '获取指定空间说说失败（可能无访问权限或目标空间未开放）';
        return toLosslessJson({
          success: false,
          scope,
          feeds: [],
          has_more: false,
          message: `读取空间动态失败: ${reason}`,
        });
      }
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

        const comments = await fetchFeedComments(ctx.gateway, feedId, authorUin, botUin);

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
        });
      }
    }

    return toLosslessJson({
      success: true,
      scope,
      feeds: feedItems,
      has_more: hasMore,
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

export function createReadQzoneFeedsTool(context?: ContextSource): ToolDefinition {
  return defineTool({
    name: 'read_qzone_feeds',
    description:
      '浏览 QQ 空间动态（说说）。可查看好友动态流（scope="friends"，默认）、自己发表过的动态（scope="self"）或指定好友的动态（scope="user"）。支持分页与条数限制（默认 5 条，上限 10 条）；好友动态流翻页请优先使用 cursor/next_cursor，offset 仅在未传 cursor 时生效。返回内容包含发布者 QQ 与昵称、文字正文、图片（包含原 URL 与已自动下载落盘供多模态视觉模型消费的本地路径）；仅 scope="friends" 的好友动态流会附带评论区摘要（包含评论者信息、内容并标记是否为 AI 自身发表），self/user 模式不返回评论。',
    parameters: {
      scope: {
        type: 'string',
        enum: ['friends', 'self', 'user'],
        description: '查看范围：friends=好友动态流(默认)，self=查看自己发表的动态，user=查看指定好友的动态',
      },
      target_qq: {
        oneOf: [{ type: 'number' }, { type: 'string' }],
        description: '当 scope 为 user 时必填，指定欲查看的好友 QQ 号。',
      },
      limit: {
        type: 'number',
        description: '单次拉取动态条数，默认 5 条，硬上限 10 条。',
      },
      offset: {
        type: 'number',
        description:
          '起始偏移量（从 0 开始）。仅用于好友动态流未传 cursor 时，或查看自己/指定好友动态时；好友动态流翻页请优先传 cursor。',
      },
      cursor: {
        type: 'string',
        description: '好友动态流翻页游标（优先于 offset）。原样传入上一页返回的 next_cursor 即可连续翻页。',
      },
      after_feed_id: {
        type: 'string',
        description: '断点续读动态 ID。指定某条已读动态的 ID，工具将定位并仅返回该条之后的更早动态；显式 cursor 模式下不生效。',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [
        {
          type: 'text',
          text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
        },
      ],
    },
    async execute(args) {
      const resolved = resolveToolContext(context);
      const cfg = typeof (resolved as any).config === 'function'
        ? (resolved as any).config()
        : ((resolved as any).config || {});
      const res = await readQzoneFeeds(args as any, {
        gateway: resolved.gateway,
        mediaManager: resolved.mediaManager,
        botQq: cfg?.bot_qq,
      });
      return toLosslessJson(res) as any;
    },
  });
}
