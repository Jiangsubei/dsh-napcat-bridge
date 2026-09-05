import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fsp } from 'node:fs';
import { bootDshNapcatBridge, type BootedDsh } from '../../src/boot.js';
import { registerNapCatDynamicPrompt } from '../../src/prompt/dynamic.js';
import { DEFAULT_PERSONA, DEFAULT_BEHAVIOR } from '../../src/constants/index.js';

describe('契约测试: System Prompt 动态段注入与非空保底 (System Prompt Context Contract)', () => {
  let tmpHome: string;
  let booted: BootedDsh;

  beforeEach(async () => {
    tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-napcat-prompt-'));
    booted = await bootDshNapcatBridge({
      dshHome: tmpHome,
      mountPlugin: false,
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

  it('契约 1: 人格与行为准则必须注入 systemPrompt.context() 动态段而非静态段', async () => {
    const customPersona = '你是一个傲娇但热心的助手。';
    const customBehavior = '严禁输出 Markdown。';

    // 调用真实动态 Prompt 注册模块
    const unregister = registerNapCatDynamicPrompt(
      booted.ctx,
      () => customPersona,
      () => customBehavior
    );

    const assembly = await booted.ctx.systemPrompt.assemble();

    // 1. 断言: 动态段 contexts 包含注入项
    const injectedCtx = assembly.contexts.find((c) => c.name.includes('napcat'));
    expect(injectedCtx).toBeDefined();
    expect(injectedCtx?.text).toContain('傲娇但热心');

    // 2. 断言: 静态段 sections 中不包含该项 (保护静态 KV Cache)
    const staticSection = assembly.sections.find((s) => s.name.includes('napcat'));
    expect(staticSection).toBeUndefined();

    unregister();
  });

  it('契约 2: 动态段空文本保底 — 未配置时必须返回非空文本防止被 DSH 丢弃', async () => {
    const unregister = registerNapCatDynamicPrompt(
      booted.ctx,
      () => '', // 用户留空
      () => ''
    );

    const assembly = await booted.ctx.systemPrompt.assemble();
    const injected = assembly.contexts.find((c) => c.name.includes('napcat'));
    expect(injected).toBeDefined();
    expect(injected?.text.length).toBeGreaterThan(0);
    expect(injected?.text).toContain(DEFAULT_BEHAVIOR);

    unregister();
  });
});
