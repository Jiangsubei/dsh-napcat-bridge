import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { NapCatFormModel, SettingsConflictError } from './model.js';
import { formatArrayToString, parseStringToArray } from './utils.js';
import type { BridgePluginConfig } from '../types/index.js';
import type { CardProps, CardController, SettingsTabId } from './types.js';

export function useCardState(
  props: CardProps,
  fallbackBaseDefaults: Partial<BridgePluginConfig>
) {
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
      baseDefaults: props.baseDefaults || fallbackBaseDefaults,
    });
  }, [props.initialConfig, props.baseDefaults, fallbackBaseDefaults]);

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
    model.setField('admins', parseStringToArray(raw));
    updateError(null);
    forceUpdate();
  };

  const handleAliasesChange = (raw: string) => {
    setAliasesInput(raw);
    model.setField('aliases', parseStringToArray(raw));
    updateError(null);
    forceUpdate();
  };

  const handleResetField = (key: keyof BridgePluginConfig) => {
    model.resetField(key);
    if (key === 'admins') setAdminsInput(formatArrayToString(model.getDraft().admins));
    if (key === 'aliases') setAliasesInput(formatArrayToString(model.getDraft().aliases));
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
        await model.save({ saveSettings: props.onSaveSettings });
      } else {
        const dirtyDraft = model.getDraft();
        const res = await fetch('/plugins/dsh-napcat-bridge/config', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(dirtyDraft),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!data?.ok) throw new Error(data?.error || '保存失败');
        if (data.hasSecret !== undefined) setRemoteHasSecret(Boolean(data.hasSecret));
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
    get activeTab() { return activeTabRef.current; },
    setActiveTab: handleTabClick,
    model,
    get expanded() { return expandedRef.current; },
    setExpanded: (exp: boolean) => { expandedRef.current = exp; setExpanded(exp); },
    get isDirty() { return model.isDirty(); },
    get saving() { return savingRef.current; },
    get errorMessage() { return errRef.current; },
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

  return {
    expanded,
    setExpanded,
    activeTab,
    handleTabClick,
    model,
    draft,
    saving,
    errorMessage,
    updateError,
    adminsInput,
    aliasesInput,
    isDirty,
    blocked,
    hasSecret,
    remoteLoading,
    remoteLoadError,
    handleFieldChange,
    handleAdminsChange,
    handleAliasesChange,
    handleResetField,
    handleDiscard,
    handleSave,
  };
}
