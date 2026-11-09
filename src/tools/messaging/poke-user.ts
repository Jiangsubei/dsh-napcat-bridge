/**
 * dsh-napcat-bridge: 戳一戳互动工具 (poke_user)
 */

import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { PokeUserParams, PokeUserResult } from '../../types/index.js';
import {
  type ToolExecutionContext,
  type ContextSource,
  getGlobalToolContext,
  resolveToolContext,
  normalizePeer,
} from '../common/context.js';
import { toLosslessJson } from '../../utils/lossless-json.js';

export type { PokeUserParams, PokeUserResult };

/**
 * 6.5 戳一戳互动工具 (poke_user)
 * 主动在群内戳指定用户或在私聊窗口抖动用户。
 */
export async function pokeUser(
  params: PokeUserParams,
  context?: ToolExecutionContext
): Promise<PokeUserResult> {
  const ctx = { ...getGlobalToolContext(), ...context };

  if (!params || !params.user_id || typeof params.user_id !== 'string' || params.user_id.trim() === '') {
    return { success: false, error: '你需要指定 user_id（目标用户的 QQ 号）' };
  }

  const userId = params.user_id.trim();

  if (ctx.gateway) {
    try {
      const res = await ctx.gateway.sendPoke(userId, ctx.groupId);
      if (res && (res.status === 'failed' || (typeof res.retcode === 'number' && res.retcode !== 0))) {
        const errMsg = res.wording || res.message || `NapCat 返回错误 (retcode: ${res.retcode})`;
        return { success: false, error: errMsg };
      }
      return { success: true };
    } catch (err: any) {
      return { success: false, error: `戳一戳执行失败: ${err?.message || '未知错误'}` };
    }
  }

  return { success: false, error: '戳一戳执行失败: NapCat 未连接 (gateway 不可用)' };
}

export function createPokeUserTool(context?: ContextSource): ToolDefinition {
  return defineTool({
    name: 'poke_user',
    description: '在群内戳指定用户，或在私聊窗口向对方发送抖动。用于趣味调侃、打招呼，或对方主动要求“戳我一下”时。',
    parameters: {
      user_id: { type: 'string', required: true, description: '目标用户的 QQ 号 (必填)' },
    },
    output: {
      schema: { type: 'json' },
      render: (args, value) => [
        {
          type: 'text',
          text: (value as any).success
            ? `已成功戳了用户 ${args.user_id}`
            : `戳一戳失败: ${(value as any).error}`,
        },
      ],
    },
    async execute(args, exec) {
      const session = (exec.agent as any)?.session;
      const rawPeer = session?.id || '';
      const peer = normalizePeer(rawPeer);
      const groupId =
        peer.startsWith('qq-group-') || peer.startsWith('group_')
          ? peer.replace(/^(qq-group-|group_)/, '').split('-')[0]
          : undefined;
      const resolved = resolveToolContext(context);
      const res = (await pokeUser(args, {
        ...resolved,
        gateway: resolved.gateway,
        groupId: groupId ?? resolved.groupId,
      })) as any;
      if (res && res.success === false) {
        throw new Error(res.error || 'poke_user 失败');
      }
      return toLosslessJson(res);
    },
  });
}
