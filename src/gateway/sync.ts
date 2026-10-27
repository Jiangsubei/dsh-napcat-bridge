/**
 * dsh-napcat-bridge: 离线消息同步与去重引擎 (Offline Message Syncer)
 * 当插件连接或重连 NapCat 网关时，自动联网检测最近活跃会话并增量拉取插件离线期间的消息记录，
 * 幂等写入 SQLite 数据库以补全历史记录与记忆上下文，纯后台静默同步，绝不唤醒 Agent。
 */

import type { NapCatGatewayServer } from './server.js';
import type { MessageDatabase } from '../storage/database.js';
import type { MessageRecord } from '../types/index.js';
import { parseNormalizedContent } from './wakeup.js';

export interface OfflineSyncerOptions {
  gateway: NapCatGatewayServer;
  db: MessageDatabase;
  botQQ?: string;
  logger?: {
    info?: (...args: any[]) => void;
    warn?: (...args: any[]) => void;
    error?: (...args: any[]) => void;
    debug?: (...args: any[]) => void;
  };
  /** 探测最近联系人数量，默认 30 */
  recentCount?: number;
  /** 单个会话最大补全拉取条数，默认 100 */
  maxPerPeer?: number;
  /** 单次分页拉取条数，默认 30 */
  pageSize?: number;
}

export interface OfflineSyncResult {
  peersChecked: number;
  peersSynced: number;
  messagesInserted: number;
  errors: Array<{ peer: string; error: string }>;
}

/**
 * 将 OneBot 11 原始消息格式转换为规范化的 MessageRecord
 */
export function convertOneBotToRecord(
  event: any,
  botQQ?: string
): MessageRecord | null {
  if (!event || typeof event !== 'object') return null;

  const isGroup = event.message_type === 'group' || Boolean(event.group_id);
  const peer = isGroup ? `group_${event.group_id}` : `user_${event.user_id}`;
  const fromUser = String(event.user_id ?? '');
  const sender = event.sender || {};
  const senderName = sender.card || sender.nickname || fromUser;
  const isSelf =
    (botQQ && botQQ !== '' && fromUser === botQQ) ||
    event.post_type === 'message_sent' ||
    event.message_sent_type === 'self'
      ? 1
      : 0;

  // NapCat 的 time 字段为秒级时间戳，转为本地毫秒级
  const timestamp = event.time ? Number(event.time) * 1000 : Date.now();

  let dominantType = 'text';
  let fileId: string | null = null;
  let busid: number | null = null;
  let replyId: number | null = null;

  if (Array.isArray(event.message)) {
    for (const seg of event.message) {
      if (!seg || typeof seg !== 'object') continue;
      const type = seg.type;
      const data = seg.data || {};
      if (type === 'image') {
        const isSticker = data.sub_type === 1 || Boolean(data.emoji_package_id);
        dominantType = isSticker ? 'sticker' : 'image';
        fileId = data.file_id || data.file || null;
      } else if (type === 'file') {
        dominantType = isGroup ? 'group_file' : 'file';
        fileId = data.file_id || data.file || null;
        busid = data.busid !== undefined && data.busid !== null ? Number(data.busid) : null;
      } else if (type === 'forward') {
        dominantType = 'forward';
        fileId = data.id || data.forward_id || null;
      } else if (type === 'record') {
        dominantType = 'record';
      } else if (type === 'video') {
        dominantType = 'video';
      } else if (type === 'reply' && data.id !== undefined) {
        replyId = Number(data.id);
        if (dominantType === 'text') dominantType = 'reply';
      }
    }
  }

  const { content: rawContent, replyId: parsedReplyId } = parseNormalizedContent(event as any);
  if (parsedReplyId !== undefined && replyId === null) {
    replyId = parsedReplyId;
  }

  // 纯空过滤 (无正文、无文件、无富媒体)
  const hasContent = rawContent.trim().length > 0 || fileId !== null || (dominantType !== 'text' && dominantType !== 'reply');
  if (!hasContent) {
    return null;
  }

  return {
    msg_id: Number(event.message_id),
    peer,
    user_id: fromUser,
    sender_name: senderName,
    time: timestamp,
    type: dominantType,
    content: rawContent,
    raw: JSON.stringify(event.message || event.raw_message || {}),
    file_id: fileId,
    busid,
    local_path: null,
    fingerprint: null,
    recalled: 0,
    self: isSelf,
    reply_to: replyId ?? null,
  };
}

export class OfflineMessageSyncer {
  private isSyncing = false;
  private readonly gateway: NapCatGatewayServer;
  private readonly db: MessageDatabase;
  private readonly botQQ: string;
  private readonly logger: OfflineSyncerOptions['logger'];
  private readonly recentCount: number;
  private readonly maxPerPeer: number;
  private readonly pageSize: number;

  constructor(options: OfflineSyncerOptions) {
    this.gateway = options.gateway;
    this.db = options.db;
    this.botQQ = options.botQQ || '';
    this.logger = options.logger;
    this.recentCount = options.recentCount ?? 30;
    this.maxPerPeer = options.maxPerPeer ?? 100;
    this.pageSize = options.pageSize ?? 30;
  }

  /**
   * 执行离线历史消息检测与增量补全
   */
  async sync(): Promise<OfflineSyncResult> {
    if (this.isSyncing) {
      this.logger?.debug?.('[OfflineSync] 前一次同步任务仍在进行中，跳过本次触发');
      return { peersChecked: 0, peersSynced: 0, messagesInserted: 0, errors: [] };
    }

    this.isSyncing = true;
    const result: OfflineSyncResult = {
      peersChecked: 0,
      peersSynced: 0,
      messagesInserted: 0,
      errors: [],
    };

    try {
      this.logger?.info?.('[OfflineSync] 开始检测离线消息与增量补全...');

      // 1. 获取最近活跃会话
      let contacts: Array<{ peer: string; peerUin: string; chatType: number; remoteMsgTime: number }> = [];

      try {
        const recentRes = await this.gateway.getRecentContact(this.recentCount);
        if (recentRes && recentRes.status === 'ok' && Array.isArray(recentRes.data)) {
          contacts = recentRes.data.map((item: any) => {
            const chatType = Number(item.chatType);
            const peerUin = String(item.peerUin);
            const peer = chatType === 2 ? `group_${peerUin}` : `user_${peerUin}`;
            const remoteMsgTime = item.msgTime ? Number(item.msgTime) * 1000 : 0;
            return { peer, peerUin, chatType, remoteMsgTime };
          });
        }
      } catch (recentErr: any) {
        this.logger?.warn?.('[OfflineSync] 获取最近联系人失败 (尝试降级):', recentErr?.message || recentErr);
      }

      result.peersChecked = contacts.length;

      // 2. 逐个会话增量比对与补全
      for (const contact of contacts) {
        const { peer, peerUin, chatType, remoteMsgTime } = contact;
        const lastDbTime = this.db.getLatestMessageTime(peer);

        // 增量过滤：如果远端最新消息时间 <= 本地最新消息时间，说明无离线新消息，跳过
        if (lastDbTime !== null && remoteMsgTime > 0 && remoteMsgTime <= lastDbTime) {
          this.logger?.debug?.(`[OfflineSync] 会话 ${peer} 已是最新 (本地: ${lastDbTime}, 远端: ${remoteMsgTime})，跳过`);
          continue;
        }

        // 3. 开始分页向前拉取
        let peerInserted = 0;
        let currentSeq: number | undefined = undefined;
        let peerFailed = false;

        while (peerInserted < this.maxPerPeer) {
          const fetchCount = Math.min(this.pageSize, this.maxPerPeer - peerInserted);
          let historyRes: any;

          try {
            if (chatType === 2) {
              historyRes = await this.gateway.getGroupMsgHistory(peerUin, fetchCount, currentSeq);
            } else {
              historyRes = await this.gateway.getFriendMsgHistory(peerUin, fetchCount, currentSeq);
            }
          } catch (fetchErr: any) {
            // 好友无聊天记录或权限受限等异常，安全记录并跳出
            this.logger?.debug?.(`[OfflineSync] 拉取会话 ${peer} 历史消息异常:`, fetchErr?.message || fetchErr);
            result.errors.push({ peer, error: String(fetchErr?.message || fetchErr) });
            peerFailed = true;
            break;
          }

          if (!historyRes || historyRes.status !== 'ok' || !historyRes.data) {
            if (historyRes && historyRes.status === 'failed') {
              this.logger?.debug?.(`[OfflineSync] 会话 ${peer} 返回失败: ${historyRes.wording || historyRes.message || '未知'}`);
              result.errors.push({ peer, error: String(historyRes.wording || historyRes.message || 'status failed') });
            }
            break;
          }

          const msgs: any[] = historyRes.data.messages || [];
          if (!Array.isArray(msgs) || msgs.length === 0) {
            break;
          }

          // 将本批次消息按时间从新到旧（降序）排序，以便从最新往历史排查
          msgs.sort((a, b) => (Number(b.time) || 0) - (Number(a.time) || 0));

          let reachOldBoundary = false;
          let oldestMsgSeq: number | undefined = undefined;

          for (const msg of msgs) {
            const msgTime = msg.time ? Number(msg.time) * 1000 : 0;
            const msgId = Number(msg.message_id);

            // 触碰已有历史边界（时间落入本地已有范围，或 ID 已在库中）
            if ((lastDbTime !== null && msgTime > 0 && msgTime <= lastDbTime) || this.db.hasMessage(msgId)) {
              reachOldBoundary = true;
              break;
            }

            const record = convertOneBotToRecord(msg, this.botQQ);
            if (record) {
              const inserted = this.db.saveMessageIfNotExists(record);
              if (inserted) {
                peerInserted++;
                result.messagesInserted++;
              }
            }

            // 记录当前最旧的一条 message_seq / message_id 用于下一页向前翻页
            if (msg.message_seq !== undefined && msg.message_seq !== null) {
              oldestMsgSeq = Number(msg.message_seq);
            } else if (msg.message_id !== undefined && msg.message_id !== null) {
              oldestMsgSeq = Number(msg.message_id);
            }
          }

          // 如果触碰了边界，或者返回条数小于请求条数，或者无法向前翻页，停止本会话同步
          if (reachOldBoundary || msgs.length < fetchCount || oldestMsgSeq === undefined || oldestMsgSeq === currentSeq) {
            break;
          }

          currentSeq = oldestMsgSeq;
        }

        if (!peerFailed && peerInserted > 0) {
          result.peersSynced++;
          this.logger?.info?.(`[OfflineSync] 会话 ${peer} 离线补全完成，新增 ${peerInserted} 条消息`);
        }
      }

      this.logger?.info?.(
        `[OfflineSync] 离线同步完毕: 检查 ${result.peersChecked} 个会话，补全 ${result.peersSynced} 个会话，共新增 ${result.messagesInserted} 条记录`
      );
    } catch (err: any) {
      this.logger?.error?.('[OfflineSync] 离线消息同步异常:', err);
    } finally {
      this.isSyncing = false;
    }

    return result;
  }
}
