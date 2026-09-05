/**
 * dsh-napcat-bridge: Memory Agent 工具集
 * 实现 read_memory, append_memory, update_memory 及其 DSH defineTool 声明与上下文绑定。
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

export interface AppendMemoryArgs {
  type: MemoryType;
  content: string;
  qq?: string;
  peer?: string;
}

export interface UpdateMemoryArgs {
  type: MemoryType;
  content: string;
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

  public async readMemory(args: ReadMemoryArgs): Promise<MemoryOperationResult> {
    const type = args.type || 'session';

    if (type === 'user') {
      const targetQQ = args.qq || 'default';
      const content = await this.storage.readUserProfile(targetQQ);
      return {
        success: true,
        message: `成功读取用户画像 (${targetQQ})`,
        content,
      };
    } else {
      const targetPeer = args.peer || 'default';
      const content = await this.storage.readSessionMemory(targetPeer);
      return {
        success: true,
        message: `成功读取 Session 记忆 (${targetPeer})`,
        content,
      };
    }
  }

  public async appendMemory(args: AppendMemoryArgs): Promise<MemoryOperationResult> {
    const type = args.type || 'session';
    const content = args.content || '';

    if (!content.trim()) {
      return { success: false, message: '追加内容不能为空' };
    }

    const preview = content.length > 40 ? content.slice(0, 40).replace(/\n+/g, ' ') + '…' : content.replace(/\n+/g, ' ');

    if (type === 'user') {
      const targetQQ = args.qq || 'default';
      await this.storage.appendUserProfile(targetQQ, content);
      const message = `已更新用户画像 (${targetQQ})：${preview}`;
      if (this.ctx && typeof (this.ctx as any).emit === 'function') {
        (this.ctx as any).emit('memory/change', { type: 'user', qq: targetQQ, action: 'append', content, message });
      }
      return { success: true, message, content };
    } else {
      const targetPeer = args.peer || 'default';
      await this.storage.appendSessionMemory(targetPeer, content);
      const message = `已更新记忆 (${targetPeer})：${preview}`;
      if (this.ctx && typeof (this.ctx as any).emit === 'function') {
        (this.ctx as any).emit('memory/change', { type: 'session', peer: targetPeer, action: 'append', content, message });
      }
      return { success: true, message, content };
    }
  }

  public async updateMemory(args: UpdateMemoryArgs): Promise<MemoryOperationResult> {
    const type = args.type || 'session';
    const content = args.content || '';

    const preview = content.length > 40 ? content.slice(0, 40).replace(/\n+/g, ' ') + '…' : content.replace(/\n+/g, ' ');

    if (type === 'user') {
      const targetQQ = args.qq || 'default';
      await this.storage.writeUserProfile(targetQQ, content);
      const message = `已重写用户画像 (${targetQQ})：${preview}`;
      if (this.ctx && typeof (this.ctx as any).emit === 'function') {
        (this.ctx as any).emit('memory/change', { type: 'user', qq: targetQQ, action: 'update', content, message });
      }
      return { success: true, message, content };
    } else {
      const targetPeer = args.peer || 'default';
      await this.storage.writeSessionMemory(targetPeer, content);
      const message = `已重写 Session 记忆 (${targetPeer})：${preview}`;
      if (this.ctx && typeof (this.ctx as any).emit === 'function') {
        (this.ctx as any).emit('memory/change', { type: 'session', peer: targetPeer, action: 'update', content, message });
      }
      return { success: true, message, content };
    }
  }
}

/**
 * 创建 DSH ToolDefinition 数组
 */
export function createMemoryToolDefinitions(tools: MemoryTools): ToolDefinition[] {
  return [
    defineTool({
      name: 'read_memory',
      description: '读取当前群聊/私聊的 Session 记忆规则或特定用户的个人画像与偏好。',
      parameters: {
        type: {
          type: 'string',
          enum: ['session', 'user'],
          description: "记忆类型：'session' 表示读取群聊/私聊规则；'user' 表示读取个人用户画像。",
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
            text: value.content ? `${value.message}\n\n${value.content}` : value.message,
          },
        ],
      },
      async execute(args: any, exec) {
        const resolved = resolveContextPeerAndQQ(exec);
        return tools.readMemory({
          type: args.type || 'session',
          qq: args.qq || resolved.qq,
          peer: resolved.peer,
        }) as any;
      },
    }),
    defineTool({
      name: 'append_memory',
      description: '向当前群聊/私聊 Session 规则或用户画像中追加一条新事实、偏好或约定。',
      parameters: {
        type: {
          type: 'string',
          enum: ['session', 'user'],
          required: true,
          description: "记忆类型：'session' 表示追加到群聊/私聊约定；'user' 表示追加到个人用户偏好。",
        },
        content: {
          type: 'string',
          required: true,
          description: '需要追加的记忆内容条目。',
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
            text: value.message,
          },
        ],
      },
      async execute(args: any, exec) {
        const resolved = resolveContextPeerAndQQ(exec);
        return tools.appendMemory({
          type: args.type || 'session',
          content: args.content,
          qq: args.qq || resolved.qq,
          peer: resolved.peer,
        }) as any;
      },
    }),
    defineTool({
      name: 'update_memory',
      description: '全量重写当前群聊/私聊 Session 记忆规则或某用户的完整个人画像 Markdown。',
      parameters: {
        type: {
          type: 'string',
          enum: ['session', 'user'],
          required: true,
          description: "记忆类型：'session' 表示重写群聊/私聊约定；'user' 表示重写个人用户画像。",
        },
        content: {
          type: 'string',
          required: true,
          description: '新的完整 Markdown 内容。',
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
            text: value.message,
          },
        ],
      },
      async execute(args: any, exec) {
        const resolved = resolveContextPeerAndQQ(exec);
        return tools.updateMemory({
          type: args.type || 'session',
          content: args.content,
          qq: args.qq || resolved.qq,
          peer: resolved.peer,
        }) as any;
      },
    }),
  ];
}
