/**
 * dsh-napcat-bridge: 黑话管理 HTTP REST API 路由
 * 为 Web UI 设置卡提供黑话列表获取、二次编辑与删除。
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Context } from '@deepseek-ai/cordis';
import type { SlangStorage } from '../slang/storage.js';
import { sendJson, parseJsonBody } from './routes.js';

export const SLANG_API_PATH = '/plugins/dsh-napcat-bridge/slang';

export interface SlangRoutesOptions {
  ctx: Context;
  storage: SlangStorage;
}

export function registerSlangRoutes(options: SlangRoutesOptions): () => void {
  const { ctx, storage } = options;
  let unregisterList: Array<() => void> = [];
  let isDisposed = false;

  // 1. GET /plugins/dsh-napcat-bridge/slang
  const slangCollectionHandler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const method = (req.method || 'GET').toUpperCase();
    if (method === 'GET') {
      try {
        const entries = await storage.getEntries();
        const stats = storage.getStats();
        sendJson(res, 200, {
          ok: true,
          entries,
          total: stats.total,
          char_count: stats.charCount,
          budget_chars: stats.budgetChars,
        });
      } catch (err: any) {
        sendJson(res, 500, { ok: false, error: err?.message || '获取黑话列表失败' });
      }
      return;
    }
    if (method === 'POST') {
      try {
        const body = (await parseJsonBody(req)) || {};
        const { term, definition, example } = body;
        if (!term || typeof term !== 'string' || !term.trim()) {
          sendJson(res, 400, { ok: false, error: '缺少词条名称 (term)' });
          return;
        }
        if (!definition || typeof definition !== 'string' || !definition.trim()) {
          sendJson(res, 400, { ok: false, error: '缺少核心释义 (definition)' });
          return;
        }
        const recordRes = await storage.recordEntry({
          term: term.trim(),
          definition: definition.trim(),
          example: typeof example === 'string' ? example.trim() : '',
        });
        sendJson(res, 200, {
          ok: true,
          entry: recordRes.entry,
          action: recordRes.action,
          char_count: recordRes.charCount,
          budget_chars: recordRes.budgetChars,
        });
      } catch (err: any) {
        sendJson(res, 400, { ok: false, error: err?.message || '添加词条失败' });
      }
      return;
    }
    sendJson(res, 405, { ok: false, error: 'Method Not Allowed' });
  };

  // 2. POST /plugins/dsh-napcat-bridge/slang/edit
  const editSlangHandler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const method = (req.method || 'POST').toUpperCase();
    if (method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'Method Not Allowed' });
      return;
    }
    try {
      const body = (await parseJsonBody(req)) || {};
      const { term, new_term, definition, example } = body;
      if (!term || typeof term !== 'string' || !term.trim()) {
        sendJson(res, 400, { ok: false, error: '缺少词条名称 (term)' });
        return;
      }
      try {
        const updated = await storage.editEntry(term, {
          newTerm: new_term,
          definition,
          example,
        });
        const stats = storage.getStats();
        sendJson(res, 200, {
          ok: true,
          entry: updated,
          char_count: stats.charCount,
          budget_chars: stats.budgetChars,
        });
      } catch (err: any) {
        if (err?.message?.includes('未找到')) {
          sendJson(res, 404, { ok: false, error: err.message });
        } else {
          sendJson(res, 400, { ok: false, error: err?.message || '编辑词条失败' });
        }
      }
    } catch (err: any) {
      sendJson(res, 500, { ok: false, error: err?.message || '服务器内部错误' });
    }
  };

  // 3. POST /plugins/dsh-napcat-bridge/slang/delete
  const deleteSlangHandler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const method = (req.method || 'POST').toUpperCase();
    if (method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'Method Not Allowed' });
      return;
    }
    try {
      const body = (await parseJsonBody(req)) || {};
      const { term } = body;
      if (!term || typeof term !== 'string' || !term.trim()) {
        sendJson(res, 400, { ok: false, error: '缺少词条名称 (term)' });
        return;
      }
      const deleted = await storage.deleteEntry(term);
      if (!deleted) {
        sendJson(res, 404, { ok: false, error: `未找到黑话词条 "${term}"` });
        return;
      }
      const stats = storage.getStats();
      sendJson(res, 200, {
        ok: true,
        char_count: stats.charCount,
        budget_chars: stats.budgetChars,
      });
    } catch (err: any) {
      sendJson(res, 500, { ok: false, error: err?.message || '删除黑话失败' });
    }
  };

  const doRegister = (server: any) => {
    if (isDisposed || !server || typeof server.register !== 'function') return;
    try {
      const u1 = server.register({ kind: 'exact', path: SLANG_API_PATH, handler: slangCollectionHandler });
      if (typeof u1 === 'function') unregisterList.push(u1);

      const u2 = server.register({ kind: 'exact', path: `${SLANG_API_PATH}/edit`, handler: editSlangHandler });
      if (typeof u2 === 'function') unregisterList.push(u2);

      const u3 = server.register({ kind: 'exact', path: `${SLANG_API_PATH}/delete`, handler: deleteSlangHandler });
      if (typeof u3 === 'function') unregisterList.push(u3);
    } catch {}
  };

  const directServer = typeof (ctx as any).get === 'function' ? (ctx as any).get('webServer') : undefined;
  if (directServer) {
    doRegister(directServer);
  } else if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (subCtx: any) => {
      const server = subCtx?.webServer ?? (typeof (ctx as any).get === 'function' ? (ctx as any).get('webServer') : undefined);
      doRegister(server);
    });
  }

  const dispose = () => {
    isDisposed = true;
    for (const unreg of unregisterList) {
      try {
        unreg();
      } catch {}
    }
    unregisterList = [];
  };

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      dispose();
    });
  }

  return dispose;
}
