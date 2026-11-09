import React, { useState } from 'react';
import { cardStyle, fieldStyle, faceStyle } from '../../card-styles.js';
import { IconPlus, IconTrash } from '../../icons.js';
import type { BridgePluginConfig } from '../../../types/index.js';

export interface BlacklistSectionProps {
  draft: Partial<BridgePluginConfig>;
  onFieldChange: (key: keyof BridgePluginConfig, val: any) => void;
}

export function BlacklistSection(props: BlacklistSectionProps): React.JSX.Element {
  const { draft, onFieldChange } = props;
  const [isAddingPrivateBlacklist, setIsAddingPrivateBlacklist] = useState(false);
  const [newPrivateBlacklistId, setNewPrivateBlacklistId] = useState('');
  const [isAddingGroupBlacklist, setIsAddingGroupBlacklist] = useState(false);
  const [newGroupBlacklistId, setNewGroupBlacklistId] = useState('');

  return (
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
                    onFieldChange('private_blacklist', list);
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
                      onFieldChange('private_blacklist', list);
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
                    onFieldChange('group_blacklist', list);
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
                      onFieldChange('group_blacklist', list);
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
  );
}
