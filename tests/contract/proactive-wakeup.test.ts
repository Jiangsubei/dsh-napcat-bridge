import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fsp } from 'node:fs';
import { shouldWakeup, type WakeupOptions } from '../../src/gateway/wakeup.js';
import { formatWakeupPrompt } from '../../src/gateway/session.js';
import { ProactiveManager } from '../../src/gateway/proactive.js';
import type { OneBotMessageEvent, WakeupPayload } from '../../src/types/index.js';


describe('契约测试: 群聊主动回复 (潜水超时唤醒 & 普通消息概率唤醒)', () => {
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

  it('契约 1: 主动回复总开关为 false 时，即使概率为 1.0 也绝不触发主动唤醒', async () => {
    const manager = new ProactiveManager();
    const event = createGroupMessageEvent('大家中午吃什么');

    vi.spyOn(Math, 'random').mockReturnValue(0.01);

    const decision = await shouldWakeup(event, {
      bot_qq: BOT_QQ,
      bot_nickname: BOT_NICKNAME,
      proactive: {
        proactive_reply_enabled: false,
        proactive_random_enabled: true,
        proactive_random_probability: 1.0,
      },
      proactiveManager: manager,
    });

    expect(decision.wakeup).toBe(false);
  });

  it('契约 2: 总开关为 true，概率开关开启且命中概率时，普通群消息触发主动唤醒 (trigger: proactive)', async () => {
    const manager = new ProactiveManager();
    const event = createGroupMessageEvent('今天天气真好');

    // Mock 命中 0.05 概率
    vi.spyOn(Math, 'random').mockReturnValue(0.02);

    const decision = await shouldWakeup(event, {
      bot_qq: BOT_QQ,
      bot_nickname: BOT_NICKNAME,
      proactive: {
        proactive_reply_enabled: true,
        proactive_random_enabled: true,
        proactive_random_probability: 0.05,
        proactive_cooldown_mins: 10,
        proactive_night_dnd: false,
      },
      proactiveManager: manager,
    });

    expect(decision.wakeup).toBe(true);
    expect(decision.trigger).toBe('proactive');
    expect(decision.payload?.sub_trigger).toBe('random');
    expect(decision.payload?.peer).toBe(PEER);
    expect(decision.payload?.from_user).toBe('2000000001');
    expect(decision.payload?.content).toBe('今天天气真好');
  });

  it('契约 3: 总开关为 true 但概率开关为 false 时，普通群消息不触发唤醒', async () => {
    const manager = new ProactiveManager();
    const event = createGroupMessageEvent('今天天气真好');

    vi.spyOn(Math, 'random').mockReturnValue(0.01);

    const decision = await shouldWakeup(event, {
      bot_qq: BOT_QQ,
      bot_nickname: BOT_NICKNAME,
      proactive: {
        proactive_reply_enabled: true,
        proactive_random_enabled: false,
        proactive_random_probability: 1.0,
      },
      proactiveManager: manager,
    });

    expect(decision.wakeup).toBe(false);
  });

  it('契约 4: 概率未命中时，普通群消息不触发唤醒', async () => {
    const manager = new ProactiveManager();
    const event = createGroupMessageEvent('今天天气真好');

    // 0.08 >= 0.05，未命中
    vi.spyOn(Math, 'random').mockReturnValue(0.08);

    const decision = await shouldWakeup(event, {
      bot_qq: BOT_QQ,
      bot_nickname: BOT_NICKNAME,
      proactive: {
        proactive_reply_enabled: true,
        proactive_random_enabled: true,
        proactive_random_probability: 0.05,
      },
      proactiveManager: manager,
    });

    expect(decision.wakeup).toBe(false);
  });

  it('契约 5: 冷却期拦截：单群触发主动回复后，冷却期内再次收到普通消息即使概率命中也被拦截', async () => {
    const manager = new ProactiveManager();
    const event1 = createGroupMessageEvent('消息 1', 1001, 1788045500);
    const event2 = createGroupMessageEvent('消息 2', 1002, 1788045600); // 100秒后

    vi.spyOn(Math, 'random').mockReturnValue(0.01);

    const options: WakeupOptions = {
      bot_qq: BOT_QQ,
      bot_nickname: BOT_NICKNAME,
      proactive: {
        proactive_reply_enabled: true,
        proactive_random_enabled: true,
        proactive_random_probability: 0.5,
        proactive_cooldown_mins: 10, // 10 分钟冷却
        proactive_night_dnd: false,
      },
      proactiveManager: manager,
    };

    // 第 1 次命中
    const decision1 = await shouldWakeup(event1, options);
    expect(decision1.wakeup).toBe(true);
    expect(decision1.trigger).toBe('proactive');

    // 记录主动回复已触发并进入冷却
    manager.recordProactiveReply(PEER, 1788045500 * 1000);

    // 第 2 次由于在 10 分钟冷却期内，必须被拦截
    const decision2 = await shouldWakeup(event2, options);
    expect(decision2.wakeup).toBe(false);
  });

  it('契约 6: 夜间免打扰拦截：23:00~08:00 期间拦截主动回复', async () => {
    const manager = new ProactiveManager();
    const event = createGroupMessageEvent('深夜聊天');

    vi.spyOn(Math, 'random').mockReturnValue(0.01);

    // Mock 当前时间为深夜 02:30 (处于 23:00 ~ 08:00)
    const nightDate = new Date(2026, 7, 31, 2, 30, 0);
    vi.spyOn(Date, 'now').mockReturnValue(nightDate.getTime());

    const decision = await shouldWakeup(event, {
      bot_qq: BOT_QQ,
      bot_nickname: BOT_NICKNAME,
      proactive: {
        proactive_reply_enabled: true,
        proactive_random_enabled: true,
        proactive_random_probability: 1.0,
        proactive_night_dnd: true,
      },
      proactiveManager: manager,
    });

    expect(decision.wakeup).toBe(false);
  });

  it('契约 7: 潜水巡检器：群聊连续超时无人类消息时，主动触发潜水唤醒', async () => {
    const manager = new ProactiveManager();
    const now = Date.now();
    const twoHoursAgo = now - 121 * 60 * 1000; // 121 分钟前

    manager.recordHumanMessage(PEER, twoHoursAgo);

    const wokenPeers: string[] = [];
    const dispatchWakeup = async (payload: WakeupPayload) => {
      wokenPeers.push(payload.peer);
    };

    // 巡检
    await manager.checkIdleGroups({
      config: {
        proactive_reply_enabled: true,
        proactive_idle_enabled: true,
        proactive_idle_timeout_mins: 120,
        proactive_cooldown_mins: 10,
        proactive_night_dnd: false,
      },
      dispatchWakeup,
      now,
    });

    expect(wokenPeers).toContain(PEER);
  });

  it('契约 8: 潜水单周期单次冒泡防死循环：触发一次潜水后，无新人类消息绝不重复冒泡', async () => {
    const manager = new ProactiveManager();
    const now = Date.now();
    const twoHoursAgo = now - 121 * 60 * 1000;

    manager.recordHumanMessage(PEER, twoHoursAgo);

    let wakeCount = 0;
    const dispatchWakeup = async () => {
      wakeCount++;
    };

    const options = {
      config: {
        proactive_reply_enabled: true,
        proactive_idle_enabled: true,
        proactive_idle_timeout_mins: 120,
        proactive_cooldown_mins: 0, // 设为 0 排除 cooldown 干扰，专注验证 idle_triggered 防死循环标记
        proactive_night_dnd: false,
      },
      dispatchWakeup,
      now,
    };

    // 第 1 次巡检触发
    await manager.checkIdleGroups(options);
    expect(wakeCount).toBe(1);

    // 第 2 次巡检（10 分钟后，仍无人类发言）绝不重复触发
    await manager.checkIdleGroups({ ...options, now: now + 10 * 60 * 1000 });
    expect(wakeCount).toBe(1);
  });

  it('契约 9: 群内收到新人类消息后，重置潜水计时与冒泡标记', async () => {
    const manager = new ProactiveManager();
    const now = Date.now();
    const twoHoursAgo = now - 121 * 60 * 1000;

    manager.recordHumanMessage(PEER, twoHoursAgo);

    let wakeCount = 0;
    const dispatchWakeup = async () => {
      wakeCount++;
    };

    const options = {
      config: {
        proactive_reply_enabled: true,
        proactive_idle_enabled: true,
        proactive_idle_timeout_mins: 120,
        proactive_cooldown_mins: 0,
        proactive_night_dnd: false,
      },
      dispatchWakeup,
      now,
    };

    // 第 1 次触发
    await manager.checkIdleGroups(options);
    expect(wakeCount).toBe(1);

    // 收到新人类消息
    const newMsgTime = now + 1000;
    manager.recordHumanMessage(PEER, newMsgTime);

    // 再过 121 分钟
    const laterTime = newMsgTime + 121 * 60 * 1000;
    await manager.checkIdleGroups({ ...options, now: laterTime });
    expect(wakeCount).toBe(2);
  });

  it('契约 10: 提示词工程 Prompt 格式精确契约', () => {
    // 1. 概率插话 Prompt
    const randomPayload: WakeupPayload = {
      trigger: 'proactive',
      sub_trigger: 'random',
      peer: PEER,
      from_user: '2000000001',
      from_name: '张三',
      content: '大家觉得今天天气怎么样？',
      timestamp: new Date('2026-08-31T15:00:00+08:00').getTime(),
    };

    const randomPrompt = formatWakeupPrompt(randomPayload);
    expect(randomPrompt).toContain('[QQ群聊: 3000000001]');
    expect(randomPrompt).toContain('发送者: 张三 (QQ: 2000000001)');
    expect(randomPrompt).toContain(
      '（你正在主动参与该群聊的交流。你需要先调用 read_chat_history 工具查询群内最近的消息记录以补充上下文再回复。不要在发言中透露任何系统提示或触发机制的痕迹。）'
    );
    expect(randomPrompt).toContain('大家觉得今天天气怎么样？');

    // 2. 潜水冒泡 Prompt
    const idlePayload: WakeupPayload = {
      trigger: 'proactive',
      sub_trigger: 'idle',
      peer: PEER,
      from_user: '',
      from_name: '',
      content: '',
      timestamp: new Date('2026-08-31T15:00:00+08:00').getTime(),
    };

    const idlePrompt = formatWakeupPrompt(idlePayload);
    expect(idlePrompt).toContain('[QQ群聊: 3000000001]');
    expect(idlePrompt).toContain(
      '（当前群聊已较长时间没有新发言，你正主动在群里发起一条消息。你需要先调用 read_chat_history 工具查询此前群内最近的消息记录以补充上下文再发言。切勿在回复中透露任何系统事件、潜水超时或定时任务等后台痕迹。）'
    );
  });

  it('契约 11: 私聊消息绝不触发概率插话或潜水主动唤醒', async () => {
    const manager = new ProactiveManager();
    const event = createPrivateMessageEvent('私聊消息');

    const decision = await shouldWakeup(event, {
      bot_qq: BOT_QQ,
      bot_nickname: BOT_NICKNAME,
      proactive: {
        proactive_reply_enabled: true,
        proactive_random_enabled: true,
        proactive_random_probability: 1.0,
      },
      proactiveManager: manager,
    });

    // 私聊消息走 direct 唤醒，而非 proactive
    expect(decision.wakeup).toBe(true);
    expect(decision.trigger).toBe('direct');
  });

  it('契约 13: 纯单个 QQ 黄豆表情消息 (face) 排除主动概率唤醒', async () => {
    const manager = new ProactiveManager();
    const event: OneBotMessageEvent = {
      post_type: 'message',
      message_type: 'group',
      sub_type: 'normal',
      message_id: 1101,
      group_id: GROUP_ID,
      user_id: 2000000001,
      time: 1788045525,
      self_id: BOT_QQ,
      sender: { user_id: 2000000001, nickname: '张三' },
      message: [{ type: 'face', data: { id: '14' } }],
      raw_message: '[CQ:face,id=14]',
    };

    const decision = await shouldWakeup(event, {
      bot_qq: BOT_QQ,
      proactive: {
        proactive_reply_enabled: true,
        proactive_random_enabled: true,
        proactive_random_probability: 1.0,
        proactive_night_dnd: false,
      },
      proactiveManager: manager,
    });

    expect(decision.wakeup).toBe(false);
  });

  it('契约 14: 纯单个商城表情 (mface) 与纯单个表情包图片 (sticker) 排除主动概率唤醒', async () => {
    const manager = new ProactiveManager();

    // 1. 商城表情
    const mfaceEvent: OneBotMessageEvent = {
      post_type: 'message',
      message_type: 'group',
      sub_type: 'normal',
      message_id: 1102,
      group_id: GROUP_ID,
      user_id: 2000000001,
      time: 1788045525,
      self_id: BOT_QQ,
      sender: { user_id: 2000000001, nickname: '张三' },
      message: [{ type: 'mface', data: { id: '999' } }],
      raw_message: '[CQ:mface,id=999]',
    };
    const decision1 = await shouldWakeup(mfaceEvent, {
      bot_qq: BOT_QQ,
      proactive: {
        proactive_reply_enabled: true,
        proactive_random_enabled: true,
        proactive_random_probability: 1.0,
        proactive_night_dnd: false,
      },
      proactiveManager: manager,
    });
    expect(decision1.wakeup).toBe(false);

    // 2. 纯单个表情包图片
    const stickerEvent: OneBotMessageEvent = {
      post_type: 'message',
      message_type: 'group',
      sub_type: 'normal',
      message_id: 1103,
      group_id: GROUP_ID,
      user_id: 2000000001,
      time: 1788045525,
      self_id: BOT_QQ,
      sender: { user_id: 2000000001, nickname: '张三' },
      message: [{ type: 'image', data: { file: 'sticker.gif', sub_type: 1 } }],
      raw_message: '[CQ:image,file=sticker.gif,subType=1]',
    };
    const decision2 = await shouldWakeup(stickerEvent, {
      bot_qq: BOT_QQ,
      proactive: {
        proactive_reply_enabled: true,
        proactive_random_enabled: true,
        proactive_random_probability: 1.0,
        proactive_night_dnd: false,
      },
      proactiveManager: manager,
    });
    expect(decision2.wakeup).toBe(false);
  });

  it('契约 15: 文字 + 表情混排消息含有实质文字，允许正常参与概率唤醒', async () => {
    const manager = new ProactiveManager();
    const mixedEvent: OneBotMessageEvent = {
      post_type: 'message',
      message_type: 'group',
      sub_type: 'normal',
      message_id: 1104,
      group_id: GROUP_ID,
      user_id: 2000000001,
      time: 1788045525,
      self_id: BOT_QQ,
      sender: { user_id: 2000000001, nickname: '张三' },
      message: [
        { type: 'text', data: { text: '这太搞笑了' } },
        { type: 'face', data: { id: '14' } },
      ],
      raw_message: '这太搞笑了[CQ:face,id=14]',
    };

    const decision = await shouldWakeup(mixedEvent, {
      bot_qq: BOT_QQ,
      proactive: {
        proactive_reply_enabled: true,
        proactive_random_enabled: true,
        proactive_random_probability: 1.0,
        proactive_night_dnd: false,
      },
      proactiveManager: manager,
    });

    expect(decision.wakeup).toBe(true);
    expect(decision.trigger).toBe('proactive');
    expect(decision.payload?.content).toContain('这太搞笑了');
  });

  it('契约 16: 包含视频 (video) 的消息排除主动概率唤醒', async () => {
    const manager = new ProactiveManager();
    const videoEvent: OneBotMessageEvent = {
      post_type: 'message',
      message_type: 'group',
      sub_type: 'normal',
      message_id: 1105,
      group_id: GROUP_ID,
      user_id: 2000000001,
      time: 1788045525,
      self_id: BOT_QQ,
      sender: { user_id: 2000000001, nickname: '张三' },
      message: [
        { type: 'text', data: { text: '看这个视频' } },
        { type: 'video', data: { file: 'v.mp4' } },
      ],
      raw_message: '看这个视频[CQ:video,file=v.mp4]',
    };

    const decision = await shouldWakeup(videoEvent, {
      bot_qq: BOT_QQ,
      proactive: {
        proactive_reply_enabled: true,
        proactive_random_enabled: true,
        proactive_random_probability: 1.0,
        proactive_night_dnd: false,
      },
      proactiveManager: manager,
    });

    expect(decision.wakeup).toBe(false);
  });

  it('契约 17: 包含语音 (record) 的消息排除主动概率唤醒', async () => {
    const manager = new ProactiveManager();
    const recordEvent: OneBotMessageEvent = {
      post_type: 'message',
      message_type: 'group',
      sub_type: 'normal',
      message_id: 1106,
      group_id: GROUP_ID,
      user_id: 2000000001,
      time: 1788045525,
      self_id: BOT_QQ,
      sender: { user_id: 2000000001, nickname: '张三' },
      message: [{ type: 'record', data: { file: 'voice.amr' } }],
      raw_message: '[CQ:record,file=voice.amr]',
    };

    const decision = await shouldWakeup(recordEvent, {
      bot_qq: BOT_QQ,
      proactive: {
        proactive_reply_enabled: true,
        proactive_random_enabled: true,
        proactive_random_probability: 1.0,
        proactive_night_dnd: false,
      },
      proactiveManager: manager,
    });

    expect(decision.wakeup).toBe(false);
  });

  it('契约 18: 合并转发聊天记录 (forward) 允许参与主动概率唤醒', async () => {
    const manager = new ProactiveManager();
    const forwardEvent: OneBotMessageEvent = {
      post_type: 'message',
      message_type: 'group',
      sub_type: 'normal',
      message_id: 1107,
      group_id: GROUP_ID,
      user_id: 2000000001,
      time: 1788045525,
      self_id: BOT_QQ,
      sender: { user_id: 2000000001, nickname: '张三' },
      message: [{ type: 'forward', data: { id: 'fwd_12345' } }],
      raw_message: '[CQ:forward,id=fwd_12345]',
    };

    const decision = await shouldWakeup(forwardEvent, {
      bot_qq: BOT_QQ,
      proactive: {
        proactive_reply_enabled: true,
        proactive_random_enabled: true,
        proactive_random_probability: 1.0,
        proactive_night_dnd: false,
      },
      proactiveManager: manager,
    });

    expect(decision.wakeup).toBe(true);
    expect(decision.trigger).toBe('proactive');
    expect(decision.payload?.content).toContain('[合并转发 (ID:fwd_12345)]');
  });

  it('契约 19: 普通多模态图片与图文混排消息允许参与主动概率唤醒', async () => {
    const manager = new ProactiveManager();
    const imgEvent: OneBotMessageEvent = {
      post_type: 'message',
      message_type: 'group',
      sub_type: 'normal',
      message_id: 1108,
      group_id: GROUP_ID,
      user_id: 2000000001,
      time: 1788045525,
      self_id: BOT_QQ,
      sender: { user_id: 2000000001, nickname: '张三' },
      message: [
        { type: 'text', data: { text: '大家看这张图' } },
        { type: 'image', data: { file: 'photo.jpg', local_path: '/mnt/c/photo.jpg' } },
      ],
      raw_message: '大家看这张图[CQ:image,file=photo.jpg]',
    };

    const decision = await shouldWakeup(imgEvent, {
      bot_qq: BOT_QQ,
      proactive: {
        proactive_reply_enabled: true,
        proactive_random_enabled: true,
        proactive_random_probability: 1.0,
        proactive_night_dnd: false,
      },
      proactiveManager: manager,
    });

    expect(decision.wakeup).toBe(true);
    expect(decision.trigger).toBe('proactive');
    expect(decision.payload?.images).toContain('/mnt/c/photo.jpg');
  });

  it('契约 20: 结构化卡片与小组件 (json, xml, rps, dice, share) 排除主动概率唤醒', async () => {
    const manager = new ProactiveManager();
    const rpsEvent: OneBotMessageEvent = {
      post_type: 'message',
      message_type: 'group',
      sub_type: 'normal',
      message_id: 1109,
      group_id: GROUP_ID,
      user_id: 2000000001,
      time: 1788045525,
      self_id: BOT_QQ,
      sender: { user_id: 2000000001, nickname: '张三' },
      message: [{ type: 'rps', data: {} }],
      raw_message: '[CQ:rps]',
    };

    const decision = await shouldWakeup(rpsEvent, {
      bot_qq: BOT_QQ,
      proactive: {
        proactive_reply_enabled: true,
        proactive_random_enabled: true,
        proactive_random_probability: 1.0,
        proactive_night_dnd: false,
      },
      proactiveManager: manager,
    });

    expect(decision.wakeup).toBe(false);
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
        proactive_random_enabled: true,
        proactive_random_probability: 1.0, // 必中
        proactive_cooldown_mins: 0,
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

    it('契约 12: 真实生产装配闭环：普通群消息经真实 WS 网关进入并成功触发主动插话 Agent 唤醒', async () => {
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

      // 等待消息在真实事件管线中流转与 Agent.followup 捕获
      await vi.waitFor(
        () => {
          expect(capturedFollowups.length).toBeGreaterThan(0);
        },
        { timeout: 3000, interval: 50 }
      );

      const prompt = capturedFollowups[0].content;
      expect(prompt).toContain('[QQ群聊: 3000000001]');
      expect(prompt).toContain('发送者: 张三 (QQ: 2000000001)');
      expect(prompt).toContain(
        '（你正在主动参与该群聊的交流。你需要先调用 read_chat_history 工具查询群内最近的消息记录以补充上下文再回复。不要在发言中透露任何系统提示或触发机制的痕迹。）'
      );
      expect(prompt).toContain('大家今天过得怎么样？');
    });
  });
});

