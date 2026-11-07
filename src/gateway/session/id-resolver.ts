/**
 * dsh-napcat-bridge: 会话标识解析、编解码、空缺填补与哈希计算模块
 * 纯函数逻辑，零外部服务依赖。
 */

import * as crypto from 'node:crypto';
import type { ParsedSessionId } from './types.js';

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
 * 从会话标题中反向提取显示名称（用于“名字未知时不得降级覆盖已有标题”）。
 * 兼容 "群聊: 名称 8000000001 #1" 与 "群聊: 8000000001 #1" 两种形态；
 * 无法提取出名称时返回 undefined。
 */
export function extractNameFromSessionTitle(
  title: string | undefined,
  peer: string
): string | undefined {
  if (!title || typeof title !== 'string') return undefined;

  const stripped = title
    .replace(/^(私聊|群聊|QQ):\s*/, '')
    .replace(/\s+#\d+.*$/, '')
    .trim();
  if (!stripped) return undefined;

  const idMatch = peer.match(/^(?:group_|user_|qq-group-|qq-user-)([^-]+)/);
  const peerId = idMatch?.[1];
  let name = stripped;
  if (peerId && name.endsWith(peerId)) {
    name = name.slice(0, -peerId.length).trim();
  }
  return name || undefined;
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

export {
  formatTimeOnly,
  formatSenderString,
  resolveChannelInfo,
  formatMsgIdString,
  formatQuotedString,
  formatMessageBody,
  formatExternalPrompt,
  formatWakeupPrompt,
} from '../external-prompt.js';

