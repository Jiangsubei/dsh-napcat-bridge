import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import { bootDshNapcatBridge, type BootedDsh } from '../../src/boot.js';
import { SessionManager, formatSessionTitle, parseSessionId } from '../../src/gateway/session.js';
import { MessageDatabase } from '../../src/storage/database.js';

describe('契约测试: DSH 重启后会话恢复与全归档开启新轮次 (Session Restart & Archive Contract)', () => {
  let tmpHome: string;
  let booted: BootedDsh | null = null;
  let db: MessageDatabase | null = null;

  beforeEach(async () => {
    tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-restart-archive-'));
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

  it('契约 1: parseSessionId 正确解析基础版本与多轮归档版本', () => {
    expect(parseSessionId('qq-user-2000000001')).toEqual({
      peer: 'user_2000000001',
      id: '2000000001',
      round: 0,
      version: 1,
      isGroup: false,
    });
    expect(parseSessionId('qq-user-2000000001-2')).toEqual({
      peer: 'user_2000000001',
      id: '2000000001',
      round: 0,
      version: 2,
      isGroup: false,
    });
    expect(parseSessionId('qq-user-2000000001-r1-1')).toEqual({
      peer: 'user_2000000001',
      id: '2000000001',
      round: 1,
      version: 1,
      isGroup: false,
    });
    expect(parseSessionId('qq-user-2000000001-r1-2')).toEqual({
      peer: 'user_2000000001',
      id: '2000000001',
      round: 1,
      version: 2,
      isGroup: false,
    });
    expect(parseSessionId('qq-group-3000000001-r2-3')).toEqual({
      peer: 'group_3000000001',
      id: '3000000001',
      round: 2,
      version: 3,
      isGroup: true,
    });
  });

  it('契约 2: 真实装配下 /clear 到 #2 后重启 DSH，唤醒必须精准恢复 #2 绝不回退至 #1', async () => {
    const dbPath = path.resolve(tmpHome, 'workspace/napcat/messages.sqlite');
    db = new MessageDatabase(dbPath);
    db.init();

    // 1. 首次 Boot 启动
    booted = await bootDshNapcatBridge({
      dshHome: tmpHome,
      mountPlugin: false,
    });

    const sessionManager1 = new SessionManager(booted.ctx, tmpHome, db);

    // 初始会话为 #1
    const agent1 = await sessionManager1.getOrCreateAgent('user_2000000001');
    expect(agent1.session.id).toBe('qq-user-2000000001');
    await booted.ctx.sessions.flush(agent1.session);

    // 执行 /clear 进入 #2
    sessionManager1.markSessionCleared('user_2000000001');
    const agent2 = await sessionManager1.getOrCreateAgent('user_2000000001');
    expect(agent2.session.id).toBe('qq-user-2000000001-2');
    await booted.ctx.sessions.flush(agent2.session);

    // 关闭 DSH 模拟进程退出
    await booted.dispose();
    booted = null;

    // 2. 模拟重启 DSH
    booted = await bootDshNapcatBridge({
      dshHome: tmpHome,
      mountPlugin: false,
    });

    const sessionManager2 = new SessionManager(booted.ctx, tmpHome, db);

    // 重启后查询 peer 对应的 SessionId
    const resumedSessionId = sessionManager2.peerToSessionId('user_2000000001');
    expect(resumedSessionId).toBe('qq-user-2000000001-2');

    // 获取/恢复 Agent
    const resumedAgent = await sessionManager2.getOrCreateAgent('user_2000000001');
    expect(resumedAgent.session.id).toBe('qq-user-2000000001-2');
  });

  it('契约 3: Web UI 全部归档旧会话后，新消息自动开启 #1 (1) 并在 /clear 与重启后保持一致', async () => {
    const dbPath = path.resolve(tmpHome, 'workspace/napcat/messages.sqlite');
    db = new MessageDatabase(dbPath);
    db.init();

    booted = await bootDshNapcatBridge({
      dshHome: tmpHome,
      mountPlugin: false,
    });

    const sessionManager = new SessionManager(booted.ctx, tmpHome, db);

    // 1. 创建 #1 与 #2
    const a1 = await sessionManager.getOrCreateAgent('user_2000000001');
    await booted.ctx.sessions.flush(a1.session);
    sessionManager.markSessionCleared('user_2000000001');
    const a2 = await sessionManager.getOrCreateAgent('user_2000000001');
    await booted.ctx.sessions.flush(a2.session);

    // 2. 模拟用户在 Web UI 将 #1 和 #2 全量归档
    const wsRegistry = (booted.ctx as any).workspaceRegistry;
    await wsRegistry.archiveSession('qq-user-2000000001');
    await wsRegistry.archiveSession('qq-user-2000000001-2');

    // 3. 用户发送新消息，自动开启轮次 1 的 #1 (1)
    const newSessionId = sessionManager.peerToSessionId('user_2000000001');
    expect(newSessionId).toBe('qq-user-2000000001-r1-1');

    sessionManager.setPeerName('user_2000000001', 'Nyara');
    const aNew = await sessionManager.getOrCreateAgent('user_2000000001');
    expect(aNew.session.id).toBe('qq-user-2000000001-r1-1');

    const title = formatSessionTitle('user_2000000001', aNew.session.id, 'Nyara');
    expect(title).toBe('私聊: Nyara 2000000001 #1 (1)');
    await booted.ctx.sessions.flush(aNew.session);

    // 4. 在新轮次中执行 /clear -> 变为 #2 (1)
    sessionManager.markSessionCleared('user_2000000001');
    const aNew2 = await sessionManager.getOrCreateAgent('user_2000000001');
    expect(aNew2.session.id).toBe('qq-user-2000000001-r1-2');
    const title2 = formatSessionTitle('user_2000000001', aNew2.session.id, 'Nyara');
    expect(title2).toBe('私聊: Nyara 2000000001 #2 (1)');
    await booted.ctx.sessions.flush(aNew2.session);

    // 5. 重启 DSH，验证新轮次恢复
    await booted.dispose();
    booted = null;

    booted = await bootDshNapcatBridge({
      dshHome: tmpHome,
      mountPlugin: false,
    });

    const sessionManagerRestarted = new SessionManager(booted.ctx, tmpHome, db);
    expect(sessionManagerRestarted.peerToSessionId('user_2000000001')).toBe('qq-user-2000000001-r1-2');

    // 6. 若将 #1(1) 和 #2(1) 再次全部归档，自动开启 #1 (2)
    const wsRegistry2 = (booted.ctx as any).workspaceRegistry;
    await wsRegistry2.archiveSession('qq-user-2000000001-r1-1');
    await wsRegistry2.archiveSession('qq-user-2000000001-r1-2');

    const round2SessionId = sessionManagerRestarted.peerToSessionId('user_2000000001');
    expect(round2SessionId).toBe('qq-user-2000000001-r2-1');
    const titleRound2 = formatSessionTitle('user_2000000001', round2SessionId, 'Nyara');
    expect(titleRound2).toBe('私聊: Nyara 2000000001 #1 (2)');
  });

  it('契约 4: 物理删除历史会话文件后，peerToSessionId 自动回退至 #1 (版本 1)', async () => {
    const dbPath = path.resolve(tmpHome, 'workspace/napcat/messages.sqlite');
    db = new MessageDatabase(dbPath);
    db.init();

    booted = await bootDshNapcatBridge({
      dshHome: tmpHome,
      mountPlugin: false,
    });

    const sessionManager = new SessionManager(booted.ctx, tmpHome, db);

    // 1. 创建 #1 与 #2 并持久化落盘
    const a1 = await sessionManager.getOrCreateAgent('user_2000000001');
    await booted.ctx.sessions.flush(a1.session);
    sessionManager.markSessionCleared('user_2000000001');
    const a2 = await sessionManager.getOrCreateAgent('user_2000000001');
    await booted.ctx.sessions.flush(a2.session);

    expect(sessionManager.peerToSessionId('user_2000000001')).toBe('qq-user-2000000001-2');

    // 2. 模拟进程退出与磁盘物理删除（如用户手动删除 sessions 目录）
    await booted.dispose();
    booted = null;

    const checkRoots = [
      path.join(tmpHome, 'sessions'),
      path.join(os.homedir(), '.dsh', 'sessions'),
    ];
    for (const r of checkRoots) {
      if (fs.existsSync(r)) {
        const dirs = fs.readdirSync(r);
        for (const d of dirs) {
          const s1 = path.join(r, d, 'qq-user-2000000001');
          const s2 = path.join(r, d, 'qq-user-2000000001-2');
          await fsp.rm(s1, { recursive: true, force: true }).catch(() => {});
          await fsp.rm(s2, { recursive: true, force: true }).catch(() => {});
        }
      }
    }

    // 3. 重启 DSH
    booted = await bootDshNapcatBridge({
      dshHome: tmpHome,
      mountPlugin: false,
    });

    const sessionManagerRestarted = new SessionManager(booted.ctx, tmpHome, db);

    // 4. 此时检测到物理文件已不存在，Session 编号应回退到 #1
    const resetSessionId = sessionManagerRestarted.peerToSessionId('user_2000000001');
    expect(resetSessionId).toBe('qq-user-2000000001');

    // 5. DB 状态也应被重置为回退后的 #1
    const state = db.getSessionState('user_2000000001');
    expect(state?.current_session_id).toBe('qq-user-2000000001');

    // 6. 重新唤醒分配 #1
    const aReset = await sessionManagerRestarted.getOrCreateAgent('user_2000000001');
    expect(aReset.session.id).toBe('qq-user-2000000001');
  });
});
