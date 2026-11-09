/**
 * 查询活跃 Agent 列表工具 (list_active_agents)
 */

import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools';
import type {
  ListActiveAgentsParams,
  ListActiveAgentsResult,
  ActiveAgentInfo,
} from '../../types/index.js';
import type { ToolExecutionContext } from '../common/context.js';
import { toLosslessJson } from '../../utils/lossless-json.js';
import {
  buildOffsetMessage,
  normalizeLimit,
  normalizeOffset,
  paginateByOffset,
} from '../pagination.js';
import { parsePeerTarget } from '../../gateway/session/agent-runner.js';
import { withInvocationSession } from './common.js';

export const LIST_ACTIVE_AGENTS_DESCRIPTION =
  '按 offset 分页查询当前系统内处于活跃或已实例化的 Agent 会话列表。每条结果返回连续行号、会话的 Session ID、绑定的目标 Peer、目标类型 (user/group)、目标 QQ 号或群号，以及当前是否正处于繁忙思考状态。用于在发起跨会话协同前探查寻址；翻页时按已展示条数自行推算 offset（例如已展示 1~20，则传 offset: 20）。';

const DEFAULT_ACTIVE_AGENTS_LIMIT = 20;
const MAX_ACTIVE_AGENTS_LIMIT = 50;

export async function queryActiveAgents(
  params: ListActiveAgentsParams,
  ctx: ToolExecutionContext
): Promise<ListActiveAgentsResult> {
  const offset = normalizeOffset(params?.offset);
  const limit = normalizeLimit(params?.limit, DEFAULT_ACTIVE_AGENTS_LIMIT, MAX_ACTIVE_AGENTS_LIMIT);
  const sessionManager = ctx.sessionManager;
  if (!sessionManager) {
    return toLosslessJson({
      success: true,
      agents: [],
      total: 0,
      total_matched: 0,
      offset,
      limit,
      has_more: false,
      message: '当前暂无活跃的 QQ Agent 会话。',
    });
  }

  // 权威活跃会话来源：优先使用 getActiveSessionIds / getAllQQSessionIds，后备兼容 getActiveHandleKeys
  const rawActiveSids: string[] =
    typeof (sessionManager as any).getActiveSessionIds === 'function'
      ? (sessionManager as any).getActiveSessionIds()
      : typeof sessionManager.getAllQQSessionIds === 'function'
      ? sessionManager.getAllQQSessionIds()
      : typeof sessionManager.getActiveHandleKeys === 'function'
      ? Array.from(sessionManager.getActiveHandleKeys())
      : [];

  const agents: ActiveAgentInfo[] = [];

  for (const sid of rawActiveSids) {
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

    const name =
      typeof (sessionManager as any).getSessionDisplayName === 'function'
        ? (sessionManager as any).getSessionDisplayName(sid)
        : typeof sessionManager.getPeerName === 'function'
        ? sessionManager.getPeerName(peer)
        : undefined;

    agents.push({
      session_id: sid,
      peer,
      target_type: type,
      target_id: id,
      is_busy: isBusy,
      ...(name ? { name } : {}),
    });
  }

  const page = paginateByOffset(agents, { offset, limit }, {
    defaultLimit: DEFAULT_ACTIVE_AGENTS_LIMIT,
    maxLimit: MAX_ACTIVE_AGENTS_LIMIT,
  });

  const message =
    page.totalMatched === 0
      ? '当前暂无活跃的 QQ Agent 会话。'
      : buildOffsetMessage({
          offset: page.offset,
          returned: page.returned,
          totalMatched: page.totalMatched,
          hasMore: page.hasMore,
          ...(page.nextOffset !== undefined ? { nextOffset: page.nextOffset } : {}),
          unit: '个 Agent',
        });

  return toLosslessJson({
    success: true,
    agents: page.items,
    total: page.returned,
    total_matched: page.totalMatched,
    offset: page.offset,
    limit: page.limit,
    has_more: page.hasMore,
    ...(message ? { message } : {}),
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
      offset: {
        type: 'number',
        description: '起始序号偏移，从 0 开始（0 表示第 1 条）。翻页时按已展示条数自行推算。',
      },
      limit: {
        type: 'number',
        description: '单次返回数量 (默认 20，上限 50)',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => {
        const v = value as unknown as ListActiveAgentsResult;
        if (!v || !v.success) return [{ type: 'text', text: `查询失败: ${v?.error || '未知错误'}` }];
        if (v.total === 0) {
          return [
            {
              type: 'text',
              text: '当前暂无活跃的 QQ Agent 会话。若需向特定好友或群聊主动发起会话，可调用 create_target_agent 并显式指定 target_type（user/group）创建并激活专属 Agent。',
            },
          ];
        }
        const lines: string[] = [`### 当前活跃 QQ Agent 列表 (序号 ${v.offset + 1}~${v.offset + v.total} / 共 ${v.total_matched} 个)`];
        for (let i = 0; i < v.agents.length; i++) {
          const a = v.agents[i];
          const typeLabel = a.target_type === 'user' ? '私聊好友' : '群聊';
          const namePart = a.name ? `【${a.name}】` : '';
          const busyTag = a.is_busy ? ' (正在思考处理中)' : ' (空闲)';
          lines.push(
            `${v.offset + i + 1}. **${typeLabel} Agent**${namePart} (ID: \`${a.target_id}\`)${busyTag}\n  - Session ID: \`${a.session_id}\``
          );
        }
        if (v.has_more) {
          lines.push(
            `\n> 还有 ${v.total_matched - v.offset - v.total} 个未展示。继续浏览请传入 \`offset: ${v.offset + v.total}\`。`
          );
        }
        lines.push(
          `\n> 提示：跨会话协作时，请复制目标 Agent 的 \`Session ID\` 作为 \`target_session_id\` 传入 \`send_agent_message\` 工具发送内部协同消息。`
        );
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    execute: async (args, exec) => {
      const ctx = withInvocationSession(contextGetter(), exec);
      return queryActiveAgents((args || {}) as ListActiveAgentsParams, ctx) as any;
    },
  });
}
