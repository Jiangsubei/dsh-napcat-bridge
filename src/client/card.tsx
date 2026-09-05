import React, { useState, useMemo, useCallback, useEffect } from 'react';
import { IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives';
import { NapCatFormModel, SettingsConflictError } from './model.js';
import { ValueField, TextAreaField, SwitchField } from './fields.js';
import { cardStyle, injectCardStyles } from './card-styles.js';
import type { BridgePluginConfig } from '../types/index.js';
import { DEFAULT_WS_PORT } from '../constants/index.js';

export interface CardProps {
  initialConfig?: Partial<BridgePluginConfig>;
  hasSecret?: boolean;
  revision?: number;
  baseDefaults?: Partial<BridgePluginConfig>;
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
  at_questioner: false,
  quote_original: true,
  image_ttl_days: 7,
  persona: '',
  behavior: '',
  proactive_reply_enabled: false,
  proactive_random_enabled: false,
  proactive_random_probability: 0.05,
  proactive_idle_enabled: false,
  proactive_idle_timeout_mins: 120,
  proactive_cooldown_mins: 10,
  proactive_night_dnd: true,
  memory_storage_dir: '.dsh/napcat/napcat_memory',
  memory_budget_chars: 2200,
  review_enabled: true,
  review_turns_interval: 10,
  review_tool_calls_interval: 10,
  review_model: '',
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
  const [expanded, setExpanded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [, setRerenderKey] = useState(0);

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

  const handleFieldChange = (key: keyof BridgePluginConfig, val: any) => {
    model.setField(key, val);
    setErrorMessage(null);
    forceUpdate();
  };

  const handleAdminsChange = (raw: string) => {
    setAdminsInput(raw);
    const parsed = parseStringToArray(raw);
    model.setField('admins', parsed);
    setErrorMessage(null);
    forceUpdate();
  };

  const handleAliasesChange = (raw: string) => {
    setAliasesInput(raw);
    const parsed = parseStringToArray(raw);
    model.setField('aliases', parsed);
    setErrorMessage(null);
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
    setErrorMessage(null);
    forceUpdate();
  };

  const handleSave = async () => {
    if (!props.onSaveSettings) return;
    setSaving(true);
    setErrorMessage(null);

    try {
      await model.save({
        saveSettings: props.onSaveSettings,
      });
      forceUpdate();
    } catch (err: any) {
      if (err instanceof SettingsConflictError || err?.code === 'SETTINGS_CONFLICT') {
        setErrorMessage('保存冲突: 配置已被其他标签页修改，请刷新后重试。');
      } else {
        setErrorMessage(err?.message || '保存失败，请检查配置');
      }
    } finally {
      setSaving(false);
    }
  };

  const draft = model.getDraft();
  const isDirty = model.isDirty();
  const blocked = !isDirty || saving;

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
        <IconChevronDownOutline14
          className={[cardStyle.chevron, expanded ? cardStyle.chevronOpen : ''].filter(Boolean).join(' ')}
        />
      </button>

      {expanded && (
        <div className={cardStyle.body}>
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
            label="WebSocket 鉴权 Token (ws_token)"
            hint="NapCat 请求 Authorization 头 Bearer Token 鉴权 (可选)"
            placeholder="留空不鉴权"
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

          <SwitchField
            id="napcat-quote-original"
            label="群聊回复引用原消息 (quote_original)"
            hint="在群聊中回复时是否引用提问者的原消息"
            checked={draft.quote_original ?? true}
            disabled={saving}
            overridden={model.isOverridden('quote_original')}
            onReset={() => handleResetField('quote_original')}
            onChange={(checked) => handleFieldChange('quote_original', checked)}
          />

          <SwitchField
            id="napcat-at-questioner"
            label="群聊回复 @ 提问者 (at_questioner)"
            hint="在群聊回复的首段消息中是否 @ 提问用户"
            checked={draft.at_questioner ?? false}
            disabled={saving}
            overridden={model.isOverridden('at_questioner')}
            onReset={() => handleResetField('at_questioner')}
            onChange={(checked) => handleFieldChange('at_questioner', checked)}
          />

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

          <SwitchField
            id="napcat-proactive-random-enabled"
            label="普通消息概率插话 (proactive_random_enabled)"
            hint={draft.proactive_reply_enabled ? '群聊收到普通消息时按设定几率随机唤醒 Agent 参与交流' : '需先开启上方的「启用群聊主动回复」总开关'}
            checked={draft.proactive_random_enabled ?? false}
            disabled={saving || !draft.proactive_reply_enabled}
            overridden={model.isOverridden('proactive_random_enabled')}
            onReset={() => handleResetField('proactive_random_enabled')}
            onChange={(checked) => handleFieldChange('proactive_random_enabled', checked)}
          />

          <ValueField
            id="napcat-proactive-random-probability"
            label="随机插话概率 (proactive_random_probability)"
            hint="普通消息触发概率 (0~1 之间的小数，如 0.05 代表 5%)"
            placeholder="0.05"
            numeric
            value={String(draft.proactive_random_probability ?? 0.05)}
            disabled={saving || !draft.proactive_reply_enabled || !draft.proactive_random_enabled}
            overridden={model.isOverridden('proactive_random_probability')}
            onReset={() => handleResetField('proactive_random_probability')}
            onChange={(val) => handleFieldChange('proactive_random_probability', parseFloat(val) || 0.05)}
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

          <ValueField
            id="napcat-proactive-cooldown"
            label="主动回复冷却时间 (proactive_cooldown_mins)"
            hint="单群两次主动回复之间的最小冷却间隔，避免频繁插话打扰 (单位: 分钟，默认 10)"
            placeholder="10"
            numeric
            value={String(draft.proactive_cooldown_mins ?? 10)}
            disabled={saving || !draft.proactive_reply_enabled}
            overridden={model.isOverridden('proactive_cooldown_mins')}
            onReset={() => handleResetField('proactive_cooldown_mins')}
            onChange={(val) => handleFieldChange('proactive_cooldown_mins', parseInt(val, 10) || 10)}
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
            id="napcat-memory-budget-chars"
            label="群聊用户画像预算字符上限 (memory_budget_chars)"
            hint="注入 System Prompt 的群聊用户画像总字符预算，超出时放完整当前用户画像并舍弃后续用户 (默认 2200)"
            placeholder="2200"
            numeric
            value={String(draft.memory_budget_chars ?? 2200)}
            disabled={saving}
            overridden={model.isOverridden('memory_budget_chars')}
            onReset={() => handleResetField('memory_budget_chars')}
            onChange={(val) => handleFieldChange('memory_budget_chars', parseInt(val, 10) || 2200)}
          />

          <SwitchField
            id="napcat-review-enabled"
            label="启用后台自动回顾 (review_enabled)"
            hint="定时在后台异步回顾对话内容，提炼群聊规则与用户画像偏好"
            checked={draft.review_enabled ?? true}
            disabled={saving}
            overridden={model.isOverridden('review_enabled')}
            onReset={() => handleResetField('review_enabled')}
            onChange={(checked) => handleFieldChange('review_enabled', checked)}
          />

          <ValueField
            id="napcat-review-turns-interval"
            label="自动回顾轮次间隔 (review_turns_interval)"
            hint="触发后台回顾的对话轮次阈值 (默认 10 轮)"
            placeholder="10"
            numeric
            value={String(draft.review_turns_interval ?? 10)}
            disabled={saving || !draft.review_enabled}
            overridden={model.isOverridden('review_turns_interval')}
            onReset={() => handleResetField('review_turns_interval')}
            onChange={(val) => handleFieldChange('review_turns_interval', parseInt(val, 10) || 10)}
          />

          <ValueField
            id="napcat-review-tool-calls-interval"
            label="自动回顾工具调用间隔 (review_tool_calls_interval)"
            hint="触发后台回顾的累计工具调用次数阈值 (默认 10 次)"
            placeholder="10"
            numeric
            value={String(draft.review_tool_calls_interval ?? 10)}
            disabled={saving || !draft.review_enabled}
            overridden={model.isOverridden('review_tool_calls_interval')}
            onReset={() => handleResetField('review_tool_calls_interval')}
            onChange={(val) => handleFieldChange('review_tool_calls_interval', parseInt(val, 10) || 10)}
          />

          <ValueField
            id="napcat-review-model"
            label="后台回顾专用子模型 (review_model)"
            hint="后台回顾使用的轻量模型名称 (可选，留空则继承主会话模型)"
            placeholder="例如: deepseek-chat"
            value={draft.review_model || ''}
            disabled={saving || !draft.review_enabled}
            overridden={model.isOverridden('review_model')}
            onReset={() => handleResetField('review_model')}
            onChange={(val) => handleFieldChange('review_model', val)}
          />


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
        </div>
      )}
    </div>
  );
}
