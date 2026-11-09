/**
 * Agent IPC 内部通用辅助
 */

import type { ToolExecutionContext } from '../common/context.js';

/**
 * 从本次工具调用的执行上下文补齐真实发起方 Session ID。
 *
 * Agent IPC 的 contextGetter 读取的是进程级 globalToolContext，它不携带调用方身份；
 * 若只依赖 ctx.sessionId，send_agent_message / create_target_agent 会把来源写成
 * 字面量 'agent'，导致对方收到无法寻址的回执地址。
 */
export function withInvocationSession(ctx: ToolExecutionContext, exec: any): ToolExecutionContext {
  const rawSessionId = exec?.agent?.session?.id;
  if (typeof rawSessionId !== 'string' || rawSessionId.trim() === '') {
    return ctx;
  }
  return { ...ctx, sessionId: rawSessionId };
}
