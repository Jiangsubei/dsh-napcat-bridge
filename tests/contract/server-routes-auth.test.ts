import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  IconChevronDownOutlineMedium: () => null,
  IconChevronDownOutlineRegular: () => null,
}));

import {
  registerConfigRoute,
  CONFIG_ROUTE_PATH,
} from '../../src/server/routes.js';
import { BridgeConfigSchema } from '../../src/config/schema.js';
import type { BridgePluginConfig } from '../../src/types/index.js';

function createMockReq(method: string, body?: any): IncomingMessage {
  const req = new EventEmitter() as any;
  req.method = method;
  req.headers = {
    'content-type': 'application/json',
    host: '127.0.0.1:8080',
    cookie: 'dsh_session=test',
  };
  process.nextTick(() => {
    if (body !== undefined) {
      req.emit('data', Buffer.from(JSON.stringify(body)));
    }
    req.emit('end');
  });
  return req;
}

function createMockRes(): {
  res: ServerResponse;
  getResult: () => Promise<{ status: number; headers: any; body: any }>;
} {
  const res = new EventEmitter() as any;
  let statusCode = 200;
  let headers: any = {};
  const chunks: Buffer[] = [];
  let isFinished = false;

  res.writeHead = vi.fn((status: number, h?: any) => {
    statusCode = status;
    if (h) headers = { ...headers, ...h };
    return res;
  });

  res.end = vi.fn((data?: any) => {
    if (data) chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
    isFinished = true;
    res.emit('finish');
    return res;
  });

  const parseResult = () => {
    const text = Buffer.concat(chunks).toString('utf8');
    let body: any = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { status: statusCode, headers, body };
  };

  const getResult = () =>
    new Promise<{ status: number; headers: any; body: any }>((resolve) => {
      if (isFinished) {
        resolve(parseResult());
        return;
      }
      res.on('finish', () => {
        resolve(parseResult());
      });
    });

  return { res, getResult };
}

describe('契约测试: 配置路由宿主身份认证门控 (Host Connection Authentication Fence - 严格 Fail-Closed)', () => {
  it('当 ctx.connection 存在且 requestRejection 返回 401 时，GET 请求直接返回 401 Unauthorized，不读取配置', async () => {
    let handler: any;
    const requestRejectionMock = vi.fn().mockReturnValue(401);
    const mockCtx: any = {
      get: vi.fn((name) => {
        if (name === 'webServer') return { register: (r: any) => { handler = r.handler; return () => {}; } };
        if (name === 'connection') return { requestRejection: requestRejectionMock };
        return undefined;
      }),
      inject: vi.fn(),
    };

    const cfgGetter = vi.fn(() => ({} as BridgePluginConfig));
    registerConfigRoute(mockCtx, cfgGetter, async () => {});

    const req = createMockReq('GET');
    const { res, getResult } = createMockRes();

    await handler(req, res);
    const result = await getResult();

    expect(requestRejectionMock).toHaveBeenCalledWith(req);
    expect(result.status).toBe(401);
    expect(result.body.ok).toBe(false);
    expect(result.body.error).toBe('Unauthorized');
    expect(cfgGetter).not.toHaveBeenCalled();
  });

  it('当 ctx.connection 存在且 requestRejection 返回 403 时，POST 请求直接返回 403 Forbidden，不保存配置且不触发热对齐', async () => {
    let handler: any;
    const requestRejectionMock = vi.fn().mockReturnValue(403);
    const mutateMock = vi.fn();
    const mockCtx: any = {
      get: vi.fn((name) => {
        if (name === 'webServer') return { register: (r: any) => { handler = r.handler; return () => {}; } };
        if (name === 'connection') return { requestRejection: requestRejectionMock };
        if (name === 'settings') return { mutate: mutateMock };
        return undefined;
      }),
      inject: vi.fn(),
    };

    const queueReconcileMock = vi.fn();
    registerConfigRoute(mockCtx, () => ({} as BridgePluginConfig), queueReconcileMock);

    const req = createMockReq('POST', { ws_port: 9999 });
    const { res, getResult } = createMockRes();

    await handler(req, res);
    const result = await getResult();

    expect(requestRejectionMock).toHaveBeenCalledWith(req);
    expect(result.status).toBe(403);
    expect(result.body.ok).toBe(false);
    expect(result.body.error).toBe('Forbidden');
    expect(mutateMock).not.toHaveBeenCalled();
    expect(queueReconcileMock).not.toHaveBeenCalled();
  });

  it('当 ctx.connection 存在且 requestRejection 返回 undefined 时，放行 GET 与 POST 请求', async () => {
    let handler: any;
    const requestRejectionMock = vi.fn().mockReturnValue(undefined);
    const mutateMock = vi.fn();
    const mockCtx: any = {
      get: vi.fn((name) => {
        if (name === 'webServer') return { register: (r: any) => { handler = r.handler; return () => {}; } };
        if (name === 'connection') return { requestRejection: requestRejectionMock };
        if (name === 'settings') return { mutate: mutateMock };
        return undefined;
      }),
      inject: vi.fn(),
    };

    const queueReconcileMock = vi.fn();
    registerConfigRoute(mockCtx, () => ({ ws_port: 8080, ws_token: 'test-token' } as BridgePluginConfig), queueReconcileMock);

    // 验证 GET 放行
    const reqGet = createMockReq('GET');
    const { res: resGet, getResult: getResultGet } = createMockRes();
    await handler(reqGet, resGet);
    const resGetResult = await getResultGet();
    expect(resGetResult.status).toBe(200);
    expect(resGetResult.body.ok).toBe(true);

    // 验证 POST 放行
    const reqPost = createMockReq('POST', { ws_port: 8081, ws_token: 'new-valid-token' });
    const { res: resPost, getResult: getResultPost } = createMockRes();
    await handler(reqPost, resPost);
    const resPostResult = await getResultPost();
    expect(resPostResult.status).toBe(200);
    expect(resPostResult.body.ok).toBe(true);
    expect(queueReconcileMock).toHaveBeenCalled();
  });

  it('严格 Fail-Closed: 当 ctx.connection 不存在（未注入认证服务）时，坚决拦截并响应 403 Forbidden', async () => {
    let handler: any;
    const mockCtx: any = {
      get: vi.fn((name) => {
        if (name === 'webServer') return { register: (r: any) => { handler = r.handler; return () => {}; } };
        return undefined;
      }),
      inject: vi.fn(),
    };

    registerConfigRoute(mockCtx, () => ({ ws_port: 8080 } as BridgePluginConfig), async () => {});

    const req = createMockReq('GET');
    const { res, getResult } = createMockRes();

    await handler(req, res);
    const result = await getResult();

    expect(result.status).toBe(403);
    expect(result.body.ok).toBe(false);
    expect(result.body.error).toContain('Forbidden');
  });

  it('Cordis 契约验证: 直接访问 ctx.connection 抛出 without inject 异常时，优先走 ctx.get("connection") 成功放行', async () => {
    let handler: any;
    const mockConnection = {
      requestRejection: vi.fn(() => undefined),
    };
    const mockCtx: any = {
      get: vi.fn((name) => {
        if (name === 'webServer') return { register: (r: any) => { handler = r.handler; return () => {}; } };
        if (name === 'connection') return mockConnection;
        return undefined;
      }),
      inject: vi.fn(),
    };
    // 模拟 Cordis Proxy 对未 inject 属性访问抛出异常的行为
    Object.defineProperty(mockCtx, 'connection', {
      get() {
        throw new Error('cannot get property "connection" without inject');
      },
    });

    registerConfigRoute(mockCtx, () => ({ ws_port: 8080, ws_token: 'valid-token' } as BridgePluginConfig), async () => {});

    const req = createMockReq('GET');
    const { res, getResult } = createMockRes();

    await handler(req, res);
    const result = await getResult();

    expect(result.status).toBe(200);
    expect(result.body.ok).toBe(true);
    expect(mockConnection.requestRejection).toHaveBeenCalled();
  });

  describe('ws_token 必填非空与持久化强校验契约', () => {
    it('Schema 兼容性: 缺失 ws_token 的历史老配置或空配置安全回退为默认空字符串，绝不抛出解析异常崩溃', () => {
      const parsed = BridgeConfigSchema({});
      const tokenVal = typeof parsed.ws_token?.get === 'function' ? parsed.ws_token.get() : parsed.ws_token;
      expect(tokenVal).toBe('');
    });

    it('POST /plugins/dsh-napcat-bridge/config: 提交空 ws_token 且现有无 token 时直接拒绝 (400 Bad Request)', async () => {
      let handler: any;
      const mockCtx: any = {
        get: vi.fn((name) => {
          if (name === 'webServer') return { register: (r: any) => { handler = r.handler; return () => {}; } };
          if (name === 'connection') return { requestRejection: () => undefined };
          return undefined;
        }),
        inject: vi.fn(),
      };

      // 现有配置中无 ws_token
      registerConfigRoute(mockCtx, () => ({ ws_port: 8080, ws_token: '' } as BridgePluginConfig), async () => {});

      const req = createMockReq('POST', { ws_port: 8080, ws_token: '' });
      const { res, getResult } = createMockRes();

      await handler(req, res);
      const result = await getResult();

      expect(result.status).toBe(400);
      expect(result.body.ok).toBe(false);
      expect(result.body.error).toContain('不能为空');
    });
  });
});
