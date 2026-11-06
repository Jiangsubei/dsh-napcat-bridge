import { describe, it, expect } from 'vitest';
import { resolveWakeupInitiator } from '../../src/approval/responder.js';

describe('契约测试: 审批唤醒发起人判定（本轮登记口径） (Approval Wakeup Initiator)', () => {
  it('契约 1: 真实 QQ 发送者唤醒（at/mention/quote/poke/direct）记录其 QQ 号', () => {
    for (const trigger of ['at', 'mention', 'quote', 'poke', 'direct']) {
      expect(resolveWakeupInitiator(trigger, '10001')).toBe('10001');
    }
  });

  it('契约 2: 系统触发（proactive/scheduled/internal_agent）一律不产生锚点', () => {
    for (const trigger of ['proactive', 'scheduled', 'internal_agent']) {
      expect(resolveWakeupInitiator(trigger, '10001')).toBeNull();
      expect(resolveWakeupInitiator(trigger, '')).toBeNull();
    }
  });

  it('契约 3: 真实触发但身份非纯数字 QQ（系统/内部 Session）时同样拒绝锚定', () => {
    expect(resolveWakeupInitiator('at', 'system')).toBeNull();
    expect(resolveWakeupInitiator('at', 'qq-agent-xxx')).toBeNull();
    expect(resolveWakeupInitiator('at', '')).toBeNull();
    expect(resolveWakeupInitiator('at', undefined)).toBeNull();
    expect(resolveWakeupInitiator('at', null)).toBeNull();
  });

  it('契约 4: 触发类型/QQ 号允许空白，未知触发类型不锚定', () => {
    expect(resolveWakeupInitiator(' at ', ' 10001 ')).toBe('10001');
    expect(resolveWakeupInitiator(undefined, '10001')).toBeNull();
    expect(resolveWakeupInitiator('unknown', '10001')).toBeNull();
  });
});
