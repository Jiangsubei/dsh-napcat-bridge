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
.napcat_tabBar{display:flex;gap:4px;border-bottom:1px solid var(--dsw-alias-border-l2);padding:8px 0 0;margin:0;overflow-x:auto}
.napcat_tab{appearance:none;background:0 0;border:none;border-bottom:2px solid transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;font-weight:500;line-height:1.5;padding:6px 12px 8px;cursor:pointer;border-radius:6px 6px 0 0;transition:color .16s,border-color .16s;white-space:nowrap}
.napcat_tab:hover:not(:disabled){color:var(--dsw-alias-label-primary)}
.napcat_tabActive{color:var(--dsw-alias-label-primary);font-weight:600;border-bottom-color:var(--dsw-alias-brand-primary)}
.napcat_tab:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-1px}
.napcat_tabPanel{display:flex;flex-direction:column}
.napcat_tabPanelHidden{display:none !important}
.napcat_section{display:flex;flex-direction:column;width:100%;min-height:0;flex:1;padding:4px 0 24px;box-sizing:border-box}
.napcat_sectionHead{margin-bottom:16px;display:flex;flex-direction:column;gap:6px}
.napcat_sectionTitleRow{display:flex;align-items:center;gap:12px}
.napcat_sectionTitle{color:var(--dsw-alias-label-primary);font-size:20px;font-weight:600;line-height:1.4;margin:0}
.napcat_sectionDescription{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5;margin:0}
.napcat_sectionBody{display:flex;flex-direction:column;flex:1}
.napcat_faceUploadBar{display:flex;align-items:center;gap:10px;padding:12px 0;flex-wrap:wrap}
.napcat_faceGallery{margin-top:16px;display:flex;flex-direction:column;gap:12px;border-top:1px solid var(--dsw-alias-border-l2);padding-top:12px}
.napcat_faceGalleryHead{display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px}
.napcat_faceGalleryTitle{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary);margin:0}
.napcat_faceGallerySub{font-size:12px;color:var(--dsw-alias-label-tertiary);margin:0}
.napcat_faceGrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:10px}
.napcat_faceCard{position:relative;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:8px;padding:8px;text-align:center;transition:border-color .16s,background .16s}
.napcat_faceCard:hover{border-color:var(--dsw-alias-label-dimmed);background:var(--dsw-alias-bg-layer-2)}
.napcat_faceCardPreview{height:64px;display:flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-tertiary)}
.napcat_faceCardTitle{font-size:12px;color:var(--dsw-alias-label-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:4px}
.napcat_faceCardActions{position:absolute;top:6px;right:6px;display:flex;gap:4px}
.napcat_faceActionBtn{appearance:none;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);border-radius:4px;cursor:pointer;padding:3px;display:inline-flex;align-items:center;justify-content:center;transition:color .16s,border-color .16s}
.napcat_faceActionBtn:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}
.napcat_faceActionDelete:hover{color:var(--dsw-alias-label-error);border-color:var(--dsw-alias-label-error)}
.napcat_faceInlineEditor{margin-top:8px;padding:6px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;display:flex;flex-direction:column;gap:6px}
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
  tabBar: 'napcat_tabBar',
  tab: 'napcat_tab',
  tabActive: 'napcat_tabActive',
  tabPanel: 'napcat_tabPanel',
  tabPanelHidden: 'napcat_tabPanelHidden',
  footer: 'napcat_footer',
  failed: 'napcat_failed',
  discard: 'napcat_discard',
  save: 'napcat_save',
};

export const sectionStyle = {
  section: 'napcat_section',
  head: 'napcat_sectionHead',
  titleRow: 'napcat_sectionTitleRow',
  title: 'napcat_sectionTitle',
  description: 'napcat_sectionDescription',
  body: 'napcat_sectionBody',
  tabBar: 'napcat_tabBar',
  tab: 'napcat_tab',
  tabActive: 'napcat_tabActive',
  tabPanel: 'napcat_tabPanel',
  tabPanelHidden: 'napcat_tabPanelHidden',
  footer: 'napcat_footer',
  failed: 'napcat_failed',
  discard: 'napcat_discard',
  save: 'napcat_save',
  badgePending: 'napcat_badgePending',
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

export const faceStyle = {
  uploadBar: 'napcat_faceUploadBar',
  gallery: 'napcat_faceGallery',
  galleryHead: 'napcat_faceGalleryHead',
  galleryTitle: 'napcat_faceGalleryTitle',
  gallerySub: 'napcat_faceGallerySub',
  grid: 'napcat_faceGrid',
  card: 'napcat_faceCard',
  cardPreview: 'napcat_faceCardPreview',
  cardTitle: 'napcat_faceCardTitle',
  cardActions: 'napcat_faceCardActions',
  actionBtn: 'napcat_faceActionBtn',
  actionDelete: 'napcat_faceActionDelete',
  inlineEditor: 'napcat_faceInlineEditor',
};
