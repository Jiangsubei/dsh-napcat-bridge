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
  // 保底/活跃入站上下文映射 (peer -> InboundReplyContextInput)
  private inboundContexts = new Map<string, InboundReplyContextInput>();
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
   * 获取底层串行发送器
   */
  getSender(): PerPeerSerialSender {
    return this.sender;
  }

  /**
   * 获取某 peer 当前正在执行的活跃轮次号（未在运行则为 undefined）
   */
  getActiveTurn(_peer: string): number | undefined {
    return undefined;
  }

  /**
   * 记录某 peer 最近一次唤醒的入站消息上下文
   */
  trackInboundContext(peer: string, context: InboundReplyContextInput): void {
    if (!peer || !context) return;
    this.inboundContexts.set(peer, context);
  }

  /**
   * 登记一条待触发轮次的 UserMessage 上下文
   */
  trackPendingMessage(_messageId: string, peer: string, context: InboundReplyContextInput): void {
    if (!peer || !context) return;
    this.inboundContexts.set(peer, context);
  }

  /**
   * 动态刷新指定 peer 当前正在活跃轮次的回复上下文
   */
  updateActiveTurnContext(peer: string, context: InboundReplyContextInput): void {
    if (!peer || !context) return;
    if ((context as any).is_synthetic || (context as any).synthetic) {
      return;
    }
    this.inboundContexts.set(peer, context);
  }

  /**
   * 获取指定 peer 当前活跃回合的回复上下文锚点
   */
  getActiveTurnContext(peer: string): InboundReplyContextInput | undefined {
    if (!peer) return undefined;

    const normalized = typeof (this.options.sessionManager as any)?.sessionIdToPeer === 'function'
      ? (this.options.sessionManager as any).sessionIdToPeer(peer)
      : peer;

    return this.inboundContexts.get(peer) ?? this.inboundContexts.get(normalized);
  }

  /**
   * 兼容方法：获取 peer 的回复上下文 (等同于 getActiveTurnContext)
   */
  getInboundContext(peer: string): InboundReplyContextInput | undefined {
    return this.getActiveTurnContext(peer);
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
   * 贯彻“用户侧静默原则”与“send_qq_message 唯一通道原则”：
   * 废除 assistant/message 纯文本自动直发，绝不搞任何 turn/end 自动补发终答兜底。
   * 若模型在本轮未调用 send_qq_message，无论包含何种思考、正文或工具调用，网关均保持绝对静默。
   */
  async handleSessionEvent(session: Session, event: SessionEvent): Promise<void> {
    if (!session || !event) return;

    // 仅处理 QQ 会话
    if (!this.options.sessionManager.isQQSession(session.id)) {
      return;
    }

    // 用户侧静默原则：不监听 assistant/message 直发出站，也不在 turn/end 兜底发信。
    // 整个系统向 QQ 下发文本的唯一途径就是显式调用 send_qq_message 工具。
    return;
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
  }
}

