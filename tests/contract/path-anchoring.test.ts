/**
 * tests/contract/path-anchoring.test.ts
 *
 * 契约测试: 修复 Memory 存储目录与 Workspace 工作区路径的绝对路径锚定缺陷
 *
 * 核心契约:
 * 1. 当 process.cwd() 位于任意与 dshHome 毫无关系的临时工作目录时，
 *    MemoryStorage 的 getBaseDir() 必须严格基于 dshHome 展开，绝不污染当前进程 cwd；
 * 2. 相对路径（如 .dsh/napcat/napcat_memory 或 napcat/napcat_memory）传入时，
 *    必须正确剥离前导 .dsh/ 并以 dshHome 为基准展开；绝对路径传入时保留；
 * 3. SessionManager 的 resolveCwd() 与工作区注册逻辑必须严格锚定在 dshHome 内，
 *    绝对不使用 process.cwd()；
 * 4. 真实生产装配闭环 (bootDshNapcatBridge):
 *    在模拟的非 dshHome 目录启动时，挂载插件后能正确从 dshHome/napcat/napcat_memory
 *    读取既有的 Session 记忆与 User Profile 并注入动态 Prompt，且当前进程工作目录下绝不产生 .dsh 污染。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import { MemoryStorage } from '../../src/memory/storage.js';
import { setupMemoryService } from '../../src/memory/index.js';
import { SessionManager } from '../../src/gateway/session.js';
import { bootDshNapcatBridge, type BootedDsh } from '../../src/boot.js';
import { MessageDatabase } from '../../src/storage/database.js';

describe('契约测试: Memory 与 Workspace 绝对路径锚定 (Path Anchoring Contract)', () => {
  let originalCwd: string;
  let originalDshHome: string | undefined;
  let arbitraryCwd: string;
  let customDshHome: string;
  let booted: BootedDsh | null = null;

  beforeEach(async () => {
    originalCwd = process.cwd();
    originalDshHome = process.env.DSH_HOME;

    arbitraryCwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'arbitrary-run-dir-'));
    customDshHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'custom-dsh-home-'));

    process.chdir(arbitraryCwd);
    process.env.DSH_HOME = customDshHome;
  });

  afterEach(async () => {
    if (booted) {
      await booted.dispose().catch(() => {});
      booted = null;
    }

    process.chdir(originalCwd);
    if (originalDshHome !== undefined) {
      process.env.DSH_HOME = originalDshHome;
    } else {
      delete process.env.DSH_HOME;
    }

    if (arbitraryCwd) {
      await fsp.rm(arbitraryCwd, { recursive: true, force: true }).catch(() => {});
    }
    if (customDshHome) {
      await fsp.rm(customDshHome, { recursive: true, force: true }).catch(() => {});
    }
  });

  describe('契约 1: MemoryStorage 路径绝对锚定', () => {
    it('无参构造函数必须默认锚定在 dshHome/napcat/napcat_memory，绝不指向 process.cwd()', () => {
      const storage = new MemoryStorage();
      const expectedDir = path.resolve(customDshHome, 'napcat/napcat_memory');

      expect(storage.getBaseDir()).toBe(expectedDir);
      expect(storage.getBaseDir().startsWith(arbitraryCwd)).toBe(false);
      expect(path.isAbsolute(storage.getBaseDir())).toBe(true);
    });

    it('传入相对路径 .dsh/napcat/napcat_memory 时正确剥离前导并锚定在 dshHome 下', () => {
      const storage = new MemoryStorage('.dsh/napcat/napcat_memory', customDshHome);
      const expectedDir = path.resolve(customDshHome, 'napcat/napcat_memory');

      expect(storage.getBaseDir()).toBe(expectedDir);
      expect(storage.getBaseDir().startsWith(arbitraryCwd)).toBe(false);
    });

    it('传入相对路径 napcat/napcat_memory 时正确锚定在 dshHome 下', () => {
      const storage = new MemoryStorage('napcat/napcat_memory', customDshHome);
      const expectedDir = path.resolve(customDshHome, 'napcat/napcat_memory');

      expect(storage.getBaseDir()).toBe(expectedDir);
      expect(storage.getBaseDir().startsWith(arbitraryCwd)).toBe(false);
    });

    it('传入绝对路径时保持绝对路径不变', () => {
      const customAbsolute = path.resolve(os.tmpdir(), 'some-absolute-storage');
      const storage = new MemoryStorage(customAbsolute, customDshHome);

      expect(storage.getBaseDir()).toBe(customAbsolute);
    });

    it('setBaseDir 也严格遵循 dshHome 绝对锚定规则', () => {
      const storage = new MemoryStorage();
      storage.setBaseDir('.dsh/custom_memory', customDshHome);
      const expectedDir = path.resolve(customDshHome, 'custom_memory');

      expect(storage.getBaseDir()).toBe(expectedDir);
      expect(storage.getBaseDir().startsWith(arbitraryCwd)).toBe(false);
    });
  });

  describe('契约 2: SessionManager Workspace 路径绝对锚定', () => {
    it('SessionManager.resolveCwd() 始终锚定在 dshHome/workspace/napcat，绝不污染 process.cwd()', () => {
      const mockCtx: any = {
        get: () => undefined,
        logger: () => ({ debug: () => {}, warn: () => {}, error: () => {} }),
      };
      const sessionManager = new SessionManager(mockCtx, customDshHome);
      const resolvedCwd = sessionManager.resolveCwd('group_646988881');
      const expectedCwd = path.resolve(customDshHome, 'workspace/napcat');

      expect(resolvedCwd).toBe(expectedCwd);
      expect(resolvedCwd.startsWith(arbitraryCwd)).toBe(false);
      expect(path.isAbsolute(resolvedCwd)).toBe(true);
    });

    it('SessionManager.registerWorkspace 必须在 dshHome 目录下创建物理工作区，当前工作区绝不产生目录', async () => {
      let createdPath = '';
      const mockWorkspaceRegistry = {
        create: async (cwd: string) => {
          createdPath = cwd;
          return { attachSession: async () => {} };
        },
      };
      const mockCtx: any = {
        get: (name: string) => (name === 'workspaceRegistry' ? mockWorkspaceRegistry : undefined),
        logger: () => ({ debug: () => {}, warn: () => {}, error: () => {} }),
      };

      const sessionManager = new SessionManager(mockCtx, customDshHome);
      await sessionManager.registerWorkspace(sessionManager.resolveCwd());

      expect(createdPath).toBe(path.resolve(customDshHome, 'workspace/napcat'));
      expect(fs.existsSync(path.resolve(customDshHome, 'workspace/napcat'))).toBe(true);
      expect(fs.existsSync(path.resolve(arbitraryCwd, '.dsh'))).toBe(false);
    });
  });

  describe('契约 3: 真实装配闭环 - bootDshNapcatBridge 下 Memory 动态注入与零工作区污染', () => {
    it('在独立进程 cwd 启动时，插件正确从 dshHome 读取记忆并注入 Prompt，cwd 绝无 .dsh 污染', async () => {
      // 1. 在 customDshHome 下准备真实的记忆目录与文件
      const memSessionDir = path.resolve(customDshHome, 'napcat/napcat_memory/session');
      const memUserDir = path.resolve(customDshHome, 'napcat/napcat_memory/user');
      await fsp.mkdir(memSessionDir, { recursive: true });
      await fsp.mkdir(memUserDir, { recursive: true });

      const testSessionContent =
        '# Session 记忆（group_646988881）\n\n### 群聊规则\n- 本群是技术研发交流群，严禁灌水';
      const testUserProfile =
        '# 用户画像（2000000001）\n\n### 特征\n- 资深架构师，关注绝对路径与安全性';

      await fsp.writeFile(path.join(memSessionDir, 'group_646988881.md'), testSessionContent, 'utf-8');
      await fsp.writeFile(path.join(memUserDir, '2000000001.md'), testUserProfile, 'utf-8');

      // 2. 在 customDshHome 的 SQLite 数据库中写入发言活跃记录
      const dbDir = path.resolve(customDshHome, 'workspace/napcat');
      await fsp.mkdir(dbDir, { recursive: true });
      const db = new MessageDatabase(path.join(dbDir, 'messages.sqlite'));
      db.init();
      db.saveMessage({
        msg_id: 1001,
        peer: 'group_646988881',
        user_id: '2000000001',
        sender_name: '架构师小张',
        time: Date.now() - 5000,
        type: 'text',
        content: '路径锚定测试消息',
        raw: '{}',
        file_id: null,
        busid: null,
        local_path: null,
        fingerprint: null,
        recalled: 0,
        self: 0,
        reply_to: null,
      });

      // 3. 启动 DSH 装配并挂载 NapCat 插件 (使用独立端口 8095 避免并发冲突)
      booted = await bootDshNapcatBridge({
        dshHome: customDshHome,
        mountPlugin: true,
        config: {
          bot_qq: '1000000001',
          ws_port: 8095,
        },
      });

      const ctx = booted.ctx;
      const systemPrompt = ctx.get('systemPrompt') || (ctx as any).systemPrompt;
      expect(systemPrompt).toBeDefined();

      // 4. 断言 Prompt 动态注入正确读取 customDshHome 下的记忆与画像
      const result = await systemPrompt.assemble({
        session: { id: 'qq-group-646988881' },
      });
      const memCtx = (result?.contexts || []).find((c: any) => c.name === 'napcat:memory');

      expect(memCtx).toBeDefined();
      expect(memCtx?.text).toContain('本群是技术研发交流群，严禁灌水');
      expect(memCtx?.text).toContain('资深架构师，关注绝对路径与安全性');

      // 5. 严格验证 arbitraryCwd 绝无任何 .dsh 目录生成或被污染
      const arbitraryDshDir = path.resolve(arbitraryCwd, '.dsh');
      expect(fs.existsSync(arbitraryDshDir)).toBe(false);
    });
  });
});
