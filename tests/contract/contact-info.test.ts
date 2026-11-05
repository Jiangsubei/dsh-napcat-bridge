/**
 * tests/contract/contact-info.test.ts
 *
 * 契约测试: 社交关系链探查与群信息只读工具集
 * (get_friend_list, get_group_list, get_user_profile, get_group_info, get_group_notice)
 *
 * 覆盖规范:
 * 1. Gateway 动作接入契约: 准确发送 OneBot 11 对应动作与参数 (尤其是 _get_group_notice)
 * 2. 字段清洗与降噪契约: 剥离无用冗余字段，仅向 Agent 暴露高价值核心信息
 * 3. 模糊检索与安全分页契约: 支持 query 匹配与 offset/limit 标准分页元数据、确定性排序与连续序号
 * 4. 内存 TTL 缓存契约: 默认命中缓存，no_cache 强制穿透
 * 5. 跨会话查群解耦契约: 允许显式传入 group_id 解除会话硬绑定
 * 6. DSH Lossless JSON 红线契约: 断言所有工具执行结果绝不包含 undefined
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import WebSocket from 'ws';
import { NapCatGatewayServer } from '../../src/gateway/server.js';
import {
  queryFriendList,
  queryGroupList,
  queryUserProfile,
  queryGroupInfo,
  queryGroupNotice,
  friendListCache,
  groupListCache,
  createGetFriendListTool,
  createGetGroupListTool,
  createGetUserProfileTool,
  createGetGroupInfoTool,
  createGetGroupNoticeTool,
} from '../../src/tools/contact-info.js';
import { bootDshNapcatBridge } from '../../src/boot.js';
import { queryGroupMemberInfo } from '../../src/tools/member-info.js';
function noopLogger(): any {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  };
}

/** 递归检查对象是否包含 undefined 字段 (DSH Lossless JSON 契约) */
function assertNoUndefinedFields(obj: any, path = ''): void {
  if (obj === null || obj === undefined) {
    if (obj === undefined) {
      throw new Error(`Found undefined at path: "${path}"`);
    }
    return;
  }
  if (Array.isArray(obj)) {
    obj.forEach((item, index) => assertNoUndefinedFields(item, `${path}[${index}]`));
    return;
  }
  if (typeof obj === 'object') {
    for (const key of Object.keys(obj)) {
      if (obj[key] === undefined) {
        throw new Error(`Found undefined field: "${path ? `${path}.${key}` : key}"`);
      }
      assertNoUndefinedFields(obj[key], path ? `${path}.${key}` : key);
    }
  }
}

describe('契约测试: 社交关系链探查与群信息只读工具集', () => {
  describe('1. Gateway 动作接入契约', () => {
    let server: NapCatGatewayServer;
    let client: WebSocket;
    let received: Array<Record<string, any>> = [];

    beforeEach(async () => {
      received = [];
      server = new NapCatGatewayServer({ port: 0, token: 'mock-test-token', logger: noopLogger() });
      await server.start();
      const addr: any = (server as any).wss.address();
      client = new WebSocket(`ws://127.0.0.1:${addr.port}?access_token=mock-test-token`);
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
      if (server) {
        await server.stop();
      }
    });

    it('getFriendList: 发送 get_friend_list 动作', async () => {
      const promise = server.getFriendList();
      const req = await new Promise<any>((resolve) => {
        const interval = setInterval(() => {
          const found = received.find((r) => r.action === 'get_friend_list');
          if (found) {
            clearInterval(interval);
            resolve(found);
          }
        }, 10);
      });

      expect(req.action).toBe('get_friend_list');
      client.send(
        JSON.stringify({
          status: 'ok',
          retcode: 0,
          data: [{ user_id: 1000000001, nickname: '张三', remark: '财务小张' }],
          echo: req.echo,
        })
      );
      const res = await promise;
      expect(res.status).toBe('ok');
      expect(res.data).toHaveLength(1);
    });

    it('getGroupList: 发送 get_group_list 动作', async () => {
      const promise = server.getGroupList(true);
      const req = await new Promise<any>((resolve) => {
        const interval = setInterval(() => {
          const found = received.find((r) => r.action === 'get_group_list');
          if (found) {
            clearInterval(interval);
            resolve(found);
          }
        }, 10);
      });

      expect(req.action).toBe('get_group_list');
      expect(req.params).toEqual({ no_cache: true });
      client.send(
        JSON.stringify({
          status: 'ok',
          retcode: 0,
          data: [{ group_id: 8000000001, group_name: '核心研发群' }],
          echo: req.echo,
        })
      );
      const res = await promise;
      expect(res.status).toBe('ok');
      expect(res.data[0].group_id).toBe(8000000001);
    });

    it('getGroupNotice: 必须发送 _get_group_notice 扩展动作 (带前导下划线实测防坑)', async () => {
      const promise = server.getGroupNotice(8000000001);
      const req = await new Promise<any>((resolve) => {
        const interval = setInterval(() => {
          const found = received.find((r) => r.action === '_get_group_notice');
          if (found) {
            clearInterval(interval);
            resolve(found);
          }
        }, 10);
      });

      expect(req.action).toBe('_get_group_notice');
      expect(req.params).toEqual({ group_id: 8000000001 });
      client.send(
        JSON.stringify({
          status: 'ok',
          retcode: 0,
          data: [
            {
              notice_id: 'notice_101',
              sender_id: 1000000002,
              publish_time: 1730700000,
              message: { text: '群公告测试内容' },
            },
          ],
          echo: req.echo,
        })
      );
      const res = await promise;
      expect(res.status).toBe('ok');
      expect(res.data).toHaveLength(1);
    });
  });

  describe('2. get_friend_list 好友查询工具逻辑契约', () => {
    let mockGateway: any;
    const rawFriendsSample = [
      {
        user_id: 1000000001,
        nickname: 'Alice',
        remark: '小爱(助理)',
        long_nick: '随时在线',
        sex: 'female',
        age: 24,
        level: 30,
        phone_num: '13800000000', // 冗余字段应被剥离
        is_qq_vip: true, // 冗余字段应被剥离
      },
      {
        user_id: 1000000002,
        nickname: 'Bob',
        remark: '老鲍(后端)',
        long_nick: '代码与诗',
        sex: 'male',
        age: 32,
        level: 60,
      },
      {
        user_id: 1000000003,
        nickname: 'Charlie',
        remark: '',
        long_nick: '',
        sex: 'unknown',
        age: 0,
        level: 1,
      },
    ];

    beforeEach(() => {
      friendListCache.clearAll();
      mockGateway = {
        getFriendList: async () => ({
          status: 'ok',
          retcode: 0,
          data: rawFriendsSample,
        }),
      };
    });

    it('字段清洗与脱敏契约: 剥离冗余字段，仅保留核心字段且严格符合 Lossless JSON', async () => {
      const res = await queryFriendList({}, { gateway: mockGateway });
      expect(res.success).toBe(true);
      expect(res.friends).toHaveLength(3);
      expect(res.friends[0]).toEqual({
        user_id: '1000000001',
        nickname: 'Alice',
        remark: '小爱(助理)',
        long_nick: '随时在线',
        sex: 'female',
        age: 24,
        level: 30,
      });
      // 确认无冗余字段
      expect((res.friends[0] as any).phone_num).toBeUndefined();
      expect((res.friends[0] as any).is_qq_vip).toBeUndefined();
      // Lossless JSON 检验
      assertNoUndefinedFields(res);
    });

    it('模糊匹配契约: 按 query 模糊搜索昵称或备注名 (不区分大小写)', async () => {
      const res1 = await queryFriendList({ query: '小爱' }, { gateway: mockGateway });
      expect(res1.friends).toHaveLength(1);
      expect(res1.friends[0].user_id).toBe('1000000001');

      const res2 = await queryFriendList({ query: 'bob' }, { gateway: mockGateway });
      expect(res2.friends).toHaveLength(1);
      expect(res2.friends[0].user_id).toBe('1000000002');
      assertNoUndefinedFields(res2);
    });

    it('分页逻辑契约: 支持 offset 与 limit 分页并生成可直接回填的 next_offset', async () => {
      const res = await queryFriendList({ offset: 0, limit: 2 }, { gateway: mockGateway });
      expect(res.friends).toHaveLength(2);
      expect(res.total).toBe(2);
      expect(res.total_matched).toBe(3);
      expect(res.offset).toBe(0);
      expect(res.limit).toBe(2);
      expect(res.has_more).toBe(true);
      expect(res.next_offset).toBe(2);
      expect(res.message).toContain('本次展示序号 1~2');
      expect(res.message).toContain('继续浏览请传入 offset: 2');
      expect((res as any).page).toBeUndefined();
      expect((res as any).total_pages).toBeUndefined();
      assertNoUndefinedFields(res);
    });

    it('offset 翻页与越界契约: 第二页取余量，越界返回空且给出范围提示', async () => {
      const resSecond = await queryFriendList({ offset: 2, limit: 2 }, { gateway: mockGateway });
      expect(resSecond.friends).toHaveLength(1);
      expect(resSecond.friends[0].user_id).toBe('1000000003');
      expect(resSecond.offset).toBe(2);
      expect(resSecond.has_more).toBe(false);
      expect(resSecond.next_offset).toBeUndefined();
      expect(resSecond.message).toContain('已展示至最后一页');

      const resOut = await queryFriendList({ offset: 99, limit: 20 }, { gateway: mockGateway });
      expect(resOut.friends).toHaveLength(0);
      expect(resOut.offset).toBe(99);
      expect(resOut.has_more).toBe(false);
      expect(resOut.message).toContain('超出范围');
      assertNoUndefinedFields(resOut);
    });

    it('确定性排序契约: 好友结果按 user_id 数值升序，不受 OneBot 原始顺序影响', async () => {
      const shuffledGateway = {
        getFriendList: async () => ({
          status: 'ok',
          retcode: 0,
          data: [
            { user_id: 1000000003, nickname: 'C' },
            { user_id: 1000000001, nickname: 'A' },
            { user_id: 1000000002, nickname: 'B' },
          ],
        }),
      };
      friendListCache.clearAll();
      const res = await queryFriendList({}, { gateway: shuffledGateway });
      expect(res.friends.map((f) => f.user_id)).toEqual(['1000000001', '1000000002', '1000000003']);
    });

    it('缓存机制契约: 默认命中内存缓存，no_cache 穿透拉取', async () => {
      let callCount = 0;
      const countingGateway = {
        getFriendList: async () => {
          callCount++;
          return { status: 'ok', retcode: 0, data: rawFriendsSample };
        },
      };

      await queryFriendList({}, { gateway: countingGateway });
      expect(callCount).toBe(1);

      // 第二次调用命中缓存，不增加 callCount
      await queryFriendList({}, { gateway: countingGateway });
      expect(callCount).toBe(1);

      // 携带 no_cache 强制穿透
      await queryFriendList({ no_cache: true }, { gateway: countingGateway });
      expect(callCount).toBe(2);
    });

    it('异常防御契约: 网关离线时如实报错并符合无损 JSON', async () => {
      const res = await queryFriendList({}, { gateway: undefined });
      expect(res.success).toBe(false);
      expect(res.error).toContain('QQ 网关未连接');
      assertNoUndefinedFields(res);
    });

    it('Render 契约: output.render 必须格式化输出好友明细 (含 user_id 与昵称备注)，绝不可仅返回数量汇总', async () => {
      const tool = createGetFriendListTool(() => ({ gateway: mockGateway }));
      const res = await queryFriendList({}, { gateway: mockGateway });
      const rendered = (tool as any).output.render({}, res);
      expect(rendered).toHaveLength(1);
      const text = rendered[0].text;
      // 必须包含具体 QQ 号与昵称明细，大模型才可寻址
      expect(text).toContain('1000000001');
      expect(text).toContain('Alice');
      expect(text).toContain('小爱(助理)');
      expect(text).toContain('1000000002');
      expect(text).toContain('Bob');
      // 必须有跨页连续的全局序号，便于模型直接换算 offset
      expect(text).toContain('1. **Alice**');
      expect(text).toContain('3. **Charlie**');
    });
  });

  describe('3. get_group_list 群聊查询工具逻辑契约', () => {
    let mockGateway: any;
    const rawGroupsSample = [
      {
        group_id: 8000000001,
        group_name: '核心技术交流群',
        group_remark: '技术1群',
        member_count: 88,
        max_member_count: 200,
        group_memo: '提问前看置顶',
        group_create_time: 1585055594,
        group_level: 0, // 冗余
      },
      {
        group_id: 8000000002,
        group_name: '闲聊灌水群',
        group_remark: '',
        member_count: 150,
        max_member_count: 500,
        group_memo: '',
        group_create_time: 1600000000,
      },
    ];

    beforeEach(() => {
      groupListCache.clearAll();
      mockGateway = {
        getGroupList: async () => ({
          status: 'ok',
          retcode: 0,
          data: rawGroupsSample,
        }),
      };
    });

    it('字段清洗与模糊搜索契约: 保留核心字段，按群名或备注检索', async () => {
      const res = await queryGroupList({ query: '技术' }, { gateway: mockGateway });
      expect(res.success).toBe(true);
      expect(res.groups).toHaveLength(1);
      expect(res.groups[0]).toEqual({
        group_id: '8000000001',
        group_name: '核心技术交流群',
        group_remark: '技术1群',
        member_count: 88,
        max_member_count: 200,
        group_memo: '提问前看置顶',
        group_create_time: 1585055594,
      });
      assertNoUndefinedFields(res);
    });

    it('无匹配时的友好提示与无损 JSON', async () => {
      const res = await queryGroupList({ query: '不存在的群聊关键词' }, { gateway: mockGateway });
      expect(res.success).toBe(true);
      expect(res.groups).toHaveLength(0);
      expect(res.total_matched).toBe(0);
      expect(res.message).toBe('未找到符合条件的群聊。');
      assertNoUndefinedFields(res);
    });

    it('Render 契约: output.render 必须格式化输出群明细 (含 group_id、群名与人数)，绝不可仅返回数量汇总', async () => {
      const tool = createGetGroupListTool(() => ({ gateway: mockGateway }));
      const res = await queryGroupList({}, { gateway: mockGateway });
      const rendered = (tool as any).output.render({}, res);
      expect(rendered).toHaveLength(1);
      const text = rendered[0].text;
      // 必须包含具体群号、群名与人数明细
      expect(text).toContain('8000000001');
      expect(text).toContain('核心技术交流群');
      expect(text).toContain('88/200');
      expect(text).toContain('1. **核心技术交流群**');
    });

    it('分页与确定性排序契约: offset/limit 切片按 group_id 升序并返回 next_offset', async () => {
      const shuffledGateway = {
        getGroupList: async () => ({
          status: 'ok',
          retcode: 0,
          data: [
            { group_id: 8000000003, group_name: 'C群', member_count: 3, max_member_count: 200 },
            { group_id: 8000000001, group_name: 'A群', member_count: 1, max_member_count: 200 },
            { group_id: 8000000002, group_name: 'B群', member_count: 2, max_member_count: 200 },
          ],
        }),
      };
      groupListCache.clearAll();
      const first = await queryGroupList({ offset: 0, limit: 2 }, { gateway: shuffledGateway });
      expect(first.groups.map((g) => g.group_id)).toEqual(['8000000001', '8000000002']);
      expect(first.offset).toBe(0);
      expect(first.total_matched).toBe(3);
      expect(first.has_more).toBe(true);
      expect(first.next_offset).toBe(2);

      const second = await queryGroupList({ offset: 2, limit: 2 }, { gateway: shuffledGateway });
      expect(second.groups.map((g) => g.group_id)).toEqual(['8000000003']);
      expect(second.has_more).toBe(false);
      assertNoUndefinedFields(second);
    });
  });

  describe('4. get_user_profile 个人公开资料卡工具契约', () => {
    it('参数校验与字段规范', async () => {
      const mockGateway = {
        getStrangerInfo: async (uid: number | string) => ({
          status: 'ok',
          retcode: 0,
          data: {
            user_id: Number(uid),
            nickname: '测试用户',
            remark: '测试备注',
            sex: 'male',
            age: 26,
            level: 48,
            long_nick: '个性签名文本',
            qid: 'test_alias',
            reg_time: 1200000000,
          },
        }),
      };

      const res = await queryUserProfile({ user_id: '1000000001' }, { gateway: mockGateway });
      expect(res.success).toBe(true);
      expect(res.user_id).toBe('1000000001');
      expect(res.nickname).toBe('测试用户');
      expect(res.remark).toBe('测试备注');
      expect(res.level).toBe(48);
      expect(res.qid).toBe('test_alias');
      assertNoUndefinedFields(res);
    });

    it('未传 user_id 时防御性报错', async () => {
      const res = await queryUserProfile({ user_id: '' }, { gateway: {} as any });
      expect(res.success).toBe(false);
      expect(res.error).toContain('QQ 号不能为空');
      assertNoUndefinedFields(res);
    });
  });

  describe('5. get_group_info 与 get_group_notice 工具契约', () => {
    it('get_group_info: 获取群基础信息与元数据', async () => {
      const mockGateway = {
        getGroupInfo: async (gid: number | string) => ({
          status: 'ok',
          retcode: 0,
          data: {
            group_id: Number(gid),
            group_name: '核心技术群',
            group_remark: '',
            member_count: 60,
            max_member_count: 200,
            group_memo: '群公告摘要',
            group_create_time: 1585055594,
          },
        }),
      };

      const res = await queryGroupInfo({ group_id: '8000000001' }, { gateway: mockGateway });
      expect(res.success).toBe(true);
      expect(res.group_id).toBe('8000000001');
      expect(res.group_name).toBe('核心技术群');
      expect(res.member_count).toBe(60);
      assertNoUndefinedFields(res);
    });

    it('get_group_notice: 扁平化清洗 message.text 并提取结构化公告列表', async () => {
      const mockGateway = {
        getGroupNotice: async (gid: number | string) => ({
          status: 'ok',
          retcode: 0,
          data: [
            {
              notice_id: 'notice_001',
              sender_id: 1000000002,
              publish_time: 1730700000,
              message: {
                text: '【本周重要公告】请大家查阅文档...',
                image: [],
              },
              read_num: 15,
              pinned: 1,
            },
          ],
        }),
      };

      const res = await queryGroupNotice({ group_id: '8000000001' }, { gateway: mockGateway });
      expect(res.success).toBe(true);
      expect(res.group_id).toBe('8000000001');
      expect(res.notices).toHaveLength(1);
      expect(res.notices[0]).toEqual({
        notice_id: 'notice_001',
        sender_id: '1000000002',
        publish_time: 1730700000,
        content: '【本周重要公告】请大家查阅文档...',
        read_num: 15,
        pinned: true,
      });
      assertNoUndefinedFields(res);
    });
  });

  describe('6. 现有查群工具解耦契约 (get_group_member_info)', () => {
    it('显式传入 group_id 时，即使在私聊会话中也能成功查询指定群成员', async () => {
      const mockGateway = {
        getGroupMemberList: async (gid: number | string) => ({
          status: 'ok',
          retcode: 0,
          data: [
            {
              group_id: Number(gid),
              user_id: 1000000001,
              nickname: '小明',
              card: '小明(群名片)',
              role: 'member',
              join_time: 1700000000,
              last_sent_time: 1730000000,
            },
          ],
        }),
      };

      // 模拟在私聊环境中执行 (ctx.peer 为 user_1000000009，但显式指定 group_id: '8000000001')
      const res = await queryGroupMemberInfo(
        { group_id: '8000000001' },
        { gateway: mockGateway as any, peer: 'user_1000000009' }
      );

      expect(res.success).toBe(true);
      expect(res.group_id).toBe('8000000001');
      expect(res.members).toHaveLength(1);
      expect(res.members[0].user_id).toBe('1000000001');
      assertNoUndefinedFields(res);
    });
  });

  describe('7. 真实装配闭环契约', () => {
    it('bootDshNapcatBridge 挂载后 tools 注册表包含全部 5 个社交只读探查工具', async () => {
      const booted = await bootDshNapcatBridge({
        port: 19830,
        auto_connect: false,
      });

      try {
        const provider = (booted.ctx.get('napcatBridgeTools') || (booted.ctx as any).napcatBridgeTools) as any;
        expect(provider).toBeDefined();
        provider.registerTools(booted.ctx);

        const tools = booted.ctx.get('tools') || (booted.ctx as any).tools;
        expect(tools).toBeDefined();
        expect(typeof tools.get).toBe('function');

        // 验证 5 个工具均已注册
        const friendTool = tools.get('get_friend_list');
        expect(friendTool).toBeDefined();
        expect(friendTool.name).toBe('get_friend_list');

        const groupTool = tools.get('get_group_list');
        expect(groupTool).toBeDefined();
        expect(groupTool.name).toBe('get_group_list');

        const profileTool = tools.get('get_user_profile');
        expect(profileTool).toBeDefined();
        expect(profileTool.name).toBe('get_user_profile');

        const groupInfoTool = tools.get('get_group_info');
        expect(groupInfoTool).toBeDefined();
        expect(groupInfoTool.name).toBe('get_group_info');

        const noticeTool = tools.get('get_group_notice');
        expect(noticeTool).toBeDefined();
        expect(noticeTool.name).toBe('get_group_notice');
      } finally {
        await booted.dispose();
      }
    });
  });
});
