/**
 * dsh-napcat-bridge Client WebUI Plugin Entry Point
 * Injects NapCat settings card into the DSH Web UI settings.plugin.item extension slot.
 */

import { NapCatSettingsCard } from './card.js';

export const name = 'dsh-napcat-bridge/client';
export const inject = ['slots', 'connection', 'settingsScope'];

/**
 * Build the card props bridge for one settings namespace.
 */
function buildSettingsBridge(ctx: any, namespace: string) {
  const describe = ctx.settingsScope?.describe?.() ?? null;
  const api = ctx.connection?.api ?? null;

  const readNamespace = () => {
    const view = describe?.getSnapshot?.().view;
    const row = view?.namespaces?.find((n: any) => n.ns === namespace);
    return row;
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
      if (!api?.settings?.update) throw new Error('settings API 不可用');
      const latestRow = readNamespace();
      const expectedRevision =
        latestRow?.revision !== undefined ? latestRow.revision : options.expectedRevision;
      let res = await api.settings.update({
        ns: namespace,
        patch: values,
        expectedRevision,
      });

      // If revision conflict occurs, re-read freshest revision and retry once
      if (!res?.result?.ok) {
        const errMsg = String(res?.result?.error?.message || '');
        if (
          errMsg.includes('changed since it was read') ||
          errMsg.includes('SETTINGS_CONFLICT') ||
          errMsg.includes('expected revision')
        ) {
          const freshRow = readNamespace();
          if (freshRow?.revision !== undefined && freshRow.revision !== expectedRevision) {
            res = await api.settings.update({
              ns: namespace,
              patch: values,
              expectedRevision: freshRow.revision,
            });
          }
        }
      }
      if (!res?.result?.ok) {
        const err = res?.result?.error;
        throw new Error(err?.message || 'settings.update 被拒绝');
      }
      return { revision: res?.result?.value?.revision as number | undefined };
    },
  };
}

export function apply(ctx: any) {
  if (!ctx?.slots?.inject) return;

  ctx.slots.inject('settings.plugin.item', function* () {
    yield ctx.slots.register(
      {
        name: 'settings.plugin.item',
        key: 'dsh-napcat-bridge',
        inject: () => buildSettingsBridge(ctx, 'dsh-napcat-bridge'),
      },
      NapCatSettingsCard
    );
  });
}

export { NapCatSettingsCard };
