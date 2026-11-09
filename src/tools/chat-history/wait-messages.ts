/**
 * dsh-napcat-bridge: 等待用户消息工具 (wait_for_user_messages)
 */

import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { WaitCollectedMessage } from '../../gateway/server.js';
import { formatDateTime } from '../../storage/database.js';
import {
  type ToolExecutionContext,
  type ContextSource,
  getGlobalToolContext,
  resolveToolContext,
  normalizePeer,
} from '../common/context.js';
import { toLosslessJson } from '../../utils/lossless-json.js';

export interface WaitForUserMessagesParams {
  timeout?: number;
  user_id?: string;
}

export type WaitForUserMessagesResult =
  | { messages: WaitCollectedMessage[]; total: number }
  | { success: false; error: string };

/** QQ 号语法级校验：5~12 位纯数字（用户拍板「语法级校验」口径） */
const QQ_ID_RE = /^\d{5,12}$/;

/**
 * EN-005: wait_for_user_messages 工具
 * Agent 在一轮内挂起，收集一段时间内到达的当前会话新消息后返回，实现单轮多消息交互。
 */
export async function waitForUserMessages(
  params: WaitForUserMessagesParams,
  context?: ToolExecutionContext
): Promise<WaitForUserMessagesResult> {
  const ctx = { ...getGlobalToolContext(), ...context };

  // 1. timeout 参数校验（状态层）
  const timeout = params?.timeout;
  if (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout <= 0) {
    return { success: false, error: '你需要指定有效的 timeout（等待秒数，>0）' };
  }

  // 2. 会话 peer 校验（非 QQ 会话不支持等待）
  const peer = normalizePeer(ctx.peer || '');
  if (!peer.startsWith('group_') && !peer.startsWith('user_')) {
    return { success: false, error: '当前会话不是 QQ 会话，无法等待用户消息' };
  }

  // 3. user_id 语法级校验（依赖层）：格式非法 → 原文报错；私聊对象不符 → 原文报错
  let userId: string | undefined;
  if (params?.user_id !== undefined && params?.user_id !== null) {
    const uid = String(params.user_id).trim();
    if (uid === '' || !QQ_ID_RE.test(uid)) {
      return { success: false, error: 'Unknown user_id, cannot wait for messages' };
    }
    if (peer.startsWith('user_') && uid !== peer.slice(5)) {
      return { success: false, error: 'Unknown user_id, cannot wait for messages' };
    }
    userId = uid;
  }

  // 4. registry 未装配 → 状态层明确报错（不悬挂、不走等待）
  if (!ctx.waitRegistry) {
    return { success: false, error: '消息等待服务不可用（waitRegistry 未装配），无法等待用户消息' };
  }

  // 5. 挂起等待（纯超时窗口，Agent 自行决定 timeout；取消由 exec.signal 传导）
  const result = await ctx.waitRegistry.wait(peer, {
    userId,
    timeoutMs: Math.round(timeout * 1000),
    signal: ctx.signal,
  });

  // 6. 结算结果映射（状态层报错原文透传，不给建议）
  if (result.ok) {
    return toLosslessJson({ messages: result.messages, total: result.messages.length }) as WaitForUserMessagesResult;
  }
  return toLosslessJson({ success: false, error: result.message }) as WaitForUserMessagesResult;
}

/** EN-005: 等待结果渲染文本（成功列出收集消息；失败显示 error） */
export function renderWaitResultText(value: WaitForUserMessagesResult): string {
  if (!('messages' in value)) {
    return `等待用户消息失败: ${value.error}`;
  }
  const messages = value.messages;
  if (messages.length === 0) {
    return '未收集到新消息。';
  }
  const lines = messages.map((m, i) => {
    const head = m.from || m.user_id || '未知用户';
    const timeStr = m.time ? formatDateTime(m.time) : '';
    const idStr = m.msg_id !== undefined ? ` [消息ID: ${m.msg_id}]` : '';
    let quoteStr = '';
    if (m.quoted) {
      let quotedSender = '某人';
      if (m.quoted.from_name && m.quoted.user_id) {
        quotedSender = `${m.quoted.from_name} (QQ: ${m.quoted.user_id})`;
      } else if (m.quoted.from_name) {
        quotedSender = m.quoted.from_name;
      } else if (m.quoted.user_id) {
        quotedSender = `QQ: ${m.quoted.user_id}`;
      } else if (m.quoted.msg_id) {
        quotedSender = `消息ID: ${m.quoted.msg_id}`;
      }
      quoteStr = ` [引用回复 ${quotedSender}${m.quoted.text ? `: "${m.quoted.text}"` : ''}]`;
    }
    return `${i + 1}. [${head}${timeStr ? ` ${timeStr}` : ''}]${idStr}${quoteStr} ${m.content}`;
  });
  return `已收集 ${messages.length} 条新消息:\n${lines.join('\n')}`;
}

export function createWaitForUserMessagesTool(context?: ContextSource): ToolDefinition {
  return defineTool({
    name: 'wait_for_user_messages',
    description:
      '临时挂起当前会话并等待用户继续发送消息，在指定窗口时间内收集到达的新消息后统一恢复执行。适用于纯图片或截图消息尚无文字说明、用户话只说了半句、明确提示“等等还有”、连续多段发言等确实需要等待对方输入下文的场景（注意：斗图、刷表情包或常规闲聊对话绝不属于此类，切勿滥用）；在调用本工具挂起等待前，通常应首先调用 send_qq_message 向用户发送一条消息给予及时反馈，告知对方你已收到并正在等待其补充或稍作等待，切勿无声挂起；建议优先采用较短的等待时间，例如先等待 30 秒左右，若等待超时后用户仍未继续发送消息，而你判断仍需要等待时，应在再次调用本工具前先发送一条消息主动跟进询问或提醒用户，确认情况后再继续等待，从而保持良好的交互反馈；窗口内收集到消息后将一次性返回供你综合研判和答复。',
    parameters: {
      timeout: {
        type: 'number',
        required: true,
        description:
          '等待秒数（正数），由你自行决定，推荐优先使用 30 秒左右的较短时长，以便在未收到消息时能及时向用户发送消息跟进互动，避免一次性过长挂起导致用户缺少反馈。',
      },
      user_id: {
        type: 'string',
        description: '群聊时指定只收集该 QQ 号的消息；私聊无需传（天然单用户）',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: renderWaitResultText(value as any) }],
    },
    timeoutMs: 600_000,
    async execute(args, exec) {
      const session = (exec.agent as any)?.session;
      const rawPeer = session?.id || '';
      const peer = normalizePeer(rawPeer);
      const resolved = resolveToolContext(context);
      const res = (await waitForUserMessages(args, {
        ...resolved,
        waitRegistry: resolved.waitRegistry,
        peer,
        signal: exec.signal,
      })) as any;
      return toLosslessJson(res);
    },
  });
}
