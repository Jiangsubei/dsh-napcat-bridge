import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  IconChevronDownOutline14: () => null,
}));

import {
  NapCatSettingsCard,
  SETTINGS_TABS,
  type CardProps,
  type CardController,
  type SettingsTabId,
} from '../../src/client/card.js';
import { DEFAULT_WS_PORT } from '../../src/constants/index.js';
import type { BridgePluginConfig } from '../../src/types/index.js';

describe('契约测试: Web UI 设置卡 Tab 分区与跨 Tab 保存 (Settings Tabs Contract)', () => {
  let controller: CardController;
  let mockSaveSettings: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockSaveSettings = vi.fn().mockResolvedValue({ revision: 2 });
  });

  function renderCard(props: Partial<CardProps> = {}) {
    let captured: CardController | null = null;
    const html = renderToStaticMarkup(
      React.createElement(NapCatSettingsCard, {
        initialExpanded: true,
        controllerRef: (ctrl) => {
          captured = ctrl;
        },
        onSaveSettings: mockSaveSettings,
        ...props,
      })
    );
    if (captured) {
      controller = captured;
    }
    return html;
  }

  describe('1. Tab 分区渲染与工具权限排他契约', () => {
    it('卡片展开后必须渲染且仅渲染 5 个官方 Tab，绝不渲染工具权限 Tab (Checklist E8)', () => {
      const html = renderCard();

      // 1. 验证存在 Tab 栏容器
      expect(html).toContain('role="tablist"');
      expect(html).toContain('aria-label="设置分区"');

      // 2. 验证 5 个 Tab 按钮全部渲染
      expect(html).toContain('id="napcat-tab-connection"');
      expect(html).toContain('连接身份');

      expect(html).toContain('id="napcat-tab-reply"');
      expect(html).toContain('回复行为');

      expect(html).toContain('id="napcat-tab-persona"');
      expect(html).toContain('人格与准则');

      expect(html).toContain('id="napcat-tab-proactive"');
      expect(html).toContain('主动回复');

      expect(html).toContain('id="napcat-tab-memory"');
      expect(html).toContain('记忆与回顾');

      // 3. 验证 SETTINGS_TABS 常量定义严格匹配
      expect(SETTINGS_TABS.map((t) => t.id)).toEqual([
        'connection',
        'reply',
        'persona',
        'proactive',
        'memory',
      ]);
      expect(SETTINGS_TABS).toHaveLength(5);

      // 4. 严禁渲染工具权限 Tab (E8 明确约定)
      expect(html).not.toContain('工具权限');
      expect(html).not.toContain('napcat-tab-tools');
      expect(html).not.toContain('napcat-tabpanel-tools');
      expect(html).not.toContain('tool_permissions');
    });

    it('默认未展开 (initialExpanded=false) 时不渲染 Tab 栏与表单字段', () => {
      const html = renderCard({ initialExpanded: false });
      expect(html).toContain('QQ 机器人桥接 (dsh-napcat-bridge)');
      expect(html).not.toContain('role="tablist"');
      expect(html).not.toContain('napcat-tab-connection');
    });
  });

  describe('2. 默认展示 Tab 1 (连接身份) 契约', () => {
    it('默认 activeTab 为 connection，其 Tab 按钮高亮且对应 panel 可见', () => {
      const html = renderCard();

      // connection Tab 选中
      expect(html).toMatch(/id="napcat-tab-connection"[^>]*aria-selected="true"/);
      expect(html).toMatch(/id="napcat-tab-connection"[^>]*napcat_tabActive/);

      // 其他 4 个 Tab 未选中
      expect(html).toMatch(/id="napcat-tab-reply"[^>]*aria-selected="false"/);
      expect(html).toMatch(/id="napcat-tab-persona"[^>]*aria-selected="false"/);
      expect(html).toMatch(/id="napcat-tab-proactive"[^>]*aria-selected="false"/);
      expect(html).toMatch(/id="napcat-tab-memory"[^>]*aria-selected="false"/);

      // connection panel 为显示状态 (没有 hidden 属性)
      expect(html).toMatch(/id="napcat-tabpanel-connection"[^>]*role="tabpanel"/);
      expect(html).not.toMatch(/id="napcat-tabpanel-connection"[^>]*hidden/);

      // 其他 4 个 panel 具有 hidden 属性与 display:none
      expect(html).toMatch(/id="napcat-tabpanel-reply"[^>]*hidden/);
      expect(html).toMatch(/id="napcat-tabpanel-persona"[^>]*hidden/);
      expect(html).toMatch(/id="napcat-tabpanel-proactive"[^>]*hidden/);
      expect(html).toMatch(/id="napcat-tabpanel-memory"[^>]*hidden/);
    });

    it('Tab 1 (连接身份) 包含全部 6 个预定义配置项', () => {
      const html = renderCard();

      // 提取 connection panel 内容
      const connectionPanelMatch = html.match(
        /id="napcat-tabpanel-connection"[\s\S]*?(?=<div[^>]*id="napcat-tabpanel-reply")/
      );
      expect(connectionPanelMatch).not.toBeNull();
      const connectionHtml = connectionPanelMatch![0];

      // 1. ws_port
      expect(connectionHtml).toContain('id="napcat-ws-port"');
      expect(connectionHtml).toContain('WebSocket 监听端口 (ws_port)');

      // 2. ws_token
      expect(connectionHtml).toContain('id="napcat-ws-token"');
      expect(connectionHtml).toContain('WebSocket 鉴权 Token (ws_token)');

      // 3. bot_qq
      expect(connectionHtml).toContain('id="napcat-bot-qq"');
      expect(connectionHtml).toContain('Bot 自身 QQ 号 (bot_qq)');

      // 4. admins
      expect(connectionHtml).toContain('id="napcat-admins"');
      expect(connectionHtml).toContain('管理员 QQ 白名单 (admins)');

      // 5. aliases
      expect(connectionHtml).toContain('id="napcat-aliases"');
      expect(connectionHtml).toContain('Bot 唤醒别名列表 (aliases)');

      // 6. image_ttl_days
      expect(connectionHtml).toContain('id="napcat-image-ttl"');
      expect(connectionHtml).toContain('多媒体文件缓存 TTL 天数 (image_ttl_days)');
    });
  });

  describe('3. Tab 切换与各 Tab 控件完整性契约', () => {
    it('切换到 Tab 2 (回复行为) 时展示对应 2 个字段，其他 panel 隐藏', () => {
      const onTabChange = vi.fn();
      const html = renderCard({ initialTab: 'reply', onTabChange });

      // reply panel 显示
      expect(html).toMatch(/id="napcat-tab-reply"[^>]*aria-selected="true"/);
      expect(html).not.toMatch(/id="napcat-tabpanel-reply"[^>]*hidden/);
      expect(html).toMatch(/id="napcat-tabpanel-connection"[^>]*hidden/);

      // 验证 2 个字段
      const panelMatch = html.match(
        /id="napcat-tabpanel-reply"[\s\S]*?(?=<div[^>]*id="napcat-tabpanel-persona")/
      );
      const replyHtml = panelMatch![0];
      expect(replyHtml).toContain('id="napcat-quote-original"');
      expect(replyHtml).toContain('群聊回复引用原消息 (quote_original)');
      expect(replyHtml).toContain('id="napcat-at-questioner"');
      expect(replyHtml).toContain('群聊回复 @ 提问者 (at_questioner)');
    });

    it('切换到 Tab 3 (人格与准则) 时展示对应 2 个 TextArea 字段', () => {
      const html = renderCard({ initialTab: 'persona' });

      expect(html).toMatch(/id="napcat-tab-persona"[^>]*aria-selected="true"/);
      expect(html).not.toMatch(/id="napcat-tabpanel-persona"[^>]*hidden/);

      const panelMatch = html.match(
        /id="napcat-tabpanel-persona"[\s\S]*?(?=<div[^>]*id="napcat-tabpanel-proactive")/
      );
      const personaHtml = panelMatch![0];
      expect(personaHtml).toContain('id="napcat-persona"');
      expect(personaHtml).toContain('助手人格设定 (persona)');
      expect(personaHtml).toContain('id="napcat-behavior"');
      expect(personaHtml).toContain('行为准则 (behavior)');
    });

    it('切换到 Tab 4 (主动回复) 时展示对应 8 个主动回复配置项', () => {
      const html = renderCard({ initialTab: 'proactive' });

      expect(html).toMatch(/id="napcat-tab-proactive"[^>]*aria-selected="true"/);
      expect(html).not.toMatch(/id="napcat-tabpanel-proactive"[^>]*hidden/);

      const panelMatch = html.match(
        /id="napcat-tabpanel-proactive"[\s\S]*?(?=<div[^>]*id="napcat-tabpanel-memory")/
      );
      const proactiveHtml = panelMatch![0];

      // 8 个字段逐一核对
      expect(proactiveHtml).toContain('id="napcat-proactive-reply-enabled"');
      expect(proactiveHtml).toContain('启用群聊主动回复 (proactive_reply_enabled)');

      expect(proactiveHtml).toContain('id="napcat-proactive-only-text"');
      expect(proactiveHtml).toContain('仅回复文本内容 (proactive_only_text)');

      expect(proactiveHtml).toContain('id="napcat-proactive-random-enabled"');
      expect(proactiveHtml).toContain('普通消息概率插话 (proactive_random_enabled)');

      expect(proactiveHtml).toContain('id="napcat-proactive-random-probability"');
      expect(proactiveHtml).toContain('随机插话概率 (proactive_random_probability)');

      expect(proactiveHtml).toContain('id="napcat-proactive-idle-enabled"');
      expect(proactiveHtml).toContain('潜水超时主动唤醒 (proactive_idle_enabled)');

      expect(proactiveHtml).toContain('id="napcat-proactive-idle-timeout"');
      expect(proactiveHtml).toContain('潜水时长阈值 (proactive_idle_timeout_mins)');

      expect(proactiveHtml).toContain('id="napcat-proactive-cooldown"');
      expect(proactiveHtml).toContain('主动回复冷却时间 (proactive_cooldown_mins)');

      expect(proactiveHtml).toContain('id="napcat-proactive-night-dnd"');
      expect(proactiveHtml).toContain('夜间免打扰模式 (proactive_night_dnd)');
    });

    it('切换到 Tab 5 (记忆与回顾) 时展示对应 6 个记忆配置项', () => {
      const html = renderCard({ initialTab: 'memory' });

      expect(html).toMatch(/id="napcat-tab-memory"[^>]*aria-selected="true"/);
      expect(html).not.toMatch(/id="napcat-tabpanel-memory"[^>]*hidden/);

      const panelMatch = html.match(
        /id="napcat-tabpanel-memory"[\s\S]*?(?=<div[^>]*class="[^"]*napcat_footer)/
      );
      const memoryHtml = panelMatch![0];

      // 6 个字段逐一核对
      expect(memoryHtml).toContain('id="napcat-memory-storage-dir"');
      expect(memoryHtml).toContain('记忆存储目录 (memory_storage_dir)');

      expect(memoryHtml).toContain('id="napcat-memory-budget-chars"');
      expect(memoryHtml).toContain('群聊用户画像预算字符上限 (memory_budget_chars)');

      expect(memoryHtml).toContain('id="napcat-review-enabled"');
      expect(memoryHtml).toContain('启用后台自动回顾 (review_enabled)');

      expect(memoryHtml).toContain('id="napcat-review-turns-interval"');
      expect(memoryHtml).toContain('自动回顾轮次间隔 (review_turns_interval)');

      expect(memoryHtml).toContain('id="napcat-review-tool-calls-interval"');
      expect(memoryHtml).toContain('自动回顾工具调用间隔 (review_tool_calls_interval)');

      expect(memoryHtml).toContain('id="napcat-review-model"');
      expect(memoryHtml).toContain('后台回顾专用子模型 (review_model)');
    });

    it('setActiveTab 正确触发 onTabChange 回调通知', () => {
      const onTabChange = vi.fn();
      renderCard({ onTabChange });

      controller.setActiveTab('memory');
      expect(onTabChange).toHaveBeenCalledWith('memory');

      controller.setActiveTab('reply');
      expect(onTabChange).toHaveBeenCalledWith('reply');
    });
  });

  describe('4. 跨 Tab 修改与未保存状态保持契约', () => {
    it('在 Tab 1 修改并在 Tab 2 修改时，跨 Tab 草稿保留且未保存标识持续生效', () => {
      renderCard({
        initialConfig: {
          ws_port: 8080,
          quote_original: true,
          persona: '默认人格',
        },
      });

      // 初始状态未被修改
      expect(controller.isDirty).toBe(false);

      // 1. 在 Tab 1 (connection) 修改 ws_port
      controller.handleFieldChange('ws_port', 9000);
      expect(controller.isDirty).toBe(true);
      expect(controller.model.getDraft().ws_port).toBe(9000);

      // 2. 切换到 Tab 2 (reply)
      controller.setActiveTab('reply');
      expect(controller.isDirty).toBe(true);
      // 检查 Tab 1 的修改未丢失
      expect(controller.model.getDraft().ws_port).toBe(9000);

      // 3. 在 Tab 2 修改 quote_original
      controller.handleFieldChange('quote_original', false);
      expect(controller.isDirty).toBe(true);
      expect(controller.model.getDraft().quote_original).toBe(false);

      // 4. 切换到 Tab 3 (persona) 并修改 persona
      controller.setActiveTab('persona');
      controller.handleFieldChange('persona', '猫娘程序员');
      expect(controller.model.getDraft().persona).toBe('猫娘程序员');

      // 5. 切回 Tab 1，所有 Tab 的修改依然完好保留在 draft
      controller.setActiveTab('connection');
      const finalDraft = controller.model.getDraft();
      expect(finalDraft.ws_port).toBe(9000);
      expect(finalDraft.quote_original).toBe(false);
      expect(finalDraft.persona).toBe('猫娘程序员');
      expect(controller.isDirty).toBe(true);
    });

    it('admins 与 aliases 逗号分隔字符串输入与数组解析跨 Tab 正确保留', () => {
      renderCard({
        initialConfig: {
          admins: ['10001'],
          aliases: ['bot'],
        },
      });

      // 支持英文逗号与中文逗号及空格混合
      controller.handleAdminsChange('10001, 10002， 10003');
      controller.handleAliasesChange('bot, 小助手， 机器猫');

      expect(controller.model.getDraft().admins).toEqual(['10001', '10002', '10003']);
      expect(controller.model.getDraft().aliases).toEqual(['bot', '小助手', '机器猫']);
      expect(controller.isDirty).toBe(true);

      // 切换 Tab 后草稿保持
      controller.setActiveTab('reply');
      expect(controller.model.getDraft().admins).toEqual(['10001', '10002', '10003']);
      expect(controller.model.getDraft().aliases).toEqual(['bot', '小助手', '机器猫']);
    });
  });

  describe('5. 全局单次保存 (跨 Tab 一并提交) 契约', () => {
    it('点击「保存更改」时，一次性向 onSaveSettings 提交包含所有 Tab 修改的完整 draft', async () => {
      renderCard({
        revision: 5,
        initialConfig: {
          ws_port: 8080,
          quote_original: true,
          proactive_reply_enabled: false,
          memory_budget_chars: 2200,
        },
      });

      // 跨 Tab 修改多项设置
      // Tab 1:
      controller.handleFieldChange('ws_port', 9876);
      // Tab 2:
      controller.handleFieldChange('quote_original', false);
      // Tab 4:
      controller.handleFieldChange('proactive_reply_enabled', true);
      // Tab 5:
      controller.handleFieldChange('memory_budget_chars', 4000);

      expect(controller.isDirty).toBe(true);

      // 触发底部全局保存
      await controller.handleSave();

      // 契约断言 1: onSaveSettings 只被单次调用
      expect(mockSaveSettings).toHaveBeenCalledTimes(1);

      // 契约断言 2: 单次调用的 draft 包含跨 Tab 的所有字段修改
      const [savedDraft, options] = mockSaveSettings.mock.calls[0];
      expect(options).toEqual({ expectedRevision: 5 });
      expect(savedDraft.ws_port).toBe(9876);
      expect(savedDraft.quote_original).toBe(false);
      expect(savedDraft.proactive_reply_enabled).toBe(true);
      expect(savedDraft.memory_budget_chars).toBe(4000);

      // 契约断言 3: 保存成功后 dirty 状态被清除，版本号更新
      expect(controller.isDirty).toBe(false);
      expect(controller.model.getRevision()).toBe(2);
    });

    it('保存被拒绝或冲突时正确设置 errorMessage 且保留修改', async () => {
      mockSaveSettings.mockRejectedValueOnce(new Error('网络超时或鉴权失败'));

      renderCard({
        initialConfig: { ws_port: 8080 },
      });

      controller.handleFieldChange('ws_port', 9999);
      await controller.handleSave();

      expect(controller.errorMessage).toBe('网络超时或鉴权失败');
      expect(controller.isDirty).toBe(true);
      expect(controller.model.getDraft().ws_port).toBe(9999);
    });
  });

  describe('6. 放弃修改与字段重置契约', () => {
    it('点击「放弃修改」时，跨所有 Tab 的所有修改全部撤回为 initialConfig', () => {
      renderCard({
        initialConfig: {
          ws_port: 8080,
          quote_original: true,
          admins: ['10001'],
          persona: '原始人格',
        },
      });

      // 跨 Tab 修改
      controller.handleFieldChange('ws_port', 9999);
      controller.handleFieldChange('quote_original', false);
      controller.handleAdminsChange('99999');
      controller.handleFieldChange('persona', '修改后的人格');

      expect(controller.isDirty).toBe(true);

      // 点击底部「放弃修改」
      controller.handleDiscard();

      // 断言修改被全部撤销
      const draft = controller.model.getDraft();
      expect(draft.ws_port).toBe(8080);
      expect(draft.quote_original).toBe(true);
      expect(draft.admins).toEqual(['10001']);
      expect(draft.persona).toBe('原始人格');
      expect(controller.isDirty).toBe(false);
    });

    it('单字段重置 (handleResetField) 正确重置该字段至 baseDefault，不影响其他修改', () => {
      renderCard({
        baseDefaults: {
          ws_port: DEFAULT_WS_PORT,
          quote_original: true,
        },
        initialConfig: {
          ws_port: DEFAULT_WS_PORT,
          quote_original: true,
        },
      });

      // 自定义两个字段
      controller.handleFieldChange('ws_port', 3000);
      controller.handleFieldChange('quote_original', false);

      expect(controller.model.isOverridden('ws_port')).toBe(true);
      expect(controller.model.isOverridden('quote_original')).toBe(true);

      // 仅重置 ws_port
      controller.handleResetField('ws_port');

      expect(controller.model.getDraft().ws_port).toBe(DEFAULT_WS_PORT);
      expect(controller.model.isOverridden('ws_port')).toBe(false);

      // quote_original 依然处于修改状态
      expect(controller.model.getDraft().quote_original).toBe(false);
      expect(controller.model.isOverridden('quote_original')).toBe(true);
      expect(controller.isDirty).toBe(true);
    });
  });
});
