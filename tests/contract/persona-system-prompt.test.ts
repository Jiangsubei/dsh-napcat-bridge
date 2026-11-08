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

  it('契约 1: 人格与行为准则必须注入动态快照通道而非静态段', async () => {
    const customPersona = '你是一个傲娇但热心的助手。';
    const customBehavior = '严禁输出 Markdown。';

    // 调用真实动态 Prompt 注册模块
    const unregister = registerNapCatDynamicPrompt(
      booted.ctx,
      () => customPersona,
      () => customBehavior
    );

    // 1. 断言: 静态段 sections 中不包含该项 (保护静态 KV Cache)
    const assembly = await booted.ctx.systemPrompt.assemble();
    const staticSection = assembly.sections.find((s: any) => s.name.includes('napcat'));
    expect(staticSection).toBeUndefined();

    // 2. 断言: 全局 systemPrompt.context 不包含该项 (彻底移出避免 DSH 重复合并巨型快照卡片)
    const globalCtx = assembly.contexts.find((c: any) => c.name.includes('napcat'));
    expect(globalCtx).toBeUndefined();

    // 3. 断言: 通过 snapshotManager 独立通道注入
    const manager = (booted.ctx as any).snapshotManager;
    expect(manager).toBeDefined();
    const personaText = manager.getProvider('napcat:persona')?.provide(null, {});
    expect(personaText).toContain('傲娇但热心');

    unregister();
  });

  it('契约 2: 独立快照通道空文本保底 — 未配置时必须返回非空文本防止被 DSH 丢弃', async () => {
    const unregister = registerNapCatDynamicPrompt(
      booted.ctx,
      () => '', // 用户留空
      () => ''
    );

    const manager = (booted.ctx as any).snapshotManager;
    expect(manager).toBeDefined();
    const behaviorText = manager.getProvider('napcat:behavior')?.provide(null, {});
    expect(behaviorText.length).toBeGreaterThan(0);
    expect(behaviorText).toContain(DEFAULT_BEHAVIOR);

    unregister();
  });
});
