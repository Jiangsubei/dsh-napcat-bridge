/**
 * dsh-napcat-bridge: 会话标识解析、编解码、空缺填补与哈希计算模块
 * 纯函数逻辑，零外部服务依赖。
 */

import * as crypto from 'node:crypto';
import type { ParsedSessionId } from './types.js';
import type { WakeupPayload } from '../../types/index.js';
import { formatDateTime } from '../../storage/database.js';

/**
 * 解析 DSH SessionId（支持基础版本 qq-user-123 / qq-user-123-2、多轮归档版本 qq-user-123-r1-1 及带短哈希防撞版本）
 */
export function parseSessionId(sessionId: string): ParsedSessionId | null {
  const groupMatch = sessionId.match(/^qq-group-([0-9a-zA-Z_]+?)(?:-r(\d+))?(?:-(\d+))?(?:-([0-9a-fA-F]{4,16}))?$/);
  if (groupMatch) {
    const id = groupMatch[1];
    const round = groupMatch[2] ? parseInt(groupMatch[2], 10) : 0;
    const version = groupMatch[3] ? parseInt(groupMatch[3], 10) : 1;
    const hash = groupMatch[4] || undefined;
    return {
      peer: `group_${id}`,
      id,
      round,
      version,
      ...(hash ? { hash } : {}),
      isGroup: true,
    };
  }
  const userMatch = sessionId.match(/^qq-user-([0-9a-zA-Z_]+?)(?:-r(\d+))?(?:-(\d+))?(?:-([0-9a-fA-F]{4,16}))?$/);
  if (userMatch) {
    const id = userMatch[1];
    const round = userMatch[2] ? parseInt(userMatch[2], 10) : 0;
    const version = userMatch[3] ? parseInt(userMatch[3], 10) : 1;
    const hash = userMatch[4] || undefined;
    return {
      peer: `user_${id}`,
      id,
      round,
      version,
      ...(hash ? { hash } : {}),
      isGroup: false,
    };
  }
  return null;
}

/**
 * 生成 6 位十六进制短哈希防撞后缀
 */
export function generateSessionHash(): string {
  return crypto.randomBytes(3).toString('hex');
}

/**
 * 从当前未归档活跃会话的版本列表中，寻找最小未占用正整数编号 (First Missing Positive)
 * 例如活跃集合为 [3]，返回 1；活跃集合为 [1, 3]，返回 2；活跃集合为 [1, 2, 3]，返回 4。
 */
export function findSmallestAvailableVersion(activeVersions: Iterable<number>): number {
  const set = new Set(activeVersions);
  let v = 1;
  while (set.has(v)) {
    v++;
  }
  return v;
}

/**
 * 构造符合命名规范的 SessionId (支持短哈希后缀)
 */
export function buildSessionId(
  baseId: string,
  round: number,
  version: number,
  hash?: string
): string {
  const hashSuffix = hash ? `-${hash}` : '';
  if (round === 0) {
    if (hash) {
      return `${baseId}-${version}${hashSuffix}`;
    }
    return version === 1 ? baseId : `${baseId}-${version}`;
  }
  return `${baseId}-r${round}-${version}${hashSuffix}`;
}

/**
 * 将 QQ peer 转换为 SessionId 基础前缀 baseId
 */
export function peerToBaseId(peer: string): string {
  if (peer.startsWith('group_')) {
    return `qq-group-${peer.slice(6)}`;
  } else if (peer.startsWith('user_')) {
    return `qq-user-${peer.slice(5)}`;
  } else {
    return `qq-${peer}`;
  }
}

/**
 * 将 DSH SessionId 反向解析为 QQ Peer（支持自动剥离版本/轮次后缀）
 */
export function sessionIdToPeer(sessionId: string): string {
  const parsed = parseSessionId(sessionId);
  if (parsed) {
    return parsed.peer;
  }
  if (sessionId.startsWith('group_') || sessionId.startsWith('user_')) {
    return sessionId;
  }
  return sessionId;
}

/**
 * 判断 SessionId 是否属于 QQ 会话
 */
export function isQQSession(sessionId: string): boolean {
  return sessionId.startsWith('qq-group-') || sessionId.startsWith('qq-user-') || sessionId.startsWith('qq-');
}

/**
 * 根据 peer、sessionId 与群名/昵称格式化会话标题 (支持多轮归档格式如 #1 (1))
 */
export function formatSessionTitle(
  peer: string,
  sessionId: string,
  name?: string
): string {
  let versionNum = '1';
  let roundNum = 0;
  const parsed = parseSessionId(sessionId);
  if (parsed) {
    versionNum = String(parsed.version);
    roundNum = parsed.round;
  }

  const tag = roundNum > 0 ? `#${versionNum} (${roundNum})` : `#${versionNum}`;

  if (peer.startsWith('group_') || peer.startsWith('qq-group-')) {
    const groupId = peer.replace(/^(group_|qq-group-)/, '').split('-')[0];
    const displayName = name ? `${name} ` : '';
    return `群聊: ${displayName}${groupId} ${tag}`;
  } else if (peer.startsWith('user_') || peer.startsWith('qq-user-')) {
    const userId = peer.replace(/^(user_|qq-user-)/, '').split('-')[0];
    const displayName = name ? `${name} ` : '';
    return `私聊: ${displayName}${userId} ${tag}`;
  } else {
    const displayName = name ? `${name} ` : '';
    return `QQ: ${displayName}${peer} ${tag}`;
  }
}

/**
 * 组装发给 Agent 的唤醒文本 (Wakeup Prompt)
 * 格式与存储层 / 历史记录检索格式对齐，包含本地化时间戳 [YYYY-MM-DD HH:mm:ss]
 */
export function formatWakeupPrompt(payload: WakeupPayload): string {
  const isGroup = payload.peer.startsWith('group_') || payload.peer.startsWith('qq-group-');
  const groupId = isGroup
    ? payload.peer.replace(/^(group_|qq-group-)/, '').split('-')[0]
    : undefined;
  const fromUser = payload.from_user || (payload as any).userId || '';
  const fromName = payload.from_name || (payload as any).senderName || '';

  const senderStr = fromName
    ? `${fromName} (QQ: ${fromUser})`
    : fromUser
      ? `QQ: ${fromUser}`
      : '未知用户';

  const timeStr = payload.timestamp
    ? formatDateTime(payload.timestamp)
    : formatDateTime(Date.now());

  const channelStr = isGroup ? `[QQ群聊: ${groupId}]` : `[QQ私聊]`;
  const headerTime = timeStr ? ` [${timeStr}]` : '';

  if (payload.trigger === 'poke') {
    return `${channelStr}${headerTime} 用户 ${senderStr} 戳了戳你。`;
  }

  if (payload.trigger === 'proactive' && payload.sub_trigger === 'idle') {
    return `${channelStr}${headerTime}\n（当前群聊已较长时间没有新发言，你正主动在群里发起一条消息。你需要先调用 read_chat_history 工具查询此前群内最近的消息记录以补充上下文再发言。切勿在回复中透露任何系统事件、潜水超时或定时任务等后台痕迹。）`;
  }

  if (payload.trigger === 'proactive') {
    let prompt = `${channelStr}${headerTime} 发送者: ${senderStr}\n`;
    prompt += `（你正在主动参与该群聊的交流。你需要先调用 read_chat_history 工具查询群内最近的消息记录以补充上下文再回复。不要在发言中透露任何系统提示或触发机制的痕迹。）\n`;
    if (payload.quoted) {
      let quotedSender = '';
      if (payload.quoted.from_name && payload.quoted.user_id) {
        quotedSender = `${payload.quoted.from_name} (QQ: ${payload.quoted.user_id})`;
      } else if (payload.quoted.from_name) {
        quotedSender = payload.quoted.from_name;
      } else if (payload.quoted.user_id) {
        quotedSender = `QQ: ${payload.quoted.user_id}`;
      } else if (payload.quoted.msg_id) {
        quotedSender = `消息ID: ${payload.quoted.msg_id}`;
      } else {
        quotedSender = '历史消息';
      }
      prompt += `[引用回复 ${quotedSender}${payload.quoted.text ? `: "${payload.quoted.text}"` : ''}]\n`;
    }
    prompt += payload.content;
    return prompt;
  }

  let prompt = `${channelStr}${headerTime} 发送者: ${senderStr}\n`;

  if (payload.quoted) {
    let quotedSender = '';
    if (payload.quoted.from_name && payload.quoted.user_id) {
      quotedSender = `${payload.quoted.from_name} (QQ: ${payload.quoted.user_id})`;
    } else if (payload.quoted.from_name) {
      quotedSender = payload.quoted.from_name;
    } else if (payload.quoted.user_id) {
      quotedSender = `QQ: ${payload.quoted.user_id}`;
    } else if (payload.quoted.msg_id) {
      quotedSender = `消息ID: ${payload.quoted.msg_id}`;
    } else {
      quotedSender = '历史消息';
    }
    prompt += `[引用回复 ${quotedSender}${payload.quoted.text ? `: "${payload.quoted.text}"` : ''}]\n`;
  }

  prompt += payload.content;
  return prompt;
}
