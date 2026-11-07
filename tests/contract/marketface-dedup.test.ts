import { describe, it, expect } from 'vitest';
import type { OneBotMessageEvent } from '../../src/types/index.js';
import { parseNormalizedContent, isExcludedFromProactive } from '../../src/gateway/wakeup.js';

/**
 * 契约测试: NTQQ / NapCat 商城表情 (MarketFace) 降级冗余文本清洗去重契约
 *
 * 背景与规范契约：
 *   NapCat 在将 NTQQ 的 MarketFaceElement（商城官方大表情）转换为 OneBot 11 消息段时，
 *   会产生两个连续的消息段：
 *     1. image 段：携带表情下载直链/本地文件、emoji_package_id，以及 summary: "[拿捏]"；
 *     2. text 段：为了兼容纯文本客户端而追加的降级文本，如 text: "[拿捏]"。
 *   在解析该消息时，若不进行紧邻同名降级文本去重，会导致消息正文被拼接为：
 *     `[表情包: 拿捏 路径: ...][拿捏]`
 *   不仅在末尾产生多余的 `[拿捏]`，还会导致群聊纯表情主动回复过滤（isExcludedFromProactive）
 *   将该消息误判为图文混排而未能排除。
 *
 * 契约要求：
 *   1. 紧随表情包段之后、且去除方括号后与表情包 summary 完全一致的纯降级 text 段，必须自动忽略不拼入 content；
 *   2. 支持带方括号 "[拿捏]" 与不带方括号 "拿捏" 的降级 text 清洗；
 *   3. 连续多个表情包各自的降级 text 均能准确去重；
 *   4. 表情包后用户真实输入的文本（与表情名不完全相同）绝对保留；
 *   5. 无表情包的纯文本 "[拿捏]" 绝对保留；
 *   6. isExcludedFromProactive 能将带有降级 text 的纯商城表情正确识别为纯表情并排除（返回 true）。
 */

const BOT_QQ = '1000000000';
const USER_QQ = '2000000001';
const GROUP_QQ = '3000000001';

describe('契约测试: NTQQ 商城表情降级冗余文本清洗去重', () => {
  it('MF-DEDUP-契约 1: 真实 NapCat 商城表情上报（带本地路径 + 紧邻降级 text [拿捏]），content 必须去除冗余 [拿捏]', () => {
    const event: OneBotMessageEvent = {
      post_type: 'message',
      message_type: 'private',
      sub_type: 'friend',
      message_id: 100001,
      user_id: USER_QQ,
      time: 1788045820,
      self_id: BOT_QQ,
      sender: { user_id: USER_QQ, nickname: '测试用户' },
      message: [
        {
          type: 'image',
          data: {
            file: 'c4-c46fb2f6.gif',
            url: 'https://gxh.vip.qq.com/club/item/parcel/item/c4/c46fb2f6/raw300.gif',
            summary: '[拿捏]',
            sub_type: 0,
            emoji_id: 'c46fb2f6',
            emoji_package_id: 235605,
            local_path: 'C:\\Users\\Mock\\.dsh\\napcat\\downloads\\sticker\\user_2000000001\\903c586a.gif',
          },
        },
        {
          type: 'text',
          data: {
            text: '[拿捏]',
          },
        },
      ],
      raw_message: '',
    };

    const { content } = parseNormalizedContent(event);
    expect(content).toBe(
      '[表情包: 拿捏 路径: C:\\Users\\Mock\\.dsh\\napcat\\downloads\\sticker\\user_2000000001\\903c586a.gif]'
    );
    expect(content.endsWith('[拿捏]')).toBe(false);
  });

  it('MF-DEDUP-契约 2: 降级 text 为无方括号形式 "拿捏"，同样必须被去重', () => {
    const event: OneBotMessageEvent = {
      post_type: 'message',
      message_type: 'private',
      sub_type: 'friend',
      message_id: 100002,
      user_id: USER_QQ,
      time: 1788045820,
      self_id: BOT_QQ,
      sender: { user_id: USER_QQ, nickname: '测试用户' },
      message: [
        {
          type: 'image',
          data: {
            file: 'c4-c46fb2f6.gif',
            summary: '[拿捏]',
            emoji_package_id: 235605,
            local_path: '/path/to/sticker.gif',
          },
        },
        {
          type: 'text',
          data: {
            text: '拿捏',
          },
        },
      ],
      raw_message: '',
    };

    const { content } = parseNormalizedContent(event);
    expect(content).toBe('[表情包: 拿捏 路径: /path/to/sticker.gif]');
  });

  it('MF-DEDUP-契约 3: 未落盘表情包段 + 紧邻降级 text 段，content 格式正确且无冗余描述', () => {
    const event: OneBotMessageEvent = {
      post_type: 'message',
      message_type: 'private',
      sub_type: 'friend',
      message_id: 100003,
      user_id: USER_QQ,
      time: 1788045820,
      self_id: BOT_QQ,
      sender: { user_id: USER_QQ, nickname: '测试用户' },
      message: [
        {
          type: 'image',
          data: {
            file: 'c4-c46fb2f6.gif',
            summary: '[拿捏]',
            emoji_package_id: 235605,
          },
        },
        {
          type: 'text',
          data: {
            text: '[拿捏]',
          },
        },
      ],
      raw_message: '',
    };

    const { content } = parseNormalizedContent(event);
    expect(content).toBe('[表情包: 拿捏]');
  });

  it('MF-DEDUP-契约 4: 连续两个商城表情各带降级 text 段，两个降级 text 均被正确去重', () => {
    const event: OneBotMessageEvent = {
      post_type: 'message',
      message_type: 'group',
      sub_type: 'normal',
      message_id: 100004,
      group_id: GROUP_QQ,
      user_id: USER_QQ,
      time: 1788045820,
      self_id: BOT_QQ,
      sender: { user_id: USER_QQ, nickname: '测试用户' },
      message: [
        {
          type: 'image',
          data: {
            file: 'c4-c46fb2f6.gif',
            summary: '[拿捏]',
            emoji_package_id: 235605,
            local_path: '/path/to/stk1.gif',
          },
        },
        {
          type: 'text',
          data: {
            text: '[拿捏]',
          },
        },
        {
          type: 'image',
          data: {
            file: 'f2-f2fc93f8.gif',
            summary: '[这啥]',
            emoji_package_id: 235605,
            local_path: '/path/to/stk2.gif',
          },
        },
        {
          type: 'text',
          data: {
            text: '[这啥]',
          },
        },
      ],
      raw_message: '',
    };

    const { content } = parseNormalizedContent(event);
    expect(content).toBe('[表情包: 拿捏 路径: /path/to/stk1.gif][表情包: 这啥 路径: /path/to/stk2.gif]');
  });

  it('MF-DEDUP-契约 5: 表情包后跟随用户真实输入的其他文本（非降级标签），用户文本绝不能被误删', () => {
    const event: OneBotMessageEvent = {
      post_type: 'message',
      message_type: 'private',
      sub_type: 'friend',
      message_id: 100005,
      user_id: USER_QQ,
      time: 1788045820,
      self_id: BOT_QQ,
      sender: { user_id: USER_QQ, nickname: '测试用户' },
      message: [
        {
          type: 'image',
          data: {
            file: 'c4-c46fb2f6.gif',
            summary: '[拿捏]',
            emoji_package_id: 235605,
            local_path: '/path/to/stk.gif',
          },
        },
        {
          type: 'text',
          data: {
            text: '这个表情太搞笑了',
          },
        },
      ],
      raw_message: '',
    };

    const { content } = parseNormalizedContent(event);
    expect(content).toBe('[表情包: 拿捏 路径: /path/to/stk.gif]这个表情太搞笑了');
  });

  it('MF-DEDUP-契约 6: 纯文本消息内容为 "[拿捏]"（无表情包），文本绝不能被误删', () => {
    const event: OneBotMessageEvent = {
      post_type: 'message',
      message_type: 'private',
      sub_type: 'friend',
      message_id: 100006,
      user_id: USER_QQ,
      time: 1788045820,
      self_id: BOT_QQ,
      sender: { user_id: USER_QQ, nickname: '测试用户' },
      message: [
        {
          type: 'text',
          data: {
            text: '[拿捏]',
          },
        },
      ],
      raw_message: '',
    };

    const { content } = parseNormalizedContent(event);
    expect(content).toBe('[拿捏]');
  });

  it('MF-DEDUP-契约 7: isExcludedFromProactive 能将带有降级 text 的纯商城表情正确识别为纯表情并排除（返回 true）', () => {
    const event: OneBotMessageEvent = {
      post_type: 'message',
      message_type: 'group',
      sub_type: 'normal',
      message_id: 100007,
      group_id: GROUP_QQ,
      user_id: USER_QQ,
      time: 1788045820,
      self_id: BOT_QQ,
      sender: { user_id: USER_QQ, nickname: '测试用户' },
      message: [
        {
          type: 'image',
          data: {
            file: 'c4-c46fb2f6.gif',
            summary: '[拿捏]',
            emoji_package_id: 235605,
          },
        },
        {
          type: 'text',
          data: {
            text: '[拿捏]',
          },
        },
      ],
      raw_message: '',
    };

    expect(isExcludedFromProactive(event, false)).toBe(true);
  });
});
