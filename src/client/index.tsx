/**
 * dsh-napcat-bridge Client WebUI Plugin Entry Point
 * Injects NapCat settings card into the DSH Web UI settings.plugin.item extension slot.
 */

import React from 'react';
import { NapCatSettingsCard } from './card.js';
import { SETTINGS_NAMESPACE } from '../constants/index.js';

export const name = 'dsh-napcat-bridge/client';
export const inject = ['slots', 'connection', 'settingsScope'];

/**
 * Build the card props bridge for one settings namespace.
 */
export function buildSettingsBridge(ctx: any, namespace: string = SETTINGS_NAMESPACE) {
  const describe = ctx.settingsScope?.describe?.() ?? null;
  const scope = ctx.settingsScope?.bind?.({ namespace }) ?? null;

  const readNamespace = () => {
    const view = describe?.getSnapshot?.().view;
    const row = view?.namespaces?.find((n: any) => n.ns === namespace);
    if (row) return row;
    const scopeSnap = scope?.getSnapshot?.();
    if (scopeSnap && scopeSnap.status !== 'unavailable') {
      return {
        value: scopeSnap.value ?? scopeSnap.user,
        revision: scopeSnap.revision,
        base: scopeSnap.base,
      };
    }
    return undefined;
  };

  return {
    get initialConfig() {
      return readNamespace()?.value ?? {};
    },
    get revision() {
      return readNamespace()?.revision ?? 0;
    },
    get baseDefaults() {
      return readNamespace()?.base ?? {};
    },
    get hasSecret() {
      return false;
    },
    onSaveSettings: async (
      values: Record<string, unknown>,
      options: { expectedRevision: number }
    ) => {
      const targetScope = scope ?? ctx.settingsScope?.bind?.({ namespace }) ?? ctx.settingsScope;
      if (!targetScope?.mutate) throw new Error('settings API 不可用');

      const ops = Object.entries(values ?? {}).map(([field, value]) => ({
        op: 'set' as const,
        path: [field],
        value,
      }));

      const latestRow = readNamespace();
      const expectedRevision =
        latestRow?.revision !== undefined ? latestRow.revision : options.expectedRevision;

      let res: any;
      try {
        res = await targetScope.mutate(ops, expectedRevision);
      } catch (err: any) {
        const errMsg = String(err?.message || '');
        if (
          errMsg.includes('changed since it was read') ||
          errMsg.includes('SETTINGS_CONFLICT') ||
          errMsg.includes('expected revision') ||
          errMsg.includes('conflict') ||
          err?.code === 'SETTINGS_CONFLICT'
        ) {
          const freshRow = readNamespace();
          const freshRev = freshRow?.revision ?? targetScope.getSnapshot?.().revision;
          if (freshRev !== undefined && freshRev !== expectedRevision) {
            res = await targetScope.mutate(ops, freshRev);
            if (res && typeof res === 'object') {
              const retryOk = res.ok ?? res.result?.ok;
              if (retryOk === false) {
                const retryErr = res.error || res.result?.error;
                throw new Error(retryErr?.message || 'settings.mutate 重试被拒绝');
              }
              return {
                revision:
                  res.value?.revision ?? res.result?.value?.revision ?? readNamespace()?.revision,
              };
            }
            const afterRetryRow = readNamespace();
            return { revision: afterRetryRow?.revision ?? targetScope.getSnapshot?.().revision };
          }
        }
        throw err;
      }

      // 1. If res returned an object (e.g. mock or RPC response)
      if (res && typeof res === 'object') {
        const isOk = res.ok ?? res.result?.ok;
        if (isOk === false) {
          const errMsg = String(res.error?.message || res.result?.error?.message || '');
          const isConflict =
            errMsg.includes('changed since it was read') ||
            errMsg.includes('SETTINGS_CONFLICT') ||
            errMsg.includes('expected revision') ||
            errMsg.includes('conflict') ||
            res.error?.code === 'SETTINGS_CONFLICT' ||
            res.result?.error?.code === 'SETTINGS_CONFLICT';

          if (isConflict || res.ok === false) {
            const freshRow = readNamespace();
            const freshRev = freshRow?.revision ?? targetScope.getSnapshot?.().revision;
            if (freshRev !== undefined && freshRev !== expectedRevision) {
              res = await targetScope.mutate(ops, freshRev);
            }
          }
        }

        const finalOk = res.ok ?? res.result?.ok;
        if (finalOk === false) {
          const err = res.error || res.result?.error;
          throw new Error(err?.message || 'settings.mutate 被拒绝');
        }

        const finalRev =
          res.value?.revision ?? res.result?.value?.revision ?? readNamespace()?.revision;
        return { revision: finalRev };
      }

      // 2. If res is undefined (official SettingsScopeController returns void)
      const afterRow = readNamespace();
      const afterRevision = afterRow?.revision ?? targetScope.getSnapshot?.().revision;

      if (afterRevision !== undefined && afterRevision > expectedRevision) {
        return { revision: afterRevision };
      }

      // Check if values landed
      const currentValues = afterRow?.value ?? targetScope.getSnapshot?.().value;
      const valuesLanded = Object.entries(values ?? {}).every(([k, v]) => {
        return JSON.stringify(currentValues?.[k]) === JSON.stringify(v);
      });

      if (valuesLanded) {
        return { revision: afterRevision };
      }

      // Values didn't land -> check if recover() reloaded a fresher revision
      if (afterRevision !== undefined && afterRevision !== expectedRevision) {
        const retryRes = await targetScope.mutate(ops, afterRevision);
        if (retryRes && typeof retryRes === 'object') {
          if (retryRes.ok ?? retryRes.result?.ok) {
            return {
              revision:
                retryRes.value?.revision ??
                retryRes.result?.value?.revision ??
                readNamespace()?.revision,
            };
          }
          throw new Error(
            retryRes.error?.message || retryRes.result?.error?.message || 'settings.mutate 重试被拒绝'
          );
        }
        const retryRow = readNamespace();
        const retryRev = retryRow?.revision ?? targetScope.getSnapshot?.().revision;
        const retryValues = retryRow?.value ?? targetScope.getSnapshot?.().value;
        const retryLanded = Object.entries(values ?? {}).every(([k, v]) => {
          return JSON.stringify(retryValues?.[k]) === JSON.stringify(v);
        });
        if (retryLanded || (retryRev !== undefined && retryRev > afterRevision)) {
          return { revision: retryRev };
        }
      }

      throw new Error('settings.mutate 被拒绝或保存冲突');
    },
  };
}

/**
 * 判断指定 Session ID 是否属于 QQ 桥接会话
 */
export function isQQSessionId(sessionId: unknown): boolean {
  if (typeof sessionId !== 'string' || !sessionId) return false;
  return (
    sessionId.startsWith('qq-group-') ||
    sessionId.startsWith('qq-user-') ||
    sessionId.startsWith('qq-')
  );
}

export interface QQComposerHiderProps {
  sessionId?: string;
  useSession?: (selector?: (session: any) => any) => any;
  useConversation?: (selector?: (conv: any) => any) => any;
}

/**
 * QQ 会话只读输入框卡片隐藏控制器：
 * 当处于 QQ 会话时，仅隐藏 [data-composer-card] 输入框卡片容器（包含多行输入区、
 * 提示文案、附件/模式切换以及右侧模型切换与发送按钮），
 * 下方的监控指标行（位于 conversation.composer.dock，显示轮步/速率/Token/命中率）完全不受影响。
 * 离开 QQ 会话切换到其他常规工作区会话时，自动返回 null 恢复原生输入框。
 */
export function QQComposerHider(props: QQComposerHiderProps): React.JSX.Element | null {
  const sessionId =
    (typeof props?.useSession === 'function'
      ? props.useSession((s: any) => s?.id)
      : undefined) ??
    props?.sessionId ??
    (typeof props?.useConversation === 'function'
      ? props.useConversation((c: any) => c?.sessionId)
      : undefined);

  if (!isQQSessionId(sessionId)) {
    return null;
  }

  return (
    <style
      data-dsh-napcat="hide-composer"
      dangerouslySetInnerHTML={{
        __html: `
[data-composer-card] {
  display: none !important;
}
`,
      }}
    />
  );
}

export function apply(ctx: any) {
  if (!ctx?.slots?.inject) return;

  // 1. 注册设置卡片
  ctx.slots.inject('settings.plugin.item', function* () {
    yield ctx.slots.register(
      {
        name: 'settings.plugin.item',
        key: 'dsh-napcat-bridge',
        inject: () => buildSettingsBridge(ctx, SETTINGS_NAMESPACE),
      },
      NapCatSettingsCard
    );
  });

  // 2. 注册 QQ 会话输入框卡片隐藏器（保留 dock 监控行）
  ctx.slots.inject('conversation.composer.dock', function* () {
    yield ctx.slots.register(
      {
        name: 'conversation.composer.dock',
        key: 'dsh-napcat-bridge-hide-composer',
        order: -100,
      },
      QQComposerHider
    );
  });
}

export { NapCatSettingsCard };

