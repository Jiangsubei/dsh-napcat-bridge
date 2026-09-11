import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it, expect, vi } from 'vitest';

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  IconChevronDownOutline14: () => null,
}));

import {
  isQQSessionId,
  QQComposerHider,
  apply,
} from '../../src/client/index.js';

describe('契约测试: Web UI 只读会话隐藏输入框卡片 (WebUI Readonly Composer Contract)', () => {
  describe('1. isQQSessionId 识别契约', () => {
    it('精确识别 QQ 群聊、私聊与自定义前缀会话 ID', () => {
      expect(isQQSessionId('qq-group-123456#0.1')).toBe(true);
      expect(isQQSessionId('qq-user-987654#0.1')).toBe(true);
      expect(isQQSessionId('qq-default')).toBe(true);
    });

    it('对普通工作区会话、本地会话及非字符串输入返回 false（不误伤）', () => {
      expect(isQQSessionId('default')).toBe(false);
      expect(isQQSessionId('workspace-session-abc')).toBe(false);
      expect(isQQSessionId('')).toBe(false);
      expect(isQQSessionId(undefined)).toBe(false);
      expect(isQQSessionId(null)).toBe(false);
    });
  });

  describe('2. QQComposerHider 组件渲染契约', () => {
    it('当传入 QQ 群聊 sessionId 时，渲染注入 display: none !important 隐藏 [data-composer-card]', () => {
      const html = renderToStaticMarkup(
        React.createElement(QQComposerHider, {
          sessionId: 'qq-group-123456#0.1',
        })
      );

      expect(html).toContain('<style');
      expect(html).toContain('[data-composer-card]');
      expect(html).toContain('display: none !important');
    });

    it('当传入普通非 QQ 会话 sessionId 时，返回 null（不渲染任何样式，恢复原生输入框）', () => {
      const html = renderToStaticMarkup(
        React.createElement(QQComposerHider, {
          sessionId: 'default-workspace-task',
        })
      );

      expect(html).toBe('');
    });

    it('当通过 useSession selector hook 提供 QQ 会话时，正确渲染隐藏卡片样式', () => {
      const mockUseSession = (selector?: (s: any) => any) => {
        const session = { id: 'qq-user-987654#0.1' };
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

    it('当通过 useSession selector hook 提供非 QQ 会话时，返回 null', () => {
      const mockUseSession = (selector?: (s: any) => any) => {
        const session = { id: 'generic-session' };
        return selector ? selector(session) : session;
      };

      const html = renderToStaticMarkup(
        React.createElement(QQComposerHider, {
          useSession: mockUseSession,
        })
      );

      expect(html).toBe('');
    });

    it('当无任何会话信息传入（如初始空白/Hero 状态）时，返回 null', () => {
      const html = renderToStaticMarkup(
        React.createElement(QQComposerHider, {})
      );

      expect(html).toBe('');
    });
  });

  describe('3. 前端插件 apply 装配契约', () => {
    it('apply(ctx) 必须同时在 slots 中注册设置卡片与 conversation.composer.dock 输入框隐藏器', () => {
      const registeredSlots: Record<string, any[]> = {};
      const mockCtx = {
        slots: {
          inject: vi.fn((slotName: string, generator: () => Generator) => {
            registeredSlots[slotName] = Array.from(generator());
          }),
          register: vi.fn((opts: any, component: any) => ({ opts, component })),
        },
      };

      apply(mockCtx);

      expect(mockCtx.slots.inject).toHaveBeenCalledWith(
        'settings.plugin.item',
        expect.any(Function)
      );
      expect(mockCtx.slots.inject).toHaveBeenCalledWith(
        'conversation.composer.dock',
        expect.any(Function)
      );

      // 验证 conversation.composer.dock 注册了 QQComposerHider
      const dockEntries = registeredSlots['conversation.composer.dock'];
      expect(dockEntries).toBeDefined();
      expect(dockEntries.length).toBeGreaterThan(0);
      expect(dockEntries[0].component).toBe(QQComposerHider);
      expect(dockEntries[0].opts.name).toBe('conversation.composer.dock');
    });
  });
});
