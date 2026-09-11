import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  IconChevronDownOutline14: () => null,
}));

import {
  isQQSessionId,
  isFixedNapCatWorkspace,
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

  describe('1. 固定工作区判定契约 (isFixedNapCatWorkspace) - 防关键字误伤', () => {
    it('固定工作区 title 为 NapCat 且路径规范匹配 .dsh/workspace/napcat 时判定为 true', () => {
      expect(
        isFixedNapCatWorkspace({
          title: 'NapCat',
          path: '/home/nyara/.dsh/workspace/napcat',
        })
      ).toBe(true);

      // Windows 路径
      expect(
        isFixedNapCatWorkspace({
          title: 'NapCat',
          path: 'C:\\Users\\Nyara\\.dsh\\workspace\\napcat',
        })
      ).toBe(true);
    });

    it('严禁关键字模糊匹配：名称或路径包含 napcat 但非插件专属固定工作区判定为 false', () => {
      // 名字包含 napcat 的普通开发工作区
      expect(
        isFixedNapCatWorkspace({
          title: 'NapCat Tools',
          path: '/home/nyara/.dsh/workspace/napcat',
        })
      ).toBe(false);

      expect(
        isFixedNapCatWorkspace({
          title: 'napcat-dev',
          path: '/home/nyara/projects/napcat-plugin',
        })
      ).toBe(false);

      // 路径包含 napcat 但不是 .dsh/workspace/napcat
      expect(
        isFixedNapCatWorkspace({
          title: 'NapCat',
          path: '/home/nyara/projects/napcat',
        })
      ).toBe(false);
    });
  });

  describe('2. 插件会话专属判定与欢迎页保留契约 (isNapCatWorkspaceOrSession)', () => {
    const mockWorkspaces = [
      {
        workspaceId: 'ws-napcat-fixed',
        title: 'NapCat',
        path: '/home/nyara/.dsh/workspace/napcat',
        sessionIds: ['qq-group-123456#0.1', 'session-webui-custom-uuid-1'],
      },
      {
        workspaceId: 'ws-user-project',
        title: 'My NapCat Project',
        path: '/home/nyara/projects/napcat-app',
        sessionIds: ['session-project-1'],
      },
    ];

    it('以 qq- 前缀开头的会话始终判定为 true (插件自己创建的 QQ 会话)', () => {
      expect(isNapCatWorkspaceOrSession({ sessionId: 'qq-group-123456#0.1' })).toBe(true);
      expect(isNapCatWorkspaceOrSession({ sessionId: 'qq-user-987654#0.1' })).toBe(true);
      expect(isNapCatWorkspaceOrSession({ sessionId: 'qq-default' })).toBe(true);
    });

    it('工作区欢迎页（Hero 状态 / sessionId 为空）绝对判定为 false（保留原生输入框）', () => {
      expect(
        isNapCatWorkspaceOrSession({
          sessionId: undefined,
          currentWorkspaceId: 'ws-napcat-fixed',
          workspaces: mockWorkspaces,
        })
      ).toBe(false);
    });

    it('在 NapCat 工作区中由用户在 Web UI 新建的非 QQ 会话判定为 false（允许 Web UI 发消息调教工作区）', () => {
      expect(
        isNapCatWorkspaceOrSession({
          sessionId: 'session-webui-custom-uuid-1',
          currentWorkspaceId: 'ws-napcat-fixed',
          workspaces: mockWorkspaces,
        })
      ).toBe(false);
    });

    it('普通开发工作区或名字含 napcat 的工作区会话判定为 false（严格不误伤）', () => {
      expect(
        isNapCatWorkspaceOrSession({
          sessionId: 'session-project-1',
          currentWorkspaceId: 'ws-user-project',
          workspaces: mockWorkspaces,
        })
      ).toBe(false);

      expect(isNapCatWorkspaceOrSession({ sessionId: 'default' })).toBe(false);
      expect(isNapCatWorkspaceOrSession({})).toBe(false);
    });

    it('向下兼容 isQQSessionId 辅助函数', () => {
      expect(isQQSessionId('qq-group-123')).toBe(true);
      expect(isQQSessionId('session-webui-123')).toBe(false);
      expect(isQQSessionId('normal-session')).toBe(false);
    });
  });

  describe('3. 全局 Body 属性与样式契约 (syncReadonlyAttribute & ensureReadonlyStyle)', () => {
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

  describe('4. QQComposerHider 组件渲染契约 (只管 QQ 会话，欢迎页与非 QQ 会话返回 null)', () => {
    it('当传入 QQ 会话 sessionId 时，渲染局部隐藏样式', () => {
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

    it('在 NapCat 工作区新建的 Web UI 会话（session-uuid）返回 null（保留输入框）', () => {
      const mockUseSession = (selector?: (s: any) => any) => {
        const session = { sessionId: 'session-native-uuid-999' };
        return selector ? selector(session) : session;
      };

      const html = renderToStaticMarkup(
        React.createElement(QQComposerHider, {
          useSession: mockUseSession,
        })
      );

      expect(html).toBe('');
    });

    it('当无任何会话信息传入（欢迎页 / Hero 状态）时，返回 null（保留输入框）', () => {
      const html = renderToStaticMarkup(
        React.createElement(QQComposerHider, {})
      );

      expect(html).toBe('');
    });

    it('当传入普通非 QQ 会话时，返回 null', () => {
      const html = renderToStaticMarkup(
        React.createElement(QQComposerHider, {
          sessionId: 'default-workspace-task',
        })
      );

      expect(html).toBe('');
    });
  });

  describe('5. 前端插件 apply 装配与运行时联动契约', () => {
    it('apply(ctx) 仅在切换到 QQ 会话时设置 body 属性，欢迎页与非 QQ 会话保持原生', () => {
      let sessionListener: (() => void) | undefined;
      let workspaceListener: (() => void) | undefined;

      let currentSessionId: string | undefined = 'session-normal';
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
                workspaceId: 'ws-napcat-fixed',
                title: 'NapCat',
                path: '/home/nyara/.dsh/workspace/napcat',
                sessionIds: ['qq-group-123456#0.1', 'session-napcat-webui-1'],
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

      // 1. 初始为普通会话，body 无只读属性
      expect(document.body.hasAttribute('data-dsh-napcat-readonly')).toBe(false);

      // 2. 切换当前会话为插件创建的 QQ 会话 -> 激活只读属性（隐藏卡片，保留指标）
      currentSessionId = 'qq-group-123456#0.1';
      currentWorkspaceId = 'ws-napcat-fixed';
      sessionListener?.();
      expect(document.body.getAttribute('data-dsh-napcat-readonly')).toBe('true');

      // 3. 在 NapCat 工作区开新会话（欢迎页 / Hero 状态，sessionId 为空）-> 必须移除只读属性，保留欢迎页输入框！
      currentSessionId = undefined;
      sessionListener?.();
      expect(document.body.hasAttribute('data-dsh-napcat-readonly')).toBe(false);

      // 4. 在 NapCat 工作区创建了 Web UI 会话（非 QQ 会话）-> 必须移除只读属性，允许 Web UI 发送消息！
      currentSessionId = 'session-napcat-webui-1';
      sessionListener?.();
      expect(document.body.hasAttribute('data-dsh-napcat-readonly')).toBe(false);

      // 5. 彻底离开 NapCat 工作区，切换到普通工作区
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
