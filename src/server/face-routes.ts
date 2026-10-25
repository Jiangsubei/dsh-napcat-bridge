/**
 * dsh-napcat-bridge 表情包管理 HTTP REST API 路由
 * 为 Web UI 设置卡提供真实的表情包列表获取、大图预览、手动上传、二次编辑与软删除。
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type { Context } from '@deepseek-ai/cordis';
import type { MessageDatabase } from '../storage/database.js';
import type { BridgePluginConfig } from '../types/index.js';
import { sendJson, parseJsonBody } from './routes.js';
import { resolveDshPath } from '../utils/path.js';
import { DEFAULT_FACE_STORE_DIR } from '../constants/index.js';

export const FACES_API_PATH = '/plugins/dsh-napcat-bridge/faces';
export const FACES_PREVIEW_API_PREFIX = '/plugins/dsh-napcat-bridge/faces/preview';

export interface FaceRoutesOptions {
  ctx: Context;
  db: MessageDatabase;
  getConfig: () => BridgePluginConfig;
  dshHome: string;
}

export function registerFacesRoutes(options: FaceRoutesOptions): () => void {
  const { ctx, db, getConfig, dshHome } = options;
  let unregisterList: Array<() => void> = [];
  let isDisposed = false;

  const getStoreDir = (): string => {
    const cfg = getConfig();
    return resolveDshPath(dshHome, cfg.face_store_dir, DEFAULT_FACE_STORE_DIR);
  };

  /**
   * 1. 列表与上传路由处理器 (GET / POST /plugins/dsh-napcat-bridge/faces)
   */
  const facesCollectionHandler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const method = (req.method || 'GET').toUpperCase();

    // GET: 获取表情包列表
    if (method === 'GET') {
      try {
        const queryRes = db.queryFaces({ limit: 100, enabledOnly: true });
        const faces = queryRes.faces.map((f) => ({
          id: f.id,
          tags: f.tags,
          mood: f.mood,
          format: f.format,
          preview_url: `${FACES_PREVIEW_API_PREFIX}/${encodeURIComponent(f.id)}`,
          use_count: f.use_count,
          added_at: f.added_at,
        }));
        sendJson(res, 200, { ok: true, faces, total: queryRes.total });
      } catch (err: any) {
        sendJson(res, 500, { ok: false, error: err?.message || '获取表情包失败' });
      }
      return;
    }

    // POST: 上传新表情包
    if (method === 'POST') {
      try {
        const body = (await parseJsonBody(req)) || {};
        const { data, tags, mood, format: rawFormat } = body;

        if (!data || typeof data !== 'string') {
          sendJson(res, 400, { ok: false, error: '缺少图片数据 (Base64)' });
          return;
        }

        // 解析 Base64 数据
        const base64Clean = data.replace(/^data:image\/[a-zA-Z0-9+.-]+;base64,/, '');
        const fileBuf = Buffer.from(base64Clean, 'base64');
        if (fileBuf.length === 0) {
          sendJson(res, 400, { ok: false, error: '图片数据无效或为空' });
          return;
        }

        const md5 = crypto.createHash('md5').update(fileBuf).digest('hex');
        let ext = (typeof rawFormat === 'string' && rawFormat.trim()) ? rawFormat.trim().toLowerCase() : 'png';
        if (ext.startsWith('.')) ext = ext.slice(1);

        const storeDir = getStoreDir();
        fs.mkdirSync(storeDir, { recursive: true });
        const targetFile = path.join(storeDir, `${md5}.${ext}`);

        if (!fs.existsSync(targetFile)) {
          fs.writeFileSync(targetFile, fileBuf);
        }

        const cfg = getConfig();
        const faceId = `face_${md5.slice(0, 8)}`;
        const safeTags = Array.isArray(tags) ? tags.map((t: any) => String(t).trim()).filter(Boolean) : [];
        const safeMood = typeof mood === 'string' && mood.trim() ? mood.trim() : undefined;

        try {
          const inserted = db.insertFace(
            {
              id: faceId,
              file_path: targetFile,
              md5,
              source: 'manual',
              tags: safeTags,
              mood: safeMood,
              enabled: true,
              size: fileBuf.length,
              format: ext,
            },
            {
              max: cfg.face_store_max,
              evictPolicy: cfg.face_evict_policy,
            }
          );

          sendJson(res, 200, {
            ok: true,
            face: {
              id: inserted.id,
              tags: inserted.tags,
              mood: inserted.mood,
              format: inserted.format,
              preview_url: `${FACES_PREVIEW_API_PREFIX}/${encodeURIComponent(inserted.id)}`,
              duplicated: inserted.duplicated,
            },
          });
        } catch (dbErr: any) {
          // 容量上限配额拦截
          sendJson(res, 400, { ok: false, error: dbErr?.message || '表情库已达容量上限，已拒绝新增' });
        }
      } catch (err: any) {
        sendJson(res, 500, { ok: false, error: err?.message || '上传表情包异常' });
      }
      return;
    }

    sendJson(res, 405, { ok: false, error: 'Method Not Allowed' });
  };

  /**
   * 2. 编辑表情路由处理器 (POST /plugins/dsh-napcat-bridge/faces/edit)
   */
  const editFaceHandler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if ((req.method || 'GET').toUpperCase() !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'Method Not Allowed' });
      return;
    }

    try {
      const body = (await parseJsonBody(req)) || {};
      const { id, tags, mood } = body;
      if (!id || typeof id !== 'string') {
        sendJson(res, 400, { ok: false, error: '缺少表情 ID' });
        return;
      }

      const safeTags = Array.isArray(tags) ? tags.map((t: any) => String(t).trim()).filter(Boolean) : undefined;
      const safeMood = typeof mood === 'string' ? mood.trim() : undefined;

      const updated = db.updateFace(id.trim(), { tags: safeTags, mood: safeMood });
      if (!updated) {
        sendJson(res, 404, { ok: false, error: '表情未找到或已被物理清除' });
        return;
      }

      sendJson(res, 200, {
        ok: true,
        face: {
          id: updated.id,
          tags: updated.tags,
          mood: updated.mood,
          format: updated.format,
          preview_url: `${FACES_PREVIEW_API_PREFIX}/${encodeURIComponent(updated.id)}`,
        },
      });
    } catch (err: any) {
      sendJson(res, 500, { ok: false, error: err?.message || '编辑表情失败' });
    }
  };

  /**
   * 3. 删除表情路由处理器 (POST /plugins/dsh-napcat-bridge/faces/delete)
   */
  const deleteFaceHandler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if ((req.method || 'GET').toUpperCase() !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'Method Not Allowed' });
      return;
    }

    try {
      const body = (await parseJsonBody(req)) || {};
      const { id } = body;
      if (!id || typeof id !== 'string') {
        sendJson(res, 400, { ok: false, error: '缺少表情 ID' });
        return;
      }

      const success = db.deleteFace(id.trim());
      sendJson(res, 200, { ok: success });
    } catch (err: any) {
      sendJson(res, 500, { ok: false, error: err?.message || '删除表情失败' });
    }
  };

  /**
   * 4. 大图与缩略图预览文件流路由处理器 (GET /plugins/dsh-napcat-bridge/faces/preview/:id)
   */
  const previewImageHandler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if ((req.method || 'GET').toUpperCase() !== 'GET') {
      sendJson(res, 405, { ok: false, error: 'Method Not Allowed' });
      return;
    }

    try {
      const url = req.url || '';
      const prefix = FACES_PREVIEW_API_PREFIX;
      let rawId = '';
      if (url.startsWith(prefix)) {
        rawId = url.slice(prefix.length).replace(/^\/+/, '').split('?')[0];
      }
      const id = decodeURIComponent(rawId).trim();
      if (!id) {
        sendJson(res, 400, { ok: false, error: '未提供表情 ID' });
        return;
      }

      const face = db.getFaceById(id, { includeDeleted: true });
      if (!face || !face.file_path || !fs.existsSync(face.file_path)) {
        sendJson(res, 404, { ok: false, error: '表情图片文件不存在' });
        return;
      }

      const ext = path.extname(face.file_path).toLowerCase();
      let contentType = 'image/png';
      if (ext === '.jpg' || ext === '.jpeg') contentType = 'image/jpeg';
      else if (ext === '.gif') contentType = 'image/gif';
      else if (ext === '.webp') contentType = 'image/webp';
      else if (ext === '.svg') contentType = 'image/svg+xml';

      const stat = fs.statSync(face.file_path);
      res.writeHead(200, {
        'content-type': contentType,
        'content-length': stat.size,
        'cache-control': 'public, max-age=86400',
      });
      fs.createReadStream(face.file_path).pipe(res);
    } catch (err: any) {
      sendJson(res, 500, { ok: false, error: err?.message || '读取图片失败' });
    }
  };

  const doRegister = (server: any) => {
    if (isDisposed || !server || typeof server.register !== 'function') return;

    try {
      // 注册 /plugins/dsh-napcat-bridge/faces
      const unreg1 = server.register({
        kind: 'exact',
        path: FACES_API_PATH,
        handler: facesCollectionHandler,
      });
      if (typeof unreg1 === 'function') unregisterList.push(unreg1);

      // 注册 /plugins/dsh-napcat-bridge/faces/edit
      const unregEdit = server.register({
        kind: 'exact',
        path: `${FACES_API_PATH}/edit`,
        handler: editFaceHandler,
      });
      if (typeof unregEdit === 'function') unregisterList.push(unregEdit);

      // 注册 /plugins/dsh-napcat-bridge/faces/delete
      const unregDel = server.register({
        kind: 'exact',
        path: `${FACES_API_PATH}/delete`,
        handler: deleteFaceHandler,
      });
      if (typeof unregDel === 'function') unregisterList.push(unregDel);

      // 注册 /plugins/dsh-napcat-bridge/faces/preview (前缀匹配)
      const unregPreview = server.register({
        kind: 'prefix',
        path: FACES_PREVIEW_API_PREFIX,
        handler: previewImageHandler,
      });
      if (typeof unregPreview === 'function') unregisterList.push(unregPreview);
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
