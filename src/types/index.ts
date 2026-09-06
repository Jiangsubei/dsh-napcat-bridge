/**
 * dsh-napcat-bridge: 核心类型定义
 * 包含 OneBot 11 协议事件与消息段、唤醒包、存储表结构、工具入参出参以及配置类型。
 */

// ==================== 1. OneBot 11 协议类型 ====================

export type OneBotPostType = 'message' | 'message_sent' | 'notice' | 'request' | 'meta_event';

export type OneBotMessageType = 'group' | 'private';

export interface OneBotSender {
  user_id: number | string;
  nickname: string;
  card?: string;
  role?: 'owner' | 'admin' | 'member';
  sex?: string;
  age?: number;
}

export type OneBotSegmentType =
  | 'text'
  | 'face'
  | 'image'
  | 'record'
  | 'video'
  | 'at'
  | 'reply'
  | 'file'
  | 'forward'
  | 'json'
  | 'xml'
  | 'poke'
  | 'shake'
  | 'rps'
  | 'dice'
  | 'contact'
  | 'location'
  | 'music'
  | 'share'
  | 'mface' // NapCat 市场表情/商城表情扩展
  | 'marketface'; // NapCat 市场表情扩展

export interface OneBotSegment<T = Record<string, any>> {
  type: OneBotSegmentType | string;
  data: T;
}

export interface OneBotTextSegment extends OneBotSegment<{ text: string }> {
  type: 'text';
}

export interface OneBotFaceSegment extends OneBotSegment<{ id: string; raw?: { faceIndex?: number; faceText?: string } }> {
  type: 'face';
}

export interface OneBotImageSegment extends OneBotSegment<{
  file: string;
  url?: string;
  sub_type?: number;
  file_size?: string | number;
  summary?: string;
  emoji_package_id?: number;
  emoji_id?: string;
}> {
  type: 'image';
}

export interface OneBotAtSegment extends OneBotSegment<{ qq: string | number }> {
  type: 'at';
}

export interface OneBotReplySegment extends OneBotSegment<{ id: string | number }> {
  type: 'reply';
}

export interface OneBotFileSegment extends OneBotSegment<{
  file: string;
  file_id: string;
  file_size?: string | number;
  busid?: number;
}> {
  type: 'file';
}

export interface OneBotForwardSegment extends OneBotSegment<{ id: string }> {
  type: 'forward';
}

export interface OneBotMessageEvent {
  post_type: 'message' | 'message_sent';
  message_type: OneBotMessageType;
  sub_type: string;
  message_id: number;
  message_seq?: number;
  real_id?: number;
  real_seq?: string;
  user_id: number | string;
  group_id?: number | string;
  group_name?: string;
  target_id?: number | string;
  sender: OneBotSender;
  message: OneBotSegment[];
  raw_message: string;
  font?: number;
  time: number;
  self_id: number | string;
}

export interface OneBotNoticeEvent {
  post_type: 'notice';
  notice_type: string;
  sub_type?: string;
  time: number;
  self_id: number | string;
  user_id?: number | string;
  sender_id?: number | string;
  target_id?: number | string;
  group_id?: number | string;
  operator_id?: number | string;
  message_id?: number;
  file?: {
    id: string;
    name: string;
    size: number;
    busid?: number;
    url?: string;
  };
  raw_info?: any[];
}

export interface OneBotMetaEvent {
  post_type: 'meta_event';
  meta_event_type: 'lifecycle' | 'heartbeat';
  sub_type?: string;
  time: number;
  self_id: number | string;
  status?: any;
  interval?: number;
}

export interface OneBotActionResponse<T = any> {
  status: 'ok' | 'failed' | string;
  retcode: number;
  data: T;
  message?: string;
  wording?: string;
  echo?: string;
}

// ==================== 2. 唤醒包契约 ====================

export type WakeupTriggerType = 'at' | 'mention' | 'quote' | 'poke' | 'proactive';

export interface WakeupPayload {
  trigger: WakeupTriggerType | 'direct';
  /** 主动回复触发子类型: random (普通消息概率插话) | idle (潜水超时冒泡) */
  sub_trigger?: 'random' | 'idle';
  peer: string;
  from_user: string;
  from_name: string;
  content: string;
  quoted?: {
    msg_id: number;
    user_id: string;
    from_name: string;
    text: string;
    images?: string[];
  };
  images?: string[];
  timestamp: number;
}

// ==================== 3. 存储表契约 ====================

export interface MessageRecord {
  msg_id: number;
  peer: string;
  user_id: string;
  sender_name: string;
  time: number; // 毫秒时间戳
  type: string;
  content: string;
  raw: string; // 原始 JSON 字符串
  file_id: string | null;
  busid: number | null;
  local_path: string | null;
  fingerprint: string | null;
  recalled: number; // 0 | 1
  self: number; // 0 | 1
  reply_to: number | null;
}

// ==================== 4. 工具入参/出参 Schema ====================

export interface ReadChatHistoryParams {
  /** 按指定发送者 QQ 号精确筛选 */
  user_id?: string;
  /** 按发送者昵称/群名片模糊匹配 (SQL LIKE %sender_name%) */
  sender_name?: string;
  /** 按消息内容关键词模糊匹配 (SQL LIKE %keyword%) */
  keyword?: string;
  /**
   * 按消息类型筛选，支持单类型或类型数组:
   * 'text' | 'image' | 'sticker' | 'file' | 'group_file' | 'forward' | 'record' | 'video' | 'poke' | 'reply'
   */
  type?: string | string[];
  /** 起始时间: 支持毫秒数字、秒级数字、相对时间字符串 ("30m", "2h", "1d", "7d") 或日期时间字符串 ("2026-08-30", "2026-08-30 12:00:00") */
  since?: number | string;
  /** 截止时间: 支持毫秒数字、秒级数字、相对时间字符串或日期时间字符串 */
  until?: number | string;
  /** 快捷相对时间窗口: 检索过去指定时间段内的消息 (如 "1h", "6h", "1d", "7d")，等效于 since = now - relative */
  relative?: string;
  /** 是否仅筛选带有文件/图片/多媒体附件的消息 (local_path 或 file_id 不为空) */
  has_file?: boolean;
  /** 查询指定 msg_id 消息的直接回复消息 (reply_to = ?) */
  reply_to?: number;
  /** 是否排除机器人自己发出的消息 (self = 0) */
  exclude_self?: boolean;
  /** 是否仅查询机器人自己发出的消息 (self = 1) */
  self_only?: boolean;
  /** 返回最大条数 (默认 20，上限 100) */
  limit?: number;
  /** 时间排序 (默认 'desc' 倒序，取最新消息) */
  order?: 'asc' | 'desc';
}

export interface ChatMessageSummary {
  msg_id: number;
  user_id: string;
  sender_name: string;
  time: number;
  formatted_time?: string;
  type: string;
  content: string;
  recalled: boolean;
  self: boolean;
  reply_to?: number | null;
  local_path?: string | null;
  file_id?: string | null;
}

export interface ReadChatHistoryResult {
  messages: ChatMessageSummary[];
  total: number;
}

export interface ListGroupFilesParams {
  /** 按群文件名模糊搜索（如 ".pdf", "周报"） */
  file_name?: string;
  /** 按上传者昵称或群名片模糊搜索 */
  sender_name?: string;
  /** 按上传者 QQ 号精确筛选 */
  user_id?: string;
  /** 起始时间: 支持毫秒数字、秒级数字、相对时间 ("7d") 或日期时间字符串 */
  since?: number | string;
  /** 截止时间: 支持毫秒数字、秒级数字、相对时间或日期时间字符串 */
  until?: number | string;
  /** 返回最大条数 (默认 20，上限 100) */
  limit?: number;
  /** 时间排序 (默认 'desc' 倒序，取最新上传的文件) */
  order?: 'asc' | 'desc';
}

export interface GroupFileInfo {
  msg_id: number;
  file_id: string;
  file_name: string;
  busid: number;
  sender_name: string;
  user_id: string;
  time: number;
  formatted_time: string;
  size?: number;
}

export interface ListGroupFilesResult {
  success?: boolean;
  files: GroupFileInfo[];
  total: number;
  error?: string;
}

export interface FetchChatResourceParams {
  file_id: string;
  busid?: number;
  file_name?: string;
}

export interface FetchChatResourceResult {
  success: boolean;
  local_path?: string;
  error?: string;
}

export interface ExpandForwardMessageParams {
  forward_id: string;
}

export interface ForwardNode {
  sender_name: string;
  user_id: string;
  time: number;
  content: string;
}

export interface ExpandForwardMessageResult {
  success: boolean;
  messages?: ForwardNode[];
  error?: string;
}

export interface SendFileParams {
  file_path: string;
  file_type?: 'image' | 'file';
}

export interface SendFileResult {
  success: boolean;
  message_id?: number;
  error?: string;
}

export interface PokeUserParams {
  user_id: string;
}

export interface PokeUserResult {
  success: boolean;
  error?: string;
}

export const EMOJI_MAP: Record<string, { id: string; name: string }> = {
  thumbs_up: { id: '76', name: '点赞' },
  heart: { id: '66', name: '爱心' },
  laugh: { id: '233', name: '笑哭' },
  grin: { id: '13', name: '呲牙' },
  snicker: { id: '20', name: '偷笑' },
  doge: { id: '277', name: '狗头' },
  ok: { id: '124', name: 'OK' },
  cry: { id: '5', name: '大哭' },
  grievance: { id: '9', name: '委屈' },
  hug: { id: '49', name: '抱抱' },
  rose: { id: '63', name: '玫瑰' },
  cheer: { id: '311', name: '打call' },
  touch_fish: { id: '285', name: '摸鱼' },
  celebrate: { id: '144', name: '礼花' },
  cute: { id: '175', name: '卖萌' },
  thinking: { id: '212', name: '托腮' },
  sweat: { id: '265', name: '辣眼睛' },
  cat: { id: '307', name: '喵喵' },
  skull: { id: '37', name: '骷髅头' },
  poop: { id: '59', name: '便便' },
  pig: { id: '46', name: '猪头' },
  button: { id: '424', name: '狂按按钮' },
  hammer: { id: '38', name: '木槌敲头' },
  baldy: { id: '390', name: '头秃' },
  victim: { id: '344', name: '大怨种' },
  rage: { id: '146', name: '爆筋' },
};

export interface ReactMessageParams {
  /** 表情语义键（对应 QQ 群消息回应表情） */
  emoji: string;
  /** 要回应的目标消息 ID。可省略，省略时自动绑定当前回合正在回复的入站消息 */
  message_id?: number;
}

export interface ReactMessageResult {
  success: boolean;
  message_id?: number;
  emoji?: string;
  emoji_id?: string;
  error?: string;
}

// ==================== 5. 插件配置接口 ====================

export interface BridgePluginConfig {
  ws_port?: number;
  ws_token?: string;
  bot_qq?: string;
  admins?: string[];
  aliases?: string[];
  at_questioner?: boolean;
  quote_original?: boolean;
  image_ttl_days?: number;
  persona?: string;
  behavior?: string;
  /** 是否启用群聊主动回复能力 (总开关，关闭时概率唤醒与潜水唤醒全部禁用) */
  proactive_reply_enabled?: boolean;
  /** 仅回复文本内容（纯文本模型专用）：开启后仅对纯文本消息触发主动回复，视频/图片/表情包等多模态消息一律不主动回复 */
  proactive_only_text?: boolean;
  /** 是否启用群聊普通消息概率唤醒 */
  proactive_random_enabled?: boolean;
  /** 群聊普通消息概率唤醒几率 (0.01 ~ 1.0) */
  proactive_random_probability?: number;
  /** 是否启用潜水超时主动唤醒 (暖群/打破冷场) */
  proactive_idle_enabled?: boolean;
  /** 潜水超时阈值 (单位: 分钟，0 表示无限/不启用) */
  proactive_idle_timeout_mins?: number;
  /** 主动回复冷却时间 (单位: 分钟，两次主动回复之间的最小间隔) */
  proactive_cooldown_mins?: number;
  /** 是否启用夜间免打扰 (23:00 - 08:00 期间不主动回复) */
  proactive_night_dnd?: boolean;
  /** 记忆 Markdown 文件存储根目录 (默认 .dsh/napcat/napcat_memory) */
  memory_storage_dir?: string;
  /** 群聊用户画像注入总字符预算上限 (默认 2200) */
  memory_budget_chars?: number;
  /** 是否启用后台自动回顾 (默认 true) */
  review_enabled?: boolean;
  /** 触发后台回顾的对话轮次间隔 (默认 10) */
  review_turns_interval?: number;
  /** 触发后台回顾的工具调用次数间隔 (默认 10) */
  review_tool_calls_interval?: number;
  /** 后台回顾使用的独立子模型名称 (可选，留空继承主模型) */
  review_model?: string;
}

// ==================== 6. 出站串行队列与入站上下文契约 ====================

/**
 * 触发一次唤醒的入站消息上下文 (Spec §7.1 / 决策 A)
 * 供出方向按 at_questioner / quote_original 组装 @提问者 与 引用原消息 前缀。
 */
export interface InboundReplyContext {
  /** 唤醒源消息的 message_id (用于 CQ:reply 引用) */
  msg_id: number;
  /** 提问者 QQ 号 (用于 CQ:at) */
  from_user: string;
  /** 是否为群聊消息 (私聊不 @ 不引用) */
  is_group: boolean;
}

/**
 * Shared per-peer 串行发送器契约 (Spec §7.3)
 * 正文、提问、审批、主动发文件均须经同一串行队列下发，保证同 peer 内发送顺序。
 */
export interface SerialSender {
  enqueue<T>(peer: string, task: () => Promise<T>): Promise<T>;
}
