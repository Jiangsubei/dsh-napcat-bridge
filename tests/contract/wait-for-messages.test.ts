/**
 * tests/contract/wait-for-messages.test.ts
 *
 * 契约测试: EN-005 wait_for_user_messages 等待用户消息工具
 *
 * 覆盖场景:
 * 1. MessageWaitRegistry 收集命中消息并在窗口结束返回完整字段
 * 2. 超时无消息 → 状态层报错 'No messages received within the specified timeout'（不给建议）
 * 3. user_id 过滤（群聊）：仅指定用户消息被收集，他人消息被抑制不收集
 * 4. 同 peer 重复等待 → wait-active 状态层拒绝
 * 5. AbortSignal 取消 → cancelled 结算，Promise 不悬挂
 * 6. 工具参数校验（timeout 缺失/非法 → 状态层；user_id 格式非法 → 依赖层原文）
 * 7. 私聊 user_id 与会话对象不符 → 依赖层原文；工具经真实 registry 收集私聊消息
 * 8. 装配: bootDshNapcatBridge 挂载后 tools 注册表包含 wait_for_user_messages，
 *    且注册工具经 execute 可按 session.id 解析 peer 并返回状态层报错原文
 * 9. 装配闭环: 真实 WS 网关入站消息 → 等待门控收集 → 工具返回 {messages,total}
 * 10. 装配闭环: user_id 过滤 + 超时状态层报错（真实装配路径）
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fsp } from 'node:fs';
import WebSocket from 'ws';
import { MessageWaitRegistry, type WaitCollectedMessage } from '../../src/gateway/server.js';
import { waitForUserMessages } from '../../src/tools/index.js';
import { bootDshNapcatBridge, type BootedDsh } from '../../src/boot.js';
import * as NapCatBridgePlugin from '../../src/index.js';

const GROUP_ID = 3000000001;
const BOT_QQ = '1000000001';
const USER_QQ = '2000000001';
const OTHER_QQ = '470250799';
const GROUP_PEER = `group_${GROUP_ID}`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('契约测试: EN-005 wait_for_user_messages（registry + 工具函数单元契约）', () => {
  it('契约 1: MessageWaitRegistry 收集命中消息并在窗口结束返回完整字段', async () => {
    const reg = new MessageWaitRegistry();
    const waitPromise = reg.wait(GROUP_PEER, { timeoutMs: 60 });
    expect(reg.isWaiting(GROUP_PEER)).toBe(true);

    // 异 peer 投递不命中、不收集
    expect(reg.tryDeliver('group_999', { from: '甲', user_id: '1', content: 'x', time: 1 })).toBe(false);

    const delivered = reg.tryDeliver(GROUP_PEER, {
      from: '张三',
      user_id: USER_QQ,
      content: '补充: 改成周三上线',
      time: 1725200000000,
    });
    expect(delivered).toBe(true);

    const result = await waitPromise;
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0]).toEqual({
        from: '张三',
        user_id: USER_QQ,
        content: '补充: 改成周三上线',
        time: 1725200000000,
      });
    }
    // 结算后一次性收集器移除
    expect(reg.isWaiting(GROUP_PEER)).toBe(false);
    expect(reg.tryDeliver(GROUP_PEER, { from: '乙', user_id: '2', content: 'y', time: 2 })).toBe(false);
  });

  it('契约 2: 超时无消息 → 状态层报错原文，不给建议', async () => {
    const reg = new MessageWaitRegistry();
    const waitPromise = reg.wait(GROUP_PEER, { timeoutMs: 40 });
    const result = await waitPromise;

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('timeout');
      expect(result.message).toBe('No messages received within the specified timeout');
    }
    expect(reg.isWaiting(GROUP_PEER)).toBe(false);
  });

  it('契约 3: user_id 过滤（群聊）——仅指定用户消息被收集', async () => {
    const reg = new MessageWaitRegistry();
    const waitPromise = reg.wait(GROUP_PEER, { userId: OTHER_QQ, timeoutMs: 50 });

    // 他人消息：不命中、不收集
    const otherDelivered = reg.tryDeliver(GROUP_PEER, {
      from: 'BotNickname',
      user_id: USER_QQ,
      content: '不是我',
      time: 1725200001000,
    });
    expect(otherDelivered).toBe(false);

    // 目标用户消息：命中收集
    const targetDelivered = reg.tryDeliver(GROUP_PEER, {
      from: '李四',
      user_id: OTHER_QQ,
      content: '是我',
      time: 1725200002000,
    });
    expect(targetDelivered).toBe(true);

    const result = await waitPromise;
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].user_id).toBe(OTHER_QQ);
      expect(result.messages[0].content).toBe('是我');
    }
  });

  it('契约 4: 同 peer 已有活动等待 → 第二次 wait 返回 wait-active 状态层拒绝', async () => {
    const reg = new MessageWaitRegistry();
    const first = reg.wait(GROUP_PEER, { timeoutMs: 80 });
    const second = reg.wait(GROUP_PEER, { timeoutMs: 80 });

    const result = await second;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('wait-active');
      expect(result.message).toContain('已有');
    }

    // 第一个等待不受影响，正常超时结算
    const firstResult = await first;
    expect(firstResult.ok).toBe(false);
  });

  it('契约 5: AbortSignal 取消 → cancelled 结算，Promise 不悬挂', async () => {
    const reg = new MessageWaitRegistry();
    const ac = new AbortController();
    const waitPromise = reg.wait(GROUP_PEER, { timeoutMs: 5000, signal: ac.signal });

    ac.abort();

    const result = await waitPromise;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('cancelled');
      expect(result.message).toContain('中断');
    }
    expect(reg.isWaiting(GROUP_PEER)).toBe(false);
  });

  it('契约 6: 工具参数校验——timeout 缺失/非法 → 状态层；user_id 格式非法 → 依赖层原文', async () => {
    // timeout 缺失
    const r1 = await waitForUserMessages({} as any, { peer: GROUP_PEER, waitRegistry: null });
    expect(r1).toHaveProperty('success', false);
    expect((r1 as any).error).toContain('timeout');

    // timeout 非法（负数）
    const r2 = await waitForUserMessages({ timeout: -1 } as any, { peer: GROUP_PEER, waitRegistry: null });
    expect(r2).toHaveProperty('success', false);
    expect((r2 as any).error).toContain('timeout');

    // user_id 格式非法 → 依赖层报错原文
    const r3 = await waitForUserMessages({ timeout: 5, user_id: 'not-a-qq' } as any, {
      peer: GROUP_PEER,
      waitRegistry: null,
    });
    expect(r3).toHaveProperty('success', false);
    expect((r3 as any).error).toBe('Unknown user_id, cannot wait for messages');

    // 非 QQ 会话（common）→ 状态层
    const r4 = await waitForUserMessages({ timeout: 5 } as any, { peer: 'common', waitRegistry: null });
    expect(r4).toHaveProperty('success', false);
    expect((r4 as any).error).toBe('当前会话不是 QQ 会话，无法等待用户消息');

    // waitRegistry 未装配 → 状态层明确报错（不悬挂、不走等待）
    const r5 = await waitForUserMessages({ timeout: 5 } as any, { peer: GROUP_PEER, waitRegistry: null });
    expect(r5).toHaveProperty('success', false);
    expect((r5 as any).error).toContain('waitRegistry');
  });

  it('契约 7: 私聊 user_id 会话对象不符 → 依赖层原文；工具经真实 registry 收集私聊消息', async () => {
    // 私聊传入与会话对象不符的 user_id → 依赖层原文
    const mismatch = await waitForUserMessages({ timeout: 5, user_id: '123456' } as any, {
      peer: `user_${USER_QQ}`,
      waitRegistry: null,
    });
    expect(mismatch).toHaveProperty('success', false);
    expect((mismatch as any).error).toBe('Unknown user_id, cannot wait for messages');

    // 私聊不传 user_id → 经真实 registry 收集会话对象消息 → {messages,total}
    const reg = new MessageWaitRegistry();
    const waitPromise = waitForUserMessages({ timeout: 1 } as any, {
      peer: `user_${USER_QQ}`,
      waitRegistry: reg,
    });

    const delivered = reg.tryDeliver(`user_${USER_QQ}`, {
      from: 'BotNickname',
      user_id: USER_QQ,
      content: '继续说',
      time: Date.now(),
    });
    expect(delivered).toBe(true);

    const result = await waitPromise;
    expect(result).toHaveProperty('total', 1);
    expect((result as any).messages[0]).toMatchObject({ user_id: USER_QQ, content: '继续说' });
  });
});

describe('契约测试: EN-005 wait_for_user_messages 装配闭环（真实装配 + 真实 WS 入站）', () => {
  let tmpHome: string;
  let booted: BootedDsh;
  let client: WebSocket;
  const WS_PORT = 18341;

  beforeEach(async () => {
    tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-napcat-wait-'));
    booted = await bootDshNapcatBridge({ dshHome: tmpHome, mountPlugin: false });
    await booted.ctx.plugin(NapCatBridgePlugin, {
      bot_qq: BOT_QQ,
      ws_port: WS_PORT,
    });

    client = new WebSocket(`ws://127.0.0.1:${WS_PORT}`);
    await new Promise<void>((resolve, reject) => {
      client.once('open', () => resolve());
      client.once('error', reject);
    });
  });

  afterEach(async () => {
    if (client) {
      client.terminate();
    }
    if (booted) {
      await booted.dispose().catch(() => {});
    }
    if (tmpHome) {
      await fsp.rm(tmpHome, { recursive: true, force: true }).catch(() => {});
    }
  });

  /** 构造 NapCat 入站群消息事件 */
  function inboundGroupMessage(
    text: string,
    opts: { messageId?: number; fromUserId?: string; fromName?: string } = {}
  ): Record<string, any> {
    const fromUserId = opts.fromUserId ?? USER_QQ;
    return {
      post_type: 'message',
      message_type: 'group',
      sub_type: 'normal',
      message_id: opts.messageId ?? Math.floor(Math.random() * 1e6),
      user_id: fromUserId,
      group_id: GROUP_ID,
      sender: { user_id: fromUserId, nickname: opts.fromName ?? '测试用户', card: opts.fromName ?? '测试用户' },
      message: [{ type: 'text', data: { text } }],
      raw_message: text,
      time: Math.floor(Date.now() / 1000),
      self_id: BOT_QQ,
    };
  }

  it('装配: tools 注册表包含 wait_for_user_messages，注册工具经 execute 按 session.id 解析 peer 并返回状态层报错原文', async () => {
    const tools = (booted.ctx.get('tools') || (booted.ctx as any).tools) as any;
    expect(tools).toBeDefined();
    const toolDef = tools.get('wait_for_user_messages');
    expect(toolDef).toBeDefined();
    expect(toolDef.name).toBe('wait_for_user_messages');
    expect(toolDef.description).toContain('等待');

    // 直调注册工具的 execute：qq-group- 会话 → 窗口（100ms）超时无消息 → 状态层报错原文
    const result = await toolDef.execute(
      { timeout: 0.1 },
      { agent: { session: { id: `qq-group-${GROUP_ID}` } }, signal: new AbortController().signal }
    );
    expect(result).toHaveProperty('success', false);
    expect((result as any).error).toBe('No messages received within the specified timeout');
  });

  it('装配: 等待期间同 peer 入站消息经真实 WS → 门控收集 → 工具返回 {messages,total}', async () => {
    const waitPromise = waitForUserMessages({ timeout: 2 } as any, { peer: GROUP_PEER });

    client.send(JSON.stringify(inboundGroupMessage('补充: 改成周三上线', { messageId: 7001 })));

    const result = await waitPromise;
    expect(result).toHaveProperty('total', 1);
    expect((result as any).messages[0]).toMatchObject({
      from: '测试用户',
      user_id: USER_QQ,
      content: '补充: 改成周三上线',
    });
    expect(typeof (result as any).messages[0].time).toBe('number');
  });

  it('装配: user_id 过滤——他人消息被抑制不收集，目标用户消息被收集', async () => {
    const waitPromise = waitForUserMessages({ timeout: 2, user_id: OTHER_QQ } as any, { peer: GROUP_PEER });

    // 他人发言：被抑制（不收集、不唤醒），窗口内等待不结算
    client.send(JSON.stringify(inboundGroupMessage('不是我', { messageId: 7002, fromUserId: USER_QQ })));
    await sleep(120);

    // 目标用户发言：收集
    client.send(JSON.stringify(inboundGroupMessage('是我', { messageId: 7003, fromUserId: OTHER_QQ, fromName: '李四' })));

    const result = await waitPromise;
    expect(result).toHaveProperty('total', 1);
    expect((result as any).messages[0]).toMatchObject({ user_id: OTHER_QQ, content: '是我', from: '李四' });
  });

  it('装配: 等待窗口超时无消息 → 工具返回状态层报错原文', async () => {
    const result = await waitForUserMessages({ timeout: 0.1 } as any, { peer: GROUP_PEER });
    expect(result).toHaveProperty('success', false);
    expect((result as any).error).toBe('No messages received within the specified timeout');
  });
});