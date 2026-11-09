import type React from 'react';
import type { BridgePluginConfig } from '../types/index.js';
import type { NapCatFormModel } from './model.js';

export type SettingsTabId = 'connection' | 'persona' | 'proactive' | 'memory' | 'face' | 'slang' | 'security';

export interface TabItem {
  id: SettingsTabId;
  label: string;
}

export const SETTINGS_TABS: readonly TabItem[] = [
  { id: 'connection', label: '连接设置' },
  { id: 'persona', label: '人格与准则' },
  { id: 'proactive', label: '回复配置' },
  { id: 'security', label: '权限与安全' },
  { id: 'memory', label: '记忆' },
  { id: 'face', label: '表情包' },
  { id: 'slang', label: '黑话学习' },
] as const;

export interface CardController {
  activeTab: SettingsTabId;
  setActiveTab: (tab: SettingsTabId) => void;
  model: NapCatFormModel;
  expanded: boolean;
  setExpanded: (expanded: boolean) => void;
  isDirty: boolean;
  saving: boolean;
  errorMessage: string | null;
  handleFieldChange: (key: keyof BridgePluginConfig, val: any) => void;
  handleAdminsChange: (raw: string) => void;
  handleAliasesChange: (raw: string) => void;
  handleResetField: (key: keyof BridgePluginConfig) => void;
  handleDiscard: () => void;
  handleSave: () => Promise<void>;
}

export interface CardProps {
  layoutMode?: 'card' | 'section';
  initialConfig?: Partial<BridgePluginConfig>;
  hasSecret?: boolean;
  revision?: number;
  baseDefaults?: Partial<BridgePluginConfig>;
  initialExpanded?: boolean;
  initialTab?: SettingsTabId;
  activeTab?: SettingsTabId;
  onTabChange?: (tab: SettingsTabId) => void;
  controllerRef?:
    | React.MutableRefObject<CardController | null>
    | ((controller: CardController) => void);
  onSaveSettings?: (
    values: Partial<BridgePluginConfig>,
    options: { expectedRevision: number }
  ) => Promise<{ revision?: number } | void>;
}

export interface SettingsSectionProps extends CardProps {
  close?: () => void;
}
