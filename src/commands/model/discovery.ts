/**
 * dsh-napcat-bridge: LLM 模型发现与探测模块
 */

import type { Context } from '@deepseek-ai/cordis';
import { safeGetService } from '../../gateway/session/agent-runner.js';
import type { DiscoveredModelInfo } from './types.js';

export async function getDiscoveredModels(ctx: Context): Promise<DiscoveredModelInfo[]> {
  const llm = safeGetService(ctx, 'llm');
  if (llm && typeof llm.listProviders === 'function') {
    try {
      const providers = llm.listProviders();
      const discovered: DiscoveredModelInfo[] = [];
      for (const provider of providers) {
        try {
          const models = await llm.listModels(provider.id);
          for (const m of models) {
            discovered.push({
              provider: provider.id,
              providerName: provider.name,
              model: m.id,
              modelName: m.name,
            });
          }
        } catch {}
      }
      if (discovered.length > 0) return discovered;
    } catch {}
  }

  // 保底默认已知模型列表
  return [
    { provider: 'deepseek-official', providerName: 'DeepSeek', model: 'deepseek-flash', modelName: 'DeepSeek-V41-Flash' },
    { provider: 'deepseek-official', providerName: 'DeepSeek', model: 'deepseek-v4-flash', modelName: 'DeepSeek-V4-Flash' },
    { provider: 'deepseek-official', providerName: 'DeepSeek', model: 'deepseek-v4-pro', modelName: 'DeepSeek-V4-Pro' },
  ];
}
