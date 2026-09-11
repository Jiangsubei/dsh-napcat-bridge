import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  IconChevronDownOutline14: () => null,
}));

import {
  isQQSessionId,
  isNapCatWorkspaceOrSession,
  syncReadonlyAttribute,
  ensureReadonlyStyle,
  QQComposerHider,
  apply,
} from '../../src/client/index.js';

// 模拟 Node.js 测试环境下的浏览器 DOM
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
  remove() {
    // remove from parent
  }
}

function createMockDocument() {
  const head = new MockElement();
  const body = new MockElement();
  const elements = new Map<string, MockElement>();

  return {
    head,
    body,
    createElement: (tag: string) => {
      const el = new MockElement();
      return el;
    },
    getElementById: (id: string) => {
      const find = (el: MockElement): MockElement | null => {
        if (el.id === id) return el;
        for (const child of el.children) {
          const res = find(child);
          if (res) return res;
        }
        return null;
      };
      return find(head) || find(body) || elements.get(id) || null;
    },
  };
}

describe('契约测试: Web UI 只读会话与 NapCat 工作区输入框卡片隐藏 (WebUI Readonly Composer Contract)', () => {
  beforeEach(() => {
    (globalThis as any).document = createMockDocument();
  });

  describe('1. 会话与工作区判定契约 (isNapCatWorkspaceOrSession)', () => {
    const mockWorkspaces = [
      {
        workspaceId: 'ws-napcat-uuid',
        title: 'NapCat',
        path: '/home/nyara/.dsh/workspace/napcat',
        sessionIds: ['qq-group-123456#0.1', 'session-custom-native-uuid-1'],
      },
      {
        workspaceId: 'ws-windows-napcat',
        title: 'NapCat Windows',
        path: 'C:\\Users\\Nyara\\.dsh\\workspace\\napcat',
        sessionIds: ['session-win-uuid'],
      },
      {
        workspaceId: 'ws-normal-project',
        title: 'My Project',
        path: '/home/nyara/projects/app',
        sessionIds: ['session-project-1'],
      },
    ];

    it('以 qq- 前缀开头的会话始终判定为 true (无论归属何处)', () => {
      expect(isNapCatWorkspaceOrSession({ sessionId: 'qq-group-123456#0.1' })).toBe(true);
      expect(isNapCatWorkspaceOrSession({ sessionId: 'qq-user-987654#0.1' })).toBe(true);
      expect(isNapCatWorkspaceOrSession({ sessionId: 'qq-default' })).toBe(true);
    });

    it('Web UI 原生 UUID 会话如果归属于 NapCat 工作区，判定为 true', () => {
      expect(
        isNapCatWorkspaceOrSession({
          sessionId: 'session-custom-native-uuid-1',
          workspaces: mockWorkspaces,
        })
      ).toBe(true);
    });

    it('跨平台 Windows 路径下的 NapCat 工作区会话判定为 true', () => {
      expect(
        isNapCatWorkspaceOrSession({
          sessionId: 'session-win-uuid',
          workspaces: mockWorkspaces,
        })
      ).toBe(true);
    });

    it('当前处于 NapCat 工作区中开新会话 (currentWorkspaceId 命中，哪怕是全新未绑定的 session) 判定为 true', () => {
      expect(
        isNapCatWorkspaceOrSession({
          sessionId: 'session-brand-new-uuid',
          currentWorkspaceId: 'ws-napcat-uuid',
          workspaces: mockWorkspaces,
        })
      ).toBe(true);

      // Hero 模式下尚未分配 sessionId
      expect(
        isNapCatWorkspaceOrSession({
          sessionId: undefined,
          currentWorkspaceId: 'ws-napcat-uuid',
          workspaces: mockWorkspaces,
        })
      ).toBe(true);
    });

    it('普通工作区会话及未关联会话判定为 false（严格不误伤常规开发）', () => {
      expect(
        isNapCatWorkspaceOrSession({
          sessionId: 'session-project-1',
          currentWorkspaceId: 'ws-normal-project',
          workspaces: mockWorkspaces,
        })
      ).toBe(false);

      expect(isNapCatWorkspaceOrSession({ sessionId: 'default' })).toBe(false);
      expect(isNapCatWorkspaceOrSession({})).toBe(false);
    });

    it('向下兼容 isQQSessionId 辅助函数', () => {
      expect(isQQSessionId('qq-group-123')).toBe(true);
      expect(isQQSessionId('normal-session')).toBe(false);
    });
  });

  describe('2. 全局 Body 属性与样式契约 (syncReadonlyAttribute & ensureReadonlyStyle)', () => {
    it('ensureReadonlyStyle 向 document.head 注入隐藏样式规则', () => {
      ensureReadonlyStyle();
      const style = document.getElementById('dsh-napcat-readonly-style');
      expect(style).toBeDefined();
      expect(style?.textContent).toContain('body[data-dsh-napcat-readonly="true"] [data-composer-card]');
      expect(style?.textContent).toContain('display: none !important');
    });

    it('syncReadonlyAttribute(true) 正确设置 body 属性并确保样式已注入', () => {
      syncReadonlyAttribute(true);
      expect(document.body.getAttribute('data-dsh-napcat-readonly')).toBe('true');
      expect(document.getElementById('dsh-napcat-readonly-style')).not.toBeNull();
    });

    it('syncReadonlyAttribute(false) 正确移除 body 属性', () => {
      syncReadonlyAttribute(true);
      expect(document.body.getAttribute('data-dsh-napcat-readonly')).toBe('true');

      syncReadonlyAttribute(false);
      expect(document.body.hasAttribute('data-dsh-napcat-readonly')).toBe(false);
    });
  });

  describe('3. QQComposerHider 组件渲染契约 (支持官方 s.sessionId 与 Workspaces 识别)', () => {
    it('当传入 QQ 会话 sessionId 时，渲染局部备用隐藏样式', () => {
      const html = renderToStaticMarkup(
        React.createElement(QQComposerHider, {
          sessionId: 'qq-group-123456#0.1',
        })
      );

      expect(html).toContain('<style');
      expect(html).toContain('[data-composer-card]');
      expect(html).toContain('display: none !important');
    });

    it('支持 DSH 官方 SessionSnapshot 字段名 s.sessionId', () => {
      const mockUseSession = (selector?: (s: any) => any) => {
        // 验证官方字段名为 sessionId
        const session = { sessionId: 'qq-user-987654#0.1' };
        return selector ? selector(session) : session;
      };

      const html = renderToStaticMarkup(
        React.createElement(QQComposerHider, {
          useSession: mockUseSession,
        })
      );

      expect(html).toContain('<style');
      expect(html).toContain('[data-composer-card]');
      expect(html).toContain('display: none !important');
    });

    it('支持通过 useWorkspaces 识别 NapCat 工作区下的 UUID 会话', () => {
      const mockUseSession = (selector?: (s: any) => any) => {
        const session = { sessionId: 'session-native-uuid-999' };
        return selector ? selector(session) : session;
      };
      const mockUseWorkspaces = (selector?: (w: any) => any) => {
        const data = {
          items: [
            {
              workspaceId: 'ws-napcat',
              title: 'NapCat',
              sessionIds: ['session-native-uuid-999'],
            },
          ],
        };
        return selector ? selector(data) : data;
      };

      const html = renderToStaticMarkup(
        React.createElement(QQComposerHider, {
          useSession: mockUseSession,
          useWorkspaces: mockUseWorkspaces,
        })
      );

      expect(html).toContain('<style');
      expect(html).toContain('[data-composer-card]');
    });

    it('当传入普通非 QQ / 非 NapCat 工作区会话时，返回 null', () => {
      const html = renderToStaticMarkup(
        React.createElement(QQComposerHider, {
          sessionId: 'default-workspace-task',
        })
      );

      expect(html).toBe('');
    });
  });

  describe('4. 前端插件 apply 装配与运行时联动契约', () => {
    it('apply(ctx) 响应式监听 sessions 与 workspaces，并在切换到 NapCat 时同步设置 body 属性', () => {
      let sessionListener: (() => void) | undefined;
      let workspaceListener: (() => void) | undefined;

      let currentSessionId = 'session-normal';
      let currentWorkspaceId = 'ws-normal';

      const mockSessions = {
        list: {
          getSnapshot: () => ({ current: currentSessionId }),
          subscribe: vi.fn((fn: () => void) => {
            sessionListener = fn;
            return () => {};
          }),
        },
      };

      const mockWorkspaces = {
        list: {
          getSnapshot: () => ({
            current: currentWorkspaceId,
            items: [
              {
                workspaceId: 'ws-napcat-1',
                title: 'NapCat',
                path: '/home/nyara/.dsh/workspace/napcat',
                sessionIds: ['session-napcat-native-1'],
              },
              {
                workspaceId: 'ws-normal',
                title: 'Normal',
                path: '/home/nyara/app',
                sessionIds: ['session-normal'],
              },
            ],
          }),
          subscribe: vi.fn((fn: () => void) => {
            workspaceListener = fn;
            return () => {};
          }),
        },
      };

      const registeredSlots: Record<string, any[]> = {};
      const mockCtx: any = {
        get: (name: string) => {
          if (name === 'sessions') return mockSessions;
          if (name === 'workspaces') return mockWorkspaces;
          return undefined;
        },
        effect: vi.fn((fn: () => any) => fn()),
        slots: {
          inject: vi.fn((slotName: string, generator: () => Generator) => {
            registeredSlots[slotName] = Array.from(generator());
          }),
          register: vi.fn((opts: any, component: any) => ({ opts, component })),
        },
      };

      apply(mockCtx);

      // 初始为普通工作区与普通会话，body 无只读属性
      expect(document.body.hasAttribute('data-dsh-napcat-readonly')).toBe(false);

      // 切换当前会话为 NapCat 原生会话
      currentSessionId = 'session-napcat-native-1';
      sessionListener?.();
      expect(document.body.getAttribute('data-dsh-napcat-readonly')).toBe('true');

      // 切换当前会话为普通会话，但处于 NapCat 工作区开新会话 (Hero 模式)
      currentSessionId = 'session-brand-new';
      currentWorkspaceId = 'ws-napcat-1';
      workspaceListener?.();
      expect(document.body.getAttribute('data-dsh-napcat-readonly')).toBe('true');

      // 彻底离开 NapCat 工作区，切换到普通工作区
      currentWorkspaceId = 'ws-normal';
      currentSessionId = 'session-normal';
      workspaceListener?.();
      expect(document.body.hasAttribute('data-dsh-napcat-readonly')).toBe(false);

      // 验证插槽注册正常
      expect(mockCtx.slots.inject).toHaveBeenCalledWith('settings.plugin.item', expect.any(Function));
      expect(mockCtx.slots.inject).toHaveBeenCalledWith('conversation.composer.dock', expect.any(Function));
    });
  });
});
