/**
 * tests/contract/ipc-reply-loop.test.ts
 *
 * 契约测试: Agent 内部协作「回执即止」约束
 *
 * 规范:
 * 1. QQ 会话预设明确要求：被派发方回执一次即止，发起方收到回执后无新要求不再回复；
 * 2. 内部协同唤醒提示包含同样的终止约束；
 * 3. send_agent_message / create_user_agent 工具描述包含该约束。
 */

import { describe, it, expect } from 'vitest';
import { QQ_PRESET_PERSONA_PREFIX } from '../../src/constants/preset.js';
import { formatWakeupPrompt } from '../../src/gateway/session/id-resolver.js';
import {
  SEND_AGENT_MESSAGE_DESCRIPTION,
  CREATE_USER_AGENT_DESCRIPTION,
} from '../../src/tools/agent-ipc.js';
import type { WakeupPayload } from '../../src/types/index.js';

describe('契约测试: 内部协作回执即止', () => {
  it('契约 1: QQ 会话预设包含「回执即止」约束', () => {
    expect(QQ_PRESET_PERSONA_PREFIX).toContain('回执即止');
    expect(QQ_PRESET_PERSONA_PREFIX).toContain('不要再回复确认、致谢或追问');
  });

  it('契约 2: 内部协同唤醒提示要求回执一次即闭环', () => {
    const payload: WakeupPayload = {
      peer: 'user_1000000001',
      trigger: 'internal_agent',
      from_user: 'qq-user_1000000002',
      from_name: '协同 Agent',
      from_session: 'qq-user-1000000002',
      content: '统计一下群活跃度',
      timestamp: 1793800000000,
    };

    const prompt = formatWakeupPrompt(payload);
    expect(prompt).toContain('回执一次即视为闭环');
    expect(prompt).toContain('不要再次跟发确认或致谢');
  });

  it('契约 3: 内部协作工具描述包含终止约束', () => {
    expect(SEND_AGENT_MESSAGE_DESCRIPTION).toContain('回执即止');
    expect(CREATE_USER_AGENT_DESCRIPTION).toContain('回执一次即视为闭环');
  });
});
