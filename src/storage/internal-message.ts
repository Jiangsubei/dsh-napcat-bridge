/**
 * dsh-napcat-bridge: Agent 内部协同通讯落库记录构造
 *
 * 内部通讯（send_agent_message / create_user_agent 初始使命）不产生 QQ 消息，
 * 但属于 Agent 的上下文资产：上下文压缩后，Agent 需要能通过 read_chat_history
 * 找回「谁给我布置了什么 / 我给谁发过什么」。
 *
 * 本模块只负责把 internal_agent 唤醒包构造成 Messages 表记录：
 * - 目标会话一份（接收方视角：来自哪个会话）；
 * - 发送方会话一份（发送方视角：发往哪个会话）；
 * - 统一身份：sender_name = '内部通讯'、user_id = 'agent:<来源 SessionID>'、
 *   source = 'agent'、self = 0（不是机器人 QQ 发言）。
 */

import type { MessageRecord, WakeupPayload } from '../types/index.js';
import { parseSessionId } from '../gateway/session/id-resolver.js';
import { stableLocalMsgId } from '../utils/local-id.js';

/** 内部通讯在历史中的统一身份标识 */
export const INTERNAL_MESSAGE_SENDER_NAME = '内部通讯';
/** 内部通讯 user_id 前缀，后接来源 Session ID（无来源时为 'system'） */
export const INTERNAL_MESSAGE_USER_PREFIX = 'agent:';
/** 内部通讯 user_id（来源缺失时） */
export const INTERNAL_MESSAGE_SYSTEM_USER = `${INTERNAL_MESSAGE_USER_PREFIX}system`;

export interface BuildInternalMessageOptions {
  /** 构造时刻（毫秒），缺省 Date.now()；payload.timestamp 优先 */
  now?: number;
}

/**
 * 由 internal_agent 唤醒包构造内部通讯记录。
 * - 目标会话记录恒生成（若内容为空则整体不生成）；
 * - 发送方会话记录仅在 from_session 可解析为合法 QQ 会话、且与目标不同时生成；
 * - 同一 (peer, 来源, 时间, 内容) 派生稳定 msg_id，重复投递天然幂等。
 */
export function buildInternalMessageRecords(
  payload: WakeupPayload,
  options: BuildInternalMessageOptions = {}
): MessageRecord[] {
  if (payload.trigger !== 'internal_agent') return [];

  const body = String(payload.content ?? '').trim();
  if (!body) return [];
  if (!payload.peer) return [];

  const time = payload.timestamp || options.now || Date.now();
  const fromSession = String(payload.from_session || '').trim();
  const fromLabel = fromSession || String(payload.from_name || '').trim() || '系统';
  const userId = fromSession ? `${INTERNAL_MESSAGE_USER_PREFIX}${fromSession}` : INTERNAL_MESSAGE_SYSTEM_USER;

  const records: MessageRecord[] = [];

  // 1. 目标会话（接收方）：明确标注来源
  records.push(
    buildRecord({
      peer: payload.peer,
      content: `【内部协同】来源会话: ${fromLabel}\n${body}`,
      user_id: userId,
      time,
    })
  );

  // 2. 发送方会话（发送方）：明确标注去向，避免与目标会话记录混淆
  const parsedFrom = fromSession ? parseSessionId(fromSession) : null;
  const fromPeer = parsedFrom?.peer;
  if (fromPeer && fromPeer !== payload.peer) {
    records.push(
      buildRecord({
        peer: fromPeer,
        content: `【内部协同】发往会话: ${payload.peer}\n${body}`,
        user_id: userId,
        time,
      })
    );
  }

  return records;
}

function buildRecord(input: {
  peer: string;
  content: string;
  user_id: string;
  time: number;
}): MessageRecord {
  return {
    msg_id: stableLocalMsgId(`agent|${input.peer}|${input.user_id}|${input.time}|${input.content}`),
    peer: input.peer,
    user_id: input.user_id,
    sender_name: INTERNAL_MESSAGE_SENDER_NAME,
    time: input.time,
    type: 'text',
    content: input.content,
    raw: JSON.stringify([{ type: 'text', data: { text: input.content } }]),
    file_id: null,
    busid: null,
    local_path: null,
    fingerprint: null,
    recalled: 0,
    self: 0,
    reply_to: null,
    source: 'agent',
  };
}
