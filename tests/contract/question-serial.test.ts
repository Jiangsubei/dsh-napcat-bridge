import { describe, it, expect } from 'vitest';
import { NapCatQuestionProvider } from '../../src/approval/responder.js';

/**
 * 契约测试: 串行多题问答状态机 + 卡片分场景展示 + 回复解析 (Ask Serial Contract)
 *
 * 测试引用 src 真实模块（responder.ts），gateway/sessionManager 桩仅隔离外部依赖：
 * - 串行多题：N 道题只渲染第 1 题 → 逐题推进 → 最后一道答完一次性 resolve 全部答案；
 * - 群聊引用锚定：只有引用当前题卡片消息的回复命中；
 * - 2 档卡片拼接：私聊/群聊操作提示两档、恒带「自定义回答」标记项；
 * - 回复解析（用户拍板）：单选序号命中/越界当自定义、多选分段解析、纯自走 constant、纯数字区间匹配。
 */

const GROUP_PEER = 'group_3000000001';
const QQ_GROUP_AGENT = { id: 'qq-group-3000000001', session: { id: 'qq-group-3000000001' } } as any;
const QQ_USER_AGENT = { id: 'qq-user-2000000001', session: { id: 'qq-user-2000000001' } } as any;

function makeGateway(sendMsgImpl?: (peer: string, msg: any) => Promise<any>) {
  const sends: Array<{ peer: string; message: any; message_id?: number | string }> = [];
  let seq = 1000;
  const gateway = {
    sends,
    sendMsg: async (peer: string, message: any) => {
      if (sendMsgImpl) {
        const res = await sendMsgImpl(peer, message);
        sends.push({ peer, message, message_id: (res as any)?.data?.message_id });
        return res;
      }
      seq += 1;
      const res = { status: 'ok', retcode: 0, data: { message_id: seq } };
      sends.push({ peer, message, message_id: seq });
      return res;
    },
  };
  return gateway;
}

function makeProvider(gateway: any, sessionToPeer: (id: string) => string) {
  return new NapCatQuestionProvider({
    gateway,
    sessionManager: { sessionIdToPeer: sessionToPeer } as any,
  });
}

describe('契约测试: 串行多题问答状态机 (Serial Multi-Question Ask)', () => {
  it('3 道题逐题答完 → 每次只发当前题卡片，最后一次性 resolve 含 3 个 answer', async () => {
    const gateway = makeGateway();
    const provider = makeProvider(gateway, (id) => `user_${id.slice(8)}`);

    const askPromise = provider.ask({
      agent: QQ_USER_AGENT,
      questions: [
        { id: 'q1', question: '问题一', options: [{ label: 'A' }, { label: 'B' }] },
        { id: 'q2', question: '问题二', options: [{ label: 'C' }, { label: 'D' }] },
        { id: 'q3', question: '问题三' },
      ],
      signal: new AbortController().signal,
    } as any);

    // 只发了第 1 题卡片（不含第 2/3 题内容）
    await new Promise((r) => setTimeout(r, 10));
    expect(gateway.sends).toHaveLength(1);
    expect(gateway.sends[0].message).toContain('问题一');
    expect(gateway.sends[0].message).not.toContain('问题二');
    expect(gateway.sends[0].message).not.toContain('问题三');

    // 答第 1 题（私聊无需引用）→ 立即发第 2 题卡片，agent 未 resolve 不丢
    let settled = false;
    void askPromise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );
    expect(provider.handleInboundReply('user_2000000001', '2')).toBe(true);
    await new Promise((r) => setTimeout(r, 10));
    // 答完第 1 题，应收到第 1 题回执 + 下发第 2 题卡片
    expect(gateway.sends.map((s) => s.message)).toContain('已收到第 1/3 题回答');
    expect(gateway.sends.some((s) => s.message.includes('问题二'))).toBe(true);
    expect(settled).toBe(false);

    // 答第 2 题 → 收到第 2 题回执 + 发第 3 题卡片
    expect(provider.handleInboundReply('user_2000000001', '1')).toBe(true);
    await new Promise((r) => setTimeout(r, 10));
    expect(gateway.sends.map((s) => s.message)).toContain('已收到第 2/3 题回答');
    expect(gateway.sends.some((s) => s.message.includes('问题三'))).toBe(true);
    expect(settled).toBe(false);

    // 答第 3 题（纯自定义，无选项）→ 收到最终回执“已成功回答”并一次性 resolve 3 个 answer
    expect(provider.handleInboundReply('user_2000000001', '自定义内容')).toBe(true);
    await new Promise((r) => setTimeout(r, 10));
    expect(gateway.sends.map((s) => s.message)).toContain('已成功回答');
    const answer = await askPromise;
    expect(settled).toBe(true);
    expect(answer.answers).toHaveLength(3);
    expect(answer.answers[0]).toEqual({ id: 'q1', selected: ['B'] });
    expect(answer.answers[1]).toEqual({ id: 'q2', selected: ['C'] });
    expect(answer.answers[2]).toEqual({ id: 'q3', selected: [], custom: '自定义内容' });
  });

  it('单道题问答：答完直接回复“已成功回答”', async () => {
    const gateway = makeGateway();
    const provider = makeProvider(gateway, (id) => `user_${id.slice(8)}`);

    const askPromise = provider.ask({
      agent: QQ_USER_AGENT,
      questions: [{ id: 'q1', question: '确认操作？', options: [{ label: '是' }, { label: '否' }] }],
      signal: new AbortController().signal,
    } as any);

    await new Promise((r) => setTimeout(r, 10));
    expect(gateway.sends).toHaveLength(1);

    expect(provider.handleInboundReply('user_2000000001', '1')).toBe(true);
    await new Promise((r) => setTimeout(r, 10));

    expect(gateway.sends.map((s) => s.message)).toContain('已成功回答');
    const res = await askPromise;
    expect(res.answers[0].selected).toEqual(['是']);
  });

  it('群聊引用锚定：未引用 / 引用错误消息不 consume；引用当前题卡片才命中并逐题推进', async () => {
    const gateway = makeGateway();
    const provider = makeProvider(gateway, (id) => `group_${id.slice(9)}`);

    const askPromise = provider.ask({
      agent: QQ_GROUP_AGENT,
      questions: [
        { id: 'q1', question: '问题一', options: [{ label: 'A' }, { label: 'B' }] },
        { id: 'q2', question: '问题二', options: [{ label: 'C' }, { label: 'D' }] },
      ],
      signal: new AbortController().signal,
    } as any);

    await new Promise((r) => setTimeout(r, 10));
    const card1Id = gateway.sends[0].message_id; // 1001（stub 自增）

    // 未引用 → false（普通消息，可进唤醒/队列）
    expect(provider.handleInboundReply(GROUP_PEER, '1')).toBe(false);
    // 引用错误消息 → false
    expect(provider.handleInboundReply(GROUP_PEER, '1', { replyId: 999 })).toBe(false);
    // 引用当前题卡片 → 命中，推进第 2 题
    expect(provider.handleInboundReply(GROUP_PEER, '1', { replyId: card1Id })).toBe(true);
    await new Promise((r) => setTimeout(r, 10));
    expect(gateway.sends.map((s) => s.message)).toContain('已收到第 1/2 题回答');

    await new Promise((r) => setTimeout(r, 10));
    const card2Id = gateway.sends[gateway.sends.length - 1].message_id;
    // 第 2 题仍须引用它自己的卡片（引用第 1 题卡片不命中）
    expect(provider.handleInboundReply(GROUP_PEER, '1', { replyId: card1Id })).toBe(false);
    expect(provider.handleInboundReply(GROUP_PEER, '2', { replyId: card2Id })).toBe(true);

    const answer = await askPromise;
    expect(answer.answers[0]).toEqual({ id: 'q1', selected: ['A'] });
    expect(answer.answers[1]).toEqual({ id: 'q2', selected: ['D'] });
  });

  it('abort 串行中途生效：第 1 题答完挂起第 2 题时 abort → 清理 pending + reject', async () => {
    const gateway = makeGateway();
    const provider = makeProvider(gateway, (id) => `user_${id.slice(8)}`);
    const controller = new AbortController();

    const askPromise = provider.ask({
      agent: QQ_USER_AGENT,
      questions: [
        { id: 'q1', question: '问题一', options: [{ label: 'A' }] },
        { id: 'q2', question: '问题二', options: [{ label: 'B' }] },
      ],
      signal: controller.signal,
    } as any);

    await new Promise((r) => setTimeout(r, 10));
    provider.handleInboundReply('user_2000000001', '1'); // 答完第 1 题，挂起第 2 题
    controller.abort();

    await expect(askPromise).rejects.toThrow('AskUserQuestion aborted by caller signal');
    // pending 已清理：后续回复不再命中
    expect(provider.handleInboundReply('user_2000000001', '1')).toBe(false);
  });

  it('群聊卡片下发必须拿到 message_id，否则 reject（引用锚定无法建立）', async () => {
    const gateway = makeGateway(async () => ({ status: 'ok', retcode: 0, data: {} }));
    const provider = makeProvider(gateway, (id) => `group_${id.slice(9)}`);

    await expect(
      provider.ask({
        agent: QQ_GROUP_AGENT,
        questions: [{ id: 'q1', question: '问题一' }],
        signal: new AbortController().signal,
      } as any)
    ).rejects.toThrow(/群聊引用锚定无法建立/);
  });
});

describe('契约测试: 回复解析规则 (Answer Parsing)', () => {
  function parse(q: any, text: string) {
    // 通过真实串行流解析：单题 ask → 回复 → 取 resolve 的 answer
    return (async () => {
      const gateway = makeGateway();
      const provider = makeProvider(gateway, (id) => `user_${id.slice(8)}`);
      const askPromise = provider.ask({
        agent: QQ_USER_AGENT,
        questions: [q],
        signal: new AbortController().signal,
      } as any);
      await new Promise((r) => setTimeout(r, 5));
      provider.handleInboundReply('user_2000000001', text);
      const answer = await askPromise;
      return answer.answers[0];
    })();
  }

  it('单选：序号命中 → selected=[label]；越界数字不判定直接当 custom', async () => {
    const q = { id: 'q1', question: '环境', options: [{ label: '生产' }, { label: '测试' }, { label: '开发' }, { label: '预发' }] };
    expect(await parse(q, '2')).toEqual({ id: 'q1', selected: ['测试'] });
    expect(await parse(q, '3')).toEqual({ id: 'q1', selected: ['开发'] });
    expect(await parse(q, '5')).toEqual({ id: 'q1', selected: [], custom: '5' });
    expect(await parse(q, '0')).toEqual({ id: 'q1', selected: [], custom: '0' });
    expect(await parse(q, 'x')).toEqual({ id: 'q1', selected: [], custom: 'x' });
    expect(await parse(q, ' 2 ')).toEqual({ id: 'q1', selected: ['测试'] });
  });

  it('多选：逗号分隔，数字段命中进 selected，非数字/越界段拼接为 custom', async () => {
    const q = { id: 'q1', question: '多选', multiSelect: true, options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }] };
    expect(await parse(q, '1,2')).toEqual({ id: 'q1', selected: ['A', 'B'] });
    expect(await parse(q, '1,5')).toEqual({ id: 'q1', selected: ['A'], custom: '5' });
    expect(await parse(q, 'abc,2')).toEqual({ id: 'q1', selected: ['B'], custom: 'abc' });
    expect(await parse(q, '5')).toEqual({ id: 'q1', selected: [], custom: '5' });
    expect(await parse(q, '3,1')).toEqual({ id: 'q1', selected: ['C', 'A'] });
  });

  it('纯自定义输入框（无 options）：恒走 custom', async () => {
    expect(await parse({ id: 'q1', question: '补充说明' }, '随便输入')).toEqual({
      id: 'q1',
      selected: [],
      custom: '随便输入',
    });
    expect(await parse({ id: 'q1', question: '补充说明' }, '42')).toEqual({
      id: 'q1',
      selected: [],
      custom: '42',
    });
  });
});

describe('契约测试: 卡片分场景展示 (Two-Tier Card)', () => {
  it('私聊档卡：题文 + detail + 选项行 + 或者输入自定义答案 + 直接回复提示（自定义标记不占数字位）', () => {
    const card = NapCatQuestionProvider.formatQuestionCard(
      {
        id: 'q1',
        question: '部署到哪个环境？',
        detail: '仅影响 staging 实例',
        options: [{ label: '生产' }, { label: '测试', description: '含 mock 数据' }],
      },
      false
    );
    expect(card).toContain('【请回答问题】');
    expect(card).toContain('部署到哪个环境？');
    expect(card).toContain('仅影响 staging 实例');
    expect(card).toContain('选项:');
    expect(card).toContain('1. 生产');
    expect(card).toContain('2. 测试 (含 mock 数据)');
    expect(card).toContain('或者输入自定义答案');
    expect(card).toContain('请直接回复数字序号，或者直接输入你的答案');
    // 自定义回答标记不占数字位：没有 "3. 自定义"
    expect(card).not.toContain('3. 自定义');
  });

  it('群聊档卡：操作提示换用「请引用本消息并回复...」两档严格区分', () => {
    const groupCard = NapCatQuestionProvider.formatQuestionCard(
      { id: 'q1', question: '部署到哪个环境？', options: [{ label: '生产' }] },
      true
    );
    const privateCard = NapCatQuestionProvider.formatQuestionCard(
      { id: 'q1', question: '部署到哪个环境？', options: [{ label: '生产' }] },
      false
    );
    expect(groupCard).toContain('请引用本消息并回复数字序号，或者直接输入你的答案');
    expect(privateCard).toContain('请直接回复数字序号，或者直接输入你的答案');
    expect(groupCard).toContain('或者输入自定义答案');
    expect(privateCard).toContain('或者输入自定义答案');
  });

  it('无选项卡片：跳过选项头，恒保留自定义回答标记与操作提示', () => {
    const card = NapCatQuestionProvider.formatQuestionCard({ id: 'q1', question: '用途说明' }, true);
    expect(card).not.toContain('选项:');
    expect(card).toContain('或者输入自定义答案');
    expect(card).toContain('请引用本消息并回复数字序号，或者直接输入你的答案');
  });
});