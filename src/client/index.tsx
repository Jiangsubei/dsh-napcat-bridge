/**
 * dsh-napcat-bridge Client WebUI Plugin Entry Point
 * Injects NapCat settings card into the DSH Web UI settings.plugin.item extension slot.
 */

import React from 'react';
import { NapCatSettingsSection, NapCatSettingsCard } from './card.js';

export const name = 'dsh-napcat-bridge';
export const inject = ['slots', 'sessions'];

export const READONLY_STYLE_ID = 'dsh-napcat-readonly-style';
export const READONLY_BODY_ATTR = 'data-dsh-napcat-readonly';

export interface IsNapCatOptions {
  sessionId?: string;
}

/**
 * 判定当前会话是否为插件创建的 QQ 只读会话：
 * 1. 插件只管自己创建的 QQ 会话（isQQSessionId，即 qq-group-、qq-user-、qq- 开头）才判定为 true，执行隐藏输入框；
 * 2. 欢迎页（sessionId 为空或 Hero 状态）必须判定为 false，保留原生输入框！
 * 3. 在 NapCat 工作区中由用户在 Web UI 新建的普通会话（session-uuid 等非 QQ 会话）必须判定为 false，允许用户在 Web 端发消息；
 * 4. 其他任何非 QQ 会话或工作区，一律判定为 false。
 *
 * 注：本判定**只依据会话 ID**，不依赖工作区（workspaces 维度已按最终结论废弃：欢迎页与 Web 端
 * 新建会话必须保留原生输入框）。若后续要重新引入工作区维度，请先阅读
 * `docs/DSH-0.1.5-rc.1升级全量修改适配方案.md` 的「最终结论更正」一节，严禁再用 includes 模糊匹配。
 */
export function isNapCatWorkspaceOrSession(options: IsNapCatOptions): boolean {
  const { sessionId } = options;
  if (!sessionId || typeof sessionId !== 'string') {
    return false;
  }
  return isQQSessionId(sessionId);
}

/**
 * 向全局 document.head 注入只读样式表规则：
 * 当 body 携带 data-dsh-napcat-readonly="true" 时，彻底隐藏 [data-composer-card] 大卡片，
 * 而下方的监控栏指标（轮数/步数/速率/Token/缓存命中率）正常保留展示。
 */
export function ensureReadonlyStyle(): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  let style = document.getElementById(READONLY_STYLE_ID);
  if (!style) {
    style = document.createElement('style');
    style.id = READONLY_STYLE_ID;
    style.textContent = `
body[${READONLY_BODY_ATTR}="true"] [data-composer-card] {
  display: none !important;
}
`;
    document.head.appendChild(style);
  }
  return style;
}

/**
 * 同步切换 body 上的只读标记属性
 */
export function syncReadonlyAttribute(readonly: boolean): void {
  if (typeof document === 'undefined') return;
  if (readonly) {
    ensureReadonlyStyle();
    document.body.setAttribute(READONLY_BODY_ATTR, 'true');
  } else {
    document.body.removeAttribute(READONLY_BODY_ATTR);
  }
}

/**
 * 判断指定 Session ID 是否属于 QQ 桥接会话
 */
export function isQQSessionId(sessionId: unknown): boolean {
  if (typeof sessionId !== 'string' || !sessionId) return false;
  return (
    sessionId.startsWith('qq-group-') ||
    sessionId.startsWith('qq-user-') ||
    sessionId.startsWith('qq-')
  );
}

export interface QQComposerHiderProps {
  sessionId?: string;
  useSession?: (selector?: (session: any) => any) => any;
  useConversation?: (selector?: (conv: any) => any) => any;
}

/**
 * QQ 会话只读输入框卡片隐藏控制器：
 * 仅当处于**插件创建的 QQ 会话**时，隐藏 [data-composer-card] 输入框卡片容器（包含多行输入区、
 * 提示文案、附件/模式切换以及右侧模型切换与发送按钮），
 * 下方的监控指标行（位于 conversation.composer.dock，显示轮步/速率/Token/命中率）完全不受影响。
 * 欢迎页（Hero）、NapCat 工作区内由 Web 端新建的普通会话、以及其他常规会话一律返回 null 恢复原生输入框。
 */
export function QQComposerHider(props: QQComposerHiderProps): React.JSX.Element | null {
  const sessionId =
    (typeof props?.useSession === 'function'
      ? props.useSession((s: any) => s?.sessionId ?? s?.id)
      : undefined) ??
    props?.sessionId ??
    (typeof props?.useConversation === 'function'
      ? props.useConversation((c: any) => c?.sessionId ?? c?.id)
      : undefined);

  const isReadonly = isNapCatWorkspaceOrSession({ sessionId });

  if (!isReadonly) {
    return null;
  }

  return (
    <style
      data-dsh-napcat="hide-composer"
      dangerouslySetInnerHTML={{
        // 此处刻意不加 body[data-dsh-napcat-readonly="true"] 前缀（局部样式不带作用域）：
        // 组件本身只在 QQ 会话渲染、其余会话返回 null，因此该前提已由渲染条件保证；
        // 若后续改为无条件渲染，必须改回带 body 属性前缀的双重互锁写法（见 f8ea52d）。
        __html: `
[data-composer-card] {
  display: none !important;
}
`,
      }}
    />
  );
}

export function apply(ctx: any) {
  // 1. 客户端预热注入只读样式表
  ensureReadonlyStyle();

  // 2. 监听 sessions 响应式 Store（只读判定仅依赖当前会话 ID）
  const sessions = ctx.get ? ctx.get('sessions') : ctx.sessions;

  const updateReadonly = () => {
    try {
      const sessionsSnap = sessions?.list?.getSnapshot?.() ?? sessions?.getSnapshot?.();
      const currentSessionId = sessionsSnap?.current;

      const isReadonly = isNapCatWorkspaceOrSession({ sessionId: currentSessionId });

      syncReadonlyAttribute(isReadonly);
    } catch {
      // 防御性捕获
    }
  };

  updateReadonly();

  const subscribeList = (target: any) => {
    if (typeof target?.subscribe === 'function') {
      return target.subscribe(updateReadonly);
    }
    return undefined;
  };

  let unsubSessions: (() => void) | undefined;

  if (sessions?.list) {
    unsubSessions = subscribeList(sessions.list);
  } else if (sessions) {
    unsubSessions = subscribeList(sessions);
  }

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => {
      updateReadonly();
      return () => {
        unsubSessions?.();
        syncReadonlyAttribute(false);
      };
    }, 'dsh-napcat-bridge: sync readonly state');
  }

  if (!ctx?.slots?.inject) return;

  // 3. 注册 0.2.1 规范侧边栏独立设置板块 (settings.section)
  ctx.slots.inject('settings.section', function* () {
    yield ctx.slots.register(
      {
        name: 'settings.section',
        id: 'napcat',
        order: 55,
        locale: 'dsh-napcat-bridge',
        label: () => 'QQ NapCat',
        inject: () => ({}),
      },
      NapCatSettingsSection
    );
  });

  // 4. 注册 QQ 会话输入框卡片隐藏器（保留 dock 监控行）
  ctx.slots.inject('conversation.composer.dock', function* () {
    yield ctx.slots.register(
      {
        name: 'conversation.composer.dock',
        id: 'dsh-napcat-bridge-hide-composer',
        key: 'dsh-napcat-bridge-hide-composer',
        order: -100,
      },
      QQComposerHider
    );
  });
}

export { NapCatSettingsSection, NapCatSettingsCard };


