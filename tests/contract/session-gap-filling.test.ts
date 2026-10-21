import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fsp } from 'node:fs';
import { bootDshNapcatBridge, type BootedDsh } from '../../src/boot.js';
import {
  SessionManager,
  formatSessionTitle,
  parseSessionId,
  buildSessionId,
  findSmallestAvailableVersion,
} from '../../src/gateway/session.js';
import { MessageDatabase } from '../../src/storage/database.js';

describe('契约测试: 会话编号空缺填补与短哈希防撞契约 (Session Gap-Filling & Hash Contract)', () => {
  let tmpHome: string;
  let booted: BootedDsh | null = null;
  let db: MessageDatabase | null = null;

  beforeEach(async () => {
    tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-gap-filling-'));
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

  it('契约 1: parseSessionId 与 buildSessionId 正确处理带短哈希的新格式并兼容旧格式', () => {
    // 1.1 旧格式向下兼容
    expect(parseSessionId('qq-group-3000000001')).toEqual({
      peer: 'group_3000000001',
      id: '3000000001',
      round: 0,
      version: 1,
      hash: undefined,
      isGroup: true,
    });
    expect(parseSessionId('qq-group-3000000001-2')).toEqual({
      peer: 'group_3000000001',
      id: '3000000001',
      round: 0,
      version: 2,
      hash: undefined,
      isGroup: true,
    });
    expect(parseSessionId('qq-user-2000000001-r1-2')).toEqual({
      peer: 'user_2000000001',
      id: '2000000001',
      round: 1,
      version: 2,
      hash: undefined,
      isGroup: false,
    });

    // 1.2 新带短哈希格式解析
    expect(parseSessionId('qq-group-3000000001-1-a7b3c9')).toEqual({
      peer: 'group_3000000001',
      id: '3000000001',
      round: 0,
      version: 1,
      hash: 'a7b3c9',
      isGroup: true,
    });
    expect(parseSessionId('qq-group-3000000001-3-f1e2d3')).toEqual({
      peer: 'group_3000000001',
      id: '3000000001',
      round: 0,
      version: 3,
      hash: 'f1e2d3',
      isGroup: true,
    });
    expect(parseSessionId('qq-user-2000000001-r1-2-123456')).toEqual({
      peer: 'user_2000000001',
      id: '2000000001',
      round: 1,
      version: 2,
      hash: '123456',
      isGroup: false,
    });

    // 1.3 buildSessionId 构造断言
    expect(buildSessionId('qq-group-3000000001', 0, 1, 'a7b3c9')).toBe('qq-group-3000000001-1-a7b3c9');
    expect(buildSessionId('qq-group-3000000001', 0, 2, 'a7b3c9')).toBe('qq-group-3000000001-2-a7b3c9');
    expect(buildSessionId('qq-group-3000000001', 1, 2, 'a7b3c9')).toBe('qq-group-3000000001-r1-2-a7b3c9');
    // 无 hash 向后兼容
    expect(buildSessionId('qq-group-3000000001', 0, 1)).toBe('qq-group-3000000001');
    expect(buildSessionId('qq-group-3000000001', 0, 2)).toBe('qq-group-3000000001-2');
  });

  it('契约 2: findSmallestAvailableVersion 纯算法契约 (First Missing Positive)', () => {
    expect(findSmallestAvailableVersion([])).toBe(1);
    expect(findSmallestAvailableVersion([3])).toBe(1);
    expect(findSmallestAvailableVersion([1, 3])).toBe(2);
    expect(findSmallestAvailableVersion([1, 2, 3])).toBe(4);
    expect(findSmallestAvailableVersion([2, 3])).toBe(1);
    expect(findSmallestAvailableVersion([1, 2])).toBe(3);
  });

  it('契约 3: 真实装配下有会话 1, 2, 3，删除 1, 2 后新建依次为 1, 2，已有 3 则跳过新建 4', async () => {
    const dbPath = path.resolve(tmpHome, 'napcat/messages.sqlite');
    db = new MessageDatabase(dbPath);
    db.init();

    booted = await bootDshNapcatBridge({
      dshHome: tmpHome,
      mountPlugin: false,
    });

    const sessionManager = new SessionManager(booted.ctx, tmpHome, db);
    const peer = 'group_3000000001';

    // 1. 依次创建会话 1, 2, 3 并持久化落盘
    const a1 = await sessionManager.getOrCreateAgent(peer);
    await booted.ctx.sessions.flush(a1.session);
    const s1Id = a1.session.id;
    expect(formatSessionTitle(peer, s1Id)).toContain('#1');

    sessionManager.markSessionCleared(peer);
    const a2 = await sessionManager.getOrCreateAgent(peer);
    await booted.ctx.sessions.flush(a2.session);
    const s2Id = a2.session.id;
    expect(formatSessionTitle(peer, s2Id)).toContain('#2');

    sessionManager.markSessionCleared(peer);
    const a3 = await sessionManager.getOrCreateAgent(peer);
    await booted.ctx.sessions.flush(a3.session);
    const s3Id = a3.session.id;
    expect(formatSessionTitle(peer, s3Id)).toContain('#3');

    // 2. 模拟用户在 Web UI 上删除了会话 1 和会话 2 (归档操作)
    const wsRegistry = (booted.ctx as any).workspaceRegistry;
    await wsRegistry.archiveSession(s1Id);
    await wsRegistry.archiveSession(s2Id);

    // 3. 验证未归档会话列表仅剩会话 3
    const activeList = sessionManager.listPeerSessionIds(peer);
    expect(activeList).toEqual([s3Id]);

    // 4. 关键验证点 A: 此时用户执行 /新建 -> 期望新建会话 1
    sessionManager.markSessionCleared(peer);
    const aNew1 = await sessionManager.getOrCreateAgent(peer);
    await booted.ctx.sessions.flush(aNew1.session);
    const new1Parsed = parseSessionId(aNew1.session.id);
    expect(new1Parsed?.version).toBe(1);
    expect(new1Parsed?.hash).toBeDefined(); // 具备短哈希
    expect(aNew1.session.id).not.toBe(s1Id); // 物理 SessionId 绝不与旧的 s1Id 碰撞！
    expect(formatSessionTitle(peer, aNew1.session.id)).toContain('#1');

    // 5. 关键验证点 B: 再次执行 /新建 -> 期望新建会话 2
    sessionManager.markSessionCleared(peer);
    const aNew2 = await sessionManager.getOrCreateAgent(peer);
    await booted.ctx.sessions.flush(aNew2.session);
    const new2Parsed = parseSessionId(aNew2.session.id);
    expect(new2Parsed?.version).toBe(2);
    expect(new2Parsed?.hash).toBeDefined();
    expect(aNew2.session.id).not.toBe(s2Id);
    expect(formatSessionTitle(peer, aNew2.session.id)).toContain('#2');

    // 6. 关键验证点 C: 此时未归档会话已有 1, 2, 3，再次执行 /新建 -> 发现已有 3，跳过新建 4
    sessionManager.markSessionCleared(peer);
    const aNew4 = await sessionManager.getOrCreateAgent(peer);
    await booted.ctx.sessions.flush(aNew4.session);
    const new4Parsed = parseSessionId(aNew4.session.id);
    expect(new4Parsed?.version).toBe(4);
    expect(formatSessionTitle(peer, aNew4.session.id)).toContain('#4');

    // 7. 关键验证点 D: 验证即使将已被归档的旧会话 1 从归档恢复 (unarchive)，两者和谐共存
    await wsRegistry.unarchiveSession(s1Id);
    expect(wsRegistry.archivedSessionIds).not.toContain(s1Id);
    // 恢复后系统中存在两个 #1，但 SessionId 不同，互不干扰
    expect(s1Id).not.toBe(aNew1.session.id);
  }, 15000);
});
