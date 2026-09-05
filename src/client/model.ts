import type { BridgePluginConfig } from '../types/index.js';

export class SettingsConflictError extends Error {
  public code = 'SETTINGS_CONFLICT';
  constructor(message = 'Settings revision conflict') {
    super(message);
    this.name = 'SettingsConflictError';
  }
}

export interface FormModelOptions {
  initialValues?: Partial<BridgePluginConfig>;
  revision?: number;
  baseDefaults?: Partial<BridgePluginConfig>;
}

export class NapCatFormModel {
  private initialValues: Partial<BridgePluginConfig>;
  private draft: Partial<BridgePluginConfig>;
  private revision: number;
  private baseDefaults: Partial<BridgePluginConfig>;

  constructor(options: FormModelOptions = {}) {
    this.initialValues = { ...options.initialValues };
    this.draft = { ...options.initialValues };
    this.revision = options.revision ?? 0;
    this.baseDefaults = { ...options.baseDefaults };
  }

  setRevision(revision: number) {
    this.revision = revision;
  }

  getRevision(): number {
    return this.revision;
  }

  getDraft(): Partial<BridgePluginConfig> {
    return this.draft;
  }

  setField<K extends keyof BridgePluginConfig>(key: K, value: BridgePluginConfig[K]) {
    this.draft[key] = value;
  }

  resetField<K extends keyof BridgePluginConfig>(key: K) {
    if (this.baseDefaults[key] !== undefined) {
      this.draft[key] = this.baseDefaults[key];
    } else {
      delete this.draft[key];
    }
  }

  isOverridden<K extends keyof BridgePluginConfig>(key: K): boolean {
    const draftVal = this.draft[key];
    const defaultVal = this.baseDefaults[key];
    if (draftVal === undefined && defaultVal === undefined) return false;
    return draftVal !== defaultVal;
  }

  isDirty(): boolean {
    const keys = Array.from(
      new Set([...Object.keys(this.initialValues), ...Object.keys(this.draft)])
    ) as Array<keyof BridgePluginConfig>;

    for (const key of keys) {
      const initVal = this.initialValues[key];
      const draftVal = this.draft[key];
      if (Array.isArray(initVal) || Array.isArray(draftVal)) {
        if (JSON.stringify(initVal || []) !== JSON.stringify(draftVal || [])) {
          return true;
        }
      } else if (initVal !== draftVal) {
        return true;
      }
    }
    return false;
  }

  discard() {
    this.draft = { ...this.initialValues };
  }

  async save(callbacks: {
    saveSettings: (
      values: Partial<BridgePluginConfig>,
      options: { expectedRevision: number }
    ) => Promise<{ revision?: number } | void>;
  }): Promise<void> {
    const res = await callbacks.saveSettings(this.draft, {
      expectedRevision: this.revision,
    });
    if (res && typeof res.revision === 'number') {
      this.revision = res.revision;
    }
    this.initialValues = { ...this.draft };
  }
}
