/**
 * dsh-napcat-bridge Settings Card Styles — visual language aligned with official
 * DSH plugin cards (`dsh-client-ui-settings-plugins` PluginCard / fields).
 *
 * Token surface: `var(--dsw-alias-*)` (official DSH design system tokens).
 */

export const NAPCAT_CARD_CSS_ID = 'dsh-napcat-bridge/card.module.css';

const NAPCAT_CARD_CSS = `
.napcat_card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;list-style:none;margin:0;transition:border-color .16s,background .16s}
.napcat_card:hover{border-color:var(--dsw-alias-label-dimmed)}
.napcat_cardOpen{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}
.napcat_header{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:0 0;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}
.napcat_header:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.napcat_headText{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}
.napcat_name{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4;margin:0}
.napcat_description{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5;margin:0}
.napcat_chevron{color:var(--dsw-alias-label-tertiary);flex:none;transition:transform .16s}
.napcat_chevronOpen{transform:rotate(180deg)}
.napcat_badgePending{white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;flex:none;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px}
.napcat_body{border-top:1px solid var(--dsw-alias-border-l2);margin:0 16px;padding-bottom:8px}
.napcat_footer{border-top:1px solid var(--dsw-alias-border-l2);justify-content:flex-end;align-items:center;gap:8px;padding:12px 0 4px;display:flex}
.napcat_failed{min-width:0;color:var(--dsw-alias-label-error);flex:1;margin:0;font-size:12px;line-height:1.5}
.napcat_discard,.napcat_save{appearance:none;font:inherit;cursor:pointer;border:1px solid transparent;border-radius:8px;padding:5px 14px;font-size:13px;line-height:1.5}
.napcat_discard{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:0 0}
.napcat_discard:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}
.napcat_save{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}
.napcat_discard:disabled,.napcat_save:disabled{opacity:.4;cursor:default}
.napcat_discard:focus-visible,.napcat_save:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.napcat_field{flex-direction:column;gap:6px;padding:12px 0;display:flex}
.napcat_field+.napcat_field{border-top:1px solid var(--dsw-alias-border-l2)}
.napcat_switchRow{flex-direction:row;align-items:center;justify-content:space-between;gap:8px}
.napcat_fieldHead{align-items:center;gap:8px;display:flex}
.napcat_fieldLabel{min-width:0;color:var(--dsw-alias-label-primary);flex:1;font-size:13px;font-weight:500;line-height:1.5}
.napcat_fieldBadges{align-items:center;gap:8px;display:inline-flex}
.napcat_fieldBadge{white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px}
.napcat_fieldBadgeMuted{white-space:nowrap;color:var(--dsw-alias-label-tertiary);border-radius:999px;padding:1px 8px;font-size:11px;line-height:17px}
.napcat_fieldReset{font:inherit;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;padding:0;font-size:12px;line-height:1.5}
.napcat_fieldReset:hover:not(:disabled){color:var(--dsw-alias-label-primary)}
.napcat_fieldReset:disabled{cursor:default}
.napcat_input{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);height:34px;font:inherit;color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 12px;font-size:13px;line-height:1.5}
.napcat_textarea{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);min-height:72px;font:inherit;color:var(--dsw-alias-label-primary);border-radius:8px;padding:8px 12px;font-size:13px;line-height:1.5;resize:vertical}
.napcat_input:focus-visible,.napcat_textarea:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-1px}
.napcat_input:disabled,.napcat_textarea:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}
.napcat_inputInvalid{border-color:var(--dsw-alias-label-error)}
.napcat_invalid{color:var(--dsw-alias-label-error);margin:0;font-size:12px;line-height:1.5}
.napcat_hint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:1.5}
.napcat_checkbox{accent-color:var(--dsw-alias-brand-primary);width:18px;height:18px;cursor:pointer;flex:none}
.napcat_checkbox:disabled{cursor:default;opacity:.4}
`;

export function injectCardStyles(): void {
  if (typeof document === 'undefined') return;
  const selector = `style[data-plugin-css=${JSON.stringify(NAPCAT_CARD_CSS_ID)}]`;
  if (document.querySelector(selector) !== null) return;
  const tag = document.createElement('style');
  tag.dataset.pluginCss = NAPCAT_CARD_CSS_ID;
  tag.textContent = NAPCAT_CARD_CSS;
  document.head.appendChild(tag);
}

export const cardStyle = {
  card: 'napcat_card',
  cardOpen: 'napcat_cardOpen',
  header: 'napcat_header',
  headText: 'napcat_headText',
  name: 'napcat_name',
  description: 'napcat_description',
  chevron: 'napcat_chevron',
  chevronOpen: 'napcat_chevronOpen',
  badgePending: 'napcat_badgePending',
  body: 'napcat_body',
  footer: 'napcat_footer',
  failed: 'napcat_failed',
  discard: 'napcat_discard',
  save: 'napcat_save',
};

export const fieldStyle = {
  field: 'napcat_field',
  head: 'napcat_fieldHead',
  label: 'napcat_fieldLabel',
  badges: 'napcat_fieldBadges',
  badge: 'napcat_fieldBadge',
  badgeMuted: 'napcat_fieldBadgeMuted',
  reset: 'napcat_fieldReset',
  input: 'napcat_input',
  textarea: 'napcat_textarea',
  inputInvalid: 'napcat_inputInvalid',
  invalid: 'napcat_invalid',
  hint: 'napcat_hint',
  checkbox: 'napcat_checkbox',
};
