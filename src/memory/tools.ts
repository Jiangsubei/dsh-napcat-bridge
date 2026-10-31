/**
 * dsh-napcat-bridge: Memory Agent 工具集
 * 实现 read_memory, create_memory, edit_memory 及其 DSH defineTool 声明与上下文绑定。
 */

import type { Context } from '@deepseek-ai/cordis';
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { MemoryStorage } from './storage.js';
import type { MemoryOperationResult, MemoryType } from './types.js';
import {
  DEFAULT_USER_PROFILE_BUDGET_CHARS,
  DEFAULT_SESSION_MEMORY_BUDGET_CHARS,
} from '../constants/index.js';

export interface ReadMemoryArgs {
  type?: MemoryType;
  user_id?: string;
  qq?: string;
  peer?: string;
}

export interface CreateMemoryArgs {
  type: MemoryType;
  content: string;
  user_id?: string;
  qq?: string;
  peer?: string;
}

export interface EditMemoryArgs {
  type: MemoryType;
  old_string: string;
  new_string?: string;
  user_id?: string;
  qq?: string;
  peer?: string;
}

/**
 * 从 SessionId 或 Context 中解析 Peer (group_xxx / user_xxx) 与 QQ 号
 */
export function resolveContextPeerAndQQ(
  context?: unknown,
  getCurrentSpeaker?: (peer: string) => string | undefined
): { peer: string; qq: string } {
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

  // D2/B13: 严禁伪造字段猜测 userId；真实发言人经由真实上下文与事件记录提供
  if (getCurrentSpeaker && peer !== 'default') {
    const speaker = getCurrentSpeaker(peer);
    if (typeof speaker === 'string' && speaker.trim()) {
      qq = speaker.trim();
    }
  }

  return { peer, qq };
}

export interface MemoryToolsLimits {
  /** 单个用户画像文件的写入上限 */
  getUserProfileLimit?: () => number;
  /** 单个 Session 规则文件的写入上限 */
  getSessionLimit?: () => number;
}

export class MemoryTools {
  constructor(
    private storage: MemoryStorage,
    private ctx?: Context,
    private limits?: MemoryToolsLimits
  ) {}

  private getUserProfileLimit(): number {
    return this.limits?.getUserProfileLimit?.() ?? DEFAULT_USER_PROFILE_BUDGET_CHARS;
  }

  private getSessionLimit(): number {
    return this.limits?.getSessionLimit?.() ?? DEFAULT_SESSION_MEMORY_BUDGET_CHARS;
  }

  /**
   * 归一化 user 类型的记忆 identity（目标用户的 QQ 号）。
   * 优先级：显式 user_id / qq > peer 的 user_ 前缀派生 > 报错（不再退回 default）。
   */
  private resolveUserTarget(args: { user_id?: string; qq?: string; peer?: string }): string | null {
    const raw = args.user_id ?? args.qq;
    const uid = raw?.trim();
    if (uid && uid !== 'default') return uid;
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
        return { success: false, message: 'user 类型记忆必须指定 user_id 参数（目标用户的 QQ 号）或传入 user_xxx 格式的 peer。' };
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

    const limit = type === 'user' ? this.getUserProfileLimit() : this.getSessionLimit();
    if (content.length > limit) {
      return {
        success: false,
        message: `${type === 'user' ? '用户画像' : 'Session 记忆'}内容长度 (${content.length} 字符) 超出上限 (${limit} 字符)，本次创建未写入。请精简提炼到 ${limit} 字符以内后重新调用 create_memory，或先创建一份简短的基础内容，再用 edit_memory 增量补充。`,
      };
    }

    if (type === 'user') {
      const targetQQ = this.resolveUserTarget(args);
      if (!targetQQ) {
        return { success: false, message: 'user 类型记忆必须指定 user_id 参数（目标用户的 QQ 号）或传入 user_xxx 格式的 peer。' };
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

    if (type === 'user') {
      const targetQQ = this.resolveUserTarget(args);
      if (!targetQQ) {
        return { success: false, message: 'user 类型记忆必须指定 user_id 参数（目标用户的 QQ 号）或传入 user_xxx 格式的 peer。' };
      }
      target = targetQQ;
    } else {
      const targetPeer = args.peer?.trim();
      if (!targetPeer || targetPeer === 'default') {
        return { success: false, message: 'session 记忆必须指定 peer 参数（如 peer="group_xxx" 或 peer="user_xxx"）。' };
      }
      target = targetPeer;
    }

    const oldStr = args.old_string;
    const newStr = args.new_string ?? '';
    let preview = '';

    const doReplace = (currentContent: string) => {
      if (!currentContent || !currentContent.trim()) {
        throw new Error('目标记忆不存在，请先 create_memory 创建。');
      }

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
        throw new Error('old_string 未在当前记忆中找到，可能内容已变化，请先 read_memory 获取最新内容。');
      }

      if (count >= 2) {
        throw new Error(`old_string 出现 ${count} 次，请补充更多上下文使其唯一。`);
      }

      // 唯一匹配替换（空/省略 = 删除匹配片段）
      const newContent =
        currentContent.slice(0, firstIndex) + newStr + currentContent.slice(firstIndex + oldStr.length);

      const limit = type === 'user' ? this.getUserProfileLimit() : this.getSessionLimit();
      if (newContent.length > limit) {
        throw new Error(
          `${type === 'user' ? '用户画像' : 'Session 记忆'}编辑后总长度 (${newContent.length} 字符) 超出上限 (${limit} 字符)，本次编辑未落盘。还需再缩减 ${newContent.length - limit} 字符；请精简合并或删除过时、冗余条目后重试。`
        );
      }

      const preStart = Math.max(0, firstIndex - 30);
      const postEnd = Math.min(newContent.length, firstIndex + newStr.length + 30);
      preview = newContent.slice(preStart, postEnd);
      return newContent;
    };

    let updateResult: { success: boolean; content: string; error?: string };
    if (type === 'user') {
      if (!(await this.storage.existsUserProfile(target))) {
        return { success: false, message: '目标记忆不存在，请先 create_memory 创建。' };
      }
      updateResult = await this.storage.updateUserProfile(target, doReplace);
    } else {
      if (!(await this.storage.existsSessionMemory(target))) {
        return { success: false, message: '目标记忆不存在，请先 create_memory 创建。' };
      }
      updateResult = await this.storage.updateSessionMemory(target, doReplace);
    }

    if (!updateResult.success) {
      return {
        success: false,
        message: updateResult.error || '编辑记忆失败。',
      };
    }

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
      description:
        '读取当前会话（type=\'session\'）的规则与文化记忆，或指定用户（type=\'user\'）的个人画像。适用于在日常交流或协助任务中，主动查阅以掌握用户深层偏好、习惯风格或确认群专属约定与互动氛围；当上下文快照提示画像未完全展示时按需查阅，或作为调用 edit_memory 精简修改前获取最新内容与唯一 old_string 的前置工具。日常对话若上下文中已有清晰背景则无需频繁调用。',
      parameters: {
        type: {
          type: 'string',
          enum: ['session', 'user'],
          required: true,
          description: "记忆类型：'session' 表示群聊/私聊规则与文化；'user' 表示个人用户画像。",
        },
        peer: {
          type: 'string',
          description: "目标会话 Peer（如 'group_xxx' 或 'user_xxx'，留空自动绑定当前会话）。",
        },
        user_id: {
          type: 'string',
          description: '目标用户的 QQ 号（仅当 type="user" 时有效，留空自动绑定当前对话者）。',
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
        if (resolved.peer === 'default' && !args.peer && !args.user_id) {
          return { success: false, message: '请显式传入 peer 参数（如 peer="group_xxx" 或 peer="user_xxx"）' };
        }
        return tools.readMemory({
          type: args.type || 'session',
          user_id: args.user_id || resolved.qq,
          peer: args.peer || resolved.peer,
        }) as any;
      },
    }),
    defineTool({
      name: 'create_memory',
      description:
        '首次创建跨场景通用的个人偏好画像（type=\'user\'），或当前会话专属的规则与文化（type=\'session\'）。适用于在交流或日常闲聊中发现用户确定性事实与长期偏好（如工作风格、技术栈习惯、人设与称呼偏好），或捕捉到群聊长期约定、群规与专属互动氛围时主动建立档案；亦在用户明确要求记住设定时调用。网络梗、词汇代称与社群黑话请使用专有黑话工具（record_slang），勿存入记忆；目标记忆已存在时勿重复创建，应使用 edit_memory 进行更新融合。严禁记录单次排查流水账、命令参数与操作手册、一次性跑分、临时报错、路过客套寒暄、单次复读摸鱼，以及因临时环境问题得出的负面断言。内容须保持紧凑高信号的单行陈述（如 "- 偏好：xxx" 或 "- 互动约定：xxx"），避免长篇叙事。',
      parameters: {
        type: {
          type: 'string',
          enum: ['session', 'user'],
          required: true,
          description: "记忆类型：'user' 表示创建用户跨场景稳定画像（群聊/私聊同一份）；'session' 表示创建当前会话专属规则与文化。",
        },
        content: {
          type: 'string',
          required: true,
          description: '要写入的完整记忆内容。必须为简练紧凑的 Markdown 条目（建议单条 <80 字），严禁流水账叙事。',
        },
        peer: {
          type: 'string',
          description: "目标会话 Peer（如 'group_xxx' 或 'user_xxx'，留空自动绑定当前会话）。",
        },
        user_id: {
          type: 'string',
          description: '目标用户的 QQ 号（仅当 type="user" 时有效，留空自动绑定当前对话者）。',
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
        if (resolved.peer === 'default' && !args.peer && !args.user_id) {
          return { success: false, message: '请显式传入 peer 参数（如 peer="group_xxx" 或 peer="user_xxx"）' };
        }
        return tools.createMemory({
          type: args.type || 'session',
          content: args.content,
          user_id: args.user_id || resolved.qq,
          peer: args.peer || resolved.peer,
        }) as any;
      },
    }),
    defineTool({
      name: 'edit_memory',
      description:
        '定向修改、更新、合并或精简已有的长期记忆条目。通过唯一匹配 old_string 替换为 new_string（若 new_string 省略或为空字符串则直接删除匹配片段）。适用于在交流与闲聊中捕捉到用户习惯演化、新事实补充时主动更新已有记忆，或在条目冗余时主动精简合并、删减失效过时的琐碎内容，使记忆持续保持高信号；亦在用户明确要求纠正、变更或删除设定时调用。维护词条级黑话请使用 manage_slang；切勿记录临时排查流水账或偶然分歧。内容保持单行精简陈述，调用前可结合 read_memory 确保 old_string 文本唯一准确。',
      parameters: {
        type: {
          type: 'string',
          enum: ['session', 'user'],
          required: true,
          description: "记忆类型：'user' 表示修改用户跨场景稳定画像；'session' 表示修改当前会话专属规则。",
        },
        old_string: {
          type: 'string',
          required: true,
          description: '待替换或删除的既有内容片段，必须在目标文件中唯一出现。',
        },
        new_string: {
          type: 'string',
          description: '替换后的新内容（保持精炼单行）；省略或为空字符串则直接删除匹配的 old_string 片段。',
        },
        peer: {
          type: 'string',
          description: "目标会话 Peer（如 'group_xxx' 或 'user_xxx'，留空自动绑定当前会话）。",
        },
        user_id: {
          type: 'string',
          description: '目标用户的 QQ 号（仅当 type="user" 时有效，留空自动绑定当前对话者）。',
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
        if (resolved.peer === 'default' && !args.peer && !args.user_id) {
          return { success: false, message: '请显式传入 peer 参数（如 peer="group_xxx" 或 peer="user_xxx"）' };
        }
        return tools.editMemory({
          type: args.type || 'session',
          old_string: args.old_string,
          new_string: args.new_string,
          user_id: args.user_id || resolved.qq,
          peer: args.peer || resolved.peer,
        }) as any;
      },
    }),
  ];
}
