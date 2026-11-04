/**
 * tests/contract/scheduled-title-guard.test.ts
 *
 * 契约测试: 系统触发器不得污染私聊会话标题/昵称
 *
 * 背景:
 * - 旧版 dispatchWakeup 只排除 internal_agent，其余触发器只要 from_name 非空
 *   就覆盖私聊标题；
 * - 定时任务 payload 的 from_name 是「系统定时任务」，于是会话标题被改成
 *   「私聊: 系统定时任务 <QQ号> #1」，且该名称被持久化到 plugin_kv:napcat_peer_names；
 * - 触发一次定时任务后，昵称就永久变成「系统定时任务」。
 *
 * 覆盖规范:
 * 1. scheduled / proactive / internal_agent 等系统触发器绝不改写私聊标题；
 * 2. 真实消息（at / mention / quote / poke）仍能正常更新昵称；
 * 3. 历史污染数据（plugin_kv 中的「系统定时任务」与已污染标题）会被清理/自愈。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fsp } from 'node:fs';
import { SessionManager } from '../../src/gateway/session.js';
import { MessageDatabase } from '../../src/storage/database.js';

const PEER = 'user_1000000001';
const SESSION_ID = 'qq-user-1000000001';
const NEUTRAL_TITLE = '私聊: 1000000001 #1';

describe('契约测试: 系统触发器不得污染私聊会话标题', () => {
  let tmpHome: string;
  let db: MessageDatabase | undefined;
  let sessionManager: SessionManager;
  let currentTitle: string;
  let rename: any;
  let followup: any;
  let mockAgent: any;

  beforeEach(async () => {
    tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-title-guard-'));
    currentTitle = NEUTRAL_TITLE;
    rename = vi.fn((_session: any, title: string) => {
      currentTitle = title;
    });
    followup = vi.fn();
    mockAgent = {
      status: 'idle',
      followup,
      steer: vi.fn(),
      session: { id: SESSION_ID },
    };
  });

  afterEach(async () => {
    await sessionManager?.dispose().catch(() => {});
    db?.close();
    db = undefined;
    await fsp.rm(tmpHome, { recursive: true, force: true }).catch(() => {});
  });

  function createManager(extraGet?: (key: string) => any): SessionManager {
    const mockCtx: any = {
      get: vi.fn((key: string) => {
        const extra = extraGet?.(key);
        if (extra !== undefined) return extra;
        if (key === 'agents') {
          return { get: () => mockAgent };
        }
        if (key === 'sessionTitle') {
          return {
            get: () => ({ title: currentTitle }),
            rename,
          };
        }
        return undefined;
      }),
      logger: () => ({
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      }),
    };
    return new SessionManager(mockCtx, tmpHome, db);
  }

  it('契约 1: 定时任务唤醒 (trigger=scheduled) 绝不改写私聊标题，也不写入昵称缓存', async () => {
    sessionManager = createManager();

    await sessionManager.dispatchWakeup({
      trigger: 'scheduled',
      peer: PEER,
      from_user: '1000000001',
      from_name: '系统定时任务',
      content: '提醒用户喝水',
      task_id: 'task-1',
      timestamp: Date.now(),
    });

    expect(rename).not.toHaveBeenCalled();
    expect(currentTitle).toBe(NEUTRAL_TITLE);
    expect(sessionManager.getPeerName(PEER)).toBeUndefined();
  });

  it('契约 2: 系统触发器 (proactive / internal_agent) 同样不得改写私聊标题', async () => {
    sessionManager = createManager();

    await sessionManager.dispatchWakeup({
      trigger: 'proactive',
      peer: PEER,
      from_user: '',
      from_name: '系统主动唤醒',
      content: '主动冒泡',
      timestamp: Date.now(),
    });
    await sessionManager.dispatchWakeup({
      trigger: 'internal_agent',
      peer: PEER,
      from_user: 'qq-user-1000000002',
      from_name: '协同 Agent',
      content: '内部任务',
      timestamp: Date.now(),
    });

    expect(rename).not.toHaveBeenCalled();
    expect(currentTitle).toBe(NEUTRAL_TITLE);
    expect(sessionManager.getPeerName(PEER)).toBeUndefined();
  });

  it('契约 3: 真实消息仍能用 from_name 正常更新私聊标题', async () => {
    sessionManager = createManager();

    await sessionManager.dispatchWakeup({
      trigger: 'at',
      peer: PEER,
      from_user: '1000000001',
      from_name: '小明',
      content: '你好',
      msg_id: 1,
      timestamp: Date.now(),
    });

    expect(rename).toHaveBeenCalledWith(mockAgent.session, '私聊: 小明 1000000001 #1');
    expect(currentTitle).toBe('私聊: 小明 1000000001 #1');
    expect(sessionManager.getPeerName(PEER)).toBe('小明');
  });

  it('契约 4: 历史污染清理 —— plugin_kv 中的「系统定时任务」加载时丢弃，已污染标题自愈为中性标题', async () => {
    const dbPath = path.join(tmpHome, 'napcat', 'messages.sqlite');
    await fsp.mkdir(path.dirname(dbPath), { recursive: true });
    db = new MessageDatabase(dbPath);
    db.init();
    db.setPluginConfig(
      'napcat_peer_names',
      JSON.stringify({ [PEER]: '系统定时任务', 'group_8000000001': '系统定时任务' })
    );

    currentTitle = '私聊: 系统定时任务 1000000001 #1';
    sessionManager = createManager();

    // 私聊的伪昵称被丢弃；群名不受影响（群可能真的叫这个名字）
    expect(sessionManager.getPeerName(PEER)).toBeUndefined();
    expect(sessionManager.getPeerName('group_8000000001')).toBe('系统定时任务');

    // 清理结果已回写持久化，避免下次启动重复丢弃
    const persisted = JSON.parse(db.getPluginConfig('napcat_peer_names')!);
    expect(persisted[PEER]).toBeUndefined();
    expect(persisted['group_8000000001']).toBe('系统定时任务');

    // 已污染的私聊标题在下次标题刷新时自愈为中性号码标题
    sessionManager.updateSessionTitle(mockAgent.session, PEER, SESSION_ID);
    expect(currentTitle).toBe(NEUTRAL_TITLE);
  });
});
