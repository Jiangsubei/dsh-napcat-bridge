/**
 * 群公告列表查询工具 (get_group_notice)
 */

import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { GroupNoticeItem, GetGroupNoticeParams, GetGroupNoticeResult } from '../../types/index.js';
import type { ToolExecutionContext } from '../common/context.js';
import { toLosslessJson } from '../../utils/lossless-json.js';
import {
  buildOffsetMessage,
  normalizeLimit,
  normalizeOffset,
  paginateByOffset,
} from '../pagination.js';
import {
  decodeHtmlEntities,
  DEFAULT_LIST_LIMIT,
  MAX_LIST_LIMIT,
} from './cache.js';

export const GET_GROUP_NOTICE_DESCRIPTION =
  '按 offset 分页查询指定 QQ 群的历史公告列表。每条结果返回连续行号、公告 ID、发布者 QQ、发布时间戳、纯文本公告内容、已阅人数及是否置顶。用于了解群内规约或最新群务动态。翻页时按已展示条数自行传入 offset。';

export async function queryGroupNotice(
  params: GetGroupNoticeParams,
  ctx: ToolExecutionContext
): Promise<GetGroupNoticeResult> {
  const offset = normalizeOffset(params?.offset);
  const limit = normalizeLimit(params?.limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
  const baseResult = { total: 0, total_matched: 0, offset, limit, has_more: false };

  if (!params || !params.group_id || String(params.group_id).trim() === '') {
    return toLosslessJson({
      success: false,
      notices: [],
      ...baseResult,
      error: '目标群号不能为空。请传入 group_id。',
    });
  }

  const gateway = ctx.gateway;
  if (!gateway) {
    return toLosslessJson({
      success: false,
      notices: [],
      ...baseResult,
      error: 'QQ 网关未连接或离线，暂时无法查询群公告。',
    });
  }

  const groupIdStr = String(params.group_id).trim();

  try {
    const res = await gateway.getGroupNotice(groupIdStr);
    if (res && res.status === 'ok' && Array.isArray(res.data)) {
      const allNotices: GroupNoticeItem[] = res.data.map((raw: any) => {
        const textContent =
          typeof raw.message === 'string'
            ? raw.message
            : raw.message?.text
            ? String(raw.message.text)
            : '';

        const decodedContent = decodeHtmlEntities(textContent).trim();

        return {
          notice_id: String(raw.notice_id || ''),
          sender_id: String(raw.sender_id || ''),
          publish_time: Number(raw.publish_time) || 0,
          content: decodedContent,
          read_num: Number(raw.read_num) || 0,
          pinned: Boolean(raw.pinned),
        };
      });

      const page = paginateByOffset(allNotices, { offset, limit }, {
        defaultLimit: DEFAULT_LIST_LIMIT,
        maxLimit: MAX_LIST_LIMIT,
      });

      const message =
        page.totalMatched === 0
          ? '该群当前暂无群公告。'
          : buildOffsetMessage({
              offset: page.offset,
              returned: page.returned,
              totalMatched: page.totalMatched,
              hasMore: page.hasMore,
              ...(page.nextOffset !== undefined ? { nextOffset: page.nextOffset } : {}),
              unit: '条公告',
            });

      return toLosslessJson({
        success: true,
        group_id: groupIdStr,
        notices: page.items,
        total: page.returned,
        total_matched: page.totalMatched,
        offset: page.offset,
        limit: page.limit,
        has_more: page.hasMore,
        ...(message ? { message } : {}),
      });
    }

    return toLosslessJson({
      success: false,
      notices: [],
      ...baseResult,
      error: `获取群公告失败: ${res?.message || '目标群不存在或无权访问公告'}`,
    });
  } catch (err: any) {
    return toLosslessJson({
      success: false,
      notices: [],
      ...baseResult,
      error: `调用群公告接口发生异常: ${err?.message || String(err)}`,
    });
  }
}

export function createGetGroupNoticeTool(
  contextGetter: () => ToolExecutionContext
): ToolDefinition {
  return defineTool({
    name: 'get_group_notice',
    description: GET_GROUP_NOTICE_DESCRIPTION,
    parameters: {
      group_id: {
        type: 'string',
        description: '目标 QQ 群号 (必填)',
      },
      offset: {
        type: 'number',
        description: '起始序号偏移，从 0 开始（0 表示第 1 条）。翻页时按已展示条数自行推算。',
      },
      limit: {
        type: 'number',
        description: '单次返回条数 (默认 20，单次上限 50)。',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => {
        const v = value as unknown as GetGroupNoticeResult;
        if (!v || !v.success) return [{ type: 'text', text: `查询失败: ${v?.error || '未知错误'}` }];
        if (v.total === 0) {
          return [{ type: 'text', text: v.message || `群 [${v.group_id}] 当前暂无群公告。` }];
        }
        const lines: string[] = [
          `### 群公告列表 (群号: \`${v.group_id}\`，序号 ${v.offset + 1}~${v.offset + v.total} / 共 ${v.total_matched} 条)`,
        ];
        for (let i = 0; i < v.notices.length; i++) {
          const n = v.notices[i];
          const timeStr = n.publish_time ? new Date(n.publish_time * 1000).toLocaleString('zh-CN') : '未知时间';
          lines.push(`${v.offset + i + 1}. [公告] ${timeStr} (发布者 QQ: \`${n.sender_id}\`)`);
          lines.push(n.content || '（纯图片或空内容）');
          lines.push('');
        }
        if (v.has_more) {
          lines.push(
            `> 还有 ${v.total_matched - v.offset - v.total} 条未展示。继续浏览请传入 \`offset: ${v.offset + v.total}\`。`
          );
        } else if (v.message) {
          lines.push(`> ${v.message}`);
        }
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    execute: async (args) => {
      const ctx = contextGetter();
      return queryGroupNotice(args as GetGroupNoticeParams, ctx) as any;
    },
  });
}
