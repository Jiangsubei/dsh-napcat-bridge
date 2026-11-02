/**
 * dsh-napcat-bridge: 黑话管理 HTTP REST API 路由
 * 为 Web UI 设置卡提供黑话列表获取、二次编辑与删除。
 * 遵循四参数体系：标题 (term) + 标签 (tags) + 释义 (definition) + 例句 (example)。
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Context } from '@deepseek-ai/cordis';
import type { SlangStorage } from '../slang/storage.js';
import { sendJson, parseJsonBody, assertHostAuthentication } from './routes.js';

export const SLANG_API_PATH = '/plugins/dsh-napcat-bridge/slang';

export interface SlangRoutesOptions {
  ctx: Context;
  storage: SlangStorage;
}

export function registerSlangRoutes(options: SlangRoutesOptions): () => void {
  const { ctx, storage } = options;
  let unregisterList: Array<() => void> = [];
  let isDisposed = false;

  // 1. GET & POST /plugins/dsh-napcat-bridge/slang
  const slangCollectionHandler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // 宿主身份认证强门控 (Fail-Closed)
    if (!assertHostAuthentication(ctx, req, res)) {
      return;
    }

    const method = (req.method || 'GET').toUpperCase();
    if (method === 'GET') {
      try {
        const entries = await storage.getEntries();
        const stats = storage.getStats();
        sendJson(res, 200, {
          ok: true,
          entries,
          total: stats.total,
          max_entries: stats.maxEntries,
          evict_policy: stats.evictPolicy,
        });
      } catch (err: any) {
        sendJson(res, 500, { ok: false, error: err?.message || '获取黑话列表失败' });
      }
      return;
    }
    if (method === 'POST') {
      try {
        const body = (await parseJsonBody(req)) || {};
        const { term, tags, definition, example } = body;
        if (!term || typeof term !== 'string' || !term.trim()) {
          sendJson(res, 400, { ok: false, error: '缺少词条名称 (term)' });
          return;
        }
        if (!tags || typeof tags !== 'string' || !tags.trim()) {
          sendJson(res, 400, { ok: false, error: '缺少简要概述标签 (tags)' });
          return;
        }
        if (!definition || typeof definition !== 'string' || !definition.trim()) {
          sendJson(res, 400, { ok: false, error: '缺少核心释义 (definition)' });
          return;
        }
        if (!example || typeof example !== 'string' || !example.trim()) {
          sendJson(res, 400, { ok: false, error: '缺少典型例句 (example)' });
          return;
        }

        const recordRes = await storage.recordEntry({
          term: term.trim(),
          tags: tags.trim(),
          definition: definition.trim(),
          example: example.trim(),
        });
        sendJson(res, 200, {
          ok: true,
          entry: recordRes.entry,
          action: recordRes.action,
          total: recordRes.total,
          max_entries: recordRes.maxEntries,
          evicted_term: recordRes.evictedTerm,
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
    // 宿主身份认证强门控 (Fail-Closed)
    if (!assertHostAuthentication(ctx, req, res)) {
      return;
    }

    const method = (req.method || 'POST').toUpperCase();
    if (method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'Method Not Allowed' });
      return;
    }
    try {
      const body = (await parseJsonBody(req)) || {};
      const { term, new_term, tags, definition, example } = body;
      if (!term || typeof term !== 'string' || !term.trim()) {
        sendJson(res, 400, { ok: false, error: '缺少词条名称 (term)' });
        return;
      }

      try {
        const updated = await storage.editEntry(term, {
          new_term,
          tags: typeof tags === 'string' ? tags.trim() : undefined,
          definition,
          example,
        });
        const stats = storage.getStats();
        sendJson(res, 200, {
          ok: true,
          entry: updated,
          total: stats.total,
          max_entries: stats.maxEntries,
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
    // 宿主身份认证强门控 (Fail-Closed)
    if (!assertHostAuthentication(ctx, req, res)) {
      return;
    }

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
        total: stats.total,
        max_entries: stats.maxEntries,
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
    ctx.inject(['webServer'], (injectedCtx: any) => {
      const s = typeof injectedCtx.get === 'function' ? injectedCtx.get('webServer') : undefined;
      if (s) doRegister(s);
    });
  }

  return () => {
    isDisposed = true;
    for (const unreg of unregisterList) {
      try {
        unreg();
      } catch {}
    }
    unregisterList = [];
  };
}
