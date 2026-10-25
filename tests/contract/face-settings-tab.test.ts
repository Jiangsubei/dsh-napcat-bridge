/**
 * tests/contract/face-settings-tab.test.ts
 * 契约测试: Web UI 设置卡「表情包」Tab 渲染与交互
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

describe('契约测试: Web UI 设置卡「表情包」Tab (Face Settings Tab Contract)', () => {
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

  it('契约 1: SETTINGS_TABS 包含表情包 Tab，且渲染 Tab 按钮', () => {
    const faceTab = SETTINGS_TABS.find((t) => t.id === 'face');
    expect(faceTab).toBeDefined();
    expect(faceTab?.label).toBe('表情包');

    const { html } = renderCard();
    expect(html).toContain('id="napcat-tab-face"');
    expect(html).toContain('表情包');
  });

  it('契约 2: 切换至 face Tab，默认渲染总开关 face_enabled (默认关闭)', () => {
    const { html } = renderCard({ initialTab: 'face' });

    expect(html).toContain('napcat-tabpanel-face');
    // 渲染总开关
    expect(html).toContain('启用表情包系统');
    expect(html).toContain('id="napcat-face-enabled"');

    // 总开关关闭时，不展示内部配额与画廊
    expect(html).not.toContain('id="napcat-face-store-max"');
    expect(html).not.toContain('napcat-face-gallery');
  });

  it('契约 3: 总开关开启 (face_enabled=true) 时展示配额、淘汰策略与表情画廊', () => {
    const { html } = renderCard({
      initialTab: 'face',
      initialConfig: {
        face_enabled: true,
        face_store_max: 100,
        face_evict_policy: 'reject',
      },
    });

    expect(html).toContain('napcat-tabpanel-face');
    expect(html).toContain('id="napcat-face-store-max"');
    expect(html).toContain('id="napcat-face-evict-policy"');
    expect(html).toContain('napcat-face-gallery');
    // 包含拖拽/图标上传框与免强制打标输入框
    expect(html).toContain('napcat-face-upload-box');
    expect(html).toContain('📤');
    // 包含铅笔编辑按钮与垃圾桶删除按钮
    expect(html).toContain('napcat-face-edit-btn');
    expect(html).toContain('napcat-face-delete-btn');
  });
});
