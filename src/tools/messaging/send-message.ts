/**
 * dsh-napcat-bridge: 发送 QQ 消息工具 (send_qq_message)
 */

import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { SendQqMessageParams, SendQqMessageResult } from '../../types/index.js';
import { stripMarkdown } from '../../outbound/render.js';
import {
  type ToolExecutionContext,
  type ContextSource,
  getGlobalToolContext,
  resolveToolContext,
  normalizePeer,
} from '../common/context.js';
import { toLosslessJson } from '../../utils/lossless-json.js';

export type { SendQqMessageParams, SendQqMessageResult };

/**
 * 将文本按最大长度分段（默认 1500 字符），优先在换行处断句，其次在空格处断句。
 */
export function splitMessageText(text: string, maxLength = 1500): string[] {
  if (!text) return [];
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxLength) {
    let splitIdx = remaining.lastIndexOf('\n', maxLength);
    if (splitIdx < Math.floor(maxLength * 0.5)) {
      splitIdx = remaining.lastIndexOf(' ', maxLength);
    }
    if (splitIdx < Math.floor(maxLength * 0.5)) {
      splitIdx = maxLength;
    }
    const chunk = remaining.slice(0, splitIdx).trim();
    if (chunk) {
      chunks.push(chunk);
    }
    remaining = remaining.slice(splitIdx).trim();
  }
  if (remaining.length > 0) {
    chunks.push(remaining);
  }
  return chunks;
}

/**
 * 6.9 发送 QQ 消息工具 (send_qq_message)
 * 向当前 QQ 会话发送普通文本消息。
 * 支持显式引用消息 (reply_to) 与艾特用户 (at_user)，超长自动分段，透明重试。
 * 执行成功后绝不调用 concludeTurn()，回合保持开放供后续顺手维护。
 */
export async function sendQqMessage(
  params: SendQqMessageParams,
  context?: ToolExecutionContext
): Promise<SendQqMessageResult> {
  const ctx = { ...getGlobalToolContext(), ...context };

  // 1. 参数非空校验（空文本/纯空白/stripMarkdown 后为空）
  if (!params || typeof params.text !== 'string') {
    return { success: false, error: '发送内容不能为空。' };
  }
  const rawStripped = stripMarkdown(params.text);
  const plainText = rawStripped.trim();
  const leadingNewline = /^\r?\n/.test(params.text.replace(/^[ \t]+/, ''));
  const processedText = leadingNewline ? `\n${plainText}` : plainText;
  if (!plainText) {
    return { success: false, error: '发送内容不能为空。' };
  }

  // 2. QQ 聊天会话上下文校验
  const rawPeer = ctx.peer || '';
  const peer = normalizePeer(rawPeer);
  const isGroup = peer.startsWith('group_') || peer.startsWith('qq-group-');
  const isUser = peer.startsWith('user_') || peer.startsWith('qq-user-');

  if (!isGroup && !isUser) {
    return { success: false, error: 'send_qq_message 需在 QQ 聊天会话中执行' };
  }

  if (!ctx.gateway) {
    return { success: false, error: 'NapCat Gateway 未连接' };
  }

  // 3. 超长文本自动分段（默认 1500 字符）
  const chunks = splitMessageText(processedText, 1500);
  let lastMessageId: number | undefined;

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    let payload: string | Array<Record<string, any>> = chunk;

    // 显式引用与艾特（仅首段携带，不重复注入后续分段）
    if (i === 0) {
      const segments: Array<Record<string, any>> = [];
      let replyId: number | undefined;
      if (params.reply_to !== undefined && params.reply_to !== null) {
        const num = typeof params.reply_to === 'number' ? params.reply_to : Number(String(params.reply_to).trim());
        if (Number.isSafeInteger(num) && num !== 0) {
          replyId = num;
        }
      }
      let atQQ: string | undefined;
      if (isGroup && params.at_user !== undefined && params.at_user !== null) {
        const rawAt = String(params.at_user).trim().replace(/^@/, '');
        if (rawAt.length > 0) {
          atQQ = rawAt;
        }
      }

      if (replyId !== undefined) {
        segments.push({ type: 'reply', data: { id: replyId } });
      }
      if (atQQ !== undefined) {
        segments.push({ type: 'at', data: { qq: atQQ } });
      }

      if (segments.length > 0) {
        // 当存在有效 at 消息段时，若正文开头非空白字符（空格/制表符/换行），自动补一个空格，防止在 QQ 端与 @昵称 紧贴
        const textContent =
          atQQ && chunk.length > 0 && !/^\s/.test(chunk)
            ? ` ${chunk}`
            : chunk;
        segments.push({ type: 'text', data: { text: textContent } });
        payload = segments;
      }
    }

    const sendTask = () => ctx.gateway!.sendMsg(peer, payload);
    let chunkSuccess = false;
    let lastError = '';

    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        const res = ctx.sender
          ? await ctx.sender.enqueue(peer, sendTask)
          : await sendTask();

        if (res && (res.status === 'ok' || res.retcode === 0)) {
          chunkSuccess = true;
          if (res.data?.message_id) {
            lastMessageId = res.data.message_id;
          }
          break;
        } else {
          lastError = res?.message || res?.wording || '网关返回错误';
        }
      } catch (err: any) {
        lastError = err?.message || String(err);
      }
      if (attempt < 5) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }

    if (!chunkSuccess) {
      return {
        success: false,
        error: `消息分段 ${i + 1}/${chunks.length} 发送失败: ${lastError}`,
      };
    }
  }

  return {
    success: true,
    message_id: lastMessageId,
    sent_preview: plainText.length > 60 ? `${plainText.slice(0, 60)}...` : plainText,
  };
}

export function createSendQqMessageTool(context?: ContextSource): ToolDefinition {
  return defineTool({
    name: 'send_qq_message',
    description:
      '向当前 QQ 会话发送文本消息。注意：你的直接文本回复不会自动显示给 QQ 用户，若要向用户发言、回答问题、同步进展或输出结论，必须调用本工具传入 text 参数，否则用户看不到任何内容。若要发送的内容较长，或包含多个不同要点、转折与独立意思，可以拆分成多条简短消息，多次调用本工具分开发送。如需引用消息，请显式传入其数字 reply_to；如需艾特特定用户，请显式传入 at_user。发送图片或文件请使用 send_file，发送表情包请使用 send_face，向用户提问或抉择可使用 ask_user_question。',
    parameters: {
      text: {
        type: 'string',
        required: true,
        description:
          '要发送给用户的纯文本聊天正文。直接填写展示给用户的原始文本，禁止附加任何 XML/HTML 标签、标签闭合符或外层包裹标记。',
      },
      reply_to: {
        oneOf: [{ type: 'number' }, { type: 'string' }],
        description: '需要引用的目标消息数字 ID，支持数字或数字字符串（来自当前入站消息头部 [消息ID: <id>] 或 read_chat_history）。',
      },
      at_user: {
        type: 'string',
        description: '需要艾特的目标用户 QQ 号（仅群聊有效，支持数字或字符串，支持自动剔除 @ 前缀）。',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => {
        const v = value as any;
        if (v?.success) {
          return [
            {
              type: 'text',
              text: `消息已发出${v.message_id ? ` (ID: ${v.message_id})` : ''}`,
            },
          ];
        }
        return [
          {
            type: 'text',
            text: `消息发送失败: ${v?.error}`,
          },
        ];
      },
    },
    async execute(args, exec) {
      const session = (exec.agent as any)?.session;
      const rawPeer = session?.id || (exec.agent as any)?.sessionId || (exec.agent as any)?.id || '';
      const peer = normalizePeer(rawPeer);
      const resolved = resolveToolContext(context);
      const res = await sendQqMessage(args, {
        ...resolved,
        gateway: resolved.gateway,
        sender: resolved.sender,
        peer: peer || resolved.peer,
      });
      return toLosslessJson(res) as any;
    },
  });
}
