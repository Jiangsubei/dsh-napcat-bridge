import React, { useState } from 'react';
import { SwitchField } from '../../fields.js';
import { cardStyle, fieldStyle, faceStyle } from '../../card-styles.js';
import { IconPlus, IconTrash } from '../../icons.js';
import type { BridgePluginConfig } from '../../../types/index.js';
import type { NapCatFormModel } from '../../model.js';

export interface CodingToolsSectionProps {
  draft: Partial<BridgePluginConfig>;
  model: NapCatFormModel;
  saving: boolean;
  onFieldChange: (key: keyof BridgePluginConfig, val: any) => void;
  onResetField: (key: keyof BridgePluginConfig) => void;
}

export function CodingToolsSection(props: CodingToolsSectionProps): React.JSX.Element {
  const { draft, model, saving, onFieldChange, onResetField } = props;

  const [isAddingPrivateCodingOverride, setIsAddingPrivateCodingOverride] = useState(false);
  const [newPrivateCodingOverrideId, setNewPrivateCodingOverrideId] = useState('');
  const [newPrivateCodingOverrideEnabled, setNewPrivateCodingOverrideEnabled] = useState(true);

  const [isAddingGroupCodingOverride, setIsAddingGroupCodingOverride] = useState(false);
  const [newGroupCodingOverrideId, setNewGroupCodingOverrideId] = useState('');
  const [newGroupCodingOverrideEnabled, setNewGroupCodingOverrideEnabled] = useState(false);

  return (
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
        onReset={() => onResetField('coding_tools_private_default')}
        onChange={(checked) => onFieldChange('coding_tools_private_default', checked)}
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
                  onFieldChange('coding_tools_overrides', list);
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
                      onFieldChange('coding_tools_overrides', list);
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
        onReset={() => onResetField('coding_tools_group_default')}
        onChange={(checked) => onFieldChange('coding_tools_group_default', checked)}
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
                  onFieldChange('coding_tools_overrides', list);
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
                      onFieldChange('coding_tools_overrides', list);
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
  );
}
