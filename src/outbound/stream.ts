/**
 * dsh-napcat-bridge: 出站事件流处理模块
 * 从 session/event 中精准提取 assistant/message 中的 TextBlock，
 * 坚决过滤 reasoning、tool-call、tool-result 等中间过程，
 * 并通过串行队列有序向 NapCat 下发纯文本排版消息。
 */

import type { Context } from '@deepseek-ai/cordis';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session';
import type { NapCatGatewayServer } from '../gateway/server.js';
import type { SessionManager } from '../gateway/session.js';
import type { BridgePluginConfig, InboundReplyContext } from '../types/index.js';
import { stripMarkdown } from './render.js';
import { PerPeerSerialSender } from './queue.js';

/**
 * 从模型输出的 ContentBlock 数组中提取正式回复 TextBlock，
 * 坚决过滤思考过程 (reasoning)、工具调用 (tool-call)、工具结果 (tool-result) 等非正文块。
 */
export function filterAndExtractOutboundBlocks(
  blocks: ContentBlock[]
): Array<{ type: 'text'; text: string }> {
  if (!Array.isArray(blocks)) {
    return [];
  }

  const results: Array<{ type: 'text'; text: string }> = [];

  for (const block of blocks) {
    if (!block) continue;
    if (block.type === 'text' && typeof (block as any).text === 'string') {
      const text = (block as any).text;
      if (text.length > 0) {
        results.push({
          type: 'text',
          text,
        });
      }
    }
  }

  return results;
}

export interface OutboundStreamBridgeOptions {
  gateway: NapCatGatewayServer;
  sessionManager: SessionManager;
  getConfig?: () => BridgePluginConfig;
  logger?: {
    info?: (...args: any[]) => void;
    warn?: (...args: any[]) => void;
    error?: (...args: any[]) => void;
    debug?: (...args: any[]) => void;
  };
}

/**
 * 出站事件流桥接器
 * 监听 Cordis session/event 事件，将模型正式回复经 Markdown Strip 纯文本排版后
 * 串行分段发送至对应 QQ Peer。
 * 群聊回复按配置 at_questioner / quote_original (Spec §7.1，决策 A) 在首段组装
 * CQ:reply (引用唤醒原消息) 与 CQ:at (@提问者) 前缀；私聊不 @ 不引用。
 */
export type InboundReplyContextInput =
  | InboundReplyContext
  | {
      msg_id?: number | undefined;
      from_user?: string;
      is_group?: boolean;
      trigger?: string;
      is_synthetic?: boolean;
      synthetic?: boolean;
    };

export class OutboundStreamBridge {
  private readonly sender: PerPeerSerialSender;
  // 保底/兼容单值上下文映射 (peer -> InboundReplyContextInput)
  private inboundContexts = new Map<string, InboundReplyContextInput>();
  // 待激活消息上下文 (messageId -> { peer, context })
  private pendingMessageContexts = new Map<string, { peer: string; context: InboundReplyContextInput }>();
  // Turn 级精准绑定映射 (peer -> Map<turn, InboundReplyContextInput>)
  private turnContexts = new Map<string, Map<number, InboundReplyContextInput>>();
  // 当前 peer 正在执行的活跃 Turn (peer -> turn)
  private activeTurns = new Map<string, number>();
  // 记录每个 Turn 是否已经下发过首段前缀 ( `${peer}:${turn}` )
  private turnFirstSent = new Set<string>();
  // 记录每个 Turn 中 send_message 的调用次数 ( `${peer}:${turn}` -> count )
  private turnSendMessageCounts = new Map<string, number>();
  private unlisten: (() => void) | null = null;

  constructor(
    private readonly ctx: Context,
    private readonly options: OutboundStreamBridgeOptions
  ) {
    this.sender = new PerPeerSerialSender();
    if (typeof (this.options.sessionManager as any)?.setOutboundBridge === 'function') {
      (this.options.sessionManager as any).setOutboundBridge(this);
    }
  }

  /**
   * 记录某 peer 最近一次唤醒的入站消息上下文（唤醒源 msg_id 与提问者 QQ），
   * 供出方向按开关组装引用/@ 前缀。由入方向消息处理路径在判定唤醒后调用。
   */
  trackInboundContext(peer: string, context: InboundReplyContextInput): void {
    if (!peer || !context) return;
    this.inboundContexts.set(peer, context);
  }

  /**
   * 登记一条待触发轮次的 UserMessage 上下文（messageId -> context）。
   * 当 Session 驱动器派发该消息并开启对应 Turn 时，自动锁定绑定至该 Turn。
   */
  trackPendingMessage(messageId: string, peer: string, context: InboundReplyContextInput): void {
    if (!messageId || !peer || !context) return;
    this.pendingMessageContexts.set(messageId, { peer, context });
  }

  /**
   * 动态刷新指定 peer 当前正在活跃轮次的回复上下文。
   * 供工具挂起等待（如 wait_for_user_messages）在当前 Turn 内收集到新消息时刷新回复锚点。
   */
  updateActiveTurnContext(peer: string, context: InboundReplyContextInput): void {
    if (!peer || !context) return;
    // 防御保护：若 context 标记为合成/notice，严禁更新活跃 Turn 的真实锚点
    if ((context as any).is_synthetic || (context as any).synthetic) {
      return;
    }
    this.inboundContexts.set(peer, context);
    const currentTurn = this.activeTurns.get(peer);
    if (currentTurn !== undefined) {
      let peerMap = this.turnContexts.get(peer);
      if (!peerMap) {
        peerMap = new Map();
        this.turnContexts.set(peer, peerMap);
      }
      peerMap.set(currentTurn, context);
    }
  }

  /**
   * 获取指定 peer 当前活跃回合的回复上下文锚点。
   * 优先从当前活跃 Turn 获取；若当前无活跃 Turn，回退至 peer 级保底上下文。
   */
  getActiveTurnContext(peer: string): InboundReplyContextInput | undefined {
    if (!peer) return undefined;

    const normalized = typeof (this.options.sessionManager as any)?.sessionIdToPeer === 'function'
      ? (this.options.sessionManager as any).sessionIdToPeer(peer)
      : peer;

    const candidates = [peer, normalized];
    for (const p of candidates) {
      const activeTurn = this.activeTurns.get(p);
      if (activeTurn !== undefined) {
        const turnCtx = this.turnContexts.get(p)?.get(activeTurn);
        if (turnCtx) return turnCtx;
      }
    }

    for (const p of candidates) {
      const fallback = this.inboundContexts.get(p);
      if (fallback) return fallback;
    }

    return undefined;
  }

  /**
   * 兼容方法：获取 peer 的回复上下文 (等同于 getActiveTurnContext)
   */
  getInboundContext(peer: string): InboundReplyContextInput | undefined {
    return this.getActiveTurnContext(peer);
  }

  /**
   * 获取指定 peer 和 turn 中 send_message 的调用次数
   */
  getTurnSendMessageCount(peer: string, turn: number): number {
    return this.turnSendMessageCounts.get(`${peer}:${turn}`) || 0;
  }

  /**
   * 启动出站事件流监听
   */
  start(): () => void {
    if (this.unlisten) {
      return this.unlisten;
    }

    const handler = async (session: Session, event: SessionEvent) => {
      try {
        await this.handleSessionEvent(session, event);
      } catch (err) {
        this.options.logger?.error?.('[OutboundStreamBridge] 处理 session/event 异常:', err);
      }
    };

    const disposer = (this.ctx as any).on('session/event', handler);
    this.unlisten = () => {
      if (typeof disposer === 'function') {
        disposer();
      }
      this.unlisten = null;
    };

    return this.unlisten;
  }

  /**
   * 处理单条 session/event
   */
  async handleSessionEvent(session: Session, event: SessionEvent): Promise<void> {
    if (!session || !event) return;

    // 仅处理 QQ 会话
    if (!this.options.sessionManager.isQQSession(session.id)) {
      return;
    }

    const peer = this.options.sessionManager.sessionIdToPeer(session.id);

    // 1. 轮次开启: 记录当前活跃 Turn
    if (event.type === 'turn/start') {
      const turn = (event.data as any)?.turn;
      if (typeof turn === 'number') {
        this.activeTurns.set(peer, turn);
        this.turnSendMessageCounts.set(`${peer}:${turn}`, 0);
        // 若此前已有该 peer 的 pending 消息到达，将其绑定到当前刚开启的 turn
        for (const [msgId, entry] of this.pendingMessageContexts.entries()) {
          if (entry.peer === peer) {
            this.pendingMessageContexts.delete(msgId);
            let peerMap = this.turnContexts.get(peer);
            if (!peerMap) {
              peerMap = new Map();
              this.turnContexts.set(peer, peerMap);
            }
            if (!peerMap.has(turn)) {
              peerMap.set(turn, entry.context);
            }
            break;
          }
        }
      }
      return;
    }

    // 2. 消息进入轮次: 尝试将 pending 的入站上下文精准锚定到当前活跃 Turn
    if (event.type === 'user/message') {
      const msgId = (event.data as any)?.id;
      if (msgId && this.pendingMessageContexts.has(msgId)) {
        const currentTurn = this.activeTurns.get(peer);
        if (currentTurn !== undefined) {
          const { context } = this.pendingMessageContexts.get(msgId)!;
          this.pendingMessageContexts.delete(msgId);
          let peerMap = this.turnContexts.get(peer);
          if (!peerMap) {
            peerMap = new Map();
            this.turnContexts.set(peer, peerMap);
          }
          if (!peerMap.has(currentTurn)) {
            peerMap.set(currentTurn, context);
          }
        }
      }
      return;
    }

    // 监听 session/event 的 tool/call 事件: 跟踪 send_message 调用次数
    if (event.type === 'tool/call') {
      const toolName = (event.data as any)?.name;
      if (toolName === 'send_message') {
        const turn = typeof (event.data as any)?.turn === 'number'
          ? (event.data as any).turn
          : this.activeTurns.get(peer);
        if (turn !== undefined) {
          const key = `${peer}:${turn}`;
          this.turnSendMessageCounts.set(key, (this.turnSendMessageCounts.get(key) || 0) + 1);
        }
      }
      return;
    }

    // 3. 轮次结束: 清理当前 Turn 的绑定映射与首段标记
    if (event.type === 'turn/end') {
      const turn = (event.data as any)?.turn;
      if (typeof turn === 'number') {
        this.turnFirstSent.delete(`${peer}:${turn}`);
        this.turnSendMessageCounts.delete(`${peer}:${turn}`);
        if (this.activeTurns.get(peer) === turn) {
          this.activeTurns.delete(peer);
        }
        this.turnContexts.get(peer)?.delete(turn);
      }
      return;
    }

    // 4. 仅针对 assistant/message 事件提取正文回复
    if (event.type === 'assistant/message') {
      const msgData = event.data as any;
      const turn = typeof msgData?.turn === 'number' ? msgData.turn : this.activeTurns.get(peer);
      const contentBlocks: ContentBlock[] = msgData?.message?.content || [];

      // 旁白结构性抑制（Checklist C1）：
      // 若 content 中包含任何 tool-call 块，说明此条消息伴随工具调用，
      // 其中的文本块纯属模型思考旁白或工具间隙溢出，结构性抑制，绝对不向 QQ 发送。
      const hasToolCall = contentBlocks.some((block) => block && (block as any).type === 'tool-call');
      if (hasToolCall) {
        return;
      }

      const turnKey = turn !== undefined ? `${peer}:${turn}` : undefined;

      // turn/end 兜底机制（Checklist C2, C3, C4）：
      // 当 assistant/message 不包含任何 tool-call 时（即纯文本回复）：
      // 检查当前 turn 的 sendCount
      const sendCount = turnKey ? (this.turnSendMessageCounts.get(turnKey) || 0) : 0;
      // 分支 B: sendCount >= 1 -> 模型已通过 send_message 主动发过言，信任模型自管理输出，末尾纯文本回复不发送（仅留存 Web UI，防重复打扰）
      if (sendCount >= 1) {
        return;
      }

      // 分支 A: sendCount === 0 -> 模型未主动调用 send_message，触发安全兜底，将纯文本回复发送给 QQ Peer
      const textBlocks = filterAndExtractOutboundBlocks(contentBlocks);

      // 提取针对该 Turn 的上下文 (Turn 级精准绑定优先)
      let inbound: InboundReplyContextInput | undefined;
      if (turn !== undefined) {
        inbound = this.turnContexts.get(peer)?.get(turn);
      }
      // 仅在未带 turn 的非轮次/兼容单值路径下回退到 peer 保底
      if (!inbound && turn === undefined) {
        inbound = this.getActiveTurnContext(peer) ?? this.inboundContexts.get(peer);
      }

      for (let i = 0; i < textBlocks.length; i++) {
        const block = textBlocks[i];
        const plainText = stripMarkdown(block.text);
        if (!plainText || !plainText.trim()) continue;

        // 仅首个正文段携带 @/引用 前缀 (Spec §7.1: 在首段 @ 提问者)
        // 若指定了 turn，确保同一 turn 跨 step 或跨 block 仅首次发送携带前缀
        const shouldPrefix = turnKey
          ? !this.turnFirstSent.has(turnKey)
          : (i === 0);

        if (turnKey && shouldPrefix) {
          this.turnFirstSent.add(turnKey);
        }

        await this.sendSerialized(peer, plainText, {
          withPrefix: shouldPrefix,
          inbound,
        });
      }
    }
  }

  /**
   * 按 at_questioner / quote_original 组装群聊出站消息 (Spec §7.1 / 决策 A)：
   * - quote_original=true 且存在唤醒源消息 id → 前置 CQ:reply 段；
   * - at_questioner=true 且存在提问者 QQ → 前置 CQ:at 段；
   * - 私聊 (user_*) 不 @ 不引用，保持纯文本原样；
   * - 无唤醒上下文时按纯文本原样下发。
   */
  buildMessagePayload(
    peer: string,
    text: string,
    options?: { withPrefix?: boolean; inbound?: InboundReplyContextInput }
  ): string | Array<Record<string, any>> {
    const isGroup = peer.startsWith('group_') || peer.startsWith('qq-group-');
    if (!isGroup) {
      return text;
    }

    const withPrefix = options?.withPrefix !== false;
    if (!withPrefix) {
      return text;
    }

    // 跨触发隔离加固：若显式指定了 options（含 options.inbound），以本次 inbound 为准；
    // 仅在未指定 options.inbound 时回退到当前活跃 Turn 锚点或 peer 保底。
    const inbound = (options && 'inbound' in options)
      ? options.inbound
      : this.getActiveTurnContext(peer) ?? this.inboundContexts.get(peer);
    if (!inbound) {
      return text;
    }

    // 防御保护：若 inbound 被标记为合成/notice，严禁生成 reply 段，出站自动降级为纯文本
    const isSynthetic =
      Boolean((inbound as any).is_synthetic) ||
      Boolean((inbound as any).synthetic) ||
      (inbound as any).trigger === 'poke' ||
      (inbound as any).trigger === 'idle' ||
      (inbound as any).trigger === 'notice' ||
      (inbound as any).notice_type !== undefined;

    if (isSynthetic) {
      return text;
    }

    if (!inbound.msg_id && !inbound.from_user) {
      return text;
    }

    const config = (this.options.getConfig ? this.options.getConfig() : {}) || {};
    const quoteOriginal = config.quote_original !== false;
    const atQuestioner = config.at_questioner === true;

    // 校验 msg_id 是否为合法的真实入站消息 ID (正整数且非合成)
    const isValidReplyMsgId =
      typeof inbound.msg_id === 'number' &&
      Number.isSafeInteger(inbound.msg_id) &&
      inbound.msg_id > 0;

    const segments: Array<Record<string, any>> = [];
    if (quoteOriginal && isValidReplyMsgId) {
      segments.push({ type: 'reply', data: { id: inbound.msg_id } });
    }
    if (atQuestioner && inbound.from_user) {
      segments.push({ type: 'at', data: { qq: inbound.from_user } });
    }
    segments.push({ type: 'text', data: { text } });

    return segments.length === 1 ? text : segments;
  }

  /**
   * 串行有序向 QQ Peer 发送消息 (解决时序乱序竞态, Spec §7.3)
   * 经共享 per-peer 串行发送器下发，与提问/审批/发文件同队列。
   */
  async sendSerialized(
    peer: string,
    text: string,
    options?: { withPrefix?: boolean; inbound?: InboundReplyContextInput }
  ): Promise<void> {
    const message = this.buildMessagePayload(peer, text, options);
    await this.sender.enqueue(peer, async () => {
      await this.options.gateway.sendMsg(peer, message);
    });
  }

  /**
   * 销毁桥接器并注销监听
   */
  dispose(): void {
    if (this.unlisten) {
      this.unlisten();
    }
    this.sender.clear();
    this.inboundContexts.clear();
    this.pendingMessageContexts.clear();
    this.turnContexts.clear();
    this.activeTurns.clear();
    this.turnFirstSent.clear();
    this.turnSendMessageCounts.clear();
  }
}

