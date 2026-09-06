/**
 * dsh-napcat-bridge: NapCat WebSocket 网关服务端
 * 作为 OneBot 11 反向 WebSocket 服务端，处理 NapCat 客户端连接、Token 鉴权、事件分发与 API Action 调用。
 */

import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import type {
  OneBotActionResponse,
  OneBotMessageEvent,
  OneBotMetaEvent,
  OneBotNoticeEvent,
} from '../types/index.js';

export interface GatewayServerOptions {
  port: number;
  token?: string;
  logger?: {
    info?: (...args: any[]) => void;
    warn?: (...args: any[]) => void;
    error?: (...args: any[]) => void;
    debug?: (...args: any[]) => void;
  };
}

export type MessageHandler = (event: OneBotMessageEvent) => void | Promise<void>;
export type NoticeHandler = (event: OneBotNoticeEvent) => void | Promise<void>;
export type MetaHandler = (event: OneBotMetaEvent) => void | Promise<void>;

interface PendingAction {
  resolve: (res: OneBotActionResponse) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export class NapCatGatewayServer {
  private wss: WebSocketServer | null = null;
  private activeSocket: WebSocket | null = null;
  private echoCounter = 0;
  private pendingActions = new Map<string, PendingAction>();

  private messageHandlers: MessageHandler[] = [];
  private noticeHandlers: NoticeHandler[] = [];
  private metaHandlers: MetaHandler[] = [];

  constructor(public readonly options: GatewayServerOptions) {}

  onMessage(handler: MessageHandler): () => void {
    this.messageHandlers.push(handler);
    return () => {
      this.messageHandlers = this.messageHandlers.filter((h) => h !== handler);
    };
  }

  onNotice(handler: NoticeHandler): () => void {
    this.noticeHandlers.push(handler);
    return () => {
      this.noticeHandlers = this.noticeHandlers.filter((h) => h !== handler);
    };
  }

  onMeta(handler: MetaHandler): () => void {
    this.metaHandlers.push(handler);
    return () => {
      this.metaHandlers = this.metaHandlers.filter((h) => h !== handler);
    };
  }

  private authenticate(req: IncomingMessage): boolean {
    const expectedToken = (this.options.token || '').trim();
    if (!expectedToken) return true; // 未配置 Token 则放行

    let token = '';
    const authHeader = req.headers['authorization'];
    if (typeof authHeader === 'string') {
      if (authHeader.startsWith('Bearer ')) {
        token = authHeader.slice(7).trim();
      } else if (authHeader.startsWith('Token ')) {
        token = authHeader.slice(6).trim();
      } else {
        token = authHeader.trim();
      }
    } else if (typeof req.headers['access_token'] === 'string') {
      token = req.headers['access_token'].trim();
    }

    if (!token) {
      try {
        const url = new URL(req.url || '/', 'http://localhost');
        token = url.searchParams.get('access_token') || '';
      } catch {}
    }

    return token === expectedToken;
  }

  async start(): Promise<void> {
    if (this.wss) return;

    return new Promise<void>((resolve, reject) => {
      try {
        this.wss = new WebSocketServer({
          port: this.options.port,
          verifyClient: (info, callback) => {
            const authenticated = this.authenticate(info.req);
            if (!authenticated) {
              this.options.logger?.warn?.(`[GatewayServer] 鉴权失败: 来源 ${info.req.socket.remoteAddress}`);
              callback(false, 401, 'Unauthorized');
            } else {
              callback(true);
            }
          },
        });

        this.wss.on('listening', () => {
          this.options.logger?.info?.(`[GatewayServer] OneBot 11 反向 WS 服务端已监听端口 ${this.options.port}`);
          resolve();
        });

        this.wss.on('error', (err) => {
          this.options.logger?.error?.('[GatewayServer] WebSocket 服务端错误:', err);
          reject(err);
        });

        this.wss.on('connection', (ws, req) => {
          this.options.logger?.info?.(`[GatewayServer] NapCat 客户端已连接 (${req.socket.remoteAddress})`);
          this.activeSocket = ws;

          ws.on('message', (data) => {
            this.handleIncomingRaw(data.toString());
          });

          ws.on('close', (code, reason) => {
            this.options.logger?.warn?.(`[GatewayServer] NapCat 连接断开 (code: ${code}, reason: ${reason.toString()})`);
            if (this.activeSocket === ws) {
              this.activeSocket = null;
            }
          });

          ws.on('error', (err) => {
            this.options.logger?.error?.('[GatewayServer] 客户端 Socket 异常:', err);
          });
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  private handleIncomingRaw(rawText: string): void {
    let parsed: any;
    try {
      parsed = JSON.parse(rawText);
    } catch (err) {
      this.options.logger?.warn?.('[GatewayServer] 无法解析 JSON 载荷:', rawText);
      return;
    }

    // 1. 如果带有 echo，则是 Action 调用的响应
    if (parsed.echo && this.pendingActions.has(parsed.echo)) {
      const pending = this.pendingActions.get(parsed.echo)!;
      this.pendingActions.delete(parsed.echo);
      clearTimeout(pending.timer);
      pending.resolve(parsed as OneBotActionResponse);
      return;
    }

    // 2. 根据 post_type 分发事件
    const postType = parsed.post_type;
    if (postType === 'message' || postType === 'message_sent') {
      const msgEvent = parsed as OneBotMessageEvent;
      for (const h of this.messageHandlers) {
        try {
          h(msgEvent);
        } catch (e) {
          this.options.logger?.error?.('[GatewayServer] 消息处理器异常:', e);
        }
      }
    } else if (postType === 'notice') {
      const noticeEvent = parsed as OneBotNoticeEvent;
      for (const h of this.noticeHandlers) {
        try {
          h(noticeEvent);
        } catch (e) {
          this.options.logger?.error?.('[GatewayServer] 通知处理器异常:', e);
        }
      }
    } else if (postType === 'meta_event') {
      const metaEvent = parsed as OneBotMetaEvent;
      for (const h of this.metaHandlers) {
        try {
          h(metaEvent);
        } catch (e) {
          this.options.logger?.error?.('[GatewayServer] 元事件处理器异常:', e);
        }
      }
    }
  }

  async sendAction<T = any>(
    action: string,
    params: Record<string, any> = {},
    timeoutMs = 15000
  ): Promise<OneBotActionResponse<T>> {
    if (!this.activeSocket || this.activeSocket.readyState !== WebSocket.OPEN) {
      throw new Error(`NapCat WebSocket 客户端未连接或连接已断开 (action: ${action})`);
    }

    const echo = `echo_${Date.now()}_${++this.echoCounter}`;
    const payload = JSON.stringify({
      action,
      params,
      echo,
    });

    return new Promise<OneBotActionResponse<T>>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pendingActions.has(echo)) {
          this.pendingActions.delete(echo);
          reject(new Error(`NapCat Action 调用超时 (${timeoutMs}ms, action: ${action})`));
        }
      }, timeoutMs);

      this.pendingActions.set(echo, {
        resolve: resolve as any,
        reject,
        timer,
      });

      this.activeSocket!.send(payload, (err) => {
        if (err) {
          this.pendingActions.delete(echo);
          clearTimeout(timer);
          reject(err);
        }
      });
    });
  }

  async sendGroupMsg(groupId: number | string, message: any): Promise<OneBotActionResponse> {
    return this.sendAction('send_group_msg', {
      group_id: Number(groupId),
      message,
    });
  }

  async sendPrivateMsg(userId: number | string, message: any): Promise<OneBotActionResponse> {
    return this.sendAction('send_private_msg', {
      user_id: Number(userId),
      message,
    });
  }

  async sendMsg(peer: string, message: any): Promise<OneBotActionResponse> {
    if (peer.startsWith('group_')) {
      const groupId = peer.slice(6).split('-')[0];
      return this.sendGroupMsg(groupId, message);
    }
    if (peer.startsWith('user_')) {
      const userId = peer.slice(5).split('-')[0];
      return this.sendPrivateMsg(userId, message);
    }
    if (peer.startsWith('qq-group-')) {
      const groupId = peer.slice(9).split('-')[0];
      return this.sendGroupMsg(groupId, message);
    }
    if (peer.startsWith('qq-user-')) {
      const userId = peer.slice(8).split('-')[0];
      return this.sendPrivateMsg(userId, message);
    }
    throw new Error(`未知的 peer 格式: ${peer}`);
  }

  /**
   * OneBot 11 get_msg: 根据 message_id 获取单条消息详情
   */
  async getMsg(messageId: number | string): Promise<OneBotActionResponse> {
    return this.sendAction('get_msg', {
      message_id: Number(messageId),
    });
  }

  async getForwardMsg(forwardId: string): Promise<OneBotActionResponse> {
    return this.sendAction('get_forward_msg', {
      id: forwardId,
      message_id: forwardId,
    });
  }

  async getGroupFileUrl(groupId: number | string, fileId: string, busid?: number): Promise<OneBotActionResponse> {
    return this.sendAction('get_group_file_url', {
      group_id: Number(groupId),
      file_id: fileId,
      busid: busid ?? 0,
    });
  }

  /**
   * PF-001: OneBot 11 get_private_file_url —— 获取私聊文件下载直链。
   * NapCat 源码实证 (GetPrivateFileUrl.ts): PayloadSchema 仅 {file_id}，返回 data.url (HTTP 直链)；
   * 依赖 packet 后端 (GetPacketStatusDepends)，QQ 9.9.30-48762 起 packet 不可用会失败 ——
   * 作为私聊文件入站落盘「首选」，失败由 downloadPrivateFile 回退 get_file（任务包 §3.1 用户拍板）。
   */
  async getPrivateFileUrl(fileId: string): Promise<OneBotActionResponse> {
    return this.sendAction('get_private_file_url', {
      file_id: fileId,
    });
  }

  /**
   * PF-001: OneBot 11 get_file —— 获取文件的 NapCat 侧本地路径（不依赖 packet 后端）。
   * NapCat 源码实证 (GetFile.ts): GetFilePayloadSchema {file?, file_id?}（私聊消息标记以 file_id 传入），
   * 返回 data.{file, url, file_size, file_name}，data.file 为 NapCat 本机本地路径 ——
   * 作为私聊文件入站落盘「回退」路径（packet 不可用时仍可靠，任务包 §3.1）。
   */
  async getFile(fileId: string): Promise<OneBotActionResponse> {
    return this.sendAction('get_file', {
      file_id: fileId,
    });
  }

  /**
   * OneBot 11 get_group_member_info (EN-001)：获取群成员信息（含 nickname/card），
   * 用于 at 段被@者昵称归一化（NapCat at 段只有 qq）。
   */
  async getGroupMemberInfo(
    groupId: number | string,
    userId: number | string
  ): Promise<OneBotActionResponse> {
    return this.sendAction('get_group_member_info', {
      group_id: Number(groupId),
      user_id: Number(userId),
    });
  }

  /**
   * OneBot 11 get_group_info: 获取群基础信息（群名称等）
   */
  async getGroupInfo(groupId: number | string): Promise<OneBotActionResponse> {
    return this.sendAction('get_group_info', {
      group_id: Number(groupId),
    });
  }

  /**
   * OneBot 11 get_stranger_info: 获取陌生人/好友信息（昵称等）
   */
  async getStrangerInfo(userId: number | string): Promise<OneBotActionResponse> {
    return this.sendAction('get_stranger_info', {
      user_id: Number(userId),
    });
  }

  /**
   * IS-S3 (v2 预留)：上传文件到群文件系统 (upload_group_file)。
   * v1 决策走消息附件（send_group_msg 带 file 段，Spec §6.2），本方法为 v2「上传到群文件
   * 系统」预留接入点（NapCat 支持该 action），文档标注 v2 预留，当前未被 send_file 调用。
   */
  async uploadGroupFile(
    groupId: number | string,
    file: string,
    name?: string,
    folder?: string
  ): Promise<OneBotActionResponse> {
    const params: Record<string, any> = {
      group_id: Number(groupId),
      file,
    };
    if (name !== undefined) params.name = name;
    if (folder !== undefined) params.folder = folder;
    return this.sendAction('upload_group_file', params);
  }

  /**
   * IS-S3 (v2 预留)：上传文件到私聊会话 (upload_private_file)。
   * v1 走消息附件；本方法为 v2 预留接入点，当前未被 send_file 调用。
   */
  async uploadPrivateFile(
    userId: number | string,
    file: string,
    name?: string
  ): Promise<OneBotActionResponse> {
    const params: Record<string, any> = {
      user_id: Number(userId),
      file,
    };
    if (name !== undefined) params.name = name;
    return this.sendAction('upload_private_file', params);
  }

  async sendPoke(userId: string | number, groupId?: string | number): Promise<OneBotActionResponse> {
    const numUserId = Number(userId);
    const numGroupId = groupId ? Number(groupId) : undefined;

    // 优先调用 NapCat 推荐的统一通用接口 send_poke
    try {
      const params: Record<string, any> = { user_id: numUserId };
      if (numGroupId) {
        params.group_id = numGroupId;
      }
      const res = await this.sendAction('send_poke', params);
      if (res && res.status === 'ok' && res.retcode === 0) {
        return res;
      }

      // 如果 send_poke 失败或未识别，尝试回退特定场景接口
      if (numGroupId) {
        const fallbackRes = await this.sendAction('group_poke', {
          group_id: numGroupId,
          user_id: numUserId,
        });
        if (fallbackRes && (fallbackRes.status === 'ok' || fallbackRes.retcode === 0)) {
          return fallbackRes;
        }
      } else {
        const fallbackRes = await this.sendAction('friend_poke', {
          user_id: numUserId,
        });
        if (fallbackRes && (fallbackRes.status === 'ok' || fallbackRes.retcode === 0)) {
          return fallbackRes;
        }
      }

      return res;
    } catch (err) {
      if (numGroupId) {
        return this.sendAction('group_poke', {
          group_id: numGroupId,
          user_id: numUserId,
        });
      }
      return this.sendAction('friend_poke', {
        user_id: numUserId,
      });
    }
  }

  /**
   * OneBot 11 扩展 set_msg_emoji_like: 为消息贴表情回应
   */
  async setMsgEmojiLike(
    messageId: number | string,
    emojiId: string | number,
    set = true
  ): Promise<OneBotActionResponse> {
    return this.sendAction('set_msg_emoji_like', {
      message_id: Number(messageId),
      emoji_id: String(emojiId),
      set,
    });
  }

  async restart(options?: Partial<GatewayServerOptions>): Promise<void> {
    await this.stop();
    if (options) {
      if (options.port !== undefined) {
        this.options.port = options.port;
      }
      if (options.token !== undefined) {
        this.options.token = options.token;
      }
    }
    await this.start();
  }

  async stop(): Promise<void> {
    for (const pending of this.pendingActions.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('GatewayServer is closing'));
    }
    this.pendingActions.clear();

    if (this.activeSocket) {
      try {
        this.activeSocket.terminate();
      } catch {}
      this.activeSocket = null;
    }

    if (this.wss) {
      try {
        for (const client of this.wss.clients) {
          try {
            client.terminate();
          } catch {}
        }
      } catch {}

      await new Promise<void>((resolve) => {
        this.wss!.close(() => resolve());
      });
      this.wss = null;
    }
  }
}

/**
 * EN-005: 等待收集的一条入站消息（字段与唤醒包同源：from 昵称 / user_id QQ /
 * content 归一化文本 / time 毫秒时间戳）
 */
export interface WaitCollectedMessage {
  from: string;
  user_id: string;
  content: string;
  time: number;
}

/**
 * EN-005: 等待结算结果。
 * - ok:true     → 窗口结束返回已收集消息（纯超时窗口，用户拍板）
 * - timeout     → 状态层报错（0 条消息，不给建议，Agent 自己推理下一步）
 * - cancelled   → Agent 回合取消 / 插件 dispose
 * - wait-active → 同 peer 已有活动等待（防御性拒绝）
 */
export type MessageWaitResult =
  | { ok: true; messages: WaitCollectedMessage[] }
  | { ok: false; error: 'timeout' | 'cancelled' | 'wait-active'; message: string };

interface ActiveWait {
  peer: string;
  userId?: string;
  messages: WaitCollectedMessage[];
  timer: NodeJS.Timeout;
  settle: (result: MessageWaitResult) => void;
}

/**
 * EN-005: 入站消息等待收集器（一次性消息收集器桥接）。
 * peer 键控（group_* 与 user_*，与 normalizePeer / index.ts 流水线同一键空间）；
 * 纯超时窗口语义：注册起算 timeoutMs 毫秒，到点返回已收集消息，0 条则状态层超时
 * 报错。可通过 AbortSignal 取消（Agent 回合中断）。单线程事件循环内注册/投递/结算
 * 同步串行，无撕裂窗口。
 */
export class MessageWaitRegistry {
  private waits = new Map<string, ActiveWait>();

  /**
   * 注册一次性消息收集器并挂起等待。
   * 同 peer 已有活动等待 → wait-active 拒绝（防御：同会话工具串行调用下理论不可达）；
   * 传入已中止的 signal → 立即 cancelled。
   */
  wait(peer: string, opts: { userId?: string; timeoutMs: number; signal?: AbortSignal }): Promise<MessageWaitResult> {
    if (this.waits.has(peer)) {
      return Promise.resolve({
        ok: false,
        error: 'wait-active',
        message: '当前会话已有一个进行中的消息等待，不能重复发起',
      });
    }
    if (opts.signal?.aborted) {
      return Promise.resolve({
        ok: false,
        error: 'cancelled',
        message: '等待已中断（Agent 回合被取消）',
      });
    }

    return new Promise<MessageWaitResult>((resolve) => {
      let settled = false;
      const messages: WaitCollectedMessage[] = [];
      let onAbort: () => void;

      const cleanup = () => {
        clearTimeout(entry.timer);
        if (opts.signal) {
          opts.signal.removeEventListener('abort', onAbort);
        }
        if (this.waits.get(peer) === entry) {
          this.waits.delete(peer);
        }
      };

      const settle = (result: MessageWaitResult) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      };

      onAbort = () => {
        settle({ ok: false, error: 'cancelled', message: '等待已中断（Agent 回合被取消）' });
      };

      const entry: ActiveWait = {
        peer,
        userId: opts.userId,
        messages,
        timer: setTimeout(() => {
          if (messages.length === 0) {
            settle({ ok: false, error: 'timeout', message: 'No messages received within the specified timeout' });
          } else {
            settle({ ok: true, messages });
          }
        }, Math.max(0, opts.timeoutMs)),
        settle,
      };

      if (opts.signal) {
        opts.signal.addEventListener('abort', onAbort, { once: true });
      }
      this.waits.set(peer, entry);
    });
  }

  /** 判活（index.ts 等待门控用，同步、O(1)） */
  isWaiting(peer: string): boolean {
    return this.waits.has(peer);
  }

  /** 尝试投递入站消息；命中（peer + user_id 过滤）并收集 → true，否则 false（不改状态） */
  tryDeliver(peer: string, msg: WaitCollectedMessage): boolean {
    const entry = this.waits.get(peer);
    if (!entry) return false;
    if (entry.userId !== undefined && String(entry.userId) !== String(msg.user_id)) return false;
    entry.messages.push(msg);
    return true;
  }

  /** 插件 dispose：结算全部活动等待为 cancelled（清空收集器，防悬挂 Promise） */
  clear(): void {
    for (const entry of this.waits.values()) {
      entry.settle({ ok: false, error: 'cancelled', message: '等待已中断（Agent 回合被取消）' });
    }
  }
}
