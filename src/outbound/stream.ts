/**
 * dsh-napcat-bridge: 出站事件流处理模块
 * 从 session/event 中精准提取 assistant/message 中的 TextBlock，
 * 坚决过滤 reasoning、tool-call、tool-result 等中间过程，
 * 并通过串行队列有序向 NapCat 下发纯文本排版消息。
 */

import type { Context } from '@deepseek-ai/cordis';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
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
  gateway?: NapCatGatewayServer;
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
 * （历史推流模式已废除，出站统一由 send_qq_message 工具显式参数控制）。
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
    _ctx: Context,
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
   * 贯彻用户侧静默原则与 send_qq_message 唯一通道规范：
   * 不监听 session/event 进行文本自动直发，系统仅通过工具显式出站。
   */
  start(): () => void {
    return () => {};
  }

  /**
   * 处理单条 session/event
   * 贯彻“用户侧静默原则”与“send_qq_message 唯一通道原则”：
   * 不监听 assistant/message 直发出站，也不在 turn/end 兜底发信，保持绝对静默。
   */
  async handleSessionEvent(_session?: any, _event?: any): Promise<void> {
    return;
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

