/**
 * dsh-napcat-bridge Client WebUI Plugin Entry Point
 * Injects NapCat settings card into the DSH Web UI settings.plugin.item extension slot.
 */

import React from 'react';
import { NapCatSettingsCard } from './card.js';
import { SETTINGS_NAMESPACE } from '../constants/index.js';

export const name = 'dsh-napcat-bridge/client';
export const inject = ['slots', 'connection', 'settingsScope', 'sessions', 'workspaces'];

export const READONLY_STYLE_ID = 'dsh-napcat-readonly-style';
export const READONLY_BODY_ATTR = 'data-dsh-napcat-readonly';

/**
 * Build the card props bridge for one settings namespace.
 */
export function buildSettingsBridge(ctx: any, namespace: string = SETTINGS_NAMESPACE) {
  const describe = ctx.settingsScope?.describe?.() ?? null;
  const scope = ctx.settingsScope?.bind?.({ namespace }) ?? null;

  const readNamespace = () => {
    const view = describe?.getSnapshot?.().view;
    const row = view?.namespaces?.find((n: any) => n.ns === namespace);
    if (row) return row;
    const scopeSnap = scope?.getSnapshot?.();
    if (scopeSnap && scopeSnap.status !== 'unavailable') {
      return {
        value: scopeSnap.value ?? scopeSnap.user,
        revision: scopeSnap.revision,
        base: scopeSnap.base,
      };
    }
    return undefined;
  };

  return {
    get initialConfig() {
      return readNamespace()?.value ?? {};
    },
    get revision() {
      return readNamespace()?.revision ?? 0;
    },
    get baseDefaults() {
      return readNamespace()?.base ?? {};
    },
    get hasSecret() {
      return false;
    },
    onSaveSettings: async (
      values: Record<string, unknown>,
      options: { expectedRevision: number }
    ) => {
      const targetScope = scope ?? ctx.settingsScope?.bind?.({ namespace }) ?? ctx.settingsScope;
      if (!targetScope?.mutate) throw new Error('settings API 不可用');

      const ops = Object.entries(values ?? {}).map(([field, value]) => ({
        op: 'set' as const,
        path: [field],
        value,
      }));

      const latestRow = readNamespace();
      const expectedRevision =
        latestRow?.revision !== undefined ? latestRow.revision : options.expectedRevision;

      let res: any;
      try {
        res = await targetScope.mutate(ops, expectedRevision);
      } catch (err: any) {
        const errMsg = String(err?.message || '');
        if (
          errMsg.includes('changed since it was read') ||
          errMsg.includes('SETTINGS_CONFLICT') ||
          errMsg.includes('expected revision') ||
          errMsg.includes('conflict') ||
          err?.code === 'SETTINGS_CONFLICT'
        ) {
          const freshRow = readNamespace();
          const freshRev = freshRow?.revision ?? targetScope.getSnapshot?.().revision;
          if (freshRev !== undefined && freshRev !== expectedRevision) {
            res = await targetScope.mutate(ops, freshRev);
            if (res && typeof res === 'object') {
              const retryOk = res.ok ?? res.result?.ok;
              if (retryOk === false) {
                const retryErr = res.error || res.result?.error;
                throw new Error(retryErr?.message || 'settings.mutate 重试被拒绝');
              }
              return {
                revision:
                  res.value?.revision ?? res.result?.value?.revision ?? readNamespace()?.revision,
              };
            }
            const afterRetryRow = readNamespace();
            return { revision: afterRetryRow?.revision ?? targetScope.getSnapshot?.().revision };
          }
        }
        throw err;
      }

      // 1. If res returned an object (e.g. mock or RPC response)
      if (res && typeof res === 'object') {
        const isOk = res.ok ?? res.result?.ok;
        if (isOk === false) {
          const errMsg = String(res.error?.message || res.result?.error?.message || '');
          const isConflict =
            errMsg.includes('changed since it was read') ||
            errMsg.includes('SETTINGS_CONFLICT') ||
            errMsg.includes('expected revision') ||
            errMsg.includes('conflict') ||
            res.error?.code === 'SETTINGS_CONFLICT' ||
            res.result?.error?.code === 'SETTINGS_CONFLICT';

          if (isConflict || res.ok === false) {
            const freshRow = readNamespace();
            const freshRev = freshRow?.revision ?? targetScope.getSnapshot?.().revision;
            if (freshRev !== undefined && freshRev !== expectedRevision) {
              res = await targetScope.mutate(ops, freshRev);
            }
          }
        }

        const finalOk = res.ok ?? res.result?.ok;
        if (finalOk === false) {
          const err = res.error || res.result?.error;
          throw new Error(err?.message || 'settings.mutate 被拒绝');
        }

        const finalRev =
          res.value?.revision ?? res.result?.value?.revision ?? readNamespace()?.revision;
        return { revision: finalRev };
      }

      // 2. If res is undefined (official SettingsScopeController returns void)
      const afterRow = readNamespace();
      const afterRevision = afterRow?.revision ?? targetScope.getSnapshot?.().revision;

      if (afterRevision !== undefined && afterRevision > expectedRevision) {
        return { revision: afterRevision };
      }

      // Check if values landed
      const currentValues = afterRow?.value ?? targetScope.getSnapshot?.().value;
      const valuesLanded = Object.entries(values ?? {}).every(([k, v]) => {
        return JSON.stringify(currentValues?.[k]) === JSON.stringify(v);
      });

      if (valuesLanded) {
        return { revision: afterRevision };
      }

      // Values didn't land -> check if recover() reloaded a fresher revision
      if (afterRevision !== undefined && afterRevision !== expectedRevision) {
        const retryRes = await targetScope.mutate(ops, afterRevision);
        if (retryRes && typeof retryRes === 'object') {
          if (retryRes.ok ?? retryRes.result?.ok) {
            return {
              revision:
                retryRes.value?.revision ??
                retryRes.result?.value?.revision ??
                readNamespace()?.revision,
            };
          }
          throw new Error(
            retryRes.error?.message || retryRes.result?.error?.message || 'settings.mutate 重试被拒绝'
          );
        }
        const retryRow = readNamespace();
        const retryRev = retryRow?.revision ?? targetScope.getSnapshot?.().revision;
        const retryValues = retryRow?.value ?? targetScope.getSnapshot?.().value;
        const retryLanded = Object.entries(values ?? {}).every(([k, v]) => {
          return JSON.stringify(retryValues?.[k]) === JSON.stringify(v);
        });
        if (retryLanded || (retryRev !== undefined && retryRev > afterRevision)) {
          return { revision: retryRev };
        }
      }

      throw new Error('settings.mutate 被拒绝或保存冲突');
    },
  };
}

/**
 * 精准判断指定 Workspace 是否为插件专用的固定工作区：
 * 插件工作区固定为 title === 'NapCat' 且路径以 `.dsh/workspace/napcat` 结尾（规范化斜杠）。
 * 严禁使用 includes 模糊关键字匹配，防止误伤名称或路径包含 napcat 的其他工作区。
 */
export function isFixedNapCatWorkspace(ws: any): boolean {
  if (!ws || typeof ws !== 'object') return false;
  const title = typeof ws.title === 'string' ? ws.title.trim() : '';
  if (title !== 'NapCat') return false;
  const p = typeof ws.path === 'string' ? ws.path.replace(/\\/g, '/').toLowerCase() : '';
  return p.endsWith('/.dsh/workspace/napcat') || p === '.dsh/workspace/napcat';
}

export interface IsNapCatOptions {
  sessionId?: string;
  currentWorkspaceId?: string;
  workspaces?: any[] | { items?: any[] };
}

/**
 * 判定当前会话是否为插件创建的 QQ 只读会话：
 * 1. 插件只管自己创建的 QQ 会话（isQQSessionId，即 qq-group-、qq-user-、qq- 开头）才判定为 true，执行隐藏输入框；
 * 2. 欢迎页（sessionId 为空或 Hero 状态）必须判定为 false，保留原生输入框！
 * 3. 在 NapCat 工作区中由用户在 Web UI 新建的普通会话（session-uuid 等非 QQ 会话）必须判定为 false，允许用户在 Web 端发消息；
 * 4. 其他任何非 QQ 会话或工作区，一律判定为 false。
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
  useWorkspaces?: (selector?: (workspaces: any) => any) => any;
}

/**
 * QQ 会话只读输入框卡片隐藏控制器：
 * 当处于 QQ 会话或 NapCat 工作区时，仅隐藏 [data-composer-card] 输入框卡片容器（包含多行输入区、
 * 提示文案、附件/模式切换以及右侧模型切换与发送按钮），
 * 下方的监控指标行（位于 conversation.composer.dock，显示轮步/速率/Token/命中率）完全不受影响。
 * 离开 QQ 会话切换到其他常规工作区会话时，自动返回 null 恢复原生输入框。
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

  const workspacesData =
    typeof props?.useWorkspaces === 'function'
      ? props.useWorkspaces((w: any) => w)
      : undefined;

  const workspaces = Array.isArray(workspacesData)
    ? workspacesData
    : workspacesData?.items;

  const currentWorkspaceId = workspacesData?.current;

  const isReadonly = isNapCatWorkspaceOrSession({
    sessionId,
    currentWorkspaceId,
    workspaces,
  });

  if (!isReadonly) {
    return null;
  }

  return (
    <style
      data-dsh-napcat="hide-composer"
      dangerouslySetInnerHTML={{
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

  // 2. 监听 sessions 与 workspaces 响应式 Store
  const sessions = ctx.get ? ctx.get('sessions') : ctx.sessions;
  const workspaces = ctx.get ? ctx.get('workspaces') : ctx.workspaces;

  const updateReadonly = () => {
    try {
      const sessionsSnap = sessions?.list?.getSnapshot?.() ?? sessions?.getSnapshot?.();
      const workspacesSnap = workspaces?.list?.getSnapshot?.() ?? workspaces?.getSnapshot?.();

      const currentSessionId = sessionsSnap?.current;
      const currentWorkspaceId = workspacesSnap?.current;
      const workspaceItems =
        workspacesSnap?.items ?? (Array.isArray(workspacesSnap) ? workspacesSnap : undefined);

      const isReadonly = isNapCatWorkspaceOrSession({
        sessionId: currentSessionId,
        currentWorkspaceId,
        workspaces: workspaceItems,
      });

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
  let unsubWorkspaces: (() => void) | undefined;

  if (sessions?.list) {
    unsubSessions = subscribeList(sessions.list);
  } else if (sessions) {
    unsubSessions = subscribeList(sessions);
  }

  if (workspaces?.list) {
    unsubWorkspaces = subscribeList(workspaces.list);
  } else if (workspaces) {
    unsubWorkspaces = subscribeList(workspaces);
  }

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => {
      updateReadonly();
      return () => {
        unsubSessions?.();
        unsubWorkspaces?.();
        syncReadonlyAttribute(false);
      };
    }, 'dsh-napcat-bridge: sync readonly state');
  }

  if (!ctx?.slots?.inject) return;

  // 3. 注册设置卡片
  ctx.slots.inject('settings.plugin.item', function* () {
    yield ctx.slots.register(
      {
        name: 'settings.plugin.item',
        key: 'dsh-napcat-bridge',
        inject: () => buildSettingsBridge(ctx, SETTINGS_NAMESPACE),
      },
      NapCatSettingsCard
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

export { NapCatSettingsCard };

