/**
 * QQ 空间发布动态工具 (publish_qzone_feed)
 */

import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { PublishQzoneFeedParams, PublishQzoneFeedResult } from '../../types/index.js';
import {
  type ContextSource,
  resolveToolContext,
} from '../common/context.js';
import { toLosslessJson } from '../../utils/lossless-json.js';
import {
  type QzoneToolContext,
  defaultQzoneRateLimiter,
  normalizeImageUri,
  invokeGatewayAction,
} from './rate-limiter.js';

export type { PublishQzoneFeedParams, PublishQzoneFeedResult };

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

export function createPublishQzoneFeedTool(context?: ContextSource): ToolDefinition {
  return defineTool({
    name: 'publish_qzone_feed',
    description:
      '向当前登录账号的 QQ 空间发布一条动态（说说）。支持纯文本正文与附加图片列表（支持本地沙箱图片路径、本地文件绝对路径或网络图片 URL）。注意：为防止账号风控，该操作内置冷却时间限制（默认 60 秒），不可高频连续发布。',
    parameters: {
      content: {
        type: 'string',
        required: true,
        description: '欲发布的动态正文内容。',
      },
      images: {
        type: 'array',
        items: { type: 'string' },
        description: '可选的配图路径或 URL 列表。支持本地绝对路径、沙箱图片路径或网络 HTTP/HTTPS 链接。',
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
      const res = await publishQzoneFeed(args as any, {
        gateway: resolved.gateway,
      });
      return toLosslessJson(res) as any;
    },
  });
}
