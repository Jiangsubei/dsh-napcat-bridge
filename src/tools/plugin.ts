/**
 * dsh-napcat-bridge: NapCat 工具集 Cordis 插件
 * 供 DSH 预设 (@deepseek-ai/dsh-agent-preset) 或 Agent 作用域作为独立 row 挂载。
 */

import type { Context } from '@deepseek-ai/cordis';

export const name = 'napcat-tools';
export const inject = ['tools'];

export interface NapCatBridgeToolsProvider {
  registerTools(ctx: Context): () => void;
}

let globalBridgeToolsProvider: NapCatBridgeToolsProvider | undefined;

export function setGlobalBridgeToolsProvider(provider: NapCatBridgeToolsProvider | undefined): void {
  globalBridgeToolsProvider = provider;
}

export function getGlobalBridgeToolsProvider(): NapCatBridgeToolsProvider | undefined {
  return globalBridgeToolsProvider;
}

export function apply(ctx: Context): void {
  const getProvider = (): NapCatBridgeToolsProvider | undefined => {
    return (
      (typeof (ctx as any).get === 'function' ? (ctx as any).get('napcatBridgeTools') : undefined) ||
      (ctx as any).napcatBridgeTools ||
      (ctx.root as any)?.napcatBridgeTools ||
      globalBridgeToolsProvider
    );
  };

  const provider = getProvider();
  if (provider && typeof provider.registerTools === 'function') {
    const unregister = provider.registerTools(ctx);
    if (typeof (ctx as any).effect === 'function') {
      (ctx as any).effect(() => () => {
        try {
          unregister();
        } catch {}
      }, 'napcat-tools.effect');
    } else {
      (ctx as any).on?.('dispose', () => {
        try {
          unregister();
        } catch {}
      });
    }
  }
}

export default { name, inject, apply };
