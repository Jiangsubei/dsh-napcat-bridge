/**
 * dsh-napcat-bridge: 配置 Schema 定义
 * 基于 @deepseek-ai/schemastery 定义插件配置项与 Web UI 设置卡片结构。
 */

import z from '@deepseek-ai/schemastery';
import {
  DEFAULT_WS_PORT,
  DEFAULT_IMAGE_TTL_DAYS,
  DEFAULT_PERSONA,
  DEFAULT_BEHAVIOR,
  DEFAULT_PROACTIVE_REPLY_ENABLED,
  DEFAULT_PROACTIVE_ONLY_TEXT_ENABLED,
  DEFAULT_PROACTIVE_RANDOM_ENABLED,
  DEFAULT_PROACTIVE_RANDOM_PROBABILITY,
  DEFAULT_PROACTIVE_IDLE_ENABLED,
  DEFAULT_PROACTIVE_IDLE_TIMEOUT_MINS,
  DEFAULT_PROACTIVE_COOLDOWN_MINS,
  DEFAULT_PROACTIVE_NIGHT_DND,
  DEFAULT_MEMORY_DIR,
  DEFAULT_MEMORY_BUDGET_CHARS,
  DEFAULT_REVIEW_ENABLED,
  DEFAULT_REVIEW_TURNS_INTERVAL,
  DEFAULT_REVIEW_TOOL_CALLS_INTERVAL,
} from '../constants/index.js';
import type { BridgePluginConfig } from '../types/index.js';

export const BridgeConfigSchema: z<BridgePluginConfig> = z.object({
  ws_port: z.number().default(DEFAULT_WS_PORT).description('WebSocket 服务端监听端口 (NapCat 反向 WS 连接目标)'),
  ws_token: z.string().default('').description('NapCat 连接鉴权 Token (留空不鉴权)'),
  bot_qq: z.string().default('').description('机器人自身 QQ 号 (用于自循环防护与识别锚点，留空则自动降级并在启动时告警)'),
  admins: z.array(z.string()).default([]).description('管理员 QQ 号白名单 (斜杠命令授权)'),
  aliases: z.array(z.string()).default([]).description('助手点名别名列表 (群聊点名唤醒)'),
  at_questioner: z.boolean().default(false).description('群聊回复是否 @提问者'),
  quote_original: z.boolean().default(true).description('群聊回复是否引用原消息'),
  image_ttl_days: z.number().default(DEFAULT_IMAGE_TTL_DAYS).description('外来图片/资源本地缓存保留天数'),
  persona: z.string().default(DEFAULT_PERSONA).description('助手人格设定 (注入 SystemPrompt 动态段)'),
  behavior: z.string().default(DEFAULT_BEHAVIOR).description('行为约束准则 (注入 SystemPrompt 动态段)'),
  proactive_reply_enabled: z.boolean().default(DEFAULT_PROACTIVE_REPLY_ENABLED).description('启用群聊主动回复功能 (总开关)'),
  proactive_only_text: z.boolean().default(DEFAULT_PROACTIVE_ONLY_TEXT_ENABLED).description('仅回复文本内容（纯文本模型专用）：开启后仅对纯文本消息触发主动回复，视频/图片/表情包等多模态消息一律不主动回复'),
  proactive_random_enabled: z.boolean().default(DEFAULT_PROACTIVE_RANDOM_ENABLED).description('启用群聊普通消息随机概率唤醒'),
  proactive_random_probability: z.number().default(DEFAULT_PROACTIVE_RANDOM_PROBABILITY).description('群聊普通消息随机唤醒概率 (0~1 之间的小数，如 0.05 代表 5%)'),
  proactive_idle_enabled: z.boolean().default(DEFAULT_PROACTIVE_IDLE_ENABLED).description('启用群聊潜水超时主动唤醒 (冷场冒泡)'),
  proactive_idle_timeout_mins: z.number().default(DEFAULT_PROACTIVE_IDLE_TIMEOUT_MINS).description('群聊潜水判定时长阈值 (单位: 分钟，默认 120 分钟)'),
  proactive_cooldown_mins: z.number().default(DEFAULT_PROACTIVE_COOLDOWN_MINS).description('主动回复冷却时间 (单位: 分钟，防止频繁插话打扰)'),
  proactive_night_dnd: z.boolean().default(DEFAULT_PROACTIVE_NIGHT_DND).description('夜间免打扰 (每日 23:00~08:00 暂停主动回复)'),
  memory_storage_dir: z.string().default(DEFAULT_MEMORY_DIR).description('记忆 Markdown 文件存储根目录 (默认 .dsh/napcat/napcat_memory)'),
  memory_budget_chars: z.number().default(DEFAULT_MEMORY_BUDGET_CHARS).description('群聊用户画像注入总字符预算上限 (默认 2200)'),
  review_enabled: z.boolean().default(DEFAULT_REVIEW_ENABLED).description('启用后台自动回顾 (定时分析对话提炼群规与用户画像)'),
  review_turns_interval: z.number().default(DEFAULT_REVIEW_TURNS_INTERVAL).description('后台回顾触发的对话轮次间隔 (默认 10 轮)'),
  review_tool_calls_interval: z.number().default(DEFAULT_REVIEW_TOOL_CALLS_INTERVAL).description('后台回顾触发的工具调用次数间隔 (默认 10 次)'),
  review_model: z.string().default('').description('后台回顾使用的独立子模型名称 (可选，留空继承主模型)'),
});

