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
      });
      expect(res.agents[1]).toEqual({
        session_id: 'qq-group-8000000001',
        peer: 'group_8000000001',
        target_type: 'group',
        target_id: '8000000001',
        is_busy: true,
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
  });

  describe('2. create_user_agent 用户常驻 Agent 创建契约', () => {
    it('为指定用户创建常驻 Agent 并注入初始指令，返回 session_id', async () => {
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
