import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fsp } from 'node:fs';
import { bootDshNapcatBridge, type BootedDsh } from '../../src/boot.js';
import { SessionManager } from '../../src/gateway/session.js';

/**
 * 契约测试: 入站消息串行排队 —— 复用 live agent 绝不取消在途回合 (QQ Inbound Serial Queue Contract)
 *
 * 根因锚点（DSH 0.1.5-rc.1 官方契约，见 docs/根因分析-入站消息串行失效与0.1.5抢占取消_260914.md）：
 * 1. `ctx.agents.get(id)` 返回 **bare Agent**（无 `handle` 属性）；`AgentHandle { agent, dispose }`
 *    只暴露给创建它的 owner（`@deepseek-ai/dsh-agent/lib/types/index.d.ts:130-147`）；
 * 2. `Agent.cancel(cause)` 默认 **清空 inbox 并中断在途回合**（不传 `{ keepInbox: true }`）——
 *    唤醒路径上任何"抢占式 cancel"都会打断上一条回复，破坏串行；
 * 3. `Agent.followup(msg)` 才是"排队下一回合"的官方语义（官方 `sessionController.prompt` 亦只用 followup）。
 *
 * 核心契约：
 * 1. 真实装配下 live agent 为 bare Agent（无 handle）时，QQ 侧只复用同一实例：不 cancel、不夺锁；
 * 2. 上一条回合运行中到达的第二条消息：仅经 followup 入队排队，绝不 cancel 在途回合；
 * 3. 复用路径不得触发 agents.resume / agents.create（严禁为"抢占"重建会话）。
 */

describe('契约测试: 入站消息串行排队与复用不取消 (Inbound Serial Queue Contract)', () => {
  let tmpHome: string;
  let booted: BootedDsh | null = null;

  beforeEach(async () => {
    tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-serial-queue-'));
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

  /** 在真实装配上创建一个"非 QQ owner 持有"的 live agent（等价 Web UI sessionController.createOrAdopt → agents.resume/create） */
  async function createForeignLiveAgent(sessionId: string) {
    if (!booted) throw new Error('booted is not ready');
    const cwd = path.join(tmpHome, 'workspace', 'napcat');
    await fsp.mkdir(cwd, { recursive: true });
    const agents = (booted.ctx as any).agents;
    const created = await agents.create({
      sessionId,
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      meta: { cwd },
    });
    // 真实 DSH 语义：句柄只属于创建者，插件侧只能拿到 bare Agent（此处刻意丢弃 handle 与 Web UI 行为一致）
    expect((created.agent as any).handle).toBeUndefined();
    return { agent: created.agent as any, handle: created };
  }

  it('契约 1: 真实装配下 live agent 为 bare Agent（无 handle），QQ 侧复用同一实例且绝不调用 cancel', async () => {
    booted = await bootDshNapcatBridge({ dshHome: tmpHome, mountPlugin: false });
    const sessionId = 'qq-group-3200000001';
    const { agent: liveAgent } = await createForeignLiveAgent(sessionId);

    // 0.1.5 形状锚点：bare Agent 无 handle → 插件不可能通过 handle.dispose 夺锁（原实现的抢占分支永不成立）
    expect((liveAgent as any).handle).toBeUndefined();
    expect(typeof liveAgent.cancel).toBe('function');

    const cancelSpy = vi.spyOn(liveAgent, 'cancel');
    const resumeSpy = vi.spyOn((booted.ctx as any).agents, 'resume');
    const createSpy = vi.spyOn((booted.ctx as any).agents, 'create');

    const sessionManager = new SessionManager(booted.ctx, tmpHome);
    const reused = await sessionManager.getOrCreateAgent('group_3200000001');

    expect(reused).toBe(liveAgent);
    expect(cancelSpy).not.toHaveBeenCalled();
    expect(resumeSpy).not.toHaveBeenCalled();
    expect(createSpy).not.toHaveBeenCalled();

    await sessionManager.dispose();
  });

  it('契约 2: 上一条回合运行中收到第二条消息 → 仅按入站顺序 followup 排队，绝不 cancel 在途回合', async () => {
    booted = await bootDshNapcatBridge({ dshHome: tmpHome, mountPlugin: false });
    const sessionId = 'qq-group-3200000002';
    const { agent: liveAgent } = await createForeignLiveAgent(sessionId);

    const cancelSpy = vi.spyOn(liveAgent, 'cancel');
    const followupSpy = vi.spyOn(liveAgent, 'followup');
    const resumeSpy = vi.spyOn((booted.ctx as any).agents, 'resume');
    const createSpy = vi.spyOn((booted.ctx as any).agents, 'create');

    const sessionManager = new SessionManager(booted.ctx, tmpHome);

    // 第一条消息：唤醒上一条回合
    const first = await sessionManager.dispatchWakeup({
      trigger: 'direct',
      peer: 'group_3200000002',
      from_user: '10001',
      from_name: '甲',
      content: '第一条消息',
      timestamp: Date.now(),
    });

    // 第二条消息在上一条回合仍在运行（running）时到达
    expect(String(liveAgent.status)).toBe('running');

    const second = await sessionManager.dispatchWakeup({
      trigger: 'direct',
      peer: 'group_3200000002',
      from_user: '10002',
      from_name: '乙',
      content: '第二条消息',
      timestamp: Date.now(),
    });

    // 核心红线：串行排队 = 两条消息都经 followup 入队，且顺序与入站顺序一致；绝不 cancel 打断在途回合
    expect(cancelSpy).not.toHaveBeenCalled();
    expect(followupSpy).toHaveBeenCalledTimes(2);
    expect(followupSpy.mock.calls[0][0]).toBe(first);
    expect(followupSpy.mock.calls[1][0]).toBe(second);

    const texts = followupSpy.mock.calls.map((call) => {
      const message: any = call[0];
      return message?.content?.[0]?.text ?? '';
    });
    expect(texts[0]).toContain('第一条消息');
    expect(texts[1]).toContain('第二条消息');

    // 复用路径不得为"抢占"而重建/恢复会话
    expect(resumeSpy).not.toHaveBeenCalled();
    expect(createSpy).not.toHaveBeenCalled();

    await sessionManager.dispose();
  });
});
