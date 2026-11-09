/**
 * dsh-napcat-bridge: 主动发送文件/图片工具 (send_file)
 */

import * as fs from 'node:fs';
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { SendFileParams, SendFileResult } from '../../types/index.js';
import { buildOutboundAttachments } from '../../attachment/outbound.js';
import { classifySendFileSource, detectSendFileType } from '../file-source.js';
import {
  type ToolExecutionContext,
  type ContextSource,
  getGlobalToolContext,
  resolveToolContext,
  normalizePeer,
} from '../common/context.js';
import { toLosslessJson } from '../../utils/lossless-json.js';

export type { SendFileParams, SendFileResult };

/**
 * 6.4 主动发送文件/图片工具 (send_file)
 * Agent 主动向当前会话发送本地生成的文件、报告或图片产物。
 */
export async function sendFile(
  params: SendFileParams,
  context?: ToolExecutionContext
): Promise<SendFileResult> {
  const ctx = { ...getGlobalToolContext(), ...context };

  if (!params || !params.file_path || typeof params.file_path !== 'string' || params.file_path.trim() === '') {
    return { success: false, error: '你需要指定 file_path' };
  }

  const filePath = params.file_path.trim();

  // IS-S1: 文件源归一化 + WSL→Windows 路径翻译（无法翻译的 WSL 内部路径直接清晰报错）
  const classified = classifySendFileSource(filePath);
  if ('error' in classified) {
    return { success: false, error: classified.error };
  }
  const src = classified.source;

  if (!ctx.gateway || !ctx.peer) {
    return {
      success: false,
      error: `发送文件失败: ${!ctx.gateway ? 'NapCat 未连接 (gateway 不可用)' : '未绑定 QQ 会话(peer)'}，无法下发文件`,
    };
  }

  // IS-S4: 本地源路径存在性校验（WSL 侧可校验时；Windows 路径且盘符未挂载时跳过校验）
  if (src.localCheckPath && !fs.existsSync(src.localCheckPath)) {
    return { success: false, error: `发送文件失败: 本地路径不存在: ${src.localCheckPath}` };
  }

  try {
    const fileKind = detectSendFileType(params.file_type, src.value);

    let msgPayload: any;
    if (fileKind === 'image') {
      msgPayload = [{ type: 'image', data: { file: src.value } }];
    } else {
      msgPayload = [{ type: 'file', data: { file: src.value } }];
    }

    // 经共享 per-peer 串行队列下发，与正文/提问/审批保持同 peer 内顺序 (Spec §7.3)
    const attachments = buildOutboundAttachments(msgPayload, { peer: ctx.peer });
    const sendTask = () => ctx.gateway!.sendMsg(ctx.peer!, msgPayload, attachments);
    const res = ctx.sender
      ? await ctx.sender.enqueue(ctx.peer, sendTask)
      : await sendTask();

    if (res && (res.status === 'failed' || (typeof res.retcode === 'number' && res.retcode !== 0))) {
      const errMsg = res.wording || res.message || `NapCat 返回错误 (retcode: ${res.retcode})`;
      return { success: false, error: errMsg };
    }

    const messageId = res?.data?.message_id;
    if (messageId === undefined || messageId === null || messageId === '') {
      return { success: false, error: '发送结果未知: NapCat 未返回 message_id，请确认文件已成功下发' };
    }

    return {
      success: true,
      message_id: Number(messageId),
    };
  } catch (err: any) {
    return { success: false, error: `发送文件失败: ${err?.message || '未知错误'}` };
  }
}

export function createSendFileTool(context?: ContextSource): ToolDefinition {
  return defineTool({
    name: 'send_file',
    description:
      '向当前聊天发送本地磁盘上的文件、生成的图片或导出报告。用于向用户交付具体的文件或图片实体产物；系统会自动根据文件扩展名选择以图片或文件卡片形式下发。切勿用于发送普通文本聊天消息。',
    parameters: {
      file_path: { type: 'string', required: true, description: '本地绝对路径、file:// URI 或 URL (必填)' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [
        {
          type: 'text',
          text: (value as any).success
            ? `文件发送成功 (message_id: ${(value as any).message_id})`
            : `文件发送失败: ${(value as any).error}`,
        },
      ],
    },
    async execute(args, exec) {
      const session = (exec.agent as any)?.session;
      const rawPeer = session?.id || '';
      const peer = normalizePeer(rawPeer);
      const resolved = resolveToolContext(context);
      const res = (await sendFile(args, {
        ...resolved,
        gateway: resolved.gateway,
        sender: resolved.sender,
        peer,
      })) as any;
      if (res && res.success === false) {
        throw new Error(res.error || 'send_file 失败');
      }
      return toLosslessJson(res);
    },
  });
}
