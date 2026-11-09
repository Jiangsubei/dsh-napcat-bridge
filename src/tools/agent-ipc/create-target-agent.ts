/**
 * 创建/唤醒用户或群聊 Agent 工具 (create_target_agent)
 */

import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { CreateTargetAgentParams, CreateTargetAgentResult } from '../../types/index.js';
import type { ToolExecutionContext } from '../common/context.js';
import { toLosslessJson } from '../../utils/lossless-json.js';
import { withInvocationSession } from './common.js';

export const CREATE_TARGET_AGENT_DESCRIPTION =
  '为指定 QQ 用户或群聊创建并激活其常驻 Agent 会话，注入初始使命指令。target_type 必须显式声明为 "user"（QQ 私聊用户，含临时会话）或 "group"（QQ 群聊），target_id 为目标 QQ 号或群号。仅当用户明确指定了目标对象（谁 / 哪个群）且需要主动发起会话时才调用；不要自行猜测或批量创建会话。注意：如果该目标此前已存在专属 Agent，本工具将直接返回其 Session ID 并提示已存在，不会重复发送消息，后续请直接调用 send_agent_message 进行通信。目标 Agent 完成使命后回执一次即视为闭环；发起方收到回执后，若用户没有新的明确要求，无需再次回复确认或致谢。';

export async function createTargetAgent(
  params: CreateTargetAgentParams,
  ctx: ToolExecutionContext
): Promise<CreateTargetAgentResult> {
  const targetType = params?.target_type;
  if (targetType !== 'user' && targetType !== 'group') {
    return toLosslessJson({
      success: false,
      error:
        'target_type 必须显式指定为 "user"（QQ 私聊用户）或 "group"（QQ 群聊），以避免把群号误当 QQ 号建成私聊会话。',
    });
  }

  const targetIdStr = params?.target_id === undefined ? '' : String(params.target_id).trim();
  if (!targetIdStr) {
    return toLosslessJson({
      success: false,
      error: `目标 ${targetType === 'group' ? '群号' : 'QQ 号'}不能为空。请传入 target_id。`,
    });
  }
  if (!/^\d+$/.test(targetIdStr)) {
    return toLosslessJson({
      success: false,
      error: `目标 ID [${targetIdStr}] 非法：必须为纯数字的 ${targetType === 'group' ? '群号' : 'QQ 号'}。`,
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

  const peer = `${targetType}_${targetIdStr}`;
  const sessionId =
    typeof sessionManager.peerToSessionId === 'function'
      ? sessionManager.peerToSessionId(peer)
      : `qq-${targetType}-${targetIdStr}`;

  // 1. 判断目标 Agent 是否已存在（且未归档、未删除）
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
      target_type: targetType,
      target_id: targetIdStr,
      message: `该目标已存在专属 Agent (Session ID: ${sessionId})。未重复注入初始消息。请直接调用 send_agent_message 工具向该 Session ID 发送内部消息。`,
    });
  }

  try {
    // 2. 目标此前无专属 Agent，首次创建并初始化
    //    先解析昵称，确保首建会话标题即带群名/好友昵称，绝不以纯号码起步
    if (typeof sessionManager.ensurePeerName === 'function') {
      try {
        await sessionManager.ensurePeerName(peer);
      } catch {}
    }
    await sessionManager.getOrCreateAgent(peer);

    // 3. 注入初始使命指令与唤醒
    const currentSessionId =
      ctx.sessionId ||
      (ctx.peer && typeof sessionManager.peerToSessionId === 'function'
        ? sessionManager.peerToSessionId(ctx.peer)
        : undefined);

    const hub = sessionManager.getSystemEventHub?.();
    if (hub) {
      await hub.dispatchAgentIpc({
        targetPeer: peer,
        fromSessionId: currentSessionId || '其他工作区',
        message: String(params.initial_message).trim(),
        isInitialDirective: true,
        timestamp: Date.now(),
      });
    } else {
      await sessionManager.dispatchWakeup({
        peer,
        trigger: 'internal_agent',
        from_session: currentSessionId,
        from_user: currentSessionId || 'system',
        from_name: '系统协作总线',
        content: String(params.initial_message).trim(),
        timestamp: Date.now(),
      });
    }

    return toLosslessJson({
      success: true,
      created: true,
      session_id: sessionId,
      peer,
      target_type: targetType,
      target_id: targetIdStr,
      message: `${targetType === 'group' ? '群聊' : '用户'}专属 Agent 创建成功，已注入初始消息并唤醒。`,
    });
  } catch (err: any) {
    return toLosslessJson({
      success: false,
      error: `创建目标 Agent 失败: ${err?.message || String(err)}`,
    });
  }
}

export function createCreateTargetAgentTool(
  contextGetter: () => ToolExecutionContext
): ToolDefinition {
  return defineTool({
    name: 'create_target_agent',
    description: CREATE_TARGET_AGENT_DESCRIPTION,
    parameters: {
      target_type: {
        type: 'string',
        enum: ['user', 'group'],
        description:
          '目标类型 (必填)：user = QQ 私聊用户（含临时会话），group = QQ 群聊。绝不能把群号当作 user 传入。',
      },
      target_id: {
        type: 'string',
        description: '目标 QQ 号或群号 (必填，纯数字)',
      },
      initial_message: {
        type: 'string',
        description: '指派给该目标 Agent 的初始指令或使命背景说明 (必填)',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => {
        const v = value as unknown as CreateTargetAgentResult;
        if (!v || !v.success) return [{ type: 'text', text: `创建失败: ${v?.error || '未知错误'}` }];
        const typeLabel = v.target_type === 'group' ? '群聊' : '用户';
        if (v.created === false) {
          return [{ type: 'text', text: `${typeLabel} Agent 已存在 [${v.session_id}]。未重复发消息，请直接调用 send_agent_message 发送内部消息。` }];
        }
        return [{ type: 'text', text: `${typeLabel} Agent [${v.session_id}] 创建成功并已注入初始消息。` }];
      },
    },
    execute: async (args, exec) => {
      const ctx = withInvocationSession(contextGetter(), exec);
      return createTargetAgent(args as CreateTargetAgentParams, ctx) as any;
    },
  });
}
