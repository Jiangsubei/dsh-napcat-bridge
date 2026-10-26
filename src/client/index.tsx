/**
 * dsh-napcat-bridge Client WebUI Plugin Entry Point
 * Injects NapCat settings card into the DSH Web UI settings.section extension slot.
 */

import { NapCatSettingsSection, NapCatSettingsCard } from './card.js';

export const name = 'dsh-napcat-bridge';
export const inject = ['slots'];

export function apply(ctx: any) {
  if (!ctx?.slots?.inject) return;

  // 注册 0.2.1 规范侧边栏独立设置板块 (settings.section)
  ctx.slots.inject('settings.section', function* () {
    yield ctx.slots.register(
      {
        name: 'settings.section',
        id: 'napcat',
        order: 55,
        label: () => 'QQ NapCat',
      },
      NapCatSettingsSection
    );
  });
}

export { NapCatSettingsSection, NapCatSettingsCard };
