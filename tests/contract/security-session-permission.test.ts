/**
 * tests/contract/security-session-permission.test.ts
 * 契约测试: 发言黑名单门控、新建会话权限与 Coding 工具组硬隔离装配 (Security & Permissions Contract)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fsp } from 'node:fs';
import WebSocket from 'ws';
import { bootDshNapcatBridge, type BootedDsh } from '../../src/boot.js';
import * as NapCatBridgePlugin from '../../src/index.js';
import { SessionManager } from '../../src/gateway/session.js';
import { MessageDatabase } from '../../src/storage/database.js';

const BOT_QQ = '1000000000';
const ADMIN_QQ = '1000000001';
const NORMAL_USER_QQ = '1000000002';
const BLACKLISTED_USER_QQ = '1000000003';
const BLACKLISTED_GROUP_ID = 8000000001;
const NORMAL_GROUP_ID = 8000000002;
const WS_PORT = 18355;

describe('契约测试: 发言黑名单、新建会话权限与 Coding 工具裁剪装配闭环', () => {
  let tmpHome: string;
  let booted: BootedDsh;
  let client: WebSocket;

  function dbPath(): string {
    return path.join(tmpHome, 'napcat/messages.sqlite');
  }

  beforeEach(async () => {
    tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-security-contract-'));

    booted = await bootDshNapcatBridge({
      dshHome: tmpHome,
      mountPlugin: false,
      extraPatches: [
        {
          insert: [
            {
              id: 'agent-preset-registry',
              name: '@deepseek-ai/dsh-agent-preset-registry',
              config: { default: 'qq-session' },
            },
          ],
        },
      ],
    });

    await booted.ctx.plugin(NapCatBridgePlugin, {
      bot_qq: BOT_QQ,
      ws_port: WS_PORT,
      ws_host: '127.0.0.1',
      admins: [ADMIN_QQ],
      private_blacklist: [
        { id: BLACKLISTED_USER_QQ, remark: '违规用户' },
        { id: ADMIN_QQ, remark: '测试把管理员也拉黑' },
      ],
      group_blacklist: [
        { id: String(BLACKLISTED_GROUP_ID), remark: '黑名单群聊' },
      ],
      session_permission_private_default: 'workspace-write',
      session_permission_group_default: 'read-only',
      session_permission_overrides: [
        { id: String(NORMAL_GROUP_ID), type: 'group', permission: 'workspace-write', remark: '特例可编辑群' },
      ],
      coding_tools_private_default: true,
      coding_tools_group_default: false,
      coding_tools_overrides: [
        { id: String(NORMAL_GROUP_ID), type: 'group', enabled: true, remark: '特例开启代码工具' },
      ],
    });

    client = new WebSocket(`ws://127.0.0.1:${WS_PORT}`);
    await new Promise<void>((resolve, reject) => {
      client.once('open', () => resolve());
      client.once('error', (err) => reject(err));
    });

    client.on('message', (raw) => {
      try {
        const parsed = JSON.parse(raw.toString());
        if (parsed.action) {
          client.send(
            JSON.stringify({
              status: 'ok',
              retcode: 0,
              echo: parsed.echo,
              data: {
                nickname: '普通群友',
                card: '普通群友名片',
              },
            })
          );
        }
      } catch {}
    });
  });

  afterEach(async () => {
    if (client && client.readyState === WebSocket.OPEN) {
      client.close();
    }
    if (booted) {
      await booted.dispose().catch(() => {});
    }
    if (tmpHome) {
      await fsp.rm(tmpHome, { recursive: true, force: true }).catch(() => {});
    }
  });

  describe('1. 发言黑名单门控契约 (CHK-03)', () => {
    it('私聊黑名单：消息正常落库，但立即阻断流转，绝不唤醒 Agent 且不执行指令', async () => {
      const db = new MessageDatabase(dbPath());
      db.init();

      // 发送私聊消息（来自被拉黑的普通用户）
      const msgEvent = {
        post_type: 'message',
        message_type: 'private',
        sub_type: 'friend',
        message_id: 88101,
        user_id: Number(BLACKLISTED_USER_QQ),
        time: Math.floor(Date.now() / 1000),
        self_id: BOT_QQ,
        sender: { user_id: Number(BLACKLISTED_USER_QQ), nickname: '拉黑用户' },
        message: [{ type: 'text', data: { text: '在吗？请求帮助' } }],
        raw_message: '在吗？请求帮助',
      };

      client.send(JSON.stringify(msgEvent));

      // 稍作等待确保消息流转
      await new Promise((resolve) => setTimeout(resolve, 500));

      // 1. 验证消息正常落入 SQLite 数据库
      const saved = db.getMessage(88101);
      expect(saved).toBeDefined();
      expect(saved?.user_id).toBe(BLACKLISTED_USER_QQ);
      expect(saved?.content).toBe('在吗？请求帮助');

      // 2. 验证会话未被唤醒/未建立 Agent 会话
      const sessionManager = (booted.ctx as any)['napcat-session'] || new SessionManager(booted.ctx, tmpHome);
      const activeSessions = (sessionManager as any).activeHandles || new Map();
      expect(activeSessions.has(`qq-user-${BLACKLISTED_USER_QQ}`)).toBe(false);
    });

    it('群聊黑名单：消息正常落库，但群内点名/@机器人的消息绝对不唤醒', async () => {
      const db = new MessageDatabase(dbPath());
      db.init();

      // 发送群聊消息（来自被拉黑的群，且 @了机器人）
      const msgEvent = {
        post_type: 'message',
        message_type: 'group',
        sub_type: 'normal',
        message_id: 88102,
        group_id: BLACKLISTED_GROUP_ID,
        user_id: Number(NORMAL_USER_QQ),
        time: Math.floor(Date.now() / 1000),
        self_id: BOT_QQ,
        sender: { user_id: Number(NORMAL_USER_QQ), nickname: '普通群友' },
        message: [
          { type: 'at', data: { qq: BOT_QQ } },
          { type: 'text', data: { text: ' 出来聊天' } },
        ],
        raw_message: `[CQ:at,qq=${BOT_QQ}] 出来聊天`,
      };

      client.send(JSON.stringify(msgEvent));
      await new Promise((resolve) => setTimeout(resolve, 500));

      // 1. 消息已落库
      const saved = db.getMessage(88102);
      expect(saved).toBeDefined();
      expect(saved?.peer).toBe(`group_${BLACKLISTED_GROUP_ID}`);

      // 2. Agent 会话未被唤醒
      const sessionManager = (booted.ctx as any)['napcat-session'] || new SessionManager(booted.ctx, tmpHome);
      const activeSessions = (sessionManager as any).activeHandles || new Map();
      expect(activeSessions.has(`qq-group-${BLACKLISTED_GROUP_ID}`)).toBe(false);
    });

    it('管理员不豁免原则：管理员落入黑名单后，发送斜杠命令同样阻断不响应', async () => {
      const db = new MessageDatabase(dbPath());
      db.init();

      // 管理员发送指令
      const msgEvent = {
        post_type: 'message',
        message_type: 'private',
        sub_type: 'friend',
        message_id: 88103,
        user_id: Number(ADMIN_QQ),
        time: Math.floor(Date.now() / 1000),
        self_id: BOT_QQ,
        sender: { user_id: Number(ADMIN_QQ), nickname: '管理员' },
        message: [{ type: 'text', data: { text: '/help' } }],
        raw_message: '/help',
      };

      client.send(JSON.stringify(msgEvent));
      await new Promise((resolve) => setTimeout(resolve, 500));

      // 消息落库
      const saved = db.getMessage(88103);
      expect(saved).toBeDefined();

      // 管理员会话未建立
      const sessionManager = (booted.ctx as any)['napcat-session'] || new SessionManager(booted.ctx, tmpHome);
      const activeSessions = (sessionManager as any).activeHandles || new Map();
      expect(activeSessions.has(`qq-user-${ADMIN_QQ}`)).toBe(false);
    });
  });

  describe('2. 新建会话权限模式与例外装配契约 (CHK-04)', () => {
    it('私聊新建会话默认装配 workspace-write 模式', async () => {
      const sessionManager = (booted.ctx as any)['napcat-session'] || new SessionManager(booted.ctx, tmpHome);
      const agent = await sessionManager.getOrCreateAgent(`user_${NORMAL_USER_QQ}`);
      expect(agent).toBeDefined();

      const permissionPresets: any =
        (booted.ctx as any).permissionPresets || (booted.ctx as any).get?.('permissionPresets');
      const currentMode = permissionPresets?.current?.(agent.session);
      expect(currentMode).toBe('workspace-write');
    });

    it('群聊新建会话默认装配 read-only 模式，特例覆盖群装配 workspace-write 模式', async () => {
      const sessionManager = (booted.ctx as any)['napcat-session'] || new SessionManager(booted.ctx, tmpHome);

      // 普通群 999999999 (未在特例表中) -> 默认 read-only
      const defaultGroupAgent = await sessionManager.getOrCreateAgent('group_999999999');
      const permissionPresets: any =
        (booted.ctx as any).permissionPresets || (booted.ctx as any).get?.('permissionPresets');
      expect(permissionPresets?.current?.(defaultGroupAgent.session)).toBe('read-only');

      // 特例覆盖群 NORMAL_GROUP_ID -> 覆盖为 workspace-write
      const overrideGroupAgent = await sessionManager.getOrCreateAgent(`group_${NORMAL_GROUP_ID}`);
      expect(permissionPresets?.current?.(overrideGroupAgent.session)).toBe('workspace-write');
    });
  });

  describe('3. Coding 工具组装载与硬隔离契约 (CHK-05)', () => {
    const CODING_TOOLS = ['bash', 'pwsh', 'read', 'write', 'edit', 'read_image', 'working_directory'];

    it('群聊默认关闭 Coding 工具组：assemble 的 tools 列表中彻底排除 7 个工程工具，保留 QQ 与 Web 工具', async () => {
      const sessionManager = (booted.ctx as any)['napcat-session'] || new SessionManager(booted.ctx, tmpHome);
      // 普通群 999999999 -> coding_tools_group_default = false
      const agent = await sessionManager.getOrCreateAgent('group_999999999');

      const asm = await booted.ctx.systemPrompt.assemble({ scope: agent, agent } as any);
      const toolNames = new Set((asm.tools as any[]).map((t) => t.name));

      // 7 个 Coding 工具必须全部被排除
      for (const t of CODING_TOOLS) {
        expect(toolNames.has(t), `工具 ${t} 应当在非 Coding 会话中被裁剪`).toBe(false);
      }

      // 核心业务/QQ交互/Web工具仍正常保留
      expect(toolNames.has('send_qq_message')).toBe(true);
      expect(toolNames.has('web_search')).toBe(true);
      expect(toolNames.has('read_chat_history')).toBe(true);
    });

    it('特例群覆盖开启 Coding 工具组：7 个工程工具正常保留装载', async () => {
      const sessionManager = (booted.ctx as any)['napcat-session'] || new SessionManager(booted.ctx, tmpHome);
      // 特例群 NORMAL_GROUP_ID -> coding_tools_overrides 设为 true
      const agent = await sessionManager.getOrCreateAgent(`group_${NORMAL_GROUP_ID}`);

      const asm = await booted.ctx.systemPrompt.assemble({ scope: agent, agent } as any);
      const toolNames = new Set((asm.tools as any[]).map((t) => t.name));

      // 核心工程工具必须存在
      expect(toolNames.has('read')).toBe(true);
      expect(toolNames.has('write')).toBe(true);
      expect(toolNames.has('edit')).toBe(true);
      if (process.platform === 'win32') {
        expect(toolNames.has('pwsh')).toBe(true);
      } else {
        expect(toolNames.has('bash')).toBe(true);
      }
    });
  });
});
