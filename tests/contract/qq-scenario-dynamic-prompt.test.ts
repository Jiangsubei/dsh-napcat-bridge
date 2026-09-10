/**
 * 契约测试: QQ 会话专属动态提示词段下线与提示词干净度契约 (QQ Scenario Clean Contract)
 *
 * 验证规则:
 * 1. 契约 1: 在 QQ 群聊会话 (qq-group-* 或 group_*) 下，严禁注入 napcat:qq_scenario，绝不包含“如何发送消息”或 send_qq_message 指令；
 * 2. 契约 2: 在 QQ 私聊会话 (qq-user-* 或 user_*) 下，同样严禁注入 napcat:qq_scenario；
 * 3. 契约 3: 在非 QQ 会话（如 web-*、review-* 沙箱等）下，同样不注入 napcat:qq_scenario；
 * 4. 契约 4: 校验系统提示词上下文注册集合中不包含 napcat:qq_scenario 段；
 * 5. 契约 5: registerQQScenarioDynamicPrompt 安全兼容（返回 noop disposer 且不产生任何脏注入）。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fsp } from 'node:fs';
import { bootDshNapcatBridge, type BootedDsh } from '../../src/boot.js';
import { registerQQScenarioDynamicPrompt } from '../../src/prompt/dynamic.js';

describe('契约测试: QQ 会话提示词干净度与下线验证 (QQ Scenario Clean Contract)', () => {
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

  it('契约 1: 在 QQ 群聊会话 (qq-group-* / group_*) 下，严禁注入 napcat:qq_scenario，提示词清理干净', async () => {
    const assemblyGroup = await booted.ctx.systemPrompt.assemble({
      session: { id: 'qq-group-123456-1' },
    } as any);

    const qqScenarioCtx = assemblyGroup.contexts.find((c: any) => c.name === 'napcat:qq_scenario');
    expect(qqScenarioCtx).toBeUndefined();

    const fullPromptText = assemblyGroup.contexts.map((c: any) => c.text || '').join('\n');
    expect(fullPromptText).not.toContain('# 如何发送消息');
    expect(fullPromptText).not.toContain('必须调用 send_qq_message 工具');
    expect(fullPromptText).not.toContain('send_qq_message');
    expect(fullPromptText).not.toContain('除工具调用外不要输出任何回复文本');

    // 同样验证 group_ 前缀
    const assemblyPeerGroup = await booted.ctx.systemPrompt.assemble({
      peer: 'group_987654',
    } as any);
    const qqPeerCtx = assemblyPeerGroup.contexts.find((c: any) => c.name === 'napcat:qq_scenario');
    expect(qqPeerCtx).toBeUndefined();
  });

  it('契约 2: 在 QQ 私聊会话 (qq-user-* / user_*) 下，同样严禁注入 napcat:qq_scenario', async () => {
    const assemblyUser = await booted.ctx.systemPrompt.assemble({
      session: { id: 'qq-user-999888' },
    } as any);

    const qqScenarioCtx = assemblyUser.contexts.find((c: any) => c.name === 'napcat:qq_scenario');
    expect(qqScenarioCtx).toBeUndefined();

    const fullPromptText = assemblyUser.contexts.map((c: any) => c.text || '').join('\n');
    expect(fullPromptText).not.toContain('# 如何发送消息');
    expect(fullPromptText).not.toContain('send_qq_message');

    // 同样验证 user_ 前缀
    const assemblyPeerUser = await booted.ctx.systemPrompt.assemble({
      peer: 'user_888999',
    } as any);
    const qqPeerCtx = assemblyPeerUser.contexts.find((c: any) => c.name === 'napcat:qq_scenario');
    expect(qqPeerCtx).toBeUndefined();
  });

  it('契约 3: 在非 QQ 会话（如 web-*、review-* 沙箱、空上下文）下，严禁注入 napcat:qq_scenario', async () => {
    // 3.1 Web UI 会话
    const assemblyWeb = await booted.ctx.systemPrompt.assemble({
      session: { id: 'web-session-42' },
    } as any);
    const webCtx = assemblyWeb.contexts.find((c: any) => c.name === 'napcat:qq_scenario');
    expect(webCtx).toBeUndefined();

    // 3.2 沙箱 Review 会话
    const assemblyReview = await booted.ctx.systemPrompt.assemble({
      session: { id: 'review-group_123456' },
    } as any);
    const reviewCtx = assemblyReview.contexts.find((c: any) => c.name === 'napcat:qq_scenario');
    expect(reviewCtx).toBeUndefined();

    // 3.3 无 session/peer 的普通/全局上下文
    const assemblyEmpty = await booted.ctx.systemPrompt.assemble();
    const emptyCtx = assemblyEmpty.contexts.find((c: any) => c.name === 'napcat:qq_scenario');
    expect(emptyCtx).toBeUndefined();
  });

  it('契约 4: 校验提示词上下文中不包含 napcat:qq_scenario 段，人格与记忆段正常挂载', async () => {
    const contextMap = (booted.ctx.systemPrompt as any).layers.merge(undefined, (l: any) => l.contexts);
    const qqScenario = contextMap.get('napcat:qq_scenario');
    const memory = contextMap.get('napcat:memory');
    const persona = contextMap.get('napcat:behavior_persona');

    expect(qqScenario).toBeUndefined();
    expect(memory).toBeDefined();
    expect(memory.order).toBe(40);
    expect(persona).toBeDefined();
    expect(persona.order).toBe(50);
  });

  it('契约 5: registerQQScenarioDynamicPrompt 安全兼容性闭环 (Disposer Contract)', async () => {
    const unmountedHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-napcat-unmounted-'));
    const unmountedBoot = await bootDshNapcatBridge({
      dshHome: unmountedHome,
      mountPlugin: false,
    });

    try {
      const disposer = registerQQScenarioDynamicPrompt(unmountedBoot.ctx);
      expect(typeof disposer).toBe('function');

      const asm = await unmountedBoot.ctx.systemPrompt.assemble({
        session: { id: 'qq-group-777' },
      } as any);
      expect(asm.contexts.find((c: any) => c.name === 'napcat:qq_scenario')).toBeUndefined();

      disposer();
    } finally {
      await unmountedBoot.dispose().catch(() => {});
      await fsp.rm(unmountedHome, { recursive: true, force: true }).catch(() => {});
    }
  });
});
