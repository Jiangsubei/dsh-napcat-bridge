import React, { useState } from 'react';
import { cardStyle, fieldStyle, faceStyle } from '../../card-styles.js';
import { IconPlus, IconTrash } from '../../icons.js';
import type { BridgePluginConfig } from '../../../types/index.js';

export interface SessionPermissionSectionProps {
  draft: Partial<BridgePluginConfig>;
  saving: boolean;
  onFieldChange: (key: keyof BridgePluginConfig, val: any) => void;
}

export function SessionPermissionSection(props: SessionPermissionSectionProps): React.JSX.Element {
  const { draft, saving, onFieldChange } = props;

  const [isAddingPrivatePermOverride, setIsAddingPrivatePermOverride] = useState(false);
  const [newPrivatePermOverrideId, setNewPrivatePermOverrideId] = useState('');
  const [newPrivatePermOverrideLevel, setNewPrivatePermOverrideLevel] = useState<'read-only' | 'workspace-write' | 'danger-full-access'>('workspace-write');

  const [isAddingGroupPermOverride, setIsAddingGroupPermOverride] = useState(false);
  const [newGroupPermOverrideId, setNewGroupPermOverrideId] = useState('');
  const [newGroupPermOverrideLevel, setNewGroupPermOverrideLevel] = useState<'read-only' | 'workspace-write' | 'danger-full-access'>('workspace-write');

  return (
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
          onChange={(e) => onFieldChange('session_permission_private_default', e.target.value as any)}
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
                  onFieldChange('session_permission_overrides', list);
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
                      onFieldChange('session_permission_overrides', list);
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
          onChange={(e) => onFieldChange('session_permission_group_default', e.target.value as any)}
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
                  onFieldChange('session_permission_overrides', list);
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
                      onFieldChange('session_permission_overrides', list);
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
  );
}
