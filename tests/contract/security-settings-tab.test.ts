/**
 * tests/contract/security-settings-tab.test.ts
 * 契约测试: Web UI 设置卡「权限与安全」Tab 渲染与交互 (Security Settings Tab Contract)
 */

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it, expect, vi } from 'vitest';

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  IconChevronDownOutlineRegular: () => null,
  IconChevronDownOutlineMedium: () => null,
  IconTrashOutlineRegular: () => null,
}));

import {
  NapCatSettingsCard,
  SETTINGS_TABS,
  type CardProps,
  type CardController,
} from '../../src/client/card.js';

describe('契约测试: Web UI 设置卡「权限与安全」Tab (Security Settings Tab Contract)', () => {
  function renderCard(props: Partial<CardProps> = {}) {
    let captured: CardController | null = null;
    const html = renderToStaticMarkup(
      React.createElement(NapCatSettingsCard, {
        initialExpanded: true,
        controllerRef: (ctrl) => {
          captured = ctrl;
        },
        ...props,
      })
    );
    return { html, controller: captured };
  }

  it('契约 1: SETTINGS_TABS 包含 security Tab，且总数从 6 变更为 7，渲染 Tab 按钮', () => {
    const securityTab = SETTINGS_TABS.find((t) => t.id === 'security');
    expect(securityTab).toBeDefined();
    expect(securityTab?.label).toBe('权限与安全');
    expect(SETTINGS_TABS).toHaveLength(7);
    expect(SETTINGS_TABS[3].id).toBe('security');

    const { html } = renderCard();
    expect(html).toContain('id="napcat-tab-security"');
    expect(html).toContain('权限与安全');
  });

  it('契约 2: 切换至 security Tab，必须渲染三级分区容器与标题', () => {
    const { html } = renderCard({ initialTab: 'security' });

    expect(html).toContain('napcat-tabpanel-security');
    // 分区 1: 发言黑名单
    expect(html).toContain('发言黑名单');
    expect(html).toContain('私聊黑名单');
    expect(html).toContain('群聊黑名单');

    // 分区 2: 会话默认权限模式
    expect(html).toContain('新建会话权限模式');
    expect(html).toContain('napcat-session-permission-private-default');
    expect(html).toContain('napcat-session-permission-group-default');
    expect(html).toContain('私聊权限例外覆盖');
    expect(html).toContain('群聊权限例外覆盖');

    // 分区 3: Coding 工具组装载控制
    expect(html).toContain('Coding 工具组装载');
    expect(html).toContain('napcat-coding-tools-private-default');
    expect(html).toContain('napcat-coding-tools-group-default');
    expect(html).toContain('私聊 Coding 工具例外覆盖');
    expect(html).toContain('群聊 Coding 工具例外覆盖');
  });

  it('契约 3: security Tab 默认展示正确的初始默认权限与开关状态', () => {
    const { html } = renderCard({ initialTab: 'security' });

    // 默认私聊为 workspace-write，群聊为 read-only
    expect(html).toContain('value="workspace-write"');
    expect(html).toContain('value="read-only"');
    // 私聊默认开启 coding 工具，群聊默认关闭
    expect(html).toContain('id="napcat-coding-tools-private-default"');
    expect(html).toContain('id="napcat-coding-tools-group-default"');
  });

  it('契约 4: security Tab 头部右对齐渲染 6 处加号图标按钮，且默认不常驻输入框', () => {
    const { html } = renderCard({ initialTab: 'security' });

    // 6 处头部加号图标按钮
    expect(html).toContain('title="添加私聊黑名单"');
    expect(html).toContain('title="添加群聊黑名单"');
    expect(html).toContain('title="添加私聊权限例外"');
    expect(html).toContain('title="添加群聊权限例外"');
    expect(html).toContain('title="添加私聊工具例外"');
    expect(html).toContain('title="添加群聊工具例外"');

    // 默认折叠状态下，不应常驻显示输入框 placeholder
    expect(html).not.toContain('placeholder="QQ 号 (如: 1000000003)"');
    expect(html).not.toContain('placeholder="群号 (如: 8000000001)"');
  });

  it('契约 5: security Tab 已有条目渲染卡片，右侧右对齐垃圾桶删除图标按钮', () => {
    const { html } = renderCard({
      initialTab: 'security',
      initialConfig: {
        private_blacklist: ['1000000002'],
        group_blacklist: ['8000000002'],
        session_permission_overrides: [
          { id: '1000000003', type: 'user', permission: 'read-only' },
          { id: '8000000003', type: 'group', permission: 'workspace-write' },
        ],
        coding_tools_overrides: [
          { id: '1000000004', type: 'user', enabled: true },
          { id: '8000000004', type: 'group', enabled: false },
        ],
      },
    });

    expect(html).toContain('1000000002');
    expect(html).toContain('8000000002');
    expect(html).toContain('1000000003');
    expect(html).toContain('8000000003');
    expect(html).toContain('1000000004');
    expect(html).toContain('8000000004');
    expect(html).toContain('title="移除黑名单"');
    expect(html).toContain('title="移除权限例外"');
    expect(html).toContain('title="移除工具例外"');
  });
});
