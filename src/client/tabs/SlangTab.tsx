import React, { useState, useEffect, useCallback } from 'react';
import { SwitchField, ValueField } from '../fields.js';
import { cardStyle, fieldStyle, faceStyle } from '../card-styles.js';
import { IconPlus, IconEdit, IconTrash } from '../icons.js';
import type { BridgePluginConfig } from '../../types/index.js';
import type { NapCatFormModel } from '../model.js';

export interface SlangEntry {
  term: string;
  tags?: string;
  definition: string;
  example?: string;
  query_count?: number;
}

export interface SlangTabProps {
  active: boolean;
  draft: Partial<BridgePluginConfig>;
  model: NapCatFormModel;
  saving: boolean;
  onFieldChange: (key: keyof BridgePluginConfig, val: any) => void;
  onResetField: (key: keyof BridgePluginConfig) => void;
  onError?: (msg: string | null) => void;
}

export function SlangTab(props: SlangTabProps): React.JSX.Element {
  const { active, draft, model, saving, onFieldChange, onResetField, onError } = props;

  const [slangEntries, setSlangEntries] = useState<SlangEntry[]>([]);
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
    if (active) {
      void loadSlang();
    }
  }, [active, loadSlang]);

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
      onError?.('词条名称不能为空');
      return;
    }
    if (!newSlangTags.trim()) {
      onError?.('词条标签（简要概述）不能为空');
      return;
    }
    if (!newSlangDef.trim()) {
      onError?.('核心释义不能为空');
      return;
    }
    if (!newSlangEx.trim()) {
      onError?.('典型例句不能为空');
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
        onError?.(data?.error || '添加黑话词条失败');
      }
    } catch (err: any) {
      onError?.(err?.message || '添加黑话词条失败');
    } finally {
      setAddingSlangLoading(false);
    }
  };

  return (
    <div
      id="napcat-tabpanel-slang"
      data-testid="napcat-tabpanel-slang"
      role="tabpanel"
      aria-labelledby="napcat-tab-slang"
      hidden={!active}
      className={[
        cardStyle.tabPanel,
        !active ? cardStyle.tabPanelHidden : '',
      ].filter(Boolean).join(' ')}
      style={!active ? { display: 'none' } : undefined}
    >
      <SwitchField
        id="napcat-slang-enabled"
        label="装载黑话学习套件 (slang_enabled)"
        hint="控制新建会话是否在预设中包含黑话学习工具集与动态上下文，保存后对后续新会话生效"
        checked={Boolean(draft.slang_enabled ?? true)}
        disabled={saving}
        overridden={model.isOverridden('slang_enabled')}
        onReset={() => onResetField('slang_enabled')}
        onChange={(checked) => onFieldChange('slang_enabled', checked)}
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
            onReset={() => onResetField('slang_max_entries')}
            onChange={(val) => onFieldChange('slang_max_entries', parseInt(val, 10) || 300)}
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
                    onClick={() => onResetField('slang_evict_policy')}
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
              onChange={(e) => onFieldChange('slang_evict_policy', e.target.value as any)}
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
  );
}
