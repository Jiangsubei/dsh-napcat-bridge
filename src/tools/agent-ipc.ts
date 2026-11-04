/**
 * src/tools/agent-ipc.ts
 *
 * dsh-napcat-bridge: 跨 Agent 内部协同体系 (Inter-Agent IPC)
 *
 * 包含工具:
 * 1. list_active_agents: 查询当前活跃/已实例化的 Agent 列表及状态
 * 2. create_user_agent: 为指定 QQ 用户创建或激活专属常驻 Agent，传入初始使命指令
 * 3. send_agent_message: Agent 间内部通信信道 (布置任务/同步成果，真人和 QQ 客户端不可见)
 *
 * 架构规范:
 * - 纯内部通信设计，绝不向 QQ 客户端飞线出站
 * - 严格遵循 DSH Lossless JSON 约束 (toLosslessJson 递归剥离所有 undefined)
 * - 目标 Agent 处于运行状态时，复用底层 new_message_behavior 顺畅插话 (steer) 或排队 (queue)
 */

import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools';
import type {
  ListActiveAgentsParams,
  ListActiveAgentsResult,
  ActiveAgentInfo,
  CreateUserAgentParams,
  CreateUserAgentResult,
  SendAgentMessageParams,
  SendAgentMessageResult,
} from '../types/index.js';
import type { ToolExecutionContext } from './index.js';
import { toLosslessJson } from './member-info.js';
import { parsePeerTarget } from '../gateway/session/agent-runner.js';

export { toLosslessJson };

// ==================== 1. list_active_agents (查询活跃 Agent 列表) ====================

export const LIST_ACTIVE_AGENTS_DESCRIPTION =
  '查询当前系统内处于活跃或已实例化的 Agent 会话列表。返回会话的 Session ID、绑定的目标 Peer、目标类型 (user/group)、目标 QQ 号或群号，以及当前是否正处于繁忙思考状态。用于在发起跨会话协同前探查寻址。';

export async function queryActiveAgents(
  params: ListActiveAgentsParams,
  ctx: ToolExecutionContext
): Promise<ListActiveAgentsResult> {
  const sessionManager = ctx.sessionManager;
  if (!sessionManager || typeof sessionManager.getActiveHandleKeys !== 'function') {
    return toLosslessJson({
      success: true,
      agents: [],
      total: 0,
    });
  }

  const activeKeys = Array.from(sessionManager.getActiveHandleKeys());
  const agents: ActiveAgentInfo[] = [];

  for (const sid of activeKeys) {
    if (typeof sid !== 'string' || !sid) continue;

    const peer =
      typeof sessionManager.sessionIdToPeer === 'function'
        ? sessionManager.sessionIdToPeer(sid)
        : sid;

    const { type, id } = parsePeerTarget(peer);
    if (params.target_type && params.target_type !== type) {
      continue;
    }

    const isBusy =
      typeof sessionManager.isSessionBusy === 'function'
        ? Boolean(sessionManager.isSessionBusy(sid))
        : false;

    agents.push({
      session_id: sid,
      peer,
      target_type: type,
      target_id: id,
      is_busy: isBusy,
    });
  }

  return toLosslessJson({
    success: true,
    agents,
    total: agents.length,
  });
}

export function createListActiveAgentsTool(
  contextGetter: () => ToolExecutionContext
): ToolDefinition {
  return defineTool({
    name: 'list_active_agents',
    description: LIST_ACTIVE_AGENTS_DESCRIPTION,
    parameters: {
      target_type: {
        type: 'string',
        enum: ['user', 'group'],
        description: '可选的目标类型筛选: "user" 仅查看私聊用户 Agent, "group" 仅查看群聊 Agent',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => {
        const v = value as unknown as ListActiveAgentsResult;
        if (!v || !v.success) return [{ type: 'text', text: `查询失败: ${v?.error || '未知错误'}` }];
        return [{ type: 'text', text: `当前活跃 Agent 数量: ${v.total}。` }];
      },
    },
    execute: async (args) => {
      const ctx = contextGetter();
      return queryActiveAgents((args || {}) as ListActiveAgentsParams, ctx) as any;
    },
  });
}

// ==================== 2. create_user_agent (创建/唤醒用户专属 Agent) ====================

export const CREATE_USER_AGENT_DESCRIPTION =
  '为指定 QQ 用户创建或激活其专属的常驻 Agent 会话，并注入初始指令或使命背景。返回该 Agent 的 Session ID，便于后续通过 send_agent_message 发送内部消息。适用于跨会话委派任务或需要主动私下联系某位用户。';

export async function createUserAgent(
  params: CreateUserAgentParams,
  ctx: ToolExecutionContext
): Promise<CreateUserAgentResult> {
  if (!params || !params.user_id || String(params.user_id).trim() === '') {
    return toLosslessJson({
      success: false,
      error: '目标用户的 QQ 号不能为空。请传入 user_id。',
    });
  }

  if (!params.initial_message || String(params.initial_message).trim() === '') {
    return toLosslessJson({
      success: false,
      error: '初始消息不能为空。请传入 initial_message 说明委派意图。',
    });
  }

  const sessionManager = ctx.sessionManager;
  if (!sessionManager) {
    return toLosslessJson({
      success: false,
      error: 'SessionManager 尚未就绪，暂时无法创建或唤醒 Agent。',
    });
  }

  const userIdStr = String(params.user_id).trim();
  const peer = `user_${userIdStr}`;
  const sessionId =
    typeof sessionManager.peerToSessionId === 'function'
      ? sessionManager.peerToSessionId(peer)
      : `qq-user-${userIdStr}`;

  try {
    // 1. 初始化或获取目标用户的常驻 Agent
    await sessionManager.getOrCreateAgent(peer);

    // 2. 注入初始指令与唤醒
    const currentSessionId =
      ctx.sessionId ||
      (ctx.peer && typeof sessionManager.peerToSessionId === 'function'
        ? sessionManager.peerToSessionId(ctx.peer)
        : undefined);

    await sessionManager.dispatchWakeup({
      peer,
      trigger: 'internal_agent',
      from_session: currentSessionId,
      reply_to_session: currentSessionId,
      from_user: currentSessionId || 'system',
      from_name: '系统协作总线',
      content: String(params.initial_message).trim(),
      timestamp: Date.now(),
    });

    return toLosslessJson({
      success: true,
      session_id: sessionId,
      peer,
      user_id: userIdStr,
      message: '用户专属 Agent 已就绪并唤醒。',
    });
  } catch (err: any) {
    return toLosslessJson({
      success: false,
      error: `创建或唤醒目标 Agent 失败: ${err?.message || String(err)}`,
    });
  }
}

export function createCreateUserAgentTool(
  contextGetter: () => ToolExecutionContext
): ToolDefinition {
  return defineTool({
    name: 'create_user_agent',
    description: CREATE_USER_AGENT_DESCRIPTION,
    parameters: {
      user_id: {
        type: 'string',
        description: '目标用户的 QQ 号 (必填)',
      },
      initial_message: {
        type: 'string',
        description: '指派给该用户 Agent 的初始指令或使命背景说明 (必填)',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => {
        const v = value as unknown as CreateUserAgentResult;
        if (!v || !v.success) return [{ type: 'text', text: `创建失败: ${v?.error || '未知错误'}` }];
        return [{ type: 'text', text: `用户 Agent [${v.session_id}] 创建/唤醒成功。` }];
      },
    },
    execute: async (args) => {
      const ctx = contextGetter();
      return createUserAgent(args as CreateUserAgentParams, ctx) as any;
    },
  });
}

// ==================== 3. send_agent_message (Agent 间内部通信) ====================

export const SEND_AGENT_MESSAGE_DESCRIPTION =
  '向指定 Session ID 的目标 Agent 发送内部协作消息（用于布置任务、同步上下文或回传成果）。该信道为系统内部总线，外部真实 QQ 用户完全不可见、零打扰。';

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

  // 解析出底层 peer
  const targetPeer =
    typeof sessionManager.sessionIdToPeer === 'function'
      ? sessionManager.sessionIdToPeer(targetSessionId)
      : targetSessionId.startsWith('qq-user-')
      ? `user_${targetSessionId.slice(8)}`
      : targetSessionId.startsWith('qq-group-')
      ? `group_${targetSessionId.slice(9)}`
      : targetSessionId;

  const currentSessionId =
    ctx.sessionId ||
    (ctx.peer && typeof sessionManager.peerToSessionId === 'function'
      ? sessionManager.peerToSessionId(ctx.peer)
      : undefined);

  const fromSession = currentSessionId;

  try {
    await sessionManager.getOrCreateAgent(targetPeer);

    await sessionManager.dispatchWakeup({
      peer: targetPeer,
      trigger: 'internal_agent',
      from_session: fromSession,
      from_user: fromSession || 'agent',
      from_name: '协同 Agent',
      content: String(params.message).trim(),
      timestamp: Date.now(),
    });

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
    execute: async (args) => {
      const ctx = contextGetter();
      return sendAgentMessage(args as SendAgentMessageParams, ctx) as any;
    },
  });
}
