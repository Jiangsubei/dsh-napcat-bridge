/**
 * QQ 空间评论动态工具 (comment_qzone_feed)
 */

import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { CommentQzoneFeedParams, CommentQzoneFeedResult } from '../../types/index.js';
import {
  type ContextSource,
  resolveToolContext,
} from '../common/context.js';
import { toLosslessJson } from '../../utils/lossless-json.js';
import {
  type QzoneToolContext,
  defaultQzoneRateLimiter,
  invokeGatewayAction,
} from './rate-limiter.js';

export type { CommentQzoneFeedParams, CommentQzoneFeedResult };

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

export function createCommentQzoneFeedTool(context?: ContextSource): ToolDefinition {
  return defineTool({
    name: 'comment_qzone_feed',
    description:
      '在指定的 QQ 空间动态（说说）下方发表评论。需要提供目标动态 ID (feed_id)、目标动态发布者的 QQ 号 (target_qq) 以及评论文本内容。内置 15 秒冷却时间以防账号风控。',
    parameters: {
      feed_id: {
        type: 'string',
        required: true,
        description: '目标动态的唯一 ID（来自 read_qzone_feeds 返回结果中的 feed_id）。',
      },
      target_qq: {
        oneOf: [{ type: 'number' }, { type: 'string' }],
        required: true,
        description: '目标动态发布者的 QQ 号。',
      },
      content: {
        type: 'string',
        required: true,
        description: '欲发表的评论文字内容。',
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
      const res = await commentQzoneFeed(args as any, {
        gateway: resolved.gateway,
      });
      return toLosslessJson(res) as any;
    },
  });
}
