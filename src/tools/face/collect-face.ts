/**
 * dsh-napcat-bridge: 偷表情/收藏工具 (collect_face)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { CollectFaceParams, CollectFaceResult, MessageRecord } from '../../types/index.js';
import { DEFAULT_FACE_STORE_DIR } from '../../constants/index.js';
import { resolveDshPath } from '../../utils/path.js';
import {
  type ToolExecutionContext,
  type ContextSource,
  getGlobalToolContext,
  resolveToolContext,
  normalizePeer,
} from '../common/context.js';
import { toLosslessJson } from '../../utils/lossless-json.js';

export type { CollectFaceParams, CollectFaceResult };

/**
 * 6.11 偷表情/收藏工具 (collect_face)
 * 从指定消息（或当前正在回复的入站消息）中提取图片并收录进本地表情库。
 * 修改已有表情标签或删除表情请使用 manage_faces。
 */
export async function collectFace(
  params: CollectFaceParams,
  context?: ToolExecutionContext & { faceDir?: string }
): Promise<CollectFaceResult> {
  const ctx = { ...getGlobalToolContext(), ...context };

  if (!params || !params.tags || !Array.isArray(params.tags) || params.tags.length === 0) {
    return { success: false, error: '缺少必填参数 tags (内容画面标签，如 ["猫猫", "叹气"])' };
  }
  if (!params.mood || typeof params.mood !== 'string' || !params.mood.trim()) {
    return { success: false, error: '缺少必填参数 mood (情绪语境意图，如 "嘲讽" / "卖萌" / "感谢")' };
  }
  if (!ctx.db) {
    return { success: false, error: '数据库不可用' };
  }

  // 偷图/收藏新表情
  const sessionPeer = ctx.peer || '';
  let targetMsgId: number | undefined;
  if (params.message_id !== undefined && params.message_id !== null && String(params.message_id).trim() !== '') {
    const parsed = Number(params.message_id);
    if (Number.isSafeInteger(parsed) && parsed !== 0) {
      targetMsgId = parsed;
    }
  }
  if (targetMsgId === undefined && ctx.inboundMsgIdGetter && sessionPeer) {
    targetMsgId = ctx.inboundMsgIdGetter(sessionPeer);
  }

  let targetMsg: MessageRecord | null = null;
  if (targetMsgId !== undefined) {
    targetMsg = ctx.db.getMessage(targetMsgId);
  } else if (sessionPeer) {
    const recent = ctx.db.readHistory(sessionPeer, { has_file: true, limit: 1 });
    if (recent.messages.length > 0) {
      targetMsg = ctx.db.getMessage(recent.messages[0].msg_id);
    }
  }

  if (!targetMsg) {
    return { success: false, error: '未找到指定的消息记录' };
  }

  const hasImg =
    targetMsg.type === 'image' ||
    targetMsg.type === 'sticker' ||
    (typeof targetMsg.raw === 'string' && (targetMsg.raw.includes('"image"') || targetMsg.raw.includes('CQ:image')));

  if (!hasImg) {
    return { success: false, error: '目标消息中未找到图片或表情附件' };
  }

  let localPath = targetMsg.local_path;
  if (!localPath || !fs.existsSync(localPath)) {
    return { success: false, error: '目标消息的图片本地缓存文件不存在，无法转存' };
  }

  try {
    const fileBuf = fs.readFileSync(localPath);
    const md5 = crypto.createHash('md5').update(fileBuf).digest('hex');
    const ext = path.extname(localPath).replace(/^\./, '').toLowerCase() || 'png';
    const size = fileBuf.length;

    const rawStoreDir = context?.faceDir || ctx.faceDir || '.dsh/napcat/faces';
    const storeDir = resolveDshPath(context?.dshHome || ctx.dshHome, rawStoreDir, DEFAULT_FACE_STORE_DIR);
    fs.mkdirSync(storeDir, { recursive: true });
    const targetFile = path.resolve(storeDir, `${md5}.${ext}`);

    if (!fs.existsSync(targetFile)) {
      fs.copyFileSync(localPath, targetFile);
    }

    const faceId = `face_${md5.slice(0, 8)}`;
    const safeTags = params.tags;
    const safeMood = params.mood.trim();

    const res = ctx.db.insertFace(
      {
        id: faceId,
        file_path: targetFile,
        md5,
        source: 'collect',
        tags: safeTags,
        mood: safeMood,
        enabled: true,
        size,
        format: ext,
      },
      {
        max: ctx.faceStoreMax,
        evictPolicy: ctx.faceEvictPolicy,
      }
    );

    if (res.duplicated) {
      return toLosslessJson({
        success: true,
        duplicated: true,
        face_id: res.id,
        message: `该表情包已在你的表情库中存在（已有标签: [${res.tags.join(', ')}]，情绪: ${res.mood || '未设置'}）`,
      });
    }

    return toLosslessJson({
      success: true,
      face_id: res.id,
      message: `已成功收藏表情包，标签: [${safeTags.join(', ')}]，情绪: ${safeMood}`,
    });
  } catch (err: any) {
    return toLosslessJson({ success: false, error: `表情入库失败: ${err?.message || '未知错误'}` });
  }
}

export function createCollectFaceTool(context?: ContextSource): ToolDefinition {
  return defineTool({
    name: 'collect_face',
    description:
      '将聊天中的图片收录入本地表情库，并打上初始标签与情绪。用于用户要求“把这图存成表情”、聊天中出现值得收藏的好梗图时。修改已有表情标签或删除表情请使用 manage_faces。',
    parameters: {
      tags: {
        type: 'array',
        required: true,
        items: { type: 'string' },
        description: '画面内容与文字标签（如 ["猫猫", "叹气", "生活不易"]，必填）',
      },
      mood: {
        type: 'string',
        required: true,
        description: '情绪与语境意图（如 "嘲讽", "卖萌", "感谢", "无奈", "破防"，必填）',
      },
      message_id: {
        oneOf: [{ type: 'number' }, { type: 'string' }],
        description: '收藏新表情时的目标消息 ID（支持数字或数字字符串）。若省略则自动绑定当前回合正在回复的入站消息',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => {
        const v = value as any;
        return [
          {
            type: 'text',
            text: v?.success
              ? v.duplicated
                ? `[表情已存在] ${v.message}`
                : `[成功] ${v.message} (face_id: ${v.face_id})`
              : `操作表情失败: ${v?.error}`,
          },
        ];
      },
    },
    async execute(args, exec) {
      const session = (exec.agent as any)?.session;
      const rawPeer = session?.id || '';
      const peer = normalizePeer(rawPeer);
      const resolved = resolveToolContext(context);
      const cfg = typeof (resolved as any).config === 'function'
        ? (resolved as any).config()
        : ((resolved as any).config || {});
      const res = await collectFace(args, {
        ...resolved,
        db: resolved.db,
        peer,
        inboundMsgIdGetter: resolved.inboundMsgIdGetter,
        dshHome: resolved.dshHome,
        faceDir: resolveDshPath(resolved.dshHome, cfg.face_store_dir, DEFAULT_FACE_STORE_DIR),
        faceStoreMax: cfg.face_store_max,
        faceEvictPolicy: cfg.face_evict_policy,
      });
      return toLosslessJson(res) as any;
    },
  });
}
