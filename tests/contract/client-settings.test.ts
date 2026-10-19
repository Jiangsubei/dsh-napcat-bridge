/**
 * 契约测试：客户端 settings.section 侧边栏独立页面装配与 0.2.1 纯净架构契约
 *
 * 目标（遵循 AGENTS.md §3 TDD 与先行契约规范）：
 *   1. 模块元数据与依赖契约：
 *      - `name` 对齐为 'dsh-napcat-bridge'（去除历史 '/client' 后缀）；
 *      - `inject` 收敛为 ['slots', 'sessions']，严禁包含已废弃的 'settingsScope'；
 *   2. DSH 0.2.1 规范侧边栏独立页面装配契约（settings.section）：
 *      - 必须注入 'settings.section' 插槽；
 *      - 彻底拒绝旧版 'settings.plugin.item' 插槽；
 *      - 元数据规范：id='napcat'、order=55、locale='dsh-napcat-bridge'、
 *        label 为函数返回展示文案、inject 为函数返回 {}（REST 自驱动）；
 *   3. 顶层组件导出契约：
 *      - 导出 NapCatSettingsSection 组件，且为合法的 React 组件；
 *   4. 输入框隐藏器保留契约：
 *      - apply(ctx) 依然注入 'conversation.composer.dock' 挂载 QQComposerHider。
 *
 * 参考基线：
 *   - F:\Project\dsh-qqbot-bridge\tests\contract\client-settings.test.ts
 *   - docs/技术债清查与0.2.1纯净架构升级方案.md
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// card.tsx 从 DSH 平台 seed 引入图标；契约测试不加载真实 DSH 客户端运行时。
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  IconChevronDownOutline14: () => null,
  IconChevronDownOutlineRegular: () => null,
  IconChevronDownOutlineMedium: () => null,
}));

import * as clientModule from '../../src/client/index.js';

const { name, inject, apply, QQComposerHider } = clientModule as any;
const NapCatSettingsSection = (clientModule as any).NapCatSettingsSection;

// 模拟 DOM 环境（防 Node 环境无 document 报错）
class MockElement {
  id = '';
  textContent = '';
  attributes: Record<string, string> = {};
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
  };
}

function createMockContext() {
  const injectedSlots: string[] = [];
  const registeredItems: Array<{ meta: any; component: any }> = [];

  const mockCtx = {
    get: vi.fn((key: string) => {
      if (key === 'sessions') {
        return {
          list: {
            getSnapshot: () => ({ current: undefined }),
            subscribe: vi.fn(() => () => {}),
          },
        };
      }
      return undefined;
    }),
    sessions: {
      list: {
        getSnapshot: () => ({ current: undefined }),
        subscribe: vi.fn(() => () => {}),
      },
    },
    effect: vi.fn((fn: () => any) => {
      if (typeof fn === 'function') {
        return fn();
      }
    }),
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

    it('导出的 inject 依赖数组必须收敛为 ["slots", "sessions"]', () => {
      expect(inject).toBeDefined();
      expect(Array.isArray(inject)).toBe(true);
      expect([...inject].sort()).toEqual(['sessions', 'slots'].sort());
    });

    it('严禁包含已废弃的 "settingsScope" 依赖（防止插件 Fiber 无法激活）', () => {
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

    it('slots.register 注册元数据必须完全对齐 0.2.1 规范', () => {
      const { mockCtx, registeredItems } = createMockContext();

      apply(mockCtx);

      const sectionRegistration = registeredItems.find(
        (item) => item.meta?.name === 'settings.section'
      );
      expect(sectionRegistration, '未找到 settings.section 注册项').toBeDefined();

      const { meta, component } = sectionRegistration!;

      // 1. 核心元数据字段断言
      expect(meta.name).toBe('settings.section');
      expect(meta.id).toBe('napcat');
      expect(meta.order).toBe(55);
      expect(meta.locale).toBe('dsh-napcat-bridge');

      // 2. label 为函数，且调用返回包含 QQ 或 NapCat 的标题文案
      expect(typeof meta.label).toBe('function');
      const labelText = meta.label();
      expect(typeof labelText).toBe('string');
      expect(labelText).toMatch(/QQ|NapCat/i);

      // 3. inject 为函数，返回空对象（REST 自驱动无需依赖内部属性）
      expect(typeof meta.inject).toBe('function');
      expect(meta.inject()).toEqual({});

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
  });

  describe('4. 输入框隐藏器保留契约', () => {
    it('apply(ctx) 必须依然注入 conversation.composer.dock 插槽并挂载 QQComposerHider', () => {
      const { mockCtx, injectedSlots, registeredItems } = createMockContext();

      apply(mockCtx);

      // 1. 保留 conversation.composer.dock 插槽注入
      expect(injectedSlots).toContain('conversation.composer.dock');

      // 2. 挂载组件与元数据断言
      const dockRegistration = registeredItems.find(
        (item) => item.meta?.name === 'conversation.composer.dock'
      );
      expect(dockRegistration, '未找到 conversation.composer.dock 注册项').toBeDefined();
      expect(dockRegistration!.meta.id).toBe('dsh-napcat-bridge-hide-composer');
      expect(dockRegistration!.component).toBe(QQComposerHider);
    });
  });
});
