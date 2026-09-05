import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fsp } from 'node:fs';
import WebSocket from 'ws';
import { bootDshNapcatBridge, type BootedDsh } from '../../src/boot.js';
import * as NapCatBridgePlugin from '../../src/index.js';

/**
 * 契约测试: 提问拦截装配闭环 (Question Interception Assembly Contract)
 *
 * 真实装配路径验证（非 mock 桩自测）：boot 挂载插件 → 真实 WS 网关 → 模拟 NapCat 客户端：
 * - 群聊引用锚定的 message_id 缓存 + 匹配：只有引用当前题卡片的入站消息被提问拦截消费，
 *   未引用/引用错误消息不 consume（不 resolve、不误吞，走普通消息流）；
 * - 串行多题经真实消息流逐题推进：每题各自锚定自己的卡片，最后一次性 resolve 全部答案；
 * - 装配级断言插件提问渠道可达（userQuestions.provider 经官方 registerProvider 注册）。
 */

const GROUP_ID = 3000000001;
const BOT_QQ = '1000000001';
const USER_QQ = '2000000001';
const WS_PORT = 18321;

describe('契约测试: 提问拦截装配闭环 (Question Interception Assembly)', () => {
  let tmpHome: string;
  let booted: BootedDsh;
  let client: WebSocket;
  /** 已收到的 WS 帧（action 请求），按序消费 */
  let frames: Array<Record<string, any>> = [];
  let frameWaiters: Array<{
    action: string;
    resolve: (f: Record<string, any>) => void;
    timer: NodeJS.Timeout;
  }> = [];

  beforeEach(async () => {
    tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-napcat-qintercept-'));
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
    client.on('message', (data) => {
      const frame = JSON.parse(data.toString());
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

  /** 等待下一个指定 action 的 WS 帧（2s 超时） */
  function waitForAction(action: string, timeoutMs = 2000): Promise<Record<string, any>> {
    const queuedIdx = frames.findIndex((f) => f.action === action);
    if (queuedIdx >= 0) {
      return Promise.resolve(frames.splice(queuedIdx, 1)[0]);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        frameWaiters = frameWaiters.filter((x) => x !== waiter);
        reject(new Error(`等待 action ${action} 超时 (已收到: ${JSON.stringify(frames.map((f) => f.action))})`));
      }, timeoutMs);
      const waiter = { action, resolve, timer };
      frameWaiters.push(waiter as any);
    });
  }

  /** 应答 action 请求（echo 回填 + 指定 message_id） */
  function respond(frame: Record<string, any>, messageId: number | string) {
    client.send(JSON.stringify({ echo: frame.echo, status: 'ok', retcode: 0, data: { message_id: messageId } }));
  }

  /** 断言在等待窗口内没有收到指定 action（负例） */
  async function expectNoAction(action: string, waitMs = 150): Promise<void> {
    await new Promise((r) => setTimeout(r, waitMs));
    expect(frames.some((f) => f.action === action)).toBe(false);
  }

  /** 构造 NapCat 入站群消息事件（可带引用段） */
  function inboundGroupMessage(text: string, opts: { messageId?: number; replyTo?: number | string; raw?: string } = {}) {
    const message: any[] = [];
    if (opts.replyTo !== undefined) {
      message.push({ type: 'reply', data: { id: opts.replyTo } });
    }
    message.push({ type: 'text', data: { text } });
    return {
      post_type: 'message',
      message_type: 'group',
      sub_type: 'normal',
      message_id: opts.messageId ?? Math.floor(Math.random() * 1e6),
      user_id: USER_QQ,
      group_id: GROUP_ID,
      sender: { user_id: USER_QQ, nickname: '测试用户', card: '测试用户' },
      message,
      raw_message: opts.raw ?? text,
      time: Math.floor(Date.now() / 1000),
      self_id: BOT_QQ,
    };
  }

  it('装配: 提问渠道可达（经官方 userQuestions 服务与 waterfall 接入 NapCat 提问渠道），群聊引用锚定 + 串行多题经真实消息流转闭环', async () => {
    // 创建真实 Live Agent 保证 caller live 校验通过
    const agentHandle = await booted.ctx.agents.create({
      sessionId: `qq-group-${GROUP_ID}`,
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      meta: { cwd: path.join(tmpHome, 'agent-ws') },
    });
    const qqAgent = agentHandle.agent || agentHandle;

    // 装配可达性断言：直接调用官方服务层 ask，验证 waterfall → NapCatQuestionProvider 完整生产路径
    // agent 一次传 2 道题 → 只发第 1 题卡片
    const askPromise = booted.ctx.userQuestions.ask({
      agent: qqAgent,
      questions: [
        { id: 'q1', question: '部署环境?', options: [{ label: '生产' }, { label: '测试' }] },
        { id: 'q2', question: '回滚策略?', options: [{ label: '手动' }, { label: '自动' }] },
      ],
      signal: new AbortController().signal,
    });

    const card1 = await waitForAction('send_group_msg');
    expect(String(card1.params.message)).toContain('部署环境?');
    expect(String(card1.params.message)).not.toContain('回滚策略?');
    expect(String(card1.params.group_id)).toBe(String(GROUP_ID));
    respond(card1, 9001);

    // 群聊引用锚定负例：未引用卡片的回复不 consume（不 resolve、不发下一张卡片、不误吞）
    client.send(JSON.stringify(inboundGroupMessage('1')));
    await expectNoAction('send_group_msg');

    // 引用当前题卡片 → 拦截消费 → 立即发第 2 题卡片
    client.send(JSON.stringify(inboundGroupMessage('2', { replyTo: 9001 })));
    const card2 = await waitForAction('send_group_msg');
    expect(String(card2.params.message)).toContain('回滚策略?');
    expect(String(card2.params.message)).not.toContain('部署环境?');
    respond(card2, 9002);

    // 第 2 题引用错误卡片 → 不命中（不发第 3 张卡片）；引用自己的卡片 → 收尾 resolve
    client.send(JSON.stringify(inboundGroupMessage('1', { replyTo: 9001 })));
    await expectNoAction('send_group_msg');
    client.send(JSON.stringify(inboundGroupMessage('1', { replyTo: 9002 })));

    const answer = await askPromise;
    expect(answer.answers).toHaveLength(2);
    expect(answer.answers[0]).toEqual({ id: 'q1', selected: ['测试'] });
    expect(answer.answers[1]).toEqual({ id: 'q2', selected: ['手动'] });
  });
});