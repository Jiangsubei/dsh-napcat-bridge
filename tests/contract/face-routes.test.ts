/**
 * tests/contract/face-routes.test.ts
 * 契约测试: 表情包管理 HTTP REST 接口 (Face Routes Contract)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { EventEmitter } from 'node:events';
import { MessageDatabase } from '../../src/storage/database.js';
import { registerFacesRoutes } from '../../src/server/face-routes.js';

class MockResponse extends EventEmitter {
  public statusCode: number = 200;
  public headers: Record<string, any> = {};
  public body: string = '';

  writeHead(status: number, headers: Record<string, any> = {}) {
    this.statusCode = status;
    this.headers = headers;
    return this;
  }

  write(chunk: any) {
    this.body += chunk.toString();
    return true;
  }

  end(data?: any) {
    if (data) {
      this.body += data.toString();
    }
    this.emit('finish');
    return this;
  }
}

function createMockRequest(method: string, url: string, bodyJson?: any): any {
  const req = new EventEmitter() as any;
  req.method = method;
  req.url = url;

  process.nextTick(() => {
    if (bodyJson !== undefined) {
      req.emit('data', Buffer.from(JSON.stringify(bodyJson)));
    }
    req.emit('end');
  });

  return req;
}

describe('契约测试: 表情包管理 HTTP REST 接口 (Face Routes Contract)', () => {
  let tmpDir: string;
  let db: MessageDatabase;
  let registeredRoutes: Map<string, any>;
  let mockServer: any;
  let mockCtx: any;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-face-routes-'));
    db = new MessageDatabase(path.join(tmpDir, 'test.sqlite'));
    registeredRoutes = new Map();

    mockServer = {
      register: vi.fn().mockImplementation(({ kind, path: routePath, handler }) => {
        registeredRoutes.set(`${kind}:${routePath}`, handler);
        return () => {
          registeredRoutes.delete(`${kind}:${routePath}`);
        };
      }),
    };

    mockCtx = {
      get: (name: string) => (name === 'webServer' ? mockServer : undefined),
    };
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('契约 1: 真实上传 Base64 图片 -> 文件落盘 -> 数据库入库', async () => {
    registerFacesRoutes({
      ctx: mockCtx,
      db,
      getConfig: () => ({ face_enabled: true, face_store_max: 10, face_evict_policy: 'evict_lru' }),
      dshHome: tmpDir,
    });

    const handler = registeredRoutes.get('exact:/plugins/dsh-napcat-bridge/faces');
    expect(handler).toBeDefined();

    // 1. 上传一张图片
    const fakeBase64 = Buffer.from('fake-image-png-binary-content').toString('base64');
    const req = createMockRequest('POST', '/plugins/dsh-napcat-bridge/faces', {
      data: fakeBase64,
      tags: ['猫猫', '喝水'],
      mood: '呆萌',
      format: 'png',
    });
    const res = new MockResponse();

    await handler(req, res);
    expect(res.statusCode).toBe(200);

    const data = JSON.parse(res.body);
    expect(data.ok).toBe(true);
    expect(data.face.id).toBeDefined();
    expect(data.face.tags).toEqual(['猫猫', '喝水']);
    expect(data.face.mood).toBe('呆萌');

    // 验证数据库真实存在
    const inDb = db.getFaceById(data.face.id);
    expect(inDb).toBeDefined();
    expect(fs.existsSync(inDb!.file_path)).toBe(true);

    // 2. GET 列表能够查询到该表情
    const getReq = createMockRequest('GET', '/plugins/dsh-napcat-bridge/faces');
    const getRes = new MockResponse();
    await handler(getReq, getRes);

    expect(getRes.statusCode).toBe(200);
    const listData = JSON.parse(getRes.body);
    expect(listData.ok).toBe(true);
    expect(listData.faces.length).toBe(1);
    expect(listData.faces[0].id).toBe(data.face.id);
    expect(listData.faces[0].preview_url).toContain(data.face.id);
  });

  it('契约 2: 编辑已有表情 tags 与 mood', async () => {
    registerFacesRoutes({
      ctx: mockCtx,
      db,
      getConfig: () => ({ face_enabled: true, face_store_max: 10 }),
      dshHome: tmpDir,
    });

    db.insertFace({
      id: 'face_edit_test',
      file_path: '/dummy.png',
      md5: 'md5_edit',
      source: 'manual',
      tags: ['旧标签'],
      mood: '旧情绪',
      enabled: true,
      size: 10,
      format: 'png',
    });

    const editHandler = registeredRoutes.get('exact:/plugins/dsh-napcat-bridge/faces/edit');
    expect(editHandler).toBeDefined();

    const req = createMockRequest('POST', '/plugins/dsh-napcat-bridge/faces/edit', {
      id: 'face_edit_test',
      tags: ['新标签A', '新标签B'],
      mood: '新情绪',
    });
    const res = new MockResponse();

    await editHandler(req, res);
    expect(res.statusCode).toBe(200);

    const data = JSON.parse(res.body);
    expect(data.ok).toBe(true);
    expect(data.face.tags).toEqual(['新标签A', '新标签B']);
    expect(data.face.mood).toBe('新情绪');

    const updated = db.getFaceById('face_edit_test');
    expect(updated?.tags).toEqual(['新标签A', '新标签B']);
  });

  it('契约 3: 删除表情 (软删除)', async () => {
    registerFacesRoutes({
      ctx: mockCtx,
      db,
      getConfig: () => ({ face_enabled: true }),
      dshHome: tmpDir,
    });

    db.insertFace({
      id: 'face_del_test',
      file_path: '/dummy.png',
      md5: 'md5_del',
      source: 'manual',
      tags: ['待删'],
      enabled: true,
      size: 10,
      format: 'png',
    });

    const deleteHandler = registeredRoutes.get('exact:/plugins/dsh-napcat-bridge/faces/delete');
    expect(deleteHandler).toBeDefined();

    const req = createMockRequest('POST', '/plugins/dsh-napcat-bridge/faces/delete', {
      id: 'face_del_test',
    });
    const res = new MockResponse();

    await deleteHandler(req, res);
    expect(res.statusCode).toBe(200);

    // 默认查询不可见
    expect(db.getFaceById('face_del_test')).toBeNull();
    // 软删除保留 7 天后悔期
    const raw = db.getFaceById('face_del_test', { includeDeleted: true });
    expect(raw?.deleted_at).toBeGreaterThan(0);
  });
});
