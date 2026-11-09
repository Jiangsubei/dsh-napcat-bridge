/**
 * 群基础信息查询工具 (get_group_info)
 */

import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { GetGroupInfoParams, GetGroupInfoResult } from '../../types/index.js';
import type { ToolExecutionContext } from '../common/context.js';
import { toLosslessJson } from '../../utils/lossless-json.js';

export const GET_GROUP_INFO_DESCRIPTION =
  '查询指定 QQ 群的基础信息与元数据（如群名称、群备注、群人数、人数上限、群公告摘要及建群时间）。用于核实群规模与基本设置。';

export async function queryGroupInfo(
  params: GetGroupInfoParams,
  ctx: ToolExecutionContext
): Promise<GetGroupInfoResult> {
  if (!params || !params.group_id || String(params.group_id).trim() === '') {
    return toLosslessJson({
      success: false,
      error: '目标群号不能为空。请传入 group_id。',
    });
  }

  const gateway = ctx.gateway;
  if (!gateway) {
    return toLosslessJson({
      success: false,
      error: 'QQ 网关未连接或离线，暂时无法查询群信息。',
    });
  }

  const groupIdStr = String(params.group_id).trim();

  try {
    const res = await gateway.getGroupInfo(groupIdStr);
    if (res && res.status === 'ok' && res.data) {
      const d = res.data;
      let groupCreateTime = Number(d.group_create_time ?? d.groupCreateTime ?? d.create_time) || 0;
      let groupMemo = String(d.richFingerMemo || d.fingerMemo || d.group_memo || d.groupMemo || d.memo || '');

      // 双轨兼容垫片：若发现建群时间为 0 或群介绍为空（如 NapCat 默认精简 6 字段），尝试升阶调用 get_group_detail_info 获取完整详情
      if (groupCreateTime === 0 || !groupMemo) {
        try {
          const detailRes = typeof (gateway as any).getGroupDetailInfo === 'function'
            ? await (gateway as any).getGroupDetailInfo(groupIdStr)
            : typeof (gateway as any).sendAction === 'function'
            ? await (gateway as any).sendAction('get_group_detail_info', { group_id: groupIdStr })
            : undefined;

          if (detailRes && detailRes.status === 'ok' && detailRes.data) {
            const dd = detailRes.data;
            if (groupCreateTime === 0) {
              groupCreateTime = Number(dd.group_create_time ?? dd.groupCreateTime ?? dd.create_time) || 0;
            }
            if (!groupMemo) {
              groupMemo = String(dd.richFingerMemo || dd.fingerMemo || dd.group_memo || dd.groupMemo || dd.memo || '');
            }
          }
        } catch {
          // 升阶异常静默降级，保留既有基础信息
        }
      }

      return toLosslessJson({
        success: true,
        group_id: String(d.group_id || d.groupCode || groupIdStr),
        group_name: String(d.group_name || d.groupName || ''),
        group_remark: String(d.group_remark || d.remarkName || ''),
        member_count: Number(d.member_count ?? d.memberNum) || 0,
        max_member_count: Number(d.max_member_count ?? d.maxMemberNum) || 0,
        group_memo: groupMemo,
        group_create_time: groupCreateTime,
      });
    }

    return toLosslessJson({
      success: false,
      error: `获取群信息失败: ${res?.message || '目标群不存在或机器人未加群'}`,
    });
  } catch (err: any) {
    return toLosslessJson({
      success: false,
      error: `调用群信息接口发生异常: ${err?.message || String(err)}`,
    });
  }
}

export function createGetGroupInfoTool(
  contextGetter: () => ToolExecutionContext
): ToolDefinition {
  return defineTool({
    name: 'get_group_info',
    description: GET_GROUP_INFO_DESCRIPTION,
    parameters: {
      group_id: {
        type: 'string',
        description: '目标 QQ 群号 (必填)',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => {
        const v = value as unknown as GetGroupInfoResult;
        if (!v || !v.success) return [{ type: 'text', text: `查询失败: ${v?.error || '未知错误'}` }];
        const createTimeStr = v.group_create_time ? new Date(v.group_create_time * 1000).toLocaleDateString('zh-CN') : '未知';
        const lines: string[] = [
          `### 群基础信息详情`,
          `- **群名称**: ${v.group_name}`,
          `- **群号**: \`${v.group_id}\``,
          ...(v.group_remark ? [`- **群备注**: ${v.group_remark}`] : []),
          `- **群规模**: ${v.member_count} / ${v.max_member_count} 人`,
          `- **建群时间**: ${createTimeStr}`,
          `- **群介绍**: ${v.group_memo || '（无）'}`,
        ];
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    execute: async (args) => {
      const ctx = contextGetter();
      return queryGroupInfo(args as GetGroupInfoParams, ctx) as any;
    },
  });
}
