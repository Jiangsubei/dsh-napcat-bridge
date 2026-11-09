/**
 * Agent 间内部通信工具 (send_agent_message)
 */

import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { SendAgentMessageParams, SendAgentMessageResult } from '../../types/index.js';
import type { ToolExecutionContext } from '../common/context.js';
import { toLosslessJson } from '../../utils/lossless-json.js';
import { parseSessionId } from '../../gateway/session/id-resolver.js';
import { withInvocationSession } from './common.js';

export const SEND_AGENT_MESSAGE_DESCRIPTION =
  '向指定 Session ID 的目标 Agent 发送内部协作消息（用于布置任务、同步上下文或回传成果）。该信道为系统内部总线，外部真实 QQ 用户完全不可见、零打扰。协作遵循「回执即止」：被派发方完成任务后回执一次即可；发起方收到回执后，若用户没有新的明确要求，不要再回复确认、致谢或追问。';

export async function sendAgentMessage(
  params: SendAgentMessageParams,
  ctx: ToolExecutionContext
): Promise<SendAgentMessageResult> {
  if (!params || !params.target_session_id || String(params.target_session_id).trim() === '') {
    return toLosslessJson({
      success: false,
      error: '目标 Session ID 不能为空。请传入 target_session_id。',
    });
  }

  if (!params.message || String(params.message).trim() === '') {
    return toLosslessJson({
      success: false,
      error: '内部消息内容不能为空。请传入 message。',
    });
  }

  const sessionManager = ctx.sessionManager;
  if (!sessionManager) {
    return toLosslessJson({
      success: false,
      error: 'SessionManager 尚未就绪，无法发送内部 Agent 消息。',
    });
  }

  const targetSessionId = String(params.target_session_id).trim();

  // 0. 目标 Session ID 必须显式匹配 QQ 会话规范，绝不允许把任意字符串当作 peer 再套前缀。
  const parsedTarget = parseSessionId(targetSessionId);
  if (!parsedTarget) {
    return toLosslessJson({
      success: false,
      error: `目标 Session ID [${targetSessionId}] 不是合法的 QQ 会话标识。请调用 list_active_agents 获取目标 Agent 的完整 Session ID（如 "qq-user-1000000001" 或 "qq-group-8000000001"）后重试。`,
    });
  }

  // 1. 目标会话状态校验：过滤已被归档或标记为僵尸/删除的会话
  if (
    typeof sessionManager.isSessionArchived === 'function' &&
    sessionManager.isSessionArchived(targetSessionId)
  ) {
    return toLosslessJson({
      success: false,
      error: `目标会话 [${targetSessionId}] 已被归档。请调用 list_active_agents 重新查询当前最新活跃会话后重试。`,
    });
  }

  if (
    typeof sessionManager.isSessionZombie === 'function' &&
    sessionManager.isSessionZombie(targetSessionId)
  ) {
    return toLosslessJson({
      success: false,
      error: `目标会话 [${targetSessionId}] 已失效或被删除。请调用 list_active_agents 重新查询当前活跃会话后重试。`,
    });
  }

  // 解析出底层 peer
  const targetPeer = parsedTarget.peer;

  // 2. 核心校验：确保 targetSessionId 仍是该 Peer 最新的活跃会话，防止向已被轮换的旧版本会话发送消息
  if (typeof sessionManager.peerToSessionId === 'function') {
    const latestSid = sessionManager.peerToSessionId(targetPeer);
    if (latestSid && latestSid !== targetSessionId) {
      return toLosslessJson({
        success: false,
        error: `目标会话 [${targetSessionId}] 已不是最新活跃会话（该对象当前最新活跃会话为: ${latestSid}）。请调用 list_active_agents 重新查询最新状态，并向最新的 Session ID 发送消息。`,
      });
    }
  }

  // 3. 校验目标会话是否处于活跃状态（已创建/已注册 handle）
  const hasHandle =
    typeof sessionManager.hasActiveHandle === 'function' &&
    sessionManager.hasActiveHandle(targetSessionId);
  const isActiveOrPresent =
    typeof sessionManager.isSessionActiveOrPresent === 'function' &&
    sessionManager.isSessionActiveOrPresent(targetSessionId);

  if (!hasHandle && !isActiveOrPresent) {
    return toLosslessJson({
      success: false,
      error: `目标 Agent 会话 [${targetSessionId}] 尚未激活或不存在。若需要为该目标建立专属会话，请先调用 create_target_agent（target_type 按 user/group 显式指定）创建并激活。`,
    });
  }

  const currentSessionId =
    ctx.sessionId ||
    (ctx.peer && typeof sessionManager.peerToSessionId === 'function'
      ? sessionManager.peerToSessionId(ctx.peer)
      : undefined);

  const fromSession = currentSessionId;

  try {
    // 建会话前预热 peer 名称（群名/好友昵称），避免内部派发创建的会话标题只有号码
    if (typeof sessionManager.ensurePeerName === 'function') {
      try {
        await sessionManager.ensurePeerName(targetPeer);
      } catch {}
    }

    await sessionManager.getOrCreateAgent(targetPeer);

    const hub = sessionManager.getSystemEventHub?.();
    if (hub) {
      await hub.dispatchAgentIpc({
        targetPeer,
        fromSessionId: fromSession || '其他工作区',
        message: String(params.message).trim(),
        timestamp: Date.now(),
      });
    } else {
      await sessionManager.dispatchWakeup({
        peer: targetPeer,
        trigger: 'internal_agent',
        from_session: fromSession,
        from_user: fromSession || 'agent',
        from_name: '协同 Agent',
        content: String(params.message).trim(),
        timestamp: Date.now(),
      });
    }

    return toLosslessJson({
      success: true,
      delivered: true,
      target_session_id: targetSessionId,
      message: '消息已成功投递至目标 Agent 上下文。',
    });
  } catch (err: any) {
    return toLosslessJson({
      success: false,
      error: `发送内部 Agent 消息失败: ${err?.message || String(err)}`,
    });
  }
}

export function createSendAgentMessageTool(
  contextGetter: () => ToolExecutionContext
): ToolDefinition {
  return defineTool({
    name: 'send_agent_message',
    description: SEND_AGENT_MESSAGE_DESCRIPTION,
    parameters: {
      target_session_id: {
        type: 'string',
        description: '目标 Agent 的 Session ID (如 "qq-user-1000000001" 或 "qq-group-8000000001")',
      },
      message: {
        type: 'string',
        description: '内部协作消息内容，清晰说明协同意图或交付成果 (外部 QQ 用户不可见)',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => {
        const v = value as unknown as SendAgentMessageResult;
        if (!v || !v.success) return [{ type: 'text', text: `投递失败: ${v?.error || '未知错误'}` }];
        return [{ type: 'text', text: `内部消息成功送达目标 Agent [${v.target_session_id}]。` }];
      },
    },
    execute: async (args, exec) => {
      const ctx = withInvocationSession(contextGetter(), exec);
      return sendAgentMessage(args as SendAgentMessageParams, ctx) as any;
    },
  });
}
