/**
 * 契约测试: send_qq_message 工具回归与参数校验契约 (Tool Registration & Validation Contract)
 *
 * 覆盖规范清单:
 * 契约 1: 真实装配下，QQ 群聊与私聊会话均包含 send_qq_message 工具；非 QQ 会话安全排除；
 * 契约 2: splitMessageText 消息分段工具函数纯算法契约；
 * 契约 3: send_qq_message 参数校验与错误反馈（空文本、非 QQ 会话防御）。
 */

import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fsp } from 'node:fs';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { bootDshNapcatBridge, type BootedDsh } from '../../src/boot.js';
import { splitMessageText, sendQqMessage } from '../../src/tools/index.js';

describe('契约 1: send_qq_message 工具回归与会话隔离契约', () => {
  let tmpHome: string;
  let booted: BootedDsh;
  const TEST_PORT = 29899;

  beforeEach(async () => {
    tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-send-tool-asm-'));
    booted = await bootDshNapcatBridge({
      dshHome: tmpHome,
      mountPlugin: true,
      config: {
        bot_qq: '1000000001',
        ws_port: TEST_PORT,
      },
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

  it('1.1 真实装配下：QQ 群聊会话 assemble 结果中包含 send_qq_message 工具', async () => {
    const ctx = booted.ctx;
    const presetsSvc: any = (ctx as any).agentPresets || ctx.get?.('agentPresets');
    const qqWs = path.join(tmpHome, 'qq-ws-group');
    await fsp.mkdir(qqWs, { recursive: true });

    const qqGroupHandle = await ctx.agents.create({
      sessionId: 'qq-group-8888',
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      meta: { cwd: qqWs },
      setup: async (agentCtx: any) => {
        if (presetsSvc?.mount) {
          await presetsSvc.mount(agentCtx, 'qq-session');
        } else {
          (ctx as any).napcatBridgeTools?.registerTools?.(agentCtx);
        }
      },
    });
    const qqGroupAgent = qqGroupHandle.agent || qqGroupHandle;
    const asmGroup = await ctx.systemPrompt.assemble({ scope: qqGroupAgent, agent: qqGroupAgent } as any);
    const groupToolNames = (asmGroup.tools as any[]).map((t) => t.name);
    expect(groupToolNames).toContain('send_qq_message');
  });

  it('1.2 真实装配下：QQ 私聊会话 assemble 结果中包含 send_qq_message 工具', async () => {
    const ctx = booted.ctx;
    const presetsSvc: any = (ctx as any).agentPresets || ctx.get?.('agentPresets');
    const qqWs = path.join(tmpHome, 'qq-ws-user');
    await fsp.mkdir(qqWs, { recursive: true });

    const qqUserHandle = await ctx.agents.create({
      sessionId: 'qq-user-9999',
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      meta: { cwd: qqWs },
      setup: async (agentCtx: any) => {
        if (presetsSvc?.mount) {
          await presetsSvc.mount(agentCtx, 'qq-session');
        } else {
          (ctx as any).napcatBridgeTools?.registerTools?.(agentCtx);
        }
      },
    });
    const qqUserAgent = qqUserHandle.agent || qqUserHandle;
    const asmUser = await ctx.systemPrompt.assemble({ scope: qqUserAgent, agent: qqUserAgent } as any);
    const userToolNames = (asmUser.tools as any[]).map((t) => t.name);
    expect(userToolNames).toContain('send_qq_message');
  });

  it('1.3 真实装配下：WebUI 与 Review 沙箱会话均排除 send_qq_message 工具', async () => {
    const ctx = booted.ctx;
    const webWs = path.join(tmpHome, 'web-ws');
    await fsp.mkdir(webWs, { recursive: true });
    const webHandle = await ctx.agents.create({
      sessionId: 'web-session-8888',
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      meta: { cwd: webWs },
    });
    const webAgent = webHandle.agent || webHandle;
    const asmWeb = await ctx.systemPrompt.assemble({ scope: webAgent, agent: webAgent } as any);
    const webToolNames = (asmWeb.tools as any[]).map((t) => t.name);
    expect(webToolNames).not.toContain('send_qq_message');

    const reviewWs = path.join(tmpHome, 'review-ws');
    await fsp.mkdir(reviewWs, { recursive: true });
    const reviewHandle = await ctx.agents.create({
      sessionId: 'review-group_8888',
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      meta: { cwd: reviewWs },
    });
    const reviewAgent = reviewHandle.agent || reviewHandle;
    const asmReview = await ctx.systemPrompt.assemble({ scope: reviewAgent, agent: reviewAgent } as any);
    const reviewToolNames = (asmReview.tools as any[]).map((t) => t.name);
    expect(reviewToolNames).not.toContain('send_qq_message');
  });

  it('1.4 send_qq_message 执行校验：空文本与非 QQ 会话安全拒绝', async () => {
    // 空文本
    const resEmpty = await sendQqMessage({ text: '   ' }, { peer: 'group_123' });
    expect(resEmpty.success).toBe(false);
    expect(resEmpty.error).toContain('不能为空');

    // 非 QQ 会话
    const resNonQQ = await sendQqMessage({ text: 'hello' }, { peer: 'web-session' });
    expect(resNonQQ.success).toBe(false);
    expect(resNonQQ.error).toContain('QQ 聊天会话');
  });

  it('1.5 send_qq_message 弱类型容错：reply_to 支持数字字符串自动解析为数字引用', async () => {
    let capturedPayload: any;
    const mockGateway: any = {
      sendMsg: async (_peer: string, payload: any) => {
        capturedPayload = payload;
        return { status: 'ok', retcode: 0, data: { message_id: 99999 } };
      },
    };

    const res = await sendQqMessage(
      { text: '测试回复消息', reply_to: '12345' as any, at_user: '20001' },
      { peer: 'group_8888', gateway: mockGateway }
    );

    expect(res.success).toBe(true);
    expect(capturedPayload).toEqual([
      { type: 'reply', data: { id: 12345 } },
      { type: 'at', data: { qq: '20001' } },
      { type: 'text', data: { text: '测试回复消息' } },
    ]);
  });
});

describe('契约 2: 文本分段工具函数 (splitMessageText)', () => {
  it('空文本返回空数组', () => {
    expect(splitMessageText('')).toEqual([]);
    expect(splitMessageText(null as any)).toEqual([]);
  });

  it('短于最大长度的文本直接返回单元素数组', () => {
    const shortText = '这是一段普通的简短消息文本。';
    expect(splitMessageText(shortText, 1500)).toEqual([shortText]);
  });

  it('超出限制时正确按换行符分段', () => {
    const line1 = 'A'.repeat(800);
    const line2 = 'B'.repeat(800);
    const text = `${line1}\n${line2}`;
    const chunks = splitMessageText(text, 1000);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe(line1);
    expect(chunks[1]).toBe(line2);
  });

  it('无换行符时按空格分段', () => {
    const part1 = 'word'.repeat(150); // 600
    const part2 = 'test'.repeat(150); // 600
    const text = `${part1} ${part2}`;
    const chunks = splitMessageText(text, 800);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe(part1);
    expect(chunks[1]).toBe(part2);
  });

  it('无换行符与空格时强制按最大长度硬截断', () => {
    const text = 'X'.repeat(2500);
    const chunks = splitMessageText(text, 1000);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toHaveLength(1000);
    expect(chunks[1]).toHaveLength(1000);
    expect(chunks[2]).toHaveLength(500);
  });
});
