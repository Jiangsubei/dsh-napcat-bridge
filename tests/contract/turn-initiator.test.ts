import { describe, it, expect } from 'vitest';
import { TurnInitiatorTracker, resolveWakeupInitiator } from '../../src/approval/turn-initiator.js';

/** 构造一条 session/event 形状的事件（tracker 只依赖 type/data）。 */
function evt(type: string, data?: any) {
  return { type, data } as any;
}

function userMessage(id: string, kind: string = 'user') {
  return evt('user/message', { id, source: { kind } });
}

describe('契约测试: 审批「本轮唤醒者」追踪器 (Turn Initiator Tracker)', () => {
  it('契约 1: 本轮首个 user/message 命中唤醒登记后绑定为审批申请人', () => {
    const tracker = new TurnInitiatorTracker();
    expect(tracker.expect('msg-a', 'qq-group-1', '10001')).toBe(true);

    tracker.observe({ id: 'qq-group-1' }, evt('turn/start'));
    tracker.observe({ id: 'qq-group-1' }, userMessage('msg-a'));

    expect(tracker.getInitiator('qq-group-1')).toBe('10001');
  });

  it('契约 2: 同轮 steer 插话（第二个 user/message）绝不覆盖本轮唤醒者', () => {
    const tracker = new TurnInitiatorTracker();
    tracker.expect('msg-a', 'qq-group-1', '10001');
    tracker.expect('msg-b', 'qq-group-1', '99999');

    tracker.observe({ id: 'qq-group-1' }, evt('turn/start'));
    tracker.observe({ id: 'qq-group-1' }, userMessage('msg-a'));
    tracker.observe({ id: 'qq-group-1' }, userMessage('msg-b'));

    expect(tracker.getInitiator('qq-group-1')).toBe('10001');
  });

  it('契约 3: turn/end 立即清除本轮申请人，下一轮前审批必须 Fail-Closed', () => {
    const tracker = new TurnInitiatorTracker();
    tracker.expect('msg-a', 'qq-group-1', '10001');

    tracker.observe({ id: 'qq-group-1' }, evt('turn/start'));
    tracker.observe({ id: 'qq-group-1' }, userMessage('msg-a'));
    tracker.observe({ id: 'qq-group-1' }, evt('turn/end', { turn: 1, reason: { kind: 'completed' } }));

    expect(tracker.getInitiator('qq-group-1')).toBeUndefined();
  });

  it('契约 4: 排队两轮唤醒各自绑定，后一轮绝不顶掉前一轮（修复「最近唤醒者」串轮）', () => {
    const tracker = new TurnInitiatorTracker();
    tracker.expect('msg-a', 'qq-group-1', '10001');
    tracker.expect('msg-b', 'qq-group-1', '99999');

    // 第一轮（管理员 A）
    tracker.observe({ id: 'qq-group-1' }, evt('turn/start'));
    tracker.observe({ id: 'qq-group-1' }, userMessage('msg-a'));
    expect(tracker.getInitiator('qq-group-1')).toBe('10001');

    tracker.observe({ id: 'qq-group-1' }, evt('turn/end', { turn: 1, reason: { kind: 'completed' } }));

    // 第二轮（普通群友 B）—— 各自归属于各自轮次
    tracker.observe({ id: 'qq-group-1' }, evt('turn/start'));
    tracker.observe({ id: 'qq-group-1' }, userMessage('msg-b'));
    expect(tracker.getInitiator('qq-group-1')).toBe('99999');
  });

  it('契约 5: 系统触发不登记 → 本轮首个 user/message 不产生申请人', () => {
    const tracker = new TurnInitiatorTracker();
    // proactive / scheduled / internal_agent 经 resolveWakeupInitiator 一律返回 null
    for (const trigger of ['proactive', 'scheduled', 'internal_agent']) {
      expect(resolveWakeupInitiator(trigger, '10001')).toBeNull();
    }

    tracker.observe({ id: 'qq-group-1' }, evt('turn/start'));
    tracker.observe({ id: 'qq-group-1' }, userMessage('msg-system'));

    expect(tracker.getInitiator('qq-group-1')).toBeUndefined();
  });

  it('契约 6: 未登记的普通群聊消息绝不误绑（刷屏消息不产生审批资格）', () => {
    const tracker = new TurnInitiatorTracker();
    tracker.expect('msg-a', 'qq-group-1', '10001');

    tracker.observe({ id: 'qq-group-1' }, evt('turn/start'));
    tracker.observe({ id: 'qq-group-1' }, userMessage('msg-noise'));
    tracker.observe({ id: 'qq-group-1' }, userMessage('msg-a'));

    // 本轮首次输入已被普通消息占用 → 严格 Fail-Closed，绝不回填后续消息
    expect(tracker.getInitiator('qq-group-1')).toBeUndefined();
  });

  it('契约 7: 跨会话的 messageId 不得绑定到另一会话', () => {
    const tracker = new TurnInitiatorTracker();
    tracker.expect('msg-a', 'qq-group-1', '10001');

    tracker.observe({ id: 'qq-group-2' }, evt('turn/start'));
    tracker.observe({ id: 'qq-group-2' }, userMessage('msg-a'));

    expect(tracker.getInitiator('qq-group-2')).toBeUndefined();
    expect(tracker.getInitiator('qq-group-1')).toBeUndefined();
  });

  it('契约 8: runtime-context 注入不占用本轮首个输入名额', () => {
    const tracker = new TurnInitiatorTracker();
    tracker.expect('msg-a', 'qq-group-1', '10001');

    tracker.observe({ id: 'qq-group-1' }, evt('turn/start'));
    tracker.observe({ id: 'qq-group-1' }, userMessage('ctx-1', 'runtime-context'));
    tracker.observe({ id: 'qq-group-1' }, userMessage('msg-a'));

    expect(tracker.getInitiator('qq-group-1')).toBe('10001');
  });

  it('契约 9: 非法登记（空 messageId / 空 sessionId / 非数字 QQ）一律拒绝', () => {
    const tracker = new TurnInitiatorTracker();
    expect(tracker.expect('', 'qq-group-1', '10001')).toBe(false);
    expect(tracker.expect('msg-a', '', '10001')).toBe(false);
    expect(tracker.expect('msg-a', 'qq-group-1', 'system')).toBe(false);
    expect(tracker.expect('msg-a', 'qq-group-1', '')).toBe(false);
    expect(tracker.pendingCount).toBe(0);
  });

  it('契约 10: 待确认登记有上限，陈旧唤醒不会无限累积', () => {
    const tracker = new TurnInitiatorTracker({ maxExpectations: 2 });
    tracker.expect('msg-1', 'qq-group-1', '10001');
    tracker.expect('msg-2', 'qq-group-1', '10002');
    tracker.expect('msg-3', 'qq-group-1', '10003');

    expect(tracker.pendingCount).toBe(2);

    tracker.observe({ id: 'qq-group-1' }, evt('turn/start'));
    tracker.observe({ id: 'qq-group-1' }, userMessage('msg-1'));
    expect(tracker.getInitiator('qq-group-1')).toBeUndefined();

    tracker.observe({ id: 'qq-group-1' }, evt('turn/start'));
    tracker.observe({ id: 'qq-group-1' }, userMessage('msg-3'));
    expect(tracker.getInitiator('qq-group-1')).toBe('10003');
  });
});
