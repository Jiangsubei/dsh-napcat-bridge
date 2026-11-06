/**
 * dsh-napcat-bridge: 审批「本轮唤醒者」追踪器
 *
 * 语义（严格本轮）：审批申请人必须是**开启当前 agent 轮次**的那条真实 QQ 唤醒消息的发送者。
 * - 唤醒下发时登记 `userMsg.id → { sessionId, userId }`；
 * - 通过官方 `session/event` 观察 `turn/start` / `user/message` / `turn/end`；
 * - 只有本轮**首个真实用户输入**能绑定发起人，后续 steer 插话/群友刷屏绝不覆盖；
 * - `turn/end` 立即清除，保证下一轮开始前审批严格 Fail-Closed。
 *
 * 与旧「最近唤醒者」相比，排队多轮唤醒时各轮独立归属，不会串轮。
 */

/**
 * 「真实 QQ 发送者」触发的唤醒类型：只有这些唤醒才能成为审批申请人锚点。
 * 系统触发（proactive/scheduled/internal_agent）不在此列，不登记发起人，审批保持 Fail-Closed。
 */
const REAL_SENDER_WAKEUP_TRIGGERS = new Set(['at', 'mention', 'quote', 'poke', 'direct']);

/**
 * 计算唤醒发起人 QQ 号：
 * - 真实 QQ 发送者唤醒 → 返回其 QQ 号；
 * - 系统触发 / 非数字身份（内部 SessionId、'agent'、'system' 等）→ 返回 null。
 */
export function resolveWakeupInitiator(
  trigger: string | undefined | null,
  fromUser: string | number | undefined | null
): string | null {
  const normalizedTrigger = String(trigger || '').trim();
  if (!REAL_SENDER_WAKEUP_TRIGGERS.has(normalizedTrigger)) {
    return null;
  }
  const uid = fromUser === undefined || fromUser === null ? '' : String(fromUser).trim();
  return /^[0-9]+$/.test(uid) ? uid : null;
}

/** 一条已下发但尚未进入 session 日志的唤醒登记。 */
export interface TurnInitiatorExpectation {
  sessionId: string;
  userId: string;
}

export interface TurnInitiatorTrackerOptions {
  /** 待确认登记上限，防止被取消的唤醒无限累积。默认 256。 */
  maxExpectations?: number;
}

/** session/event 的最小结构依赖（避免与本模块无关的官方类型耦合）。 */
interface SessionLike {
  id?: string;
}

interface SessionEventLike {
  type?: string;
  data?: unknown;
}

/**
 * 追踪每个 QQ 会话「当前轮次」的唤醒发起人。
 *
 * 使用方：
 * - `SessionAgentRunner.dispatchWakeup` 在消息入队前调用 {@link expect}；
 * - 插件根 Context 把 `session/event` 转发给 {@link observe}；
 * - 审批 waterfall 用 {@link getInitiator} 取本轮申请人。
 */
export class TurnInitiatorTracker {
  private readonly expectations = new Map<string, TurnInitiatorExpectation>();
  /** sessionId → 当前轮次发起人 QQ */
  private readonly initiators = new Map<string, string>();
  /** 已开启且尚未消费「本轮首个真实用户输入」的会话 */
  private readonly awaitingTurnInput = new Set<string>();
  private readonly maxExpectations: number;

  constructor(options: TurnInitiatorTrackerOptions = {}) {
    const rawMax = Number(options.maxExpectations ?? 256);
    this.maxExpectations = Number.isFinite(rawMax) ? Math.max(1, Math.trunc(rawMax)) : 256;
  }

  /**
   * 登记一条即将下发的唤醒消息。仅真实 QQ 发送者的唤醒应被登记。
   * @returns 是否登记成功（非法输入一律忽略，保持 Fail-Closed）。
   */
  expect(
    messageId: string | undefined | null,
    sessionId: string | undefined | null,
    userId: string | undefined | null
  ): boolean {
    const mid = messageId === undefined || messageId === null ? '' : String(messageId).trim();
    const sid = sessionId === undefined || sessionId === null ? '' : String(sessionId).trim();
    const uid = userId === undefined || userId === null ? '' : String(userId).trim();
    if (!mid || !sid || !/^[0-9]+$/.test(uid)) {
      return false;
    }

    if (this.expectations.has(mid)) {
      this.expectations.delete(mid);
    }
    while (this.expectations.size >= this.maxExpectations) {
      const oldest = this.expectations.keys().next();
      if (oldest.done) break;
      this.expectations.delete(oldest.value);
    }
    this.expectations.set(mid, { sessionId: sid, userId: uid });
    return true;
  }

  /**
   * 观察官方 session 事件，维护「本轮发起人」状态机。
   * 该方法必须保持同步且绝不抛错（由 session 观察者容器兜底）。
   */
  observe(session: SessionLike | undefined | null, event: SessionEventLike | undefined | null): void {
    const sessionId = session?.id === undefined || session?.id === null ? '' : String(session.id);
    const type = event?.type;
    if (!sessionId || !type) return;

    if (type === 'turn/start') {
      // 新一轮开始：等待本轮首个真实用户输入，旧轮次归属立即失效。
      this.awaitingTurnInput.add(sessionId);
      this.initiators.delete(sessionId);
      return;
    }

    if (type === 'turn/end') {
      this.awaitingTurnInput.delete(sessionId);
      this.initiators.delete(sessionId);
      return;
    }

    if (type !== 'user/message') return;
    if (!this.awaitingTurnInput.has(sessionId)) return;

    const message = event.data as { id?: unknown; source?: { kind?: unknown } } | undefined;
    const sourceKind = message?.source?.kind;
    // runtime-context 等系统注入不占用「首个真实用户输入」名额。
    if (sourceKind === 'runtime-context') return;

    // 本轮首个真实输入已确定：无论是否为唤醒消息，后续 steer 都不再改写归属。
    this.awaitingTurnInput.delete(sessionId);

    const messageId = message?.id === undefined || message?.id === null ? '' : String(message.id);
    if (!messageId) return;
    const expectation = this.expectations.get(messageId);
    if (!expectation) return;
    this.expectations.delete(messageId);
    if (expectation.sessionId !== sessionId) return;

    this.initiators.set(sessionId, expectation.userId);
  }

  /** 取某会话当前轮次的唤醒发起人 QQ；无归属时返回 undefined（调用方必须 Fail-Closed）。 */
  getInitiator(sessionId: string | undefined | null): string | undefined {
    const sid = sessionId === undefined || sessionId === null ? '' : String(sessionId).trim();
    if (!sid) return undefined;
    return this.initiators.get(sid);
  }

  /** 清空全部跟踪状态（插件卸载时使用）。 */
  clear(): void {
    this.expectations.clear();
    this.initiators.clear();
    this.awaitingTurnInput.clear();
  }

  /** 待确认唤醒登记数（诊断与契约测试用）。 */
  get pendingCount(): number {
    return this.expectations.size;
  }
}
