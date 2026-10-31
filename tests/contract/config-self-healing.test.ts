import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  IconChevronDownOutlineMedium: () => null,
  IconChevronDownOutlineRegular: () => null,
}));

import {
  getValidConfigKeys,
  sanitizeConfigPayload,
  healProfileConfigFile,
} from '../../src/config/heal.js';
import {
  registerConfigRoute,
  CONFIG_ROUTE_PATH,
} from '../../src/server/routes.js';
import { BridgeConfigSchema } from '../../src/config/schema.js';
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

describe('契约测试: 配置动态校验与配置文件自愈机制 (Config Self-Healing Contract)', () => {
  const testTmpDir = path.resolve(process.cwd(), 'tmp/test-config-heal');

  beforeEach(() => {
    fs.mkdirSync(testTmpDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(testTmpDir, { recursive: true, force: true });
  });

  describe('1. 单一真相源与纯函数自愈清洗契约 (sanitizeConfigPayload)', () => {
    it('getValidConfigKeys 动态返回 BridgeConfigSchema 中声明的 30 项合法键', () => {
      const validKeys = getValidConfigKeys();
      expect(validKeys.size).toBe(30);
      expect(validKeys.has('proactive_interval_mins')).toBe(true);
      expect(validKeys.has('proactive_buffer_size')).toBe(true);
      expect(validKeys.has('ws_port')).toBe(true);
      expect(validKeys.has('bot_qq')).toBe(true);
      expect(validKeys.has('face_enabled')).toBe(true);
      expect(validKeys.has('user_profile_budget_chars')).toBe(true);
      expect(validKeys.has('session_memory_budget_chars')).toBe(true);
      expect(validKeys.has('group_memory_total_budget_chars')).toBe(true);

      // 已下线的历史键严禁存在于有效键集合中
      expect(validKeys.has('at_questioner')).toBe(false);
      expect(validKeys.has('quote_original')).toBe(false);
      expect(validKeys.has('review_enabled')).toBe(false);
      expect(validKeys.has('face_auto_curate')).toBe(false);
      expect(validKeys.has('memory_budget_chars')).toBe(false);
      expect(validKeys.has('group_memory_budget_chars')).toBe(false);
      expect(validKeys.has('private_memory_budget_chars')).toBe(false);
    });

    it('sanitizeConfigPayload 正确分离合法字段与脏字段，并剔除无效键', () => {
      const dirtyInput = {
        ws_port: 3001,
        bot_qq: '12345678',
        at_questioner: false, // 脏字段
        quote_original: true, // 脏字段
        review_enabled: true, // 历史脏字段
        some_random_alien_key: 'hacked', // 未知脏字段
        persona: '测试人格',
      };

      const result = sanitizeConfigPayload(dirtyInput);
      expect(result.valid).toEqual({
        ws_port: 3001,
        bot_qq: '12345678',
        persona: '测试人格',
      });

      expect(result.removed.sort()).toEqual(
        ['at_questioner', 'quote_original', 'review_enabled', 'some_random_alien_key'].sort()
      );
    });

    it('当输入已是 100% 纯净配置时，removed 数组为空', () => {
      const cleanInput = {
        ws_port: 8080,
        bot_qq: '10001',
      };

      const result = sanitizeConfigPayload(cleanInput);
      expect(result.valid).toEqual(cleanInput);
      expect(result.removed).toEqual([]);
    });

    it('sanitizeConfigPayload 在清洗前将旧记忆预算键的值搬运至新键', () => {
      const legacyInput = {
        ws_port: 8080,
        memory_budget_chars: 3300,
        private_memory_budget_chars: 1900,
      };

      const result = sanitizeConfigPayload(legacyInput);
      expect(result.valid.ws_port).toBe(8080);
      expect(result.valid.group_memory_total_budget_chars).toBe(3300);
      expect(result.valid.user_profile_budget_chars).toBe(1900);
      expect(result.removed).toEqual([]);
    });
  });

  describe('2. 物理配置文件自愈契约 (healProfileConfigFile)', () => {
    it('探测到 profile patch 中存在 dsh-napcat-bridge 的脏键时，安全剔除并写回文件，且保留其他合法项', () => {
      const profileDir = path.join(testTmpDir, 'profiles/desktop');
      fs.mkdirSync(profileDir, { recursive: true });
      const patchPath = path.join(profileDir, 'cordis.patch.yml');

      // 构造包含历史废弃键与合法键的 YAML 内容
      const mockYaml = `
- id: ui-theme
  name: "@deepseek-ai/dsh-client-ui-theme"
  config:
    preference: system
- id: dsh-napcat-bridge
  name: dsh-napcat-bridge
  config:
    ws_port: 3001
    bot_qq: "1000000000"
    admins:
      - "1000000001"
    at_questioner: false
    quote_original: true
    review_enabled: true
    persona: "测试人格"
`;
      fs.writeFileSync(patchPath, mockYaml, 'utf8');

      const healResult = healProfileConfigFile(testTmpDir, 'desktop');
      expect(healResult.healed).toBe(true);
      expect(healResult.removedKeys.sort()).toEqual(
        ['at_questioner', 'quote_original', 'review_enabled'].sort()
      );

      // 读取写回后的内容，验证脏键被彻底移除，合法键完整保留
      const updatedContent = fs.readFileSync(patchPath, 'utf8');
      expect(updatedContent).not.toContain('at_questioner');
      expect(updatedContent).not.toContain('quote_original');
      expect(updatedContent).not.toContain('review_enabled');

      expect(updatedContent).toContain('3001');
      expect(updatedContent).toContain('1000000000');
      expect(updatedContent).toContain('1000000001');
      expect(updatedContent).toContain('测试人格');
      expect(updatedContent).toContain('ui-theme');
    });

    it('当 profile patch 文件中没有任何脏键时，保持文件不变且 healed 为 false', () => {
      const profileDir = path.join(testTmpDir, 'profiles/desktop');
      fs.mkdirSync(profileDir, { recursive: true });
      const patchPath = path.join(profileDir, 'cordis.patch.yml');

      const cleanYaml = `
- id: dsh-napcat-bridge
  name: dsh-napcat-bridge
  config:
    ws_port: 3001
    bot_qq: "1000000000"
`;
      fs.writeFileSync(patchPath, cleanYaml, 'utf8');

      const healResult = healProfileConfigFile(testTmpDir, 'desktop');
      expect(healResult.healed).toBe(false);
      expect(healResult.removedKeys).toEqual([]);
    });

    it('探测到旧记忆预算键时原地重命名为新键并保留用户旧值', () => {
      const profileDir = path.join(testTmpDir, 'profiles/desktop');
      fs.mkdirSync(profileDir, { recursive: true });
      const patchPath = path.join(profileDir, 'cordis.patch.yml');

      const legacyYaml = `
- id: dsh-napcat-bridge
  name: dsh-napcat-bridge
  config:
    ws_port: 3001
    group_memory_budget_chars: 4100
    private_memory_budget_chars: 1900
    persona: "测试人格"
`;
      fs.writeFileSync(patchPath, legacyYaml, 'utf8');

      const healResult = healProfileConfigFile(testTmpDir, 'desktop');
      expect(healResult.healed).toBe(true);
      expect(healResult.removedKeys).toEqual([]);
      expect(healResult.renamedKeys).toEqual(
        expect.arrayContaining([
          { from: 'group_memory_budget_chars', to: 'group_memory_total_budget_chars' },
          { from: 'private_memory_budget_chars', to: 'user_profile_budget_chars' },
        ])
      );

      const updatedContent = fs.readFileSync(patchPath, 'utf8');
      expect(updatedContent).toContain('group_memory_total_budget_chars: 4100');
      expect(updatedContent).toContain('user_profile_budget_chars: 1900');
      expect(updatedContent).not.toContain('group_memory_budget_chars');
      expect(updatedContent).not.toContain('private_memory_budget_chars');
      expect(updatedContent).toContain('测试人格');
    });
  });

  describe('3. 保存配置时自愈与防 500 契约 (Save Route Interception)', () => {
    it('POST 收到包含历史废弃键（at_questioner / quote_original）时，服务端自愈过滤并成功持久化，绝不抛出 500', async () => {
      let handler: any;
      const mutateMock = vi.fn().mockImplementation(async (ns: string, ops: any[]) => {
        // 模拟 DSH 真实 settings.mutate 的严格 volatile 校验
        const schema = BridgeConfigSchema as any;
        const validKeys = new Set(Object.keys(schema.dict || {}));
        for (const op of ops) {
          const key = op.path[0];
          if (!validKeys.has(key)) {
            throw new Error(`Config field "${key}" is not volatile`);
          }
        }
        return { ok: true };
      });

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
        bot_qq: '12345678',
      };

      const reconcileMock = vi.fn().mockImplementation(async (next) => {
        if (next) currentCfg = { ...next };
      });

      registerConfigRoute(mockCtx, () => currentCfg, reconcileMock);

      // 模拟前端带有历史脏字段提交
      const dirtyPayload = {
        ws_port: 9000,
        bot_qq: '88888888',
        at_questioner: false, // 脏字段
        quote_original: true, // 脏字段
      };

      const req = createMockReq('POST', dirtyPayload);
      const { res, getResult } = createMockRes();

      await handler(req, res);
      const result = await getResult();

      // 必须响应 200，绝不崩溃 500
      expect(result.status).toBe(200);
      expect(result.body.ok).toBe(true);

      // 验证交给 settings.mutate 的 ops 绝不包含 at_questioner 或 quote_original
      expect(mutateMock).toHaveBeenCalled();
      const passedOps = mutateMock.mock.calls[0][1];
      const passedPaths = passedOps.map((op: any) => op.path[0]);
      expect(passedPaths).not.toContain('at_questioner');
      expect(passedPaths).not.toContain('quote_original');
      expect(passedPaths).toContain('ws_port');
      expect(passedPaths).toContain('bot_qq');
    });

    it('GET 请求下发配置时，仅下发 Schema 范围内的干净字段，避免向前端渗透脏数据', async () => {
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

      // 模拟存量配置中持有历史废弃字段
      const dirtyCurrentCfg = {
        ws_port: 8080,
        bot_qq: '12345678',
        at_questioner: false,
        quote_original: true,
        review_enabled: true,
      };

      registerConfigRoute(mockCtx, () => dirtyCurrentCfg as any, async () => {});

      const req = createMockReq('GET');
      const { res, getResult } = createMockRes();

      await handler(req, res);
      const result = await getResult();

      expect(result.status).toBe(200);
      expect(result.body.ok).toBe(true);
      expect(result.body.config.at_questioner).toBeUndefined();
      expect(result.body.config.quote_original).toBeUndefined();
      expect(result.body.config.review_enabled).toBeUndefined();
      expect(result.body.config.ws_port).toBe(8080);
      expect(result.body.config.bot_qq).toBe('12345678');
    });
  });
});
