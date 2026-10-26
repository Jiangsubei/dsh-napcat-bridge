import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import { bootDshNapcatBridge, type BootedDsh } from '../../src/boot.js';
import { SessionManager } from '../../src/gateway/session.js';
import * as NapCatBridgePlugin from '../../src/index.js';

describe('契约测试: QQ 会话专属预设装配与工具隔离 (QQ Session Preset Contract)', () => {
  let tmpHome: string;
  let booted: BootedDsh;

  beforeEach(async () => {
    tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-preset-contract-'));
    booted = await bootDshNapcatBridge({
      dshHome: tmpHome,
      mountPlugin: false,
      extraPatches: [
        {
          insert: [
            {
              id: 'agent-preset-registry',
              name: '@deepseek-ai/dsh-agent-preset-registry',
              config: { default: 'qq-session' },
            },
          ],
        },
      ],
    });

    await booted.ctx.plugin(NapCatBridgePlugin, {
      ws_port: 29995,
      face_enabled: true,
      memory_enabled: true,
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

  it('契约 1: 运行时 agentPresets 存在时，qq-session 预设必须成功注册', async () => {
    const presetsSvc: any = (booted.ctx as any).agentPresets || (booted.ctx as any).get?.('agentPresets');
    expect(presetsSvc).toBeDefined();

    // 等待异步注册完成
    const list = await presetsSvc.list();
    const qqPreset = list.find((p: any) => p.id === 'qq-session');
    expect(qqPreset).toBeDefined();
    expect(qqPreset.name).toBe('QQ 智能助手');
  });

  it('契约 2: 挂载 qq-session 预设的 Agent，Prompt 必须被 complete: true 完全覆盖为专属轻量提示词', async () => {
    const presetsSvc: any = (booted.ctx as any).agentPresets || (booted.ctx as any).get?.('agentPresets');
    const qqWs = path.join(tmpHome, 'qq-ws');
    fs.mkdirSync(qqWs, { recursive: true });

    const qqHandle = await booted.ctx.agents.create({
      sessionId: 'qq-group-8000000002',
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      meta: { cwd: qqWs },
      setup: async (agentCtx: any) => {
        await presetsSvc.mount(agentCtx, 'qq-session');
      },
    });

    const qqAgent = qqHandle.agent || qqHandle;
    const asm = await booted.ctx.systemPrompt.assemble({ scope: qqAgent, agent: qqAgent } as any);

    const fullPrompt = ((asm as any).sections as any[]).map((s) => s.text).join('\n');

    // 专属 Prompt 验证：包含目标指令且完全不包含默认 coding 提示词
    expect(fullPrompt).toContain('当前会话是 qq 会话。');
    expect(fullPrompt).not.toContain('You are a coding agent');
    expect(fullPrompt).not.toContain('git commit');
  });

  it('契约 3: 挂载 qq-session 预设的 Agent，工具集合必须包含基础文件/Shell/Web及全量 NapCat 专属工具', async () => {
    const presetsSvc: any = (booted.ctx as any).agentPresets || (booted.ctx as any).get?.('agentPresets');
    const qqWs = path.join(tmpHome, 'qq-ws-tools');
    fs.mkdirSync(qqWs, { recursive: true });

    const qqHandle = await booted.ctx.agents.create({
      sessionId: 'qq-group-8000000002',
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      meta: { cwd: qqWs },
      setup: async (agentCtx: any) => {
        await presetsSvc.mount(agentCtx, 'qq-session');
      },
    });

    const qqAgent = qqHandle.agent || qqHandle;
    const asm = await booted.ctx.systemPrompt.assemble({ scope: qqAgent, agent: qqAgent } as any);
    const toolNames = new Set((asm.tools as any[]).map((t) => t.name));

    // 1. 基础工作区与文件工具
    expect(toolNames.has('read')).toBe(true);
    expect(toolNames.has('write')).toBe(true);
    expect(toolNames.has('edit')).toBe(true);
    expect(toolNames.has('read_image')).toBe(true);
    expect(toolNames.has('working_directory')).toBe(true);

    // 2. 跨平台 Shell (Windows 下为 pwsh，Unix 下为 bash)
    if (process.platform === 'win32') {
      expect(toolNames.has('pwsh')).toBe(true);
      expect(toolNames.has('bash')).toBe(false);
    } else {
      expect(toolNames.has('bash')).toBe(true);
      expect(toolNames.has('pwsh')).toBe(false);
    }

    // 3. 官方 Web 搜索
    expect(toolNames.has('web_search')).toBe(true);
    expect(toolNames.has('web_fetch')).toBe(true);

    // 4. 技能工具
    expect(toolNames.has('skill')).toBe(true);

    // 5. NapCat 专属工具
    expect(toolNames.has('send_qq_message')).toBe(true);
    expect(toolNames.has('read_chat_history')).toBe(true);
    expect(toolNames.has('fetch_chat_resource')).toBe(true);
    expect(toolNames.has('expand_forward_message')).toBe(true);
    expect(toolNames.has('send_file')).toBe(true);
    expect(toolNames.has('poke_user')).toBe(true);
    expect(toolNames.has('list_group_files')).toBe(true);
    expect(toolNames.has('wait_for_user_messages')).toBe(true);
    expect(toolNames.has('react_message')).toBe(true);
    expect(toolNames.has('send_face')).toBe(true);
    expect(toolNames.has('list_faces')).toBe(true);
    expect(toolNames.has('collect_face')).toBe(true);
    expect(toolNames.has('manage_faces')).toBe(true);
    expect(toolNames.has('read_memory')).toBe(true);
    expect(toolNames.has('create_memory')).toBe(true);
    expect(toolNames.has('edit_memory')).toBe(true);
  });

  it('契约 4: 通过 SessionAgentRunner 创建的 QQ Agent 会话自动挂载 qq-session 预设', async () => {
    const sessionManager = new SessionManager(booted.ctx, tmpHome);
    const agent = await sessionManager.getOrCreateAgent('group:8000000002');
    expect(agent).toBeDefined();

    const presetsSvc: any = (booted.ctx as any).agentPresets || (booted.ctx as any).get?.('agentPresets');
    const composedPreset = presetsSvc.composedPreset(agent.ctx);
    expect(composedPreset).toBe('qq-session');

    // 验证其 assemble 结果
    const asm = await booted.ctx.systemPrompt.assemble({ scope: agent, agent } as any);
    const fullPrompt = ((asm as any).sections as any[]).map((s) => s.text).join('\n');
    expect(fullPrompt).toContain('当前会话是 qq 会话。');
    expect(fullPrompt).not.toContain('You are a coding agent');
  });

  it('契约 5: 挂载 qq-session 预设的 Agent，运行时上下文 napcat:memory 未被抑制并正常注入', async () => {
    const sessionManager = new SessionManager(booted.ctx, tmpHome);
    const agent = await sessionManager.getOrCreateAgent('group:8000000002');

    const asm = await booted.ctx.systemPrompt.assemble({ scope: agent, agent } as any);
    const contextNames = (asm.contexts as any[]).map((c) => c.name);

    // 验证 napcat:memory 运行时上下文存在（未被 persona.includeRuntimeContext: false 抑制）
    expect(contextNames).toContain('napcat:memory');
    expect(contextNames.some((n: string) => n.startsWith('working-directory'))).toBe(true);
  });

  it('契约 6: qq-session 预设配置必须完整包含 agent-instructions、skill-filesystem 与 tool-skill 插件定义', async () => {
    const presetsSvc: any = (booted.ctx as any).agentPresets || (booted.ctx as any).get?.('agentPresets');
    const qqDef = presetsSvc.definitions?.get?.('qq-session');
    expect(qqDef).toBeDefined();

    const plugins = qqDef.config.plugins;
    const pluginIds = plugins.map((p: any) => p.id);
    expect(pluginIds).toContain('agent-instructions');
    expect(pluginIds).toContain('skill-filesystem');
    expect(pluginIds).toContain('tool-skill');

    const instructionsPlugin = plugins.find((p: any) => p.id === 'agent-instructions');
    expect(instructionsPlugin.config?.maxBytes).toBe(65536);
  });
});
