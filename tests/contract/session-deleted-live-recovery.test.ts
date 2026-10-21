import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import { bootDshNapcatBridge, type BootedDsh } from '../../src/boot.js';
import { SessionManager } from '../../src/gateway/session.js';
import { MessageDatabase } from '../../src/storage/database.js';

describe('契约测试: 运行期物理删除会话后的僵尸句柄自动淘汰与新会话恢复 (Live Deletion & Zombie Handle Eviction)', () => {
  let tmpHome: string;
  let booted: BootedDsh | null = null;
  let db: MessageDatabase | null = null;

  beforeEach(async () => {
    tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-live-deletion-'));
  });

  afterEach(async () => {
    if (db) {
      db.close();
      db = null;
    }
    if (booted) {
      await booted.dispose().catch(() => {});
      booted = null;
    }
    if (tmpHome) {
      await fsp.rm(tmpHome, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('契约 1: isSessionPhysicallyPresent 必须以真实物理日志文件为准，严禁因内存持有 handle 或空目录而误判为存在', async () => {
    const dbPath = path.resolve(tmpHome, 'napcat/messages.sqlite');
    db = new MessageDatabase(dbPath);
    db.init();

    booted = await bootDshNapcatBridge({
      dshHome: tmpHome,
      mountPlugin: false,
    });

    const sessionManager = new SessionManager(booted.ctx, tmpHome, db);

    // 1. 创建会话并落盘
    const agent = await sessionManager.getOrCreateAgent('user_99990001');
    const sid = agent.session.id;
    await booted.ctx.sessions.flush(agent.session);

    // 此时物理文件存在且内存持有 handle
    expect(sessionManager.hasActiveHandle(sid)).toBe(true);
    expect(sessionManager.isSessionPhysicallyPresent(sid)).toBe(true);

    // 2. 模拟外部物理删除：直接删除磁盘上的会话文件/目录
    const baseSessionsDir = path.join(tmpHome, 'sessions');
    if (fs.existsSync(baseSessionsDir)) {
      const dirs = fs.readdirSync(baseSessionsDir);
      for (const d of dirs) {
        const p = path.join(baseSessionsDir, d, sid);
        if (fs.existsSync(p)) {
          await fsp.rm(p, { recursive: true, force: true });
        }
      }
    }

    // 此时内存虽然仍持有 activeHandles，但物理文件已被删除！
    // 契约红线：isSessionPhysicallyPresent 绝不能因为内存有 activeHandles 就返回 true！
    expect(sessionManager.isSessionPhysicallyPresent(sid)).toBe(false);

    // 3. 模拟仅留空目录（无任何 session 日志文件）
    const dummyDir = path.join(tmpHome, 'sessions', '--test--', sid);
    await fsp.mkdir(dummyDir, { recursive: true });
    // 契约红线：空目录严禁被判定为有效会话
    expect(sessionManager.isSessionPhysicallyPresent(sid)).toBe(false);
  });

  it('契约 2: 运行期物理删除会话后无需重启 DSH，再次调用 getOrCreateAgent 自动淘汰僵尸句柄并创建全新物理会话', async () => {
    const dbPath = path.resolve(tmpHome, 'napcat/messages.sqlite');
    db = new MessageDatabase(dbPath);
    db.init();

    booted = await bootDshNapcatBridge({
      dshHome: tmpHome,
      mountPlugin: false,
    });

    const sessionManager = new SessionManager(booted.ctx, tmpHome, db);

    // 1. 首次创建会话并落盘
    const agent1 = await sessionManager.getOrCreateAgent('user_99990002');
    const sid1 = agent1.session.id;
    await booted.ctx.sessions.flush(agent1.session);
    expect(sessionManager.hasActiveHandle(sid1)).toBe(true);

    // 2. 模拟用户在 Web/桌面端物理删除了该会话（在不重启 DSH 的运行状态下）
    const baseSessionsDir = path.join(tmpHome, 'sessions');
    if (fs.existsSync(baseSessionsDir)) {
      const dirs = fs.readdirSync(baseSessionsDir);
      for (const d of dirs) {
        const p = path.join(baseSessionsDir, d, sid1);
        if (fs.existsSync(p)) {
          await fsp.rm(p, { recursive: true, force: true });
        }
      }
    }

    // 3. QQ 发送新消息唤醒：再次调用 getOrCreateAgent
    // 此时 DSH 进程从未重启，但系统必须能感知到物理文件已被删除，
    // 自动释放旧句柄、清理缓存并成功创建新的物理会话！
    const agent2 = await sessionManager.getOrCreateAgent('user_99990002');
    const sid2 = agent2.session.id;

    // 验证：
    // - 新会话必须不是指向死掉的 sid1（或者 sid1 被重新物理初始化）
    // - 新会话必须物理有效，能正常 flush 落盘
    await booted.ctx.sessions.flush(agent2.session);
    expect(sessionManager.isSessionPhysicallyPresent(sid2)).toBe(true);
    expect(sessionManager.hasActiveHandle(sid2)).toBe(true);
  });
});
