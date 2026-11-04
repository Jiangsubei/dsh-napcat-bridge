/**
 * tests/contract/agent-ipc.test.ts
 *
 * 契约测试: 跨 Agent 内部协同体系 (Inter-Agent IPC)
 * (list_active_agents, create_user_agent, send_agent_message)
 *
 * 覆盖规范:
 * 1. 活跃感知契约 (list_active_agents): 正确枚举当前活跃的 Agent 句柄、绑定的会话类型与繁忙状态
 * 2. 专属成员常驻契约 (create_user_agent): 目标用户首次创建或唤醒常驻 Agent，注入初始系统使命，返回 session_id
 * 3. 内部通信与回传契约 (send_agent_message): 投递内部消息，真人和 QQ 端不可见，携带 reply_to_session 原路闭环
 * 4. 并发排队与引导契约: 复用底层 new_message_behavior，平滑调度
 * 5. DSH Lossless JSON 红线契约: 断言所有工具执行结果绝不包含 undefined
 * 6. 真实装配闭环契约: bootDshNapcatBridge 挂载后 tools 注册表包含全部 3 个 IPC 工具
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  queryActiveAgents,
  createUserAgent,
  sendAgentMessage,
  createListActiveAgentsTool,
  createCreateUserAgentTool,
  createSendAgentMessageTool,
} from '../../src/tools/agent-ipc.js';
import { bootDshNapcatBridge } from '../../src/boot.js';

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

describe('契约测试: 跨 Agent 内部协同体系 (Agent IPC)', () => {
  let mockSessionManager: any;
  let dispatchedPayloads: any[] = [];

  beforeEach(() => {
    dispatchedPayloads = [];
    mockSessionManager = {
      getActiveHandleKeys: () => ['qq-user-1000000001', 'qq-group-8000000001'][Symbol.iterator](),
      sessionIdToPeer: (sid: string) => {
        if (sid.startsWith('qq-user-')) return `user_${sid.slice(8)}`;
        if (sid.startsWith('qq-group-')) return `group_${sid.slice(9)}`;
        return sid;
      },
      peerToSessionId: (peer: string) => {
        if (peer.startsWith('user_')) return `qq-user-${peer.slice(5)}`;
        if (peer.startsWith('group_')) return `qq-group-${peer.slice(6)}`;
        return peer;
      },
      isSessionBusy: (sid: string) => sid === 'qq-group-8000000001',
      hasActiveHandle: (sid: string) => ['qq-user-1000000001', 'qq-group-8000000001'].includes(sid),
      isSessionActiveOrPresent: (sid: string) => ['qq-user-1000000001', 'qq-group-8000000001'].includes(sid),
      getSessionDisplayName: (sid: string) => {
        if (sid.includes('1000000001')) return '财务小张';
        if (sid.includes('8000000001')) return '核心研发群';
        return undefined;
      },
      getOrCreateAgent: async (peer: string) => ({
        session: { id: peer.startsWith('user_') ? `qq-user-${peer.slice(5)}` : `qq-group-${peer.slice(6)}` },
      }),
      dispatchWakeup: async (payload: any) => {
        dispatchedPayloads.push(payload);
        return { id: 'msg_mock_001' };
      },
    };
  });

  describe('1. list_active_agents 活跃感知契约', () => {
    it('正确枚举活跃会话元数据，包括 session_id, peer, target_type, target_id 与 is_busy', async () => {
      const res = await queryActiveAgents({}, { sessionManager: mockSessionManager });
      expect(res.success).toBe(true);
      expect(res.agents).toHaveLength(2);
      expect(res.agents[0]).toEqual({
        session_id: 'qq-user-1000000001',
        peer: 'user_1000000001',
        target_type: 'user',
        target_id: '1000000001',
        is_busy: false,
        name: '财务小张',
      });
      expect(res.agents[1]).toEqual({
        session_id: 'qq-group-8000000001',
        peer: 'group_8000000001',
        target_type: 'group',
        target_id: '8000000001',
        is_busy: true,
        name: '核心研发群',
      });
      assertNoUndefinedFields(res);
    });

    it('支持按 target_type 进行类型筛选', async () => {
      const res = await queryActiveAgents({ target_type: 'user' }, { sessionManager: mockSessionManager });
      expect(res.success).toBe(true);
      expect(res.agents).toHaveLength(1);
      expect(res.agents[0].target_type).toBe('user');
      expect(res.agents[0].session_id).toBe('qq-user-1000000001');
      assertNoUndefinedFields(res);
    });

    it('过滤归档与僵尸契约: 已归档或已标记为僵尸的 Session ID 绝不出现在活跃列表中', async () => {
      mockSessionManager.isSessionArchived = (sid) => sid === 'qq-user-1000000001';
      const res = await queryActiveAgents({}, { sessionManager: mockSessionManager });
      expect(res.success).toBe(true);
      expect(res.agents).toHaveLength(1);
      expect(res.agents[0].session_id).toBe('qq-group-8000000001');
      assertNoUndefinedFields(res);
    });

    it('轮换旧版本过滤契约: 若某 peer 已发生会话轮换，旧版本 Session ID 绝不出现在活跃列表中', async () => {
      // 模拟 activeKeys 中残留旧 session，但 peerToSessionId 已指向新版本 _v2
      mockSessionManager.getActiveHandleKeys = () => ['qq-user-1000000001', 'qq-group-8000000001'][Symbol.iterator]();
      mockSessionManager.peerToSessionId = (peer) => peer === 'user_1000000001' ? 'qq-user-1000000001_v2' : 'qq-group-8000000001';

      const res = await queryActiveAgents({}, { sessionManager: mockSessionManager });
      expect(res.success).toBe(true);
      // 旧版 qq-user-1000000001 被过滤，只剩 qq-group-8000000001
      expect(res.agents).toHaveLength(1);
      expect(res.agents[0].session_id).toBe('qq-group-8000000001');
      assertNoUndefinedFields(res);
    });

    it('工作区会话全量枚举契约: 优先调用 getAllQQSessionIds / getActiveSessionIds 覆盖工作区已建会话，即使内存无活跃 handle 也可精准发现', async () => {
      // 模拟 activeHandles 为空 (例如服务重启后刚启动，尚未唤醒 handle)
      mockSessionManager.getActiveHandleKeys = () => [][Symbol.iterator]();
      // 但在 DSH 工作区 / SQLite / 会话服务中存在 3 个会话 (使用标准脱敏测试 Mock ID 与名称)
      mockSessionManager.getAllQQSessionIds = () => [
        'qq-user-1000000003',
        'qq-group-8000000002',
        'qq-group-8000000003',
      ];
      mockSessionManager.sessionIdToPeer = (sid) => {
        if (sid.startsWith('qq-user-')) return `user_${sid.slice(8)}`;
        if (sid.startsWith('qq-group-')) return `group_${sid.slice(9)}`;
        return sid;
      };
      mockSessionManager.peerToSessionId = (peer) => {
        if (peer.startsWith('user_')) return `qq-user-${peer.slice(5)}`;
        if (peer.startsWith('group_')) return `qq-group-${peer.slice(6)}`;
        return peer;
      };
      mockSessionManager.getSessionDisplayName = (sid) => {
        if (sid.includes('1000000003')) return '测试好友C';
        if (sid.includes('8000000002')) return '技术测试群B';
        if (sid.includes('8000000003')) return '闲聊测试群C';
        return undefined;
      };

      const res = await queryActiveAgents({}, { sessionManager: mockSessionManager });
      expect(res.success).toBe(true);
      expect(res.agents).toHaveLength(3);
      expect(res.agents[0].session_id).toBe('qq-user-1000000003');
      expect(res.agents[0].name).toBe('测试好友C');
      expect(res.agents[1].session_id).toBe('qq-group-8000000002');
      expect(res.agents[1].name).toBe('技术测试群B');
      expect(res.agents[2].session_id).toBe('qq-group-8000000003');
      expect(res.agents[2].name).toBe('闲聊测试群C');
      assertNoUndefinedFields(res);
    });

    it('Render 契约: output.render 格式化输出活跃 Agent 明细列表 (含 Session ID、名称、类型、QQ号/群号与 IPC 提示语)', async () => {
      const tool = createListActiveAgentsTool(() => ({ sessionManager: mockSessionManager }));
      const res = await queryActiveAgents({}, { sessionManager: mockSessionManager });
      const rendered = (tool as any).output.render({}, res);
      expect(rendered).toHaveLength(1);
      const text = rendered[0].text;
      expect(text).toContain('活跃 QQ Agent 列表');
      expect(text).toContain('qq-user-1000000001');
      expect(text).toContain('财务小张');
      expect(text).toContain('qq-group-8000000001');
      expect(text).toContain('核心研发群');
      expect(text).toContain('send_agent_message');
    });
  });

  describe('2. create_user_agent 用户常驻 Agent 创建契约', () => {
    it('首次创建: 用户此前无专属 Agent 时真正创建并注入初始指令，返回 created: true', async () => {
      const res = await createUserAgent(
        {
          user_id: '1000000002',
          initial_message: '主人安排向你询问发票单号，请协助私聊跟进。',
        },
        {
          sessionManager: mockSessionManager,
          sessionId: 'qq-group-8000000001',
        }
      );

      expect(res.success).toBe(true);
      expect(res.created).toBe(true);
      expect(res.session_id).toBe('qq-user-1000000002');
      expect(res.peer).toBe('user_1000000002');
      expect(res.user_id).toBe('1000000002');

      // 验证唤醒 Payload
      expect(dispatchedPayloads).toHaveLength(1);
      const payload = dispatchedPayloads[0];
      expect(payload.peer).toBe('user_1000000002');
      expect(payload.trigger).toBe('internal_agent');
      expect(payload.content).toBe('主人安排向你询问发票单号，请协助私聊跟进。');
      expect(payload.from_session).toBe('qq-group-8000000001');
      assertNoUndefinedFields(res);
    });

    it('已存在抑制契约: 用户已存在活跃 Agent 时返回 created: false 并告知 Session ID，绝不重复发送消息', async () => {
      // 模拟 1000000001 已存在于 active handles 中
      mockSessionManager.hasActiveHandle = (sid) => sid === 'qq-user-1000000001';

      const res = await createUserAgent(
        {
          user_id: '1000000001',
          initial_message: '重复消息',
        },
        {
          sessionManager: mockSessionManager,
          sessionId: 'qq-group-8000000001',
        }
      );

      expect(res.success).toBe(true);
      expect(res.created).toBe(false);
      expect(res.session_id).toBe('qq-user-1000000001');
      expect(res.message).toContain('已存在专属 Agent');
      expect(res.message).toContain('send_agent_message');

      // 验证绝不触发 dispatchWakeup，保持消息通道唯一归属于 send_agent_message
      expect(dispatchedPayloads).toHaveLength(0);
      assertNoUndefinedFields(res);
    });

    it('归档或僵尸失效契约: 若已存在记录已被归档或为僵尸，重新走首次创建与注入链路', async () => {
      mockSessionManager.hasActiveHandle = (sid) => sid === 'qq-user-1000000001';
      // 标记为已归档
      mockSessionManager.isSessionArchived = (sid) => sid === 'qq-user-1000000001';

      const res = await createUserAgent(
        {
          user_id: '1000000001',
          initial_message: '重新创建消息',
        },
        {
          sessionManager: mockSessionManager,
          sessionId: 'qq-group-8000000001',
        }
      );

      expect(res.success).toBe(true);
      expect(res.created).toBe(true);
      expect(res.session_id).toBe('qq-user-1000000001');
      expect(dispatchedPayloads).toHaveLength(1);
      assertNoUndefinedFields(res);
    });

    it('未传 user_id 或 initial_message 时防御性拦截', async () => {
      const res1 = await createUserAgent({ user_id: '', initial_message: 'test' }, { sessionManager: mockSessionManager });
      expect(res1.success).toBe(false);
      expect(res1.error).toContain('QQ 号不能为空');
      assertNoUndefinedFields(res1);

      const res2 = await createUserAgent({ user_id: '1000000001', initial_message: '' }, { sessionManager: mockSessionManager });
      expect(res2.success).toBe(false);
      expect(res2.error).toContain('初始消息不能为空');
      assertNoUndefinedFields(res2);
    });

    it('真实装配契约: execute 从 exec.agent.session.id 注入发起方 Session ID，不依赖全局上下文', async () => {
      const tool = createCreateUserAgentTool(() => ({ sessionManager: mockSessionManager }));

      const res = await (tool as any).execute(
        { user_id: '1000000002', initial_message: '请跟进发票单号' },
        { agent: { session: { id: 'qq-user-1000000001' } } }
      );

      expect(res.success).toBe(true);
      expect(res.created).toBe(true);
      expect(dispatchedPayloads).toHaveLength(1);
      expect(dispatchedPayloads[0].from_session).toBe('qq-user-1000000001');
      assertNoUndefinedFields(res);
    });
  });

  describe('3. send_agent_message 内部通信与成果交付契约', () => {
    it('向目标 Session ID 投递内部消息，自动注入发起方 sessionId 作为来源', async () => {
      const res = await sendAgentMessage(
        {
          target_session_id: 'qq-group-8000000001',
          message: '已获取到发票单号：FP-889900',
        },
        {
          sessionManager: mockSessionManager,
          sessionId: 'qq-user-1000000002',
        }
      );

      expect(res.success).toBe(true);
      expect(res.delivered).toBe(true);
      expect(res.target_session_id).toBe('qq-group-8000000001');

      expect(dispatchedPayloads).toHaveLength(1);
      const payload = dispatchedPayloads[0];
      expect(payload.peer).toBe('group_8000000001');
      expect(payload.trigger).toBe('internal_agent');
      expect(payload.content).toBe('已获取到发票单号：FP-889900');
      expect(payload.from_session).toBe('qq-user-1000000002');
      assertNoUndefinedFields(res);
    });

    it('未传 target_session_id 或 message 时防御性拦截', async () => {
      const res = await sendAgentMessage({ target_session_id: '', message: 'hi' }, { sessionManager: mockSessionManager });
      expect(res.success).toBe(false);
      expect(res.error).toContain('目标 Session ID 不能为空');
      assertNoUndefinedFields(res);
    });

    it('归一化幂等契约: 非法 Session ID 明确拦截，绝不再拼出 qq-agent / qq-qq-agent 幽灵会话', async () => {
      for (const bogus of ['agent', 'qq-agent']) {
        const res = await sendAgentMessage(
          { target_session_id: bogus, message: '回执测试' },
          { sessionManager: mockSessionManager, sessionId: 'qq-user-1000000002' }
        );
        expect(res.success).toBe(false);
        expect(res.error).toContain('不是合法的 QQ 会话标识');
        expect(res.error).not.toContain('最新活跃会话');
        expect(res.error).not.toContain('qq-qq-agent');
      }
      expect(dispatchedPayloads).toHaveLength(0);
    });

    it('真实装配契约: execute 从 exec.agent.session.id 注入发起方 Session ID，回执地址绝不为字面量 agent', async () => {
      const tool = createSendAgentMessageTool(() => ({ sessionManager: mockSessionManager }));

      const res = await (tool as any).execute(
        { target_session_id: 'qq-group-8000000001', message: '111 已落地' },
        { agent: { session: { id: 'qq-user-1000000002' } } }
      );

      expect(res.success).toBe(true);
      expect(res.delivered).toBe(true);
      expect(dispatchedPayloads).toHaveLength(1);
      expect(dispatchedPayloads[0].from_session).toBe('qq-user-1000000002');
      expect(dispatchedPayloads[0].from_user).toBe('qq-user-1000000002');
      expect(dispatchedPayloads[0].from_user).not.toBe('agent');
      assertNoUndefinedFields(res);
    });

    it('旧版本轮换拦截契约: 向已不是最新活跃的旧 Session ID 发送消息时明确报错并告知最新 ID', async () => {
      // 模拟用户已创建新版本会话 _v2
      mockSessionManager.peerToSessionId = (peer) =>
        peer === 'user_1000000001' ? 'qq-user-1000000001_v2' : peer;

      const res = await sendAgentMessage(
        {
          target_session_id: 'qq-user-1000000001',
          message: '向旧会话发送消息',
        },
        {
          sessionManager: mockSessionManager,
          sessionId: 'qq-group-8000000001',
        }
      );

      expect(res.success).toBe(false);
      expect(res.error).toContain('已不是最新活跃会话');
      expect(res.error).toContain('qq-user-1000000001_v2');
      expect(res.error).toContain('list_active_agents');
      expect(dispatchedPayloads).toHaveLength(0);
      assertNoUndefinedFields(res);
    });

    it('归档拦截契约: 向已被归档的 Session ID 发送消息时拦截并提示重新查询', async () => {
      mockSessionManager.isSessionArchived = (sid) => sid === 'qq-user-1000000001';

      const res = await sendAgentMessage(
        {
          target_session_id: 'qq-user-1000000001',
          message: '向已归档会话发消息',
        },
        {
          sessionManager: mockSessionManager,
          sessionId: 'qq-group-8000000001',
        }
      );

      expect(res.success).toBe(false);
      expect(res.error).toContain('已被归档');
      expect(res.error).toContain('list_active_agents');
      expect(dispatchedPayloads).toHaveLength(0);
      assertNoUndefinedFields(res);
    });

    it('未激活拦截契约: 向从未创建或未处于活跃状态的 Session ID 发送消息时拦截并提示调用 create_user_agent', async () => {
      mockSessionManager.hasActiveHandle = () => false;
      mockSessionManager.isSessionActiveOrPresent = () => false;

      const res = await sendAgentMessage(
        {
          target_session_id: 'qq-user-9999999999',
          message: '向未激活用户发消息',
        },
        {
          sessionManager: mockSessionManager,
          sessionId: 'qq-group-8000000001',
        }
      );

      expect(res.success).toBe(false);
      expect(res.error).toContain('尚未激活或不存在');
      expect(res.error).toContain('create_user_agent');
      expect(dispatchedPayloads).toHaveLength(0);
      assertNoUndefinedFields(res);
    });
  });

  describe('4. 真实装配闭环契约', () => {
    it('bootDshNapcatBridge 挂载后 tools 注册表包含全部 3 个 IPC 工具', async () => {
      const booted = await bootDshNapcatBridge({
        port: 19835,
        auto_connect: false,
      });

      try {
        const provider = (booted.ctx.get('napcatBridgeTools') || (booted.ctx as any).napcatBridgeTools) as any;
        expect(provider).toBeDefined();
        provider.registerTools(booted.ctx);

        const tools = booted.ctx.get('tools') || (booted.ctx as any).tools;
        expect(tools).toBeDefined();

        const listTool = tools.get('list_active_agents');
        expect(listTool).toBeDefined();
        expect(listTool.name).toBe('list_active_agents');

        const createTool = tools.get('create_user_agent');
        expect(createTool).toBeDefined();
        expect(createTool.name).toBe('create_user_agent');

        const sendTool = tools.get('send_agent_message');
        expect(sendTool).toBeDefined();
        expect(sendTool.name).toBe('send_agent_message');
      } finally {
        await booted.dispose();
      }
    });
  });
});
