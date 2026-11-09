import React from 'react';
import { ValueField } from '../fields.js';
import { cardStyle } from '../card-styles.js';
import type { BridgePluginConfig } from '../../types/index.js';
import { DEFAULT_WS_PORT } from '../../constants/index.js';
import type { NapCatFormModel } from '../model.js';

export interface ConnectionTabProps {
  active: boolean;
  draft: Partial<BridgePluginConfig>;
  model: NapCatFormModel;
  saving: boolean;
  hasSecret: boolean;
  adminsInput: string;
  aliasesInput: string;
  onFieldChange: (key: keyof BridgePluginConfig, val: any) => void;
  onResetField: (key: keyof BridgePluginConfig) => void;
  onAdminsChange: (raw: string) => void;
  onAliasesChange: (raw: string) => void;
}

export function ConnectionTab(props: ConnectionTabProps): React.JSX.Element {
  const {
    active,
    draft,
    model,
    saving,
    hasSecret,
    adminsInput,
    aliasesInput,
    onFieldChange,
    onResetField,
    onAdminsChange,
    onAliasesChange,
  } = props;

  return (
    <div
      id="napcat-tabpanel-connection"
      data-testid="napcat-tabpanel-connection"
      role="tabpanel"
      aria-labelledby="napcat-tab-connection"
      hidden={!active}
      className={[
        cardStyle.tabPanel,
        !active ? cardStyle.tabPanelHidden : '',
      ].filter(Boolean).join(' ')}
      style={!active ? { display: 'none' } : undefined}
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
        onReset={() => onResetField('ws_port')}
        onChange={(val) => onFieldChange('ws_port', parseInt(val, 10) || DEFAULT_WS_PORT)}
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
        onReset={() => onResetField('ws_token')}
        onChange={(val) => onFieldChange('ws_token', val)}
      />

      <ValueField
        id="napcat-bot-qq"
        label="Bot 自身 QQ 号 (bot_qq)"
        hint="机器人的 QQ 号，用于过滤自我消息循环与 At 唤醒精准比对"
        placeholder="例如: 3889001234"
        value={draft.bot_qq || ''}
        disabled={saving}
        overridden={model.isOverridden('bot_qq')}
        onReset={() => onResetField('bot_qq')}
        onChange={(val) => onFieldChange('bot_qq', val)}
      />

      <ValueField
        id="napcat-admins"
        label="管理员 QQ 白名单 (admins)"
        hint="拥有斜杠命令执行权限的 QQ 号列表（支持英文逗号、中文逗号或空格分隔）"
        placeholder="例如: 10001, 10002"
        value={adminsInput}
        disabled={saving}
        overridden={model.isOverridden('admins')}
        onReset={() => onResetField('admins')}
        onChange={onAdminsChange}
      />

      <ValueField
        id="napcat-aliases"
        label="Bot 唤醒别名列表 (aliases)"
        hint="群聊中前缀点名唤醒机器人的别名列表（支持英文逗号、中文逗号或空格分隔）"
        placeholder="例如: 助手, bot, 小明"
        value={aliasesInput}
        disabled={saving}
        overridden={model.isOverridden('aliases')}
        onReset={() => onResetField('aliases')}
        onChange={onAliasesChange}
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
        onReset={() => onResetField('image_ttl_days')}
        onChange={(val) => onFieldChange('image_ttl_days', parseInt(val, 10) || 7)}
      />
    </div>
  );
}
