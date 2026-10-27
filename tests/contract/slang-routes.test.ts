/**
 * tests/contract/slang-routes.test.ts
 * 契约测试: 黑话管理 HTTP REST 接口 (Slang Routes Contract)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { EventEmitter } from 'node:events';
import { SlangStorage } from '../../src/slang/storage.js';
import { registerSlangRoutes, SLANG_API_PATH } from '../../src/server/slang-routes.js';

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

describe('契约测试: 黑话管理 HTTP REST 接口 (Slang Routes Contract)', () => {
  let tmpDir: string;
  let testFilePath: string;
  let storage: SlangStorage;
  let registeredRoutes: Map<string, any>;
  let mockServer: any;
  let mockCtx: any;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-slang-routes-'));
    testFilePath = path.join(tmpDir, 'slang.md');
    storage = new SlangStorage(testFilePath, 5000);
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
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it('契约 1: 成功注册黑话管理路由至 webServer', () => {
    const unregister = registerSlangRoutes({ ctx: mockCtx, storage });
    expect(mockServer.register).toHaveBeenCalled();
    expect(registeredRoutes.has(`exact:${SLANG_API_PATH}`)).toBe(true);
    expect(registeredRoutes.has(`exact:${SLANG_API_PATH}/edit`)).toBe(true);
    expect(registeredRoutes.has(`exact:${SLANG_API_PATH}/delete`)).toBe(true);

    unregister();
    expect(registeredRoutes.size).toBe(0);
  });

  it('契约 2: GET /plugins/dsh-napcat-bridge/slang 获取词条列表与用量统计', async () => {
    registerSlangRoutes({ ctx: mockCtx, storage });
    await storage.recordEntry({ term: '牢大', definition: '科比梗', example: '想你了' });
    await storage.recordEntry({ term: '开香槟', definition: '提前庆祝', example: '别开' });

    const handler = registeredRoutes.get(`exact:${SLANG_API_PATH}`);
    const req = createMockRequest('GET', SLANG_API_PATH);
    const res = new MockResponse();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.total).toBe(2);
    expect(body.entries).toHaveLength(2);
    expect(body.char_count).toBeGreaterThan(0);
    expect(body.budget_chars).toBe(5000);
  });

  it('契约 3: POST /plugins/dsh-napcat-bridge/slang/edit 编辑词条成功与失败校验', async () => {
    registerSlangRoutes({ ctx: mockCtx, storage });
    await storage.recordEntry({ term: '牢大', definition: '旧释义', example: '旧例句' });

    const handler = registeredRoutes.get(`exact:${SLANG_API_PATH}/edit`);

    // 成功编辑
    const reqSuccess = createMockRequest('POST', `${SLANG_API_PATH}/edit`, {
      term: '牢大',
      definition: '新释义',
      example: '新例句',
    });
    const resSuccess = new MockResponse();
    await handler(reqSuccess, resSuccess);

    expect(resSuccess.statusCode).toBe(200);
    const bodySuccess = JSON.parse(resSuccess.body);
    expect(bodySuccess.ok).toBe(true);
    expect(bodySuccess.entry.definition).toBe('新释义');

    // 缺少 term
    const reqNoTerm = createMockRequest('POST', `${SLANG_API_PATH}/edit`, { definition: 'xxx' });
    const resNoTerm = new MockResponse();
    await handler(reqNoTerm, resNoTerm);
    expect(resNoTerm.statusCode).toBe(400);

    // 词条不存在
    const reqNotFound = createMockRequest('POST', `${SLANG_API_PATH}/edit`, {
      term: '不存在的词',
      definition: 'xxx',
    });
    const resNotFound = new MockResponse();
    await handler(reqNotFound, resNotFound);
    expect(resNotFound.statusCode).toBe(404);
  });

  it('契约 4: POST /plugins/dsh-napcat-bridge/slang/delete 删除词条成功与失败校验', async () => {
    registerSlangRoutes({ ctx: mockCtx, storage });
    await storage.recordEntry({ term: '牢大', definition: '释义', example: '例句' });

    const handler = registeredRoutes.get(`exact:${SLANG_API_PATH}/delete`);

    // 缺少 term
    const reqNoTerm = createMockRequest('POST', `${SLANG_API_PATH}/delete`, {});
    const resNoTerm = new MockResponse();
    await handler(reqNoTerm, resNoTerm);
    expect(resNoTerm.statusCode).toBe(400);

    // 词条不存在
    const reqNotFound = createMockRequest('POST', `${SLANG_API_PATH}/delete`, { term: '不存在的词' });
    const resNotFound = new MockResponse();
    await handler(reqNotFound, resNotFound);
    expect(resNotFound.statusCode).toBe(404);

    // 成功删除
    const reqSuccess = createMockRequest('POST', `${SLANG_API_PATH}/delete`, { term: '牢大' });
    const resSuccess = new MockResponse();
    await handler(reqSuccess, resSuccess);
    expect(resSuccess.statusCode).toBe(200);
    const bodySuccess = JSON.parse(resSuccess.body);
    expect(bodySuccess.ok).toBe(true);

    const entries = await storage.getEntries();
    expect(entries).toHaveLength(0);
  });
});
