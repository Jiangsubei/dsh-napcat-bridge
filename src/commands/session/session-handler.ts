/**
 * dsh-napcat-bridge: /会话 命令处理器
 */

import { formatSessionTitle } from '../../gateway/session.js';
import type { CommandContext, CommandResult } from '../types.js';

export async function handleSessionCommand(
  args: string,
  context: CommandContext
): Promise<CommandResult> {
  const sm = context.sessionManager;
  if (!sm) {
    return {
      handled: true,
      success: false,
      error: '执行 /会话 失败: 当前环境缺少 SessionManager 服务',
    };
  }
  const peer = sm.sessionIdToPeer(context.session.id);
  const peerName = sm.getPeerName(peer);
  const sessions = sm.listPeerSessionIds(peer); // 升序：旧→新

  if (!args) {
    const currentSid = sm.peerToSessionId(peer);
    const lines = [...sessions].reverse().map((sid, i) => {
      const num = sessions.length - i;
      const isCurrent = sid === currentSid ? ' [当前]' : '';
      const title = formatSessionTitle(peer, sid, peerName);
      return `${num}.${isCurrent} ${title} (${sid})`;
    });
    const peerDesc = formatSessionTitle(peer, currentSid, peerName).replace(/#\d+.*$/, '').trim();
    return {
      handled: true,
      success: true,
      reply: `历史会话列表（${peerDesc}）：\n${lines.join('\n')}\n\n切换方法：\n- 按序号切换：/会话 <序号>\n- 按标题切换：/会话 <标题>`,
    };
  }

  let targetSid: string | undefined;
  const numArg = parseInt(args, 10);
  if (!isNaN(numArg) && /^\d+$/.test(args)) {
    if (numArg < 1 || numArg > sessions.length) {
      return {
        handled: true,
        success: false,
        error: `序号无效，范围 1~${sessions.length}`,
      };
    }
    targetSid = sessions[numArg - 1];
  } else {
    const matched = sessions.filter((sid) => {
      const title = formatSessionTitle(peer, sid, peerName);
      return title.toLowerCase().includes(args.toLowerCase()) || sid.toLowerCase().includes(args.toLowerCase());
    });
    if (matched.length === 1) {
      targetSid = matched[0];
    } else if (matched.length > 1) {
      const candidates = matched.map((sid) => `- ${formatSessionTitle(peer, sid, peerName)} (${sid})`).join('\n');
      return {
        handled: true,
        success: false,
        error: `发现多个匹配的会话，请使用序号切换：\n${candidates}`,
      };
    } else {
      return {
        handled: true,
        success: false,
        error: '切换失败：未找到匹配的会话，请输入 /会话 查看可用列表',
      };
    }
  }

  if (!targetSid) {
    return {
      handled: true,
      success: false,
      error: '切换失败：未找到匹配的会话，请输入 /会话 查看可用列表',
    };
  }

  const ok = sm.resumeSession(peer, targetSid);
  const targetTitle = formatSessionTitle(peer, targetSid, peerName);
  return ok
    ? {
        handled: true,
        success: true,
        reply: `已切换到会话：${targetTitle} (${targetSid})`,
      }
    : {
        handled: true,
        success: false,
        error: '恢复失败：会话不存在或已归档',
      };
}
