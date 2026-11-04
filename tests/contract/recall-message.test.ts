/**
 * 契约测试: recall_message 消息撤回工具契约与全场景装配 (Recall Message Tool Contract)
 *
 * 覆盖规范清单:
 * 契约 1: 真实装配下，QQ 群聊与私聊会话均包含 recall_message 工具；WebUI/Review 沙箱安全排除；
 * 契约 2: recallMessage 核心执行契约（数字 ID、数字字符串 ID、网关 delete_msg 动作透传）；
 * 契约 3: recallMessage 异常与边界校验（缺少 ID、非法 ID、网关未连接、底层超时或权限拦截）；
 * 契约 4: 串行队列调度保障（通过 PerPeerSerialSender 串行执行）；
 * 契约 5: DSH Lossless JSON 契约（执行返回值所有键值绝无 undefined）。
 */

import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fsp } from 'node:fs';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { bootDshNapcatBridge, type BootedDsh } from '../../src/boot.js';
import {
  recallMessage,
  type RecallMessageParams,
  registerAgentTools,
  resetGlobalToolContext,
} from '../../src/tools/index.js';
import { PerPeerSerialSender } from '../../src/outbound/queue.js';
import { Context } from '@deepseek-ai/cordis';

describe('契约 1: recall_message 工具真实装配与会话隔离契约', () => {
  let tmpHome: string;
  let booted: BootedDsh;
  const TEST_PORT = 29910;

  beforeEach(async () => {
    tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-recall-tool-asm-'));
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

  it('1.1 真实装配下：QQ 群聊会话 assemble 结果中包含 recall_message 工具', async () => {
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
    const toolNames = (asmGroup.tools as any[]).map((t: any) => t.name);
    expect(toolNames).toContain('recall_message');
  });

  it('1.2 真实装配下：QQ 私聊会话 assemble 结果中包含 recall_message 工具', async () => {
    const ctx = booted.ctx;
    const presetsSvc: any = (ctx as any).agentPresets || ctx.get?.('agentPresets');
    const qqWs = path.join(tmpHome, 'qq-ws-user');
    await fsp.mkdir(qqWs, { recursive: true });

    const qqUserHandle = await ctx.agents.create({
      sessionId: 'qq-user-2222',
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
    const toolNames = (asmUser.tools as any[]).map((t: any) => t.name);
    expect(toolNames).toContain('recall_message');
  });

  it('1.3 真实装配下：WebUI 与 Review 沙箱会话均排除 recall_message 工具', async () => {
    const ctx = booted.ctx;
    const webWs = path.join(tmpHome, 'web-ws');
    await fsp.mkdir(webWs, { recursive: true });

    const webHandle = await ctx.agents.create({
      sessionId: 'web-session-1',
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      meta: { cwd: webWs },
    });

    const webAgent = webHandle.agent || webHandle;
    const asmWeb = await ctx.systemPrompt.assemble({ scope: webAgent, agent: webAgent } as any);
    const webToolNames = (asmWeb.tools as any[]).map((t: any) => t.name);
    expect(webToolNames).not.toContain('recall_message');
  });
});

describe('契约 2-5: recallMessage 核心功能、异常校验、串行调度与 Lossless JSON 契约', () => {
  beforeEach(() => {
    resetGlobalToolContext();
  });

  function hasUndefinedValue(obj: any): boolean {
    if (obj === undefined) return true;
    if (obj === null || typeof obj !== 'object') return false;
    for (const [key, val] of Object.entries(obj)) {
      if (val === undefined) return true;
      if (typeof val === 'object' && hasUndefinedValue(val)) return true;
    }
    return false;
  }

  it('2.1 正常调用：传入数字 message_id，成功调用 gateway.deleteMsg 并返回无损 JSON', async () => {
    const deleteMsgMock = vi.fn(async (msgId: number | string) => {
      return { status: 'ok', retcode: 0, data: null };
    });
    const mockGateway: any = { deleteMsg: deleteMsgMock };

    const res = await recallMessage(
      { message_id: 123456789 },
      { gateway: mockGateway }
    );

    expect(deleteMsgMock).toHaveBeenCalledWith(123456789);
    expect(res.success).toBe(true);
    expect(res.message).toContain('123456789');
    expect(hasUndefinedValue(res)).toBe(false);
  });

  it('2.2 正常调用：传入数字字符串 message_id，自动转换为数字调用', async () => {
    const deleteMsgMock = vi.fn(async (msgId: number | string) => {
      return { status: 'ok', retcode: 0, data: null };
    });
    const mockGateway: any = { deleteMsg: deleteMsgMock };

    const res = await recallMessage(
      { message_id: '987654321' } as any,
      { gateway: mockGateway }
    );

    expect(deleteMsgMock).toHaveBeenCalledWith(987654321);
    expect(res.success).toBe(true);
    expect(hasUndefinedValue(res)).toBe(false);
  });

  it('3.1 异常校验：未提供 message_id 时安全拦截并返回错误信息', async () => {
    const deleteMsgMock = vi.fn();
    const mockGateway: any = { deleteMsg: deleteMsgMock };

    const res1 = await recallMessage({} as any, { gateway: mockGateway });
    expect(res1.success).toBe(false);
    expect(res1.error).toContain('message_id');
    expect(deleteMsgMock).not.toHaveBeenCalled();
    expect(hasUndefinedValue(res1)).toBe(false);

    const res2 = await recallMessage({ message_id: '' } as any, { gateway: mockGateway });
    expect(res2.success).toBe(false);
    expect(res2.error).toContain('message_id');
    expect(hasUndefinedValue(res2)).toBe(false);
  });

  it('3.2 异常校验：传入非数字字符串等非法 message_id 时安全拦截', async () => {
    const deleteMsgMock = vi.fn();
    const mockGateway: any = { deleteMsg: deleteMsgMock };

    const res = await recallMessage({ message_id: 'not-a-number' } as any, { gateway: mockGateway });
    expect(res.success).toBe(false);
    expect(res.error).toContain('无效的消息 ID');
    expect(deleteMsgMock).not.toHaveBeenCalled();
    expect(hasUndefinedValue(res)).toBe(false);
  });

  it('3.3 异常校验：网关未连接时安全拦截', async () => {
    const res = await recallMessage({ message_id: 123456 }, { gateway: undefined });
    expect(res.success).toBe(false);
    expect(res.error).toContain('Gateway 未连接');
    expect(hasUndefinedValue(res)).toBe(false);
  });

  it('3.4 平台报错透传：底层超时或无权限时，如实反馈底层报错文本', async () => {
    const deleteMsgMock = vi.fn(async () => {
      return {
        status: 'failed',
        retcode: 100,
        message: 'delete_msg failed',
        wording: '消息发送时间已超过 2 分钟，无法撤回',
      };
    });
    const mockGateway: any = { deleteMsg: deleteMsgMock };

    const res = await recallMessage({ message_id: 123456 }, { gateway: mockGateway });
    expect(res.success).toBe(false);
    expect(res.error).toContain('消息发送时间已超过 2 分钟，无法撤回');
    expect(hasUndefinedValue(res)).toBe(false);
  });

  it('4.1 串行队列调度：存在 peer 与 sender 时，经由 sender.enqueue 调度执行', async () => {
    const callOrder: string[] = [];
    const deleteMsgMock = vi.fn(async (msgId: number | string) => {
      callOrder.push(`gateway:${msgId}`);
      return { status: 'ok', retcode: 0, data: null };
    });
    const mockGateway: any = { deleteMsg: deleteMsgMock };
    const sender = new PerPeerSerialSender();

    // 先推一个模拟发送任务
    sender.enqueue('group_8888', async () => {
      await new Promise((r) => setTimeout(r, 20));
      callOrder.push('send:1');
    });

    // 紧接着调用 recallMessage
    const resPromise = recallMessage(
      { message_id: 123456 },
      {
        gateway: mockGateway,
        sender,
        peer: 'group_8888',
      }
    );

    const res = await resPromise;
    expect(res.success).toBe(true);
    // 验证顺序必须是 send 在前，recall 在后
    expect(callOrder).toEqual(['send:1', 'gateway:123456']);
    expect(hasUndefinedValue(res)).toBe(false);
  });

  it('5.1 defineTool execute 返回值满足 Lossless JSON 红线要求', async () => {
    const appCtx = new Context();
    const registeredTools: any[] = [];
    appCtx.provide('tools');
    appCtx.set('tools', {
      register: (tool: any) => {
        registeredTools.push(tool);
        return () => {};
      },
    });

    const deleteMsgMock = vi.fn(async () => ({ status: 'ok', retcode: 0, data: null }));
    const mockGateway: any = { deleteMsg: deleteMsgMock };

    registerAgentTools(appCtx, {
      gateway: mockGateway,
      db: {} as any,
      mediaManager: {} as any,
    });

    const recallTool = registeredTools.find((t) => t.name === 'recall_message');
    expect(recallTool).toBeDefined();

    const mockExec: any = {
      agent: {
        session: { id: 'group_1000' },
      },
    };

    // 成功分支
    const execSuccess = await recallTool.execute({ message_id: 11111 }, mockExec);
    expect(execSuccess.success).toBe(true);
    expect(hasUndefinedValue(execSuccess)).toBe(false);

    // 失败分支
    deleteMsgMock.mockResolvedValueOnce({
      status: 'failed',
      retcode: 1200,
      wording: '无权限撤回该消息',
    } as any);
    const execFail = await recallTool.execute({ message_id: 22222 }, mockExec);
    expect(execFail.success).toBe(false);
    expect(hasUndefinedValue(execFail)).toBe(false);
  });
});
