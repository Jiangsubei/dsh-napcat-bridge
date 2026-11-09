/**
 * dsh-napcat-bridge: 唤醒门控模块
 * 实现 OneBot 11 入方向消息与通知事件的唤醒条件判定与唤醒包组装。
 */

import type {
  BridgePluginConfig,
  OneBotMessageEvent,
  OneBotNoticeEvent,
  WakeupPayload,
  WakeupTriggerType,
  FaceRecord,
} from '../types/index.js';
import type { ProactiveManager } from './proactive.js';
import type { FriendNoticeTracker } from './friend-tracker.js';
import { parseNormalizedContent, resolveAtNicknames } from './segment-normalizer.js';

// 向后兼容 Re-export 子模块导出
export * from './card-parser.js';
export * from './segment-normalizer.js';
export * from './proactive-filter.js';

export interface WakeupOptions {
  bot_qq: string;
  bot_nickname?: string;
  aliases?: string[];
  isQuotingBot?: (replyMsgId: number) => Promise<boolean>;
  getQuotedMessage?: (replyMsgId: number) => Promise<{
    user_id: string;
    sender_name?: string;
    content: string;
    self?: number;
    images?: string[];
  } | null | undefined>;
  /** EN-001: 被@者昵称解析器（NapCat at 段只有 qq，昵称经 get_group_member_info 获取） */
  resolveNickname?: (groupId: number | string, qq: string) => Promise<string | undefined>;
  /** 主动回复插件配置 */
  proactive?: BridgePluginConfig;
  /** 主动回复管理器实例 */
  proactiveManager?: ProactiveManager;
  /** 好友申请与通知跟踪器 */
  friendTracker?: FriendNoticeTracker;
  /** 入站图片匹配本地表情库查询器 */
  getFaceByMd5?: (md5: string) => FaceRecord | null | undefined;
}

export interface WakeupDecision {
  wakeup: boolean;
  trigger?: WakeupTriggerType | 'direct';
  payload?: WakeupPayload;
}

export async function shouldWakeup(
  event: OneBotMessageEvent | OneBotNoticeEvent,
  options: WakeupOptions
): Promise<WakeupDecision> {
  const botQQ = String(options.bot_qq || '');

  // 1. 自循环防护: 过滤自身发出的消息或由 bot_qq 发出的事件
  if (event.post_type === 'message_sent') {
    return { wakeup: false };
  }

  const eventUserId = 'user_id' in event && event.user_id !== undefined ? String(event.user_id) : '';
  const senderUserId = 'sender' in event && event.sender?.user_id !== undefined ? String(event.sender.user_id) : '';

  if (botQQ && (eventUserId === botQQ || senderUserId === botQQ)) {
    return { wakeup: false };
  }

  const timestamp = event.time
    ? event.time < 10000000000
      ? event.time * 1000
      : event.time
    : Date.now();

  // 2. Notice 事件判定 (如 poke 戳一戳)
  if (event.post_type === 'notice') {
    const notice = event as OneBotNoticeEvent;
    if (notice.notice_type === 'notify' && notice.sub_type === 'poke') {
      const targetId = notice.target_id !== undefined ? String(notice.target_id) : '';
      if (botQQ && targetId === botQQ) {
        const fromUser = String(notice.user_id ?? notice.sender_id ?? '');
        const isGroup = Boolean(notice.group_id);
        const peer = isGroup ? `group_${notice.group_id}` : `user_${fromUser}`;
        let fromName = '';
        if (isGroup && notice.group_id && typeof options.resolveNickname === 'function') {
          try {
            fromName = (await options.resolveNickname(notice.group_id, fromUser)) || '';
          } catch {}
        }
        const payload: WakeupPayload = {
          trigger: 'poke',
          peer,
          from_user: fromUser,
          from_name: fromName,
          content: '[戳一戳]',
          timestamp,
        };
        return {
          wakeup: true,
          trigger: 'poke',
          payload,
        };
      }
    }
    return { wakeup: false };
  }

  // 3. Message 事件判定
  const msgEvent = event as OneBotMessageEvent;
  const fromUser = String(msgEvent.sender?.user_id ?? msgEvent.user_id ?? '');
  let fromName = msgEvent.sender?.card || msgEvent.sender?.nickname || '';
  const isGroup = msgEvent.message_type === 'group';
  const groupId = msgEvent.group_id;
  const peer = isGroup ? `group_${msgEvent.group_id}` : `user_${fromUser}`;

  // 若群聊消息中发送者昵称为空，尝试调用 resolveNickname 兜底拉取群名片/昵称
  if (isGroup && !fromName && groupId !== undefined && typeof options.resolveNickname === 'function') {
    try {
      fromName = (await options.resolveNickname(groupId, fromUser)) || '';
    } catch {}
  }

  const { content: rawContent, images, replyId, atQQs } = parseNormalizedContent(msgEvent, {
    getFaceByMd5: options.getFaceByMd5,
  });
  const inboundMsgId =
    typeof msgEvent.message_id === 'number' && Number.isSafeInteger(msgEvent.message_id) && msgEvent.message_id !== 0
      ? msgEvent.message_id
      : (msgEvent.message_id !== undefined && msgEvent.message_id !== null && Number.isSafeInteger(Number(msgEvent.message_id)) && Number(msgEvent.message_id) !== 0)
        ? Number(msgEvent.message_id)
        : undefined;

  // 若消息完全无字符（长度为 0）且无图片/引用/at 等有效内容，直接过滤，不唤醒（如文件下载回执/空系统灰条）
  if (rawContent.length === 0 && images.length === 0 && replyId === undefined && atQQs.length === 0) {
    return { wakeup: false };
  }

  // EN-001: 群聊消息的 at 段统一归一化为 @昵称(QQ号)（唤醒包 content 与 from_name 同源格式）
  let content = rawContent;
  if (
    isGroup &&
    atQQs.length > 0 &&
    typeof options.resolveNickname === 'function' &&
    groupId !== undefined
  ) {
    content = await resolveAtNicknames(content, atQQs, groupId, options.resolveNickname);
  }

  // 3.0 异步统一解析被引用消息（若存在 replyId）
  let quoted: WakeupPayload['quoted'] = undefined;
  let isQuotingSelf = false;
  const combinedImages = [...images];

  if (replyId !== undefined) {
    if (options.getQuotedMessage) {
      try {
        const quotedMsg = await options.getQuotedMessage(replyId);
        if (quotedMsg) {
          isQuotingSelf = Boolean(
            quotedMsg.self === 1 ||
              (botQQ !== '' && String(quotedMsg.user_id) === botQQ)
          );
          quoted = {
            msg_id: replyId,
            user_id: String(quotedMsg.user_id || ''),
            from_name: quotedMsg.sender_name || (isQuotingSelf ? (options.bot_nickname || '') : ''),
            text: quotedMsg.content || '',
            images: quotedMsg.images && quotedMsg.images.length > 0 ? quotedMsg.images : undefined,
          };
          if (quotedMsg.images && Array.isArray(quotedMsg.images)) {
            for (const img of quotedMsg.images) {
              if (img && !combinedImages.includes(img)) {
                combinedImages.push(img);
              }
            }
          }
        } else {
          // 优雅降级占位保底
          quoted = {
            msg_id: replyId,
            user_id: '',
            from_name: '',
            text: '〔历史引用消息：内容已过期或无法获取〕',
          };
        }
      } catch {
        quoted = {
          msg_id: replyId,
          user_id: '',
          from_name: '',
          text: '〔历史引用消息：内容已过期或无法获取〕',
        };
      }
    } else if (options.isQuotingBot) {
      try {
        const isQuoting = await options.isQuotingBot(replyId);
        if (isQuoting) {
          isQuotingSelf = true;
          quoted = {
            msg_id: replyId,
            user_id: botQQ,
            from_name: options.bot_nickname || '',
            text: '',
          };
        }
      } catch {}
    }
  }

  // 3.1 私聊消息: 默认直接唤醒
  if (!isGroup) {
    // 过滤系统号 (如 10000 系统通知) 或系统通知子类型
    if (fromUser === '10000' || msgEvent.sub_type === 'notice' || msgEvent.sub_type === 'system') {
      return { wakeup: false };
    }

    // 若匹配为好友申请附言自动注入或伴生消息，直接阻断唤醒（零误杀）
    if (options.friendTracker?.checkAndConsumeFriendNotice(fromUser, content, timestamp)) {
      return { wakeup: false };
    }

    const payload: WakeupPayload = {
      msg_id: inboundMsgId,
      trigger: 'at', // default trigger type for private or handled by agent
      peer,
      from_user: fromUser,
      from_name: fromName,
      content,
      quoted,
      images: combinedImages.length > 0 ? combinedImages : undefined,
      timestamp,
    };
    return {
      wakeup: true,
      trigger: 'direct',
      payload,
    };
  }

  // 3.2 群聊唤醒判定
  // (1) @ 机器人
  if (botQQ && atQQs.includes(botQQ)) {
    const payload: WakeupPayload = {
      msg_id: inboundMsgId,
      trigger: 'at',
      peer,
      from_user: fromUser,
      from_name: fromName,
      content,
      quoted,
      images: combinedImages.length > 0 ? combinedImages : undefined,
      timestamp,
    };
    return {
      wakeup: true,
      trigger: 'at',
      payload,
    };
  }

  // (2) 引用回复机器人
  if (isQuotingSelf && quoted) {
    const payload: WakeupPayload = {
      msg_id: inboundMsgId,
      trigger: 'quote',
      peer,
      from_user: fromUser,
      from_name: fromName,
      content,
      quoted,
      images: combinedImages.length > 0 ? combinedImages : undefined,
      timestamp,
    };
    return {
      wakeup: true,
      trigger: 'quote',
      payload,
    };
  }

  // (3) 点名机器人昵称或别名
  const mentionTargets: string[] = [];
  if (options.bot_nickname && options.bot_nickname.trim() !== '') {
    mentionTargets.push(options.bot_nickname.trim());
  }
  if (Array.isArray(options.aliases)) {
    for (const alias of options.aliases) {
      if (alias && alias.trim() !== '') {
        mentionTargets.push(alias.trim());
      }
    }
  }

  const rawOrContent = `${msgEvent.raw_message || ''} ${content}`;
  for (const target of mentionTargets) {
    if (rawOrContent.includes(target)) {
      const payload: WakeupPayload = {
        msg_id: inboundMsgId,
        trigger: 'mention',
        peer,
        from_user: fromUser,
        from_name: fromName,
        content,
        quoted,
        images: combinedImages.length > 0 ? combinedImages : undefined,
        timestamp,
      };
      return {
        wakeup: true,
        trigger: 'mention',
        payload,
      };
    }
  }

  // 3.3 普通群消息不再即时唤醒，由 ProactiveManager 统一收集缓冲并在轮询窗口期集中研判

  return { wakeup: false };
}
