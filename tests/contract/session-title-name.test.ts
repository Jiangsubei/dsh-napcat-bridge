/**
 * tests/contract/session-title-name.test.ts
 *
 * 契约测试: 会话昵称解析、持久化与“不得降级覆盖”
 *
 * 背景:
 * - peer 名称此前只存在内存 Map，DSH 重启即丢；
 * - getOrCreateAgent 每次无条件 rename，名字未知时会把
 *   「群聊: 测试群 8000000001 #1」覆盖成「群聊: 8000000001 #1」；
 * - Agent 内部主动创建会话（create_target_agent / send_agent_message）此前没有昵称来源，
 *   首建标题只有号码。
 *
 * 覆盖规范:
 * 1. 从会话标题反向提取名称（纯函数边界）；
 * 2. 真实装配下 ensurePeerName 通过 get_group_info / get_stranger_info 解析并持久化到 plugin_kv；
 * 3. 名字未知且已有标题时，updateSessionTitle 绝不降级覆盖。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fsp } from 'node:fs';
import { bootDshNapcatBridge, type BootedDsh } from '../../src/boot.js';
import { extractNameFromSessionTitle } from '../../src/gateway/session.js';

const WS_PORT = 29881;
const WS_TOKEN = 'test-mock-token';
const BOT_QQ = '1000000000';

describe('契约测试: 会话昵称解析与持久化', () => {
  let tmpHome: string;
  let booted: BootedDsh | undefined;

  beforeEach(async () => {
    tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-session-name-'));
    booted = await bootDshNapcatBridge({
      dshHome: tmpHome,
      mountPlugin: true,
      config: { bot_qq: BOT_QQ, ws_port: WS_PORT, ws_token: WS_TOKEN },
    });
  });

  afterEach(async () => {
    if (booted) {
      await booted.dispose().catch(() => {});
      booted = undefined;
    }
    if (tmpHome) {
      await fsp.rm(tmpHome, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('契约 1: 从会话标题提取名称（有名称 / 纯号码 / 无标题）', () => {
    expect(extractNameFromSessionTitle('群聊: 测试群 8000000001 #1', 'group_8000000001')).toBe('测试群');
    expect(extractNameFromSessionTitle('私聊: 小明 1000000001 #2 (1)', 'user_1000000001')).toBe('小明');
    expect(extractNameFromSessionTitle('群聊: 8000000001 #1', 'group_8000000001')).toBeUndefined();
    expect(extractNameFromSessionTitle(undefined, 'group_8000000001')).toBeUndefined();
    expect(extractNameFromSessionTitle('', 'group_8000000001')).toBeUndefined();
  });

  it('契约 2: ensurePeerName 通过 NapCat 查询群名/昵称，并持久化到 plugin_kv', async () => {
    const ctx: any = booted!.ctx;
    const gateway: any = ctx.get('napcat-gateway');
    expect(gateway).toBeDefined();

    gateway.getGroupInfo = async () => ({
      status: 'ok',
      retcode: 0,
      data: { group_id: 8000000001, group_name: '装配测试群' },
    });
    gateway.getStrangerInfo = async () => ({
      status: 'ok',
      retcode: 0,
      data: { user_id: 1000000001, nickname: '装配测试用户' },
    });

    const sessionManager: any = ctx.get('napcat-session');
    expect(await sessionManager.ensurePeerName('group_8000000001')).toBe('装配测试群');
    expect(await sessionManager.ensurePeerName('user_1000000001')).toBe('装配测试用户');
    expect(sessionManager.getPeerName('group_8000000001')).toBe('装配测试群');
    expect(sessionManager.getPeerName('user_1000000001')).toBe('装配测试用户');

    const rawDb = new DatabaseSync(path.join(tmpHome, 'napcat', 'messages.sqlite'), {
      readOnly: true,
    });
    try {
      const row = rawDb
        .prepare("SELECT value FROM plugin_kv WHERE key = 'napcat_peer_names'")
        .get() as any;
      expect(row?.value).toBeTruthy();
      const persisted = JSON.parse(row.value);
      expect(persisted['group_8000000001']).toBe('装配测试群');
      expect(persisted['user_1000000001']).toBe('装配测试用户');
    } finally {
      rawDb.close();
    }
  });

  it('契约 3: 名字未知且已有标题时，绝不降级覆盖为纯号码标题', async () => {
    const ctx: any = booted!.ctx;
    const gateway: any = ctx.get('napcat-gateway');
    gateway.getGroupInfo = async () => {
      throw new Error('NapCat offline');
    };

    const sessionManager: any = ctx.get('napcat-session');
    const cwd = path.join(tmpHome, 'title-ws');
    await fsp.mkdir(cwd, { recursive: true });
    const handle = await ctx.agents.create({
      sessionId: 'qq-group-8000000002',
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      meta: { cwd },
    });
    const session = (handle.agent || handle).session;

    const titleSvc: any = ctx.get('sessionTitle') || ctx.sessionTitle;
    expect(typeof titleSvc?.rename).toBe('function');
    titleSvc.rename(session, '群聊: 原始群名 8000000002 #1');

    // 名字解析失败，且内存/持久化缓存均无该 peer
    expect(await sessionManager.ensurePeerName('group_8000000002')).toBeUndefined();
    sessionManager.updateSessionTitle(session, 'group_8000000002', 'qq-group-8000000002');

    expect(titleSvc.get(session)?.title).toBe('群聊: 原始群名 8000000002 #1');
  });
});
