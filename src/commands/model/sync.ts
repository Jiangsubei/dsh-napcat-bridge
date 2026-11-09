/**
 * dsh-napcat-bridge: 会话模型同步互斥链模块
 */

import type { Context } from '@deepseek-ai/cordis';
import { safeGetService } from '../../gateway/session/agent-runner.js';

let syncModelChain: Promise<void> = Promise.resolve();

/**
 * 同步宿主会话模型选择 (包含可选 reasoningEffort)
 * 采用 Promise 互斥链，杜绝并发调用及 -g 批量同步时的竞态条件
 */
export async function safeSyncSessionModel(
  ctx: Context,
  sessionId: string,
  provider: string,
  model: string,
  reasoningEffort?: string
): Promise<void> {
  const op = async () => {
    const sessionController = safeGetService(ctx, 'sessionController');
    if (!sessionController?.selectModel) return;

    await sessionController.selectModel({
      sessionId,
      provider,
      model,
      ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    });
  };

  const next = syncModelChain.then(op, op);
  syncModelChain = next.catch(() => {});
  await next;
}
