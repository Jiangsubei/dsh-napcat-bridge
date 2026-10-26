/**
 * 契约测试：客户端 settings.section 侧边栏独立页面装配与 0.2.1 纯净架构契约
 *
 * 目标（遵循 AGENTS.md §3 TDD 与先行契约规范）：
 *   1. 模块元数据与依赖契约：
 *      - `name` 对齐为 'dsh-napcat-bridge'（去除历史 '/client' 后缀）；
 *      - `inject` 收敛为 ['slots']，严禁包含已废弃的 'sessions' 与 'settingsScope'；
 *   2. DSH 0.2.1 规范侧边栏独立页面装配契约（settings.section）：
 *      - 必须注入 'settings.section' 插槽；
 *      - 彻底拒绝旧版 'settings.plugin.item' 插槽；
 *      - 绝不注入 'conversation.composer.dock'（已彻底移除不稳定输入框隐藏逻辑，恢复默认状态）；
 *      - 元数据规范：id='napcat'、order=55、locale='dsh-napcat-bridge'、
 *        label 为函数返回展示文案、inject 为函数返回 {}（REST 自驱动）；
 *   3. 顶层组件导出契约：
 *      - 导出 NapCatSettingsSection 组件，且为合法的 React 组件。
 *
 * 参考基线：
 *   - F:\Project\dsh-qqbot-bridge\tests\contract\client-settings.test.ts
 *   - docs/技术债清查与0.2.1纯净架构升级方案.md
 */

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// card.tsx 从 DSH 平台 seed 引入图标；契约测试不加载真实 DSH 客户端运行时。
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  IconChevronDownOutlineRegular: () => null,
  IconChevronDownOutlineMedium: () => null,
}));

import * as clientModule from '../../src/client/index.js';

const { name, inject, apply } = clientModule as any;
const NapCatSettingsSection = (clientModule as any).NapCatSettingsSection;

// 模拟 DOM 环境（防 Node 环境无 document 报错）
class MockElement {
  id = '';
  textContent = '';
  attributes: Record<string, string> = {};
  dataset: Record<string, string> = {};
  children: MockElement[] = [];

  setAttribute(name: string, value: string) {
    this.attributes[name] = String(value);
  }
  getAttribute(name: string) {
    return this.attributes[name] ?? null;
  }
  removeAttribute(name: string) {
    delete this.attributes[name];
  }
  hasAttribute(name: string) {
    return name in this.attributes;
  }
  appendChild(child: MockElement) {
    this.children.push(child);
    return child;
  }
  remove() {}
}

function createMockDocument() {
  const head = new MockElement();
  const body = new MockElement();
  return {
    head,
    body,
    createElement: () => new MockElement(),
    getElementById: () => null,
    querySelector: () => null,
  };
}

function createMockContext() {
  const injectedSlots: string[] = [];
  const registeredItems: Array<{ meta: any; component: any }> = [];

  const mockCtx = {
    slots: {
      inject: vi.fn((slotName: string, cb: () => any) => {
        injectedSlots.push(slotName);
        const res = cb?.();
        // 兼容 generator 与普通函数形式的插槽回调
        if (res && typeof res[Symbol.iterator] === 'function') {
          for (const _item of res) {
            // generator 产生的 item 已在 register 阶段记录
          }
        }
      }),
      register: vi.fn((meta: any, component: any) => {
        const item = { meta, component };
        registeredItems.push(item);
        return item;
      }),
    },
  };

  return { mockCtx, injectedSlots, registeredItems };
}

describe('契约测试: 客户端 settings.section 侧边栏独立页面与 0.2.1 装配规范', () => {
  beforeEach(() => {
    (globalThis as any).document = createMockDocument();
  });

  describe('1. 模块元数据与依赖契约', () => {
    it('导出的模块名 name 必须对齐为 "dsh-napcat-bridge"（不得带 /client 后缀）', () => {
      expect(name).toBe('dsh-napcat-bridge');
    });

    it('导出的 inject 依赖数组必须收敛为 ["slots"]', () => {
      expect(inject).toBeDefined();
      expect(Array.isArray(inject)).toBe(true);
      expect(inject).toEqual(['slots']);
    });

    it('严禁包含已废弃的 "sessions" 与 "settingsScope" 依赖', () => {
      expect(inject).not.toContain('sessions');
      expect(inject).not.toContain('settingsScope');
    });

    it('严禁包含已废弃的 "connection" 或 "workspace-controller" 等幽灵依赖', () => {
      expect(inject).not.toContain('connection');
      expect(inject).not.toContain('workspace-controller');
      expect(inject).not.toContain('@deepseek-ai/dsh-client-connection');
    });
  });

  describe('2. DSH 0.2.1 规范侧边栏独立页面装配契约（settings.section）', () => {
    it('客户端 apply(ctx) 必须注入 settings.section 插槽，且彻底拒绝旧版 settings.plugin.item 插槽', () => {
      const { mockCtx, injectedSlots } = createMockContext();

      apply(mockCtx);

      // 1. 必须注入 settings.section
      expect(injectedSlots).toContain('settings.section');

      // 2. 彻底拒绝已废弃的 settings.plugin.item
      expect(injectedSlots).not.toContain('settings.plugin.item');
    });

    it('彻底移除输入框隐藏器注入，恢复默认状态（绝不注入 conversation.composer.dock）', () => {
      const { mockCtx, injectedSlots } = createMockContext();

      apply(mockCtx);

      expect(injectedSlots).not.toContain('conversation.composer.dock');
    });

    it('slots.register 注册元数据必须完全对齐 0.2.1 规范', () => {
      const { mockCtx, registeredItems } = createMockContext();

      apply(mockCtx);

      const sectionRegistration = registeredItems.find(
        (item) => item.meta?.name === 'settings.section'
      );
      expect(sectionRegistration, '未找到 settings.section 注册项').toBeDefined();

      const { meta, component } = sectionRegistration!;

      // 1. 核心元数据字段断言：按 0.2.1 规范收窄，不传入空 locale 声明
      expect(meta.name).toBe('settings.section');
      expect(meta.id).toBe('napcat');
      expect(meta.order).toBe(55);
      expect(meta.locale).toBeUndefined();

      // 2. label 为函数，且调用返回包含 QQ 或 NapCat 的标题文案
      expect(typeof meta.label).toBe('function');
      const labelText = meta.label();
      expect(typeof labelText).toBe('string');
      expect(labelText).toMatch(/QQ|NapCat/i);

      // 3. inject 应当保持 undefined（REST 自驱动，不需要空对象注水）
      expect(meta.inject).toBeUndefined();

      // 4. 注册组件必须绑定 NapCatSettingsSection
      expect(component).toBe(NapCatSettingsSection);
    });
  });

  describe('3. 顶层组件导出契约', () => {
    it('模块必须显式导出 NapCatSettingsSection 组件', () => {
      expect('NapCatSettingsSection' in clientModule).toBe(true);
      expect(NapCatSettingsSection).toBeDefined();
    });

    it('NapCatSettingsSection 必须为合法的 React 组件（函数或对象）', () => {
      expect(
        typeof NapCatSettingsSection === 'function' || typeof NapCatSettingsSection === 'object'
      ).toBe(true);
    });

    it('NapCatSettingsSection 可被 React 正常实例化创建元素', () => {
      if (NapCatSettingsSection) {
        const element = React.createElement(NapCatSettingsSection);
        expect(React.isValidElement(element)).toBe(true);
      } else {
        expect(NapCatSettingsSection).toBeDefined();
      }
    });

    it('NapCatSettingsSection 接收 0.2.1 owner close 回调并支持真实静态渲染', () => {
      const closeMock = vi.fn();
      const html = renderToStaticMarkup(
        React.createElement(NapCatSettingsSection, {
          close: closeMock,
          initialConfig: { bot_qq: '123456789' },
        })
      );
      expect(html).toContain('NapCat');
      expect(html).toContain('123456789');
    });
  });
});
