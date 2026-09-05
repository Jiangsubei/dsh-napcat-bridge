import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fsp } from 'node:fs';
import WebSocket from 'ws';
import { bootDshNapcatBridge, type BootedDsh } from '../../src/boot.js';
import { PLUGIN_NAME } from '../../src/constants/index.js';
import * as NapCatBridgePlugin from '../../src/index.js';

describe('契约测试: DSH 真实服务装配与插件挂载 (Assembly Contract)', () => {
  let tmpHome: string;
  let booted: BootedDsh;

  beforeEach(async () => {
    tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-napcat-assembly-'));
    booted = await bootDshNapcatBridge({
      dshHome: tmpHome,
      config: {
        bot_qq: '1000000001',
        ws_port: 8080,
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

  it('断言 1: 真实 DSH 基础服务栈必须全部装配就绪', () => {
    const ctx = booted.ctx;

    // Agent 与 Session 服务
    expect(ctx.agents).toBeDefined();
    expect(typeof ctx.agents.create).toBe('function');
    expect(typeof ctx.agents.resume).toBe('function');

    expect(ctx.sessions).toBeDefined();
    expect(typeof ctx.sessions.get).toBe('function');
    expect(typeof ctx.sessions.create).toBe('function');

    // 存储服务
    expect(ctx.storageDomain).toBeDefined();
    expect(typeof ctx.storageDomain.open).toBe('function');

    // LLM 与 SystemPrompt
    expect(ctx.llm).toBeDefined();
    expect(ctx.systemPrompt).toBeDefined();
    expect(typeof ctx.systemPrompt.context).toBe('function');
    expect(typeof ctx.systemPrompt.section).toBe('function');

    // 提问、审批与权限预设
    expect(ctx.userQuestions).toBeDefined();
    expect(typeof ctx.userQuestions.ask).toBe('function');

    expect(ctx.approval).toBeDefined();
    expect(typeof ctx.approval.request).toBe('function');

    expect(ctx.permissionPresets).toBeDefined();
    expect(typeof ctx.permissionPresets.set).toBe('function');
  });

  it('断言 2: dsh-napcat-bridge 插件已成功注册并在 Context 上生效', () => {
    expect(booted.ctx).toBeDefined();
    // 插件 settings 注册
    const settings = booted.ctx.get('settings');
    expect(settings).toBeDefined();
  });

  it('B2-契约 3: 插件通过 user-questions/request waterfall 接入 NapCat 提问渠道', async () => {
    const uq = booted.ctx.userQuestions;
    expect(uq).toBeDefined();

    const handle = await booted.ctx.agents.create({
      sessionId: 'qq-group-123',
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      meta: { cwd: path.join(tmpHome, 'qq-ws') },
    });
    const qqAgent = handle.agent || handle;

    // 未连接 gateway 时向 QQ 会话提问，会由 NapCatQuestionProvider 处理并抛出连接错误
    await expect(
      uq.ask({
        agent: qqAgent,
        questions: [{ id: 'q1', question: 'x' }],
      })
    ).rejects.toThrow(/NapCat.*未连接/);
  });

  it('TD001-契约 4: 插件通过 user-questions/request waterfall 级联共存，QQ 会话由插件处理，Web 会话委托宿主', async () => {
    const booted2 = await bootDshNapcatBridge({
      dshHome: tmpHome,
      mountPlugin: false,
    });
    try {
      let webCalled = false;
      booted2.ctx.on('user-questions/request', async (req: any, next: any) => {
        const sid = req.agent?.session?.id || req.agent?.id || '';
        if (!sid.startsWith('qq-')) {
          webCalled = true;
          return { answers: [{ id: 'q1', selected: ['web'] }] };
        }
        return next();
      });
      await booted2.ctx.plugin(NapCatBridgePlugin, {
        bot_qq: '1000000001',
        ws_port: 18082,
      });

      const webHandle = await booted2.ctx.agents.create({
        sessionId: 'web-session-1',
        agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
        meta: { cwd: path.join(tmpHome, 'web-ws-2') },
      });
      const webAgent = webHandle.agent || webHandle;

      // Web 会话 → 委托宿主 provider
      const webAnswer = await booted2.ctx.userQuestions.ask({
        agent: webAgent,
        questions: [{ id: 'q1', question: 'x' }],
      });
      expect(webCalled).toBe(true);
      expect(webAnswer).toEqual({ answers: [{ id: 'q1', selected: ['web'] }] });
    } finally {
      await booted2.dispose().catch(() => {});
    }
  });

  it('B3-契约 5: tools.guard 执行侧隔离 — 非 QQ 会话调用 NapCat 工具被拒绝，QQ 会话放行', async () => {
    const tools: any = booted.ctx.get('tools');
    expect(typeof tools.guard).toBe('function');

    // 非 QQ (Web) 会话 agent
    const webHandle = await booted.ctx.agents.create({
      sessionId: 'web-session-1',
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      meta: { cwd: path.join(tmpHome, 'web-ws') },
    });
    const webAgent = webHandle.agent || webHandle;
    const denied = await tools.execute({
      name: 'read_chat_history',
      arguments: {},
      agent: webAgent,
      signal: new AbortController().signal,
    });
    expect(denied.isError).toBe(true);
    expect((denied as any).error?.message).toContain('仅限 QQ 会话');

    // QQ 会话 agent
    const qqHandle = await booted.ctx.agents.create({
      sessionId: 'qq-group-1001',
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      meta: { cwd: path.join(tmpHome, 'qq-ws') },
    });
    const qqAgent = qqHandle.agent || qqHandle;
    const allowed = await tools.execute({
      name: 'read_chat_history',
      arguments: {},
      agent: qqAgent,
      signal: new AbortController().signal,
    });
    expect(allowed.isError).toBe(false);
  });

  it('B3-契约 6: system-prompt/assemble 呈现侧隔离 — Web 装配不含 NapCat 工具，QQ 装配含全量', async () => {
    const NAPCAT_TOOLS = new Set([
      'read_chat_history',
      'fetch_chat_resource',
      'expand_forward_message',
      'send_file',
      'poke_user',
    ]);

    const webHandle = await booted.ctx.agents.create({
      sessionId: 'web-session-2',
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      meta: { cwd: path.join(tmpHome, 'web-ws-2') },
    });
    const webAgent = webHandle.agent || webHandle;
    const asmWeb = await booted.ctx.systemPrompt.assemble({ scope: webAgent, agent: webAgent } as any);
    const webNapcat = (asmWeb.tools as any[]).filter((t) => NAPCAT_TOOLS.has(t.name));
    expect(webNapcat).toHaveLength(0);

    const qqHandle = await booted.ctx.agents.create({
      sessionId: 'qq-group-1002',
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      meta: { cwd: path.join(tmpHome, 'qq-ws-2') },
    });
    const qqAgent = qqHandle.agent || qqHandle;
    const asmQq = await booted.ctx.systemPrompt.assemble({ scope: qqAgent, agent: qqAgent } as any);
    const qqNapcat = (asmQq.tools as any[]).filter((t) => NAPCAT_TOOLS.has(t.name));
    expect(qqNapcat.map((t) => t.name).sort()).toEqual([...NAPCAT_TOOLS].sort());
  });
});
