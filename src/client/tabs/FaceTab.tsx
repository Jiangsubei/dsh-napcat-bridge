import React, { useState, useEffect, useRef, useCallback } from 'react';
import { SwitchField, ValueField } from '../fields.js';
import { cardStyle, fieldStyle, faceStyle } from '../card-styles.js';
import { IconUpload, IconEdit, IconTrash, IconBan } from '../icons.js';
import { parseStringToArray } from '../utils.js';
import type { BridgePluginConfig } from '../../types/index.js';
import type { NapCatFormModel } from '../model.js';

export interface FaceItem {
  id: string;
  tags: string[];
  mood?: string;
  format: string;
  preview_url: string;
  use_count?: number;
}

export interface PendingUpload {
  file: File;
  previewUrl: string;
  base64Data: string;
  format: string;
}

export interface FaceTabProps {
  active: boolean;
  draft: Partial<BridgePluginConfig>;
  model: NapCatFormModel;
  saving: boolean;
  onFieldChange: (key: keyof BridgePluginConfig, val: any) => void;
  onResetField: (key: keyof BridgePluginConfig) => void;
  onError?: (msg: string | null) => void;
}

export function FaceTab(props: FaceTabProps): React.JSX.Element {
  const { active, draft, model, saving, onFieldChange, onResetField, onError } = props;

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [faces, setFaces] = useState<FaceItem[]>([]);
  const [facesLoading, setFacesLoading] = useState(false);
  const [pendingUpload, setPendingUpload] = useState<PendingUpload | null>(null);
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
    if (active) {
      void loadFaces();
    }
  }, [active, loadFaces]);

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
    onError?.(null);
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
      onError?.(err?.message || '上传表情失败');
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

  return (
    <div
      id="napcat-tabpanel-face"
      data-testid="napcat-tabpanel-face"
      role="tabpanel"
      aria-labelledby="napcat-tab-face"
      hidden={!active}
      className={[
        cardStyle.tabPanel,
        !active ? cardStyle.tabPanelHidden : '',
      ].filter(Boolean).join(' ')}
      style={!active ? { display: 'none' } : undefined}
    >
      <SwitchField
        id="napcat-face-enabled"
        label="装载表情包工具集 (face_enabled)"
        hint="控制新建会话是否在预设中包含表情包工具集，保存后对后续新会话生效"
        checked={Boolean(draft.face_enabled)}
        disabled={saving}
        overridden={model.isOverridden('face_enabled')}
        onReset={() => onResetField('face_enabled')}
        onChange={(checked) => onFieldChange('face_enabled', checked)}
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
            onReset={() => onResetField('face_store_max')}
            onChange={(val) => onFieldChange('face_store_max', parseInt(val, 10) || 100)}
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
                    onClick={() => onResetField('face_evict_policy')}
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
              onChange={(e) => onFieldChange('face_evict_policy', e.target.value as any)}
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
            onReset={() => onResetField('face_store_dir')}
            onChange={(val) => onFieldChange('face_store_dir', val)}
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
  );
}
