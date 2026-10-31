import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fsp } from 'node:fs';
import { bootDshNapcatBridge, type BootedDsh } from '../../src/boot.js';
import { SessionManager } from '../../src/gateway/session.js';
import * as NapCatBridgePlugin from '../../src/index.js';
import { QQ_PRESET_ID, QQ_PRESET_PERSONA_PREFIX } from '../../src/constants/preset.js';

describe('契约测试: DSH 默认 coding 预设环境下 QQ 会话预设持久化与重启恢复契约 (Session Preset Persistence & Resume Contract)', () => {
  let tmpHome: string;
  let booted: BootedDsh | null = null;

  beforeEach(async () => {
    tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-preset-resume-'));
  });

  afterEach(async () => {
    if (booted) {
      await booted.dispose().catch(() => {});
      booted = null;
    }
    if (tmpHome) {
      await fsp.rm(tmpHome, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('契约 1: 在系统默认预设为 standard 的生产环境下，创建会话必须在 Session Header 与投影中固化 agentPreset', async () => {
    booted = await bootDshNapcatBridge({
      dshHome: tmpHome,
      mountPlugin: false,
      extraPatches: [
        {
          id: 'agent-preset-registry',
          config: { default: 'standard' },
        },
      ],
    });

    await booted.ctx.plugin(NapCatBridgePlugin, {
      ws_port: 29997,
      face_enabled: true,
      memory_enabled: true,
    });

    const sessionManager = new SessionManager(booted.ctx, tmpHome);
    const agent = await sessionManager.getOrCreateAgent('group:8000000005');
    expect(agent).toBeDefined();

    // 1. 验证 Session Header 持久化携带 agentPreset
    const session = agent.session;
    expect((session as any).header?.agentPreset).toBe(QQ_PRESET_ID);

    // 2. 验证 sessionProjections 投影中的 agentPreset 固化为 QQ_PRESET_ID
    const sessionProjections: any = (booted.ctx as any).sessionProjections;
    const projectedPreset = sessionProjections?.stateOf?.(session, 'agentPreset');
    expect(projectedPreset).toBe(QQ_PRESET_ID);
  });

  it('契约 2: DSH 重启（冷恢复）后，即使系统默认预设为 standard，QQ 会话恢复后预设绝不 fallback 至 standard', async () => {
    // 1. 首次启动：在 default: 'standard' 环境下创建会话并落盘
    booted = await bootDshNapcatBridge({
      dshHome: tmpHome,
      mountPlugin: false,
      extraPatches: [
        {
          id: 'agent-preset-registry',
          config: { default: 'standard' },
        },
      ],
    });

    await booted.ctx.plugin(NapCatBridgePlugin, {
      ws_port: 29997,
      face_enabled: true,
      memory_enabled: true,
    });

    const sessionManager1 = new SessionManager(booted.ctx, tmpHome);
    const agent1 = await sessionManager1.getOrCreateAgent('group:8000000006');
    expect(agent1).toBeDefined();

    // 强制落盘 session 日志
    await booted.ctx.sessions.flush(agent1.session);

    // 2. 模拟 DSH 进程退出 / 重启
    await booted.dispose();
    booted = null;

    // 3. 模拟 DSH 重启后冷加载：系统默认预设依然是生产环境的 standard
    booted = await bootDshNapcatBridge({
      dshHome: tmpHome,
      mountPlugin: false,
      extraPatches: [
        {
          id: 'agent-preset-registry',
          config: { default: 'standard' },
        },
      ],
    });

    await booted.ctx.plugin(NapCatBridgePlugin, {
      ws_port: 29997,
      face_enabled: true,
      memory_enabled: true,
    });

    const sessionManager2 = new SessionManager(booted.ctx, tmpHome);
    const resumedAgent = await sessionManager2.getOrCreateAgent('group:8000000006');
    expect(resumedAgent).toBeDefined();

    // 4. 断言恢复后的 Session Header 与 SessionProjection 中的 agentPreset 绝不为空
    expect((resumedAgent.session as any).header?.agentPreset).toBe(QQ_PRESET_ID);
    const sessionProjections: any = (booted.ctx as any).sessionProjections;
    expect(sessionProjections?.stateOf?.(resumedAgent.session, 'agentPreset')).toBe(QQ_PRESET_ID);

    // 5. 断言恢复后的 Agent 绑定的预设必须是 qq-session，绝不 fallback 到 standard
    const presetsSvc: any = (booted.ctx as any).agentPresets || (booted.ctx as any).get?.('agentPresets');
    const composedPreset = presetsSvc.composedPreset(resumedAgent.ctx);
    expect(composedPreset).toBe(QQ_PRESET_ID);

    // 6. 断言组装出的 Prompt 为 QQ 专属提示词，绝不含 coding 提示词
    const asm = await booted.ctx.systemPrompt.assemble({ scope: resumedAgent, agent: resumedAgent } as any);
    const fullPrompt = ((asm as any).sections as any[]).map((s) => s.text).join('\n');
    expect(fullPrompt).toContain(QQ_PRESET_PERSONA_PREFIX);
    expect(fullPrompt).not.toContain('You are a coding agent');

    // 7. 断言 NapCat 专属工具健全，不随重启而消失
    const toolNames = new Set(((asm as any).tools as any[]).map((t) => t.name));
    expect(toolNames.has('send_qq_message')).toBe(true);
    expect(toolNames.has('read_chat_history')).toBe(true);
    expect(toolNames.has('read_memory')).toBe(true);
  });
});
