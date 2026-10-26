/**
 * 契约测试: All-in-One 架构 send_qq_message 回归与出站静默契约
 *
 * 验证规则:
 * 1. 契约 1: bootDshNapcatBridge 真实装配下，QQ 群聊与私聊工具列表中均必须包含 send_qq_message 工具；
 * 2. 契约 2: QQ 会话下 assemble 系统提示词包含自然顺手维护引导，不包含历史 Background 抑制词；
 * 3. 契约 3: 用户侧静默原则（User-Side Silence Principle）：当模型在 assistant/message 输出思考或正文（未调 send_qq_message）时，网关保持绝对静默，绝不向 QQ 直发；
 * 4. 契约 4: send_qq_message 显式传参驱动：通过显式 reply_to 与 at_user 精确组装 OneBot 11 载荷并发送；
 * 5. 契约 5: 非终结解耦设计：调用 send_qq_message 成功后不结束当前轮次，回合保持开放以供顺手执行维护操作。
 */

import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fsp } from 'node:fs';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import { bootDshNapcatBridge, type BootedDsh } from '../../src/boot.js';
import { OutboundStreamBridge } from '../../src/outbound/stream.js';
import { sendQqMessage, registerAgentTools } from '../../src/tools/index.js';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';

describe('契约测试: All-in-One 架构 send_qq_message 回归与出站静默契约', () => {
  let tmpHome: string;
  let booted: BootedDsh;
  const TEST_PORT = 29777;

  beforeEach(async () => {
    tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-all-in-one-'));
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

  it('契约 1: 真实装配下，QQ 群聊与私聊工具列表中均必须包含 send_qq_message 工具', async () => {
    const presetsSvc: any = (booted.ctx as any).agentPresets || (booted.ctx as any).get?.('agentPresets');
    const provider: any = (booted.ctx as any).napcatBridgeTools || (booted.ctx as any).get?.('napcatBridgeTools');

    // 1.1 群聊会话 assemble
    const groupWs = path.join(tmpHome, 'qq-ws-group');
    await fsp.mkdir(groupWs, { recursive: true });
    const groupHandle = await booted.ctx.agents.create({
      sessionId: 'qq-group-10001',
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      meta: { cwd: groupWs },
      setup: async (agentCtx: any) => {
        if (presetsSvc?.mount) {
          await presetsSvc.mount(agentCtx, 'qq-session');
        } else {
          provider?.registerTools?.(agentCtx);
        }
      },
    });
    const groupAgent = groupHandle.agent || groupHandle;
    const groupAssembly = await booted.ctx.systemPrompt.assemble({
      scope: groupAgent,
      agent: groupAgent,
      session: { id: 'qq-group-10001' },
    } as any);
    const groupToolNames = (groupAssembly.tools || []).map((t: any) => t.name);
    expect(groupToolNames).toContain('send_qq_message');

    // 1.2 私聊会话 assemble
    const userWs = path.join(tmpHome, 'qq-ws-user');
    await fsp.mkdir(userWs, { recursive: true });
    const userHandle = await booted.ctx.agents.create({
      sessionId: 'qq-user-20002',
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      meta: { cwd: userWs },
      setup: async (agentCtx: any) => {
        if (presetsSvc?.mount) {
          await presetsSvc.mount(agentCtx, 'qq-session');
        } else {
          provider?.registerTools?.(agentCtx);
        }
      },
    });
    const userAgent = userHandle.agent || userHandle;
    const userAssembly = await booted.ctx.systemPrompt.assemble({
      scope: userAgent,
      agent: userAgent,
      session: { id: 'qq-user-20002' },
    } as any);
    const userToolNames = (userAssembly.tools || []).map((t: any) => t.name);
    expect(userToolNames).toContain('send_qq_message');
  });

  it('契约 2: QQ 会话下 assemble 系统提示词包含自然顺手维护引导，不包含历史 Background 抑制词', async () => {
    const assemblyGroup = await booted.ctx.systemPrompt.assemble({
      session: { id: 'qq-group-10001-1' },
    } as any);

    const fullPromptText = assemblyGroup.contexts.map((c: any) => c.text || '').join('\n');
    expect(fullPromptText).toContain('send_qq_message');
    expect(fullPromptText).not.toContain('持久记忆由系统后台自动打理');
  });

  it('契约 3: 用户侧静默原则：当模型在 assistant/message 输出思考或正文时，网关保持绝对静默，绝不向 QQ 直发', async () => {
    const sent: Array<{ peer: string; msg: any }> = [];
    const gateway = {
      sendMsg: async (peer: string, msg: any) => {
        sent.push({ peer, msg });
        return { status: 'ok', retcode: 0, data: { message_id: 100 } };
      },
    };
    const sessionManager = {
      isQQSession: (id: string) => id.startsWith('qq-') || id.startsWith('group_') || id.startsWith('user_'),
      sessionIdToPeer: (id: string) => {
        if (id.startsWith('qq-group-')) return `group_${id.slice('qq-group-'.length)}`;
        if (id.startsWith('qq-user-')) return `user_${id.slice('qq-user-'.length)}`;
        return id;
      },
    };

    const ctx = new Context();
    const bridge = new OutboundStreamBridge(ctx, {
      gateway: gateway as any,
      sessionManager: sessionManager as any,
      getConfig: () => ({ quote_original: true, at_questioner: true }),
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    });

    const session = { id: 'qq-group-10001' };

    // 模拟入站消息
    bridge.trackInboundContext('group_10001', {
      msg_id: 8888,
      from_user: '1000000001',
      is_group: true,
    });

    // 开启轮次
    await bridge.handleSessionEvent(session as any, {
      type: 'turn/start',
      data: { turn: 1 },
    } as any);

    // Step 1: 模型输出思考与正文文本块（模拟老直发场景）
    const stepBlocks: ContentBlock[] = [
      {
        type: 'reasoning',
        text: 'Thinking about whether to reply...',
      },
      {
        type: 'text',
        text: '这是一段没有通过 send_qq_message 发送的中间正文。',
      },
    ];

    await bridge.handleSessionEvent(session as any, {
      type: 'assistant/message',
      data: {
        turn: 1,
        step: 1,
        message: { content: stepBlocks },
      },
    } as any);

    // 关键断言：绝对静默！sent 数组必须为空！
    expect(sent).toHaveLength(0);

    // 轮次结束：同样绝对不搞任何补发
    await bridge.handleSessionEvent(session as any, {
      type: 'turn/end',
      data: { turn: 1, reason: { kind: 'completed' } },
    } as any);

    expect(sent).toHaveLength(0);
  });

  it('契约 4: send_qq_message 显式传参驱动：通过显式 reply_to 与 at_user 精确组装并发送', async () => {
    const sent: Array<{ peer: string; msg: any }> = [];
    const gateway = {
      sendMsg: async (peer: string, msg: any) => {
        sent.push({ peer, msg });
        return { status: 'ok', retcode: 0, data: { message_id: 9999 } };
      },
    };

    const result = await sendQqMessage(
      {
        text: '收到，马上处理！',
        reply_to: 12345,
        at_user: '1000000001',
      },
      {
        gateway: gateway as any,
        peer: 'group_10001',
      }
    );

    expect(result.success).toBe(true);
    expect(result.message_id).toBe(9999);
    expect(sent).toHaveLength(1);
    expect(sent[0].peer).toBe('group_10001');

    const msgPayload = sent[0].msg;
    expect(Array.isArray(msgPayload)).toBe(true);
    expect(msgPayload[0]).toEqual({ type: 'reply', data: { id: 12345 } });
    expect(msgPayload[1]).toEqual({ type: 'at', data: { qq: '1000000001' } });
    expect(msgPayload[2]).toEqual({ type: 'text', data: { text: '收到，马上处理！' } });
  });

  it('契约 5: 非终结解耦设计：调用 send_qq_message 不调用 concludeTurn，回合保持开放', async () => {
    const gateway = {
      sendMsg: async () => ({ status: 'ok', retcode: 0, data: { message_id: 1 } }),
    };

    const concludeTurnMock = vi.fn();
    const mockExec = {
      agent: { session: { id: 'qq-group-10001' } },
      concludeTurn: concludeTurnMock,
    };

    // 在独立测试 Context 注册工具验证 execute 行为
    const testCtx = new Context();
    let registeredToolDef: any;
    const toolsMock = {
      register: (def: any) => {
        registeredToolDef = def;
        return () => {};
      },
    };
    (testCtx as any).tools = toolsMock;

    registerAgentTools(testCtx, {
      db: {} as any,
      gateway: gateway as any,
      mediaManager: {} as any,
    });

    expect(registeredToolDef).toBeDefined();
    expect(registeredToolDef.name).toBe('send_qq_message');

    const result = await registeredToolDef.execute(
      { text: '已向用户发送答复' },
      mockExec
    );

    expect(result.success).toBe(true);
    // 关键断言：绝不调用 concludeTurn！
    expect(concludeTurnMock).not.toHaveBeenCalled();
  });
});
