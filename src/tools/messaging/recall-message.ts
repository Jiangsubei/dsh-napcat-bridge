/**
 * dsh-napcat-bridge: 撤回 QQ 消息工具 (recall_message)
 */

import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools';
import {
  type ToolExecutionContext,
  type ContextSource,
  getGlobalToolContext,
  resolveToolContext,
  normalizePeer,
} from '../common/context.js';
import { toLosslessJson } from '../../utils/lossless-json.js';

export interface RecallMessageParams {
  message_id: number | string;
}

export interface RecallMessageResult {
  success: boolean;
  message?: string;
  error?: string;
}

/**
 * 6.13 撤回 QQ 消息工具 (recall_message)
 * 撤回当前 QQ 会话中的指定消息。
 * 依托 QQ / NapCat 原生时效（2分钟）与群管权限校验，如实反馈执行结果。
 * 执行时经由 per-peer 串行队列下发，确保出站时序严谨。
 */
export async function recallMessage(
  params: RecallMessageParams,
  context?: ToolExecutionContext
): Promise<RecallMessageResult> {
  const ctx = { ...getGlobalToolContext(), ...context };

  // 1. 参数校验
  if (
    !params ||
    params.message_id === undefined ||
    params.message_id === null ||
    String(params.message_id).trim() === ''
  ) {
    return toLosslessJson({
      success: false,
      error: '请提供需要撤回的消息 ID (message_id)。',
    });
  }

  const rawId =
    typeof params.message_id === 'number'
      ? params.message_id
      : Number(String(params.message_id).trim());

  if (!Number.isSafeInteger(rawId) || rawId === 0) {
    return toLosslessJson({
      success: false,
      error: `无效的消息 ID: ${params.message_id}，必须为非零有效整数。`,
    });
  }

  // 2. 网关校验
  if (!ctx.gateway) {
    return toLosslessJson({
      success: false,
      error: 'NapCat Gateway 未连接',
    });
  }

  // 3. 经由 per-peer 串行队列下发，保证发送与撤回的时序一致性
  const peer = ctx.peer ? normalizePeer(ctx.peer) : '';
  const sendTask = () => ctx.gateway!.deleteMsg(rawId);

  try {
    const res =
      peer && ctx.sender
        ? await ctx.sender.enqueue(peer, sendTask)
        : await sendTask();

    if (res && (res.status === 'ok' || res.retcode === 0)) {
      // 撤回成功立即标记本地记录：不依赖 NapCat 是否回流自身撤回 notice，
      // 自身消息保留原文（markRecalled 内部按 self 区分）。
      try {
        ctx.db?.markRecalled(rawId);
      } catch {}
      return toLosslessJson({
        success: true,
        message: `消息已成功撤回 (ID: ${rawId})。`,
      });
    }

    const reason =
      res?.wording ||
      res?.message ||
      '撤回失败，可能消息发送已超过 2 分钟或无权撤回该消息。';
    return toLosslessJson({
      success: false,
      error: `撤回失败: ${reason}`,
    });
  } catch (err: any) {
    return toLosslessJson({
      success: false,
      error: `撤回失败: ${err?.message || String(err)}`,
    });
  }
}

export function createRecallMessageTool(context?: ContextSource): ToolDefinition {
  return defineTool({
    name: 'recall_message',
    description:
      '撤回当前 QQ 会话中的指定消息。适用于：撤回自己发错/产生幻觉/格式错误的消息，或在具备管理员权限时撤回群友的违规发言。需要传入目标消息的数字 message_id（可来自 send_qq_message 的返回结果，或来自 read_chat_history 的消息头 [消息ID: xxx]）。受 QQ 平台客观限制（如普通消息仅 2 分钟内可撤回、撤回他人需群管权限等），若超过时限或无权撤回将如实报错。',
    parameters: {
      message_id: {
        oneOf: [{ type: 'number' }, { type: 'string' }],
        required: true,
        description:
          '需要撤回的目标消息数字 ID（来自 send_qq_message 返回的 message_id 或 read_chat_history 中的消息头 [消息ID: xxx]）。',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => {
        const v = value as any;
        if (v?.success) {
          return [
            {
              type: 'text',
              text: v.message || '消息已成功撤回',
            },
          ];
        }
        return [
          {
            type: 'text',
            text: `消息撤回失败: ${v?.error}`,
          },
        ];
      },
    },
    async execute(args, exec) {
      const session = (exec.agent as any)?.session;
      const rawPeer =
        session?.id ||
        (exec.agent as any)?.sessionId ||
        (exec.agent as any)?.id ||
        '';
      const peer = normalizePeer(rawPeer);
      const resolved = resolveToolContext(context);
      const res = await recallMessage(args as any, {
        ...resolved,
        gateway: resolved.gateway,
        sender: resolved.sender,
        peer: peer || resolved.peer,
      });
      return toLosslessJson(res) as any;
    },
  });
}
