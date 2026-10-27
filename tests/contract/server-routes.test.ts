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
  DEFAULT_BASE_CONFIG,
  sendJson,
  parseJsonBody,
} from '../../src/server/routes.js';
import type { BridgePluginConfig } from '../../src/types/index.js';

function createMockReq(method: string, body?: any): IncomingMessage {
  const req = new EventEmitter() as any;
  req.method = method;
  req.headers = { 'content-type': 'application/json' };
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

describe('契约测试: 服务端配置 REST API 路由 (/plugins/dsh-napcat-bridge/config)', () => {
  describe('1. 路由注册与生命周期反注册契约', () => {
    it('正确向 ctx.webServer 注册 exact 路径 /plugins/dsh-napcat-bridge/config (直接获取模式)', () => {
      const registerMock = vi.fn();
      const mockCtx: any = {
        get: vi.fn((name) => (name === 'webServer' ? { register: registerMock } : undefined)),
        inject: vi.fn(),
      };

      expect(CONFIG_ROUTE_PATH).toBe('/plugins/dsh-napcat-bridge/config');

      registerConfigRoute(mockCtx, () => ({} as BridgePluginConfig), async () => {});

      expect(registerMock).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'exact',
          path: CONFIG_ROUTE_PATH,
          handler: expect.any(Function),
        })
      );
    });

    it('支持在 webServer 未就绪时通过 ctx.inject 延迟注册 (注入依赖模式)', () => {
      const registerMock = vi.fn();
      let injectCallback: ((subCtx: any) => void) | undefined;
      const mockCtx: any = {
        get: vi.fn(() => undefined),
        inject: vi.fn((deps, cb) => {
          expect(deps).toContain('webServer');
          injectCallback = cb;
        }),
      };

      registerConfigRoute(mockCtx, () => ({} as BridgePluginConfig), async () => {});

      expect(registerMock).not.toHaveBeenCalled();
      expect(mockCtx.inject).toHaveBeenCalled();

      // 模拟 webServer 加载完成触发 inject 回调
      injectCallback?.({ webServer: { register: registerMock } });
      expect(registerMock).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'exact',
          path: CONFIG_ROUTE_PATH,
          handler: expect.any(Function),
        })
      );
    });

    it('调用返回的清理函数可注销路由，避免内存泄漏', () => {
      const unregisterMock = vi.fn();
      const mockCtx: any = {
        get: vi.fn((name) =>
          name === 'webServer'
            ? {
                register: vi.fn(() => unregisterMock),
              }
            : undefined
        ),
        inject: vi.fn(),
      };

      const unregister = registerConfigRoute(mockCtx, () => ({} as BridgePluginConfig), async () => {});
      expect(unregisterMock).not.toHaveBeenCalled();

      unregister();
      expect(unregisterMock).toHaveBeenCalled();
    });
  });

  describe('2. GET /plugins/dsh-napcat-bridge/config 配置读取与脱敏保护', () => {
    it('返回 200 JSON，ws_token 存在时 hasSecret 为 true 且 ws_token 必须脱敏为空字符串', async () => {
      let handler: any;
      const mockCtx: any = {
        get: vi.fn((name) =>
          name === 'webServer'
            ? {
                register: (route: any) => {
                  handler = route.handler;
                  return () => {};
                },
              }
            : undefined
        ),
        inject: vi.fn(),
      };

      const currentCfg: BridgePluginConfig = {
        ws_port: 8080,
        ws_token: 'secret-token-super-confidential',
        bot_qq: '12345678',
        admins: ['10001', '10002'],
        aliases: ['小助手'],
        image_ttl_days: 7,
        persona: '测试人格设定',
        proactive_reply_enabled: true,
      };

      registerConfigRoute(mockCtx, () => currentCfg, async () => {});

      const req = createMockReq('GET');
      const { res, getResult } = createMockRes();

      await handler(req, res);
      const result = await getResult();

      expect(result.status).toBe(200);
      expect(result.body.ok).toBe(true);
      expect(result.body.hasSecret).toBe(true);
      expect(result.body.config.ws_port).toBe(8080);
      expect(result.body.config.ws_token).toBe(''); // 绝对脱敏保护，绝不向前端泄露明文
      expect(result.body.config.bot_qq).toBe('12345678');
      expect(result.body.config.admins).toEqual(['10001', '10002']);
      expect(result.body.config.image_ttl_days).toBe(7);
      expect(result.body.baseDefaults).toEqual(DEFAULT_BASE_CONFIG);
      expect(result.body.baseDefaults.ws_port).toBe(8080);
    });

    it('当 ws_token 为空或未设置时，hasSecret 为 false 且 ws_token 为空字符串', async () => {
      let handler: any;
      const mockCtx: any = {
        get: vi.fn((name) =>
          name === 'webServer'
            ? {
                register: (route: any) => {
                  handler = route.handler;
                  return () => {};
                },
              }
            : undefined
        ),
        inject: vi.fn(),
      };

      const currentCfg: BridgePluginConfig = {
        ws_port: 8080,
        ws_token: '',
        bot_qq: '12345678',
      };

      registerConfigRoute(mockCtx, () => currentCfg, async () => {});

      const req = createMockReq('GET');
      const { res, getResult } = createMockRes();

      await handler(req, res);
      const result = await getResult();

      expect(result.status).toBe(200);
      expect(result.body.ok).toBe(true);
      expect(result.body.hasSecret).toBe(false);
      expect(result.body.config.ws_token).toBe('');
    });
  });

  describe('3. POST /plugins/dsh-napcat-bridge/config 配置保存、防误清空与热对齐', () => {
    it('接收更新 payload，在 ws_token 为空或未传时自动保留既有 Token，写入 settings 并触发热对齐', async () => {
      let handler: any;
      const mutateMock = vi.fn().mockResolvedValue({ ok: true });
      const mockCtx: any = {
        get: vi.fn((name) => {
          if (name === 'webServer') {
            return {
              register: (route: any) => {
                handler = route.handler;
                return () => {};
              },
            };
          }
          if (name === 'settings') {
            return { mutate: mutateMock };
          }
          return undefined;
        }),
        inject: vi.fn(),
      };

      let currentCfg: BridgePluginConfig = {
        ws_port: 8080,
        ws_token: 'existing_valuable_token_666',
        bot_qq: '12345678',
      };

      const reconcileMock = vi.fn().mockImplementation(async (next) => {
        if (next) currentCfg = { ...next };
      });

      registerConfigRoute(mockCtx, () => currentCfg, reconcileMock);

      // 模拟前端保存：ws_token 留空（防误清空契约）
      const updatePayload: Partial<BridgePluginConfig> = {
        ws_port: 8081,
        ws_token: '', // 前端留空，代表保留原 secret
        bot_qq: '88888888',
        proactive_reply_enabled: true,
      };

      const req = createMockReq('POST', updatePayload);
      const { res, getResult } = createMockRes();

      await handler(req, res);
      const result = await getResult();

      expect(result.status).toBe(200);
      expect(result.body.ok).toBe(true);
      expect(result.body.hasSecret).toBe(true);

      // 验证热对齐回调被触发，且正确保留了既有 ws_token
      expect(reconcileMock).toHaveBeenCalled();
      const passedToReconcile = reconcileMock.mock.calls[0][0];
      expect(passedToReconcile.ws_port).toBe(8081);
      expect(passedToReconcile.ws_token).toBe('existing_valuable_token_666'); // 防误清空！
      expect(passedToReconcile.bot_qq).toBe('88888888');
      expect(passedToReconcile.proactive_reply_enabled).toBe(true);

      // 验证 settings.mutate 被调用以持久化
      expect(mutateMock).toHaveBeenCalled();
    });

    it('当显式提交新的 ws_token 时，正确更新并持久化新 Token', async () => {
      let handler: any;
      const mutateMock = vi.fn().mockResolvedValue({ ok: true });
      const mockCtx: any = {
        get: vi.fn((name) => {
          if (name === 'webServer') {
            return {
              register: (route: any) => {
                handler = route.handler;
                return () => {};
              },
            };
          }
          if (name === 'settings') {
            return { mutate: mutateMock };
          }
          return undefined;
        }),
        inject: vi.fn(),
      };

      let currentCfg: BridgePluginConfig = {
        ws_port: 8080,
        ws_token: 'old_token',
      };

      const reconcileMock = vi.fn().mockImplementation(async (next) => {
        if (next) currentCfg = { ...next };
      });

      registerConfigRoute(mockCtx, () => currentCfg, reconcileMock);

      const updatePayload: Partial<BridgePluginConfig> = {
        ws_port: 8080,
        ws_token: 'new_custom_token_999',
      };

      const req = createMockReq('POST', updatePayload);
      const { res, getResult } = createMockRes();

      await handler(req, res);
      const result = await getResult();

      expect(result.status).toBe(200);
      expect(result.body.ok).toBe(true);
      expect(result.body.hasSecret).toBe(true);

      expect(reconcileMock).toHaveBeenCalled();
      const passedToReconcile = reconcileMock.mock.calls[0][0];
      expect(passedToReconcile.ws_token).toBe('new_custom_token_999');
    });

    it('兼容支持 settings.update 持久化通道', async () => {
      let handler: any;
      const updateMock = vi.fn().mockResolvedValue({ ok: true });
      const mockCtx: any = {
        get: vi.fn((name) => {
          if (name === 'webServer') {
            return {
              register: (route: any) => {
                handler = route.handler;
                return () => {};
              },
            };
          }
          if (name === 'settings') {
            return { update: updateMock }; // 仅有 update 方法
          }
          return undefined;
        }),
        inject: vi.fn(),
      };

      const reconcileMock = vi.fn().mockResolvedValue(undefined);
      registerConfigRoute(mockCtx, () => ({} as BridgePluginConfig), reconcileMock);

      const req = createMockReq('POST', { ws_port: 9000 });
      const { res, getResult } = createMockRes();

      await handler(req, res);
      const result = await getResult();

      expect(result.status).toBe(200);
      expect(result.body.ok).toBe(true);
      expect(updateMock).toHaveBeenCalled();
    });

    it('当持久化 settings.mutate 抛出异常时，正确记录日志并返回 HTTP 500 与错误消息', async () => {
      let handler: any;
      const errorMock = vi.fn();
      const mockCtx: any = {
        logger: () => ({ error: errorMock, info: vi.fn(), warn: vi.fn() }),
        get: vi.fn((name) => {
          if (name === 'webServer') {
            return {
              register: (route: any) => {
                handler = route.handler;
                return () => {};
              },
            };
          }
          if (name === 'settings') {
            return {
              mutate: vi.fn().mockRejectedValue(new Error('Config field "invalid_field" is not volatile')),
            };
          }
          return undefined;
        }),
        inject: vi.fn(),
      };

      registerConfigRoute(mockCtx, () => ({} as BridgePluginConfig), async () => {});

      const req = createMockReq('POST', { ws_port: 9000 });
      const { res, getResult } = createMockRes();

      await handler(req, res);
      const result = await getResult();

      expect(result.status).toBe(500);
      expect(result.body.ok).toBe(false);
      expect(result.body.error).toContain('is not volatile');
      expect(errorMock).toHaveBeenCalledWith(
        expect.stringContaining('持久化配置到 settings 失败'),
        expect.any(Error)
      );
    });

    it('保存包含 bot_qq 的配置后，后续 GET 请求能正确读取更新后的 bot_qq 与其他字段（防恢复默认值）', async () => {
      let handler: any;
      let persistedSettings: Record<string, unknown> = {};
      const mutateMock = vi.fn().mockImplementation(async (_ns: string, ops: any[]) => {
        for (const op of ops) {
          if (op.op === 'set') {
            persistedSettings[op.path[0]] = op.value;
          }
        }
        return { ok: true };
      });

      let currentConfig: BridgePluginConfig = {
        ws_port: 8080,
        bot_qq: '',
        persona: '',
      };

      const mockCtx: any = {
        get: vi.fn((name) => {
          if (name === 'webServer') {
            return {
              register: (route: any) => {
                handler = route.handler;
                return () => {};
              },
            };
          }
          if (name === 'settings') {
            return { mutate: mutateMock };
          }
          return undefined;
        }),
        inject: vi.fn(),
      };

      const reconcileMock = vi.fn().mockImplementation(async (payload) => {
        currentConfig = { ...currentConfig, ...payload };
      });

      registerConfigRoute(mockCtx, () => currentConfig, reconcileMock);

      // 1. 模拟保存包含 bot_qq、persona 与 ws_port 的修改
      const saveReq = createMockReq('POST', {
        ws_port: 9876,
        bot_qq: '1234567890',
        persona: '猫娘助手',
      });
      const { res: saveRes, getResult: getSaveResult } = createMockRes();
      await handler(saveReq, saveRes);
      const saveResult = await getSaveResult();

      expect(saveResult.status).toBe(200);
      expect(saveResult.body.ok).toBe(true);
      expect(mutateMock).toHaveBeenCalled();
      expect(persistedSettings.bot_qq).toBe('1234567890');
      expect(persistedSettings.persona).toBe('猫娘助手');

      // 2. 模拟面板关闭后重新打开发送 GET 请求读取配置
      const readReq = createMockReq('GET');
      const { res: readRes, getResult: getReadResult } = createMockRes();
      await handler(readReq, readRes);
      const readResult = await getReadResult();

      expect(readResult.status).toBe(200);
      expect(readResult.body.ok).toBe(true);
      expect(readResult.body.config.bot_qq).toBe('1234567890');
      expect(readResult.body.config.ws_port).toBe(9876);
      expect(readResult.body.config.persona).toBe('猫娘助手');
    });
  });

  describe('4. HTTP 协议规范与工具函数契约', () => {
    it('不支持的 HTTP 方法返回 405 Method Not Allowed', async () => {
      let handler: any;
      const mockCtx: any = {
        get: vi.fn((name) =>
          name === 'webServer'
            ? {
                register: (route: any) => {
                  handler = route.handler;
                  return () => {};
                },
              }
            : undefined
        ),
        inject: vi.fn(),
      };

      registerConfigRoute(mockCtx, () => ({} as BridgePluginConfig), async () => {});

      const req = createMockReq('DELETE');
      const { res, getResult } = createMockRes();

      await handler(req, res);
      const result = await getResult();

      expect(result.status).toBe(405);
      expect(result.body.ok).toBe(false);
      expect(result.body.error).toBe('Method Not Allowed');
    });

    it('sendJson 正确格式化 JSON 响应并设置标头', async () => {
      const { res, getResult } = createMockRes();
      sendJson(res, 201, { success: true, count: 42 });

      const result = await getResult();
      expect(result.status).toBe(201);
      expect(result.headers['content-type']).toContain('application/json');
      expect(result.body).toEqual({ success: true, count: 42 });
    });

    it('parseJsonBody 正确从 IncomingMessage 解析 JSON 请求体', async () => {
      const req = createMockReq('POST', { testKey: 'testValue' });
      const parsed = await parseJsonBody(req);
      expect(parsed).toEqual({ testKey: 'testValue' });
    });

    it('parseJsonBody 面对空请求体返回空对象', async () => {
      const req = createMockReq('POST', undefined);
      const parsed = await parseJsonBody(req);
      expect(parsed).toEqual({});
    });
  });
});
