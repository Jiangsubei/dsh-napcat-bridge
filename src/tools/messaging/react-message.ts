/**
 * dsh-napcat-bridge: 贴表情回应工具 (react_message)
 */

import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { ReactMessageParams, ReactMessageResult } from '../../types/index.js';
import { EMOJI_MAP } from '../../types/index.js';
import {
  type ToolExecutionContext,
  type ContextSource,
  getGlobalToolContext,
  resolveToolContext,
  normalizePeer,
} from '../common/context.js';
import { toLosslessJson } from '../../utils/lossless-json.js';

export type { ReactMessageParams, ReactMessageResult };
export { EMOJI_MAP };

/**
 * 6.8 贴表情回应工具 (react_message)
 * 通过 NapCat OneBot 11 扩展接口 set_msg_emoji_like 对群聊消息添加表情回应。
 */
export async function reactMessage(
  params: ReactMessageParams,
  context?: ToolExecutionContext
): Promise<ReactMessageResult> {
  const ctx = { ...getGlobalToolContext(), ...context };

  if (!params || !params.emoji || typeof params.emoji !== 'string' || !(params.emoji in EMOJI_MAP)) {
    return {
      success: false,
      error: `未知的表情名 '${params?.emoji}'。请从以下支持的表情中选择: ${Object.keys(EMOJI_MAP).join(', ')}`,
    };
  }

  const key = params.emoji;
  const item = EMOJI_MAP[key];

  let msgId: number | undefined;
  if (params.message_id !== undefined && params.message_id !== null && String(params.message_id).trim() !== '') {
    const parsed = Number(params.message_id);
    if (!Number.isNaN(parsed)) {
      msgId = parsed;
    }
  }

  if (msgId === undefined) {
    const peer = ctx.peer || '';
    if (ctx.inboundMsgIdGetter) {
      msgId = ctx.inboundMsgIdGetter(peer) ?? ctx.inboundMsgIdGetter(normalizePeer(peer));
    }
  }

  if (msgId === undefined || Number.isNaN(msgId)) {
    return {
      success: false,
      error: '未提供 message_id 且当前回合无入站消息上下文',
    };
  }

  if (!ctx.gateway) {
    return {
      success: false,
      error: 'NapCat 未连接 (gateway 不可用)',
    };
  }

  try {
    const res = await ctx.gateway.setMsgEmojiLike(msgId, item.id);
    if (res && (res.status === 'failed' || (typeof res.retcode === 'number' && res.retcode !== 0))) {
      return {
        success: false,
        error: res.wording || res.message || `NapCat API 调用失败 (retcode: ${res.retcode})`,
      };
    }
    return {
      success: true,
      message_id: msgId,
      emoji: key,
      emoji_id: item.id,
    };
  } catch (err: any) {
    return {
      success: false,
      error: err?.message || '未知错误',
    };
  }
}

export function createReactMessageTool(context?: ContextSource): ToolDefinition {
  return defineTool({
    name: 'react_message',
    description:
      '为当前或指定入站消息贴一个小表情回应，本工具受 QQ 功能限制仅限群聊可用，私聊会话不可用且会被系统拦截。用于在群聊中对群友的调侃、搞笑图、日常问候做快速情绪化表态，或确认收到指令；无需冗长文字即可生动闭环；如果在私聊场景下需要回复或确认，请直接调用 send_qq_message 发送文本。',
    parameters: {
      emoji: {
        type: 'string',
        required: true,
        enum: Object.keys(EMOJI_MAP),
        description:
          '表情语义键（对应 QQ 群消息回应表情）。可选值与具体语境含义：\n' +
          '- thumbs_up: 点赞 / 收到 / 认可\n' +
          '- heart: 爱心 / 喜爱 / 感谢支持\n' +
          '- laugh: 笑哭 / 搞笑 / 无奈破防\n' +
          '- grin: 呲牙 / 开心笑 / 友好打招呼\n' +
          '- snicker: 偷笑 / 窃喜 / 暗爽使坏\n' +
          '- doge: 狗头 / 滑稽调侃 / 友军反讽防误伤\n' +
          '- ok: OK / 确认收到 / 没问题\n' +
          '- cry: 大哭 / 难过 / 心疼太惨了\n' +
          '- grievance: 委屈 / 可怜巴巴 / 受委屈\n' +
          '- hug: 抱抱 / 温暖安慰 / 抱团\n' +
          '- rose: 玫瑰 / 鲜花 / 感谢致意\n' +
          '- cheer: 打call / 加油应援 / 振奋\n' +
          '- touch_fish: 摸鱼 / 划水 / 下班偷闲\n' +
          '- celebrate: 礼花 / 庆祝 / 大吉恭喜\n' +
          '- cute: 卖萌 / 可爱乖巧\n' +
          '- thinking: 托腮 / 思考琢磨 / 好奇观望\n' +
          '- sweat: 辣眼睛 / 尴尬 / 汗颜无语\n' +
          '- cat: 喵喵 / 猫咪卖萌 / 嗷呜\n' +
          '- skull: 骷髅头 / 寄了 / 完蛋暴毙 / 吓人\n' +
          '- poop: 便便 / 恶搞吐槽 / 嫌弃\n' +
          '- pig: 猪头 / 笨蛋调侃 / 亲切吐槽\n' +
          '- button: 狂按按钮 / 强烈赞同(+10086) / 疯狂催促\n' +
          '- hammer: 木槌敲头 / 敲打制裁 / 清醒一下\n' +
          '- baldy: 头秃 / 掉发 / 码农太难了\n' +
          '- victim: 大怨种 / 倒霉背锅 / 冤大头\n' +
          '- rage: 爆筋 / 生气愤怒 / 忍无可忍',
      },
      message_id: {
        oneOf: [{ type: 'number' }, { type: 'string' }],
        description: '要回应的目标消息 ID（支持数字或数字字符串）。可省略，省略时自动绑定当前回合正在回复的入站消息',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (args, value) => {
        const v = value as any;
        if (v?.success) {
          const item = EMOJI_MAP[v.emoji || args?.emoji];
          const emojiName = item ? item.name : (v?.emoji || args?.emoji);
          return [
            {
              type: 'text',
              text: `已对消息 ${v.message_id} 贴表情 [${emojiName}]`,
            },
          ];
        }
        return [
          {
            type: 'text',
            text: `贴表情失败: ${v?.error}`,
          },
        ];
      },
    },
    async execute(args, exec) {
      const session = (exec.agent as any)?.session;
      const rawPeer = session?.id || (exec.agent as any)?.sessionId || '';
      const peer = normalizePeer(rawPeer);
      const isQQGroup = Boolean(
        rawPeer.startsWith('qq-group-') ||
        peer.startsWith('group_') ||
        rawPeer.startsWith('group_')
      );
      if (!isQQGroup) {
        throw new Error('dsh-napcat-bridge: react_message 工具仅限群聊调用，当前会话不可执行');
      }
      const resolved = resolveToolContext(context);
      const res = (await reactMessage(args, {
        ...resolved,
        gateway: resolved.gateway,
        inboundMsgIdGetter: resolved.inboundMsgIdGetter,
        peer,
      })) as any;
      if (res && res.success === false) {
        throw new Error(res.error || 'react_message 失败');
      }
      return toLosslessJson(res) as any;
    },
  });
}
