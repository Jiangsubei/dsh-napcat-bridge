/**
 * dsh-napcat-bridge: 检索表情包工具 (list_faces)
 */

import * as path from 'node:path';
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools';
import type {
  ListFacesParams,
  ListFacesResult,
  FaceSummaryItem,
} from '../../types/index.js';
import { DEFAULT_FACE_STORE_DIR } from '../../constants/index.js';
import { resolveDshPath } from '../../utils/path.js';
import {
  type ToolExecutionContext,
  type ContextSource,
  getGlobalToolContext,
  resolveToolContext,
} from '../common/context.js';
import { toLosslessJson } from '../../utils/lossless-json.js';
import {
  buildOffsetMessage,
  normalizeLimit,
  normalizeOffset,
} from '../pagination.js';

export type { ListFacesParams, ListFacesResult, FaceSummaryItem };

/**
 * 6.9 检索表情包工具 (list_faces)
 * 按情绪 (mood) 或内容标签 (tag) 检索本地可用表情包。
 * 强制分页，仅返回语义元数据 (id, tags, mood, format)，坚决不出 URL。
 */
export async function listFaces(
  params: ListFacesParams,
  context?: ToolExecutionContext
): Promise<ListFacesResult> {
  const offset = normalizeOffset(params?.offset);
  const limit = normalizeLimit(params?.limit, 100, 100);
  const ctx = { ...getGlobalToolContext(), ...context };
  if (!ctx.db) {
    return {
      faces: [],
      total: 0,
      total_matched: 0,
      offset,
      limit,
      has_more: false,
      message: '数据库不可用，暂时无法检索表情包。',
    };
  }
  const queryRes = ctx.db.queryFaces({
    query: params?.query,
    mood: params?.mood,
    tag: params?.tag,
    untagged: params?.untagged,
    limit,
    offset,
    enabledOnly: true,
  });

  const faces: FaceSummaryItem[] = queryRes.faces.map((f) => {
    const item: FaceSummaryItem = {
      id: f.id,
      tags: f.tags || [],
      format: f.format,
    };
    if (f.mood !== undefined && f.mood !== null && String(f.mood).trim() !== '') {
      item.mood = f.mood;
    }
    if (f.file_path) {
      item.file_path = path.isAbsolute(f.file_path)
        ? f.file_path
        : resolveDshPath(ctx.dshHome, f.file_path, DEFAULT_FACE_STORE_DIR);
    }
    return item;
  });

  const hasMore = offset + faces.length < queryRes.total;
  let message: string | undefined;
  if (queryRes.total === 0) {
    message = '未找到符合条件的表情包。';
  } else {
    message = buildOffsetMessage({
      offset,
      returned: faces.length,
      totalMatched: queryRes.total,
      hasMore,
      ...(hasMore ? { nextOffset: offset + faces.length } : {}),
      unit: '个表情',
    });
  }

  const res: ListFacesResult = {
    faces,
    total: faces.length,
    total_matched: queryRes.total,
    offset,
    limit,
    has_more: hasMore,
    ...(message ? { message } : {}),
  };

  return toLosslessJson(res);
}

export function createListFacesTool(context?: ContextSource): ToolDefinition {
  return defineTool({
    name: 'list_faces',
    description:
      '在机器人本地表情库中检索可用的表情包。用于斗图或需要情绪表达前，按情绪（mood）或标签（tag）查验可用库存；结果按收录时间倒序排列，每条带连续行号，可通过 offset/limit 分页。返回合法 face_id、标签、情绪及本地路径。翻页时按已展示条数自行推算 offset（例如已展示 1~20，则传 offset: 20）。检索到心仪表情后，使用其 face_id 配合 send_face 发送。',
    parameters: {
      query: {
        type: 'string',
        description: '综合模糊检索关键词，同时匹配表情的情绪或标签内容（如 "问号", "猫猫", "委屈"）',
      },
      mood: {
        type: 'string',
        description: '按情绪或语境筛选（支持包含匹配，如 "嘲讽", "卖萌", "赞同", "无奈", "开心"）',
      },
      tag: {
        type: 'string',
        description: '按画面元素或文字标签筛选（支持包含匹配，如 "猫猫", "熊猫头", "问号"）',
      },
      untagged: {
        type: 'boolean',
        description: '是否只检索尚未打标的表情（默认 false）。设为 true 可配合读图查看并调用 collect_face 进行补标。',
      },
      offset: {
        type: 'number',
        description: '起始序号偏移，从 0 开始（0 表示第 1 个）。翻页时按已展示条数自行推算，例如已展示 1~20 则传 20。',
      },
      limit: {
        type: 'number',
        description: '单次返回数量上限 (默认 100，上限 100)',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => {
        const v = value as any;
        if (!v || !Array.isArray(v.faces) || v.faces.length === 0) {
          return [{ type: 'text', text: v?.message || '未找到符合条件的表情包。' }];
        }
        const baseOffset = v.offset ?? 0;
        const totalMatched = v.total_matched ?? v.total;
        const lines = [
          `共匹配 ${totalMatched} 个可用表情（序号 ${baseOffset + 1}~${baseOffset + v.faces.length}，本次返回 ${v.faces.length} 个）:`,
        ];
        for (let i = 0; i < v.faces.length; i++) {
          const f = v.faces[i];
          const moodStr = f.mood ? ` [情绪: ${f.mood}]` : '';
          const tagStr = f.tags && f.tags.length > 0 ? ` 标签: [${f.tags.join(', ')}]` : ' [无标签]';
          const pathStr = f.file_path ? ` | 路径: ${f.file_path}` : '';
          lines.push(`${baseOffset + i + 1}. ID: ${f.id} (${f.format})${moodStr}${tagStr}${pathStr}`);
        }
        if (v.has_more) {
          lines.push(
            `\n> 还有 ${totalMatched - baseOffset - v.faces.length} 个未展示。继续浏览请传入 \`offset: ${baseOffset + v.faces.length}\`。`
          );
        } else if (v.message) {
          lines.push(`\n> ${v.message}`);
        }
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    async execute(args, _exec) {
      const resolved = resolveToolContext(context);
      const res = await listFaces(args, { db: resolved.db, dshHome: resolved.dshHome });
      return toLosslessJson(res) as any;
    },
  });
}
