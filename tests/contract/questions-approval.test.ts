import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fsp } from 'node:fs';
import { bootDshNapcatBridge, type BootedDsh } from '../../src/boot.js';
import {
  NapCatQuestionProvider,
  NapCatApprovalResponder,
  registerNapCatQuestionChannel,
} from '../../src/approval/responder.js';

describe('契约测试: 提问与审批官方 Provider 状态机协同 (Questions & Approval Contract)', () => {
  let tmpHome: string;
  let booted: BootedDsh;

  beforeEach(async () => {
    tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-napcat-qa-'));
    booted = await bootDshNapcatBridge({
      dshHome: tmpHome,
      mountPlugin: false,
    });
  });

  afterEach(async () => {
    if (booted) {
      await booted.dispose().catch(() => {});
    }
    if (tmpHome) {
      await fsp.rm(tmpHome, { recursive: true, force: true }).catch(() => {});
    }
  });

  const QQ_AGENT = { session: { id: 'qq-group-3000000001' } } as any;

  it('A2-契约 1: 无 peer/gateway 时提问必须抛错，绝不自动作答替 agent 决策 (需求 §0.0)', async () => {
    const provider = new NapCatQuestionProvider();
    await expect(
      provider.ask({
        agent: QQ_AGENT,
        questions: [{ id: 'q1', question: '请选择部署环境' }],
      } as any)
    ).rejects.toThrow(/NapCat 未连接|未解析到 QQ 会话/);
  });

  it('A2-契约 2: 提问发送失败必须 reject，不进入无限挂起 (B4)', async () => {
    const provider = new NapCatQuestionProvider({
      gateway: {
        sendMsg: async () => {
          throw new Error('NapCat socket closed');
        },
      } as any,
      sessionManager: {
        sessionIdToPeer: (id: string) => `group_${id.slice(9)}`,
      } as any,
    });

    await expect(
      provider.ask({
        questions: [{ id: 'q1', question: '请选择' }],
        agent: QQ_AGENT,
      } as any)
    ).rejects.toThrow(/发送提问消息到 group_3000000001 失败.*closed/);
  });

  it('A2-契约 3: 审批无 peer/gateway 直接拒绝，不替用户放行也不挂起', async () => {
    const responder = new NapCatApprovalResponder();
    const decision = await responder.handleApprovalRequest({
      peer: 'group_3000000001',
      toolName: 'execute_bash',
      reason: '测试',
    });
    expect(decision).toBe('rejected');

    const decision2 = await responder.handleApprovalRequest({
      peer: '',
      toolName: 'execute_bash',
      reason: '测试',
    });
    expect(decision2).toBe('rejected');
  });

  it('B2-契约 1: 官方 user-questions/request waterfall 接入与注销契约', async () => {
    const p1 = new NapCatQuestionProvider();
    const unregister1 = registerNapCatQuestionChannel(booted.ctx, { questionProvider: p1 });
    expect(typeof unregister1).toBe('function');

    const p2 = new NapCatQuestionProvider();
    const unregister2 = registerNapCatQuestionChannel(booted.ctx, { questionProvider: p2 });
    expect(typeof unregister2).toBe('function');

    unregister1();
    unregister2();
  });

  it('B4/A3-契约 4: 提问经共享串行队列成功投递后，可由 QQ 端回复正常流转闭环', async () => {
    const order: string[] = [];
    const gateway = {
      sendMsg: async (_peer: string, msg: any) => {
        order.push(typeof msg === 'string' ? msg : JSON.stringify(msg));
        return { status: 'ok', retcode: 0, data: { message_id: 1 } };
      },
    };
    const sessionManager = {
      sessionIdToPeer: (id: string) => `group_${id.slice(9)}`,
    } as any;
    const provider = new NapCatQuestionProvider({
      gateway: gateway as any,
      sessionManager,
    });

    const askPromise = provider.ask({
      questions: [{ id: 'q1', prompt: '请选择部署环境' }],
      agent: QQ_AGENT,
      signal: new AbortController().signal,
    } as any);

    // 等待提问消息真正抵达 gateway 后再应答（否则 pendingByPeer 未就绪）
    await new Promise((resolve) => setTimeout(resolve, 20));
    // 群聊引用锚定（用户拍板方案 A）：未引用卡片的回复不命中（当普通消息流转）
    expect(provider.handleInboundReply('group_3000000001', '2')).toBe(false);
    // 群聊引用「当前提问卡片那条消息」(message_id=1) 才命中并闭环
    const handled = provider.handleInboundReply('group_3000000001', '1', { replyId: 1 });
    expect(handled).toBe(true);

    const answer = await askPromise;
    expect(answer.answers[0]).toBeDefined();
    expect(order.some((m) => m.includes('【请回答问题】'))).toBe(true);
  });

  it('契约 6: NapCatApprovalResponder 拦截审批请求并响应 y/n 决策', async () => {
    const responder = new NapCatApprovalResponder();

    const approvalPromise = responder.handleApprovalRequest({
      peer: 'group_3000000001',
      toolName: 'execute_dangerous_bash',
      reason: '清理构建缓存',
    });

    // 无 gateway 时直接拒绝（见 A2-契约 3），此处提供 gateway 后走正常流转
    const responder2 = new NapCatApprovalResponder({
      gateway: {
        sendMsg: async () => ({ status: 'ok', retcode: 0, data: {} }),
      } as any,
    });
    const approvalPromise2 = responder2.handleApprovalRequest({
      peer: 'group_3000000001',
      toolName: 'execute_dangerous_bash',
      reason: '清理构建缓存',
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(responder2.handleInboundReply('group_3000000001', 'y')).toBe(true);
    const decision = await approvalPromise2;
    expect(decision).toBe('allowed-once');

    const rejected = await approvalPromise;
    expect(rejected).toBe('rejected');
  });
});