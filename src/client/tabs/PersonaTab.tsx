import React from 'react';
import { TextAreaField } from '../fields.js';
import { cardStyle } from '../card-styles.js';
import type { BridgePluginConfig } from '../../types/index.js';
import type { NapCatFormModel } from '../model.js';

export interface PersonaTabProps {
  active: boolean;
  draft: Partial<BridgePluginConfig>;
  model: NapCatFormModel;
  saving: boolean;
  onFieldChange: (key: keyof BridgePluginConfig, val: any) => void;
  onResetField: (key: keyof BridgePluginConfig) => void;
}

export function PersonaTab(props: PersonaTabProps): React.JSX.Element {
  const { active, draft, model, saving, onFieldChange, onResetField } = props;

  return (
    <div
      id="napcat-tabpanel-persona"
      data-testid="napcat-tabpanel-persona"
      role="tabpanel"
      aria-labelledby="napcat-tab-persona"
      hidden={!active}
      className={[
        cardStyle.tabPanel,
        !active ? cardStyle.tabPanelHidden : '',
      ].filter(Boolean).join(' ')}
      style={!active ? { display: 'none' } : undefined}
    >
      <TextAreaField
        id="napcat-persona"
        label="助手人格设定 (persona)"
        hint="注入 Agent 动态 System Prompt 的角色设定 (保护静态 KV 缓存)"
        placeholder="例如: 你是一个运行在 QQ 群内的智能编程助理..."
        value={draft.persona || ''}
        disabled={saving}
        overridden={model.isOverridden('persona')}
        onReset={() => onResetField('persona')}
        onChange={(val) => onFieldChange('persona', val)}
      />

      <TextAreaField
        id="napcat-behavior"
        label="行为准则 (behavior)"
        hint="注入 Agent 动态 System Prompt 的行为准则与回答风格要求"
        placeholder="例如: 回答请简洁有力，避免冗长代码，必要时主动调用 read_chat_history..."
        value={draft.behavior || ''}
        disabled={saving}
        overridden={model.isOverridden('behavior')}
        onReset={() => onResetField('behavior')}
        onChange={(val) => onFieldChange('behavior', val)}
      />
    </div>
  );
}
