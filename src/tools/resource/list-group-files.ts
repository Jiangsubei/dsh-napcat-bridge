/**
 * dsh-napcat-bridge: 获取群文件列表工具 (list_group_files)
 */

import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { ListGroupFilesParams, ListGroupFilesResult } from '../../types/index.js';
import {
  type ToolExecutionContext,
  type ContextSource,
  getGlobalToolContext,
  resolveToolContext,
  normalizePeer,
} from '../common/context.js';
import { toLosslessJson } from '../../utils/lossless-json.js';

export type { ListGroupFilesParams, ListGroupFilesResult };

/**
 * 格式化群文件列表输出为清晰的 Markdown 文本
 */
export function renderGroupFilesText(result: ListGroupFilesResult): string {
  if (!result.success && result.error) {
    return `群文件查询失败: ${result.error}`;
  }
  if (!result.files || result.files.length === 0) {
    return result.message || '未查询到符合条件的群文件记录。';
  }
  const offset = result.offset ?? 0;
  const totalMatched = result.total_matched ?? result.total;
  const lines: string[] = [
    `共匹配 ${totalMatched} 个群文件（序号 ${offset + 1}~${offset + result.files.length}，本次返回 ${result.files.length} 个）:`,
  ];
  for (let i = 0; i < result.files.length; i++) {
    const f = result.files[i];
    const sizeStr = f.size ? ` (${(f.size / 1024).toFixed(1)} KB)` : '';
    lines.push(`${offset + i + 1}. ${f.file_name}${sizeStr}`);
    lines.push(`  • file_id: ${f.file_id}`);
    lines.push(`  • busid: ${f.busid}`);
    lines.push(`  • 上传者: ${f.sender_name} (${f.user_id})`);
    lines.push(`  • 时间: ${f.formatted_time || f.time}`);
  }
  if (result.has_more) {
    lines.push(
      `\n> 还有 ${totalMatched - offset - result.files.length} 个未展示。继续浏览请传入 \`offset: ${offset + result.files.length}\`。`
    );
  } else if (result.message) {
    lines.push(`\n> ${result.message}`);
  }
  lines.push('\n提示: 如需读取文件内容，请调用 fetch_chat_resource(file_id=..., busid=...) 下载。');
  return lines.join('\n');
}

/**
 * 6.6 获取群文件列表工具 (list_group_files)
 * 从 SQLite 按 type='group_file' + peer 筛选群文件记录。
 */
export async function listGroupFiles(
  params: ListGroupFilesParams = {},
  context?: ToolExecutionContext
): Promise<ListGroupFilesResult> {
  const ctx = { ...getGlobalToolContext(), ...context };
  const rawPeer = ctx.peer || '';
  const peer = normalizePeer(rawPeer);

  if (!peer.startsWith('group_') && !peer.startsWith('qq-group-')) {
    return {
      success: false,
      files: [],
      total: 0,
      total_matched: 0,
      offset: 0,
      limit: params.limit ?? 20,
      has_more: false,
      error: '当前会话不是群聊，无群文件记录 (私聊文件请使用 read_chat_history)',
    };
  }

  const db = ctx.db;
  if (!db) {
    return {
      success: false,
      files: [],
      total: 0,
      total_matched: 0,
      offset: 0,
      limit: params.limit ?? 20,
      has_more: false,
      error: '数据库不可用，无法查询群文件列表',
    };
  }

  return db.listGroupFiles(peer, params);
}

export function createListGroupFilesTool(context?: ContextSource): ToolDefinition {
  return defineTool({
    name: 'list_group_files',
    description:
      '按 offset 分页检索当前群聊中已记录到本地数据库的群文件索引（并非协议端全量群文件清单，仅覆盖机器人见过的群文件消息）。用于用户查找群共享文件、查询资料是否已存在；返回结果包含连续行号、文件名、上传者、file_id 和 busid。如需读取文件内容，需将返回的 file_id 与 busid 传给 fetch_chat_resource 下载。翻页时按已展示条数自行传入 offset。切勿用于检索聊天文字。',
    parameters: {
      file_name: { type: 'string', description: '按群文件名模糊搜索（如 ".pdf", "周报"）' },
      sender_name: { type: 'string', description: '按上传者昵称或群名片模糊搜索' },
      user_id: { type: 'string', description: '按上传者 QQ 号精确筛选' },
      since: {
        type: 'string',
        description:
          "起始时间：支持相对时间 (如 '7d', '2w') 或自然日期 (如 '2026-08-25', '2026-08-30 14:00')",
      },
      until: {
        type: 'string',
        description: '截止时间：支持相对时间或自然日期时间字符串',
      },
      offset: {
        type: 'number',
        description: '起始序号偏移，从 0 开始（0 表示第 1 条）。翻页时按已展示条数自行推算。',
      },
      limit: { type: 'number', description: '返回最大数量 (默认 20，上限 100)' },
      order: {
        type: 'string',
        enum: ['asc', 'desc'],
        description: "排序方式 (默认 'desc' 倒序，取最新上传的文件)",
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [
        {
          type: 'text',
          text: renderGroupFilesText(value as any),
        },
      ],
    },
    async execute(args, exec) {
      const session = (exec.agent as any)?.session;
      const rawPeer = session?.id || '';
      const peer = normalizePeer(rawPeer);
      const resolved = resolveToolContext(context);
      const res = await listGroupFiles(args, {
        ...resolved,
        db: resolved.db,
        peer,
      });
      return toLosslessJson(res) as any;
    },
  });
}
