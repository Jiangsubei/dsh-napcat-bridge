import React from 'react';
import { cardStyle, sectionStyle, injectCardStyles } from './card-styles.js';
import { SafeIconChevronDown } from './icons.js';
import { useCardState } from './use-card-state.js';
import { SectionErrorBoundary } from './error-boundary.js';
import { ConnectionTab, PersonaTab, ProactiveTab, SecurityTab, MemoryTab, FaceTab, SlangTab } from './tabs/index.js';
import type { BridgePluginConfig } from '../types/index.js';
import { DEFAULT_WS_PORT } from '../constants/index.js';
import { SETTINGS_TABS, type SettingsTabId, type TabItem, type CardController, type CardProps, type SettingsSectionProps } from './types.js';

export { DEFAULT_BASE_CONFIG, SETTINGS_TABS, type SettingsTabId, type TabItem, type CardController, type CardProps, type SettingsSectionProps };

const DEFAULT_BASE_CONFIG: Partial<BridgePluginConfig> = {
  ws_port: DEFAULT_WS_PORT,
  ws_token: '',
  bot_qq: '',
  admins: [],
  aliases: [],
  image_ttl_days: 7,
  persona: '',
  behavior: '',
  proactive_reply_enabled: false,
  proactive_interval_mins: 3,
  proactive_buffer_size: 10,
  proactive_only_text: false,
  proactive_random_enabled: false,
  proactive_random_probability: 0.05,
  proactive_idle_enabled: false,
  proactive_idle_timeout_mins: 120,
  proactive_cooldown_mins: 10,
  proactive_night_dnd: true,
  memory_storage_dir: '.dsh/napcat/napcat_memory',
  user_profile_budget_chars: 2200,
  session_memory_budget_chars: 2200,
  group_memory_total_budget_chars: 8000,
  face_enabled: false,
  face_store_max: 100,
  face_store_dir: '.dsh/napcat/faces',
  face_sub_type: 1,
  face_evict_policy: 'evict_lru',
  slang_enabled: true,
  slang_max_entries: 300,
  slang_evict_policy: 'reject',
  slang_storage_path: '.dsh/napcat/slang/slang.md',
  private_blacklist: [],
  group_blacklist: [],
  session_permission_private_default: 'workspace-write',
  session_permission_group_default: 'read-only',
  session_permission_overrides: [],
  coding_tools_private_default: true,
  coding_tools_group_default: false,
  coding_tools_overrides: [],
  new_message_behavior: 'steer',
};

export function NapCatSettingsCard(props: CardProps): React.JSX.Element {
  injectCardStyles();
  const isSection = props.layoutMode === 'section';
  const state = useCardState(props, DEFAULT_BASE_CONFIG);
  const commonTabProps = {
    draft: state.draft,
    model: state.model,
    saving: state.saving,
    onFieldChange: state.handleFieldChange,
    onResetField: state.handleResetField,
  };

  const formContent = (
    <>
      <div className={cardStyle.tabBar} role="tablist" aria-label="设置分区">
        {SETTINGS_TABS.map((tab) => {
          const isSelected = state.activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              id={`napcat-tab-${tab.id}`}
              data-testid={`napcat-tab-${tab.id}`}
              aria-selected={isSelected}
              aria-controls={`napcat-tabpanel-${tab.id}`}
              tabIndex={isSelected ? 0 : -1}
              className={[cardStyle.tab, isSelected ? cardStyle.tabActive : ''].filter(Boolean).join(' ')}
              onClick={() => state.handleTabClick(tab.id)}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      <ConnectionTab
        {...commonTabProps}
        active={state.activeTab === 'connection'}
        hasSecret={state.hasSecret}
        adminsInput={state.adminsInput}
        aliasesInput={state.aliasesInput}
        onAdminsChange={state.handleAdminsChange}
        onAliasesChange={state.handleAliasesChange}
      />
      <PersonaTab {...commonTabProps} active={state.activeTab === 'persona'} />
      <ProactiveTab {...commonTabProps} active={state.activeTab === 'proactive'} />
      <SecurityTab {...commonTabProps} active={state.activeTab === 'security'} />
      <MemoryTab {...commonTabProps} active={state.activeTab === 'memory'} />
      <FaceTab {...commonTabProps} active={state.activeTab === 'face'} onError={state.updateError} />
      <SlangTab {...commonTabProps} active={state.activeTab === 'slang'} onError={state.updateError} />

      <div className={cardStyle.footer}>
        {state.errorMessage && <p className={cardStyle.failed} role="alert">{state.errorMessage}</p>}
        <button type="button" className={cardStyle.discard} disabled={state.blocked} onClick={state.handleDiscard}>
          放弃修改
        </button>
        <button type="button" className={cardStyle.save} disabled={state.blocked} onClick={state.handleSave}>
          {state.saving ? '保存中...' : '保存更改'}
        </button>
      </div>
    </>
  );

  if (isSection) {
    return (
      <div className={sectionStyle.section} data-testid="napcat-bridge-section">
        <div className={sectionStyle.head}>
          <div className={sectionStyle.titleRow}>
            <h2 className={sectionStyle.title}>QQ NapCat 机器人配置</h2>
            {state.isDirty && <span className={sectionStyle.badgePending}>未保存修改</span>}
            {state.remoteLoading && <span className={sectionStyle.badgePending}>加载中...</span>}
          </div>
          <p className={sectionStyle.description}>NapCat (OneBot 11) 反向 WebSocket 接入、消息入库、Agent 工具与群聊/私聊对话桥接</p>
          {state.remoteLoadError && <p className={cardStyle.failed} role="alert">配置加载异常：{state.remoteLoadError}</p>}
        </div>
        <div className={sectionStyle.body}>{formContent}</div>
      </div>
    );
  }

  return (
    <div className={[cardStyle.card, state.expanded ? cardStyle.cardOpen : ''].filter(Boolean).join(' ')} data-testid="napcat-bridge-card">
      <button
        type="button"
        className={cardStyle.header}
        aria-expanded={state.expanded}
        aria-label={`${state.expanded ? '收起' : '展开'}: QQ 机器人桥接 (dsh-napcat-bridge)`}
        onClick={() => state.setExpanded(!state.expanded)}
      >
        <span className={cardStyle.headText}>
          <span className={cardStyle.name}>QQ 机器人桥接 (dsh-napcat-bridge)</span>
          <span className={cardStyle.description}>NapCat (OneBot 11) 反向 WebSocket 接入、消息入库、Agent 工具与群聊/私聊对话桥接</span>
        </span>
        {state.isDirty && <span className={cardStyle.badgePending}>未保存修改</span>}
        <SafeIconChevronDown className={[cardStyle.chevron, state.expanded ? cardStyle.chevronOpen : ''].filter(Boolean).join(' ')} />
      </button>

      {state.expanded && <div className={cardStyle.body}>{formContent}</div>}
    </div>
  );
}

export function NapCatSettingsSection(props: SettingsSectionProps): React.JSX.Element {
  return (
    <SectionErrorBoundary>
      <NapCatSettingsCard {...props} layoutMode="section" initialExpanded={true} />
    </SectionErrorBoundary>
  );
}
