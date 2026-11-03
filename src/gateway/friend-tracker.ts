/**
 * dsh-napcat-bridge: 好友申请与系统通知跟踪器 (FriendNoticeTracker)
 * 职责：
 * 1. 跟踪由 OneBot request.friend 上报的好友申请及验证附言 (comment)；
 * 2. 跟踪由 OneBot notice.friend_add 上报的好友成功添加通知；
 * 3. 精准识别并拦截 QQNT 在好友通过瞬间自动注入私聊的历史附言消息，杜绝误当用户新发言唤醒；
 * 4. 消费后立即清除，确保用户在后续正常对话中打字发送相同内容时 100% 正常回复（零误杀）。
 */

export interface PendingFriendRequest {
  comment: string;
  time: number;
  flag?: string;
  createdAt: number;
}

export interface RecentFriendAdd {
  time: number;
  timestamp: number;
}

export class FriendNoticeTracker {
  private pendingRequests = new Map<string, PendingFriendRequest>();
  private recentFriendAdds = new Map<string, RecentFriendAdd>();

  private readonly REQUEST_TTL_MS = 15 * 60 * 1000; // 15 分钟
  private readonly FRIEND_ADD_TTL_MS = 30 * 1000;    // 30 秒

  /**
   * 记录加好友请求 (来自 post_type === 'request' && request_type === 'friend')
   */
  recordRequest(userId: string | number, comment: string, time: number, flag?: string): void {
    this.cleanExpired();
    this.pendingRequests.set(String(userId), {
      comment: (comment || '').trim(),
      time,
      flag,
      createdAt: Date.now(),
    });
  }

  /**
   * 记录好友添加成功通知 (来自 post_type === 'notice' && notice_type === 'friend_add')
   */
  recordFriendAdd(userId: string | number, time: number): void {
    this.cleanExpired();
    this.recentFriendAdds.set(String(userId), {
      time,
      timestamp: Date.now(),
    });
  }

  /**
   * 检查并消费是否为好友申请附言自动注入或伴生消息
   * @param userId 消息发送者 QQ
   * @param content 消息归一化后的文本内容
   * @param msgTime 消息时间戳
   * @returns true 表示匹配到附言注入，应当拦截且不唤醒 Agent；false 表示正常用户发言
   */
  checkAndConsumeFriendNotice(userId: string | number, content: string, _msgTime?: number): boolean {
    this.cleanExpired();
    const uid = String(userId);
    const trimmedContent = (content || '').trim();

    // 1. 检查是否存在匹配的加好友申请
    const pending = this.pendingRequests.get(uid);
    if (pending) {
      // 附言精准匹配（即使是空附言且消息也是空打招呼，或者内容一致）
      const isExactCommentMatch = pending.comment !== '' && pending.comment === trimmedContent;
      const isBothEmpty = pending.comment === '' && trimmedContent === '';

      if (isExactCommentMatch || isBothEmpty) {
        this.pendingRequests.delete(uid);
        this.recentFriendAdds.delete(uid);
        return true;
      }

      // 如果有伴随的 recentFriendAdd（好友通过瞬间），且消息内容包含附言
      const recent = this.recentFriendAdds.get(uid);
      if (recent && Date.now() - recent.timestamp < this.FRIEND_ADD_TTL_MS) {
        if (pending.comment && trimmedContent.includes(pending.comment)) {
          this.pendingRequests.delete(uid);
          this.recentFriendAdds.delete(uid);
          return true;
        }
      }
    }

    return false;
  }

  /**
   * 清理过期记录
   */
  private cleanExpired(): void {
    const now = Date.now();
    for (const [k, v] of this.pendingRequests.entries()) {
      if (now - v.createdAt > this.REQUEST_TTL_MS) {
        this.pendingRequests.delete(k);
      }
    }
    for (const [k, v] of this.recentFriendAdds.entries()) {
      if (now - v.timestamp > this.FRIEND_ADD_TTL_MS) {
        this.recentFriendAdds.delete(k);
      }
    }
  }

  /**
   * 清空所有状态
   */
  clear(): void {
    this.pendingRequests.clear();
    this.recentFriendAdds.clear();
  }
}
