import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  IconChevronDownOutline14: () => null,
}));

import { BridgeConfigSchema } from '../../src/config/schema.js';
import {
  DEFAULT_PROACTIVE_ONLY_TEXT_ENABLED,
  DEFAULT_PROACTIVE_REPLY_ENABLED,
  DEFAULT_PROACTIVE_RANDOM_ENABLED,
} from '../../src/constants/index.js';
import {
  isExcludedFromProactive,
  shouldWakeup,
  type WakeupOptions,
} from '../../src/gateway/wakeup.js';
import { NapCatFormModel } from '../../src/client/model.js';
import { NapCatSettingsCard } from '../../src/client/card.js';
import type { OneBotMessageEvent } from '../../src/types/index.js';

describe('契约测试: 仅回复文本内容开关 (proactive_only_text)', () => {
  const BOT_QQ = '1000000001';
  const GROUP_ID = 3000000001;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('1. 常量与 Schema 契约', () => {
    it('DEFAULT_PROACTIVE_ONLY_TEXT_ENABLED 默认值必须为 false', () => {
      expect(DEFAULT_PROACTIVE_ONLY_TEXT_ENABLED).toBe(false);
    });

    it('BridgeConfigSchema 默认值中 proactive_only_text 为 false', () => {
      const parsed = BridgeConfigSchema({});
      expect(parsed.proactive_only_text).toBe(false);
    });

    it('BridgeConfigSchema 支持显式传入 true 与 false', () => {
      const parsedTrue = BridgeConfigSchema({ proactive_only_text: true });
      expect(parsedTrue.proactive_only_text).toBe(true);

      const parsedFalse = BridgeConfigSchema({ proactive_only_text: false });
      expect(parsedFalse.proactive_only_text).toBe(false);
    });
  });

  describe('2. isExcludedFromProactive 排除逻辑契约', () => {
    const createEventWithSegments = (
      segments: any[],
      raw = 'raw text'
    ): OneBotMessageEvent => ({
      post_type: 'message',
      message_type: 'group',
      sub_type: 'normal',
      message_id: 1001,
      group_id: GROUP_ID,
      user_id: 2000000001,
      time: 1788045525,
      self_id: BOT_QQ,
      sender: { user_id: 2000000001, nickname: '张三' },
      message: segments,
      raw_message: raw,
    });

    describe('开启状态 (onlyText = true)', () => {
      it('纯文本消息 (text) 不排除 (返回 false)', () => {
        const ev = createEventWithSegments([
          { type: 'text', data: { text: '大家中午好，今天讨论什么话题？' } },
        ]);
        expect(isExcludedFromProactive(ev, true)).toBe(false);
      });

      it('文本 + @ (text + at) 不排除 (返回 false)', () => {
        const ev = createEventWithSegments([
          { type: 'at', data: { qq: '2000000002' } },
          { type: 'text', data: { text: ' 吃了没？' } },
        ]);
        expect(isExcludedFromProactive(ev, true)).toBe(false);
      });

      it('文本 + 引用 (text + reply) 不排除 (返回 false)', () => {
        const ev = createEventWithSegments([
          { type: 'reply', data: { id: '9999' } },
          { type: 'text', data: { text: '确实如此' } },
        ]);
        expect(isExcludedFromProactive(ev, true)).toBe(false);
      });

      it('文本 + @ + 引用 (text + at + reply) 不排除 (返回 false)', () => {
        const ev = createEventWithSegments([
          { type: 'reply', data: { id: '9999' } },
          { type: 'at', data: { qq: '2000000002' } },
          { type: 'text', data: { text: '同意这个观点' } },
        ]);
        expect(isExcludedFromProactive(ev, true)).toBe(false);
      });

      it('包含图片 (image) 的单媒体或图文混合消息必须排除 (返回 true)', () => {
        const pureImg = createEventWithSegments([
          { type: 'image', data: { file: 'test.png', url: 'https://example.com/test.png' } },
        ]);
        expect(isExcludedFromProactive(pureImg, true)).toBe(true);

        const mixedImg = createEventWithSegments([
          { type: 'text', data: { text: '看看这张图' } },
          { type: 'image', data: { file: 'test.png', url: 'https://example.com/test.png' } },
        ]);
        expect(isExcludedFromProactive(mixedImg, true)).toBe(true);
      });

      it('包含系统表情/大表情 (face / mface / marketface) 必须排除 (返回 true)', () => {
        const faceEv = createEventWithSegments([
          { type: 'text', data: { text: '好呀' } },
          { type: 'face', data: { id: 14 } },
        ]);
        expect(isExcludedFromProactive(faceEv, true)).toBe(true);

        const mfaceEv = createEventWithSegments([
          { type: 'mface', data: { summary: '[动画表情]' } },
        ]);
        expect(isExcludedFromProactive(mfaceEv, true)).toBe(true);

        const marketfaceEv = createEventWithSegments([
          { type: 'marketface', data: { id: 'market_123' } },
        ]);
        expect(isExcludedFromProactive(marketfaceEv, true)).toBe(true);
      });

      it('包含视频 (video)、语音 (record)、文件 (file) 必须排除 (返回 true)', () => {
        const videoEv = createEventWithSegments([
          { type: 'video', data: { file: 'v.mp4' } },
        ]);
        expect(isExcludedFromProactive(videoEv, true)).toBe(true);

        const recordEv = createEventWithSegments([
          { type: 'record', data: { file: 'voice.amr' } },
        ]);
        expect(isExcludedFromProactive(recordEv, true)).toBe(true);

        const fileEv = createEventWithSegments([
          { type: 'file', data: { file_id: 'f1', file_name: 'doc.pdf' } },
        ]);
        expect(isExcludedFromProactive(fileEv, true)).toBe(true);
      });

      it('包含卡片/合并转发等非文本段 (forward / json / xml) 必须排除 (返回 true)', () => {
        const fwdEv = createEventWithSegments([
          { type: 'forward', data: { id: 'fwd_123' } },
        ]);
        expect(isExcludedFromProactive(fwdEv, true)).toBe(true);

        const jsonEv = createEventWithSegments([
          { type: 'json', data: { data: '{}' } },
        ]);
        expect(isExcludedFromProactive(jsonEv, true)).toBe(true);
      });

      describe('raw_message 兜底正则逻辑 (当 segments 为空)', () => {
        it('纯文本 raw_message 不排除 (返回 false)', () => {
          const ev = createEventWithSegments([], '纯文本消息内容');
          expect(isExcludedFromProactive(ev, true)).toBe(false);
        });

        it('含 [CQ:at] 或 [CQ:reply] 的 raw_message 不排除 (返回 false)', () => {
          const evAt = createEventWithSegments([], '[CQ:at,qq=2000000002] 吃了吗？');
          expect(isExcludedFromProactive(evAt, true)).toBe(false);

          const evReply = createEventWithSegments([], '[CQ:reply,id=1001] 好的');
          expect(isExcludedFromProactive(evReply, true)).toBe(false);
        });

        it('含多模态 CQ 码的 raw_message 必须排除 (返回 true)', () => {
          expect(isExcludedFromProactive(createEventWithSegments([], '看图[CQ:image,file=a.jpg]'), true)).toBe(true);
          expect(isExcludedFromProactive(createEventWithSegments([], '[CQ:face,id=14]'), true)).toBe(true);
          expect(isExcludedFromProactive(createEventWithSegments([], '[CQ:mface,summary=动画表情]'), true)).toBe(true);
          expect(isExcludedFromProactive(createEventWithSegments([], '[CQ:video,file=b.mp4]'), true)).toBe(true);
          expect(isExcludedFromProactive(createEventWithSegments([], '[CQ:record,file=c.amr]'), true)).toBe(true);
          expect(isExcludedFromProactive(createEventWithSegments([], '[CQ:file,file_id=d123]'), true)).toBe(true);
        });
      });
    });

    describe('关闭状态 (onlyText = false，保持现有行为)', () => {
      it('默认不传 onlyText 时，图文混排与普通图片允许通过', () => {
        const mixedImg = createEventWithSegments([
          { type: 'text', data: { text: '大家看这张图' } },
          { type: 'image', data: { file: 'test.png' } },
        ]);
        expect(isExcludedFromProactive(mixedImg)).toBe(false);
        expect(isExcludedFromProactive(mixedImg, false)).toBe(false);
      });

      it('默认不传 onlyText 时，合并转发允许通过', () => {
        const fwdEv = createEventWithSegments([
          { type: 'forward', data: { id: 'fwd_123' } },
        ]);
        expect(isExcludedFromProactive(fwdEv)).toBe(false);
        expect(isExcludedFromProactive(fwdEv, false)).toBe(false);
      });

      it('默认不传 onlyText 时，视频/语音/纯单表情依然被既有逻辑排除', () => {
        const videoEv = createEventWithSegments([
          { type: 'video', data: { file: 'v.mp4' } },
        ]);
        expect(isExcludedFromProactive(videoEv)).toBe(true);

        const recordEv = createEventWithSegments([
          { type: 'record', data: { file: 'v.amr' } },
        ]);
        expect(isExcludedFromProactive(recordEv)).toBe(true);
      });
    });
  });

  describe('3. shouldWakeup 装配闭环契约', () => {
    it('proactive_only_text = true 时，图文混合消息即使命中概率也不唤醒', async () => {
      const mixedImgEvent: OneBotMessageEvent = {
        post_type: 'message',
        message_type: 'group',
        sub_type: 'normal',
        message_id: 1108,
        group_id: GROUP_ID,
        user_id: 2000000001,
        time: 1788045525,
        self_id: BOT_QQ,
        sender: { user_id: 2000000001, nickname: '张三' },
        message: [
          { type: 'text', data: { text: '大家看这张图' } },
          { type: 'image', data: { file: 'photo.jpg' } },
        ],
        raw_message: '大家看这张图[CQ:image,file=photo.jpg]',
      };

      vi.spyOn(Math, 'random').mockReturnValue(0.01);

      const decision = await shouldWakeup(mixedImgEvent, {
        bot_qq: BOT_QQ,
        proactive: {
          proactive_reply_enabled: true,
          proactive_random_enabled: true,
          proactive_random_probability: 1.0,
          proactive_only_text: true,
          proactive_night_dnd: false,
        },
      });

      expect(decision.wakeup).toBe(false);
    });

    it('proactive_only_text = true 时，纯文本消息命中概率正常主动唤醒', async () => {
      const textEvent: OneBotMessageEvent = {
        post_type: 'message',
        message_type: 'group',
        sub_type: 'normal',
        message_id: 1109,
        group_id: GROUP_ID,
        user_id: 2000000001,
        time: 1788045525,
        self_id: BOT_QQ,
        sender: { user_id: 2000000001, nickname: '张三' },
        message: [
          { type: 'text', data: { text: '今天大家过得怎么样' } },
        ],
        raw_message: '今天大家过得怎么样',
      };

      vi.spyOn(Math, 'random').mockReturnValue(0.01);

      const decision = await shouldWakeup(textEvent, {
        bot_qq: BOT_QQ,
        proactive: {
          proactive_reply_enabled: true,
          proactive_random_enabled: true,
          proactive_random_probability: 1.0,
          proactive_only_text: true,
          proactive_night_dnd: false,
        },
      });

      expect(decision.wakeup).toBe(true);
      expect(decision.trigger).toBe('proactive');
    });

    it('proactive_only_text = false (默认) 时，图文混合消息命中概率依然正常主动唤醒', async () => {
      const mixedImgEvent: OneBotMessageEvent = {
        post_type: 'message',
        message_type: 'group',
        sub_type: 'normal',
        message_id: 1110,
        group_id: GROUP_ID,
        user_id: 2000000001,
        time: 1788045525,
        self_id: BOT_QQ,
        sender: { user_id: 2000000001, nickname: '张三' },
        message: [
          { type: 'text', data: { text: '大家看这张图' } },
          { type: 'image', data: { file: 'photo.jpg' } },
        ],
        raw_message: '大家看这张图[CQ:image,file=photo.jpg]',
      };

      vi.spyOn(Math, 'random').mockReturnValue(0.01);

      const decision = await shouldWakeup(mixedImgEvent, {
        bot_qq: BOT_QQ,
        proactive: {
          proactive_reply_enabled: true,
          proactive_random_enabled: true,
          proactive_random_probability: 1.0,
          proactive_only_text: false,
          proactive_night_dnd: false,
        },
      });

      expect(decision.wakeup).toBe(true);
      expect(decision.trigger).toBe('proactive');
    });
  });

  describe('4. Client Card & Model 属性契约', () => {
    it('NapCatFormModel 支持 proactive_only_text 的读写与重置', () => {
      const model = new NapCatFormModel({
        initialValues: { proactive_only_text: false },
        baseDefaults: { proactive_only_text: false },
      });

      expect(model.getDraft().proactive_only_text).toBe(false);
      expect(model.isOverridden('proactive_only_text')).toBe(false);

      model.setField('proactive_only_text', true);
      expect(model.getDraft().proactive_only_text).toBe(true);
      expect(model.isOverridden('proactive_only_text')).toBe(true);

      model.resetField('proactive_only_text');
      expect(model.getDraft().proactive_only_text).toBe(false);
      expect(model.isOverridden('proactive_only_text')).toBe(false);
    });

    it('NapCatSettingsCard 包含仅回复文本内容开关，并在总开关关闭时禁用', () => {
      const htmlDisabled = renderToStaticMarkup(
        React.createElement(NapCatSettingsCard, {
          initialConfig: { proactive_reply_enabled: false },
        })
      );
      expect(htmlDisabled).toContain('napcat-proactive-only-text');
      expect(htmlDisabled).toContain('仅回复文本内容');
      expect(htmlDisabled).toMatch(/id="napcat-proactive-only-text"[^>]*disabled/);

      const htmlEnabled = renderToStaticMarkup(
        React.createElement(NapCatSettingsCard, {
          initialConfig: { proactive_reply_enabled: true },
        })
      );
      expect(htmlEnabled).toContain('napcat-proactive-only-text');
      expect(htmlEnabled).not.toMatch(/id="napcat-proactive-only-text"[^>]*disabled/);
    });
  });
});
