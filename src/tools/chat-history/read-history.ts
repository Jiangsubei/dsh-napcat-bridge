/**
 * dsh-napcat-bridge: 读历史记录工具 (read_chat_history)
 */

import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { ReadChatHistoryParams, ReadChatHistoryResult } from '../../types/index.js';
import type { MessageDatabase } from '../../storage/database.js';
import { formatSenderString } from '../../gateway/external-prompt.js';
import {
  type ContextSource,
  getGlobalToolContext,
  resolveToolContext,
  normalizePeer,
} from '../common/context.js';
import { toLosslessJson } from '../../utils/lossless-json.js';
import { normalizeLimit, normalizeOffset } from '../pagination.js';

export type { ReadChatHistoryParams, ReadChatHistoryResult };
export { normalizePeer };

/**
 * 6.1 读历史记录工具 (read_chat_history)
 * 检索当前群聊或私聊的历史聊天记录，支持多维度组合筛选。
 */
export async function readChatHistory(
  peerOrParams: string | (ReadChatHistoryParams & { peer?: string }),
  paramsOrDb?: ReadChatHistoryParams | MessageDatabase,
  maybeDb?: MessageDatabase
): Promise<ReadChatHistoryResult> {
  let peer = '';
  let params: ReadChatHistoryParams = {};
  let db = maybeDb || getGlobalToolContext().db;

  if (typeof peerOrParams === 'string') {
    peer = normalizePeer(peerOrParams);
    if (paramsOrDb && typeof (paramsOrDb as any).readHistory === 'function') {
      db = paramsOrDb as MessageDatabase;
    } else {
      params = (paramsOrDb as ReadChatHistoryParams) || {};
    }
  } else if (typeof peerOrParams === 'object' && peerOrParams !== null) {
    peer = normalizePeer(peerOrParams.peer || getGlobalToolContext().peer || '');
    params = peerOrParams;
    if (paramsOrDb && typeof (paramsOrDb as any).readHistory === 'function') {
      db = paramsOrDb as MessageDatabase;
    }
  }

  if (!db) {
    return {
      messages: [],
      total: 0,
      total_matched: 0,
      offset: normalizeOffset(params.offset),
      limit: normalizeLimit(params.limit, 20, 100),
      has_more: false,
      message: '数据库不可用，暂时无法读取聊天记录。',
    };
  }

  // 默认只查真实 QQ 消息：内部协同通讯需显式传 source='agent' 才展示；
  // source='all' 表示两者都要。
  if (params.source === 'all') {
    const { source: _all, ...rest } = params;
    params = rest;
  } else if (params.source === undefined) {
    params = { ...params, source: 'qq' };
  }

  return db.readHistory(peer, params);
}

/**
 * 格式化聊天记录为带跨页连续序号的 Markdown 文本
 */
export function renderChatHistoryText(result: ReadChatHistoryResult): string {
  if (!result || !Array.isArray(result.messages) || result.messages.length === 0) {
    return result?.message || '未查询到符合条件的聊天记录。';
  }
  const offset = result.offset ?? 0;
  const totalMatched = result.total_matched ?? result.total;
  const lines: string[] = [
    `共匹配 ${totalMatched} 条消息（序号 ${offset + 1}~${offset + result.messages.length}，本次返回 ${result.messages.length} 条）:`,
  ];
  for (let i = 0; i < result.messages.length; i++) {
    const m = result.messages[i];
    const selfTag = m.self ? ' [自身发言]' : '';
    const recalledTag = m.recalled ? ' [已撤回]' : '';
    lines.push(
      `${offset + i + 1}. [${m.formatted_time}] ${formatSenderString(m.sender_name, m.user_id)}${selfTag}${recalledTag} | msg_id: ${m.msg_id} | ${m.type}`
    );
    if (m.content) lines.push(`   ${m.content}`);
  }
  if (result.has_more) {
    lines.push(
      `\n> 还有 ${totalMatched - offset - result.messages.length} 条未展示。继续浏览请传入 \`offset: ${offset + result.messages.length}\`。`
    );
  } else if (result.message) {
    lines.push(`\n> ${result.message}`);
  }
  return lines.join('\n');
}

export function createReadChatHistoryTool(context?: ContextSource): ToolDefinition {
  return defineTool({
    name: 'read_chat_history',
    description:
      '检索当前会话的本地历史聊天记录。在群聊中查询两条消息之间有什么其他的消息，需要查询指定的时间段，建议在两条消息之间间隔超过 5 分钟时调用，根据聊天节奏决定是否每次查询；亦用于指代不明追溯前情、响应用户查询/复述历史发言，或为贴表情/收藏表情等下游工具捞取目标消息的 message_id。查找群文件请使用专用的 list_group_files。',
    parameters: {
      peer: {
        type: 'string',
        description: '可选目标会话标识 (如 "group_8000000001" 或 "user_1000000001")。缺省时默认为当前会话。',
      },
      keyword: { type: 'string', description: '按消息文本内容关键词模糊搜索' },
      sender_name: { type: 'string', description: '按发送者昵称或群名片模糊搜索' },
      user_id: { type: 'string', description: '按指定发送者 QQ 号精确筛选（内部通讯为 agent:<来源SessionID>，无来源时为 agent:system）' },
      type: {
        type: 'string',
        description:
          "按消息类型筛选，如 'text'(文本), 'image'(图片), 'sticker'(表情包), 'file'(私聊文件), 'group_file'(群文件), 'forward'(合并转发), 'poke'(戳一戳)",
      },
      since: {
        type: 'string',
        description:
          "起始时间：支持毫秒时间戳数字、相对时间 (如 '30m', '2h', '1d', '7d')、裸时间 (如 '19:00', '19:00:00') 或自然日期时间字符串 (如 '10-30 19:00', '2026-10-30 19:00')",
      },
      until: {
        type: 'string',
        description: "截止时间：支持毫秒时间戳数字、相对时间、裸时间 (如 '20:00') 或自然日期时间字符串",
      },
      relative: {
        type: 'string',
        description: "快捷相对时间窗口：检索过去指定时间段内的消息 (如 '1h', '6h', '1d', '7d')",
      },
      has_file: { type: 'boolean', description: '是否仅筛选带有文件/图片/媒体附件的消息' },
      reply_to: {
        oneOf: [{ type: 'number' }, { type: 'string' }],
        description: '查询引用了指定 msg_id 的直接回复消息（支持数字或数字字符串）',
      },
      exclude_self: { type: 'boolean', description: '是否排除机器人自身的发言 (默认 false)' },
      self_only: { type: 'boolean', description: '是否仅查询机器人自身的发言 (默认 false)' },
      source: {
        type: 'string',
        enum: ['qq', 'agent', 'all'],
        description:
          "按消息来源筛选：默认（不传）仅返回真实 QQ 消息；'agent' 仅返回 Agent 内部协同通讯（sender_name 为「内部通讯」，user_id 形如 agent:<来源SessionID>）；'all' 返回两者。",
      },
      limit: { type: 'number', description: '返回最大条数 (默认 20，上限 100)' },
      offset: {
        type: 'number',
        description: '起始序号偏移，从 0 开始（0 表示第 1 条）。翻页时按已展示条数自行推算。',
      },
      order: { type: 'string', enum: ['asc', 'desc'], description: "时间排序 (默认 'desc' 倒序，取最新消息)" },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [
        { type: 'text', text: renderChatHistoryText(value as unknown as ReadChatHistoryResult) },
      ],
    },
    async execute(args, exec) {
      const session = (exec.agent as any)?.session;
      const rawPeer = session?.id || 'common';
      const currentPeer = normalizePeer(rawPeer);
      // 显式传入的 peer 优先于当前会话：支持在私聊中只读查看某个群/其他好友的近期消息
      const requestedPeer =
        typeof (args as any)?.peer === 'string' && String((args as any).peer).trim()
          ? normalizePeer(String((args as any).peer).trim())
          : currentPeer;
      const { peer: _peer, ...params } = (args || {}) as any;
      const resolved = resolveToolContext(context);
      const res = await readChatHistory(requestedPeer, params, resolved.db || undefined);
      return toLosslessJson(res) as any;
    },
  });
}
