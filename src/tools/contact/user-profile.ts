/**
 * 个人公开资料卡查询工具 (get_user_profile)
 */

import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { GetUserProfileParams, GetUserProfileResult } from '../../types/index.js';
import type { ToolExecutionContext } from '../common/context.js';
import { toLosslessJson } from '../../utils/lossless-json.js';

export const GET_USER_PROFILE_DESCRIPTION =
  '查询任意指定 QQ 用户的公开资料卡信息（好友与非好友均可查询）。返回昵称、备注、性别、年龄、QQ 等级、个性签名、QID 及注册时间戳等字段。用于了解陌生人身份或查询联系人资料。';

export async function queryUserProfile(
  params: GetUserProfileParams,
  ctx: ToolExecutionContext
): Promise<GetUserProfileResult> {
  if (!params || !params.user_id || String(params.user_id).trim() === '') {
    return toLosslessJson({
      success: false,
      error: '目标 QQ 号不能为空。请传入 user_id。',
    });
  }

  const gateway = ctx.gateway;
  if (!gateway) {
    return toLosslessJson({
      success: false,
      error: 'QQ 网关未连接或离线，暂时无法查询用户资料。',
    });
  }

  const userIdStr = String(params.user_id).trim();

  try {
    const res = await gateway.getStrangerInfo(userIdStr);
    if (res && res.status === 'ok' && res.data) {
      const d = res.data;
      return toLosslessJson({
        success: true,
        user_id: String(d.user_id || userIdStr),
        nickname: String(d.nickname || ''),
        remark: String(d.remark || ''),
        sex: String(d.sex || 'unknown'),
        age: Number(d.age) || 0,
        level: Number(d.level || d.qq_level || 0),
        long_nick: String(d.long_nick || ''),
        ...(d.qid ? { qid: String(d.qid) } : {}),
        ...(d.reg_time ? { reg_time: Number(d.reg_time) } : {}),
      });
    }

    return toLosslessJson({
      success: false,
      error: `获取用户资料失败: ${res?.message || '目标用户不存在或受隐私限制'}`,
    });
  } catch (err: any) {
    return toLosslessJson({
      success: false,
      error: `调用资料卡接口发生异常: ${err?.message || String(err)}`,
    });
  }
}

export function createGetUserProfileTool(
  contextGetter: () => ToolExecutionContext
): ToolDefinition {
  return defineTool({
    name: 'get_user_profile',
    description: GET_USER_PROFILE_DESCRIPTION,
    parameters: {
      user_id: {
        type: 'string',
        description: '目标用户的 QQ 号 (必填)',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => {
        const v = value as unknown as GetUserProfileResult;
        if (!v || !v.success) return [{ type: 'text', text: `查询失败: ${v?.error || '未知错误'}` }];
        const regTimeStr = v.reg_time ? new Date(v.reg_time * 1000).toLocaleDateString('zh-CN') : undefined;
        const lines: string[] = [
          `### QQ 个人公开资料卡`,
          `- **用户昵称**: ${v.nickname || '（未知）'}`,
          `- **QQ 账号**: \`${v.user_id}\``,
          ...(v.remark ? [`- **好友备注**: ${v.remark}`] : []),
          ...(v.qid ? [`- **QID**: ${v.qid}`] : []),
          `- **性别/年龄**: ${v.sex || '未知'} / ${v.age ?? 0} 岁`,
          `- **QQ 等级**: Lv.${v.level ?? 0}`,
          ...(regTimeStr ? [`- **注册时间**: ${regTimeStr}`] : []),
          `- **个性签名**: ${v.long_nick || '（无）'}`,
        ];
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    execute: async (args) => {
      const ctx = contextGetter();
      return queryUserProfile(args as GetUserProfileParams, ctx) as any;
    },
  });
}
