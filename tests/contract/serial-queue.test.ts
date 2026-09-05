import { describe, it, expect } from 'vitest';
import { PerPeerSerialSender } from '../../src/outbound/queue.js';
import { NapCatQuestionProvider, NapCatApprovalResponder } from '../../src/approval/responder.js';

describe('契约测试: 共享 per-peer 串行发送器保序 (Spec §7.3 / P-02, A-3)', () => {
  const PEER = 'group_3000000001';
  const QQ_AGENT = { session: { id: 'qq-group-3000000001' } } as any;

  it('A3-契约 1: 同一 peer 任务严格按入队顺序执行（前置任务延迟不插队）', async () => {
    const order: string[] = [];
    const sender = new PerPeerSerialSender();

    const tasks = [1, 2, 3].map((n) =>
      sender.enqueue(PEER, async () => {
        // 前置任务人为制造延迟，验证队列强制等待
        await new Promise((r) => setTimeout(r, n === 1 ? 40 : 5));
        order.push(n);
      })
    );

    await Promise.all(tasks);
    expect(order).toEqual([1, 2, 3]);
  });

  it('A3-契约 2: 不同 peer 互不阻塞（独立队列）', async () => {
    const order: string[] = [];
    const sender = new PerPeerSerialSender();

    const p1 = sender.enqueue('group_1', async () => {
      await new Promise((r) => setTimeout(r, 40));
      order.push('group_1');
    });
    const p2 = sender.enqueue('group_2', async () => {
      order.push('group_2');
    });

    await Promise.all([p1, p2]);
    // group_2 不等待 group_1 的延迟任务
    expect(order[0]).toBe('group_2');
  });

  it('A3-契约 3: 前置任务失败不阻塞后续任务，且调用方仍收到拒绝', async () => {
    const order: string[] = [];
    const sender = new PerPeerSerialSender();

    const failing = sender.enqueue(PEER, async () => {
      throw new Error('boom');
    });
    const next = sender.enqueue(PEER, async () => {
      order.push('after-failure');
    });

    await expect(failing).rejects.toThrow('boom');
    await next;
    expect(order).toEqual(['after-failure']);
  });

  it('A3-契约 4: 正文 → 提问 → 审批 经同一队列严格保序（先文本后提问、先提问后审批）', async () => {
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

    const sender = new PerPeerSerialSender();
    const provider = new NapCatQuestionProvider({
      gateway: gateway as any,
      sessionManager,
      sender,
    });
    const responder = new NapCatApprovalResponder({
      gateway: gateway as any,
      sessionManager,
      sender,
    });

    // 1. 正文回复（出站桥接器使用同一 sender 契约）——首任务带 30ms 延迟，验证队列强制等待
    const textPromise = sender.enqueue(PEER, async () => {
      await new Promise((r) => setTimeout(r, 30));
      await gateway.sendMsg(PEER, '正文回复内容');
    });

    // 2. 提问（不等待完成，立即发起）
    const askPromise = provider.ask({
      questions: [{ id: 'q1', prompt: '请选择部署环境', options: [{ label: '生产' }, { label: '测试' }] }],
      agent: QQ_AGENT,
      signal: new AbortController().signal,
    } as any);

    // 3. 审批（立即发起）
    const approvalPromise = responder.handleApprovalRequest({
      peer: PEER,
      toolName: 'execute_bash',
      reason: '清理缓存',
      signal: new AbortController().signal,
    });

    // 等待消息全部抵达后再应答
    await new Promise((resolve) => setTimeout(resolve, 80));
    responder.handleInboundReply(PEER, 'y');
    // 群聊引用锚定（用户拍板方案 A）：回复必须引用提问卡片那条消息 (message_id=1)
    provider.handleInboundReply(PEER, '1', { replyId: 1 });

    await textPromise;
    await askPromise;
    await approvalPromise;

    const textIdx = order.findIndex((m) => m.includes('正文回复内容'));
    const questionIdx = order.findIndex((m) => m.includes('【请回答问题】'));
    const approvalIdx = order.findIndex((m) => m.includes('【审批请求】'));

    expect(textIdx).toBeGreaterThanOrEqual(0);
    expect(questionIdx).toBeGreaterThan(textIdx); // 先文本后提问
    expect(approvalIdx).toBeGreaterThan(questionIdx); // 先提问后审批
  });
});