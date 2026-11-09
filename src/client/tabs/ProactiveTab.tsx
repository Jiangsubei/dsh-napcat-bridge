import React from 'react';
import { ValueField, SwitchField } from '../fields.js';
import { cardStyle, fieldStyle } from '../card-styles.js';
import type { BridgePluginConfig } from '../../types/index.js';
import type { NapCatFormModel } from '../model.js';

export interface ProactiveTabProps {
  active: boolean;
  draft: Partial<BridgePluginConfig>;
  model: NapCatFormModel;
  saving: boolean;
  onFieldChange: (key: keyof BridgePluginConfig, val: any) => void;
  onResetField: (key: keyof BridgePluginConfig) => void;
}

export function ProactiveTab(props: ProactiveTabProps): React.JSX.Element {
  const { active, draft, model, saving, onFieldChange, onResetField } = props;

  return (
    <div
      id="napcat-tabpanel-proactive"
      data-testid="napcat-tabpanel-proactive"
      role="tabpanel"
      aria-labelledby="napcat-tab-proactive"
      hidden={!active}
      className={[
        cardStyle.tabPanel,
        !active ? cardStyle.tabPanelHidden : '',
      ].filter(Boolean).join(' ')}
      style={!active ? { display: 'none' } : undefined}
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
        onReset={() => onResetField('proactive_buffer_size')}
        onChange={(val) => onFieldChange('proactive_buffer_size', parseInt(val, 10) || 10)}
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
                onClick={() => onResetField('new_message_behavior')}
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
          onChange={(e) => onFieldChange('new_message_behavior', e.target.value as any)}
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
        onReset={() => onResetField('proactive_reply_enabled')}
        onChange={(checked) => onFieldChange('proactive_reply_enabled', checked)}
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
        onReset={() => onResetField('proactive_interval_mins')}
        onChange={(val) => onFieldChange('proactive_interval_mins', parseInt(val, 10) || 3)}
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
        onReset={() => onResetField('proactive_only_text')}
        onChange={(checked) => onFieldChange('proactive_only_text', checked)}
      />

      <SwitchField
        id="napcat-proactive-idle-enabled"
        label="潜水超时主动唤醒 (proactive_idle_enabled)"
        hint={draft.proactive_reply_enabled ? '群聊长时间没有新消息时，主动唤醒 Agent 在群内发言' : '需先开启上方的「启用群聊主动回复」总开关'}
        checked={draft.proactive_idle_enabled ?? false}
        disabled={saving || !draft.proactive_reply_enabled}
        overridden={model.isOverridden('proactive_idle_enabled')}
        onReset={() => onResetField('proactive_idle_enabled')}
        onChange={(checked) => onFieldChange('proactive_idle_enabled', checked)}
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
        onReset={() => onResetField('proactive_idle_timeout_mins')}
        onChange={(val) => onFieldChange('proactive_idle_timeout_mins', parseInt(val, 10) || 120)}
      />

      <SwitchField
        id="napcat-proactive-night-dnd"
        label="夜间免打扰模式 (proactive_night_dnd)"
        hint="每日 23:00 至次日 08:00 期间暂停一切主动回复与潜水冒泡"
        checked={draft.proactive_night_dnd ?? true}
        disabled={saving || !draft.proactive_reply_enabled}
        overridden={model.isOverridden('proactive_night_dnd')}
        onReset={() => onResetField('proactive_night_dnd')}
        onChange={(checked) => onFieldChange('proactive_night_dnd', checked)}
      />
    </div>
  );
}
