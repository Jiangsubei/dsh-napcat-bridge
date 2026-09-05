import { describe, it, expect } from 'vitest';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import {
  filterAndExtractOutboundBlocks,
  OutboundStreamBridge,
} from '../../src/outbound/stream.js';
import { stripMarkdown } from '../../src/outbound/render.js';

describe('契约测试: 出方向事件过滤与 Markdown 纯文本渲染 (Outbound & Strip Contract)', () => {
  it('契约 1: 仅正式回复 TextBlock 被提取发往 QQ，思考与工具块坚决过滤', () => {
    const blocks: ContentBlock[] = [
      {
        type: 'reasoning',
        text: '让我思考一下用户的需求，首先需要调用天气工具...',
      },
      {
        type: 'tool-call',
        id: 'call_123' as any,
        name: 'get_weather',
        arguments: '{"city":"Beijing"}',
      },
      {
        type: 'text',
        text: '北京今天天气晴朗，气温 25 度。',
      },
    ];

    // 调用真实出站过滤模块
    const formalTextBlocks = filterAndExtractOutboundBlocks(blocks);
    expect(formalTextBlocks).toHaveLength(1);
    expect(formalTextBlocks[0].text).toBe('北京今天天气晴朗，气温 25 度。');

    const combinedText = formalTextBlocks.map((b) => b.text).join('\n');
    expect(combinedText).not.toContain('让我思考一下');
    expect(combinedText).not.toContain('get_weather');
  });

  it('契约 2: stripMarkdown 算法剥离语法符号，生成适合 QQ 的纯文本排版', () => {
    const md = `### 系统运行报告
**状态**: 正常运行
*详情*: 当前 CPU 负载 _20%_
这是一个 \`npm test\` 命令。
[官方文档](https://deepseek.com)

\`\`\`bash
pnpm run build
pnpm test
\`\`\`

| 服务 | 状态 |
|---|---|
| Gateway | 在线 |
| Agent | 就绪 |
`;

    // 调用真实 Markdown 剥离模块
    const plain = stripMarkdown(md);

    // 断言: 标题转换为中文括号
    expect(plain).toContain('【系统运行报告】');
    // 断言: 加粗/斜体符号已去除
    expect(plain).toContain('状态: 正常运行');
    expect(plain).toContain('详情: 当前 CPU 负载 20%');
    expect(plain).not.toContain('**');
    expect(plain).not.toContain('`npm test`');
    expect(plain).toContain('npm test');
    // 断言: 链接展开
    expect(plain).toContain('官方文档 (https://deepseek.com)');
    // 断言: 代码块反引号去除
    expect(plain).not.toContain('```');
    expect(plain).toContain('pnpm run build');
    // 断言: 表格分隔符已被清理
    expect(plain).not.toContain('|---|---|');
  });
});

describe('契约测试: 出方向 @提问者 / 引用原消息 开关接线 (Spec §7.1 决策 A, A-1)', () => {
  function makeBridge(getConfig: () => any, sent: Array<{ peer: string; msg: any }>) {
    const gateway = {
      sendMsg: async (peer: string, msg: any) => {
        sent.push({ peer, msg });
        return { status: 'ok', retcode: 0, data: { message_id: 100 } };
      },
    };
    const sessionManager = {
      isQQSession: () => true,
      sessionIdToPeer: () => 'group_123',
    };
    return new OutboundStreamBridge({} as any, {
      gateway: gateway as any,
      sessionManager: sessionManager as any,
      getConfig,
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    });
  }

  it('A1-契约 1: quote_original=true 且 at_questioner=false 时，群聊首段前缀仅含 CQ:reply 引用', async () => {
    const sent: Array<{ peer: string; msg: any }> = [];
    const bridge = makeBridge(
      () => ({ quote_original: true, at_questioner: false }),
      sent
    );
    bridge.trackInboundContext('group_123', {
      msg_id: 9001,
      from_user: '2000000001',
      is_group: true,
    });

    await bridge.sendSerialized('group_123', '好的，我查一下。', { withPrefix: true });

    expect(sent).toHaveLength(1);
    const msg = sent[0].msg;
    expect(Array.isArray(msg)).toBe(true);
    const segs = msg as Array<Record<string, any>>;
    expect(segs[0]).toEqual({ type: 'reply', data: { id: 9001 } });
    expect(segs.some((s) => s.type === 'at')).toBe(false);
    expect(segs[segs.length - 1]).toEqual({ type: 'text', data: { text: '好的，我查一下。' } });
  });

  it('A1-契约 2: at_questioner=true 时前缀追加 CQ:at 提问者；quote_original=false 时去掉引用', async () => {
    const sent1: Array<{ peer: string; msg: any }> = [];
    const bridge1 = makeBridge(
      () => ({ quote_original: true, at_questioner: true }),
      sent1
    );
    bridge1.trackInboundContext('group_123', {
      msg_id: 9001,
      from_user: '2000000001',
      is_group: true,
    });
    await bridge1.sendSerialized('group_123', '你好！', { withPrefix: true });
    const segs1 = sent1[0].msg as Array<Record<string, any>>;
    expect(segs1[0]).toEqual({ type: 'reply', data: { id: 9001 } });
    expect(segs1[1]).toEqual({ type: 'at', data: { qq: '2000000001' } });

    const sent2: Array<{ peer: string; msg: any }> = [];
    const bridge2 = makeBridge(
      () => ({ quote_original: false, at_questioner: true }),
      sent2
    );
    bridge2.trackInboundContext('group_123', {
      msg_id: 9001,
      from_user: '2000000001',
      is_group: true,
    });
    await bridge2.sendSerialized('group_123', '你好！', { withPrefix: true });
    const segs2 = sent2[0].msg as Array<Record<string, any>>;
    expect(segs2.some((s) => s.type === 'reply')).toBe(false);
    expect(segs2[0]).toEqual({ type: 'at', data: { qq: '2000000001' } });
  });

  it('A1-契约 3: 私聊 (user_*) 不 @ 不引用，保持纯文本原样下发', async () => {
    const sent: Array<{ peer: string; msg: any }> = [];
    const bridge = makeBridge(
      () => ({ quote_original: true, at_questioner: true }),
      sent
    );
    bridge.trackInboundContext('user_2000000001', {
      msg_id: 9001,
      from_user: '2000000001',
      is_group: false,
    });

    await bridge.sendSerialized('user_2000000001', '私聊回复内容', { withPrefix: true });

    expect(sent[0].msg).toBe('私聊回复内容');
  });

  it('A1-契约 4: 无唤醒上下文时按纯文本原样下发，不拼接任何 CQ 前缀', async () => {
    const sent: Array<{ peer: string; msg: any }> = [];
    const bridge = makeBridge(() => ({ quote_original: true, at_questioner: true }), sent);

    await bridge.sendSerialized('group_123', '无上下文的回复', { withPrefix: true });

    expect(sent[0].msg).toBe('无上下文的回复');
  });

  it('A1-契约 5: 同 turn 多段正文仅首段携带 @/引用 前缀 (Spec §7.1 "在首段")', async () => {
    const sent: Array<{ peer: string; msg: any }> = [];
    const bridge = makeBridge(
      () => ({ quote_original: true, at_questioner: true }),
      sent
    );
    bridge.trackInboundContext('group_123', {
      msg_id: 9001,
      from_user: '2000000001',
      is_group: true,
    });

    const session = { id: 'qq-group-123' };
    const event = {
      type: 'assistant/message',
      data: {
        message: {
          content: [
            { type: 'text', text: '**第一段**' },
            { type: 'text', text: '第二段正文' },
          ],
        },
      },
    };

    await bridge.handleSessionEvent(session as any, event as any);

    expect(sent).toHaveLength(2);
    const first = sent[0].msg as Array<Record<string, any>>;
    expect(Array.isArray(first)).toBe(true);
    expect(first[0]).toEqual({ type: 'reply', data: { id: 9001 } });
    expect(first.some((s) => s.type === 'at')).toBe(true);
    // 第二段不携带前缀
    expect(sent[1].msg).toBe('第二段正文');
  });
});

describe('契约测试: Turn 级精准绑定与异步排队消息隔离 (Turn Context Isolation Contract)', () => {
  function makeBridge(sent: Array<{ peer: string; msg: any }>) {
    const gateway = {
      sendMsg: async (peer: string, msg: any) => {
        sent.push({ peer, msg });
        return { status: 'ok', retcode: 0, data: { message_id: 100 } };
      },
    };
    const sessionManager = {
      isQQSession: () => true,
      sessionIdToPeer: () => 'group_123',
    };
    return new OutboundStreamBridge({} as any, {
      gateway: gateway as any,
      sessionManager: sessionManager as any,
      getConfig: () => ({ quote_original: true, at_questioner: true }),
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    });
  }

  it('Turn-契约 1: 轮次 A 未结束时排队消息 B 入站，轮次 A 必须引用消息 A，轮次 B 必须引用消息 B', async () => {
    const sent: Array<{ peer: string; msg: any }> = [];
    const bridge = makeBridge(sent);

    const session = { id: 'qq-group-123' };

    // 1. 消息 A 入站并登记 pending (msg_id: 1001, from_user: 'user_A')
    bridge.trackPendingMessage('user_msg_A', 'group_123', {
      msg_id: 1001,
      from_user: 'user_A',
      is_group: true,
    });

    // 2. 轮次 1 开启: turn/start (turn: 1) -> user/message ('user_msg_A')
    await bridge.handleSessionEvent(session as any, {
      type: 'turn/start',
      data: { turn: 1 },
    } as any);
    await bridge.handleSessionEvent(session as any, {
      type: 'user/message',
      data: { id: 'user_msg_A', content: [{ type: 'text', text: '问题 A' }] },
    } as any);

    // 3. 轮次 1 尚未结束时，用户在群内继续发送消息 B (msg_id: 1002, from_user: 'user_B') 排队等待
    bridge.trackPendingMessage('user_msg_B', 'group_123', {
      msg_id: 1002,
      from_user: 'user_B',
      is_group: true,
    });

    // 4. 轮次 1 推理完毕产生 assistant/message (turn: 1)
    await bridge.handleSessionEvent(session as any, {
      type: 'assistant/message',
      data: {
        turn: 1,
        step: 1,
        message: { content: [{ type: 'text', text: '轮次 1 的最终回答' }] },
      },
    } as any);

    // 5. 轮次 1 结束: turn/end (turn: 1)
    await bridge.handleSessionEvent(session as any, {
      type: 'turn/end',
      data: { turn: 1, reason: { kind: 'completed' } },
    } as any);

    // 6. 轮次 2 开启: turn/start (turn: 2) -> user/message ('user_msg_B')
    await bridge.handleSessionEvent(session as any, {
      type: 'turn/start',
      data: { turn: 2 },
    } as any);
    await bridge.handleSessionEvent(session as any, {
      type: 'user/message',
      data: { id: 'user_msg_B', content: [{ type: 'text', text: '问题 B' }] },
    } as any);

    // 7. 轮次 2 推理完毕产生 assistant/message (turn: 2)
    await bridge.handleSessionEvent(session as any, {
      type: 'assistant/message',
      data: {
        turn: 2,
        step: 1,
        message: { content: [{ type: 'text', text: '轮次 2 的最终回答' }] },
      },
    } as any);

    // 8. 轮次 2 结束
    await bridge.handleSessionEvent(session as any, {
      type: 'turn/end',
      data: { turn: 2, reason: { kind: 'completed' } },
    } as any);

    // 核心断言:
    // sent[0] 为轮次 1 回复: 必须引用 1001 (@ user_A)，绝不能引用 1002
    expect(sent).toHaveLength(2);

    const replyA = sent[0].msg as Array<Record<string, any>>;
    expect(Array.isArray(replyA)).toBe(true);
    expect(replyA[0]).toEqual({ type: 'reply', data: { id: 1001 } });
    expect(replyA[1]).toEqual({ type: 'at', data: { qq: 'user_A' } });
    expect(replyA[2]).toEqual({ type: 'text', data: { text: '轮次 1 的最终回答' } });

    // sent[1] 为轮次 2 回复: 必须引用 1002 (@ user_B)
    const replyB = sent[1].msg as Array<Record<string, any>>;
    expect(Array.isArray(replyB)).toBe(true);
    expect(replyB[0]).toEqual({ type: 'reply', data: { id: 1002 } });
    expect(replyB[1]).toEqual({ type: 'at', data: { qq: 'user_B' } });
    expect(replyB[2]).toEqual({ type: 'text', data: { text: '轮次 2 的最终回答' } });
  });

  it('Turn-契约 2: 同轮次多次 assistant/message (如工具调用后最终回复)，保持正确绑定且仅首段引用', async () => {
    const sent: Array<{ peer: string; msg: any }> = [];
    const bridge = makeBridge(sent);
    const session = { id: 'qq-group-123' };

    bridge.trackPendingMessage('user_msg_step', 'group_123', {
      msg_id: 5001,
      from_user: 'user_step',
      is_group: true,
    });

    await bridge.handleSessionEvent(session as any, {
      type: 'turn/start',
      data: { turn: 1 },
    } as any);
    await bridge.handleSessionEvent(session as any, {
      type: 'user/message',
      data: { id: 'user_msg_step', content: [{ type: 'text', text: '查天气' }] },
    } as any);

    // step 1: 中途输出说明并调用工具
    await bridge.handleSessionEvent(session as any, {
      type: 'assistant/message',
      data: {
        turn: 1,
        step: 1,
        message: { content: [{ type: 'text', text: '正在为您查询天气...' }] },
      },
    } as any);

    // step 2: 最终回复
    await bridge.handleSessionEvent(session as any, {
      type: 'assistant/message',
      data: {
        turn: 1,
        step: 2,
        message: { content: [{ type: 'text', text: '今天晴天，气温 25 度。' }] },
      },
    } as any);

    expect(sent).toHaveLength(2);
    // 第一条消息携带引用
    const seg1 = sent[0].msg as Array<Record<string, any>>;
    expect(seg1[0]).toEqual({ type: 'reply', data: { id: 5001 } });
    // 第二条消息由于该 turn 已经下发过前缀，不重复引用
    expect(sent[1].msg).toBe('今天晴天，气温 25 度。');
  });

  it('Turn-契约 3: 无 Turn 上下文或降级情况回退至单值保底或纯文本，绝不抛未捕获异常', async () => {
    const sent: Array<{ peer: string; msg: any }> = [];
    const bridge = makeBridge(sent);
    const session = { id: 'qq-group-123' };

    // 模拟来自 Web UI 触发的 turn (无任何 pending QQ 消息)
    await bridge.handleSessionEvent(session as any, {
      type: 'turn/start',
      data: { turn: 99 },
    } as any);
    await bridge.handleSessionEvent(session as any, {
      type: 'user/message',
      data: { id: 'web_msg', content: [{ type: 'text', text: 'web prompt' }] },
    } as any);

    await bridge.handleSessionEvent(session as any, {
      type: 'assistant/message',
      data: {
        turn: 99,
        step: 1,
        message: { content: [{ type: 'text', text: 'web 回复' }] },
      },
    } as any);

    expect(sent).toHaveLength(1);
    // 降级为纯文本，无引用
    expect(sent[0].msg).toBe('web 回复');
  });
});

