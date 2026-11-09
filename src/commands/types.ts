/**
 * dsh-napcat-bridge: 斜杠命令通用类型定义
 */

import type { Context } from '@deepseek-ai/cordis';
import type { Session } from '@deepseek-ai/dsh-session';
import type { SessionManager } from '../gateway/session.js';

export interface CommandContext {
  userId: string;
  admins: string[];
  session: Session;
  ctx: Context;
  /** 可选：当前会话对应的活体 Agent 实例 */
  agent?: any;
  /** 可选：per-session 模型选择落位 (Spec §8.1 /model 为 Per-Session 语义) */
  sessionManager?: SessionManager;
}

export interface CommandResult {
  handled: boolean;
  success?: boolean;
  reply?: string;
  error?: string;
  /** 可选：两段式异步结果追加（用于长耗时异步操作，如 /压缩） */
  followUp?: () => Promise<string | undefined>;
}

export type CommandHandler = (
  args: string,
  context: CommandContext
) => Promise<CommandResult> | CommandResult;
