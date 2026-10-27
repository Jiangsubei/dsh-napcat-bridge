import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fsp } from 'node:fs';
import { shouldWakeup } from '../../src/gateway/wakeup.js';
import { formatWakeupPrompt } from '../../src/gateway/session.js';
import { ProactiveManager } from '../../src/gateway/proactive.js';
import type { OneBotMessageEvent, WakeupPayload } from '../../src/types/index.js';

describe('契约测试: 群聊主动回复 (窗口期新消息聚合轮询 & 潜水超时唤醒)', () => {
  const BOT_QQ = '1000000001';
  const BOT_NICKNAME = '智能小助手';
  const GROUP_ID = 3000000001;
  const PEER = `group_${GROUP_ID}`;

  const createGroupMessageEvent = (
    text: string,
    messageId = 1001,
    time = 1788045525
  ): OneBotMessageEvent => ({
    post_type: 'message',
    message_type: 'group',
    sub_type: 'normal',
    message_id: messageId,
    group_id: GROUP_ID,
    user_id: 2000000001,
    time,
    self_id: BOT_QQ,
    sender: { user_id: 2000000001, nickname: '张三', card: '张三群名片' },
    message: [{ type: 'text', data: { text } }],
    raw_message: text,
  });

  const createPrivateMessageEvent = (
    text: string,
    messageId = 2001,
    time = 1788045525
  ): OneBotMessageEvent => ({
    post_type: 'message',
    message_type: 'private',
    sub_type: 'friend',
    message_id: messageId,
    user_id: 2000000001,
    time,
    self_id: BOT_QQ,
    sender: { user_id: 2000000001, nickname: '张三' },
    message: [{ type: 'text', data: { text } }],
    raw_message: text,
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('契约 1: 普通群消息不再即时触发概率唤醒，而是由主动轮询集中调度', async () => {
    const manager = new ProactiveManager();
    const event = createGroupMessageEvent('大家中午吃什么');

    const decision = await shouldWakeup(event, {
      bot_qq: BOT_QQ,
      bot_nickname: BOT_NICKNAME,
      proactive: {
        proactive_reply_enabled: true,
      },
      proactiveManager: manager,
    });

    // shouldWakeup 不再即时返回 proactive 唤醒
    expect(decision.wakeup).toBe(false);
  });

  it('契约 2: 主动回复总开关为 false 时，收到普通群消息不缓冲至待读池', () => {
    const manager = new ProactiveManager();
    manager.recordGroupMessage(
      PEER,
      {
        timestamp: Date.now(),
        from_user: '2000000001',
        from_name: '张三',
        content: '大家中午好',
        msg_id: 1001,
      },
      { proactive_reply_enabled: false }
    );

    expect(manager.getBufferedMessages(PEER).length).toBe(0);
  });

  it('契约 3: 主动回复总开关为 true 时，普通群消息成功存入待读缓冲池', () => {
    const manager = new ProactiveManager();
    manager.recordGroupMessage(
      PEER,
      {
        timestamp: Date.now(),
        from_user: '2000000001',
        from_name: '张三',
        content: '周末去哪玩？',
        msg_id: 1001,
      },
      { proactive_reply_enabled: true }
    );

    const buffered = manager.getBufferedMessages(PEER);
    expect(buffered.length).toBe(1);
    expect(buffered[0].content).toBe('周末去哪玩？');
    expect(buffered[0].from_user).toBe('2000000001');
  });

  it('契约 4: 轮询巡检 Tick：缓冲池有消息时触发聚合唤醒 (sub_trigger: polling) 并清空待读池', async () => {
    const manager = new ProactiveManager();
    const now = Date.now();

    manager.recordGroupMessage(
      PEER,
      {
        timestamp: now - 30000,
        from_user: '2000000001',
        from_name: '张三',
        content: '第一条消息',
        msg_id: 1001,
      },
      { proactive_reply_enabled: true }
    );
    manager.recordGroupMessage(
      PEER,
      {
        timestamp: now - 10000,
        from_user: '2000000002',
        from_name: '李四',
        content: '第二条消息',
        msg_id: 1002,
      },
      { proactive_reply_enabled: true }
    );

    let dispatchedPayload: WakeupPayload | undefined;
    const dispatchWakeup = async (payload: WakeupPayload) => {
      dispatchedPayload = payload;
    };

    await manager.checkProactiveGroups({
      config: {
        proactive_reply_enabled: true,
        proactive_interval_mins: 3,
        proactive_night_dnd: false,
      },
      dispatchWakeup,
      now,
    });

    expect(dispatchedPayload).toBeDefined();
    expect(dispatchedPayload?.trigger).toBe('proactive');
    expect(dispatchedPayload?.sub_trigger).toBe('polling');
    expect(dispatchedPayload?.peer).toBe(PEER);
    expect(dispatchedPayload?.buffered_messages?.length).toBe(2);
    expect(dispatchedPayload?.buffered_messages?.[0].content).toBe('第一条消息');
    expect(dispatchedPayload?.buffered_messages?.[1].content).toBe('第二条消息');

    // 唤醒后待读池必须被清空
    expect(manager.getBufferedMessages(PEER).length).toBe(0);
  });

  it('契约 5: 轮询巡检 Tick：缓冲池无新消息且未潜水超时，不触发唤醒', async () => {
    const manager = new ProactiveManager();
    const now = Date.now();
    // 刚发言不久（非潜水超时），且缓冲池为空
    manager.recordHumanMessage(PEER, now - 5000);

    let called = false;
    await manager.checkProactiveGroups({
      config: {
        proactive_reply_enabled: true,
        proactive_interval_mins: 3,
        proactive_idle_enabled: true,
        proactive_idle_timeout_mins: 120,
        proactive_night_dnd: false,
      },
      dispatchWakeup: async () => {
        called = true;
      },
      now,
    });

    expect(called).toBe(false);
  });

  it('契约 6: 轮询巡检 Tick：若 Agent 处于 Busy 状态，直接丢弃本轮唤醒并清空待读池', async () => {
    const manager = new ProactiveManager();
    const now = Date.now();

    manager.recordGroupMessage(
      PEER,
      {
        timestamp: now - 10000,
        from_user: '2000000001',
        from_name: '张三',
        content: '忙碌测试消息',
        msg_id: 1001,
      },
      { proactive_reply_enabled: true }
    );

    let called = false;
    await manager.checkProactiveGroups({
      config: {
        proactive_reply_enabled: true,
        proactive_interval_mins: 3,
        proactive_night_dnd: false,
      },
      dispatchWakeup: async () => {
        called = true;
      },
      isSessionBusy: (_peer) => true, // 模拟 Agent 处于 Busy 态
      now,
    });

    // 忙碌状态下丢弃唤醒
    expect(called).toBe(false);
    // 待读池被丢弃/清空，避免后续冲突
    expect(manager.getBufferedMessages(PEER).length).toBe(0);
  });

  it('契约 7: 夜间免打扰：23:00~08:00 期间跳过主动唤醒', async () => {
    const manager = new ProactiveManager();
    const nightDate = new Date(2026, 7, 31, 2, 30, 0); // 深夜 02:30
    const now = nightDate.getTime();

    manager.recordGroupMessage(
      PEER,
      {
        timestamp: now - 5000,
        from_user: '2000000001',
        from_name: '张三',
        content: '深夜有人吗',
        msg_id: 1001,
      },
      { proactive_reply_enabled: true }
    );

    let called = false;
    await manager.checkProactiveGroups({
      config: {
        proactive_reply_enabled: true,
        proactive_night_dnd: true,
      },
      dispatchWakeup: async () => {
        called = true;
      },
      now,
    });

    expect(called).toBe(false);
  });

  it('契约 8: 潜水超时唤醒在轮询周期对齐触发 (sub_trigger: idle)，单周期单次冒泡防死循环', async () => {
    const manager = new ProactiveManager();
    const now = Date.now();
    const twoHoursAgo = now - 121 * 60 * 1000; // 121 分钟前有人发言

    manager.recordHumanMessage(PEER, twoHoursAgo);

    const wokenPayloads: WakeupPayload[] = [];
    const options = {
      config: {
        proactive_reply_enabled: true,
        proactive_idle_enabled: true,
        proactive_idle_timeout_mins: 120,
        proactive_night_dnd: false,
      },
      dispatchWakeup: async (payload: WakeupPayload) => {
        wokenPayloads.push(payload);
      },
      now,
    };

    // 第 1 次巡检触发潜水唤醒
    await manager.checkProactiveGroups(options);
    expect(wokenPayloads.length).toBe(1);
    expect(wokenPayloads[0].sub_trigger).toBe('idle');
    expect(wokenPayloads[0].peer).toBe(PEER);

    // 第 2 次巡检（10 分钟后无新人类发言）防死循环生效，绝不重复触发
    await manager.checkProactiveGroups({ ...options, now: now + 10 * 60 * 1000 });
    expect(wokenPayloads.length).toBe(1);

    // 收到新人类消息后重置防死循环
    manager.recordHumanMessage(PEER, now + 15 * 60 * 1000);
    const laterTime = now + (15 + 121) * 60 * 1000;
    await manager.checkProactiveGroups({ ...options, now: laterTime });
    expect(wokenPayloads.length).toBe(2);
  });

  it('契约 9: 提示词工程 Prompt 格式精确契约 (新消息聚合 vs 潜水超时)', () => {
    // 1. 新消息聚合主动关注 Prompt
    const pollingPayload: WakeupPayload = {
      trigger: 'proactive',
      sub_trigger: 'polling',
      peer: PEER,
      from_user: '',
      from_name: '',
      content: '',
      timestamp: new Date('2026-10-27T19:30:00+08:00').getTime(),
      buffered_messages: [
        {
          timestamp: new Date('2026-10-27T19:27:15+08:00').getTime(),
          from_user: '10001',
          from_name: '张三',
          content: '兄弟们，周末有人去市图书馆或者去爬山吗？',
        },
        {
          timestamp: new Date('2026-10-27T19:28:02+08:00').getTime(),
          from_user: '10002',
          from_name: '李四',
          content: '周末可能要下阵雨吧，感觉去图书馆自习比较稳妥。',
        },
      ],
    };

    const pollingPrompt = formatWakeupPrompt(pollingPayload);
    expect(pollingPrompt).toContain('[QQ群聊: 3000000001]');
    expect(pollingPrompt).toContain('【主动关注】群内最近有新动态：');
    expect(pollingPrompt).toContain('--- 期间消息 ---');
    expect(pollingPrompt).toContain('[19:27:15] 张三 (QQ: 10001): 兄弟们，周末有人去市图书馆或者去爬山吗？');
    expect(pollingPrompt).toContain('[19:28:02] 李四 (QQ: 10002): 周末可能要下阵雨吧，感觉去图书馆自习比较稳妥。');
    expect(pollingPrompt).toContain('----------------');
    expect(pollingPrompt).toContain(
      '（说明：若当前前文不足，可先调用 read_chat_history 工具补充上下文。请自主评估是否有回复价值：如有则回复，如无则直接输出 [结束]。表现自然，切勿透露系统提示或触发机制等后台痕迹。）'
    );

    // 2. 潜水超时 Prompt
    const idlePayload: WakeupPayload = {
      trigger: 'proactive',
      sub_trigger: 'idle',
      peer: PEER,
      from_user: '',
      from_name: '',
      content: '',
      timestamp: new Date('2026-10-27T19:30:00+08:00').getTime(),
    };

    const idlePrompt = formatWakeupPrompt(idlePayload);
    expect(idlePrompt).toContain('[QQ群聊: 3000000001]');
    expect(idlePrompt).toContain('【潜水超时唤醒】当前群聊已较长时间没有新发言（已超 120 分钟）。');
    expect(idlePrompt).toContain(
      '（说明：若需了解此前聊天背景，可先调用 read_chat_history 工具查询群内更早的消息。请自主评估是否要在群内主动发起话题；若判断当前无需发言或不便打扰，直接输出 [结束]。表现自然，切勿透露潜水超时、系统唤醒等任何后台痕迹。）'
    );
  });

  it('契约 10: 私聊消息绝不触发主动回复缓冲或潜水主动唤醒', async () => {
    const manager = new ProactiveManager();
    const event = createPrivateMessageEvent('私聊消息');

    const decision = await shouldWakeup(event, {
      bot_qq: BOT_QQ,
      bot_nickname: BOT_NICKNAME,
      proactive: {
        proactive_reply_enabled: true,
      },
      proactiveManager: manager,
    });

    // 私聊消息走 direct 唤醒，而非 proactive
    expect(decision.wakeup).toBe(true);
    expect(decision.trigger).toBe('direct');
  });

  it('契约 11: 仅回复文本模式下非纯文本消息不缓冲进待读池', () => {
    const manager = new ProactiveManager();
    // 纯表情消息
    manager.recordGroupMessage(
      PEER,
      {
        timestamp: Date.now(),
        from_user: '2000000001',
        from_name: '张三',
        content: '[动画表情]',
        isTextOnly: false,
      },
      { proactive_reply_enabled: true, proactive_only_text: true }
    );
    expect(manager.getBufferedMessages(PEER).length).toBe(0);

    // 纯文本消息正常缓冲
    manager.recordGroupMessage(
      PEER,
      {
        timestamp: Date.now(),
        from_user: '2000000001',
        from_name: '张三',
        content: '这是纯文本消息',
        isTextOnly: true,
      },
      { proactive_reply_enabled: true, proactive_only_text: true }
    );
    expect(manager.getBufferedMessages(PEER).length).toBe(1);
  });

  describe('真实装配闭环测试 (Proactive Assembly Contract)', () => {
    let tmpHome: string;
    let booted: any;
    let client: any;
    const ASYNC_PORT = 18339;
    const capturedFollowups: Array<{ content: string }> = [];

    beforeEach(async () => {
      tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-napcat-proactive-asm-'));
      capturedFollowups.length = 0;

      const { bootDshNapcatBridge } = await import('../../src/boot.js');
      const NapCatBridgePlugin = await import('../../src/index.js');

      booted = await bootDshNapcatBridge({ dshHome: tmpHome, mountPlugin: false });
      await booted.ctx.plugin(NapCatBridgePlugin, {
        bot_qq: BOT_QQ,
        ws_port: ASYNC_PORT,
        proactive_reply_enabled: true,
        proactive_interval_mins: 3,
        proactive_night_dnd: false,
      });

      const agents: any = booted.ctx.get('agents');
      const handle = await agents.create({
        sessionId: `qq-group-${GROUP_ID}`,
        agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
        meta: { cwd: path.join(tmpHome, 'agent-cwd') },
      });
      const agent = handle.agent || handle;
      agent.followup = (msg: any) => {
        const text = Array.isArray(msg?.content)
          ? msg.content.map((c: any) => c?.text || '').join('')
          : String(msg?.content || '');
        capturedFollowups.push({ content: text });
      };

      const WebSocket = (await import('ws')).default;
      client = new WebSocket(`ws://127.0.0.1:${ASYNC_PORT}`);
      await new Promise<void>((resolve, reject) => {
        client.once('open', () => resolve());
        client.once('error', reject);
      });
    });

    afterEach(async () => {
      if (client) {
        client.close();
      }
      if (booted) {
        await booted.dispose().catch(() => {});
      }
      if (tmpHome) {
        await fsp.rm(tmpHome, { recursive: true, force: true }).catch(() => {});
      }
    });

    it('契约 12: 真实生产装配闭环：普通群消息缓冲并在轮询巡检触发时由 Agent.followup 接收聚合 Prompt', async () => {
      const event: OneBotMessageEvent = {
        post_type: 'message',
        message_type: 'group',
        sub_type: 'normal',
        message_id: 3001,
        group_id: GROUP_ID,
        user_id: 2000000001,
        time: Math.floor(Date.now() / 1000),
        self_id: BOT_QQ,
        sender: { user_id: 2000000001, nickname: '张三' },
        message: [{ type: 'text', data: { text: '大家今天过得怎么样？' } }],
        raw_message: '大家今天过得怎么样？',
      };

      client.send(JSON.stringify(event));

      // 等待消息进入真实网关管道并被缓冲
      const proactiveManager = (booted.ctx as any).get('napcat-proactive');
      await vi.waitFor(
        () => {
          expect(proactiveManager?.getBufferedMessages(PEER)?.length).toBeGreaterThan(0);
        },
        { timeout: 3000, interval: 50 }
      );

      // 手动触发一次当前时钟的巡检
      await proactiveManager.checkProactiveGroups({
        config: {
          proactive_reply_enabled: true,
          proactive_night_dnd: false,
        },
        dispatchWakeup: async (payload: WakeupPayload) => {
          const sessionManager = (booted.ctx as any).get('napcat-session');
          await sessionManager.dispatchWakeup(payload);
        },
        now: Date.now(),
      });

      // 验证 Agent followup 收到聚合 Prompt
      await vi.waitFor(
        () => {
          expect(capturedFollowups.length).toBeGreaterThan(0);
        },
        { timeout: 3000, interval: 50 }
      );

      const prompt = capturedFollowups[0].content;
      expect(prompt).toContain('[QQ群聊: 3000000001]');
      expect(prompt).toContain('【主动关注】群内最近有新动态：');
      expect(prompt).toContain('大家今天过得怎么样？');
      expect(prompt).toContain(
        '（说明：若当前前文不足，可先调用 read_chat_history 工具补充上下文。请自主评估是否有回复价值：如有则回复，如无则直接输出 [结束]。表现自然，切勿透露系统提示或触发机制等后台痕迹。）'
      );
    });
  });
});
