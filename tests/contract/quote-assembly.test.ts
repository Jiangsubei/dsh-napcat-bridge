import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fsp } from 'node:fs';
import WebSocket from 'ws';
import { bootDshNapcatBridge, type BootedDsh } from '../../src/boot.js';
import * as NapCatBridgePlugin from '../../src/index.js';
import { MessageDatabase } from '../../src/storage/database.js';

/**
 * 契约测试: 引用消息真实生产装配闭环 (Quote Assembly Contract)
 *
 * 真实装配路径验证（非 mock 桩自测）：boot 挂载插件 → 真实 WS 网关 → 模拟 NapCat 客户端：
 * - 场景 1: 前置图片消息入库 → 后续引用该图片并 @机器人 → 唤醒包 Prompt 完整渲染 [引用回复 ...] + 文本；
 * - 场景 2: 引用机器人启动前历史消息（本地 DB 未命中） → NapCat get_msg API 实时反查成功 → 自动回填入库 + 唤醒包注入引用内容；
 * - 场景 3: 本地与 NapCat 均查无此消息 → 优雅降级为占位提示，不中断唤醒。
 */

const GROUP_ID = 3000000001;
const BOT_QQ = '1000000001';
const USER_QQ = '2000000001';
const WS_PORT = 18335;

describe('契约测试: 引用消息真实生产装配闭环 (Quote Assembly Contract)', () => {
  let tmpHome: string;
  let booted: BootedDsh;
  let client: WebSocket;
  let frames: Array<Record<string, any>> = [];
  let frameWaiters: Array<{
    action: string;
    resolve: (f: Record<string, any>) => void;
    timer: NodeJS.Timeout;
  }> = [];
  let capturedFollowups: Array<{ content: string }> = [];
  let capturedUserMsgs: any[] = [];
  let agent: any;

  beforeEach(async () => {
    tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-napcat-quote-asm-'));
    capturedFollowups = [];
    capturedUserMsgs = [];
    frames = [];
    frameWaiters = [];

    booted = await bootDshNapcatBridge({ dshHome: tmpHome, mountPlugin: false });
    await booted.ctx.plugin(NapCatBridgePlugin, {
      bot_qq: BOT_QQ,
      ws_port: WS_PORT,
    });

    // 预创建群聊 Agent 并接管 followup 捕获 Wakeup Prompt
    const agents: any = booted.ctx.get('agents');
    const handle = await agents.create({
      sessionId: `qq-group-${GROUP_ID}`,
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      meta: { cwd: path.join(tmpHome, 'agent-cwd') },
    });
    agent = handle.agent || handle;
    agent.followup = (msg: any) => {
      capturedUserMsgs.push(msg);
      const text = Array.isArray(msg?.content)
        ? msg.content.map((c: any) => c?.text || '').join('')
        : String(msg?.content || '');
      capturedFollowups.push({ content: text });
    };

    client = new WebSocket(`ws://127.0.0.1:${WS_PORT}`);
    await new Promise<void>((resolve, reject) => {
      client.once('open', () => resolve());
      client.once('error', reject);
    });

    client.on('message', (data) => {
      const frame = JSON.parse(data.toString());
      if (frame.action === 'get_group_member_info') {
        client.send(
          JSON.stringify({
            echo: frame.echo,
            status: 'ok',
            retcode: 0,
            data: { nickname: 'BotNickname', card: 'BotNickname' },
          })
        );
        return;
      }
      if (frame.action === 'get_group_info') {
        client.send(
          JSON.stringify({
            echo: frame.echo,
            status: 'ok',
            retcode: 0,
            data: { group_name: '温馨树洞小屋' },
          })
        );
        return;
      }
      const w = frameWaiters.find((x) => x.action === frame.action);
      if (w) {
        clearTimeout(w.timer);
        frameWaiters = frameWaiters.filter((x) => x !== w);
        w.resolve(frame);
      } else {
        frames.push(frame);
      }
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

  function waitForAction(action: string, timeoutMs = 2000): Promise<Record<string, any>> {
    const queuedIdx = frames.findIndex((f) => f.action === action);
    if (queuedIdx >= 0) {
      return Promise.resolve(frames.splice(queuedIdx, 1)[0]);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        frameWaiters = frameWaiters.filter((x) => x !== waiter);
        reject(new Error(`等待 action ${action} 超时`));
      }, timeoutMs);
      const waiter = { action, resolve, timer };
      frameWaiters.push(waiter as any);
    });
  }

  it('场景 1: 本地命中 — 前置图片入库后，引用该图片并 @机器人，Prompt 必须包含 [引用回复 ...]', async () => {
    // 1. 下发前置图片消息 (msg_id: 88888)
    const prevMsg = {
      post_type: 'message',
      message_type: 'group',
      sub_type: 'normal',
      message_id: 88888,
      group_id: GROUP_ID,
      user_id: 1617307295,
      time: 1788045800,
      self_id: BOT_QQ,
      sender: { user_id: 1617307295, nickname: '用户名加载中…', card: '用户名加载中…' },
      message: [
        {
          type: 'image',
          data: {
            file: 'test.jpg',
            local_path: '/dsh/workspace/napcat_download/image/common/test.jpg',
          },
        },
      ],
      raw_message: '[CQ:image,file=test.jpg]',
    };
    client.send(JSON.stringify(prevMsg));

    await new Promise((r) => setTimeout(r, 100));

    // 2. 下发引用消息 (msg_id: 99999) 引用 88888 并 @机器人
    const msgEvent = {
      post_type: 'message',
      message_type: 'group',
      sub_type: 'normal',
      message_id: 99999,
      group_id: GROUP_ID,
      user_id: USER_QQ,
      time: 1788045820,
      self_id: BOT_QQ,
      sender: { user_id: USER_QQ, nickname: '你醒了？你被基米单杀了', card: '你醒了？你被基米单杀了' },
      message: [
        { type: 'reply', data: { id: 88888 } },
        { type: 'at', data: { qq: BOT_QQ } },
        { type: 'text', data: { text: ' 说的这个图' } },
      ],
      raw_message: `[CQ:reply,id=88888][CQ:at,qq=${BOT_QQ}] 说的这个图`,
    };
    client.send(JSON.stringify(msgEvent));

    await new Promise((r) => setTimeout(r, 200));

    expect(capturedFollowups).toHaveLength(1);
    const prompt = capturedFollowups[0].content;
    expect(prompt).toContain(`[QQ群聊: ${GROUP_ID}]`);
    expect(prompt).toContain('发送者: 你醒了？你被基米单杀了 (QQ: 2000000001)');
    expect(prompt).toContain('[引用回复 用户名加载中… (QQ: 1617307295): "[图片:/dsh/workspace/napcat_download/image/common/test.jpg]"]');
    expect(prompt).toContain('说的这个图');
  });

  it('场景 2: 本地未命中 — 引用启动前历史消息时触发 get_msg API 二级兜底并回填入库', async () => {
    // 下发引用未在本地出现过的消息 (msg_id: 77777)
    const msgEvent = {
      post_type: 'message',
      message_type: 'group',
      sub_type: 'normal',
      message_id: 99998,
      group_id: GROUP_ID,
      user_id: USER_QQ,
      time: 1788045820,
      self_id: BOT_QQ,
      sender: { user_id: USER_QQ, nickname: '提问者', card: '提问者' },
      message: [
        { type: 'reply', data: { id: 77777 } },
        { type: 'at', data: { qq: BOT_QQ } },
        { type: 'text', data: { text: ' 这句话什么意思' } },
      ],
      raw_message: `[CQ:reply,id=77777][CQ:at,qq=${BOT_QQ}] 这句话什么意思`,
    };
    client.send(JSON.stringify(msgEvent));

    // 网关检测到本地未命中，向 NapCat 发送 get_msg 请求
    const getMsgFrame = await waitForAction('get_msg');
    expect(getMsgFrame.params.message_id).toBe(77777);

    // 客户端应答 get_msg
    client.send(
      JSON.stringify({
        echo: getMsgFrame.echo,
        status: 'ok',
        retcode: 0,
        data: {
          message_id: 77777,
          time: 1788045700,
          user_id: 33334444,
          sender: { user_id: 33334444, nickname: '历史用户', card: '历史用户' },
          message: [{ type: 'text', data: { text: '这是历史上一条重要消息' } }],
          raw_message: '这是历史上一条重要消息',
        },
      })
    );

    await new Promise((r) => setTimeout(r, 200));

    expect(capturedFollowups).toHaveLength(1);
    const prompt = capturedFollowups[0].content;
    expect(prompt).toContain('[引用回复 历史用户 (QQ: 33334444): "这是历史上一条重要消息"]');
    expect(prompt).toContain('这句话什么意思');
  });

  it('场景 3: 双失败 — 历史消息拉取失败时优雅降级为占位提示，唤醒不中断', async () => {
    // 下发引用不存在的消息 (msg_id: 66666)
    const msgEvent = {
      post_type: 'message',
      message_type: 'group',
      sub_type: 'normal',
      message_id: 99997,
      group_id: GROUP_ID,
      user_id: USER_QQ,
      time: 1788045820,
      self_id: BOT_QQ,
      sender: { user_id: USER_QQ, nickname: '提问者', card: '提问者' },
      message: [
        { type: 'reply', data: { id: 66666 } },
        { type: 'at', data: { qq: BOT_QQ } },
        { type: 'text', data: { text: ' 之前的结论是什么' } },
      ],
      raw_message: `[CQ:reply,id=66666][CQ:at,qq=${BOT_QQ}] 之前的结论是什么`,
    };
    client.send(JSON.stringify(msgEvent));

    // 网关尝试 get_msg
    const getMsgFrame = await waitForAction('get_msg');
    expect(getMsgFrame.params.message_id).toBe(66666);

    // 客户端应答 404 / 失败
    client.send(
      JSON.stringify({
        echo: getMsgFrame.echo,
        status: 'failed',
        retcode: 1404,
        message: 'Message not found or expired',
      })
    );

    await new Promise((r) => setTimeout(r, 200));

    expect(capturedFollowups).toHaveLength(1);
    const prompt = capturedFollowups[0].content;
    expect(prompt).toContain('[引用回复 消息ID: 66666: "〔历史引用消息：内容已过期或无法获取〕"]');
    expect(prompt).toContain('之前的结论是什么');
  });

  it('场景 4: 引用本地历史卡片消息 — cached.raw 动态重解析升级，完整提取直链与封面图', async () => {
    // 1. 模拟历史旧数据在 SQLite 中（保存时只有老格式无链接 content，但有 raw）
    const dbPath = path.join(tmpHome, 'workspace', 'napcat', 'messages.sqlite');
    const db = new MessageDatabase(dbPath);
    db.init();
    db.saveMessage({
      msg_id: 1684979878,
      peer: `group_${GROUP_ID}`,
      user_id: '2794950199',
      sender_name: '在这',
      time: 1788246335000,
      type: 'json',
      content: '[卡片消息:[QQ小程序]我讨厌黑色，却选择了墨岩]', // 老格式无链接
      raw: JSON.stringify([
        {
          type: 'json',
          data: {
            data: JSON.stringify({
              ver: '1.0.0.19',
              prompt: '[QQ小程序]我讨厌黑色，却选择了墨岩',
              app: 'com.tencent.miniapp_01',
              meta: {
                detail_1: {
                  appid: '1109937557',
                  title: '哔哩哔哩',
                  desc: '我讨厌黑色，却选择了墨岩',
                  icon: 'https://open.gtimg.cn/open/app_icon/00/95/17/76/100951776_100_m.png?t=1787736665',
                  preview: 'https://qq.ugcimg.cn/v1/08du1gpgshmqa998g5mlbujmlkihsgd9vu9u6p9j5bn4oidqqmvdvugn2t6ml1rtfb7sj0cgm9hj5ur7vp0oaj09op7kdinskflecr3akp7rkl4q05o5rmvabpqq7bnesngql8egougd5r0fupvhe3tl04/e9vf2tsqr6j29hl2kodb3vahlc',
                  url: 'm.q.qq.com/a/s/3b0f15c1f5e3bb76a5439fd09397295e',
                  qqdocurl: 'https://b23.tv/qSGBhv4?share_medium=android&share_source=qq&bbid=XXD8605D2B9502CF7816EC606686E7F683D68&ts=1788246331916',
                },
              },
            }),
          },
        },
      ]),
      file_id: null,
      busid: null,
      local_path: null,
      fingerprint: null,
      recalled: 0,
      self: 0,
      reply_to: null,
    });

    // 2. 用户发送引用该卡片的消息并 @机器人
    const msgEvent = {
      post_type: 'message',
      message_type: 'group',
      sub_type: 'normal',
      message_id: 99998,
      group_id: GROUP_ID,
      user_id: USER_QQ,
      time: 1788246400,
      self_id: BOT_QQ,
      sender: { user_id: USER_QQ, nickname: '你醒了？你被基米单杀了', card: '你醒了？你被基米单杀了' },
      message: [
        { type: 'reply', data: { id: 1684979878 } },
        { type: 'at', data: { qq: BOT_QQ } },
        { type: 'text', data: { text: ' 看看这个' } },
      ],
      raw_message: `[CQ:reply,id=1684979878][CQ:at,qq=${BOT_QQ}] 看看这个`,
    };
    client.send(JSON.stringify(msgEvent));

    await new Promise((r) => setTimeout(r, 200));

    expect(capturedFollowups).toHaveLength(1);
    const prompt = capturedFollowups[0].content;
    // 验证：动态重解析生效，成功注入了直达链接与封面图！
    expect(prompt).toContain(
      '[引用回复 在这 (QQ: 2794950199): "[卡片消息:[QQ小程序]我讨厌黑色，却选择了墨岩](https://b23.tv/qSGBhv4?share_medium=android&share_source=qq&bbid=XXD8605D2B9502CF7816EC606686E7F683D68&ts=1788246331916) [封面:https://qq.ugcimg.cn/v1/08du1gpgshmqa998g5mlbujmlkihsgd9vu9u6p9j5bn4oidqqmvdvugn2t6ml1rtfb7sj0cgm9hj5ur7vp0oaj09op7kdinskflecr3akp7rkl4q05o5rmvabpqq7bnesngql8egougd5r0fupvhe3tl04/e9vf2tsqr6j29hl2kodb3vahlc]"]'
    );
    expect(prompt).toContain('看看这个');
  });

  it('场景 5: 真实装配下连续两条入站消息排队，出站回复精准引用各自对应的入站消息（Turn 级精准绑定装配闭环）', async () => {
    // 监听客户端向 NapCat 发送的 send_group_msg action
    const sentGroupMessages: Array<Record<string, any>> = [];
    client.on('message', (data) => {
      const frame = JSON.parse(data.toString());
      if (frame.action === 'send_group_msg') {
        sentGroupMessages.push(frame);
        // 回包模拟 NapCat 成功
        client.send(
          JSON.stringify({
            echo: frame.echo,
            status: 'ok',
            retcode: 0,
            data: { message_id: Math.floor(Math.random() * 100000) },
          })
        );
      }
    });

    // 1. 用户发送第一条入站消息 88801 并 @机器人
    const msgEvent1 = {
      post_type: 'message',
      message_type: 'group',
      sub_type: 'normal',
      message_id: 88801,
      group_id: GROUP_ID,
      user_id: USER_QQ,
      time: 1788246500,
      self_id: BOT_QQ,
      sender: { user_id: USER_QQ, nickname: '提问者A', card: '提问者A' },
      message: [
        { type: 'at', data: { qq: BOT_QQ } },
        { type: 'text', data: { text: ' 轮次A问题' } },
      ],
      raw_message: `[CQ:at,qq=${BOT_QQ}] 轮次A问题`,
    };
    client.send(JSON.stringify(msgEvent1));

    // 等待消息 1 流转并被 agent 捕获
    await new Promise((r) => setTimeout(r, 150));
    expect(capturedUserMsgs).toHaveLength(1);

    // 2. 轮次 A 尚未结束（未出站）时，用户又发送了第二条消息 88802（排队）
    const msgEvent2 = {
      post_type: 'message',
      message_type: 'group',
      sub_type: 'normal',
      message_id: 88802,
      group_id: GROUP_ID,
      user_id: '3456789012',
      time: 1788246505,
      self_id: BOT_QQ,
      sender: { user_id: '3456789012', nickname: '提问者B', card: '提问者B' },
      message: [
        { type: 'at', data: { qq: BOT_QQ } },
        { type: 'text', data: { text: ' 轮次B问题' } },
      ],
      raw_message: `[CQ:at,qq=${BOT_QQ}] 轮次B问题`,
    };
    client.send(JSON.stringify(msgEvent2));

    // 等待消息 2 流转并被 agent 捕获
    await new Promise((r) => setTimeout(r, 150));
    expect(capturedUserMsgs).toHaveLength(2);

    const session = agent.session;

    // 3. 驱动轮次 1 (Turn 1): 模拟 DSH 驱动器消费消息 1
    (booted.ctx as any).emit('session/event', session, {
      seq: 0,
      type: 'turn/start',
      data: { turn: 1 },
    });
    (booted.ctx as any).emit('session/event', session, {
      seq: 1,
      type: 'user/message',
      data: capturedUserMsgs[0],
    });
    // 轮次 1 产生模型回复
    (booted.ctx as any).emit('session/event', session, {
      seq: 2,
      type: 'assistant/message',
      data: {
        turn: 1,
        step: 1,
        message: { content: [{ type: 'text', text: '轮次 1 最终答复' }] },
      },
    });
    (booted.ctx as any).emit('session/event', session, {
      seq: 3,
      type: 'turn/end',
      data: { turn: 1, reason: { kind: 'completed' } },
    });

    // 等待出站串行发送
    await new Promise((r) => setTimeout(r, 150));

    // 4. 驱动轮次 2 (Turn 2): 模拟 DSH 驱动器消费排队的消息 2
    (booted.ctx as any).emit('session/event', session, {
      seq: 4,
      type: 'turn/start',
      data: { turn: 2 },
    });
    (booted.ctx as any).emit('session/event', session, {
      seq: 5,
      type: 'user/message',
      data: capturedUserMsgs[1],
    });
    // 轮次 2 产生模型回复
    (booted.ctx as any).emit('session/event', session, {
      seq: 6,
      type: 'assistant/message',
      data: {
        turn: 2,
        step: 1,
        message: { content: [{ type: 'text', text: '轮次 2 最终答复' }] },
      },
    });
    (booted.ctx as any).emit('session/event', session, {
      seq: 7,
      type: 'turn/end',
      data: { turn: 2, reason: { kind: 'completed' } },
    });

    // 等待出站串行发送
    await new Promise((r) => setTimeout(r, 150));

    // 5. 验证真实 WS 下发的出站消息
    expect(sentGroupMessages).toHaveLength(2);

    // 轮次 1 的出站消息必须引用 88801，绝不能引用 88802
    const outboundMsg1 = sentGroupMessages[0].params.message;
    const replySeg1 = Array.isArray(outboundMsg1)
      ? outboundMsg1.find((s: any) => s.type === 'reply')
      : null;
    expect(replySeg1).toBeDefined();
    expect(Number(replySeg1.data.id)).toBe(88801);

    // 轮次 2 的出站消息必须引用 88802
    const outboundMsg2 = sentGroupMessages[1].params.message;
    const replySeg2 = Array.isArray(outboundMsg2)
      ? outboundMsg2.find((s: any) => s.type === 'reply')
      : null;
    expect(replySeg2).toBeDefined();
    expect(Number(replySeg2.data.id)).toBe(88802);
  });
});

