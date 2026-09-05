import { describe, it, expect } from 'vitest';
import {
  shouldWakeup,
  parseNormalizedContent,
  resolveAtNicknames,
} from '../../src/gateway/wakeup.js';
import { formatWakeupPrompt } from '../../src/gateway/session.js';
import type { OneBotMessageEvent, OneBotNoticeEvent } from '../../src/types/index.js';

describe('契约测试: 唤醒门控与唤醒包构造 (Wakeup Gate Contract)', () => {
  const BOT_QQ = '1000000001';
  const BOT_NICKNAME = '智能小助手';
  const ALIASES = ['小助手', '助手酱'];

  it('契约 1: 私聊普通消息应直接触发唤醒', async () => {
    const event: OneBotMessageEvent = {
      post_type: 'message',
      message_type: 'private',
      sub_type: 'friend',
      message_id: 1001,
      user_id: 2000000001,
      time: 1788045525,
      self_id: BOT_QQ,
      sender: { user_id: 2000000001, nickname: '测试用户' },
      message: [{ type: 'text', data: { text: '你好呀' } }],
      raw_message: '你好呀',
    };

    const decision = await shouldWakeup(event, {
      bot_qq: BOT_QQ,
      bot_nickname: BOT_NICKNAME,
      aliases: ALIASES,
    });

    expect(decision.wakeup).toBe(true);
    expect(decision.payload).toBeDefined();
    expect(decision.payload?.peer).toBe('user_2000000001');
    expect(decision.payload?.from_user).toBe('2000000001');
    expect(decision.payload?.content).toBe('你好呀');
  });

  it('契约 2: 群聊中 @机器人 应触发唤醒 (trigger: at)', async () => {
    const event: OneBotMessageEvent = {
      post_type: 'message',
      message_type: 'group',
      sub_type: 'normal',
      message_id: 1002,
      group_id: 3000000001,
      user_id: 2000000001,
      time: 1788045737,
      self_id: BOT_QQ,
      sender: { user_id: 2000000001, nickname: '张三', card: '张三群名片' },
      message: [
        { type: 'at', data: { qq: BOT_QQ } },
        { type: 'text', data: { text: ' 今天天气怎么样' } },
      ],
      raw_message: `[CQ:at,qq=${BOT_QQ}] 今天天气怎么样`,
    };

    const decision = await shouldWakeup(event, {
      bot_qq: BOT_QQ,
      bot_nickname: BOT_NICKNAME,
      aliases: ALIASES,
    });

    expect(decision.wakeup).toBe(true);
    expect(decision.trigger).toBe('at');
    expect(decision.payload?.peer).toBe('group_3000000001');
    expect(decision.payload?.from_user).toBe('2000000001');
  });

  it('契约 3: 群聊中文本点名机器人昵称/别名应触发唤醒 (trigger: mention)', async () => {
    const event: OneBotMessageEvent = {
      post_type: 'message',
      message_type: 'group',
      sub_type: 'normal',
      message_id: 1003,
      group_id: 3000000001,
      user_id: 2000000001,
      time: 1788045750,
      self_id: BOT_QQ,
      sender: { user_id: 2000000001, nickname: '李四' },
      message: [{ type: 'text', data: { text: '小助手 在吗' } }],
      raw_message: '小助手 在吗',
    };

    const decision = await shouldWakeup(event, {
      bot_qq: BOT_QQ,
      bot_nickname: BOT_NICKNAME,
      aliases: ALIASES,
    });

    expect(decision.wakeup).toBe(true);
    expect(decision.trigger).toBe('mention');
    expect(decision.payload?.content).toBe('小助手 在吗');
  });

  it('契约 4: 群聊中引用回复机器人发出的消息应触发唤醒 (trigger: quote)', async () => {
    const event: OneBotMessageEvent = {
      post_type: 'message',
      message_type: 'group',
      sub_type: 'normal',
      message_id: 1004,
      group_id: 3000000001,
      user_id: 2000000001,
      time: 1788045814,
      self_id: BOT_QQ,
      sender: { user_id: 2000000001, nickname: '王五' },
      message: [
        { type: 'reply', data: { id: 999 } },
        { type: 'text', data: { text: '你刚才说的很有道理' } },
      ],
      raw_message: '[CQ:reply,id=999]你刚才说的很有道理',
    };

    const decision = await shouldWakeup(event, {
      bot_qq: BOT_QQ,
      bot_nickname: BOT_NICKNAME,
      aliases: ALIASES,
      isQuotingBot: async (replyMsgId: number) => replyMsgId === 999,
    });

    expect(decision.wakeup).toBe(true);
    expect(decision.trigger).toBe('quote');
    expect(decision.payload?.quoted).toBeDefined();
    expect(decision.payload?.quoted?.msg_id).toBe(999);
  });

  it('契约 5: 群聊/私聊中戳一戳机器人应触发唤醒 (trigger: poke)', async () => {
    const pokeNotice: OneBotNoticeEvent = {
      post_type: 'notice',
      notice_type: 'notify',
      sub_type: 'poke',
      time: 1788045714,
      self_id: BOT_QQ,
      target_id: BOT_QQ,
      user_id: 2000000001,
      group_id: 3000000001,
    };

    const decision = await shouldWakeup(pokeNotice, {
      bot_qq: BOT_QQ,
      bot_nickname: BOT_NICKNAME,
      aliases: ALIASES,
    });

    expect(decision.wakeup).toBe(true);
    expect(decision.trigger).toBe('poke');
    expect(decision.payload?.peer).toBe('group_3000000001');
    expect(decision.payload?.from_user).toBe('2000000001');
  });

  it('契约 6: 自循环防护 — 机器人自身发出的消息绝对不触发唤醒', async () => {
    const selfMsgEvent: OneBotMessageEvent = {
      post_type: 'message_sent',
      message_type: 'group',
      sub_type: 'normal',
      message_id: 1005,
      group_id: 3000000001,
      user_id: BOT_QQ, // 机器人自身 QQ
      time: 1788045820,
      self_id: BOT_QQ,
      sender: { user_id: BOT_QQ, nickname: BOT_NICKNAME },
      message: [{ type: 'text', data: { text: '这是我发出的消息' } }],
      raw_message: '这是我发出的消息',
    };

    const decision = await shouldWakeup(selfMsgEvent, {
      bot_qq: BOT_QQ,
      bot_nickname: BOT_NICKNAME,
      aliases: ALIASES,
    });

    expect(decision.wakeup).toBe(false);
  });

  it('C3-契约 7: Spec 未列消息段类型 (share/music/location/contact/anonymous/lightapp) 保留占位不静默丢段', () => {
    // parseNormalizedContent 真实解析含未映射段的混合消息
    const event: OneBotMessageEvent = {
      post_type: 'message',
      message_type: 'group',
      sub_type: 'normal',
      message_id: 2001,
      group_id: 3000000001,
      user_id: '2000000001',
      time: 1788045820,
      self_id: BOT_QQ,
      sender: { user_id: '2000000001', nickname: '测试用户' },
      message: [
        { type: 'text', data: { text: '看看这个' } },
        { type: 'share', data: { title: '分享标题' } },
        { type: 'music', data: {} },
        { type: 'location', data: { title: '杭州' } },
        { type: 'contact', data: {} },
        { type: 'anonymous', data: {} },
        { type: 'lightapp', data: { title: '小程序' } },
      ],
      raw_message: '',
    };

    const { content } = parseNormalizedContent(event);
    expect(content).toContain('看看这个');
    expect(content).toContain('[分享:分享标题]');
    expect(content).toContain('[音乐分享]');
    expect(content).toContain('[位置:杭州]');
    expect(content).toContain('[联系人推荐]');
    expect(content).toContain('[匿名消息]');
    expect(content).toContain('[分享:小程序]');
  });

  it('EN-001-契约 8: at 段归一化输出 @昵称(QQ号)（唤醒包 content 统一昵称+QQ号格式）', async () => {
    const event: OneBotMessageEvent = {
      post_type: 'message',
      message_type: 'group',
      sub_type: 'normal',
      message_id: 2002,
      group_id: 3000000001,
      user_id: 2000000001,
      time: 1788045820,
      self_id: BOT_QQ,
      sender: { user_id: 2000000001, nickname: '张三', card: '张三群名片' },
      message: [
        { type: 'at', data: { qq: BOT_QQ } },
        { type: 'at', data: { qq: 2000000001 } },
        { type: 'text', data: { text: ' 帮忙看看这个链接' } },
      ],
      raw_message: `[CQ:at,qq=${BOT_QQ}][CQ:at,qq=2000000001] 帮忙看看这个链接`,
    };

    const decision = await shouldWakeup(event, {
      bot_qq: BOT_QQ,
      bot_nickname: BOT_NICKNAME,
      aliases: ALIASES,
      resolveNickname: async (_groupId, qq) => {
        if (qq === BOT_QQ) return 'BotNickname';
        if (qq === '2000000001') return '张三';
        return undefined;
      },
    });

    expect(decision.wakeup).toBe(true);
    expect(decision.trigger).toBe('at');
    expect(decision.payload?.content).toBe('@BotNickname(1000000001)@张三(2000000001) 帮忙看看这个链接');
    // from_name 用发送者 sender 字段（card 优先）
    expect(decision.payload?.from_name).toBe('张三群名片');
  });

  it('EN-001-契约 9: 解析器查不到昵称时回退为裸 @QQ号，不中断', async () => {
    const event: OneBotMessageEvent = {
      post_type: 'message',
      message_type: 'group',
      sub_type: 'normal',
      message_id: 2003,
      group_id: 3000000001,
      user_id: 2000000001,
      time: 1788045820,
      self_id: BOT_QQ,
      sender: { user_id: 2000000001, nickname: '张三' },
      message: [
        { type: 'at', data: { qq: BOT_QQ } },
        { type: 'text', data: { text: ' 你好' } },
      ],
      raw_message: `[CQ:at,qq=${BOT_QQ}] 你好`,
    };

    const decision = await shouldWakeup(event, {
      bot_qq: BOT_QQ,
      resolveNickname: async () => undefined,
    });

    expect(decision.wakeup).toBe(true);
    expect(decision.payload?.content).toBe(`@${BOT_QQ} 你好`);
  });

  it('EN-001-契约 10: 纯文本字面的 @昵称 保持原样（用户手敲，非 CQ:at 段）', async () => {
    const event: OneBotMessageEvent = {
      post_type: 'message',
      message_type: 'group',
      sub_type: 'normal',
      message_id: 2004,
      group_id: 3000000001,
      user_id: 2000000001,
      time: 1788045820,
      self_id: BOT_QQ,
      sender: { user_id: 2000000001, nickname: '张三' },
      message: [
        { type: 'text', data: { text: '@BotNickname ' } },
        { type: 'at', data: { qq: BOT_QQ } },
        { type: 'text', data: { text: ' 在吗' } },
      ],
      raw_message: '@BotNickname [CQ:at,qq=${BOT_QQ}] 在吗',
    };

    const decision = await shouldWakeup(event, {
      bot_qq: BOT_QQ,
      resolveNickname: async () => 'BotNickname',
    });

    expect(decision.wakeup).toBe(true);
    expect(decision.payload?.content).toBe('@BotNickname @BotNickname(1000000001) 在吗');
  });

  it('EN-001-契约 11: resolveAtNicknames 单元 — 多 at 去重、失败不抛出', async () => {
    const resolved = await resolveAtNicknames(
      '@123 @456 文本 @123',
      ['123', '456', '123'],
      3000000001,
      async (_gid, qq) => (qq === '123' ? '猫猫' : undefined)
    );
    expect(resolved).toBe('@猫猫(123) @456 文本 @猫猫(123)');

    // 无 resolver / 无 at / 无 groupId 时原样返回
    expect(await resolveAtNicknames('x @123', ['123'], 1, undefined)).toBe('x @123');
    expect(await resolveAtNicknames('x @123', [], 1, async () => 'y')).toBe('x @123');
    expect(await resolveAtNicknames('x @123', ['123'], undefined, async () => 'y')).toBe('x @123');

    // resolver 抛错时回退原样，不中断
    expect(
      await resolveAtNicknames('x @123', ['123'], 1, async () => {
        throw new Error('boom');
      })
    ).toBe('x @123');
  });

  it('契约 12: sticker + local_path + summary -> content 包含 local_path 且含「已保存:」，格式 [表情包:[动画表情] 已保存: /...]', () => {
    const event: OneBotMessageEvent = {
      post_type: 'message',
      message_type: 'private',
      sub_type: 'friend',
      message_id: 3001,
      user_id: 2000000001,
      time: 1788045820,
      self_id: BOT_QQ,
      sender: { user_id: 2000000001, nickname: '测试用户' },
      message: [
        {
          type: 'image',
          data: {
            file: 'f36ee0e.gif',
            sub_type: 1,
            summary: '[动画表情]',
            local_path: '/dsh/workspace/napcat_download/sticker/user_2000000001/f36ee0e.gif',
          },
        },
      ],
      raw_message: '',
    };

    const { content, images } = parseNormalizedContent(event);
    expect(content).toBe('[表情包:[动画表情] 已保存: /dsh/workspace/napcat_download/sticker/user_2000000001/f36ee0e.gif]');
    expect(content).toContain('已保存:');
    expect(content).toContain('/dsh/workspace/napcat_download/sticker/user_2000000001/f36ee0e.gif');
    expect(images).toEqual(['/dsh/workspace/napcat_download/sticker/user_2000000001/f36ee0e.gif']);
  });

  it('契约 13: sticker + local_path 无 summary -> 包含路径，格式 [表情包:表情 已保存: /...]', () => {
    const event: OneBotMessageEvent = {
      post_type: 'message',
      message_type: 'private',
      sub_type: 'friend',
      message_id: 3002,
      user_id: 2000000001,
      time: 1788045820,
      self_id: BOT_QQ,
      sender: { user_id: 2000000001, nickname: '测试用户' },
      message: [
        {
          type: 'image',
          data: {
            file: 'f36ee0e.gif',
            sub_type: 1,
            local_path: '/dsh/workspace/napcat_download/sticker/user_2000000001/f36ee0e.gif',
          },
        },
      ],
      raw_message: '',
    };

    const { content, images } = parseNormalizedContent(event);
    expect(content).toBe('[表情包:表情 已保存: /dsh/workspace/napcat_download/sticker/user_2000000001/f36ee0e.gif]');
    expect(content).toContain('已保存:');
    expect(content).toContain('/dsh/workspace/napcat_download/sticker/user_2000000001/f36ee0e.gif');
    expect(images).toEqual(['/dsh/workspace/napcat_download/sticker/user_2000000001/f36ee0e.gif']);
  });

  it('契约 14: sticker 无 local_path 有 summary -> 保持 [表情包:[动画表情]] 不丢', () => {
    const event: OneBotMessageEvent = {
      post_type: 'message',
      message_type: 'private',
      sub_type: 'friend',
      message_id: 3003,
      user_id: 2000000001,
      time: 1788045820,
      self_id: BOT_QQ,
      sender: { user_id: 2000000001, nickname: '测试用户' },
      message: [
        {
          type: 'image',
          data: {
            file: 'http://example.com/sticker.png',
            sub_type: 1,
            summary: '[动画表情]',
          },
        },
      ],
      raw_message: '',
    };

    const { content, images } = parseNormalizedContent(event);
    expect(content).toBe('[表情包:[动画表情]]');
    expect(images).toEqual(['http://example.com/sticker.png']);
  });

  it('契约 15: 普通 image 保持 [图片:/path] 格式不回归', () => {
    const event: OneBotMessageEvent = {
      post_type: 'message',
      message_type: 'private',
      sub_type: 'friend',
      message_id: 3004,
      user_id: 2000000001,
      time: 1788045820,
      self_id: BOT_QQ,
      sender: { user_id: 2000000001, nickname: '测试用户' },
      message: [
        {
          type: 'image',
          data: {
            file: 'photo.jpg',
            local_path: '/dsh/workspace/napcat_download/image/common/photo.jpg',
          },
        },
      ],
      raw_message: '',
    };

    const { content, images } = parseNormalizedContent(event);
    expect(content).toBe('[图片:/dsh/workspace/napcat_download/image/common/photo.jpg]');
    expect(images).toEqual(['/dsh/workspace/napcat_download/image/common/photo.jpg']);
  });

  it('契约 16: formatWakeupPrompt 群聊消息应包含 [QQ群聊: <群号>] [YYYY-MM-DD HH:mm:ss] 发送者信息', () => {
    // 2026-08-31 04:00:56 本地时间测试时间戳: 构造固定时间以验证格式
    const fixedDate = new Date(2026, 7, 31, 4, 0, 56);
    const ts = fixedDate.getTime();

    const prompt = formatWakeupPrompt({
      trigger: 'at',
      peer: 'group_3000000001',
      from_user: '2000000001',
      from_name: '张三',
      content: '今天天气怎么样',
      timestamp: ts,
    });

    expect(prompt).toBe(
      '[QQ群聊: 3000000001] [2026-08-31 04:00:56] 发送者: 张三 (QQ: 2000000001)\n今天天气怎么样'
    );
  });

  it('契约 17: formatWakeupPrompt 私聊消息应包含 [QQ私聊] [YYYY-MM-DD HH:mm:ss] 发送者信息', () => {
    const fixedDate = new Date(2026, 7, 31, 4, 0, 56);
    const ts = fixedDate.getTime();

    const prompt = formatWakeupPrompt({
      trigger: 'at',
      peer: 'user_2000000001',
      from_user: '2000000001',
      from_name: '李四',
      content: '你好呀',
      timestamp: ts,
    });

    expect(prompt).toBe(
      '[QQ私聊] [2026-08-31 04:00:56] 发送者: 李四 (QQ: 2000000001)\n你好呀'
    );
  });

  it('契约 18: formatWakeupPrompt 戳一戳通知应包含 [YYYY-MM-DD HH:mm:ss] 时间戳', () => {
    const fixedDate = new Date(2026, 7, 31, 4, 0, 56);
    const ts = fixedDate.getTime();

    const groupPoke = formatWakeupPrompt({
      trigger: 'poke',
      peer: 'group_3000000001',
      from_user: '2000000001',
      from_name: '王五',
      content: '[戳一戳]',
      timestamp: ts,
    });
    expect(groupPoke).toBe(
      '[QQ群聊: 3000000001] [2026-08-31 04:00:56] 用户 王五 (QQ: 2000000001) 戳了戳你。'
    );

    const privatePoke = formatWakeupPrompt({
      trigger: 'poke',
      peer: 'user_2000000001',
      from_user: '2000000001',
      from_name: '王五',
      content: '[戳一戳]',
      timestamp: ts,
    });
    expect(privatePoke).toBe(
      '[QQ私聊] [2026-08-31 04:00:56] 用户 王五 (QQ: 2000000001) 戳了戳你。'
    );
  });

  it('契约 19: formatWakeupPrompt 引用回复消息带时间戳与引用元数据', () => {
    const fixedDate = new Date(2026, 7, 31, 4, 0, 56);
    const ts = fixedDate.getTime();

    const prompt = formatWakeupPrompt({
      trigger: 'quote',
      peer: 'group_3000000001',
      from_user: '2000000001',
      from_name: '张三',
      quoted: {
        msg_id: 888,
        user_id: '1000000001',
        from_name: '智能小助手',
        text: '这是之前的一条回复',
      },
      content: '对这条回复有疑问',
      timestamp: ts,
    });

    expect(prompt).toBe(
      '[QQ群聊: 3000000001] [2026-08-31 04:00:56] 发送者: 张三 (QQ: 2000000001)\n[引用回复 智能小助手 (QQ: 1000000001): "这是之前的一条回复"]\n对这条回复有疑问'
    );
  });

  it('契约 20: 群聊戳一戳应通过 resolveNickname 异步解析戳人者群名片/昵称并填入 payload.from_name', async () => {
    const pokeNotice: OneBotNoticeEvent = {
      post_type: 'notice',
      notice_type: 'notify',
      sub_type: 'poke',
      time: 1788045714,
      self_id: BOT_QQ,
      target_id: BOT_QQ,
      user_id: 2000000001,
      group_id: 3000000001,
    };

    const decision = await shouldWakeup(pokeNotice, {
      bot_qq: BOT_QQ,
      bot_nickname: BOT_NICKNAME,
      aliases: ALIASES,
      resolveNickname: async (gid, qq) => {
        if (String(gid) === '3000000001' && String(qq) === '2000000001') {
          return '群管张三';
        }
        return undefined;
      },
    });

    expect(decision.wakeup).toBe(true);
    expect(decision.trigger).toBe('poke');
    expect(decision.payload?.peer).toBe('group_3000000001');
    expect(decision.payload?.from_user).toBe('2000000001');
    expect(decision.payload?.from_name).toBe('群管张三');
  });

  it('契约 21: 群聊消息当 sender.card 与 sender.nickname 为空时，应通过 resolveNickname 兜底解析群昵称', async () => {
    const event: OneBotMessageEvent = {
      post_type: 'message',
      message_type: 'group',
      sub_type: 'normal',
      message_id: 2001,
      group_id: 3000000001,
      user_id: 2000000001,
      time: 1788045737,
      self_id: BOT_QQ,
      sender: { user_id: 2000000001, nickname: '' },
      message: [
        { type: 'at', data: { qq: BOT_QQ } },
        { type: 'text', data: { text: ' 测试无昵称兜底' } },
      ],
      raw_message: `[CQ:at,qq=${BOT_QQ}] 测试无昵称兜底`,
    };

    const decision = await shouldWakeup(event, {
      bot_qq: BOT_QQ,
      bot_nickname: BOT_NICKNAME,
      aliases: ALIASES,
      resolveNickname: async (gid, qq) => {
        if (String(gid) === '3000000001' && String(qq) === '2000000001') {
          return '群管张三';
        }
        return undefined;
      },
    });

    expect(decision.wakeup).toBe(true);
    expect(decision.payload?.from_name).toBe('群管张三');
  });

  it('契约 22: 完全为空的私聊消息（无字符无图片附件，如文件下载回执）在 shouldWakeup 中必须返回 wakeup: false', async () => {
    const emptyPrivateEvent: OneBotMessageEvent = {
      post_type: 'message',
      message_type: 'private',
      sub_type: 'friend',
      message_id: 4001,
      user_id: 2000000001,
      time: 1788045820,
      self_id: BOT_QQ,
      sender: { user_id: 2000000001, nickname: '测试用户' },
      message: [],
      raw_message: '',
    };

    const decision = await shouldWakeup(emptyPrivateEvent, {
      bot_qq: BOT_QQ,
      bot_nickname: BOT_NICKNAME,
      aliases: ALIASES,
    });

    expect(decision.wakeup).toBe(false);
    expect(decision.payload).toBeUndefined();
  });

  it('契约 23: 完全为空的群聊消息在 shouldWakeup 中必须返回 wakeup: false', async () => {
    const emptyGroupEvent: OneBotMessageEvent = {
      post_type: 'message',
      message_type: 'group',
      sub_type: 'normal',
      message_id: 4002,
      group_id: 3000000001,
      user_id: 2000000001,
      time: 1788045820,
      self_id: BOT_QQ,
      sender: { user_id: 2000000001, nickname: '测试用户' },
      message: [],
      raw_message: '',
    };

    const decision = await shouldWakeup(emptyGroupEvent, {
      bot_qq: BOT_QQ,
      bot_nickname: BOT_NICKNAME,
      aliases: ALIASES,
    });

    expect(decision.wakeup).toBe(false);
    expect(decision.payload).toBeUndefined();
  });

  it('契约 24: 单纯只有空格的私聊消息含有有效字符，必须正常触发唤醒 (wakeup: true)，不可误过滤', async () => {
    const spacePrivateEvent: OneBotMessageEvent = {
      post_type: 'message',
      message_type: 'private',
      sub_type: 'friend',
      message_id: 4003,
      user_id: 2000000001,
      time: 1788045820,
      self_id: BOT_QQ,
      sender: { user_id: 2000000001, nickname: '测试用户' },
      message: [{ type: 'text', data: { text: '   ' } }],
      raw_message: '   ',
    };

    const decision = await shouldWakeup(spacePrivateEvent, {
      bot_qq: BOT_QQ,
      bot_nickname: BOT_NICKNAME,
      aliases: ALIASES,
    });

    expect(decision.wakeup).toBe(true);
    expect(decision.payload).toBeDefined();
    expect(decision.payload?.content).toBe('   ');
  });

  it('契约 25: 群聊中 @机器人 并带有纯空格文本，必须正常触发唤醒 (wakeup: true)', async () => {
    const spaceGroupEvent: OneBotMessageEvent = {
      post_type: 'message',
      message_type: 'group',
      sub_type: 'normal',
      message_id: 4004,
      group_id: 3000000001,
      user_id: 2000000001,
      time: 1788045820,
      self_id: BOT_QQ,
      sender: { user_id: 2000000001, nickname: '测试用户' },
      message: [
        { type: 'at', data: { qq: BOT_QQ } },
        { type: 'text', data: { text: '  ' } },
      ],
      raw_message: `[CQ:at,qq=${BOT_QQ}]  `,
    };

    const decision = await shouldWakeup(spaceGroupEvent, {
      bot_qq: BOT_QQ,
      bot_nickname: BOT_NICKNAME,
      aliases: ALIASES,
    });

    expect(decision.wakeup).toBe(true);
    expect(decision.trigger).toBe('at');
  });

  it('契约 26: 群聊中同时包含 @机器人 + 引用回复群友图片，必须完整携带 quoted 并将图片合并至 images', async () => {
    const event: OneBotMessageEvent = {
      post_type: 'message',
      message_type: 'group',
      sub_type: 'normal',
      message_id: 5001,
      group_id: 3000000001,
      user_id: 2000000001,
      time: 1788045820,
      self_id: BOT_QQ,
      sender: { user_id: 2000000001, nickname: '你醒了？你被基米单杀了', card: '你醒了？你被基米单杀了' },
      message: [
        { type: 'reply', data: { id: 12345 } },
        { type: 'at', data: { qq: BOT_QQ } },
        { type: 'text', data: { text: ' 说的这个图' } },
      ],
      raw_message: `[CQ:reply,id=12345][CQ:at,qq=${BOT_QQ}] 说的这个图`,
    };

    const decision = await shouldWakeup(event, {
      bot_qq: BOT_QQ,
      bot_nickname: BOT_NICKNAME,
      aliases: ALIASES,
      resolveNickname: async (_gid, qq) => (qq === BOT_QQ ? 'BotNickname' : '用户名加载中…'),
      getQuotedMessage: async (repId: number) => {
        if (repId === 12345) {
          return {
            user_id: '1617307295',
            sender_name: '用户名加载中…',
            content: '[图片:/dsh/workspace/napcat_download/image/common/abc.jpg]',
            images: ['/dsh/workspace/napcat_download/image/common/abc.jpg'],
          };
        }
        return null;
      },
    });

    expect(decision.wakeup).toBe(true);
    expect(decision.trigger).toBe('at');
    expect(decision.payload).toBeDefined();
    expect(decision.payload?.quoted).toBeDefined();
    expect(decision.payload?.quoted?.msg_id).toBe(12345);
    expect(decision.payload?.quoted?.user_id).toBe('1617307295');
    expect(decision.payload?.quoted?.from_name).toBe('用户名加载中…');
    expect(decision.payload?.quoted?.text).toBe('[图片:/dsh/workspace/napcat_download/image/common/abc.jpg]');
    // 引用中的图片合并进入 payload.images
    expect(decision.payload?.images).toContain('/dsh/workspace/napcat_download/image/common/abc.jpg');
  });

  it('契约 27: 群聊中点名机器人别名 + 引用回复，必须完整携带 quoted', async () => {
    const event: OneBotMessageEvent = {
      post_type: 'message',
      message_type: 'group',
      sub_type: 'normal',
      message_id: 5002,
      group_id: 3000000001,
      user_id: 2000000001,
      time: 1788045820,
      self_id: BOT_QQ,
      sender: { user_id: 2000000001, nickname: '测试用户' },
      message: [
        { type: 'reply', data: { id: 67890 } },
        { type: 'text', data: { text: '小助手 评价一下这个' } },
      ],
      raw_message: '[CQ:reply,id=67890]小助手 评价一下这个',
    };

    const decision = await shouldWakeup(event, {
      bot_qq: BOT_QQ,
      bot_nickname: BOT_NICKNAME,
      aliases: ALIASES,
      getQuotedMessage: async (repId: number) => {
        if (repId === 67890) {
          return {
            user_id: '998877',
            sender_name: '群友老王',
            content: '我觉得这个方案不太行',
          };
        }
        return null;
      },
    });

    expect(decision.wakeup).toBe(true);
    expect(decision.trigger).toBe('mention');
    expect(decision.payload?.quoted).toBeDefined();
    expect(decision.payload?.quoted?.msg_id).toBe(67890);
    expect(decision.payload?.quoted?.user_id).toBe('998877');
    expect(decision.payload?.quoted?.from_name).toBe('群友老王');
    expect(decision.payload?.quoted?.text).toBe('我觉得这个方案不太行');
  });

  it('契约 28: 私聊中引用历史消息，必须完整携带 quoted', async () => {
    const event: OneBotMessageEvent = {
      post_type: 'message',
      message_type: 'private',
      sub_type: 'friend',
      message_id: 5003,
      user_id: 2000000001,
      time: 1788045820,
      self_id: BOT_QQ,
      sender: { user_id: 2000000001, nickname: '测试用户' },
      message: [
        { type: 'reply', data: { id: 112233 } },
        { type: 'text', data: { text: '请基于这个继续写' } },
      ],
      raw_message: '[CQ:reply,id=112233]请基于这个继续写',
    };

    const decision = await shouldWakeup(event, {
      bot_qq: BOT_QQ,
      bot_nickname: BOT_NICKNAME,
      aliases: ALIASES,
      getQuotedMessage: async (repId: number) => {
        if (repId === 112233) {
          return {
            user_id: BOT_QQ,
            sender_name: BOT_NICKNAME,
            content: '第一章：开始...',
          };
        }
        return null;
      },
    });

    expect(decision.wakeup).toBe(true);
    expect(decision.payload?.quoted).toBeDefined();
    expect(decision.payload?.quoted?.msg_id).toBe(112233);
    expect(decision.payload?.quoted?.text).toBe('第一章：开始...');
  });

  it('契约 29: 引用历史消息查不到内容时，必须优雅降级为占位提示且不中断唤醒', async () => {
    const event: OneBotMessageEvent = {
      post_type: 'message',
      message_type: 'group',
      sub_type: 'normal',
      message_id: 5004,
      group_id: 3000000001,
      user_id: 2000000001,
      time: 1788045820,
      self_id: BOT_QQ,
      sender: { user_id: 2000000001, nickname: '测试用户' },
      message: [
        { type: 'reply', data: { id: 999999 } },
        { type: 'at', data: { qq: BOT_QQ } },
        { type: 'text', data: { text: ' 这个怎么看' } },
      ],
      raw_message: `[CQ:reply,id=999999][CQ:at,qq=${BOT_QQ}] 这个怎么看`,
    };

    const decision = await shouldWakeup(event, {
      bot_qq: BOT_QQ,
      bot_nickname: BOT_NICKNAME,
      aliases: ALIASES,
      getQuotedMessage: async () => null, // 模拟查不到
    });

    expect(decision.wakeup).toBe(true);
    expect(decision.payload?.quoted).toBeDefined();
    expect(decision.payload?.quoted?.msg_id).toBe(999999);
    expect(decision.payload?.quoted?.text).toBe('〔历史引用消息：内容已过期或无法获取〕');
  });

  it('契约 30: formatWakeupPrompt 优雅降级引用消息格式化渲染', () => {
    const fixedDate = new Date(2026, 7, 31, 11, 37, 55);
    const ts = fixedDate.getTime();

    const prompt = formatWakeupPrompt({
      trigger: 'at',
      peer: 'group_3000000001',
      from_user: '2000000001',
      from_name: '你醒了？你被基米单杀了',
      quoted: {
        msg_id: 12345,
        user_id: '1617307295',
        from_name: '用户名加载中…',
        text: '[图片:/dsh/workspace/napcat_download/image/common/abc.jpg]',
      },
      content: '@BotNickname(1000000001) 说的这个图',
      timestamp: ts,
    });

    expect(prompt).toBe(
      '[QQ群聊: 3000000001] [2026-08-31 11:37:55] 发送者: 你醒了？你被基米单杀了 (QQ: 2000000001)\n' +
      '[引用回复 用户名加载中… (QQ: 1617307295): "[图片:/dsh/workspace/napcat_download/image/common/abc.jpg]"]\n' +
      '@BotNickname(1000000001) 说的这个图'
    );

    const fallbackPrompt = formatWakeupPrompt({
      trigger: 'at',
      peer: 'group_3000000001',
      from_user: '2000000001',
      from_name: '你醒了？你被基米单杀了',
      quoted: {
        msg_id: 999999,
        user_id: '',
        from_name: '',
        text: '〔历史引用消息：内容已过期或无法获取〕',
      },
      content: '@BotNickname(1000000001) 说的这个图',
      timestamp: ts,
    });

    expect(fallbackPrompt).toBe(
      '[QQ群聊: 3000000001] [2026-08-31 11:37:55] 发送者: 你醒了？你被基米单杀了 (QQ: 2000000001)\n' +
      '[引用回复 消息ID: 999999: "〔历史引用消息：内容已过期或无法获取〕"]\n' +
      '@BotNickname(1000000001) 说的这个图'
    );
  });

  describe('EN-004: 卡片消息通用内容提取器 (JSON/XML/多源卡片/封面图)', () => {
    it('EN-004-契约 31: Bilibili 小程序卡片 (meta.detail_1: qqdocurl 优先 + title + preview 封面)', () => {
      const event: OneBotMessageEvent = {
        post_type: 'message',
        message_type: 'group',
        sub_type: 'normal',
        message_id: 3001,
        group_id: 3000000001,
        user_id: 2000000001,
        time: 1788045820,
        self_id: BOT_QQ,
        sender: { user_id: 2000000001, nickname: '张三' },
        message: [
          {
            type: 'json',
            data: {
              data: JSON.stringify({
                app: 'com.tencent.miniapp',
                desc: '',
                prompt: '[QQ小程序]哔哩哔哩',
                meta: {
                  detail_1: {
                    appid: '1109937557',
                    title: '【深度学习】Transformer 从零手写实现',
                    desc: '视频简介内容',
                    preview: 'https://i0.hdslb.com/bfs/archive/12345.jpg',
                    url: 'https://m.q.qq.com/a/s/xxx',
                    qqdocurl: 'https://b23.tv/av123456',
                  },
                },
              }),
            },
          },
        ],
        raw_message: '',
      };

      const { content, images } = parseNormalizedContent(event);
      expect(content).toBe(
        '[卡片消息:【深度学习】Transformer 从零手写实现](https://b23.tv/av123456) [封面:https://i0.hdslb.com/bfs/archive/12345.jpg]'
      );
      expect(images).toEqual(['https://i0.hdslb.com/bfs/archive/12345.jpg']);
    });

    it('EN-004-契约 32: QQ超级会员小程序卡片 (meta.miniapp: jumpUrl + title + preview 封面)', () => {
      const event: OneBotMessageEvent = {
        post_type: 'message',
        message_type: 'private',
        sub_type: 'friend',
        message_id: 3002,
        user_id: 2000000001,
        time: 1788045820,
        self_id: BOT_QQ,
        sender: { user_id: 2000000001, nickname: '张三' },
        message: [
          {
            type: 'json',
            data: {
              data: JSON.stringify({
                app: 'com.tencent.miniapp',
                prompt: '[QQ小程序]超级会员',
                meta: {
                  miniapp: {
                    title: '腾讯视频 VIP 年卡 5 折特惠',
                    desc: '限时特惠',
                    preview: 'https://imgcache.qq.com/vip/banner.png',
                    jumpUrl: 'https://vip.qq.com/act/xxx',
                  },
                },
              }),
            },
          },
        ],
        raw_message: '',
      };

      const { content, images } = parseNormalizedContent(event);
      expect(content).toBe(
        '[卡片消息:腾讯视频 VIP 年卡 5 折特惠](https://vip.qq.com/act/xxx) [封面:https://imgcache.qq.com/vip/banner.png]'
      );
      expect(images).toEqual(['https://imgcache.qq.com/vip/banner.png']);
    });

    it('EN-004-契约 33: 仅 prompt 无 title 的分享卡片 (退回 prompt)', () => {
      const event: OneBotMessageEvent = {
        post_type: 'message',
        message_type: 'group',
        sub_type: 'normal',
        message_id: 3003,
        group_id: 3000000001,
        user_id: 2000000001,
        time: 1788045820,
        self_id: BOT_QQ,
        sender: { user_id: 2000000001, nickname: '张三' },
        message: [
          {
            type: 'json',
            data: {
              data: JSON.stringify({
                app: 'com.tencent.share',
                prompt: '[分享] bilibili',
                meta: {
                  detail_1: {
                    qqdocurl: 'https://b23.tv/xxxxx',
                  },
                },
              }),
            },
          },
        ],
        raw_message: '',
      };

      const { content, images } = parseNormalizedContent(event);
      expect(content).toBe('[卡片消息:[分享] bilibili](https://b23.tv/xxxxx)');
      expect(images).toEqual([]);
    });

    it('EN-004-契约 34: 无链接纯公告卡片 (仅 title 无任何 url 字段)', () => {
      const event: OneBotMessageEvent = {
        post_type: 'message',
        message_type: 'group',
        sub_type: 'normal',
        message_id: 3004,
        group_id: 3000000001,
        user_id: 2000000001,
        time: 1788045820,
        self_id: BOT_QQ,
        sender: { user_id: 2000000001, nickname: '张三' },
        message: [
          {
            type: 'json',
            data: {
              data: JSON.stringify({
                app: 'com.tencent.card',
                prompt: '[公告] 维护通知',
                meta: {
                  detail_1: {
                    title: '系统维护通知',
                    desc: '今晚进行例行升级维护',
                  },
                },
              }),
            },
          },
        ],
        raw_message: '',
      };

      const { content, images } = parseNormalizedContent(event);
      expect(content).toBe('[卡片消息:系统维护通知]');
      expect(images).toEqual([]);
    });

    it('EN-004-契约 35: XML 音乐分享卡片解析 (<title> + picture cover + url)', () => {
      const event: OneBotMessageEvent = {
        post_type: 'message',
        message_type: 'group',
        sub_type: 'normal',
        message_id: 3005,
        group_id: 3000000001,
        user_id: 2000000001,
        time: 1788045820,
        self_id: BOT_QQ,
        sender: { user_id: 2000000001, nickname: '张三' },
        message: [
          {
            type: 'xml',
            data: {
              data: `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><msg serviceID="1" templateID="1" action="web" brief="[分享] 晴天" url="https://i.y.qq.com/v8/playsong.html?songmid=003aAPSN040BEs"><item layout="2"><picture cover="http://y.gtimg.cn/music/photo_new/xxx.jpg" /><title>晴天</title><summary>周杰伦</summary></item></msg>`,
            },
          },
        ],
        raw_message: '',
      };

      const { content, images } = parseNormalizedContent(event);
      expect(content).toBe(
        '[卡片消息:晴天](https://i.y.qq.com/v8/playsong.html?songmid=003aAPSN040BEs) [封面:http://y.gtimg.cn/music/photo_new/xxx.jpg]'
      );
      expect(images).toEqual(['http://y.gtimg.cn/music/photo_new/xxx.jpg']);
    });

    it('EN-004-契约 36: XML 实体反转义与损坏 JSON 容错降级', () => {
      // 1. XML 实体反转义
      const xmlEvent: OneBotMessageEvent = {
        post_type: 'message',
        message_type: 'group',
        sub_type: 'normal',
        message_id: 3006,
        group_id: 3000000001,
        user_id: 2000000001,
        time: 1788045820,
        self_id: BOT_QQ,
        sender: { user_id: 2000000001, nickname: '张三' },
        message: [
          {
            type: 'xml',
            data: {
              data: `<msg action="web" url="https://example.com/test?a=1&amp;b=2"><item><title>Tom &amp; Jerry &quot;Show&quot;</title><picture cover="https://example.com/img.png?x=1&amp;y=2"/></item></msg>`,
            },
          },
        ],
        raw_message: '',
      };

      const { content: xmlContent, images: xmlImages } = parseNormalizedContent(xmlEvent);
      expect(xmlContent).toBe(
        '[卡片消息:Tom & Jerry "Show"](https://example.com/test?a=1&b=2) [封面:https://example.com/img.png?x=1&y=2]'
      );
      expect(xmlImages).toEqual(['https://example.com/img.png?x=1&y=2']);

      // 2. 损坏 JSON 容错
      const corruptEvent: OneBotMessageEvent = {
        post_type: 'message',
        message_type: 'group',
        sub_type: 'normal',
        message_id: 3007,
        group_id: 3000000001,
        user_id: 2000000001,
        time: 1788045820,
        self_id: BOT_QQ,
        sender: { user_id: 2000000001, nickname: '张三' },
        message: [
          {
            type: 'json',
            data: {
              data: 'invalid json {{{',
            },
          },
        ],
        raw_message: '',
      };

      const { content: corruptContent } = parseNormalizedContent(corruptEvent);
      expect(corruptContent).toBe('[卡片消息:卡片消息]');
    });

    it('EN-004-契约 37: 真实私聊收到卡片消息唤醒 Prompt 组装闭环', async () => {
      const fixedDate = new Date(2026, 8, 1, 16, 20, 0);
      const event: OneBotMessageEvent = {
        post_type: 'message',
        message_type: 'private',
        sub_type: 'friend',
        message_id: 3008,
        user_id: 2000000001,
        time: Math.floor(fixedDate.getTime() / 1000),
        self_id: BOT_QQ,
        sender: { user_id: 2000000001, nickname: '张三' },
        message: [
          {
            type: 'json',
            data: {
              data: JSON.stringify({
                app: 'com.tencent.miniapp',
                prompt: '[QQ小程序]哔哩哔哩',
                meta: {
                  detail_1: {
                    title: '【深度学习】Transformer 从零手写实现',
                    preview: 'https://i0.hdslb.com/bfs/archive/12345.jpg',
                    qqdocurl: 'https://b23.tv/av123456',
                  },
                },
              }),
            },
          },
        ],
        raw_message: '',
      };

      const decision = await shouldWakeup(event, {
        bot_qq: BOT_QQ,
        bot_nickname: BOT_NICKNAME,
        aliases: ALIASES,
      });

      expect(decision.wakeup).toBe(true);
      expect(decision.payload).toBeDefined();
      expect(decision.payload?.images).toEqual(['https://i0.hdslb.com/bfs/archive/12345.jpg']);

      const prompt = formatWakeupPrompt(decision.payload!);
      expect(prompt).toContain(
        '[卡片消息:【深度学习】Transformer 从零手写实现](https://b23.tv/av123456) [封面:https://i0.hdslb.com/bfs/archive/12345.jpg]'
      );
    });

    it('EN-004-契约 38: 真实实机 B站小程序卡片 (样本 1684979878: 转义斜杠 + prompt/desc 标题提纯 + qqdocurl 直链)', () => {
      const event: OneBotMessageEvent = {
        post_type: 'message',
        message_type: 'group',
        sub_type: 'normal',
        message_id: 1684979878,
        group_id: 3000000001,
        user_id: 2794950199,
        time: 1788246335,
        self_id: BOT_QQ,
        sender: { user_id: 2794950199, nickname: '在这' },
        message: [
          {
            type: 'json',
            data: {
              data: JSON.stringify({
                ver: '1.0.0.19',
                prompt: '[QQ小程序]我讨厌黑色，却选择了墨岩',
                app: 'com.tencent.miniapp_01',
                meta: {
                  detail_1: {
                    appid: '1109937557',
                    title: '哔哩哔哩',
                    desc: '我讨厌黑色，却选择了墨岩',
                    icon: 'https://open.gtimg.cn/open/app_icon/00/95/17/76/100951776_100_m.png?t=1787736665',
                    preview: 'https://qq.ugcimg.cn/v1/08du1gpgshmqa998g5mlbujmlkihsgd9vu9u6p9j5bn4oidqqmvdvugn2t6ml1rtfb7sj0cgm9hj5ur7vp0oaj09op7kdinskflecr3akp7rkl4q05o5rmvabpqq7bnesngql8egougd5r0fupvhe3tl04/e9vf2tsqr6j29hl2kodb3vahlc',
                    url: 'm.q.qq.com/a/s/3b0f15c1f5e3bb76a5439fd09397295e',
                    qqdocurl: 'https://b23.tv/qSGBhv4?share_medium=android&share_source=qq&bbid=XXD8605D2B9502CF7816EC606686E7F683D68&ts=1788246331916',
                  },
                },
              }),
            },
          },
        ],
        raw_message: '',
      };

      const { content, images } = parseNormalizedContent(event);
      expect(content).toBe(
        '[卡片消息:[QQ小程序]我讨厌黑色，却选择了墨岩](https://b23.tv/qSGBhv4?share_medium=android&share_source=qq&bbid=XXD8605D2B9502CF7816EC606686E7F683D68&ts=1788246331916) [封面:https://qq.ugcimg.cn/v1/08du1gpgshmqa998g5mlbujmlkihsgd9vu9u6p9j5bn4oidqqmvdvugn2t6ml1rtfb7sj0cgm9hj5ur7vp0oaj09op7kdinskflecr3akp7rkl4q05o5rmvabpqq7bnesngql8egougd5r0fupvhe3tl04/e9vf2tsqr6j29hl2kodb3vahlc]'
      );
      expect(images).toEqual([
        'https://qq.ugcimg.cn/v1/08du1gpgshmqa998g5mlbujmlkihsgd9vu9u6p9j5bn4oidqqmvdvugn2t6ml1rtfb7sj0cgm9hj5ur7vp0oaj09op7kdinskflecr3akp7rkl4q05o5rmvabpqq7bnesngql8egougd5r0fupvhe3tl04/e9vf2tsqr6j29hl2kodb3vahlc',
      ]);
    });

    it('EN-004-契约 39: 真实实机 QQ经典农场小程序卡片 (样本 811158342: 无 qqdocurl + 裸域名 url 自动补全 https:// 协议头)', () => {
      const event: OneBotMessageEvent = {
        post_type: 'message',
        message_type: 'group',
        sub_type: 'normal',
        message_id: 811158342,
        group_id: 3000000001,
        user_id: 4000000001,
        time: 1788204857,
        self_id: BOT_QQ,
        sender: { user_id: 4000000001, nickname: 'UserA' },
        message: [
          {
            type: 'json',
            data: {
              data: JSON.stringify({
                app: 'com.tencent.miniapp_01',
                prompt: '[QQ小程序]免费午餐小善大爱，和农场共赴公益之约。',
                meta: {
                  detail_1: {
                    appid: '1112386029',
                    title: 'QQ经典农场',
                    desc: '免费午餐小善大爱，和农场共赴公益之约。',
                    preview: 'https://mmocgame.qpic.cn/wechatgame/u7rpbMopeABOSFryx0zgnDSbhc0MZswh2bXRO0TtFhQ1aaLLQky6EJUhCnqIEnU6/0',
                    url: 'm.q.qq.com/a/s/f3d277bbdf5faf296c189faacee73717',
                  },
                },
              }),
            },
          },
        ],
        raw_message: '',
      };

      const { content, images } = parseNormalizedContent(event);
      expect(content).toBe(
        '[卡片消息:[QQ小程序]免费午餐小善大爱，和农场共赴公益之约。](https://m.q.qq.com/a/s/f3d277bbdf5faf296c189faacee73717) [封面:https://mmocgame.qpic.cn/wechatgame/u7rpbMopeABOSFryx0zgnDSbhc0MZswh2bXRO0TtFhQ1aaLLQky6EJUhCnqIEnU6/0]'
      );
      expect(images).toEqual([
        'https://mmocgame.qpic.cn/wechatgame/u7rpbMopeABOSFryx0zgnDSbhc0MZswh2bXRO0TtFhQ1aaLLQky6EJUhCnqIEnU6/0',
      ]);
    });
  });
});


