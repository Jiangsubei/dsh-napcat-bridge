import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import { promises as fsp } from 'node:fs';
import { bootDshNapcatBridge } from '../../src/boot.js';
import { SessionManager, formatSessionTitle, parseSessionId } from '../../src/gateway/session.js';
import { MessageDatabase } from '../../src/storage/database.js';
import type { WakeupPayload } from '../../src/types/index.js';

describe('契约测试：QQ /新建 命令版本自增与未落盘新会话消息路由防回退', () => {
  let tmpHome: string;
  let db: MessageDatabase | undefined;
  let booted: any;

  beforeEach(async () => {
    tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-new-sid-test-'));
  });

  afterEach(async () => {
    try {
      if (db) {
        db.close();
      }
      if (booted?.ctx) {
        await booted.ctx.stop();
      }
    } catch {}
    try {
      await fsp.rm(tmpHome, { recursive: true, force: true });
    } catch {}
  });

  it('契约 1: 当前会话一无论是否落盘，执行 markSessionCleared 必须生成版本 2，严禁重复生成版本 1', async () => {
    const dbPath = path.resolve(tmpHome, 'napcat/messages.sqlite');
    db = new MessageDatabase(dbPath);
    db.init();

    booted = await bootDshNapcatBridge({
      dshHome: tmpHome,
      mountPlugin: false,
    });

    const sessionManager = new SessionManager(booted.ctx, tmpHome, db);
    const peer = 'user_1000000001';

    // 1. 获取会话一
    const a1 = await sessionManager.getOrCreateAgent(peer);
    const s1Id = a1.session.id;
    const parsed1 = parseSessionId(s1Id);
    expect(parsed1?.version).toBe(1);
    expect(formatSessionTitle(peer, s1Id)).toContain('#1');

    // 2. 模拟用户敲 /新建
    const clearedSid = sessionManager.markSessionCleared(s1Id);
    expect(clearedSid).toBeDefined();

    // 3. 核心断言：新会话版本必须为 2，严禁依然是 1；标题必须为 #2
    const a2 = await sessionManager.getOrCreateAgent(peer);
    const s2Id = a2.session.id;
    const parsed2 = parseSessionId(s2Id);
    expect(parsed2?.version).toBe(2);
    expect(s2Id).not.toBe(s1Id);
    expect(formatSessionTitle(peer, s2Id)).toContain('#2');
  });

  it('契约 2: 刚通过 agents.create 创建的新会话在尚未落盘期间，后续消息不被误杀，不回退到旧会话', async () => {
    const dbPath = path.resolve(tmpHome, 'napcat/messages.sqlite');
    db = new MessageDatabase(dbPath);
    db.init();

    booted = await bootDshNapcatBridge({
      dshHome: tmpHome,
      mountPlugin: false,
    });

    const sessionManager = new SessionManager(booted.ctx, tmpHome, db);
    const peer = 'user_1000000001';

    // 1. 创建会话一并落盘
    const a1 = await sessionManager.getOrCreateAgent(peer);
    await booted.ctx.sessions.flush(a1.session);
    const s1Id = a1.session.id;

    // 2. 用户执行 /新建
    sessionManager.markSessionCleared(peer);

    // 3. 新消息进入，创建新会话（此时在新会话中，尚未完成落盘）
    const a2 = await sessionManager.getOrCreateAgent(peer);
    const s2Id = a2.session.id;
    expect(s2Id).not.toBe(s1Id);

    // 4. 关键动作：紧接着第二条、第三条消息到来（模拟未落盘的内存活动期）
    // 此时系统绝不能误杀 a2 句柄并退回 s1Id！
    const a2Second = await sessionManager.getOrCreateAgent(peer);
    expect(a2Second.session.id).toBe(s2Id);
    expect(sessionManager.peerToSessionId(peer)).toBe(s2Id);
  });

  it('契约 3: dispatchWakeup 端到端唤醒流下，/新建 后的消息必须锁定新会话 ID 与标题 #2，严禁回退旧会话 #1', async () => {
    const dbPath = path.resolve(tmpHome, 'napcat/messages.sqlite');
    db = new MessageDatabase(dbPath);
    db.init();

    booted = await bootDshNapcatBridge({
      dshHome: tmpHome,
      mountPlugin: false,
    });

    const sessionManager = new SessionManager(booted.ctx, tmpHome, db);
    const peer = 'user_1000000001';

    // 捕获 sessionTitle.rename 调用记录
    const sessionTitleSvc = booted.ctx.get('sessionTitle') || (booted.ctx as any).sessionTitle;
    const renameCalls: string[] = [];
    if (sessionTitleSvc && typeof sessionTitleSvc.rename === 'function') {
      const origRename = sessionTitleSvc.rename.bind(sessionTitleSvc);
      sessionTitleSvc.rename = vi.fn().mockImplementation((session: any, title: string) => {
        renameCalls.push(title);
        return origRename(session, title);
      });
    }

    // 1. 首次消息唤醒创建会话 1
    const p1: WakeupPayload = {
      peer,
      trigger: 'private',
      from_user: '1000000001',
      from_name: '我也要做吗',
      content: '早上好',
      timestamp: Date.now(),
    };
    await sessionManager.dispatchWakeup(p1);
    const s1Id = sessionManager.peerToSessionId(peer);
    expect(parseSessionId(s1Id)?.version).toBe(1);

    // 2. 用户执行 /新建
    sessionManager.markSessionCleared(s1Id);

    // 模拟新会话尚未产生物理文件的情况 (isSessionPhysicallyPresent 对新 sid 返回 false)
    const origIsPhysicallyPresent = sessionManager.isSessionPhysicallyPresent.bind(sessionManager);
    vi.spyOn(sessionManager, 'isSessionPhysicallyPresent').mockImplementation((sid: string) => {
      // 旧会话 1 是物理存在的，新会话故意模拟为尚未写盘落盘
      if (sid === s1Id) return true;
      return false;
    });

    // 3. 用户发送新消息唤醒
    const p2: WakeupPayload = {
      peer,
      trigger: 'private',
      from_user: '1000000001',
      from_name: '我也要做吗',
      content: '早上晚',
      timestamp: Date.now(),
    };
    await sessionManager.dispatchWakeup(p2);

    // 关键断言 A: 唤醒后当前会话必须是会话 2，绝不能被置换为会话 1
    const s2Id = sessionManager.peerToSessionId(peer);
    const parsed2 = parseSessionId(s2Id);
    expect(parsed2?.version).toBe(2);
    expect(s2Id).not.toBe(s1Id);

    // 关键断言 B: 新会话的标题必须被更新为 #2，严禁被误更新为 #1！
    const lastRenameTitle = renameCalls[renameCalls.length - 1];
    expect(lastRenameTitle).toContain('#2');
    expect(lastRenameTitle).not.toContain('#1');

    // 关键断言 C: 后续再发送消息 "那就晚上早"，依然稳定在会话 2，绝不回退
    const p3: WakeupPayload = {
      peer,
      trigger: 'private',
      from_user: '1000000001',
      from_name: '我也要做吗',
      content: '那就晚上早',
      timestamp: Date.now(),
    };
    await sessionManager.dispatchWakeup(p3);
    expect(sessionManager.peerToSessionId(peer)).toBe(s2Id);
  });
});
