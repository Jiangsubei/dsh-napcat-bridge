/**
 * dsh-napcat-bridge: 敏感工具管理员白名单二元审批模块
 * 接入 Cordis approval/request waterfall。
 * 负责管理员鉴权、超时Fail-Closed、顶替收敛与 y/n 回复处理。
 */

import type { NapCatGatewayServer } from '../gateway/server.js';
import type { SessionManager } from '../gateway/session.js';
import type { SerialSender } from '../types/index.js';

export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable';

export interface ApprovalRequestPayload {
  peer: string;
  toolName: string;
  callId?: string;
  reason?: string;
  /** 本轮唤醒者 QQ 号（群聊必填；私聊以 peer 中的 QQ 为准） */
  applicantId?: string;
  signal?: AbortSignal;
}

export interface ApprovalResponderOptions {
  gateway?: NapCatGatewayServer;
  sessionManager?: SessionManager;
  /** 共享 per-peer 串行发送器 (Spec §7.3)：审批与正文/提问同队列，保证同 peer 内发送顺序 */
  sender?: SerialSender;
  /** 审批超时时间 (ms)，默认 300_000ms (5 分钟) */
  timeoutMs?: number;
  /** 管理员 QQ 白名单列表（群聊放行鉴权） */
  admins?: string[];
  logger?: {
    info?: (...args: any[]) => void;
    warn?: (...args: any[]) => void;
    error?: (...args: any[]) => void;
    debug?: (...args: any[]) => void;
  };
}

interface PendingApproval {
  req: ApprovalRequestPayload;
  timer: NodeJS.Timeout | null;
  onAbort: (() => void) | null;
  resolve: (decision: ApprovalOutcome) => void;
  reject: (err: Error) => void;
}

/**
 * 接入 Cordis approval/request waterfall 的 NapCat 审批响应器
 */
export class NapCatApprovalResponder {
  private pendingByPeer = new Map<string, PendingApproval>();

  constructor(private readonly options?: ApprovalResponderOptions) {}

  async handleApprovalRequest(req: ApprovalRequestPayload): Promise<ApprovalOutcome> {
    if (req.signal?.aborted) {
      return 'cancelled';
    }

    // 无 peer 或无 Gateway：直接拒绝，绝不替用户放行，也不挂起等待 (需求 §0.0)
    if (!req.peer || !this.options?.gateway) {
      this.options?.logger?.warn?.(
        `[NapCatApprovalResponder] ${!req.peer ? '缺少目标 peer' : '无 NapCat 连接'}，审批请求 ${req.toolName} 已拒绝`
      );
      return 'rejected';
    }

    // 管理员门控（用户拍板）：只有管理员发起的审批才下发弹窗。
    // 未配置 admins / 无法解析申请人 / 申请人不在白名单 → 直接拒绝，绝不下发任何审批消息。
    const admins = (this.options?.admins || []).map((a) => String(a).trim()).filter(Boolean);
    if (admins.length === 0) {
      this.options?.logger?.warn?.(
        `[NapCatApprovalResponder] 未配置 admins 管理员白名单，审批请求 ${req.toolName} 已直接拒绝 (Fail-Closed)`
      );
      return 'rejected';
    }
    const applicantId = this.resolveApplicantId(req);
    if (!applicantId) {
      this.options?.logger?.warn?.(
        `[NapCatApprovalResponder] 无法解析审批申请人身份 (peer: ${req.peer})，审批请求 ${req.toolName} 已直接拒绝 (Fail-Closed)`
      );
      return 'rejected';
    }
    if (!admins.includes(applicantId)) {
      this.options?.logger?.warn?.(
        `[NapCatApprovalResponder] 非管理员 ${applicantId} 发起审批请求 ${req.toolName}，已直接拒绝且不下发`
      );
      return 'rejected';
    }

    // 顶替机制 (A4)：同一 peer 发起新审批请求时，前序挂起请求被顶替收敛为 cancelled
    if (this.pendingByPeer.has(req.peer)) {
      const prev = this.pendingByPeer.get(req.peer)!;
      try {
        if (prev.timer) clearTimeout(prev.timer);
        if (prev.onAbort && prev.req.signal) {
          prev.req.signal.removeEventListener('abort', prev.onAbort);
        }
        prev.resolve('cancelled');
      } catch {}
      this.pendingByPeer.delete(req.peer);
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

    return new Promise<ApprovalOutcome>((resolve, reject) => {
      const timeoutMs = this.options?.timeoutMs ?? 300_000;
      let timer: NodeJS.Timeout | null = null;
      let onAbort: (() => void) | null = null;

      const cleanup = () => {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        if (onAbort && req.signal) {
          req.signal.removeEventListener('abort', onAbort);
          onAbort = null;
        }
        this.pendingByPeer.delete(req.peer);
      };

      if (req.signal) {
        onAbort = () => {
          cleanup();
          resolve('cancelled');
        };
        req.signal.addEventListener('abort', onAbort, { once: true });
      }

      if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
        timer = setTimeout(() => {
          this.options?.logger?.warn?.(
            `[NapCatApprovalResponder] 审批请求 ${req.toolName} 超时 (${timeoutMs}ms)，自动 fail-closed 拒绝`
          );
          cleanup();
          resolve('rejected');
        }, timeoutMs);
      }

      this.pendingByPeer.set(req.peer, {
        req,
        timer,
        onAbort,
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
   * 解析本次审批申请的发起人 QQ 号：
   * - 私聊 peer 形如 user_<QQ>，直接以 peer 为准（最可靠）；
   * - 群聊 peer 形如 group_<群号>，取最近一次真实唤醒的发起人 applicantId（由 index.ts 注入）；
   * - 系统触发（定时任务 / 主动冒泡 / 内部 Agent）不携带真实唤醒者，一律返回 null，
   *   由调用方按 Fail-Closed 直接拒绝。
   */
  private resolveApplicantId(req: ApprovalRequestPayload): string | null {
    const privateMatch = /^user_([0-9]+)$/.exec(req.peer.trim());
    if (privateMatch) {
      return privateMatch[1];
    }
    if (req.applicantId === undefined || req.applicantId === null) {
      return null;
    }
    const applicant = String(req.applicantId).trim();
    return applicant || null;
  }

  /**
   * 处理 QQ 端用户的审批决策 (y/n)
   */
  handleInboundReply(
    peer: string,
    text: string,
    options?: { userId?: string | number; replyId?: string | number }
  ): boolean {
    if (!this.pendingByPeer.has(peer)) {
      return false;
    }

    const pending = this.pendingByPeer.get(peer)!;
    const trimmed = text.trim().toLowerCase();

    const isApprove = trimmed === 'y' || trimmed === 'yes' || trimmed === '同意' || trimmed === '允许';
    const isReject = trimmed === 'n' || trimmed === 'no' || trimmed === '拒绝' || trimmed === '不同意';

    if (!isApprove && !isReject) {
      return false;
    }

    // 群聊鉴权 (B4/B11)：审批请求阶段已做管理员门控（申请人与可批者均在 admins 内），
    // 此处再兜底限制只有管理员（或发起人）可回复 y/n，防止群内其他成员冒充审批。
    // 注：未配置 admins 时请求阶段已一律拒绝，下方 else 分支仅为防御性兜底。
    if (peer.startsWith('group_') && options?.userId !== undefined) {
      const uid = String(options.userId).trim();
      const admins = (this.options?.admins || []).map((a) => String(a).trim()).filter(Boolean);
      const isApplicant = Boolean(pending.req.applicantId && String(pending.req.applicantId).trim() === uid);
      const isAdmin = admins.includes(uid);

      if (admins.length > 0) {
        if (!isAdmin && !isApplicant) {
          this.options?.logger?.warn?.(
            `[NapCatApprovalResponder] 群聊非授权用户 ${uid} 尝试审批决策，已被忽略`
          );
          return false;
        }
      } else {
        // 未配置管理员白名单时，群聊采取 Fail-Closed 策略：严禁任意群员冒充审批，仅允许申请人批准
        if (!isApplicant) {
          this.options?.logger?.warn?.(
            `[NapCatApprovalResponder] 群聊未配置 admins 白名单，非申请人 ${uid} 尝试审批决策已被拒绝 (Fail-Closed)`
          );
          return false;
        }
      }
    }

    if (isApprove) {
      pending.resolve('allowed-once');
      return true;
    }

    if (isReject) {
      pending.resolve('rejected');
      return true;
    }

    return false;
  }
}
