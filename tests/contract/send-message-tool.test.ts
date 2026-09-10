/**
 * 契约测试: send_qq_message 工具下线与直发架构防护契约 (Decommission & Isolation Contract)
 *
 * 覆盖规范清单:
 * 契约 1: 真实装配下，QQ 群聊、私聊、WebUI、沙箱等所有会话中严禁注册 send_qq_message 工具；
 * 契约 2: splitMessageText 消息分段工具函数纯算法契约；
 * 契约 3: tools 执行未注册的 send_qq_message 返回 isError: true，避免误调。
 */

import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fsp } from 'node:fs';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { bootDshNapcatBridge, type BootedDsh } from '../../src/boot.js';
import { splitMessageText } from '../../src/tools/index.js';

describe('契约 1: send_qq_message 工具全面下线与隔离防护', () => {
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

  it('1.1 真实装配下：QQ 群聊会话 assemble 结果中严禁包含 send_qq_message 工具', async () => {
    const ctx = booted.ctx;
    const qqGroupHandle = await ctx.agents.create({
      sessionId: 'qq-group-8888',
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      meta: { cwd: path.join(tmpHome, 'qq-ws-group') },
    });
    const qqGroupAgent = qqGroupHandle.agent || qqGroupHandle;
    const asmGroup = await ctx.systemPrompt.assemble({ scope: qqGroupAgent, agent: qqGroupAgent } as any);
    const groupToolNames = (asmGroup.tools as any[]).map((t) => t.name);
    expect(groupToolNames).not.toContain('send_qq_message');
  });

  it('1.2 真实装配下：QQ 私聊会话 assemble 结果中严禁包含 send_qq_message 工具', async () => {
    const ctx = booted.ctx;
    const qqUserHandle = await ctx.agents.create({
      sessionId: 'qq-user-9999',
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      meta: { cwd: path.join(tmpHome, 'qq-ws-user') },
    });
    const qqUserAgent = qqUserHandle.agent || qqUserHandle;
    const asmUser = await ctx.systemPrompt.assemble({ scope: qqUserAgent, agent: qqUserAgent } as any);
    const userToolNames = (asmUser.tools as any[]).map((t) => t.name);
    expect(userToolNames).not.toContain('send_qq_message');
  });

  it('1.3 真实装配下：WebUI 与 Review 沙箱会话均排除 send_qq_message 工具', async () => {
    const ctx = booted.ctx;
    const webHandle = await ctx.agents.create({
      sessionId: 'web-session-8888',
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      meta: { cwd: path.join(tmpHome, 'web-ws') },
    });
    const webAgent = webHandle.agent || webHandle;
    const asmWeb = await ctx.systemPrompt.assemble({ scope: webAgent, agent: webAgent } as any);
    const webToolNames = (asmWeb.tools as any[]).map((t) => t.name);
    expect(webToolNames).not.toContain('send_qq_message');

    const reviewHandle = await ctx.agents.create({
      sessionId: 'review-group_8888',
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      meta: { cwd: path.join(tmpHome, 'review-ws') },
    });
    const reviewAgent = reviewHandle.agent || reviewHandle;
    const asmReview = await ctx.systemPrompt.assemble({ scope: reviewAgent, agent: reviewAgent } as any);
    const reviewToolNames = (asmReview.tools as any[]).map((t) => t.name);
    expect(reviewToolNames).not.toContain('send_qq_message');
  });

  it('1.4 真实装配下：调用未注册的 send_qq_message 工具被系统安全拒执', async () => {
    const ctx = booted.ctx;
    const tools: any = ctx.get('tools');
    const qqGroupHandle = await ctx.agents.create({
      sessionId: 'qq-group-8888',
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      meta: { cwd: path.join(tmpHome, 'qq-ws-group') },
    });
    const qqGroupAgent = qqGroupHandle.agent || qqGroupHandle;

    const res = await tools.execute({
      name: 'send_qq_message',
      arguments: { text: 'test' },
      agent: qqGroupAgent,
      signal: new AbortController().signal,
    });
    expect(res.isError).toBe(true);
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
