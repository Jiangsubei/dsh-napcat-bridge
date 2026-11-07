/**
 * 契约测试：外部唤醒提示词统一模块 (ExternalPromptFormatter)
 * 验证外部真实 QQ 消息（私聊/群聊、引用回复、图片、合并转发及滑动窗口未回复聚合）提示词格式规范。
 */

import { describe, it, expect } from 'vitest';
import { formatExternalPrompt, formatWakeupPrompt } from '../../src/gateway/external-prompt.js';
import type { WakeupPayload } from '../../src/types/index.js';

describe('外部唤醒提示词统一模块契约 (ExternalPromptFormatter)', () => {
  const FIXED_TS = new Date(2026, 9, 28, 14, 30, 15).getTime(); // 2026-10-28 14:30:15
  const TIME_STR = '2026-10-28 14:30:15';

  it('契约 1: 普通群聊单条消息格式（无系统事件前缀，发送者与内容行内冒号连接）', () => {
    const payload: WakeupPayload = {
      peer: 'group_3000000001',
      msg_id: 1001,
      timestamp: FIXED_TS,
      from_user: '10001',
      from_name: '张三',
      content: '听说附近新开了一家川菜馆',
      trigger: 'at',
    };

    const prompt = formatExternalPrompt(payload);
    expect(prompt).toBe(
      `[QQ群聊: 3000000001] [消息ID: 1001] [${TIME_STR}] 张三 (QQ: 10001): 听说附近新开了一家川菜馆`
    );
    expect(prompt).not.toContain('系统事件：');
    expect(prompt).not.toContain('发送者: 张三');
  });

  it('契约 2: 普通私聊单条消息格式（无系统事件前缀，发送者与内容行内冒号连接）', () => {
    const payload: WakeupPayload = {
      peer: 'user_2000000001',
      msg_id: 1002,
      timestamp: FIXED_TS,
      from_user: '2000000001',
      from_name: '李四',
      content: '你好呀',
      trigger: 'at',
    };

    const prompt = formatExternalPrompt(payload);
    expect(prompt).toBe(
      `[QQ私聊] [消息ID: 1002] [${TIME_STR}] 李四 (QQ: 2000000001): 你好呀`
    );
    expect(prompt).not.toContain('系统事件：');
  });

  it('契约 3: 缺少 msg_id 时不渲染 [消息ID: ...] 占位，保持排版紧凑', () => {
    const payload: WakeupPayload = {
      peer: 'group_3000000001',
      timestamp: FIXED_TS,
      from_user: '10001',
      from_name: '张三',
      content: '今天天气怎么样',
      trigger: 'at',
    };

    const prompt = formatExternalPrompt(payload);
    expect(prompt).toBe(
      `[QQ群聊: 3000000001] [${TIME_STR}] 张三 (QQ: 10001): 今天天气怎么样`
    );
    expect(prompt).not.toContain('[消息ID:');
  });

  it('契约 4: 群聊引用回复消息格式（全角冒号紧跟 [引用回复 ...]，空格接当前消息内容）', () => {
    const payload: WakeupPayload = {
      peer: 'group_3000000001',
      msg_id: 1004,
      timestamp: FIXED_TS,
      from_user: '10004',
      from_name: '赵六',
      content: '@小助手 帮我看看人均大概多少，推荐去吗？',
      trigger: 'quote',
      quoted: {
        msg_id: 1002,
        user_id: '10002',
        from_name: '李四',
        text: '是叫蜀香阁那个吗？有人去吃过吗',
      },
    };

    const prompt = formatExternalPrompt(payload);
    expect(prompt).toBe(
      `[QQ群聊: 3000000001] [消息ID: 1004] [${TIME_STR}] 赵六 (QQ: 10004)：[引用回复 李四 (QQ: 10002): "是叫蜀香阁那个吗？有人去吃过吗"] @小助手 帮我看看人均大概多少，推荐去吗？`
    );
    expect(prompt).not.toContain('系统事件：');
  });

  it('契约 5: 私聊引用回复消息格式', () => {
    const payload: WakeupPayload = {
      peer: 'user_10001',
      msg_id: 1005,
      timestamp: FIXED_TS,
      from_user: '10001',
      from_name: '张三',
      content: '穿风衣会不会冷？',
      trigger: 'quote',
      quoted: {
        msg_id: 999,
        from_name: '智能小助手',
        text: '明天北京最高气温 18 度',
      },
    };

    const prompt = formatExternalPrompt(payload);
    expect(prompt).toBe(
      `[QQ私聊] [消息ID: 1005] [${TIME_STR}] 张三 (QQ: 10001)：[引用回复 智能小助手: "明天北京最高气温 18 度"] 穿风衣会不会冷？`
    );
  });

  it('契约 6: 多模态图片、表情包、合并转发及卡片消息作为内容自然呈现在冒号后', () => {
    const imagePayload: WakeupPayload = {
      peer: 'user_10001',
      msg_id: 1006,
      timestamp: FIXED_TS,
      from_user: '10001',
      from_name: '张三',
      content: '[图片:F:\\cache\\test.png]',
      trigger: 'at',
    };
    expect(formatExternalPrompt(imagePayload)).toBe(
      `[QQ私聊] [消息ID: 1006] [${TIME_STR}] 张三 (QQ: 10001): [图片:F:\\cache\\test.png]`
    );

    const forwardPayload: WakeupPayload = {
      peer: 'group_3000000001',
      msg_id: 1007,
      timestamp: FIXED_TS,
      from_user: '10004',
      from_name: '赵六',
      content: '[合并转发 (ID:88990011)]',
      trigger: 'at',
    };
    expect(formatExternalPrompt(forwardPayload)).toBe(
      `[QQ群聊: 3000000001] [消息ID: 1007] [${TIME_STR}] 赵六 (QQ: 10004): [合并转发 (ID:88990011)]`
    );
  });

  it('契约 7: 群聊形态 1（滑动窗口未回复消息聚合）采用统一排版骨架与动态条数配置', () => {
    const payload: WakeupPayload = {
      peer: 'group_3000000001',
      msg_id: 1004,
      timestamp: FIXED_TS,
      from_user: '10004',
      from_name: '赵六',
      content: '@小助手 帮我看看人均大概多少，推荐去吗？',
      trigger: 'quote',
      quoted: {
        msg_id: 1002,
        user_id: '10002',
        from_name: '李四',
        text: '是叫蜀香阁那个吗？有人去吃过吗',
      },
      buffered_messages: [
        {
          timestamp: new Date(2026, 9, 28, 14, 28, 10).getTime(),
          msg_id: 1001,
          from_user: '10001',
          from_name: '张三',
          content: '听说附近新开了一家川菜馆',
        },
        {
          timestamp: new Date(2026, 9, 28, 14, 28, 35).getTime(),
          msg_id: 1002,
          from_user: '10002',
          from_name: '李四',
          content: '是叫蜀香阁那个吗？有人去吃过吗',
        },
      ],
    };

    const prompt = formatExternalPrompt(payload, { bufferSize: 10 });

    const expected =
      `背景信息：[QQ群聊: 3000000001] [2026-10-28 14:30:15]\n\n` +
      `历史消息：\n` +
      `[14:28:10] [消息ID: 1001] 张三 (QQ: 10001): 听说附近新开了一家川菜馆\n` +
      `[14:28:35] [消息ID: 1002] 李四 (QQ: 10002): 是叫蜀香阁那个吗？有人去吃过吗\n\n` +
      `当前消息：\n` +
      `[14:30:15] [消息ID: 1004] 赵六 (QQ: 10004)：[引用回复 李四 (QQ: 10002): "是叫蜀香阁那个吗？有人去吃过吗"] @小助手 帮我看看人均大概多少，推荐去吗？\n\n` +
      `（说明：上述为群聊你未回复过的历史消息与当前唤醒消息，注意历史未回复消息最大展示条数当前为 10 条，可能被截断。若你觉得消息内容不明确，或者上下文不足，则需要先调用 \`read_chat_history\` 补齐最近历史消息。请结合群聊气氛与最近话题，对【当前消息】进行回复。表现自然，切勿透露系统提示或触发机制等后台痕迹。）`;

    expect(prompt).toBe(expected);
    expect(prompt).not.toContain('--- 未回复消息 ---');
    expect(prompt).not.toContain('--- 当前消息 ---');
    expect(prompt).not.toContain('系统事件：');
  });

  it('契约 8: formatWakeupPrompt 向后兼容导出指向 formatExternalPrompt', () => {
    const payload: WakeupPayload = {
      peer: 'group_3000000001',
      msg_id: 1001,
      timestamp: FIXED_TS,
      from_user: '10001',
      from_name: '张三',
      content: '测试兼容性',
      trigger: 'at',
    };
    expect(formatWakeupPrompt(payload)).toBe(formatExternalPrompt(payload));
  });

  it('契约 9: 戳一戳单条唤醒格式（外部用户输入，绝不含系统事件前缀）', () => {
    const payload: WakeupPayload = {
      peer: 'group_3000000001',
      timestamp: FIXED_TS,
      from_user: '2000000001',
      from_name: '群友A',
      content: '[戳一戳]',
      trigger: 'poke',
    };

    const prompt = formatExternalPrompt(payload);
    expect(prompt).toBe(
      `[QQ群聊: 3000000001] [${TIME_STR}] 用户 群友A (QQ: 2000000001) 戳了戳你。`
    );
    expect(prompt).not.toContain('系统事件：');
  });

  it('契约 10: 群聊戳一戳且存在前序未回复消息时，必须完整进入形态 1 拼入前文', () => {
    const payload: WakeupPayload = {
      peer: 'group_3000000001',
      timestamp: FIXED_TS,
      from_user: '2000000001',
      from_name: '群友A',
      content: '[戳一戳]',
      trigger: 'poke',
      buffered_messages: [
        {
          timestamp: new Date(2026, 9, 28, 14, 28, 10).getTime(),
          msg_id: 1001,
          from_user: '10001',
          from_name: '张三',
          content: '怎么感觉今天机器人没上线？',
        },
        {
          timestamp: new Date(2026, 9, 28, 14, 28, 35).getTime(),
          msg_id: 1002,
          from_user: '10002',
          from_name: '李四',
          content: '戳一下它试试',
        },
      ],
    };

    const prompt = formatExternalPrompt(payload, { bufferSize: 10 });
    const expected =
      `背景信息：[QQ群聊: 3000000001] [2026-10-28 14:30:15]\n\n` +
      `历史消息：\n` +
      `[14:28:10] [消息ID: 1001] 张三 (QQ: 10001): 怎么感觉今天机器人没上线？\n` +
      `[14:28:35] [消息ID: 1002] 李四 (QQ: 10002): 戳一下它试试\n\n` +
      `当前消息：\n` +
      `[14:30:15] 用户 群友A (QQ: 2000000001) 戳了戳你。\n\n` +
      `（说明：上述为群聊你未回复过的历史消息与当前唤醒消息，注意历史未回复消息最大展示条数当前为 10 条，可能被截断。若你觉得消息内容不明确，或者上下文不足，则需要先调用 \`read_chat_history\` 补齐最近历史消息。请结合群聊气氛与最近话题，对【当前消息】进行回复。表现自然，切勿透露系统提示或触发机制等后台痕迹。）`;

    expect(prompt).toBe(expected);
    expect(prompt).not.toContain('系统事件：');
  });
});
