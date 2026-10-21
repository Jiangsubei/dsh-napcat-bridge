/**
 * dsh-napcat-bridge: Session 领域公共类型与异常定义
 */

/**
 * 结构化 RemoteError 类（对齐 DSH typert-protocol 远程调用失败契约）
 */
export class RemoteError extends Error {
  readonly code: string;
  readonly details: any;
  readonly isDSHRemoteError = true;

  constructor(code: string, message: string, details: any = {}, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
    this.details = details;
    this.name = 'RemoteError';
    Object.setPrototypeOf(this, RemoteError.prototype);
  }
}

/**
 * DSH 0.2.x 文件级排他锁 (session.lock) 冲突异常
 */
export class SessionAlreadyOwnedError extends Error {
  readonly sessionId: string;

  constructor(sessionId: string, message?: string) {
    super(
      message ||
        `会话 ${sessionId} 当前正被其他控制台或任务占用（排他锁冲突），请稍后重试或在 Web 端切换其他会话以释放锁。`
    );
    this.name = 'SessionAlreadyOwnedError';
    this.sessionId = sessionId;
    Object.setPrototypeOf(this, SessionAlreadyOwnedError.prototype);
  }
}

export interface ParsedSessionId {
  peer: string;
  id: string;
  round: number;
  version: number;
  hash?: string;
  isGroup: boolean;
}

export interface OutboundBridgeLike {
  trackInboundContext(peer: string, context: any): void;
  trackPendingMessage?(messageId: string, peer: string, context: any): void;
}

export interface SessionManagerOptions {
  retryDelays?: number[];
}
