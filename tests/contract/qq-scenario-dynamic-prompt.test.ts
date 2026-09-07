/**
 * 契约测试: QQ 会话专属动态提示词段 (QQ Scenario Dynamic Prompt Contract)
 *
 * 验证规则:
 * 1. 契约 1: 在 QQ 群聊会话 (qq-group-* 或 group_*) 下，通过 systemPrompt.context 渲染出的动态段文本包含定稿内容；
 * 2. 契约 2: 在 QQ 私聊会话 (qq-user-* 或 user_*) 下，通过 systemPrompt.context 渲染出的动态段文本同样包含定稿内容；
 * 3. 契约 3: 在非 QQ 会话（如 web-*、review-* 沙箱等）下，返回空字符串 ''；
 * 4. 契约 4: 校验 order 属性为 10，排在 napcat:memory (40) 与 napcat:behavior_persona (50) 之前；
 * 5. 契约 5: 独立注册与注销清理闭环 (Disposer Contract)。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fsp } from 'node:fs';
import { bootDshNapcatBridge, type BootedDsh } from '../../src/boot.js';
import { registerQQScenarioDynamicPrompt, QQ_SCENARIO_PROMPT } from '../../src/prompt/dynamic.js';

const EXPECTED_PROMPT_TEXT = `# 如何发送消息

你正在 QQ 聊天中与用户对话。

【如何把内容送达用户】
- 想向用户发送文字/答复，必须调用 send_qq_message 工具。请勿直接在回复正文中回复，写在回复正文里的文字不会发送给用户。`;

describe('契约测试: QQ 会话专属动态提示词段 (QQ Scenario Dynamic Prompt)', () => {
  let tmpHome: string;
  let booted: BootedDsh;
  const TEST_PORT = 29888;

  beforeEach(async () => {
    tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-napcat-qq-prompt-'));
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

  it('契约 1: 在 QQ 群聊会话 (qq-group-* / group_*) 下，渲染出的动态段文本包含定稿内容', async () => {
    const assemblyGroup = await booted.ctx.systemPrompt.assemble({
      session: { id: 'qq-group-123456-1' },
    } as any);

    const qqScenarioCtx = assemblyGroup.contexts.find((c: any) => c.name === 'napcat:qq_scenario');
    expect(qqScenarioCtx).toBeDefined();
    expect(qqScenarioCtx?.text).toBe(EXPECTED_PROMPT_TEXT);
    expect(qqScenarioCtx?.text).toContain('# 如何发送消息');
    expect(qqScenarioCtx?.text).toContain('必须调用 send_qq_message 工具');
    expect(qqScenarioCtx?.text).toContain('写在回复正文里的文字不会发送给用户');
    // 严禁告知 turn/end 兜底机制（隐形安全网）
    expect(qqScenarioCtx?.text).not.toContain('turn/end');
    expect(qqScenarioCtx?.text).not.toContain('兜底');
    expect(qqScenarioCtx?.text).not.toContain('安全网');

    // 同样验证 group_ 前缀
    const assemblyPeerGroup = await booted.ctx.systemPrompt.assemble({
      peer: 'group_987654',
    } as any);
    const qqPeerCtx = assemblyPeerGroup.contexts.find((c: any) => c.name === 'napcat:qq_scenario');
    expect(qqPeerCtx?.text).toBe(EXPECTED_PROMPT_TEXT);
  });

  it('契约 2: 在 QQ 私聊会话 (qq-user-* / user_*) 下，渲染出的动态段文本同样包含定稿内容', async () => {
    const assemblyUser = await booted.ctx.systemPrompt.assemble({
      session: { id: 'qq-user-999888' },
    } as any);

    const qqScenarioCtx = assemblyUser.contexts.find((c: any) => c.name === 'napcat:qq_scenario');
    expect(qqScenarioCtx).toBeDefined();
    expect(qqScenarioCtx?.text).toBe(EXPECTED_PROMPT_TEXT);

    // 同样验证 user_ 前缀
    const assemblyPeerUser = await booted.ctx.systemPrompt.assemble({
      peer: 'user_888999',
    } as any);
    const qqPeerCtx = assemblyPeerUser.contexts.find((c: any) => c.name === 'napcat:qq_scenario');
    expect(qqPeerCtx?.text).toBe(EXPECTED_PROMPT_TEXT);
  });

  it('契约 3: 在非 QQ 会话（如 web-*、review-* 沙箱、空上下文）下，返回空字符串 \'\'', async () => {
    // 3.1 Web UI 会话
    const assemblyWeb = await booted.ctx.systemPrompt.assemble({
      session: { id: 'web-session-42' },
    } as any);
    const webCtx = assemblyWeb.contexts.find((c: any) => c.name === 'napcat:qq_scenario');
    expect(webCtx).toBeDefined();
    expect(webCtx?.text).toBe('');

    // 3.2 沙箱 Review 会话
    const assemblyReview = await booted.ctx.systemPrompt.assemble({
      session: { id: 'review-group_123456' },
    } as any);
    const reviewCtx = assemblyReview.contexts.find((c: any) => c.name === 'napcat:qq_scenario');
    expect(reviewCtx).toBeDefined();
    expect(reviewCtx?.text).toBe('');

    // 3.3 无 session/peer 的普通/全局上下文
    const assemblyEmpty = await booted.ctx.systemPrompt.assemble();
    const emptyCtx = assemblyEmpty.contexts.find((c: any) => c.name === 'napcat:qq_scenario');
    expect(emptyCtx).toBeDefined();
    expect(emptyCtx?.text).toBe('');
  });

  it('契约 4: 校验 order 属性为 10，排在 napcat:memory (40) 与 napcat:behavior_persona (50) 之前', async () => {
    // 4.1 检查系统内注册层上的原始 order 配置
    const contextMap = (booted.ctx.systemPrompt as any).layers.merge(undefined, (l: any) => l.contexts);
    const qqScenario = contextMap.get('napcat:qq_scenario');
    const memory = contextMap.get('napcat:memory');
    const persona = contextMap.get('napcat:behavior_persona');

    expect(qqScenario).toBeDefined();
    expect(qqScenario.order).toBe(10);
    expect(memory).toBeDefined();
    expect(memory.order).toBe(40);
    expect(persona).toBeDefined();
    expect(persona.order).toBe(50);
    expect(qqScenario.order).toBeLessThan(memory.order);
    expect(memory.order).toBeLessThan(persona.order);

    // 4.2 检查真实 assemble() 组装输出中 contexts 数组的相对顺序
    const assembly = await booted.ctx.systemPrompt.assemble({
      session: { id: 'qq-group-10001' },
    } as any);

    const names = assembly.contexts.map((c: any) => c.name);
    const qqScenarioIdx = names.indexOf('napcat:qq_scenario');
    const memIdx = names.indexOf('napcat:memory');
    const personaIdx = names.indexOf('napcat:behavior_persona');

    expect(qqScenarioIdx).toBeGreaterThanOrEqual(0);
    expect(memIdx).toBeGreaterThan(qqScenarioIdx);
    expect(personaIdx).toBeGreaterThan(memIdx);
  });

  it('契约 5: 独立注册与注销清理闭环 (Disposer Contract)', async () => {
    // 在未挂载插件的独立 boot 环境下测试独立注册与注销
    const unmountedHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-napcat-unmounted-'));
    const unmountedBoot = await bootDshNapcatBridge({
      dshHome: unmountedHome,
      mountPlugin: false,
    });

    try {
      const disposer = registerQQScenarioDynamicPrompt(unmountedBoot.ctx);
      expect(typeof disposer).toBe('function');

      // 注册后可组装到 napcat:qq_scenario
      let asm = await unmountedBoot.ctx.systemPrompt.assemble({
        session: { id: 'qq-group-777' },
      } as any);
      expect(asm.contexts.find((c: any) => c.name === 'napcat:qq_scenario')?.text).toBe(EXPECTED_PROMPT_TEXT);

      // 注销后该段不再存在
      disposer();
      asm = await unmountedBoot.ctx.systemPrompt.assemble({
        session: { id: 'qq-group-777' },
      } as any);
      expect(asm.contexts.find((c: any) => c.name === 'napcat:qq_scenario')).toBeUndefined();
    } finally {
      await unmountedBoot.dispose().catch(() => {});
      await fsp.rm(unmountedHome, { recursive: true, force: true }).catch(() => {});
    }
  });
});
