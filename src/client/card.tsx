import React, { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import * as DshPrimitives from '@deepseek-ai/dsh-client-ui-primitives';
import { NapCatFormModel, SettingsConflictError } from './model.js';
import { ValueField, TextAreaField, SwitchField } from './fields.js';
import { cardStyle, sectionStyle, fieldStyle, faceStyle, injectCardStyles } from './card-styles.js';
import type { BridgePluginConfig } from '../types/index.js';
import { DEFAULT_WS_PORT } from '../constants/index.js';

function IconUpload(props: { size?: number }): React.JSX.Element {
  const size = props.size ?? 14;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12" />
    </svg>
  );
}

function IconEdit(props: { size?: number }): React.JSX.Element {
  const size = props.size ?? 14;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
    </svg>
  );
}

function IconPlus(props: { size?: number }): React.JSX.Element {
  const size = props.size ?? 14;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

function IconTrash(props: { size?: number }): React.JSX.Element {
  const size = props.size ?? 14;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M10 11v6M14 11v6" />
    </svg>
  );
}

function IconBan(props: { size?: number }): React.JSX.Element {
  const size = props.size ?? 32;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="10" />
      <line x1="4.93" y1="4.93" x2="19.07" y2="19.07" />
    </svg>
  );
}

function resolveChevronDownIcon(): React.ComponentType<{ className?: string }> {
  try {
    const P = DshPrimitives as any;
    if (typeof P?.IconChevronDownOutlineMedium === 'function') return P.IconChevronDownOutlineMedium;
    if (typeof P?.IconChevronDownOutlineRegular === 'function') return P.IconChevronDownOutlineRegular;
  } catch {
    // ignore
  }
  return () => null;
}

const SafeIconChevronDown: React.ComponentType<{ className?: string }> = resolveChevronDownIcon();

export { DEFAULT_BASE_CONFIG };

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

function formatArrayToString(arr?: string[]): string {
  if (!Array.isArray(arr)) return '';
  return arr.join(', ');
}

function parseStringToArray(str: string): string[] {
  return str
    .split(/[,，\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function NapCatSettingsCard(props: CardProps): React.JSX.Element {
  injectCardStyles();
  const isSection = props.layoutMode === 'section';
  const [expandedState, setExpandedState] = useState(props.initialExpanded ?? false);
  const expanded = isSection ? true : expandedState;
  const setExpanded = useCallback(
    (exp: boolean) => {
      if (!isSection) setExpandedState(exp);
    },
    [isSection]
  );
  const [activeTabState, setActiveTabState] = useState<SettingsTabId>(
    props.initialTab ?? 'connection'
  );
  const activeTab = props.activeTab ?? activeTabState;
  const [saving, setSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [, setRerenderKey] = useState(0);

  const activeTabRef = useRef<SettingsTabId>(activeTab);
  activeTabRef.current = activeTab;

  const errRef = useRef<string | null>(errorMessage);
  errRef.current = errorMessage;

  const savingRef = useRef<boolean>(saving);
  savingRef.current = saving;

  const expandedRef = useRef<boolean>(expanded);
  expandedRef.current = expanded;

  const updateError = (msg: string | null) => {
    errRef.current = msg;
    setErrorMessage(msg);
  };

  const model = useMemo(() => {
    return new NapCatFormModel({
      initialValues: props.initialConfig || {},
      revision: props.revision ?? 0,
      baseDefaults: props.baseDefaults || DEFAULT_BASE_CONFIG,
    });
  }, [props.initialConfig, props.baseDefaults]);

  // Local string states for array fields to support smooth typing with both English (,) and Chinese (，) commas
  const [adminsInput, setAdminsInput] = useState<string>(() =>
    formatArrayToString(props.initialConfig?.admins)
  );
  const [aliasesInput, setAliasesInput] = useState<string>(() =>
    formatArrayToString(props.initialConfig?.aliases)
  );

  useEffect(() => {
    if (props.revision !== undefined) {
      model.setRevision(props.revision);
    }
  }, [props.revision, model]);

  useEffect(() => {
    setAdminsInput(formatArrayToString(props.initialConfig?.admins));
    setAliasesInput(formatArrayToString(props.initialConfig?.aliases));
  }, [props.initialConfig]);

  const forceUpdate = useCallback(() => {
    setRerenderKey((k) => k + 1);
  }, []);

  const isExternalControlled = Boolean(
    (props.initialConfig && Object.keys(props.initialConfig).length > 0) ||
      props.onSaveSettings
  );

  const [remoteLoaded, setRemoteLoaded] = useState(false);
  const [remoteLoading, setRemoteLoading] = useState(false);
  const [remoteLoadError, setRemoteLoadError] = useState<string | null>(null);
  const [remoteHasSecret, setRemoteHasSecret] = useState(false);

  // 表情包上传与编辑状态 (用户免强制打标，标准按钮上传，卡片内联展开二次编辑)
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [faces, setFaces] = useState<Array<{ id: string; tags: string[]; mood?: string; format: string; preview_url: string; use_count?: number }>>([]);
  const [facesLoading, setFacesLoading] = useState(false);
  const [pendingUpload, setPendingUpload] = useState<{ file: File; previewUrl: string; base64Data: string; format: string } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadTags, setUploadTags] = useState('');
  const [uploadMood, setUploadMood] = useState('');
  const [editingFaceId, setEditingFaceId] = useState<string | null>(null);
  const [editingTags, setEditingTags] = useState('');
  const [editingMood, setEditingMood] = useState('');

  const loadFaces = useCallback(async () => {
    setFacesLoading(true);
    try {
      const res = await fetch('/plugins/dsh-napcat-bridge/faces');
      if (!res.ok) return;
      const data = await res.json();
      if (data?.ok && Array.isArray(data.faces)) {
        setFaces(data.faces);
      }
    } catch {
      // 离线或加载静默
    } finally {
      setFacesLoading(false);
    }
  }, []);

  useEffect(() => {
    if (activeTab === 'face') {
      void loadFaces();
    }
  }, [activeTab, loadFaces]);

  const [slangEntries, setSlangEntries] = useState<Array<{ term: string; tags?: string; definition: string; example?: string; query_count?: number }>>([]);
  const [slangTotal, setSlangTotal] = useState(0);
  const [slangLoading, setSlangLoading] = useState(false);
  const [editingSlangTerm, setEditingSlangTerm] = useState<string | null>(null);
  const [editingSlangNewTerm, setEditingSlangNewTerm] = useState('');
  const [editingSlangTags, setEditingSlangTags] = useState('');
  const [editingSlangDef, setEditingSlangDef] = useState('');
  const [editingSlangEx, setEditingSlangEx] = useState('');
  const [isAddingSlang, setIsAddingSlang] = useState(false);
  const [newSlangTerm, setNewSlangTerm] = useState('');
  const [newSlangTags, setNewSlangTags] = useState('');
  const [newSlangDef, setNewSlangDef] = useState('');
  const [newSlangEx, setNewSlangEx] = useState('');
  const [addingSlangLoading, setAddingSlangLoading] = useState(false);

  // Security Tab 本地添加表单状态
  const [isAddingPrivateBlacklist, setIsAddingPrivateBlacklist] = useState(false);
  const [newPrivateBlacklistId, setNewPrivateBlacklistId] = useState('');
  const [isAddingGroupBlacklist, setIsAddingGroupBlacklist] = useState(false);
  const [newGroupBlacklistId, setNewGroupBlacklistId] = useState('');

  const [isAddingPrivatePermOverride, setIsAddingPrivatePermOverride] = useState(false);
  const [newPrivatePermOverrideId, setNewPrivatePermOverrideId] = useState('');
  const [newPrivatePermOverrideLevel, setNewPrivatePermOverrideLevel] = useState<'read-only' | 'workspace-write' | 'danger-full-access'>('workspace-write');
  const [isAddingGroupPermOverride, setIsAddingGroupPermOverride] = useState(false);
  const [newGroupPermOverrideId, setNewGroupPermOverrideId] = useState('');
  const [newGroupPermOverrideLevel, setNewGroupPermOverrideLevel] = useState<'read-only' | 'workspace-write' | 'danger-full-access'>('workspace-write');

  const [isAddingPrivateCodingOverride, setIsAddingPrivateCodingOverride] = useState(false);
  const [newPrivateCodingOverrideId, setNewPrivateCodingOverrideId] = useState('');
  const [newPrivateCodingOverrideEnabled, setNewPrivateCodingOverrideEnabled] = useState(true);
  const [isAddingGroupCodingOverride, setIsAddingGroupCodingOverride] = useState(false);
  const [newGroupCodingOverrideId, setNewGroupCodingOverrideId] = useState('');
  const [newGroupCodingOverrideEnabled, setNewGroupCodingOverrideEnabled] = useState(false);


  const loadSlang = useCallback(async () => {
    setSlangLoading(true);
    try {
      const res = await fetch('/plugins/dsh-napcat-bridge/slang');
      if (!res.ok) return;
      const data = await res.json();
      if (data?.ok && Array.isArray(data.entries)) {
        setSlangEntries(data.entries);
        setSlangTotal(data.total !== undefined ? data.total : data.entries.length);
      }
    } catch {
      // 离线或加载静默
    } finally {
      setSlangLoading(false);
    }
  }, []);

  useEffect(() => {
    if (activeTab === 'slang') {
      void loadSlang();
    }
  }, [activeTab, loadSlang]);

  const handleDeleteSlang = async (term: string) => {
    try {
      const res = await fetch('/plugins/dsh-napcat-bridge/slang/delete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ term }),
      });
      if (res.ok) {
        void loadSlang();
      }
    } catch {}
  };

  const handleSaveEditSlang = async (term: string) => {
    try {
      const res = await fetch('/plugins/dsh-napcat-bridge/slang/edit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          term,
          new_term: editingSlangNewTerm.trim() || undefined,
          tags: editingSlangTags.trim() || undefined,
          definition: editingSlangDef.trim() || undefined,
          example: editingSlangEx.trim() || undefined,
        }),
      });
      if (res.ok) {
        setEditingSlangTerm(null);
        void loadSlang();
      }
    } catch {}
  };

  const handleAddSlangSubmit = async () => {
    if (!newSlangTerm.trim()) {
      updateError('词条名称不能为空');
      return;
    }
    if (!newSlangTags.trim()) {
      updateError('词条标签（简要概述）不能为空');
      return;
    }
    if (!newSlangDef.trim()) {
      updateError('核心释义不能为空');
      return;
    }
    if (!newSlangEx.trim()) {
      updateError('典型例句不能为空');
      return;
    }
    setAddingSlangLoading(true);
    try {
      const res = await fetch('/plugins/dsh-napcat-bridge/slang', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          term: newSlangTerm.trim(),
          tags: newSlangTags.trim(),
          definition: newSlangDef.trim(),
          example: newSlangEx.trim(),
        }),
      });
      const data = await res.json();
      if (res.ok && data?.ok) {
        setIsAddingSlang(false);
        setNewSlangTerm('');
        setNewSlangTags('');
        setNewSlangDef('');
        setNewSlangEx('');
        void loadSlang();
      } else {
        updateError(data?.error || '添加黑话词条失败');
      }
    } catch (err: any) {
      updateError(err?.message || '添加黑话词条失败');
    } finally {
      setAddingSlangLoading(false);
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const ext = file.name.split('.').pop()?.toLowerCase() || 'png';
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      if (result) {
        setPendingUpload({
          file,
          previewUrl: result,
          base64Data: result,
          format: ext,
        });
      }
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  const submitPendingUpload = async () => {
    if (!pendingUpload) return;
    setUploading(true);
    updateError(null);
    try {
      const parsedTags = parseStringToArray(uploadTags);
      const res = await fetch('/plugins/dsh-napcat-bridge/faces', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          data: pendingUpload.base64Data,
          format: pendingUpload.format,
          tags: parsedTags,
          mood: uploadMood.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data?.ok) {
        throw new Error(data?.error || '上传表情包失败');
      }
      setPendingUpload(null);
      setUploadTags('');
      setUploadMood('');
      void loadFaces();
    } catch (err: any) {
      updateError(err?.message || '上传表情失败');
    } finally {
      setUploading(false);
    }
  };

  const handleDeleteFace = async (id: string) => {
    try {
      const res = await fetch('/plugins/dsh-napcat-bridge/faces/delete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      const data = await res.json();
      if (data?.ok) {
        void loadFaces();
      }
    } catch {}
  };

  const handleSaveEditFace = async (id: string) => {
    try {
      const parsedTags = parseStringToArray(editingTags);
      const res = await fetch('/plugins/dsh-napcat-bridge/faces/edit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id,
          tags: parsedTags,
          mood: editingMood.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (data?.ok) {
        setEditingFaceId(null);
        void loadFaces();
      }
    } catch {}
  };

  const loadRemoteConfig = useCallback(async () => {
    setRemoteLoading(true);
    setRemoteLoadError(null);
    try {
      const res = await fetch('/plugins/dsh-napcat-bridge/config');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data?.ok) {
        if (data.config) {
          model.setInitialValues(data.config);
          setAdminsInput(formatArrayToString(data.config.admins));
          setAliasesInput(formatArrayToString(data.config.aliases));
        }
        if (data.baseDefaults) {
          model.setBaseDefaults(data.baseDefaults);
        }
        setRemoteHasSecret(Boolean(data.hasSecret));
        setRemoteLoaded(true);
        forceUpdate();
      } else {
        throw new Error(data?.error || 'Failed to load configuration');
      }
    } catch (err: any) {
      console.warn('[dsh-napcat-bridge] Failed to fetch remote config:', err);
      setRemoteLoadError(err?.message || '加载配置失败');
    } finally {
      setRemoteLoading(false);
    }
  }, [model, forceUpdate]);

  useEffect(() => {
    if (!isExternalControlled && !remoteLoaded) {
      void loadRemoteConfig();
    }
  }, [isExternalControlled, remoteLoaded, loadRemoteConfig]);

  const handleTabClick = (tabId: SettingsTabId) => {
    activeTabRef.current = tabId;
    setActiveTabState(tabId);
    props.onTabChange?.(tabId);
    forceUpdate();
  };

  const handleFieldChange = (key: keyof BridgePluginConfig, val: any) => {
    model.setField(key, val);
    updateError(null);
    forceUpdate();
  };

  const handleAdminsChange = (raw: string) => {
    setAdminsInput(raw);
    const parsed = parseStringToArray(raw);
    model.setField('admins', parsed);
    updateError(null);
    forceUpdate();
  };

  const handleAliasesChange = (raw: string) => {
    setAliasesInput(raw);
    const parsed = parseStringToArray(raw);
    model.setField('aliases', parsed);
    updateError(null);
    forceUpdate();
  };

  const handleResetField = (key: keyof BridgePluginConfig) => {
    model.resetField(key);
    if (key === 'admins') {
      setAdminsInput(formatArrayToString(model.getDraft().admins));
    }
    if (key === 'aliases') {
      setAliasesInput(formatArrayToString(model.getDraft().aliases));
    }
    forceUpdate();
  };

  const handleDiscard = () => {
    model.discard();
    setAdminsInput(formatArrayToString(model.getDraft().admins));
    setAliasesInput(formatArrayToString(model.getDraft().aliases));
    updateError(null);
    forceUpdate();
  };

  const handleSave = async () => {
    savingRef.current = true;
    setSaving(true);
    updateError(null);

    try {
      if (props.onSaveSettings) {
        await model.save({
          saveSettings: props.onSaveSettings,
        });
      } else {
        const dirtyDraft = model.getDraft();
        const res = await fetch('/plugins/dsh-napcat-bridge/config', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(dirtyDraft),
        });
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const data = await res.json();
        if (!data?.ok) {
          throw new Error(data?.error || '保存失败');
        }
        if (data.hasSecret !== undefined) {
          setRemoteHasSecret(Boolean(data.hasSecret));
        }
        model.markClean();
      }
      forceUpdate();
    } catch (err: any) {
      if (err instanceof SettingsConflictError || err?.code === 'SETTINGS_CONFLICT') {
        updateError('保存冲突: 配置已被其他标签页修改，请刷新后重试。');
      } else {
        updateError(err?.message || '保存失败，请检查配置');
      }
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const draft = model.getDraft();
  const isDirty = model.isDirty();
  const blocked = !isDirty || saving;
  const hasSecret = Boolean(props.hasSecret ?? remoteHasSecret);

  const controller: CardController = {
    get activeTab() {
      return activeTabRef.current;
    },
    setActiveTab: handleTabClick,
    model,
    get expanded() {
      return expandedRef.current;
    },
    setExpanded: (exp: boolean) => {
      expandedRef.current = exp;
      setExpanded(exp);
    },
    get isDirty() {
      return model.isDirty();
    },
    get saving() {
      return savingRef.current;
    },
    get errorMessage() {
      return errRef.current;
    },
    handleFieldChange,
    handleAdminsChange,
    handleAliasesChange,
    handleResetField,
    handleDiscard,
    handleSave,
  };

  if (props.controllerRef) {
    if (typeof props.controllerRef === 'function') {
      props.controllerRef(controller);
    } else {
      props.controllerRef.current = controller;
    }
  }

  const formContent = (
    <>
      <div className={cardStyle.tabBar} role="tablist" aria-label="设置分区">
        {SETTINGS_TABS.map((tab) => {
          const isSelected = activeTab === tab.id;
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
              className={[
                cardStyle.tab,
                isSelected ? cardStyle.tabActive : '',
              ].filter(Boolean).join(' ')}
              onClick={() => handleTabClick(tab.id)}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      <div
        id="napcat-tabpanel-connection"
        data-testid="napcat-tabpanel-connection"
        role="tabpanel"
        aria-labelledby="napcat-tab-connection"
        hidden={activeTab !== 'connection'}
        className={[
          cardStyle.tabPanel,
          activeTab !== 'connection' ? cardStyle.tabPanelHidden : '',
        ].filter(Boolean).join(' ')}
        style={activeTab !== 'connection' ? { display: 'none' } : undefined}
      >
        <ValueField
          id="napcat-ws-port"
          label="WebSocket 监听端口 (ws_port)"
          hint="NapCat 连接的反向 WebSocket 服务端端口 (默认 8080)"
          placeholder="8080"
          numeric
          value={String(draft.ws_port ?? DEFAULT_WS_PORT)}
          disabled={saving}
          overridden={model.isOverridden('ws_port')}
          onReset={() => handleResetField('ws_port')}
          onChange={(val) => handleFieldChange('ws_port', parseInt(val, 10) || DEFAULT_WS_PORT)}
        />

        <ValueField
          id="napcat-ws-token"
          label="WebSocket 鉴权 Token (ws_token) *"
          hint={
            hasSecret
              ? '当前已配置鉴权 Token；留空保存将保留现有 Token，输入新值将覆盖更新'
              : 'NapCat 请求 Authorization 头 Bearer Token 鉴权 (必填，空着直接拒绝连接)'
          }
          placeholder={hasSecret ? '已配置（已脱敏，留空保持不变）' : '必填，请输入与 NapCat 一致的 Token'}
          value={draft.ws_token || ''}
          disabled={saving}
          overridden={model.isOverridden('ws_token')}
          onReset={() => handleResetField('ws_token')}
          onChange={(val) => handleFieldChange('ws_token', val)}
        />

          <ValueField
            id="napcat-bot-qq"
            label="Bot 自身 QQ 号 (bot_qq)"
            hint="机器人的 QQ 号，用于过滤自我消息循环与 At 唤醒精准比对"
            placeholder="例如: 3889001234"
            value={draft.bot_qq || ''}
            disabled={saving}
            overridden={model.isOverridden('bot_qq')}
            onReset={() => handleResetField('bot_qq')}
            onChange={(val) => handleFieldChange('bot_qq', val)}
          />

          <ValueField
            id="napcat-admins"
            label="管理员 QQ 白名单 (admins)"
            hint="拥有斜杠命令执行权限的 QQ 号列表（支持英文逗号、中文逗号或空格分隔）"
            placeholder="例如: 10001, 10002"
            value={adminsInput}
            disabled={saving}
            overridden={model.isOverridden('admins')}
            onReset={() => handleResetField('admins')}
            onChange={handleAdminsChange}
          />

          <ValueField
            id="napcat-aliases"
            label="Bot 唤醒别名列表 (aliases)"
            hint="群聊中前缀点名唤醒机器人的别名列表（支持英文逗号、中文逗号或空格分隔）"
            placeholder="例如: 助手, bot, 小明"
            value={aliasesInput}
            disabled={saving}
            overridden={model.isOverridden('aliases')}
            onReset={() => handleResetField('aliases')}
            onChange={handleAliasesChange}
          />

          <ValueField
            id="napcat-image-ttl"
            label="多媒体文件缓存 TTL 天数 (image_ttl_days)"
            hint="接收与生成的图片/文件在本地的保留天数，过期定时自动清理 (默认 7)"
            placeholder="7"
            numeric
            value={String(draft.image_ttl_days ?? 7)}
            disabled={saving}
            overridden={model.isOverridden('image_ttl_days')}
            onReset={() => handleResetField('image_ttl_days')}
            onChange={(val) => handleFieldChange('image_ttl_days', parseInt(val, 10) || 7)}
          />
          </div>

          <div
            id="napcat-tabpanel-persona"
            data-testid="napcat-tabpanel-persona"
            role="tabpanel"
            aria-labelledby="napcat-tab-persona"
            hidden={activeTab !== 'persona'}
            className={[
              cardStyle.tabPanel,
              activeTab !== 'persona' ? cardStyle.tabPanelHidden : '',
            ].filter(Boolean).join(' ')}
            style={activeTab !== 'persona' ? { display: 'none' } : undefined}
          >
          <TextAreaField
            id="napcat-persona"
            label="助手人格设定 (persona)"
            hint="注入 Agent 动态 System Prompt 的角色设定 (保护静态 KV 缓存)"
            placeholder="例如: 你是一个运行在 QQ 群内的智能编程助理..."
            value={draft.persona || ''}
            disabled={saving}
            overridden={model.isOverridden('persona')}
            onReset={() => handleResetField('persona')}
            onChange={(val) => handleFieldChange('persona', val)}
          />

          <TextAreaField
            id="napcat-behavior"
            label="行为准则 (behavior)"
            hint="注入 Agent 动态 System Prompt 的行为准则与回答风格要求"
            placeholder="例如: 回答请简洁有力，避免冗长代码，必要时主动调用 read_chat_history..."
            value={draft.behavior || ''}
            disabled={saving}
            overridden={model.isOverridden('behavior')}
            onReset={() => handleResetField('behavior')}
            onChange={(val) => handleFieldChange('behavior', val)}
          />
          </div>

          <div
            id="napcat-tabpanel-proactive"
            data-testid="napcat-tabpanel-proactive"
            role="tabpanel"
            aria-labelledby="napcat-tab-proactive"
            hidden={activeTab !== 'proactive'}
            className={[
              cardStyle.tabPanel,
              activeTab !== 'proactive' ? cardStyle.tabPanelHidden : '',
            ].filter(Boolean).join(' ')}
            style={activeTab !== 'proactive' ? { display: 'none' } : undefined}
          >
          <ValueField
            id="napcat-proactive-buffer-size"
            label="滑动窗口保留条数 (proactive_buffer_size)"
            hint="群聊消息滑动窗口队列最大保留条数 (默认 10 条)，为被动唤醒与主动回复共同提供短程前序上下文"
            placeholder="10"
            numeric
            value={String(draft.proactive_buffer_size ?? 10)}
            disabled={saving}
            overridden={model.isOverridden('proactive_buffer_size')}
            onReset={() => handleResetField('proactive_buffer_size')}
            onChange={(val) => handleFieldChange('proactive_buffer_size', parseInt(val, 10) || 10)}
          />

          <div className={fieldStyle.field}>
            <div className={fieldStyle.head}>
              <label htmlFor="napcat-new-message-behavior" className={fieldStyle.label}>
                新消息行为 (new_message_behavior)
              </label>
              {model.isOverridden('new_message_behavior') && (
                <div className={fieldStyle.badges}>
                  <span className={fieldStyle.badge}>已自定义</span>
                  <button
                    type="button"
                    className={fieldStyle.reset}
                    onClick={() => handleResetField('new_message_behavior')}
                  >
                    重置
                  </button>
                </div>
              )}
            </div>
            <select
              id="napcat-new-message-behavior"
              className={fieldStyle.input}
              disabled={saving}
              value={draft.new_message_behavior || 'steer'}
              onChange={(e) => handleFieldChange('new_message_behavior', e.target.value as any)}
            >
              <option value="steer">及时插话 (steer) - 等待当前 Step 完成后立即接纳新消息并调整行动</option>
              <option value="queue">加入队列 (queue) - 等待当前轮次（Turn）完全结束后依次排队执行</option>
            </select>
            <p className={fieldStyle.hint}>一轮 Agent 循环正在进行时收到新消息的处理行为。在即时聊天场景下推荐“及时插话”。</p>
          </div>

          <SwitchField
            id="napcat-proactive-reply-enabled"
            label="启用群聊主动回复 (proactive_reply_enabled)"
            hint="群聊主动回复总开关。关闭时，普通消息概率插话与潜水超时唤醒全部停用"
            checked={draft.proactive_reply_enabled ?? false}
            disabled={saving}
            overridden={model.isOverridden('proactive_reply_enabled')}
            onReset={() => handleResetField('proactive_reply_enabled')}
            onChange={(checked) => handleFieldChange('proactive_reply_enabled', checked)}
          />

          <ValueField
            id="napcat-proactive-interval-mins"
            label="主动回复轮询间隔 (proactive_interval_mins)"
            hint="定期巡检群聊消息的窗口期时长 (单位: 分钟，默认 3)"
            placeholder="3"
            numeric
            value={String(draft.proactive_interval_mins ?? 3)}
            disabled={saving || !draft.proactive_reply_enabled}
            overridden={model.isOverridden('proactive_interval_mins')}
            onReset={() => handleResetField('proactive_interval_mins')}
            onChange={(val) => handleFieldChange('proactive_interval_mins', parseInt(val, 10) || 3)}
          />

          <SwitchField
            id="napcat-proactive-only-text"
            label="仅回复文本内容 (proactive_only_text)"
            hint={
              draft.proactive_reply_enabled
                ? '开启后（纯文本模型部署）：只有纯文本消息会触发主动回复；视频/图片/表情包等多模态消息一律不主动回复'
                : '需先开启上方的「启用群聊主动回复」总开关'
            }
            checked={draft.proactive_only_text ?? false}
            disabled={saving || !draft.proactive_reply_enabled}
            overridden={model.isOverridden('proactive_only_text')}
            onReset={() => handleResetField('proactive_only_text')}
            onChange={(checked) => handleFieldChange('proactive_only_text', checked)}
          />

          <SwitchField
            id="napcat-proactive-idle-enabled"
            label="潜水超时主动唤醒 (proactive_idle_enabled)"
            hint={draft.proactive_reply_enabled ? '群聊长时间没有新消息时，主动唤醒 Agent 在群内发言' : '需先开启上方的「启用群聊主动回复」总开关'}
            checked={draft.proactive_idle_enabled ?? false}
            disabled={saving || !draft.proactive_reply_enabled}
            overridden={model.isOverridden('proactive_idle_enabled')}
            onReset={() => handleResetField('proactive_idle_enabled')}
            onChange={(checked) => handleFieldChange('proactive_idle_enabled', checked)}
          />

          <ValueField
            id="napcat-proactive-idle-timeout"
            label="潜水时长阈值 (proactive_idle_timeout_mins)"
            hint="群聊连续无人发言达到该分钟数后触发主动唤醒 (单位: 分钟，默认 120)"
            placeholder="120"
            numeric
            value={String(draft.proactive_idle_timeout_mins ?? 120)}
            disabled={saving || !draft.proactive_reply_enabled || !draft.proactive_idle_enabled}
            overridden={model.isOverridden('proactive_idle_timeout_mins')}
            onReset={() => handleResetField('proactive_idle_timeout_mins')}
            onChange={(val) => handleFieldChange('proactive_idle_timeout_mins', parseInt(val, 10) || 120)}
          />

          <SwitchField
            id="napcat-proactive-night-dnd"
            label="夜间免打扰模式 (proactive_night_dnd)"
            hint="每日 23:00 至次日 08:00 期间暂停一切主动回复与潜水冒泡"
            checked={draft.proactive_night_dnd ?? true}
            disabled={saving || !draft.proactive_reply_enabled}
            overridden={model.isOverridden('proactive_night_dnd')}
            onReset={() => handleResetField('proactive_night_dnd')}
            onChange={(checked) => handleFieldChange('proactive_night_dnd', checked)}
          />
          </div>

          <div
            id="napcat-tabpanel-security"
            data-testid="napcat-tabpanel-security"
            role="tabpanel"
            aria-labelledby="napcat-tab-security"
            hidden={activeTab !== 'security'}
            className={[
              cardStyle.tabPanel,
              activeTab !== 'security' ? cardStyle.tabPanelHidden : '',
            ].filter(Boolean).join(' ')}
            style={activeTab !== 'security' ? { display: 'none' } : undefined}
          >
            {/* 分区 1: 发言黑名单 */}
            <div style={{ padding: '8px 0 12px' }}>
              <h4 style={{ margin: '4px 0 6px', fontSize: '14px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' }}>发言黑名单</h4>
              <p className={fieldStyle.hint} style={{ margin: '0 0 12px' }}>
                被拉黑的私聊用户或群聊，消息正常入库记录供归档审计，但永远阻断唤醒与所有回复（管理员亦不豁免）。
              </p>

              {/* 私聊黑名单 */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '14px' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <div style={{ fontSize: '13px', fontWeight: 500, color: 'var(--dsw-alias-label-primary)' }}>私聊黑名单</div>
                  <button
                    type="button"
                    className={`napcat-security-add-private-blacklist-btn ${faceStyle.actionBtn}`}
                    title="添加私聊黑名单"
                    disabled={isAddingPrivateBlacklist}
                    onClick={() => {
                      setIsAddingPrivateBlacklist(true);
                      setNewPrivateBlacklistId('');
                    }}
                  >
                    <IconPlus size={12} />
                  </button>
                </div>

                {isAddingPrivateBlacklist && (
                  <div
                    style={{
                      padding: '8px 10px',
                      border: '1px solid var(--dsw-alias-border-l2)',
                      borderRadius: '8px',
                      background: 'var(--dsw-alias-bg-layer-2)',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px',
                    }}
                  >
                    <input
                      type="text"
                      placeholder="QQ 号 (如: 1000000003)"
                      value={newPrivateBlacklistId}
                      onChange={(e) => setNewPrivateBlacklistId(e.target.value)}
                      className={fieldStyle.input}
                      style={{ flex: 1, height: '30px', fontSize: '12px' }}
                      autoFocus
                    />
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginLeft: 'auto', flexShrink: 0 }}>
                      <button
                        type="button"
                        className={cardStyle.discard}
                        style={{ height: '30px', padding: '0 10px', fontSize: '12px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
                        onClick={() => {
                          setIsAddingPrivateBlacklist(false);
                          setNewPrivateBlacklistId('');
                        }}
                      >
                        取消
                      </button>
                      <button
                        type="button"
                        className={cardStyle.save}
                        style={{ height: '30px', padding: '0 12px', fontSize: '12px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
                        onClick={() => {
                          const id = newPrivateBlacklistId.trim();
                          if (!id) return;
                          const list = [...(draft.private_blacklist || [])];
                          if (!list.some((item: any) => (typeof item === 'string' ? item : item.id) === id)) {
                            list.push({ id });
                            handleFieldChange('private_blacklist', list);
                          }
                          setIsAddingPrivateBlacklist(false);
                          setNewPrivateBlacklistId('');
                        }}
                      >
                        保存
                      </button>
                    </div>
                  </div>
                )}

                {(draft.private_blacklist || []).length > 0 ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    {(draft.private_blacklist || []).map((item: any, idx: number) => {
                      const id = typeof item === 'string' ? item : item.id;
                      return (
                        <div
                          key={id + '-' + idx}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            padding: '8px 10px',
                            border: '1px solid var(--dsw-alias-border-l2)',
                            borderRadius: '8px',
                            background: 'var(--dsw-alias-bg-layer-2)',
                            fontSize: '12px',
                          }}
                        >
                          <strong style={{ color: 'var(--dsw-alias-label-primary)' }}>{id}</strong>
                          <button
                            type="button"
                            className={`${faceStyle.actionBtn} ${faceStyle.actionDelete}`}
                            title="移除黑名单"
                            onClick={() => {
                              const list = (draft.private_blacklist || []).filter((i: any) => (typeof i === 'string' ? i : i.id) !== id);
                              handleFieldChange('private_blacklist', list);
                            }}
                          >
                            <IconTrash size={12} />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                ) : !isAddingPrivateBlacklist ? (
                  <div style={{ fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)' }}>暂无私聊黑名单</div>
                ) : null}
              </div>

              {/* 群聊黑名单 */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <div style={{ fontSize: '13px', fontWeight: 500, color: 'var(--dsw-alias-label-primary)' }}>群聊黑名单</div>
                  <button
                    type="button"
                    className={`napcat-security-add-group-blacklist-btn ${faceStyle.actionBtn}`}
                    title="添加群聊黑名单"
                    disabled={isAddingGroupBlacklist}
                    onClick={() => {
                      setIsAddingGroupBlacklist(true);
                      setNewGroupBlacklistId('');
                    }}
                  >
                    <IconPlus size={12} />
                  </button>
                </div>

                {isAddingGroupBlacklist && (
                  <div
                    style={{
                      padding: '8px 10px',
                      border: '1px solid var(--dsw-alias-border-l2)',
                      borderRadius: '8px',
                      background: 'var(--dsw-alias-bg-layer-2)',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px',
                    }}
                  >
                    <input
                      type="text"
                      placeholder="群号 (如: 8000000001)"
                      value={newGroupBlacklistId}
                      onChange={(e) => setNewGroupBlacklistId(e.target.value)}
                      className={fieldStyle.input}
                      style={{ flex: 1, height: '30px', fontSize: '12px' }}
                      autoFocus
                    />
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginLeft: 'auto', flexShrink: 0 }}>
                      <button
                        type="button"
                        className={cardStyle.discard}
                        style={{ height: '30px', padding: '0 10px', fontSize: '12px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
                        onClick={() => {
                          setIsAddingGroupBlacklist(false);
                          setNewGroupBlacklistId('');
                        }}
                      >
                        取消
                      </button>
                      <button
                        type="button"
                        className={cardStyle.save}
                        style={{ height: '30px', padding: '0 12px', fontSize: '12px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
                        onClick={() => {
                          const id = newGroupBlacklistId.trim();
                          if (!id) return;
                          const list = [...(draft.group_blacklist || [])];
                          if (!list.some((item: any) => (typeof item === 'string' ? item : item.id) === id)) {
                            list.push({ id });
                            handleFieldChange('group_blacklist', list);
                          }
                          setIsAddingGroupBlacklist(false);
                          setNewGroupBlacklistId('');
                        }}
                      >
                        保存
                      </button>
                    </div>
                  </div>
                )}

                {(draft.group_blacklist || []).length > 0 ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    {(draft.group_blacklist || []).map((item: any, idx: number) => {
                      const id = typeof item === 'string' ? item : item.id;
                      return (
                        <div
                          key={id + '-' + idx}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            padding: '8px 10px',
                            border: '1px solid var(--dsw-alias-border-l2)',
                            borderRadius: '8px',
                            background: 'var(--dsw-alias-bg-layer-2)',
                            fontSize: '12px',
                          }}
                        >
                          <strong style={{ color: 'var(--dsw-alias-label-primary)' }}>{id}</strong>
                          <button
                            type="button"
                            className={`${faceStyle.actionBtn} ${faceStyle.actionDelete}`}
                            title="移除黑名单"
                            onClick={() => {
                              const list = (draft.group_blacklist || []).filter((i: any) => (typeof i === 'string' ? i : i.id) !== id);
                              handleFieldChange('group_blacklist', list);
                            }}
                          >
                            <IconTrash size={12} />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                ) : !isAddingGroupBlacklist ? (
                  <div style={{ fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)' }}>暂无群聊黑名单</div>
                ) : null}
              </div>
            </div>

            {/* 分区 2: 新建会话权限模式 */}
            <div style={{ padding: '12px 0', borderTop: '1px solid var(--dsw-alias-border-l2)' }}>
              <h4 style={{ margin: '4px 0 6px', fontSize: '14px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' }}>新建会话权限模式</h4>
              <p className={fieldStyle.hint} style={{ margin: '0 0 12px' }}>
                控制新建会话 (agents.create 或 /新建 指令) 的初始 DSH 权限预设。已有会话热恢复不强行覆盖。
              </p>

              {/* 私聊权限设置 */}
              <div className={fieldStyle.field}>
                <label htmlFor="napcat-session-permission-private-default" className={fieldStyle.label}>
                  私聊新建会话默认权限 (session_permission_private_default)
                </label>
                <select
                  id="napcat-session-permission-private-default"
                  className={fieldStyle.input}
                  disabled={saving}
                  value={draft.session_permission_private_default || 'workspace-write'}
                  onChange={(e) => handleFieldChange('session_permission_private_default', e.target.value as any)}
                >
                  <option value="workspace-write">工作区读写 (workspace-write) [默认]</option>
                  <option value="read-only">只读 (read-only)</option>
                  <option value="danger-full-access">完全 (danger-full-access)</option>
                </select>
              </div>

              {/* 私聊权限例外覆盖 */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '16px' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <div style={{ fontSize: '13px', fontWeight: 500, color: 'var(--dsw-alias-label-primary)' }}>私聊权限例外覆盖</div>
                  <button
                    type="button"
                    className={`napcat-security-add-private-perm-btn ${faceStyle.actionBtn}`}
                    title="添加私聊权限例外"
                    disabled={isAddingPrivatePermOverride}
                    onClick={() => {
                      setIsAddingPrivatePermOverride(true);
                      setNewPrivatePermOverrideId('');
                      setNewPrivatePermOverrideLevel('workspace-write');
                    }}
                  >
                    <IconPlus size={12} />
                  </button>
                </div>

                {isAddingPrivatePermOverride && (
                  <div
                    style={{
                      padding: '8px 10px',
                      border: '1px solid var(--dsw-alias-border-l2)',
                      borderRadius: '8px',
                      background: 'var(--dsw-alias-bg-layer-2)',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px',
                    }}
                  >
                    <input
                      type="text"
                      placeholder="QQ 号 (如: 1000000003)"
                      value={newPrivatePermOverrideId}
                      onChange={(e) => setNewPrivatePermOverrideId(e.target.value)}
                      className={fieldStyle.input}
                      style={{ flex: 1, height: '30px', fontSize: '12px' }}
                      autoFocus
                    />
                    <select
                      value={newPrivatePermOverrideLevel}
                      onChange={(e) => setNewPrivatePermOverrideLevel(e.target.value as any)}
                      className={fieldStyle.input}
                      style={{ width: '130px', height: '30px', fontSize: '12px', flexShrink: 0 }}
                    >
                      <option value="workspace-write">工作区读写</option>
                      <option value="read-only">只读</option>
                      <option value="danger-full-access">完全</option>
                    </select>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginLeft: 'auto', flexShrink: 0 }}>
                      <button
                        type="button"
                        className={cardStyle.discard}
                        style={{ height: '30px', padding: '0 10px', fontSize: '12px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
                        onClick={() => {
                          setIsAddingPrivatePermOverride(false);
                          setNewPrivatePermOverrideId('');
                        }}
                      >
                        取消
                      </button>
                      <button
                        type="button"
                        className={cardStyle.save}
                        style={{ height: '30px', padding: '0 12px', fontSize: '12px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
                        onClick={() => {
                          const id = newPrivatePermOverrideId.trim();
                          if (!id) return;
                          const list = [...(draft.session_permission_overrides || [])];
                          const existingIdx = list.findIndex((i: any) => i.id === id && i.type === 'user');
                          const item = { id, type: 'user' as const, permission: newPrivatePermOverrideLevel };
                          if (existingIdx >= 0) {
                            list[existingIdx] = item;
                          } else {
                            list.push(item);
                          }
                          handleFieldChange('session_permission_overrides', list);
                          setIsAddingPrivatePermOverride(false);
                          setNewPrivatePermOverrideId('');
                        }}
                      >
                        保存
                      </button>
                    </div>
                  </div>
                )}

                {((draft.session_permission_overrides || []).filter((i: any) => i.type === 'user')).length > 0 ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    {(draft.session_permission_overrides || [])
                      .filter((i: any) => i.type === 'user')
                      .map((item: any, idx: number) => (
                        <div
                          key={item.id + '-user-' + idx}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            padding: '8px 10px',
                            border: '1px solid var(--dsw-alias-border-l2)',
                            borderRadius: '8px',
                            background: 'var(--dsw-alias-bg-layer-2)',
                            fontSize: '12px',
                          }}
                        >
                          <div>
                            <strong style={{ color: 'var(--dsw-alias-label-primary)' }}>{item.id}</strong>
                            <span style={{ marginLeft: '8px', color: 'var(--dsw-alias-brand-primary)' }}>
                              {item.permission}
                            </span>
                          </div>
                          <button
                            type="button"
                            className={`${faceStyle.actionBtn} ${faceStyle.actionDelete}`}
                            title="移除权限例外"
                            onClick={() => {
                              const list = (draft.session_permission_overrides || []).filter((i: any) => !(i.id === item.id && i.type === 'user'));
                              handleFieldChange('session_permission_overrides', list);
                            }}
                          >
                            <IconTrash size={12} />
                          </button>
                        </div>
                      ))}
                  </div>
                ) : !isAddingPrivatePermOverride ? (
                  <div style={{ fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)' }}>暂无私聊权限例外</div>
                ) : null}
              </div>

              {/* 群聊权限设置 */}
              <div className={fieldStyle.field}>
                <label htmlFor="napcat-session-permission-group-default" className={fieldStyle.label}>
                  群聊新建会话默认权限 (session_permission_group_default)
                </label>
                <select
                  id="napcat-session-permission-group-default"
                  className={fieldStyle.input}
                  disabled={saving}
                  value={draft.session_permission_group_default || 'read-only'}
                  onChange={(e) => handleFieldChange('session_permission_group_default', e.target.value as any)}
                >
                  <option value="read-only">只读 (read-only) [默认，安全推荐]</option>
                  <option value="workspace-write">工作区读写 (workspace-write)</option>
                  <option value="danger-full-access">完全 (danger-full-access)</option>
                </select>
              </div>

              {/* 群聊权限例外覆盖 */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <div style={{ fontSize: '13px', fontWeight: 500, color: 'var(--dsw-alias-label-primary)' }}>群聊权限例外覆盖</div>
                  <button
                    type="button"
                    className={`napcat-security-add-group-perm-btn ${faceStyle.actionBtn}`}
                    title="添加群聊权限例外"
                    disabled={isAddingGroupPermOverride}
                    onClick={() => {
                      setIsAddingGroupPermOverride(true);
                      setNewGroupPermOverrideId('');
                      setNewGroupPermOverrideLevel('workspace-write');
                    }}
                  >
                    <IconPlus size={12} />
                  </button>
                </div>

                {isAddingGroupPermOverride && (
                  <div
                    style={{
                      padding: '8px 10px',
                      border: '1px solid var(--dsw-alias-border-l2)',
                      borderRadius: '8px',
                      background: 'var(--dsw-alias-bg-layer-2)',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px',
                    }}
                  >
                    <input
                      type="text"
                      placeholder="群号 (如: 8000000001)"
                      value={newGroupPermOverrideId}
                      onChange={(e) => setNewGroupPermOverrideId(e.target.value)}
                      className={fieldStyle.input}
                      style={{ flex: 1, height: '30px', fontSize: '12px' }}
                      autoFocus
                    />
                    <select
                      value={newGroupPermOverrideLevel}
                      onChange={(e) => setNewGroupPermOverrideLevel(e.target.value as any)}
                      className={fieldStyle.input}
                      style={{ width: '130px', height: '30px', fontSize: '12px', flexShrink: 0 }}
                    >
                      <option value="workspace-write">工作区读写</option>
                      <option value="read-only">只读</option>
                      <option value="danger-full-access">完全</option>
                    </select>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginLeft: 'auto', flexShrink: 0 }}>
                      <button
                        type="button"
                        className={cardStyle.discard}
                        style={{ height: '30px', padding: '0 10px', fontSize: '12px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
                        onClick={() => {
                          setIsAddingGroupPermOverride(false);
                          setNewGroupPermOverrideId('');
                        }}
                      >
                        取消
                      </button>
                      <button
                        type="button"
                        className={cardStyle.save}
                        style={{ height: '30px', padding: '0 12px', fontSize: '12px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
                        onClick={() => {
                          const id = newGroupPermOverrideId.trim();
                          if (!id) return;
                          const list = [...(draft.session_permission_overrides || [])];
                          const existingIdx = list.findIndex((i: any) => i.id === id && i.type === 'group');
                          const item = { id, type: 'group' as const, permission: newGroupPermOverrideLevel };
                          if (existingIdx >= 0) {
                            list[existingIdx] = item;
                          } else {
                            list.push(item);
                          }
                          handleFieldChange('session_permission_overrides', list);
                          setIsAddingGroupPermOverride(false);
                          setNewGroupPermOverrideId('');
                        }}
                      >
                        保存
                      </button>
                    </div>
                  </div>
                )}

                {((draft.session_permission_overrides || []).filter((i: any) => i.type === 'group')).length > 0 ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    {(draft.session_permission_overrides || [])
                      .filter((i: any) => i.type === 'group')
                      .map((item: any, idx: number) => (
                        <div
                          key={item.id + '-group-' + idx}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            padding: '8px 10px',
                            border: '1px solid var(--dsw-alias-border-l2)',
                            borderRadius: '8px',
                            background: 'var(--dsw-alias-bg-layer-2)',
                            fontSize: '12px',
                          }}
                        >
                          <div>
                            <strong style={{ color: 'var(--dsw-alias-label-primary)' }}>{item.id}</strong>
                            <span style={{ marginLeft: '8px', color: 'var(--dsw-alias-brand-primary)' }}>
                              {item.permission}
                            </span>
                          </div>
                          <button
                            type="button"
                            className={`${faceStyle.actionBtn} ${faceStyle.actionDelete}`}
                            title="移除权限例外"
                            onClick={() => {
                              const list = (draft.session_permission_overrides || []).filter((i: any) => !(i.id === item.id && i.type === 'group'));
                              handleFieldChange('session_permission_overrides', list);
                            }}
                          >
                            <IconTrash size={12} />
                          </button>
                        </div>
                      ))}
                  </div>
                ) : !isAddingGroupPermOverride ? (
                  <div style={{ fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)' }}>暂无群聊权限例外</div>
                ) : null}
              </div>
            </div>

            {/* 分区 3: Coding 工具组装载控制 */}
            <div style={{ padding: '12px 0 8px', borderTop: '1px solid var(--dsw-alias-border-l2)' }}>
              <h4 style={{ margin: '4px 0 6px', fontSize: '14px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' }}>Coding 工具组装载</h4>
              <p className={fieldStyle.hint} style={{ margin: '0 0 12px' }}>
                控制新建会话是否装载 5 个工程编码工具 (bash/pwsh/read/write/edit)。关闭可彻底隔离高危操作并大幅节省 Token（视觉识图 read_image 与目录感知 working_directory 作为只读工具始终保留）。
              </p>

              {/* 私聊 Coding 工具默认设置 */}
              <SwitchField
                id="napcat-coding-tools-private-default"
                label="私聊默认装载 Coding 工具组 (coding_tools_private_default)"
                hint="私聊新建会话是否默认包含工程与终端工具 (默认开启)"
                checked={Boolean(draft.coding_tools_private_default ?? true)}
                disabled={saving}
                overridden={model.isOverridden('coding_tools_private_default')}
                onReset={() => handleResetField('coding_tools_private_default')}
                onChange={(checked) => handleFieldChange('coding_tools_private_default', checked)}
              />

              {/* 私聊 Coding 工具例外覆盖 */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '16px', marginTop: '8px' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <div style={{ fontSize: '13px', fontWeight: 500, color: 'var(--dsw-alias-label-primary)' }}>私聊 Coding 工具例外覆盖</div>
                  <button
                    type="button"
                    className={`napcat-security-add-private-coding-btn ${faceStyle.actionBtn}`}
                    title="添加私聊工具例外"
                    disabled={isAddingPrivateCodingOverride}
                    onClick={() => {
                      setIsAddingPrivateCodingOverride(true);
                      setNewPrivateCodingOverrideId('');
                      setNewPrivateCodingOverrideEnabled(true);
                    }}
                  >
                    <IconPlus size={12} />
                  </button>
                </div>

                {isAddingPrivateCodingOverride && (
                  <div
                    style={{
                      padding: '8px 10px',
                      border: '1px solid var(--dsw-alias-border-l2)',
                      borderRadius: '8px',
                      background: 'var(--dsw-alias-bg-layer-2)',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px',
                    }}
                  >
                    <input
                      type="text"
                      placeholder="QQ 号 (如: 1000000003)"
                      value={newPrivateCodingOverrideId}
                      onChange={(e) => setNewPrivateCodingOverrideId(e.target.value)}
                      className={fieldStyle.input}
                      style={{ flex: 1, height: '30px', fontSize: '12px' }}
                      autoFocus
                    />
                    <select
                      value={newPrivateCodingOverrideEnabled ? 'true' : 'false'}
                      onChange={(e) => setNewPrivateCodingOverrideEnabled(e.target.value === 'true')}
                      className={fieldStyle.input}
                      style={{ width: '90px', height: '30px', fontSize: '12px', flexShrink: 0 }}
                    >
                      <option value="true">开启</option>
                      <option value="false">关闭</option>
                    </select>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginLeft: 'auto', flexShrink: 0 }}>
                      <button
                        type="button"
                        className={cardStyle.discard}
                        style={{ height: '30px', padding: '0 10px', fontSize: '12px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
                        onClick={() => {
                          setIsAddingPrivateCodingOverride(false);
                          setNewPrivateCodingOverrideId('');
                        }}
                      >
                        取消
                      </button>
                      <button
                        type="button"
                        className={cardStyle.save}
                        style={{ height: '30px', padding: '0 12px', fontSize: '12px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
                        onClick={() => {
                          const id = newPrivateCodingOverrideId.trim();
                          if (!id) return;
                          const list = [...(draft.coding_tools_overrides || [])];
                          const existingIdx = list.findIndex((i: any) => i.id === id && i.type === 'user');
                          const item = { id, type: 'user' as const, enabled: newPrivateCodingOverrideEnabled };
                          if (existingIdx >= 0) {
                            list[existingIdx] = item;
                          } else {
                            list.push(item);
                          }
                          handleFieldChange('coding_tools_overrides', list);
                          setIsAddingPrivateCodingOverride(false);
                          setNewPrivateCodingOverrideId('');
                        }}
                      >
                        保存
                      </button>
                    </div>
                  </div>
                )}

                {((draft.coding_tools_overrides || []).filter((i: any) => i.type === 'user')).length > 0 ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    {(draft.coding_tools_overrides || [])
                      .filter((i: any) => i.type === 'user')
                      .map((item: any, idx: number) => (
                        <div
                          key={item.id + '-user-' + idx}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            padding: '8px 10px',
                            border: '1px solid var(--dsw-alias-border-l2)',
                            borderRadius: '8px',
                            background: 'var(--dsw-alias-bg-layer-2)',
                            fontSize: '12px',
                          }}
                        >
                          <div>
                            <strong style={{ color: 'var(--dsw-alias-label-primary)' }}>{item.id}</strong>
                            <span style={{ marginLeft: '8px', color: item.enabled ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-label-error)' }}>
                              {item.enabled ? '已开启' : '已关闭'}
                            </span>
                          </div>
                          <button
                            type="button"
                            className={`${faceStyle.actionBtn} ${faceStyle.actionDelete}`}
                            title="移除工具例外"
                            onClick={() => {
                              const list = (draft.coding_tools_overrides || []).filter((i: any) => !(i.id === item.id && i.type === 'user'));
                              handleFieldChange('coding_tools_overrides', list);
                            }}
                          >
                            <IconTrash size={12} />
                          </button>
                        </div>
                      ))}
                  </div>
                ) : !isAddingPrivateCodingOverride ? (
                  <div style={{ fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)' }}>暂无私聊 Coding 工具例外</div>
                ) : null}
              </div>

              {/* 群聊 Coding 工具默认设置 */}
              <SwitchField
                id="napcat-coding-tools-group-default"
                label="群聊默认装载 Coding 工具组 (coding_tools_group_default)"
                hint="群聊新建会话是否默认包含工程与终端工具 (默认关闭，安全推荐)"
                checked={Boolean(draft.coding_tools_group_default ?? false)}
                disabled={saving}
                overridden={model.isOverridden('coding_tools_group_default')}
                onReset={() => handleResetField('coding_tools_group_default')}
                onChange={(checked) => handleFieldChange('coding_tools_group_default', checked)}
              />

              {/* 群聊 Coding 工具例外覆盖 */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '8px' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <div style={{ fontSize: '13px', fontWeight: 500, color: 'var(--dsw-alias-label-primary)' }}>群聊 Coding 工具例外覆盖</div>
                  <button
                    type="button"
                    className={`napcat-security-add-group-coding-btn ${faceStyle.actionBtn}`}
                    title="添加群聊工具例外"
                    disabled={isAddingGroupCodingOverride}
                    onClick={() => {
                      setIsAddingGroupCodingOverride(true);
                      setNewGroupCodingOverrideId('');
                      setNewGroupCodingOverrideEnabled(false);
                    }}
                  >
                    <IconPlus size={12} />
                  </button>
                </div>

                {isAddingGroupCodingOverride && (
                  <div
                    style={{
                      padding: '8px 10px',
                      border: '1px solid var(--dsw-alias-border-l2)',
                      borderRadius: '8px',
                      background: 'var(--dsw-alias-bg-layer-2)',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px',
                    }}
                  >
                    <input
                      type="text"
                      placeholder="群号 (如: 8000000001)"
                      value={newGroupCodingOverrideId}
                      onChange={(e) => setNewGroupCodingOverrideId(e.target.value)}
                      className={fieldStyle.input}
                      style={{ flex: 1, height: '30px', fontSize: '12px' }}
                      autoFocus
                    />
                    <select
                      value={newGroupCodingOverrideEnabled ? 'true' : 'false'}
                      onChange={(e) => setNewGroupCodingOverrideEnabled(e.target.value === 'true')}
                      className={fieldStyle.input}
                      style={{ width: '90px', height: '30px', fontSize: '12px', flexShrink: 0 }}
                    >
                      <option value="true">开启</option>
                      <option value="false">关闭</option>
                    </select>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginLeft: 'auto', flexShrink: 0 }}>
                      <button
                        type="button"
                        className={cardStyle.discard}
                        style={{ height: '30px', padding: '0 10px', fontSize: '12px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
                        onClick={() => {
                          setIsAddingGroupCodingOverride(false);
                          setNewGroupCodingOverrideId('');
                        }}
                      >
                        取消
                      </button>
                      <button
                        type="button"
                        className={cardStyle.save}
                        style={{ height: '30px', padding: '0 12px', fontSize: '12px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
                        onClick={() => {
                          const id = newGroupCodingOverrideId.trim();
                          if (!id) return;
                          const list = [...(draft.coding_tools_overrides || [])];
                          const existingIdx = list.findIndex((i: any) => i.id === id && i.type === 'group');
                          const item = { id, type: 'group' as const, enabled: newGroupCodingOverrideEnabled };
                          if (existingIdx >= 0) {
                            list[existingIdx] = item;
                          } else {
                            list.push(item);
                          }
                          handleFieldChange('coding_tools_overrides', list);
                          setIsAddingGroupCodingOverride(false);
                          setNewGroupCodingOverrideId('');
                        }}
                      >
                        保存
                      </button>
                    </div>
                  </div>
                )}

                {((draft.coding_tools_overrides || []).filter((i: any) => i.type === 'group')).length > 0 ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    {(draft.coding_tools_overrides || [])
                      .filter((i: any) => i.type === 'group')
                      .map((item: any, idx: number) => (
                        <div
                          key={item.id + '-group-' + idx}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            padding: '8px 10px',
                            border: '1px solid var(--dsw-alias-border-l2)',
                            borderRadius: '8px',
                            background: 'var(--dsw-alias-bg-layer-2)',
                            fontSize: '12px',
                          }}
                        >
                          <div>
                            <strong style={{ color: 'var(--dsw-alias-label-primary)' }}>{item.id}</strong>
                            <span style={{ marginLeft: '8px', color: item.enabled ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-label-error)' }}>
                              {item.enabled ? '已开启' : '已关闭'}
                            </span>
                          </div>
                          <button
                            type="button"
                            className={`${faceStyle.actionBtn} ${faceStyle.actionDelete}`}
                            title="移除工具例外"
                            onClick={() => {
                              const list = (draft.coding_tools_overrides || []).filter((i: any) => !(i.id === item.id && i.type === 'group'));
                              handleFieldChange('coding_tools_overrides', list);
                            }}
                          >
                            <IconTrash size={12} />
                          </button>
                        </div>
                      ))}
                  </div>
                ) : !isAddingGroupCodingOverride ? (
                  <div style={{ fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)' }}>暂无群聊 Coding 工具例外</div>
                ) : null}
              </div>
            </div>
          </div>

          <div
            id="napcat-tabpanel-memory"
            data-testid="napcat-tabpanel-memory"
            role="tabpanel"
            aria-labelledby="napcat-tab-memory"
            hidden={activeTab !== 'memory'}
            className={[
              cardStyle.tabPanel,
              activeTab !== 'memory' ? cardStyle.tabPanelHidden : '',
            ].filter(Boolean).join(' ')}
            style={activeTab !== 'memory' ? { display: 'none' } : undefined}
          >
          <ValueField
            id="napcat-memory-storage-dir"
            label="记忆存储目录 (memory_storage_dir)"
            hint="Session 记忆与用户画像 Markdown 存储根目录 (默认 .dsh/napcat/napcat_memory)"
            placeholder=".dsh/napcat/napcat_memory"
            value={draft.memory_storage_dir || '.dsh/napcat/napcat_memory'}
            disabled={saving}
            overridden={model.isOverridden('memory_storage_dir')}
            onReset={() => handleResetField('memory_storage_dir')}
            onChange={(val) => handleFieldChange('memory_storage_dir', val)}
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
            onReset={() => handleResetField('user_profile_budget_chars')}
            onChange={(val) => handleFieldChange('user_profile_budget_chars', parseInt(val, 10) || 2200)}
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
            onReset={() => handleResetField('session_memory_budget_chars')}
            onChange={(val) => handleFieldChange('session_memory_budget_chars', parseInt(val, 10) || 2200)}
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
            onReset={() => handleResetField('group_memory_total_budget_chars')}
            onChange={(val) => handleFieldChange('group_memory_total_budget_chars', parseInt(val, 10) || 8000)}
          />
        </div>

        <div
          id="napcat-tabpanel-face"
          data-testid="napcat-tabpanel-face"
          role="tabpanel"
          aria-labelledby="napcat-tab-face"
          hidden={activeTab !== 'face'}
          className={[
            cardStyle.tabPanel,
            activeTab !== 'face' ? cardStyle.tabPanelHidden : '',
          ].filter(Boolean).join(' ')}
          style={activeTab !== 'face' ? { display: 'none' } : undefined}
        >
          <SwitchField
            id="napcat-face-enabled"
            label="装载表情包工具集 (face_enabled)"
            hint="控制新建会话是否在预设中包含表情包工具集，保存后对后续新会话生效"
            checked={Boolean(draft.face_enabled)}
            disabled={saving}
            overridden={model.isOverridden('face_enabled')}
            onReset={() => handleResetField('face_enabled')}
            onChange={(checked) => handleFieldChange('face_enabled', checked)}
          />

          {draft.face_enabled && (
            <>
              <ValueField
                id="napcat-face-store-max"
                label="表情库容量上限 (face_store_max)"
                hint="本地表情库最多保存多少张可用表情（默认 100 张）"
                placeholder="100"
                numeric
                value={String(draft.face_store_max ?? 100)}
                disabled={saving}
                overridden={model.isOverridden('face_store_max')}
                onReset={() => handleResetField('face_store_max')}
                onChange={(val) => handleFieldChange('face_store_max', parseInt(val, 10) || 100)}
              />

              <div className={fieldStyle.field}>
                <div className={fieldStyle.head}>
                  <label htmlFor="napcat-face-evict-policy" className={fieldStyle.label}>
                    满额淘汰策略 (face_evict_policy)
                  </label>
                  {model.isOverridden('face_evict_policy') && (
                    <div className={fieldStyle.badges}>
                      <span className={fieldStyle.badge}>已自定义</span>
                      <button
                        type="button"
                        className={fieldStyle.reset}
                        onClick={() => handleResetField('face_evict_policy')}
                      >
                        重置
                      </button>
                    </div>
                  )}
                </div>
                <select
                  id="napcat-face-evict-policy"
                  className={fieldStyle.input}
                  disabled={saving}
                  value={draft.face_evict_policy || 'reject'}
                  onChange={(e) => handleFieldChange('face_evict_policy', e.target.value as any)}
                >
                  <option value="reject">拒绝新增 (reject) - 满额后停止收录，不删旧表情</option>
                  <option value="evict_lru">淘汰最久未用 (evict_lru) - 满额后自动淘汰最久未使用的表情</option>
                </select>
                <p className={fieldStyle.hint}>达到容量上限后的行为策略。淘汰的表情在硬盘上保留 7 天后悔期。</p>
              </div>

              <ValueField
                id="napcat-face-store-dir"
                label="表情库存储目录 (face_store_dir)"
                hint="本地表情图片原图落盘存储目录 (默认 .dsh/napcat/faces)"
                placeholder=".dsh/napcat/faces"
                value={draft.face_store_dir || '.dsh/napcat/faces'}
                disabled={saving}
                overridden={model.isOverridden('face_store_dir')}
                onReset={() => handleResetField('face_store_dir')}
                onChange={(val) => handleFieldChange('face_store_dir', val)}
              />

              {/* 上传操作栏 (标准按钮触发文件选择，输入框移至选择图片后的确认弹窗内) */}
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                style={{ display: 'none' }}
                onChange={handleFileSelect}
              />
              <div className={`napcat-face-upload-bar ${faceStyle.uploadBar}`}>
                <button
                  type="button"
                  className={`napcat-face-upload-btn ${cardStyle.discard}`}
                  onClick={() => fileInputRef.current?.click()}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
                >
                  <IconUpload size={14} />
                  <span>上传表情</span>
                </button>
                <span className={fieldStyle.hint} style={{ margin: 0 }}>
                  支持 PNG / JPG / GIF / WEBP 格式（选择图片后弹出确认与打标弹窗，免强制打标）
                </span>
              </div>

              {/* 资产画廊区 (严格契合 DSH 主题设计，空状态居中展示静止符号，多图真实渲染且上下间距大于左右) */}
              <div className={`napcat-face-gallery ${faceStyle.gallery}`}>
                <div className={faceStyle.galleryHead}>
                  <h4 className={faceStyle.galleryTitle}>已收录表情包资产 ({faces.length})</h4>
                  <p className={faceStyle.gallerySub}>
                    免人工审批 · 即偷即用 · 点击铅笔图标可直接二次编辑标签 · 淘汰表情保留 7 天后悔期
                  </p>
                </div>

                {faces.length === 0 ? (
                  <div className={`napcat-face-empty ${faceStyle.empty}`}>
                    <IconBan size={36} />
                    <p className={faceStyle.emptyText}>
                      {facesLoading ? '正在加载表情库...' : '暂未收录表情包，点击上方「上传表情」即可添加'}
                    </p>
                  </div>
                ) : (
                  <div className={`napcat-face-grid ${faceStyle.grid}`}>
                    {faces.map((f) => (
                      <div key={f.id} className={faceStyle.card}>
                        <div className={faceStyle.cardPreview}>
                          <img src={f.preview_url} className={faceStyle.cardImg} alt={f.id} />
                        </div>
                        <div className={faceStyle.cardTitle} title={f.tags.join(', ') || f.id}>
                          {f.tags.length > 0 ? f.tags.join(', ') : f.id}
                        </div>

                        {/* 操作按钮区：线性 SVG 铅笔与垃圾桶 */}
                        <div className={faceStyle.cardActions}>
                          <button
                            type="button"
                            className={`napcat-face-edit-btn ${faceStyle.actionBtn}`}
                            title="编辑表情标签与情绪"
                            onClick={() => {
                              if (editingFaceId === f.id) {
                                setEditingFaceId(null);
                              } else {
                                setEditingFaceId(f.id);
                                setEditingTags(f.tags.join(', '));
                                setEditingMood(f.mood || '');
                              }
                            }}
                          >
                            <IconEdit size={12} />
                          </button>
                          <button
                            type="button"
                            className={`napcat-face-delete-btn ${faceStyle.actionBtn} ${faceStyle.actionDelete}`}
                            title="删除表情包 (保留 7 天后悔期)"
                            onClick={() => handleDeleteFace(f.id)}
                          >
                            <IconTrash size={12} />
                          </button>
                        </div>

                        {/* 画框范围内内联展开的小输入框二次编辑区域 */}
                        {editingFaceId === f.id && (
                          <div className={`napcat-face-inline-editor ${faceStyle.inlineEditor}`}>
                            <input
                              type="text"
                              className={fieldStyle.input}
                              value={editingTags}
                              onChange={(e) => setEditingTags(e.target.value)}
                              placeholder="新标签 (逗号分隔)"
                              style={{
                                height: '24px',
                                fontSize: '11px',
                                padding: '2px 6px',
                                width: '100%',
                                boxSizing: 'border-box',
                              }}
                            />
                            <input
                              type="text"
                              className={fieldStyle.input}
                              value={editingMood}
                              onChange={(e) => setEditingMood(e.target.value)}
                              placeholder="新情绪 (选填)"
                              style={{
                                height: '24px',
                                fontSize: '11px',
                                padding: '2px 6px',
                                width: '100%',
                                boxSizing: 'border-box',
                              }}
                            />
                            <div style={{ display: 'flex', gap: '4px', marginTop: '2px' }}>
                              <button
                                type="button"
                                className={`napcat-face-save-edit-btn ${cardStyle.save}`}
                                onClick={() => handleSaveEditFace(f.id)}
                                style={{
                                  flex: 1,
                                  height: '24px',
                                  padding: '0 4px',
                                  fontSize: '11px',
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  justifyContent: 'center',
                                }}
                              >
                                保存
                              </button>
                              <button
                                type="button"
                                className={cardStyle.discard}
                                onClick={() => setEditingFaceId(null)}
                                style={{
                                  height: '24px',
                                  padding: '0 6px',
                                  fontSize: '11px',
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  justifyContent: 'center',
                                }}
                              >
                                取消
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* 上传确认弹窗 Modal (上方大图预览，下方左到右排布输入框与提交按钮) */}
              {pendingUpload && (
                <div className={faceStyle.modalOverlay} onClick={() => setPendingUpload(null)}>
                  <div className={faceStyle.modalPanel} onClick={(e) => e.stopPropagation()}>
                    <div className={faceStyle.modalHead}>
                      <h3 className={faceStyle.modalTitle}>上传新表情包</h3>
                      <button
                        type="button"
                        className={faceStyle.modalClose}
                        onClick={() => setPendingUpload(null)}
                        title="关闭"
                      >
                        ✕
                      </button>
                    </div>

                    <div className={faceStyle.modalBody}>
                      <div className={faceStyle.modalPreviewBox}>
                        <img
                          src={pendingUpload.previewUrl}
                          className={faceStyle.modalPreviewImg}
                          alt="表情大图预览"
                        />
                      </div>
                    </div>

                    <div className={faceStyle.modalFooterRow}>
                      <input
                        type="text"
                        className={fieldStyle.input}
                        placeholder="标签 (选填，逗号分隔，如: 猫猫, 叹气)"
                        value={uploadTags}
                        onChange={(e) => setUploadTags(e.target.value)}
                        style={{ flex: 1, minWidth: '120px', height: '32px', fontSize: '12px' }}
                      />
                      <input
                        type="text"
                        className={fieldStyle.input}
                        placeholder="情绪 (选填)"
                        value={uploadMood}
                        onChange={(e) => setUploadMood(e.target.value)}
                        style={{ width: '80px', flexShrink: 0, height: '32px', fontSize: '12px' }}
                      />
                      <button
                        type="button"
                        className={cardStyle.discard}
                        onClick={() => setPendingUpload(null)}
                        style={{ height: '32px', padding: '0 12px', fontSize: '12px', whiteSpace: 'nowrap', flexShrink: 0 }}
                      >
                        取消
                      </button>
                      <button
                        type="button"
                        className={`napcat-face-modal-submit-btn ${cardStyle.save}`}
                        onClick={submitPendingUpload}
                        disabled={uploading}
                        style={{ height: '32px', padding: '0 14px', fontSize: '12px', whiteSpace: 'nowrap', flexShrink: 0 }}
                      >
                        {uploading ? '上传中...' : '提交表情'}
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        <div
          id="napcat-tabpanel-slang"
          data-testid="napcat-tabpanel-slang"
          role="tabpanel"
          aria-labelledby="napcat-tab-slang"
          hidden={activeTab !== 'slang'}
          className={[
            cardStyle.tabPanel,
            activeTab !== 'slang' ? cardStyle.tabPanelHidden : '',
          ].filter(Boolean).join(' ')}
          style={activeTab !== 'slang' ? { display: 'none' } : undefined}
        >
          <SwitchField
            id="napcat-slang-enabled"
            label="装载黑话学习套件 (slang_enabled)"
            hint="控制新建会话是否在预设中包含黑话学习工具集与动态上下文，保存后对后续新会话生效"
            checked={Boolean(draft.slang_enabled ?? true)}
            disabled={saving}
            overridden={model.isOverridden('slang_enabled')}
            onReset={() => handleResetField('slang_enabled')}
            onChange={(checked) => handleFieldChange('slang_enabled', checked)}
          />

          {(draft.slang_enabled ?? true) && (
            <>
              <ValueField
                id="napcat-slang-max-entries"
                label="黑话条数容量上限 (slang_max_entries)"
                hint="黑话知识库最大允许收录条数 (默认 300 条)"
                placeholder="300"
                numeric
                value={String(draft.slang_max_entries ?? 300)}
                disabled={saving}
                overridden={model.isOverridden('slang_max_entries')}
                onReset={() => handleResetField('slang_max_entries')}
                onChange={(val) => handleFieldChange('slang_max_entries', parseInt(val, 10) || 300)}
              />

              <div className={fieldStyle.field}>
                <div className={fieldStyle.head}>
                  <label htmlFor="napcat-slang-evict-policy" className={fieldStyle.label}>
                    满额淘汰策略 (slang_evict_policy)
                  </label>
                  {model.isOverridden('slang_evict_policy') && (
                    <div className={fieldStyle.badges}>
                      <span className={fieldStyle.badge}>已自定义</span>
                      <button
                        type="button"
                        className={fieldStyle.reset}
                        onClick={() => handleResetField('slang_evict_policy')}
                      >
                        重置
                      </button>
                    </div>
                  )}
                </div>
                <select
                  id="napcat-slang-evict-policy"
                  className={fieldStyle.input}
                  disabled={saving}
                  value={draft.slang_evict_policy || 'reject'}
                  onChange={(e) => handleFieldChange('slang_evict_policy', e.target.value as any)}
                >
                  <option value="reject">拒绝新增 (reject) - 满额后停止收录，提示手动清理</option>
                  <option value="evict_lru">淘汰查阅最少词条 (evict_lru) - 满额后根据模型查询次数自动淘汰最冷门词条</option>
                </select>
                <p className={fieldStyle.hint}>达到条数上限后的行为策略。淘汰依据为模型调用工具查询黑话的次数与活跃度。</p>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 0 8px', borderTop: '1px solid var(--dsw-alias-border-l2)', fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' }}>
                <div>
                  容量状态: <strong style={{ color: 'var(--dsw-alias-label-primary)' }}>{slangTotal}</strong> / {draft.slang_max_entries ?? 300} 条 (策略: {draft.slang_evict_policy || 'reject'})
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <button
                    type="button"
                    className={`napcat-slang-add-btn ${faceStyle.actionBtn}`}
                    title="添加黑话词条"
                    disabled={isAddingSlang}
                    onClick={() => {
                      setIsAddingSlang(true);
                      setNewSlangTerm('');
                      setNewSlangTags('');
                      setNewSlangDef('');
                      setNewSlangEx('');
                    }}
                  >
                    <IconPlus size={12} />
                  </button>
                </div>
              </div>

              {slangLoading ? (
                <div className={faceStyle.empty}>
                  <p className={faceStyle.emptyText}>正在加载黑话库...</p>
                </div>
              ) : slangEntries.length === 0 && !isAddingSlang ? (
                <div className={faceStyle.empty}>
                  <p className={faceStyle.emptyText}>暂无已收录黑话词条，聊天中 Agent 会自动学习或可手动通过 record_slang 工具添加。</p>
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '4px' }}>
                  {isAddingSlang && (
                    <div
                      style={{
                        padding: '10px 12px',
                        border: '1px solid var(--dsw-alias-border-l2)',
                        borderRadius: '8px',
                        background: 'var(--dsw-alias-bg-layer-2)',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '6px',
                      }}
                    >
                      <div className={faceStyle.inlineEditor}>
                        <input
                          type="text"
                          value={newSlangTerm}
                          onChange={(e) => setNewSlangTerm(e.target.value)}
                          placeholder="词条名称（必填，如：开香槟、牢大）"
                          className={fieldStyle.input}
                          style={{ height: '28px', fontSize: '12px', padding: '0 8px' }}
                          autoFocus
                        />
                        <input
                          type="text"
                          value={newSlangTags}
                          onChange={(e) => setNewSlangTags(e.target.value)}
                          placeholder="简要概述标签（必填，如：提前庆祝、反转被打脸）"
                          className={fieldStyle.input}
                          style={{ height: '28px', fontSize: '12px', padding: '0 8px' }}
                        />
                        <input
                          type="text"
                          value={newSlangDef}
                          onChange={(e) => setNewSlangDef(e.target.value)}
                          placeholder="核心释义（必填，一两句话概括本质）"
                          className={fieldStyle.input}
                          style={{ height: '28px', fontSize: '12px', padding: '0 8px' }}
                        />
                        <input
                          type="text"
                          value={newSlangEx}
                          onChange={(e) => setNewSlangEx(e.target.value)}
                          placeholder="典型例句（必填，如：优势很大，但先别开香槟）"
                          className={fieldStyle.input}
                          style={{ height: '28px', fontSize: '12px', padding: '0 8px' }}
                        />
                        <div style={{ display: 'flex', gap: '6px', justifyContent: 'flex-end', marginTop: '4px' }}>
                          <button
                            type="button"
                            className={cardStyle.discard}
                            onClick={() => {
                              setIsAddingSlang(false);
                              setNewSlangTerm('');
                              setNewSlangDef('');
                              setNewSlangEx('');
                            }}
                            style={{ height: '24px', padding: '0 8px', fontSize: '11px' }}
                          >
                            取消
                          </button>
                          <button
                            type="button"
                            className={`napcat-slang-save-add-btn ${cardStyle.save}`}
                            disabled={addingSlangLoading}
                            onClick={handleAddSlangSubmit}
                            style={{ height: '24px', padding: '0 10px', fontSize: '11px' }}
                          >
                            {addingSlangLoading ? '保存中...' : '保存'}
                          </button>
                        </div>
                      </div>
                    </div>
                  )}
                  {slangEntries.map((item) => {
                    const isEditing = editingSlangTerm === item.term;
                    return (
                      <div
                        key={item.term}
                        style={{
                          padding: '10px 12px',
                          border: '1px solid var(--dsw-alias-border-l2)',
                          borderRadius: '8px',
                          background: 'var(--dsw-alias-bg-layer-2)',
                          display: 'flex',
                          flexDirection: 'column',
                          gap: '6px',
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                          <div style={{ fontWeight: 600, color: 'var(--dsw-alias-label-primary)', fontSize: '13px' }}>
                            {item.term}
                          </div>
                          <div style={{ display: 'flex', gap: '4px' }}>
                            <button
                              type="button"
                              className={`napcat-slang-edit-btn ${faceStyle.actionBtn}`}
                              title="编辑词条"
                              onClick={() => {
                                if (isEditing) {
                                  setEditingSlangTerm(null);
                                } else {
                                  setEditingSlangTerm(item.term);
                                  setEditingSlangNewTerm(item.term);
                                  setEditingSlangTags(item.tags || '');
                                  setEditingSlangDef(item.definition);
                                  setEditingSlangEx(item.example || '');
                                }
                              }}
                            >
                              <IconEdit size={12} />
                            </button>
                            <button
                              type="button"
                              className={`napcat-slang-delete-btn ${faceStyle.actionBtn} ${faceStyle.actionDelete}`}
                              title="删除词条"
                              onClick={() => handleDeleteSlang(item.term)}
                            >
                              <IconTrash size={12} />
                            </button>
                          </div>
                        </div>

                        {!isEditing ? (
                          <>
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', alignItems: 'center' }}>
                              {item.tags && (
                                <span style={{ fontSize: '11px', background: 'var(--dsw-alias-bg-layer-3)', padding: '2px 6px', borderRadius: '4px', color: 'var(--dsw-alias-label-primary)' }}>
                                  🏷️ {item.tags}
                                </span>
                              )}
                              {item.query_count !== undefined && item.query_count > 0 && (
                                <span style={{ fontSize: '10px', color: 'var(--dsw-alias-label-tertiary)', marginLeft: 'auto' }}>
                                  查阅 {item.query_count} 次
                                </span>
                              )}
                            </div>
                            <div style={{ fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.5 }}>
                              {item.definition}
                            </div>
                            {item.example && (
                              <div style={{ fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)', fontStyle: 'italic' }}>
                                例：{item.example}
                              </div>
                            )}
                          </>
                        ) : (
                          <div className={faceStyle.inlineEditor}>
                            <input
                              type="text"
                              value={editingSlangNewTerm}
                              onChange={(e) => setEditingSlangNewTerm(e.target.value)}
                              placeholder="词条名称（必填）"
                              className={fieldStyle.input}
                              style={{ height: '28px', fontSize: '12px', padding: '0 8px' }}
                            />
                            <input
                              type="text"
                              value={editingSlangTags}
                              onChange={(e) => setEditingSlangTags(e.target.value)}
                              placeholder="简要概述标签（必填）"
                              className={fieldStyle.input}
                              style={{ height: '28px', fontSize: '12px', padding: '0 8px' }}
                            />
                            <input
                              type="text"
                              value={editingSlangDef}
                              onChange={(e) => setEditingSlangDef(e.target.value)}
                              placeholder="核心释义（必填）"
                              className={fieldStyle.input}
                              style={{ height: '28px', fontSize: '12px', padding: '0 8px' }}
                            />
                            <input
                              type="text"
                              value={editingSlangEx}
                              onChange={(e) => setEditingSlangEx(e.target.value)}
                              placeholder="典型例句（必填）"
                              className={fieldStyle.input}
                              style={{ height: '28px', fontSize: '12px', padding: '0 8px' }}
                            />
                            <div style={{ display: 'flex', gap: '6px', justifyContent: 'flex-end', marginTop: '4px' }}>
                              <button
                                type="button"
                                className={cardStyle.discard}
                                onClick={() => setEditingSlangTerm(null)}
                                style={{ height: '24px', padding: '0 8px', fontSize: '11px' }}
                              >
                                取消
                              </button>
                              <button
                                type="button"
                                className={cardStyle.save}
                                onClick={() => handleSaveEditSlang(item.term)}
                                style={{ height: '24px', padding: '0 10px', fontSize: '11px' }}
                              >
                                保存
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </div>

        <div className={cardStyle.footer}>
          {errorMessage && (
            <p className={cardStyle.failed} role="alert">
              {errorMessage}
            </p>
          )}
          <button
            type="button"
            className={cardStyle.discard}
            disabled={blocked}
            onClick={handleDiscard}
          >
            放弃修改
          </button>
          <button
            type="button"
            className={cardStyle.save}
            disabled={blocked}
            onClick={handleSave}
          >
            {saving ? '保存中...' : '保存更改'}
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
            {isDirty && <span className={sectionStyle.badgePending}>未保存修改</span>}
            {remoteLoading && <span className={sectionStyle.badgePending}>加载中...</span>}
          </div>
          <p className={sectionStyle.description}>
            NapCat (OneBot 11) 反向 WebSocket 接入、消息入库、Agent 工具与群聊/私聊对话桥接
          </p>
          {remoteLoadError && (
            <p className={cardStyle.failed} role="alert">
              配置加载异常：{remoteLoadError}
            </p>
          )}
        </div>

        <div className={sectionStyle.body}>
          {formContent}
        </div>
      </div>
    );
  }

  return (
    <div
      className={[cardStyle.card, expanded ? cardStyle.cardOpen : ''].filter(Boolean).join(' ')}
      data-testid="napcat-bridge-card"
    >
      <button
        type="button"
        className={cardStyle.header}
        aria-expanded={expanded}
        aria-label={`${expanded ? '收起' : '展开'}: QQ 机器人桥接 (dsh-napcat-bridge)`}
        onClick={() => setExpanded(!expanded)}
      >
        <span className={cardStyle.headText}>
          <span className={cardStyle.name}>QQ 机器人桥接 (dsh-napcat-bridge)</span>
          <span className={cardStyle.description}>
            NapCat (OneBot 11) 反向 WebSocket 接入、消息入库、Agent 工具与群聊/私聊对话桥接
          </span>
        </span>
        {isDirty && <span className={cardStyle.badgePending}>未保存修改</span>}
        <SafeIconChevronDown
          className={[cardStyle.chevron, expanded ? cardStyle.chevronOpen : ''].filter(Boolean).join(' ')}
        />
      </button>

      {expanded && (
        <div className={cardStyle.body}>
          {formContent}
        </div>
      )}
    </div>
  );
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

class SectionErrorBoundary extends React.Component<{ children: React.ReactNode }, ErrorBoundaryState> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[dsh-napcat-bridge] Section render error:', error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: '24px', color: '#ff6b6b' }}>
          <h3>QQ NapCat 设置加载异常</h3>
          <pre style={{ whiteSpace: 'pre-wrap', fontSize: '12px' }}>
            {this.state.error?.stack || this.state.error?.message || String(this.state.error)}
          </pre>
        </div>
      );
    }
    return this.props.children;
  }
}

export interface SettingsSectionProps extends CardProps {
  close?: () => void;
}

export function NapCatSettingsSection(props: SettingsSectionProps): React.JSX.Element {
  return (
    <SectionErrorBoundary>
      <NapCatSettingsCard {...props} layoutMode="section" initialExpanded={true} />
    </SectionErrorBoundary>
  );
}

