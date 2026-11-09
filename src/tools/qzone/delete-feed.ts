/**
 * QQ 空间删除动态工具 (delete_qzone_feed)
 */

import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { DeleteQzoneFeedParams, DeleteQzoneFeedResult } from '../../types/index.js';
import {
  type ContextSource,
  resolveToolContext,
} from '../common/context.js';
import { toLosslessJson } from '../../utils/lossless-json.js';
import {
  type QzoneToolContext,
  invokeGatewayAction,
} from './rate-limiter.js';

export type { DeleteQzoneFeedParams, DeleteQzoneFeedResult };

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

export function createDeleteQzoneFeedTool(context?: ContextSource): ToolDefinition {
  return defineTool({
    name: 'delete_qzone_feed',
    description:
      '删除当前登录账号自己发布过的某条 QQ 空间动态（说说）。需传入动态 ID (feed_id)。动态将被物理删除，无法撤销。',
    parameters: {
      feed_id: {
        type: 'string',
        required: true,
        description: '欲删除的动态唯一 ID（来自 publish_qzone_feed 的返回值或 read_qzone_feeds 的查询结果）。',
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
      const res = await deleteQzoneFeed(args as any, {
        gateway: resolved.gateway,
      });
      return toLosslessJson(res) as any;
    },
  });
}
