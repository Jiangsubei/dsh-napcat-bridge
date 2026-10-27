/**
 * 契约测试: send_qq_message 显式引用与艾特规则契约 (Explicit Reply & At Contract)
 *
 * 覆盖规范清单:
 * 契约 1: 显式引用与艾特：传入 reply_to 与 at_user 时，群聊消息正确组装 reply 与 at 前缀段；
 * 契约 2: 仅艾特不引用：省略 reply_to，仅传 at_user 时，仅组装 at 段与文本，绝不产生 reply 段；
 * 契约 3: 仅引用不艾特：传入 reply_to，省略 at_user 时，仅组装 reply 段与文本，绝不产生 at 段；
 * 契约 4: 纯文本发送：既不传 reply_to 也不传 at_user 时，作为纯文本直接下发；
 * 契约 5: 超长消息分段：首次输出超长分段下发时，仅第 1 个分段携带引用/艾特，后续分段均为纯文本；
 * 契约 6: 私聊会话隔离：私聊会话不组装 at 段；若传入合法 reply_to 则支持私聊引用。
 */

import { describe, it, expect, vi } from 'vitest';
import { sendQqMessage } from '../../src/tools/index.js';

describe('契约 1 ~ 6: send_qq_message 显式引用与艾特规则契约', () => {
  function setupMockGateway() {
    const sent: Array<{ peer: string; msg: any }> = [];
    let msgIdSeq = 1000;
    const gateway = {
      sendMsg: vi.fn(async (peer: string, msg: any) => {
        sent.push({ peer, msg });
        msgIdSeq += 1;
        return { status: 'ok', retcode: 0, data: { message_id: msgIdSeq } };
      }),
    };
    return { gateway, sent };
  }

  it('契约 1: 显式引用与艾特：传入 reply_to 与 at_user 时，群聊消息正确组装 reply 与 at 段', async () => {
    const { gateway, sent } = setupMockGateway();

    const res = await sendQqMessage(
      {
        text: '这是带引用和艾特的消息',
        reply_to: 8888,
        at_user: '1000000001',
      },
      {
        gateway: gateway as any,
        peer: 'group_10001',
      }
    );

    expect(res.success).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0].peer).toBe('group_10001');

    const msg = sent[0].msg as Array<Record<string, any>>;
    expect(Array.isArray(msg)).toBe(true);
    expect(msg[0]).toEqual({ type: 'reply', data: { id: 8888 } });
    expect(msg[1]).toEqual({ type: 'at', data: { qq: '1000000001' } });
    expect(msg[2]).toEqual({ type: 'text', data: { text: ' 这是带引用和艾特的消息' } });
  });

  it('契约 2: 仅艾特不引用：省略 reply_to，仅传 at_user 时，仅组装 at 段与文本，不生成 reply 段', async () => {
    const { gateway, sent } = setupMockGateway();

    const res = await sendQqMessage(
      {
        text: '这是仅艾特的消息',
        at_user: '1000000001',
      },
      {
        gateway: gateway as any,
        peer: 'group_10001',
      }
    );

    expect(res.success).toBe(true);
    expect(sent).toHaveLength(1);

    const msg = sent[0].msg as Array<Record<string, any>>;
    expect(Array.isArray(msg)).toBe(true);
    expect(msg.find((s) => s.type === 'reply')).toBeUndefined();
    expect(msg[0]).toEqual({ type: 'at', data: { qq: '1000000001' } });
    expect(msg[1]).toEqual({ type: 'text', data: { text: ' 这是仅艾特的消息' } });
  });

  it('契约 3: 仅引用不艾特：传入 reply_to，省略 at_user 时，仅组装 reply 段与文本，不生成 at 段', async () => {
    const { gateway, sent } = setupMockGateway();

    const res = await sendQqMessage(
      {
        text: '这是仅引用的消息',
        reply_to: 9999,
      },
      {
        gateway: gateway as any,
        peer: 'group_10001',
      }
    );

    expect(res.success).toBe(true);
    expect(sent).toHaveLength(1);

    const msg = sent[0].msg as Array<Record<string, any>>;
    expect(Array.isArray(msg)).toBe(true);
    expect(msg.find((s) => s.type === 'at')).toBeUndefined();
    expect(msg[0]).toEqual({ type: 'reply', data: { id: 9999 } });
    expect(msg[1]).toEqual({ type: 'text', data: { text: '这是仅引用的消息' } });
  });

  it('契约 4: 纯文本发送：既不传 reply_to 也不传 at_user 时，作为纯文本直接下发', async () => {
    const { gateway, sent } = setupMockGateway();

    const res = await sendQqMessage(
      {
        text: '这是纯文本消息',
      },
      {
        gateway: gateway as any,
        peer: 'group_10001',
      }
    );

    expect(res.success).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0].msg).toBe('这是纯文本消息');
  });

  it('契约 5: 超长消息分段：首次输出超长分段下发时，仅第 1 个分段携带引用/艾特，后续分段均为纯文本', async () => {
    const { gateway, sent } = setupMockGateway();

    const part1 = 'A'.repeat(1600);
    const part2 = 'B'.repeat(500);
    const longText = `${part1}\n${part2}`;

    const res = await sendQqMessage(
      {
        text: longText,
        reply_to: 8888,
        at_user: '1000000001',
      },
      {
        gateway: gateway as any,
        peer: 'group_10001',
      }
    );

    expect(res.success).toBe(true);
    expect(sent.length).toBeGreaterThan(1);

    // 第 1 个分段携带 reply 和 at 段
    const seg1 = sent[0].msg;
    expect(Array.isArray(seg1)).toBe(true);
    expect(seg1[0]).toEqual({ type: 'reply', data: { id: 8888 } });
    expect(seg1[1]).toEqual({ type: 'at', data: { qq: '1000000001' } });

    // 后续分段均为纯文本，不重复携带 reply 或 at
    for (let i = 1; i < sent.length; i++) {
      expect(typeof sent[i].msg).toBe('string');
      expect(JSON.stringify(sent[i].msg)).not.toContain('reply');
      expect(JSON.stringify(sent[i].msg)).not.toContain('1000000001');
    }
  });

  it('契约 6: 私聊会话隔离：私聊会话不组装 at 段；若传入合法 reply_to 则生成私聊引用', async () => {
    const { gateway, sent } = setupMockGateway();

    // 6.1 私聊带 reply_to 与 at_user（at_user 在私聊应被自动忽略）
    const res = await sendQqMessage(
      {
        text: '私聊回复文本',
        reply_to: 12345,
        at_user: '1000000001',
      },
      {
        gateway: gateway as any,
        peer: 'user_1000000001',
      }
    );

    expect(res.success).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0].peer).toBe('user_1000000001');

    const msg = sent[0].msg;
    expect(Array.isArray(msg)).toBe(true);
    expect(msg[0]).toEqual({ type: 'reply', data: { id: 12345 } });
    expect(msg.find((s: any) => s.type === 'at')).toBeUndefined();
    expect(msg[1]).toEqual({ type: 'text', data: { text: '私聊回复文本' } });

    // 6.2 私聊无 reply_to 纯文本
    await sendQqMessage(
      { text: '私聊纯文本' },
      { gateway: gateway as any, peer: 'user_1000000001' }
    );
    expect(sent[1].msg).toBe('私聊纯文本');
  });

  it('契约 7: at_user 容错性契约：支持数字与带 @ 前缀传参，自动清洗并前置空格', async () => {
    const { gateway, sent } = setupMockGateway();

    // 7.1 数字类型 at_user
    await sendQqMessage(
      { text: '数字QQ', at_user: 1000000001 as any },
      { gateway: gateway as any, peer: 'group_10001' }
    );
    expect(sent[0].msg).toEqual([
      { type: 'at', data: { qq: '1000000001' } },
      { type: 'text', data: { text: ' 数字QQ' } },
    ]);

    // 7.2 带 @ 前缀 at_user
    await sendQqMessage(
      { text: '带艾特前缀', at_user: '@1000000001' },
      { gateway: gateway as any, peer: 'group_10001' }
    );
    expect(sent[1].msg).toEqual([
      { type: 'at', data: { qq: '1000000001' } },
      { type: 'text', data: { text: ' 带艾特前缀' } },
    ]);
  });

  it('契约 8: 艾特空格幂等契约：正文已带空格或换行时，不重复补空格', async () => {
    const { gateway, sent } = setupMockGateway();

    // 8.1 正文已有前导空格
    await sendQqMessage(
      { text: ' 已经有空格', at_user: '1000000001' },
      { gateway: gateway as any, peer: 'group_10001' }
    );
    expect(sent[0].msg).toEqual([
      { type: 'at', data: { qq: '1000000001' } },
      { type: 'text', data: { text: ' 已经有空格' } },
    ]);

    // 8.2 正文为换行开头
    await sendQqMessage(
      { text: '\n换行开头消息', at_user: '1000000001' },
      { gateway: gateway as any, peer: 'group_10001' }
    );
    expect(sent[1].msg).toEqual([
      { type: 'at', data: { qq: '1000000001' } },
      { type: 'text', data: { text: '\n换行开头消息' } },
    ]);
  });
});
