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

    // 过滤已被归档或僵尸的会话
    if (typeof sessionManager.isSessionArchived === 'function' && sessionManager.isSessionArchived(sid)) {
      continue;
    }
    if (typeof sessionManager.isSessionZombie === 'function' && sessionManager.isSessionZombie(sid)) {
      continue;
    }

    const peer =
      typeof sessionManager.sessionIdToPeer === 'function'
        ? sessionManager.sessionIdToPeer(sid)
        : sid;

    // 过滤已被新版本替换的陈旧会话，确保只列出当前 Peer 最新的活跃会话
    if (typeof sessionManager.peerToSessionId === 'function') {
      const latestSid = sessionManager.peerToSessionId(peer);
      if (latestSid && latestSid !== sid) {
        continue;
      }
    }

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
  '为指定 QQ 用户创建其专属的常驻 Agent 会话，并注入初始使命指令。注意：如果该用户此前已存在专属 Agent，本工具将直接返回其 Session ID 并提示已存在，不会重复发送消息，后续请直接调用 send_agent_message 进行通信；仅在该用户此前尚无专属 Agent 时，本工具才会真正创建并注入初始消息。';

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

  // 1. 判断目标用户的 Agent 是否已存在（且未归档、未删除）
  const isArchived =
    typeof sessionManager.isSessionArchived === 'function' && sessionManager.isSessionArchived(sessionId);
  const isZombie =
    typeof sessionManager.isSessionZombie === 'function' && sessionManager.isSessionZombie(sessionId);

  const isExisting =
    !isArchived &&
    !isZombie &&
    ((typeof sessionManager.hasActiveHandle === 'function' && sessionManager.hasActiveHandle(sessionId)) ||
      (typeof sessionManager.isSessionActiveOrPresent === 'function' &&
        sessionManager.isSessionActiveOrPresent(sessionId)));

  if (isExisting) {
    return toLosslessJson({
      success: true,
      created: false,
      session_id: sessionId,
      peer,
      user_id: userIdStr,
      message: `该用户已存在专属 Agent (Session ID: ${sessionId})。未重复注入初始消息。请直接调用 send_agent_message 工具向该 Session ID 发送内部消息。`,
    });
  }

  try {
    // 2. 目标用户此前无专属 Agent，首次创建并初始化
    await sessionManager.getOrCreateAgent(peer);

    // 3. 注入初始使命指令与唤醒
    const currentSessionId =
      ctx.sessionId ||
      (ctx.peer && typeof sessionManager.peerToSessionId === 'function'
        ? sessionManager.peerToSessionId(ctx.peer)
        : undefined);

    await sessionManager.dispatchWakeup({
      peer,
      trigger: 'internal_agent',
      from_session: currentSessionId,
      from_user: currentSessionId || 'system',
      from_name: '系统协作总线',
      content: String(params.initial_message).trim(),
      timestamp: Date.now(),
    });

    return toLosslessJson({
      success: true,
      created: true,
      session_id: sessionId,
      peer,
      user_id: userIdStr,
      message: '用户专属 Agent 创建成功，已注入初始消息并唤醒。',
    });
  } catch (err: any) {
    return toLosslessJson({
      success: false,
      error: `创建目标 Agent 失败: ${err?.message || String(err)}`,
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
        if (v.created === false) {
          return [{ type: 'text', text: `用户 Agent 已存在 [${v.session_id}]。未重复发消息，请直接调用 send_agent_message 发送内部消息。` }];
        }
        return [{ type: 'text', text: `用户 Agent [${v.session_id}] 创建成功并已注入初始消息。` }];
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
  const targetPeer =
    typeof sessionManager.sessionIdToPeer === 'function'
      ? sessionManager.sessionIdToPeer(targetSessionId)
      : targetSessionId.startsWith('qq-user-')
      ? `user_${targetSessionId.slice(8)}`
      : targetSessionId.startsWith('qq-group-')
      ? `group_${targetSessionId.slice(9)}`
      : targetSessionId;

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
      error: `目标 Agent 会话 [${targetSessionId}] 尚未激活或不存在。若需要为该用户建立专属会话，请先调用 create_user_agent 创建并激活。`,
    });
  }

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
