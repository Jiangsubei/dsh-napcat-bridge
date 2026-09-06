/**
 * dsh-napcat-bridge: Memory Agent 工具集
 * 实现 read_memory, create_memory, edit_memory 及其 DSH defineTool 声明与上下文绑定。
 */

import type { Context } from '@deepseek-ai/cordis';
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { MemoryStorage } from './storage.js';
import type { MemoryOperationResult, MemoryType } from './types.js';

export interface ReadMemoryArgs {
  type?: MemoryType;
  qq?: string;
  peer?: string;
}

export interface CreateMemoryArgs {
  type: MemoryType;
  content: string;
  qq?: string;
  peer?: string;
}

export interface EditMemoryArgs {
  type: MemoryType;
  old_string: string;
  new_string?: string;
  qq?: string;
  peer?: string;
}

/**
 * 从 SessionId 或 Context 中解析 Peer (group_xxx / user_xxx) 与 QQ 号
 */
export function resolveContextPeerAndQQ(context?: unknown): { peer: string; qq: string } {
  let peer = 'default';
  let qq = 'default';

  if (!context || typeof context !== 'object') {
    return { peer, qq };
  }

  const anyCtx = context as Record<string, any>;
  const session = anyCtx.session || anyCtx.agent?.session || anyCtx.agent;
  const rawSessionId = session?.id || session?.sessionId || anyCtx.sessionId || '';

  if (typeof rawSessionId === 'string' && rawSessionId) {
    const trimmed = rawSessionId.trim();
    // 匹配 qq-group-3000000001-1 或 group_3000000001
    const groupMatch = trimmed.match(/^(?:qq-group-|group_)(\d+)/);
    if (groupMatch) {
      peer = `group_${groupMatch[1]}`;
    } else {
      const userMatch = trimmed.match(/^(?:qq-user-|user-|qq-)(\d+)/);
      if (userMatch) {
        peer = `user_${userMatch[1]}`;
        qq = userMatch[1];
      } else if (trimmed.startsWith('review-')) {
        peer = 'default';
      } else {
        peer = trimmed;
      }
    }
  }

  // 优先从直接字段或 agent 获取当前用户 QQ
  const directUser = anyCtx.userId || anyCtx.user_id || anyCtx.agent?.userId || anyCtx.agent?.user_id;
  if (typeof directUser === 'string' && directUser.trim()) {
    qq = directUser.trim();
  }

  return { peer, qq };
}

export class MemoryTools {
  constructor(private storage: MemoryStorage, private ctx?: Context) {}

  /**
   * 归一化 user 类型的记忆 identity（QQ 号）。
   * 优先级：显式 qq > peer 的 user_ 前缀派生 > 报错（不再退回 default）。
   */
  private resolveUserTarget(args: { qq?: string; peer?: string }): string | null {
    const qq = args.qq?.trim();
    if (qq && qq !== 'default') return qq;
    if (args.peer?.startsWith('user_')) {
      const derived = args.peer.slice(5).trim();
      if (derived && derived !== 'default') return derived;
    }
    if (args.peer?.startsWith('qq-user-')) {
      const derived = args.peer.replace(/^qq-user-/, '').split('-')[0].trim();
      if (derived && derived !== 'default') return derived;
    }
    return null;
  }

  public async readMemory(args: ReadMemoryArgs): Promise<MemoryOperationResult> {
    const type = args.type || 'session';

    if (type !== 'session' && type !== 'user') {
      return { success: false, message: '无效的记忆类型，仅支持 session 或 user。' };
    }

    if (type === 'user') {
      const targetQQ = this.resolveUserTarget(args);
      if (!targetQQ) {
        return { success: false, message: 'user 类型记忆必须指定 qq 参数或传入 user_xxx 格式的 peer。' };
      }
      const rawContent = await this.storage.readUserProfileRaw(targetQQ);
      const content = rawContent || '';
      const hasContent = Boolean(content.trim());
      return {
        success: true,
        type: 'user',
        target: targetQQ,
        content,
        message: hasContent
          ? `成功读取用户画像 (${targetQQ})`
          : '该记忆文件不存在或内容为空。如需记录，请使用 create_memory 创建。',
      };
    } else {
      const targetPeer = args.peer?.trim();
      if (!targetPeer || targetPeer === 'default') {
        return { success: false, message: 'session 记忆必须指定 peer 参数（如 peer="group_xxx" 或 peer="user_xxx"）。' };
      }
      const rawContent = await this.storage.readSessionMemoryRaw(targetPeer);
      const content = rawContent || '';
      const hasContent = Boolean(content.trim());
      return {
        success: true,
        type: 'session',
        target: targetPeer,
        content,
        message: hasContent
          ? `成功读取 Session 记忆 (${targetPeer})`
          : '该记忆文件不存在或内容为空。如需记录，请使用 create_memory 创建。',
      };
    }
  }

  public async createMemory(args: CreateMemoryArgs): Promise<MemoryOperationResult> {
    const type = args.type;
    if (type !== 'session' && type !== 'user') {
      return { success: false, message: '无效的记忆类型，仅支持 session 或 user。' };
    }

    const content = args.content;
    if (content === undefined || content === null || !content.trim()) {
      return { success: false, message: '创建内容不能为空。' };
    }

    if (type === 'user') {
      const targetQQ = this.resolveUserTarget(args);
      if (!targetQQ) {
        return { success: false, message: 'user 类型记忆必须指定 qq 参数或传入 user_xxx 格式的 peer。' };
      }

      if (await this.storage.existsUserProfile(targetQQ)) {
        return { success: false, message: '目标记忆已存在，请使用 edit_memory 修改，不要重复创建。' };
      }

      await this.storage.writeUserProfile(targetQQ, content);
      const message = `已创建用户画像 (${targetQQ})`;
      if (this.ctx && typeof (this.ctx as any).emit === 'function') {
        (this.ctx as any).emit('memory/change', {
          type: 'user',
          qq: targetQQ,
          action: 'create',
          content,
          message,
        });
      }
      return {
        success: true,
        type: 'user',
        target: targetQQ,
        message,
      };
    } else {
      const targetPeer = args.peer?.trim();
      if (!targetPeer || targetPeer === 'default') {
        return { success: false, message: 'session 记忆必须指定 peer 参数（如 peer="group_xxx" 或 peer="user_xxx"）。' };
      }

      if (await this.storage.existsSessionMemory(targetPeer)) {
        return { success: false, message: '目标记忆已存在，请使用 edit_memory 修改，不要重复创建。' };
      }

      await this.storage.writeSessionMemory(targetPeer, content);
      const message = `已创建 Session 记忆 (${targetPeer})`;
      if (this.ctx && typeof (this.ctx as any).emit === 'function') {
        (this.ctx as any).emit('memory/change', {
          type: 'session',
          peer: targetPeer,
          action: 'create',
          content,
          message,
        });
      }
      return {
        success: true,
        type: 'session',
        target: targetPeer,
        message,
      };
    }
  }

  public async editMemory(args: EditMemoryArgs): Promise<MemoryOperationResult> {
    const type = args.type;
    if (type !== 'session' && type !== 'user') {
      return { success: false, message: '无效的记忆类型，仅支持 session 或 user。' };
    }

    if (args.old_string === undefined || args.old_string === null || args.old_string === '') {
      return { success: false, message: 'old_string 不能为空。' };
    }

    let target: string;
    let currentContent: string;

    if (type === 'user') {
      const targetQQ = this.resolveUserTarget(args);
      if (!targetQQ) {
        return { success: false, message: 'user 类型记忆必须指定 qq 参数或传入 user_xxx 格式的 peer。' };
      }
      target = targetQQ;

      if (!(await this.storage.existsUserProfile(targetQQ))) {
        return { success: false, message: '目标记忆不存在，请先 create_memory 创建。' };
      }

      currentContent = await this.storage.readUserProfileRaw(targetQQ);
      if (!currentContent || !currentContent.trim()) {
        return { success: false, message: '目标记忆不存在，请先 create_memory 创建。' };
      }
    } else {
      const targetPeer = args.peer?.trim();
      if (!targetPeer || targetPeer === 'default') {
        return { success: false, message: 'session 记忆必须指定 peer 参数（如 peer="group_xxx" 或 peer="user_xxx"）。' };
      }
      target = targetPeer;

      if (!(await this.storage.existsSessionMemory(targetPeer))) {
        return { success: false, message: '目标记忆不存在，请先 create_memory 创建。' };
      }

      currentContent = await this.storage.readSessionMemoryRaw(targetPeer);
      if (!currentContent || !currentContent.trim()) {
        return { success: false, message: '目标记忆不存在，请先 create_memory 创建。' };
      }
    }

    const oldStr = args.old_string;
    const newStr = args.new_string ?? '';

    // 找 old_string 所有出现位置
    let count = 0;
    let firstIndex = -1;
    let pos = 0;
    while ((pos = currentContent.indexOf(oldStr, pos)) !== -1) {
      count++;
      if (firstIndex === -1) firstIndex = pos;
      pos += oldStr.length;
    }

    if (count === 0) {
      return {
        success: false,
        message: 'old_string 未在当前记忆中找到，可能内容已变化，请先 read_memory 获取最新内容。',
      };
    }

    if (count >= 2) {
      return {
        success: false,
        message: `old_string 出现 ${count} 次，请补充更多上下文使其唯一。`,
      };
    }

    // 唯一匹配替换（空/省略 = 删除匹配片段）
    const newContent =
      currentContent.slice(0, firstIndex) + newStr + currentContent.slice(firstIndex + oldStr.length);

    if (type === 'user') {
      await this.storage.writeUserProfile(target, newContent);
    } else {
      await this.storage.writeSessionMemory(target, newContent);
    }

    const preStart = Math.max(0, firstIndex - 30);
    const postEnd = Math.min(newContent.length, firstIndex + newStr.length + 30);
    const preview = newContent.slice(preStart, postEnd);

    const message = `已编辑${type === 'user' ? '用户画像' : 'Session 记忆'} (${target})：${preview}`;

    if (this.ctx && typeof (this.ctx as any).emit === 'function') {
      (this.ctx as any).emit('memory/change', {
        type,
        ...(type === 'user' ? { qq: target } : { peer: target }),
        action: 'edit',
        old_string: oldStr,
        new_string: newStr,
        preview,
        message,
      });
    }

    return {
      success: true,
      type,
      target,
      preview,
      message,
    };
  }
}

/**
 * 创建 DSH ToolDefinition 数组
 */
export function createMemoryToolDefinitions(tools: MemoryTools): ToolDefinition[] {
  return [
    defineTool({
      name: 'read_memory',
      description: '读取当前群聊/私聊的 Session 记忆规则或特定用户的个人画像与偏好。目标文件不存在时返回空内容，不报错。',
      parameters: {
        type: {
          type: 'string',
          enum: ['session', 'user'],
          required: true,
          description: "记忆类型：'session' 表示读取群聊/私聊规则；'user' 表示读取个人用户画像。",
        },
        peer: {
          type: 'string',
          description: "目标会话 Peer（如 'group_xxx' 或 'user_xxx'，留空自动绑定当前会话）。",
        },
        qq: {
          type: 'string',
          description: "目标用户的 QQ 号（仅当 type='user' 时有效，留空自动读取当前对话者）。",
        },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value: any) => [
          {
            type: 'text',
            text: value?.content?.trim()
              ? `${value.message || '读取成功'}\n\n${value.content}`
              : (value?.message || '记忆内容为空（当前无内容）'),
          },
        ],
      },
      async execute(args: any, exec) {
        const resolved = resolveContextPeerAndQQ(exec);
        if (resolved.peer === 'default' && !args.peer && !args.qq) {
          return { success: false, message: '请显式传入 peer 参数（如 peer="group_xxx" 或 peer="user_xxx"）' };
        }
        return tools.readMemory({
          type: args.type || 'session',
          qq: args.qq || resolved.qq,
          peer: args.peer || resolved.peer,
        }) as any;
      },
    }),
    defineTool({
      name: 'create_memory',
      description: '创建当前群聊/私聊 Session 记忆或用户画像。仅当目标记忆文件不存在时可用，原样写入内容。已存在时请使用 edit_memory。',
      parameters: {
        type: {
          type: 'string',
          enum: ['session', 'user'],
          required: true,
          description: "记忆类型：'session' 表示创建群聊/私聊约定；'user' 表示创建个人用户画像。",
        },
        content: {
          type: 'string',
          required: true,
          description: '要写入的完整记忆内容（原样写入，不自动追加时间戳或标题头）。',
        },
        peer: {
          type: 'string',
          description: "目标会话 Peer（如 'group_xxx' 或 'user_xxx'，留空自动绑定当前会话）。",
        },
        qq: {
          type: 'string',
          description: "目标用户的 QQ 号（仅当 type='user' 时有效，留空自动绑定当前对话者）。",
        },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value: any) => [
          {
            type: 'text',
            text: value.message || `成功创建记忆 (${value.target})`,
          },
        ],
      },
      async execute(args: any, exec) {
        const resolved = resolveContextPeerAndQQ(exec);
        if (resolved.peer === 'default' && !args.peer && !args.qq) {
          return { success: false, message: '请显式传入 peer 参数（如 peer="group_xxx" 或 peer="user_xxx"）' };
        }
        return tools.createMemory({
          type: args.type || 'session',
          content: args.content,
          qq: args.qq || resolved.qq,
          peer: args.peer || resolved.peer,
        }) as any;
      },
    }),
    defineTool({
      name: 'edit_memory',
      description: '定向修改当前群聊/私聊 Session 记忆或用户画像。通过 old_string 精确匹配并替换为 new_string；若 new_string 为空或省略则删除该片段。要求 old_string 必须在内容中唯一存在。',
      parameters: {
        type: {
          type: 'string',
          enum: ['session', 'user'],
          required: true,
          description: "记忆类型：'session' 表示修改群聊/私聊约定；'user' 表示修改个人用户画像。",
        },
        old_string: {
          type: 'string',
          required: true,
          description: '待替换/删除的原文字符串，必须在文件中唯一出现。',
        },
        new_string: {
          type: 'string',
          description: '替换后的新字符串。若省略或为空字符串，则删除匹配的 old_string 片段。',
        },
        peer: {
          type: 'string',
          description: "目标会话 Peer（如 'group_xxx' 或 'user_xxx'，留空自动绑定当前会话）。",
        },
        qq: {
          type: 'string',
          description: "目标用户的 QQ 号（仅当 type='user' 时有效，留空自动绑定当前对话者）。",
        },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value: any) => [
          {
            type: 'text',
            text: value.message || `成功编辑记忆 (${value.target})：${value.preview}`,
          },
        ],
      },
      async execute(args: any, exec) {
        const resolved = resolveContextPeerAndQQ(exec);
        if (resolved.peer === 'default' && !args.peer && !args.qq) {
          return { success: false, message: '请显式传入 peer 参数（如 peer="group_xxx" 或 peer="user_xxx"）' };
        }
        return tools.editMemory({
          type: args.type || 'session',
          old_string: args.old_string,
          new_string: args.new_string,
          qq: args.qq || resolved.qq,
          peer: args.peer || resolved.peer,
        }) as any;
      },
    }),
  ];
}
