/**
 * dsh-napcat-bridge: 审批响应器与提问 Provider 模块
 * 接入 Cordis approval/request waterfall 与 UserQuestionService.registerProvider。
 * 通过官方状态机流转审批与提问决策，规避旁路状态机孤岛。
 */

import type {
  AskUserQuestionRequest,
  AskUserQuestionAnswer,
  AskUserQuestionItem,
} from '@deepseek-ai/dsh-user-questions';
import type { NapCatGatewayServer } from '../gateway/server.js';
import type { SessionManager } from '../gateway/session.js';
import type { SerialSender } from '../types/index.js';

export interface QuestionProviderOptions {
  gateway?: NapCatGatewayServer;
  sessionManager?: SessionManager;
  /** 共享 per-peer 串行发送器 (Spec §7.3)：提问与正文/审批同队列，保证同 peer 内发送顺序 */
  sender?: SerialSender;
  logger?: {
    info?: (...args: any[]) => void;
    warn?: (...args: any[]) => void;
    error?: (...args: any[]) => void;
    debug?: (...args: any[]) => void;
  };
}

/**
 * 串行多题问答的挂起状态：
 * agent 一次传 N 道题 → 插件逐题下发（每次只渲染当前题卡片），全部答完才一次性 resolve。
 */
interface PendingSerialQuestion {
  request: AskUserQuestionRequest;
  peer: string;
  /** 私聊 / 群聊：决定卡片操作提示两档文案 */
  isGroup: boolean;
  /** 当前展示题的卡片消息 QQ message_id（群聊引用锚定：只有引用该卡片的回复才命中） */
  cardMessageId: number | string | null;
  /** 已作答缓存：逐题推进，最后一道答完一次性交回 agent */
  answers: AskUserQuestionAnswer['answers'];
  /** 当前题下标（0-based） */
  index: number;
  resolve: (answer: AskUserQuestionAnswer) => void;
  reject: (err: Error) => void;
}

/**
 * 接入 DSH UserQuestionService 的 NapCat 提问 Provider
 *
 * 串行多题问答状态机（用户拍板）：
 * - agent 一次传 N 道题 → 只渲染第 1 题卡片发给用户，挂起等该题答案；
 * - 用户答完当前题 → 不 resolve 不丢 agent，缓存该题 answer 并立即渲染下一题；
 * - 逐题推进，最后一道答完 → 一次性 resolve({ answers: [题1…题N] }) 交回 agent；
 * - 全程 agent 只等待一次；abort signal 任一节点生效 → 清理 pending + reject。
 */
export class NapCatQuestionProvider {
  private pendingByPeer = new Map<string, PendingSerialQuestion>();

  constructor(private readonly options?: QuestionProviderOptions) {}

  async ask(request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer> {
    if (request.signal?.aborted) {
      throw new Error('AskUserQuestion was aborted before the user answered');
    }

    let peer: string | null = null;
    const sessionId = request.agent?.session?.id;

    if (sessionId) {
      if (this.options?.sessionManager) {
        peer = this.options.sessionManager.sessionIdToPeer(sessionId);
      } else if (sessionId.startsWith('qq-group-')) {
        peer = `group_${sessionId.slice(9)}`;
      } else if (sessionId.startsWith('qq-user-')) {
        peer = `user_${sessionId.slice(8)}`;
      } else {
        peer = sessionId;
      }
    }

    // 未绑定具体 QQ Peer 或无 Gateway 连接：不得自动作答替 agent 决策 (需求 §0.0 / AGENTS §3.1)
    if (!peer || !this.options?.gateway) {
      throw new Error(
        `[NapCatQuestionProvider] 无法向 QQ 下发提问: ${!peer ? '未解析到 QQ 会话(peer)' : 'NapCat 未连接 (gateway 不可用)'}，请确认提问发生在 QQ 会话中`
      );
    }

    if (request.questions.length === 0) {
      throw new Error('[NapCatQuestionProvider] 提问请求必须包含至少一道问题 (questions 不能为空)');
    }

    // 创建挂起 Promise：agent 全程只等待一次，串行多题在插件侧逐题推进（B4 不挂死）
    let resolveHolder!: (answer: AskUserQuestionAnswer) => void;
    let rejectHolder!: (err: Error) => void;
    const pendingPromise = new Promise<AskUserQuestionAnswer>((resolve, reject) => {
      resolveHolder = resolve;
      rejectHolder = reject;
    });

    const cleanup = () => {
      this.pendingByPeer.delete(peer!);
      if (request.signal) {
        request.signal.removeEventListener('abort', abortHandler);
      }
    };

    const abortHandler = () => {
      cleanup();
      rejectHolder(new Error('AskUserQuestion aborted by caller signal'));
    };

    if (request.signal) {
      request.signal.addEventListener('abort', abortHandler, { once: true });
    }

    const pending: PendingSerialQuestion = {
      request,
      peer: peer!,
      isGroup: peer!.startsWith('group_'),
      cardMessageId: null,
      answers: [],
      index: 0,
      resolve: (answer) => {
        cleanup();
        resolveHolder(answer);
      },
      reject: (err) => {
        cleanup();
        rejectHolder(err);
      },
    };

    // 先入 pending 表再下发第一题卡片：快速回复不错失
    this.pendingByPeer.set(pending.peer, pending);

    try {
      await this.sendCurrentCard(pending);
    } catch (err: any) {
      // 发送失败必须 reject，避免 Promise 永久 pending 卡死 agent (B4)
      pending.reject(
        new Error(`[NapCatQuestionProvider] 发送提问消息到 ${pending.peer} 失败: ${err?.message || String(err)}`)
      );
    }

    return pendingPromise;
  }

  /**
   * 下发当前题的卡片（每次只发一道题），并缓存该卡片的 QQ message_id（群聊引用锚定用）。
   * 群聊必须拿到 message_id 才能建立引用锚定，拿不到即视为下发失败（宁可 reject 不静默挂起）。
   */
  private async sendCurrentCard(pending: PendingSerialQuestion): Promise<void> {
    const q = pending.request.questions[pending.index];
    const card = NapCatQuestionProvider.formatQuestionCard(q, pending.isGroup);
    const gateway = this.options!.gateway!;
    const sender = this.options?.sender;
    const sendTask = () => gateway.sendMsg(pending.peer, card);
    const resp = sender
      ? await sender.enqueue(pending.peer, sendTask)
      : await sendTask();

    const messageId = (resp as any)?.data?.message_id ?? null;
    if (pending.isGroup && (messageId === null || messageId === undefined || messageId === '')) {
      throw new Error('NapCat 未返回群消息 message_id，群聊引用锚定无法建立');
    }
    pending.cardMessageId = messageId;
  }

  /**
   * 卡片分场景展示（2 档，恒带自定义）：
   * - 私聊：... + 末尾恒拼「自定义回答」标记项 + 「请直接回复数字序号选择对应选项，或输入你的答案」
   * - 群聊：同上，操作提示改为「请引用本消息并回复数字序号选择对应选项，或输入你的答案」
   * 「自定义回答」标记项参与展示但不参与数字匹配（用户输非数字文本才走自定义）。
   */
  static formatQuestionCard(q: AskUserQuestionItem, isGroup: boolean): string {
    const lines: string[] = ['【请回答问题】'];
    const promptText = (q as any).prompt || q.question || q.id;
    if (promptText) lines.push(promptText);
    if (q.detail) lines.push(q.detail);
    if (q.options && q.options.length > 0) {
      lines.push('选项:');
      q.options.forEach((opt, idx) => {
        const desc = opt.description ? ` (${opt.description})` : '';
        lines.push(`${idx + 1}. ${opt.label}${desc}`);
      });
    }
    lines.push('自定义回答');
    lines.push(
      isGroup
        ? '请引用本消息并回复数字序号选择对应选项，或输入你的答案'
        : '请直接回复数字序号选择对应选项，或输入你的答案'
    );
    return lines.join('\n');
  }

  /**
   * 回复解析（用户拍板：越界数字不判定、不提示重答，直接当自定义——自定义恒在场）：
   * - 单选：文本命中选项序号（N∈[1,选项数]，纯数字串）→ selected=[label_N]；否则整体当 custom。
   * - 多选（multiSelect）：英文逗号分隔；数字段在区间内 → 各进 selected；非数字/越界段 → 拼接为 custom。
   * - 纯自定义输入框（无 options）：恒走 custom。
   */
  static parseAnswerForQuestion(q: AskUserQuestionItem, rawText: string): AskUserQuestionAnswer['answers'][number] {
    const trimmed = rawText.trim();
    const options = q.options || [];

    if (q.multiSelect) {
      const selected: string[] = [];
      const customParts: string[] = [];
      for (const part of trimmed.split(',')) {
        const seg = part.trim();
        if (!seg) continue;
        if (/^\d+$/.test(seg)) {
          const num = Number(seg);
          if (num >= 1 && num <= options.length) {
            selected.push(options[num - 1].label);
            continue;
          }
        }
        // 非数字 / 越界段 → 拼接为 custom（越界数字不判定）
        customParts.push(seg);
      }
      const answer: AskUserQuestionAnswer['answers'][number] = { id: q.id, selected };
      if (customParts.length > 0) answer.custom = customParts.join(',');
      return answer;
    }

    // 单选：纯数字串且命中选项区间 → selected；否则整体当 custom
    if (/^\d+$/.test(trimmed)) {
      const num = Number(trimmed);
      if (num >= 1 && num <= options.length) {
        return { id: q.id, selected: [options[num - 1].label] };
      }
    }
    return { id: q.id, selected: [], custom: trimmed };
  }

  /**
   * 处理 QQ 端用户的回复。命中当前 pending 提问则推进/收尾串行问答并返回 true；
   * 未命中（无 pending / 群聊未引用当前卡片）返回 false —— 调用方按普通消息继续流转
   * （可进唤醒/队列），绝不误吞普通消息。
   */
  handleInboundReply(
    peer: string,
    text: string,
    options?: { replyId?: number | string | null }
  ): boolean {
    const pending = this.pendingByPeer.get(peer);
    if (!pending) {
      return false;
    }

    // 群聊引用锚定（用户选 A 方案）：只有「引用当前题卡片那条消息」的回复才 resolve 当前题；
    // 未引用 / 引用其他消息 → 当普通消息返回 false（可进唤醒/队列），每题各自锚定自己的卡片
    if (pending.isGroup) {
      const replyId = options?.replyId;
      if (replyId === undefined || replyId === null || replyId === '') {
        return false;
      }
      if (pending.cardMessageId === null || String(pending.cardMessageId) !== String(replyId)) {
        return false;
      }
    }

    const q = pending.request.questions[pending.index];
    const answer = NapCatQuestionProvider.parseAnswerForQuestion(q, text);
    pending.answers.push(answer);

    if (pending.index === pending.request.questions.length - 1) {
      // 最后一道答完 → 一次性 resolve 全部答案交回 agent（agent 感知不到多题拆分）
      pending.resolve({ answers: pending.answers });
      return true;
    }

    // 串行推进下一题：不 resolve 不丢 agent，只换发下一张卡片
    pending.index += 1;
    pending.cardMessageId = null;

    void this.sendCurrentCard(pending).catch((err: any) => {
      // 中间某一题下发失败 → reject 整个串行，绝不永久 pending 卡死 agent (B4)
      pending.reject(
        new Error(`[NapCatQuestionProvider] 发送提问消息到 ${pending.peer} 失败: ${err?.message || String(err)}`)
      );
    });

    return true;
  }
}

/**
 * 接入 DSH 0.1.2-rc.1 官方 user-questions/request waterfall 提问渠道：
 * - 多 Answerer 官方原生级联支持；
 * - 若为 QQ 会话，由 NapCatQuestionProvider 处理并返回；
 * - 非 QQ 会话，调用 next() 委托给宿主 Web UI 或后续 provider，实现零冲突平滑共存。
 */
export interface RegisterQuestionChannelOptions {
  /** QQ 渠道提问 Provider */
  questionProvider: NapCatQuestionProvider;
  /** 判断 session id 是否属于 QQ 会话（缺省按 qq- 前缀） */
  isQQSession?: (sessionId: string) => boolean;
  logger?: QuestionProviderOptions['logger'];
}

export function registerNapCatQuestionChannel(
  ctx: {
    on(event: string, handler: (...args: any[]) => void): any;
  },
  options: RegisterQuestionChannelOptions
): () => void {
  const isQQSession =
    options.isQQSession || ((sessionId: string) => sessionId.startsWith('qq-'));
  const { questionProvider } = options;

  const off = (ctx as any).on('user-questions/request', async (req: any, next: any) => {
    const sessionId =
      req.agent?.session?.id || req.agent?.id || (req.agent as any)?.sessionId || '';
    if (sessionId && isQQSession(sessionId)) {
      return await questionProvider.ask(req);
    }
    return next ? next() : Promise.reject(new Error('no user-questions answerer accepted the request'));
  });

  options.logger?.info?.('[RegisterQuestionChannel] 已接入官方 user-questions/request waterfall 提问渠道');

  return () => {
    try {
      off?.();
    } catch {}
  };
}

export interface ApprovalRequestPayload {
  peer: string;
  toolName: string;
  reason?: string;
  signal?: AbortSignal;
}

export interface ApprovalResponderOptions {
  gateway?: NapCatGatewayServer;
  sessionManager?: SessionManager;
  /** 共享 per-peer 串行发送器 (Spec §7.3)：审批与正文/提问同队列，保证同 peer 内发送顺序 */
  sender?: SerialSender;
  logger?: {
    info?: (...args: any[]) => void;
    warn?: (...args: any[]) => void;
    error?: (...args: any[]) => void;
    debug?: (...args: any[]) => void;
  };
}

interface PendingApproval {
  req: ApprovalRequestPayload;
  resolve: (decision: 'allowed-once' | 'rejected') => void;
  reject: (err: Error) => void;
}

/**
 * 接入 Cordis approval/request waterfall 的 NapCat 审批响应器
 */
export class NapCatApprovalResponder {
  private pendingByPeer = new Map<string, PendingApproval>();

  constructor(private readonly options?: ApprovalResponderOptions) {}

  async handleApprovalRequest(req: ApprovalRequestPayload): Promise<'allowed-once' | 'rejected'> {
    if (req.signal?.aborted) {
      return 'rejected';
    }

    // 无 peer 或无 Gateway：直接拒绝，绝不替用户放行，也不挂起等待 (需求 §0.0)
    if (!req.peer || !this.options?.gateway) {
      this.options?.logger?.warn?.(
        `[NapCatApprovalResponder] ${!req.peer ? '缺少目标 peer' : '无 NapCat 连接'}，审批请求 ${req.toolName} 已拒绝`
      );
      return 'rejected';
    }

    {
      const msg = [
        '【审批请求】',
        `Agent 请求执行工具: ${req.toolName}`,
        `原因: ${req.reason || '无'}`,
        '请回复 y (同意) 或 n (拒绝)',
      ].join('\n');

      try {
        const sendTask = () => this.options!.gateway!.sendMsg(req.peer, msg);
        if (this.options.sender) {
          await this.options.sender.enqueue(req.peer, sendTask);
        } else {
          await sendTask();
        }
      } catch (err: any) {
        // 发送失败直接拒绝（不无限挂起等待），并允许后续走其他审批渠道
        this.options?.logger?.error?.(
          `[NapCatApprovalResponder] 下发审批请求到 ${req.peer} 失败:`,
          err
        );
        return 'rejected';
      }
    }

    return new Promise<'allowed-once' | 'rejected'>((resolve, reject) => {
      const cleanup = () => {
        this.pendingByPeer.delete(req.peer);
      };

      if (req.signal) {
        req.signal.addEventListener(
          'abort',
          () => {
            cleanup();
            resolve('rejected');
          },
          { once: true }
        );
      }

      this.pendingByPeer.set(req.peer, {
        req,
        resolve: (decision) => {
          cleanup();
          resolve(decision);
        },
        reject: (err) => {
          cleanup();
          reject(err);
        },
      });
    });
  }

  /**
   * 处理 QQ 端用户的审批决策 (y/n)
   */
  handleInboundReply(peer: string, text: string): boolean {
    if (!this.pendingByPeer.has(peer)) {
      return false;
    }

    const pending = this.pendingByPeer.get(peer)!;
    const trimmed = text.trim().toLowerCase();

    if (trimmed === 'y' || trimmed === 'yes' || trimmed === '同意' || trimmed === '允许') {
      pending.resolve('allowed-once');
      return true;
    }

    if (trimmed === 'n' || trimmed === 'no' || trimmed === '拒绝' || trimmed === '不同意') {
      pending.resolve('rejected');
      return true;
    }

    return false;
  }
}

