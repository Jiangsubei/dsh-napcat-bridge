/**
 * tests/contract/system-event-hub.test.ts
 *
 * 契约测试: 系统内部事件与统一唤醒中枢 (SystemEventHub)
 *
 * 验证目标:
 * 1. 统一格式化标准: 双换行分段、中文冒号标题、原本精心打磨的行为引导 100% 完整保留并置底;
 * 2. 标题防污染铁律: 任何系统事件经由 Hub 分发，底层 Payload 的 from_name 绝不含系统伪昵称，绝对不触发私聊重命名与昵称缓存;
 * 3. 零特权审批铁律: 系统事件底层 Payload 的 from_user 严格为空，杜绝借壳提权;
 * 4. 出站上下文自动挂载: 自动向 OutboundBridge 挂载 is_synthetic: true 的上下文，且 trigger 映射准确。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fsp } from 'node:fs';
import { SessionManager } from '../../src/gateway/session.js';
import { SystemEventHub, formatSystemEventPrompt } from '../../src/gateway/system-event-hub.js';
import type {
  ScheduledTaskEvent,
  AgentIpcEvent,
  ProactiveLurkEvent,
  ProactivePollingEvent,
  SyntheticNoticeEvent,
} from '../../src/types/system-event.js';

const PEER_USER = 'user_1000000001';
const PEER_GROUP = 'group_8000000001';
const SESSION_ID = 'qq-user-1000000001';
const NEUTRAL_TITLE = '私聊: 1000000001 #1';

describe('契约测试: 系统事件与统一唤醒中枢 (SystemEventHub)', () => {
  let tmpHome: string;
  let sessionManager: SessionManager;
  let currentTitle: string;
  let rename: any;
  let followup: any;
  let mockAgent: any;
  let mockOutboundBridge: any;
  let systemEventHub: SystemEventHub;

  beforeEach(async () => {
    tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-system-event-hub-'));
    currentTitle = NEUTRAL_TITLE;
    rename = vi.fn((_session: any, title: string) => {
      currentTitle = title;
    });
    followup = vi.fn();
    mockAgent = {
      status: 'idle',
      followup,
      steer: vi.fn(),
      session: { id: SESSION_ID },
    };

    const mockCtx: any = {
      get: vi.fn((key: string) => {
        if (key === 'agents') {
          return { get: () => mockAgent };
        }
        if (key === 'sessionTitle') {
          return {
            get: () => ({ title: currentTitle }),
            rename,
          };
        }
        return undefined;
      }),
      logger: () => ({
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      }),
    };

    sessionManager = new SessionManager(mockCtx, tmpHome);

    mockOutboundBridge = {
      trackInboundContext: vi.fn(),
      trackPendingMessage: vi.fn(),
    };

    systemEventHub = new SystemEventHub({
      sessionManager,
      outboundBridge: mockOutboundBridge,
    });
  });

  afterEach(async () => {
    await sessionManager?.dispose().catch(() => {});
    await fsp.rm(tmpHome, { recursive: true, force: true }).catch(() => {});
  });

  describe('1. 提示词标准骨架格式化契约 (formatSystemEventPrompt)', () => {
    it('1.1 定时任务唤醒: 包含统一头部、任务编号、规则、内容以及置底的打磨说明', () => {
      const event: ScheduledTaskEvent = {
        kind: 'scheduled_task',
        peer: PEER_GROUP,
        taskId: 'task_999',
        taskType: 'recurring',
        taskRule: '每天 18:00 执行',
        prompt: '提醒大家下班打卡并通报天气',
        timestamp: 1794000000000,
      };

      const prompt = formatSystemEventPrompt(event);

      // 验证双换行分段结构
      expect(prompt).toContain('系统事件：[定时任务] [任务编号: #task_999] [QQ群聊: 8000000001]');
      expect(prompt).toContain('任务规则：每天 18:00 执行');
      expect(prompt).toContain('\n\n任务内容：\n提醒大家下班打卡并通报天气\n\n');
      // 验证原本打磨好的引导文案完整保留在末尾
      expect(prompt.endsWith(
        '（说明：这是此前设定的定时任务触发。如果是群聊场景，建议先通过 read_chat_history 工具查看最近群聊动态再决定如何发言，发言内容应自然贴切，切勿向用户透露内部 task_id 或系统事件代码等调试信息。）'
      )).toBe(true);
    });

    it('1.2 跨 Agent 协同 IPC: 包含统一头部、来源会话、内容以及置底回执指引', () => {
      const event: AgentIpcEvent = {
        kind: 'agent_ipc',
        targetPeer: PEER_USER,
        fromSessionId: 'session_caller_123',
        message: '请协助确认该用户的未付账单',
        timestamp: 1794000000000,
      };

      const prompt = formatSystemEventPrompt(event);

      expect(prompt).toContain('系统事件：[内部协同] [来源会话: session_caller_123]');
      expect(prompt).toContain('\n\n协同内容：\n请协助确认该用户的未付账单\n\n');
      expect(prompt).toContain('（说明：这是来自其他 Agent 工作区的内部协作指令/消息，QQ 真实用户完全不可见。');
      expect(prompt).toContain('target_session_id 设为 "session_caller_123"');
    });

    it('1.3 潜水超时冒泡: 包含时长与置底的 [结束] 决策指引', () => {
      const event: ProactiveLurkEvent = {
        kind: 'proactive_lurk',
        peer: PEER_GROUP,
        idleDurationMinutes: 120,
        timestamp: 1794000000000,
      };

      const prompt = formatSystemEventPrompt(event);

      expect(prompt).toContain('系统事件：[潜水唤醒] [QQ群聊: 8000000001]');
      expect(prompt).toContain('\n\n群聊状态：当前群聊已较长时间没有新发言（已超 120 分钟）。\n\n');
      expect(prompt).toContain('若判断当前无需发言或不便打扰，直接输出 [结束]。表现自然，切勿透露潜水超时、系统唤醒等任何后台痕迹。');
    });

    it('1.4 主动回复未读聚合: 消息列表前置，包含消息ID，原本的复读/接梗说明置底', () => {
      const event: ProactivePollingEvent = {
        kind: 'proactive_polling',
        peer: PEER_GROUP,
        bufferedMessages: [
          {
            timestamp: 1794000001000,
            from_user: '1000000001',
            from_name: '张三',
            content: '大家晚上吃什么',
            msg_id: 66601,
          },
          {
            timestamp: 1794000002000,
            from_user: '1000000002',
            from_name: '李四',
            content: '吃烤肉吧',
            msg_id: 66602,
          },
        ],
        timestamp: 1794000003000,
      };

      const prompt = formatSystemEventPrompt(event);

      expect(prompt).toContain('系统事件：[主动回复] [QQ群聊: 8000000001]');
      expect(prompt).toContain('\n\n历史消息：\n');
      expect(prompt).toContain('[消息ID: 66601] 张三 (QQ: 1000000001): 大家晚上吃什么');
      expect(prompt).toContain('[消息ID: 66602] 李四 (QQ: 1000000002): 吃烤肉吧');
      expect(prompt).toContain('如果群内最近明显在复读玩梗，可以根据群内当前氛围判断是否需要一起复读');
      expect(prompt).toContain('若拿不准则输出 [结束]。切勿透露系统提示或触发机制等后台痕迹。');
    });

    it('1.5 戳一戳通知合成: 标准头部与戳一戳描述', () => {
      const event: SyntheticNoticeEvent = {
        kind: 'synthetic_notice',
        peer: PEER_USER,
        noticeType: 'poke',
        operatorUser: '1000000001',
        operatorName: '测试好友',
        timestamp: 1794000000000,
      };

      const prompt = formatSystemEventPrompt(event);

      expect(prompt).toContain('系统事件：[戳一戳] [QQ私聊]');
      expect(prompt).toContain('用户 测试好友 (QQ: 1000000001) 戳了戳你。');
    });
  });

  describe('2. 标题防污染与零特权审批契约', () => {
    it('2.1 定时任务通过 Hub 分发: 绝不修改会话标题，绝不写入昵称缓存，底层 from_name/from_user 为空', async () => {
      let capturedPayload: any;
      const originalDispatch = sessionManager.dispatchWakeup.bind(sessionManager);
      sessionManager.dispatchWakeup = vi.fn(async (payload, opts) => {
        capturedPayload = payload;
        return originalDispatch(payload, opts);
      });

      await systemEventHub.dispatchScheduledTask({
        peer: PEER_USER,
        taskId: 'task_001',
        taskType: 'once',
        prompt: '提醒喝水',
        creator: '1000000001',
      });

      // 验证捕获到的 payload
      expect(capturedPayload.is_system).toBe(true);
      expect(capturedPayload.from_name).toBe('');
      expect(capturedPayload.from_user).toBe('');
      expect(capturedPayload.trigger).toBe('scheduled');

      // 验证标题未被污染
      expect(rename).not.toHaveBeenCalled();
      expect(currentTitle).toBe(NEUTRAL_TITLE);
      expect(sessionManager.getPeerName(PEER_USER)).toBeUndefined();
    });

    it('2.2 跨 Agent IPC 通过 Hub 分发: 同样杜绝标题污染', async () => {
      await systemEventHub.dispatchAgentIpc({
        targetPeer: PEER_USER,
        fromSessionId: 'session_parent',
        message: '协同执行任务',
      });

      expect(rename).not.toHaveBeenCalled();
      expect(currentTitle).toBe(NEUTRAL_TITLE);
      expect(sessionManager.getPeerName(PEER_USER)).toBeUndefined();
    });
  });

  describe('3. 出站合成上下文自动追踪契约', () => {
    it('3.1 系统事件分发时自动向 OutboundBridge 挂载 is_synthetic: true 与对应 trigger', async () => {
      await systemEventHub.dispatchScheduledTask({
        peer: PEER_GROUP,
        taskId: 'task_002',
        taskType: 'once',
        prompt: '群早报',
      });

      expect(mockOutboundBridge.trackInboundContext).toHaveBeenCalledWith(
        PEER_GROUP,
        expect.objectContaining({
          msg_id: undefined,
          from_user: '',
          is_group: true,
          trigger: 'scheduled',
          is_synthetic: true,
        })
      );
    });

    it('3.2 潜水唤醒自动标记 trigger=idle 且 is_synthetic: true', async () => {
      await systemEventHub.dispatchProactiveLurk({
        peer: PEER_GROUP,
        idleDurationMinutes: 120,
      });

      expect(mockOutboundBridge.trackInboundContext).toHaveBeenCalledWith(
        PEER_GROUP,
        expect.objectContaining({
          trigger: 'idle',
          is_synthetic: true,
        })
      );
    });
  });
});
