import React from 'react';
import { cardStyle } from '../../card-styles.js';
import { BlacklistSection } from './BlacklistSection.js';
import { SessionPermissionSection } from './SessionPermissionSection.js';
import { CodingToolsSection } from './CodingToolsSection.js';
import type { BridgePluginConfig } from '../../../types/index.js';
import type { NapCatFormModel } from '../../model.js';

export interface SecurityTabProps {
  active: boolean;
  draft: Partial<BridgePluginConfig>;
  model: NapCatFormModel;
  saving: boolean;
  onFieldChange: (key: keyof BridgePluginConfig, val: any) => void;
  onResetField: (key: keyof BridgePluginConfig) => void;
}

export function SecurityTab(props: SecurityTabProps): React.JSX.Element {
  const { active, draft, model, saving, onFieldChange, onResetField } = props;

  return (
    <div
      id="napcat-tabpanel-security"
      data-testid="napcat-tabpanel-security"
      role="tabpanel"
      aria-labelledby="napcat-tab-security"
      hidden={!active}
      className={[
        cardStyle.tabPanel,
        !active ? cardStyle.tabPanelHidden : '',
      ].filter(Boolean).join(' ')}
      style={!active ? { display: 'none' } : undefined}
    >
      <BlacklistSection draft={draft} onFieldChange={onFieldChange} />
      <SessionPermissionSection draft={draft} saving={saving} onFieldChange={onFieldChange} />
      <CodingToolsSection
        draft={draft}
        model={model}
        saving={saving}
        onFieldChange={onFieldChange}
        onResetField={onResetField}
      />
    </div>
  );
}

export { BlacklistSection, SessionPermissionSection, CodingToolsSection };
