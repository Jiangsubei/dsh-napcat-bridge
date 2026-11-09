import React from 'react';
import { ValueField } from '../fields.js';
import { cardStyle } from '../card-styles.js';
import type { BridgePluginConfig } from '../../types/index.js';
import type { NapCatFormModel } from '../model.js';

export interface MemoryTabProps {
  active: boolean;
  draft: Partial<BridgePluginConfig>;
  model: NapCatFormModel;
  saving: boolean;
  onFieldChange: (key: keyof BridgePluginConfig, val: any) => void;
  onResetField: (key: keyof BridgePluginConfig) => void;
}

export function MemoryTab(props: MemoryTabProps): React.JSX.Element {
  const { active, draft, model, saving, onFieldChange, onResetField } = props;

  return (
    <div
      id="napcat-tabpanel-memory"
      data-testid="napcat-tabpanel-memory"
      role="tabpanel"
      aria-labelledby="napcat-tab-memory"
      hidden={!active}
      className={[
        cardStyle.tabPanel,
        !active ? cardStyle.tabPanelHidden : '',
      ].filter(Boolean).join(' ')}
      style={!active ? { display: 'none' } : undefined}
    >
      <ValueField
        id="napcat-memory-storage-dir"
        label="记忆存储目录 (memory_storage_dir)"
        hint="Session 记忆与用户画像 Markdown 存储根目录 (默认 .dsh/napcat/napcat_memory)"
        placeholder=".dsh/napcat/napcat_memory"
        value={draft.memory_storage_dir || '.dsh/napcat/napcat_memory'}
        disabled={saving}
        overridden={model.isOverridden('memory_storage_dir')}
        onReset={() => onResetField('memory_storage_dir')}
        onChange={(val) => onFieldChange('memory_storage_dir', val)}
      />

      <ValueField
        id="napcat-user-profile-budget-chars"
        label="用户画像字符预算上限 (user_profile_budget_chars)"
        hint="单个用户画像文件的写入上限，跨群聊/私聊通用 (默认 2200)"
        placeholder="2200"
        numeric
        value={String(draft.user_profile_budget_chars ?? 2200)}
        disabled={saving}
        overridden={model.isOverridden('user_profile_budget_chars')}
        onReset={() => onResetField('user_profile_budget_chars')}
        onChange={(val) => onFieldChange('user_profile_budget_chars', parseInt(val, 10) || 2200)}
      />

      <ValueField
        id="napcat-session-memory-budget-chars"
        label="Session 规则字符预算上限 (session_memory_budget_chars)"
        hint="单个会话规则文件的写入上限，群聊与私聊统一 (默认 2200)"
        placeholder="2200"
        numeric
        value={String(draft.session_memory_budget_chars ?? 2200)}
        disabled={saving}
        overridden={model.isOverridden('session_memory_budget_chars')}
        onReset={() => onResetField('session_memory_budget_chars')}
        onChange={(val) => onFieldChange('session_memory_budget_chars', parseInt(val, 10) || 2200)}
      />

      <ValueField
        id="napcat-group-memory-total-budget-chars"
        label="群聊用户画像总预算上限 (group_memory_total_budget_chars)"
        hint="群聊注入时所有活跃群友画像合计的字符预算，Session 规则不计入 (默认 8000)"
        placeholder="8000"
        numeric
        value={String(draft.group_memory_total_budget_chars ?? 8000)}
        disabled={saving}
        overridden={model.isOverridden('group_memory_total_budget_chars')}
        onReset={() => onResetField('group_memory_total_budget_chars')}
        onChange={(val) => onFieldChange('group_memory_total_budget_chars', parseInt(val, 10) || 8000)}
      />
    </div>
  );
}
