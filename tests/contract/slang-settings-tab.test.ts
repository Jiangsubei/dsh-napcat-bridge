/**
 * tests/contract/slang-settings-tab.test.ts
 * 契约测试: Web UI 设置卡「黑话学习」Tab 渲染与交互
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

describe('契约测试: Web UI 设置卡「黑话学习」Tab (Slang Settings Tab Contract)', () => {
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

  it('契约 1: SETTINGS_TABS 包含黑话学习 Tab，且渲染 Tab 按钮', () => {
    const slangTab = SETTINGS_TABS.find((t) => t.id === 'slang');
    expect(slangTab).toBeDefined();
    expect(slangTab?.label).toBe('黑话学习');

    const { html } = renderCard();
    expect(html).toContain('id="napcat-tab-slang"');
    expect(html).toContain('黑话学习');
  });

  it('契约 2: 切换至 slang Tab，默认渲染总开关 slang_enabled (默认开启) 及条数上限与淘汰策略', () => {
    const { html } = renderCard({ initialTab: 'slang' });

    expect(html).toContain('napcat-tabpanel-slang');
    expect(html).toContain('装载黑话学习套件');
    expect(html).toContain('id="napcat-slang-enabled"');

    // 默认开启，展示条数容量上限与满额淘汰策略
    expect(html).toContain('id="napcat-slang-max-entries"');
    expect(html).toContain('id="napcat-slang-evict-policy"');
    expect(html).toContain('容量状态:');

    // 确认已废弃的字符预算配置项已彻底清理
    expect(html).not.toContain('id="napcat-slang-budget-chars"');
  });

  it('契约 3: 当 slang_enabled 为 false 时，折叠下级配置与词条列表', () => {
    const { html } = renderCard({
      initialTab: 'slang',
      initialConfig: { slang_enabled: false },
    });

    expect(html).toContain('napcat-tabpanel-slang');
    expect(html).toContain('id="napcat-slang-enabled"');
    expect(html).not.toContain('id="napcat-slang-max-entries"');
    expect(html).not.toContain('id="napcat-slang-evict-policy"');
    expect(html).not.toContain('容量状态:');
  });

  it('契约 4: 渲染「+ 添加黑话」图标按钮且位于容量状态右侧', () => {
    const { html } = renderCard({ initialTab: 'slang' });

    expect(html).toContain('napcat-slang-add-btn');
    expect(html).toContain('title="添加黑话词条"');
    expect(html).toMatch(/容量状态[\s\S]*?napcat-slang-add-btn/);
  });
});
