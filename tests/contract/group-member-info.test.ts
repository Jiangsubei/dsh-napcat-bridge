/**
 * tests/contract/group-member-info.test.ts
 *
 * 契约测试: get_group_member_info 群成员信息查询工具
 *
 * 覆盖场景:
 * 1. Gateway 动作契约: getGroupMemberList 发送 get_group_member_list 动作与参数
 * 2. 工具逻辑精确匹配: 按 user_id 查询目标成员，识破自称群主但实为普通成员
 * 3. 工具逻辑模糊搜索: 按 query 模糊匹配群名片或昵称
 * 4. 工具逻辑角色筛选: 按 role ('owner' | 'admin' | 'member') 筛选特定群体
 * 5. 会话门控拦截: 私聊会话调用时防御性拦截并返回友好提示
 * 6. 缓存与穿透策略: 默认命中内存缓存，no_cache: true 触发强制穿透拉新
 * 7. 纯隐式会话继承: Agent 无感知也无需传入群号，直接从运行时 exec.agent.session.id 自动继承
 * 8. 真实装配闭环: bootDshNapcatBridge 挂载后 tools 包含 get_group_member_info
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import WebSocket from 'ws';
import { NapCatGatewayServer } from '../../src/gateway/server.js';
import {
  queryGroupMemberInfo,
  formatMemberInfo,
  createGetGroupMemberInfoTool,
  groupMemberCache,
  type GroupMemberRawItem,
} from '../../src/tools/member-info.js';
import { bootDshNapcatBridge } from '../../src/boot.js';

function noopLogger(): any {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  };
}

describe('契约测试: get_group_member_info 群成员信息查询工具', () => {
  describe('1. Gateway 动作接入契约', () => {
    let server: NapCatGatewayServer;
    let client: WebSocket;
    let received: Array<Record<string, any>> = [];

    beforeEach(async () => {
      received = [];
      server = new NapCatGatewayServer({ port: 0, logger: noopLogger() });
      await server.start();
      const addr: any = (server as any).wss.address();
      client = new WebSocket(`ws://127.0.0.1:${addr.port}`);
      await new Promise<void>((resolve, reject) => {
        client.once('open', () => resolve());
        client.once('error', reject);
      });
      client.on('message', (data) => {
        received.push(JSON.parse(data.toString()));
      });
    });

    afterEach(async () => {
      if (client) {
        client.terminate();
      }
      await server.stop().catch(() => {});
    });

    it('契约 1.1: getGroupMemberList 正确发送 get_group_member_list 动作与参数', async () => {
      const waitPromise = server.getGroupMemberList(888888888, true);

      await new Promise((resolve) => setTimeout(resolve, 30));
      const req = received.find((r) => r.action === 'get_group_member_list');
      expect(req).toBeDefined();
      expect(req?.params).toEqual({
        group_id: 888888888,
        no_cache: true,
      });

      // 模拟 NapCat 客户端响应
      client.send(
        JSON.stringify({
          echo: req?.echo,
          status: 'ok',
          retcode: 0,
          data: [
            {
              group_id: 888888888,
              user_id: 10001,
              nickname: 'RealOwner',
              card: '真正的群主',
              role: 'owner',
              title: '👑大当家',
              join_time: 1700000000,
              last_sent_time: 1750000000,
              level: '100',
              shut_up_timestamp: 0,
              is_robot: false,
            },
          ],
        })
      );

      const res = await waitPromise;
      expect(res.status).toBe('ok');
      expect(res.data).toHaveLength(1);
      expect(res.data[0].role).toBe('owner');
    });
  });

  describe('2. 工具执行与过滤语义化', () => {
    const mockMembers: GroupMemberRawItem[] = [
      {
        group_id: 888888888,
        user_id: 10001,
        nickname: 'Alice',
        card: '老群主',
        role: 'owner',
        title: '最高领袖',
        join_time: 1600000000,
        last_sent_time: 1750000000,
        level: '99',
        shut_up_timestamp: 0,
        is_robot: false,
      },
      {
        group_id: 888888888,
        user_id: 10002,
        nickname: 'Bob',
        card: '管理-小鲍',
        role: 'admin',
        title: '巡查官',
        join_time: 1650000000,
        last_sent_time: 1740000000,
        level: '50',
        shut_up_timestamp: 0,
        is_robot: false,
      },
      {
        group_id: 888888888,
        user_id: 10003,
        nickname: 'Charlie',
        card: '',
        role: 'member',
        title: '',
        join_time: 1700000000,
        last_sent_time: 1730000000,
        level: '10',
        shut_up_timestamp: 0,
        is_robot: false,
      },
      {
        group_id: 888888888,
        user_id: 10004,
        nickname: 'David',
        card: '冒牌群主', // 故意取名叫冒牌群主，用来测试防伪
        role: 'member',
        title: '',
        join_time: 1720000000,
        last_sent_time: 1720000000,
        level: '1',
        shut_up_timestamp: Math.floor(Date.now() / 1000) + 3600, // 禁言中
        is_robot: false,
      },
    ];

    let mockGateway: any;

    beforeEach(() => {
      groupMemberCache.clearAll();
      mockGateway = {
        getGroupMemberList: vi.fn().mockResolvedValue({
          status: 'ok',
          retcode: 0,
          data: mockMembers,
        }),
      };
    });

    it('契约 2.1: 按 user_id 精确查询目标成员，识破自称群主但实为普通成员', async () => {
      const res = await queryGroupMemberInfo(
        { user_id: '10004' },
        { gateway: mockGateway, peer: 'group_888888888', groupId: 888888888 }
      );

      expect(res.success).toBe(true);
      expect(res.total).toBe(1);
      const member = res.members[0];
      expect(member.user_id).toBe('10004');
      expect(member.card).toBe('冒牌群主');
      // 真实身份必须是普通成员，绝非群主！
      expect(member.role).toContain('普通成员');
      expect(member.role).toContain('member');
      expect(member.status).toContain('禁言中');
    });

    it('契约 2.2: 按 query 模糊匹配群名片与昵称', async () => {
      const res = await queryGroupMemberInfo(
        { query: '老群主' },
        { gateway: mockGateway, peer: 'group_888888888', groupId: 888888888 }
      );

      expect(res.success).toBe(true);
      expect(res.total).toBe(1);
      expect(res.members[0].user_id).toBe('10001');
      expect(res.members[0].role).toContain('群主');
      expect(res.members[0].title).toBe('最高领袖');
    });

    it('契约 2.3: 按 role 筛选特权成员 (owner / admin)', async () => {
      const ownerRes = await queryGroupMemberInfo(
        { role: 'owner' },
        { gateway: mockGateway, peer: 'group_888888888', groupId: 888888888 }
      );
      expect(ownerRes.success).toBe(true);
      expect(ownerRes.total).toBe(1);
      expect(ownerRes.members[0].user_id).toBe('10001');

      const adminRes = await queryGroupMemberInfo(
        { role: 'admin' },
        { gateway: mockGateway, peer: 'group_888888888', groupId: 888888888 }
      );
      expect(adminRes.success).toBe(true);
      expect(adminRes.total).toBe(1);
      expect(adminRes.members[0].user_id).toBe('10002');
    });

    it('契约 2.4: 会话门控拦截 - 私聊环境下调用直接报错', async () => {
      const res = await queryGroupMemberInfo(
        { query: 'any' },
        { gateway: mockGateway, peer: 'user_10001' }
      );

      expect(res.success).toBe(false);
      expect(res.error).toContain('当前不在群聊会话中');
      expect(mockGateway.getGroupMemberList).not.toHaveBeenCalled();
    });

    it('契约 2.5: 缓存策略 - 默认复用缓存，no_cache: true 强制穿透刷新', async () => {
      // 第一次调用，触发 API
      await queryGroupMemberInfo(
        { role: 'owner' },
        { gateway: mockGateway, peer: 'group_888888888', groupId: 888888888 }
      );
      expect(mockGateway.getGroupMemberList).toHaveBeenCalledTimes(1);

      // 第二次调用无 no_cache，命中缓存，API 调用次数依然为 1
      await queryGroupMemberInfo(
        { role: 'admin' },
        { gateway: mockGateway, peer: 'group_888888888', groupId: 888888888 }
      );
      expect(mockGateway.getGroupMemberList).toHaveBeenCalledTimes(1);

      // 第三次调用带 no_cache: true，强制穿透，API 调用次数变为 2
      await queryGroupMemberInfo(
        { role: 'owner', no_cache: true },
        { gateway: mockGateway, peer: 'group_888888888', groupId: 888888888 }
      );
      expect(mockGateway.getGroupMemberList).toHaveBeenCalledTimes(2);
    });

    it('契约 2.6: formatMemberInfo 输出字段完备性与格式化语义', () => {
      const formatted = formatMemberInfo(mockMembers[0]);
      expect(formatted.user_id).toBe('10001');
      expect(formatted.display_name).toBe('老群主');
      expect(formatted.nickname).toBe('Alice');
      expect(formatted.card).toBe('老群主');
      expect(formatted.role).toBe('群主 (owner)');
      expect(formatted.title).toBe('最高领袖');
      expect(formatted.join_time).toMatch(/\d{4}-\d{2}-\d{2}/);
      expect(formatted.last_sent_time).toMatch(/\d{4}-\d{2}-\d{2}/);
      expect(formatted.status).toBe('正常');
    });

    it('契约 2.7: 真实 Agent execute 场景下，从 exec.agent.session.id (qq-group-888888888) 纯隐式自动继承群聊会话', async () => {
      const tool = createGetGroupMemberInfoTool(() => ({
        gateway: mockGateway,
      }));

      const execMock = {
        agent: {
          session: {
            id: 'qq-group-888888888',
          },
        },
      };

      // 模型入参中无群号，纯传 role
      const result = await (tool as any).execute({ role: 'owner' }, execMock);
      expect(result.success).toBe(true);
      expect(result.group_id).toBe('888888888');
      expect(mockGateway.getGroupMemberList).toHaveBeenCalledWith('888888888', false);
      expect(result.members[0].role).toContain('群主');
    });

    it('契约 2.8: tool.execute 输出严格符合 DSH Lossless JSON 规范 (不含任何 undefined 字段)', async () => {
      const tool = createGetGroupMemberInfoTool(() => ({
        gateway: mockGateway,
      }));

      const execMock = {
        agent: {
          session: {
            id: 'qq-group-888888888',
          },
        },
      };

      const result = await (tool as any).execute({ user_id: '10001' }, execMock);
      // 检查顶层属性绝无 undefined
      for (const [_key, value] of Object.entries(result)) {
        expect(value).not.toBeUndefined();
      }
      // message/error 若未赋值，经过 toLosslessJson 清洗后绝不保留为 undefined 属性
      expect(result.hasOwnProperty('message')).toBe(false);
      expect(result.hasOwnProperty('error')).toBe(false);
    });
  });

  describe('3. 真实装配闭环', () => {
    it('契约 3.1: bootDshNapcatBridge 挂载后 tools 注册表包含 get_group_member_info', async () => {
      const booted = await bootDshNapcatBridge({
        port: 19825,
        auto_connect: false,
      });

      try {
        const provider = (booted.ctx.get('napcatBridgeTools') || (booted.ctx as any).napcatBridgeTools) as any;
        expect(provider).toBeDefined();
        provider.registerTools(booted.ctx);

        const tools = booted.ctx.get('tools') || (booted.ctx as any).tools;
        expect(tools).toBeDefined();
        expect(typeof tools.get).toBe('function');
        const toolDef = tools.get('get_group_member_info');
        expect(toolDef).toBeDefined();
        expect(toolDef.name).toBe('get_group_member_info');
        expect(toolDef.description).toContain('查询当前群聊中的成员资料');
        expect(toolDef.description).toContain('身份角色（群主/管理员/普通成员）');
        // 参数列表中严禁暴露 group_id，模型无需指定
        expect(toolDef.parameters.group_id).toBeUndefined();
      } finally {
        await booted.dispose();
      }
    });
  });
});
