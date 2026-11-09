/**
 * dsh-napcat-bridge: 思考深度探测与元数据解析模块
 */

import type { Context } from '@deepseek-ai/cordis';
import { safeGetService } from '../../gateway/session/agent-runner.js';
import type { ModelReasoningMetadata } from './types.js';

/**
 * 从 DSH LLM 服务动态获取指定模型的思考深度能力与支持的档位列表
 */
export async function getModelReasoningInfo(
  ctx: Context,
  provider: string,
  model: string,
  explicitEffort?: string
): Promise<ModelReasoningMetadata> {
  const llm = safeGetService(ctx, 'llm');
  if (llm && typeof llm.resolveModelInfo === 'function') {
    try {
      const info = await llm.resolveModelInfo(provider, model);
      if (info && info.reasoning && Array.isArray(info.reasoning.efforts) && info.reasoning.efforts.length > 0) {
        const efforts = info.reasoning.efforts.map((e: any) => ({
          id: String(e.id),
          name: String(e.name || e.id),
          description: e.description ? String(e.description) : undefined,
        }));
        const defaultEffort = info.reasoning.defaultEffort
          ? String(info.reasoning.defaultEffort)
          : efforts[0]?.id;
        const currentEffort = explicitEffort || defaultEffort;
        return {
          supported: true,
          efforts,
          defaultEffort,
          currentEffort,
          isDefault: !explicitEffort || explicitEffort === defaultEffort,
        };
      } else if (info && info.reasoning === undefined) {
        // 明确当前模型无思考能力
        return { supported: false, efforts: [], isDefault: true };
      }
    } catch {}
  }

  // 保底：若为官方 DeepSeek 适配器但 resolveModelInfo 失败或为离线测试桩
  if (provider === 'deepseek-official') {
    const efforts = [
      { id: 'off', name: 'Off', description: '关闭思考' },
      { id: 'low', name: 'Low', description: '常规或低延迟任务' },
      { id: 'high', name: 'High', description: '多数任务推荐（默认）' },
      { id: 'max', name: 'Max', description: '复杂任务深度思考' },
    ];
    return {
      supported: true,
      efforts,
      defaultEffort: 'high',
      currentEffort: explicitEffort || 'high',
      isDefault: !explicitEffort || explicitEffort === 'high',
    };
  }

  return { supported: false, efforts: [], isDefault: true };
}
