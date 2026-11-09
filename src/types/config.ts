/**
 * dsh-napcat-bridge: 插件全局与会话配置类型契约
 */

export type DshPermissionPreset = 'read-only' | 'workspace-write' | 'danger-full-access';

export interface BlacklistItem {
  id: string;
  remark?: string;
}

export interface SessionPermissionOverride {
  id: string;
  type: 'user' | 'group';
  permission: DshPermissionPreset;
  remark?: string;
}

export interface CodingToolsOverride {
  id: string;
  type: 'user' | 'group';
  enabled: boolean;
  remark?: string;
}

export interface BridgePluginConfig {
  ws_port?: number;
  ws_token?: string;
  bot_qq?: string;
  admins?: string[];
  aliases?: string[];
  image_ttl_days?: number;
  persona?: string;
  behavior?: string;
  /** 是否启用群聊主动回复能力 (总开关，关闭时主动轮询与潜水唤醒全部禁用) */
  proactive_reply_enabled?: boolean;
  /** 仅回复文本内容（纯文本模型专用）：开启后仅对纯文本消息触发主动回复，视频/图片/表情包等多模态消息一律不主动回复 */
  proactive_only_text?: boolean;
  /** 主动回复轮询窗口期 (单位: 分钟，默认 3) */
  proactive_interval_mins?: number;
  /** 主动回复滑动窗口消息保留条数 (默认 10) */
  proactive_buffer_size?: number;
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
  /** 用户画像字符预算上限：单个用户画像文件的写入上限 (默认 2200) */
  user_profile_budget_chars?: number;
  /** Session 规则字符预算上限：单个会话规则文件的写入上限 (默认 2200) */
  session_memory_budget_chars?: number;
  /** 群聊用户画像总预算上限：群聊注入时所有活跃群友画像合计字符预算，Session 规则不计入 (默认 8000) */
  group_memory_total_budget_chars?: number;
  /** 控制新建会话是否装载表情包工具集，对后续新会话生效 */
  face_enabled?: boolean;
  /** 本地表情库存储容量上限 (默认 100 张) */
  face_store_max?: number;
  /** 本地表情库文件存储目录 (默认 .dsh/napcat/faces) */
  face_store_dir?: string;
  /** 发送表情包消息段使用的 sub_type (默认 1) */
  face_sub_type?: number;
  /** 表情库满额淘汰策略 ('reject' 拒绝新增 / 'evict_lru' 淘汰最久未用，默认 'reject') */
  face_evict_policy?: 'reject' | 'evict_lru';
  /** 控制新建会话是否装载黑话工具集与注入黑话上下文，对后续新会话生效 */
  slang_enabled?: boolean;
  /** 黑话知识库条数上限 (默认 300 条) */
  slang_max_entries?: number;
  /** 黑话库满额淘汰策略 ('reject' 拒绝新增 / 'evict_lru' 淘汰查阅最少词条，默认 'reject') */
  slang_evict_policy?: 'reject' | 'evict_lru';
  /** 黑话 Markdown 文档保存路径 (默认 .dsh/napcat/slang/slang.md) */
  slang_storage_path?: string;
  /** 私聊发言黑名单列表 (命中则不唤醒、不回复，管理员亦不例外) */
  private_blacklist?: BlacklistItem[];
  /** 群聊发言黑名单列表 (命中则不唤醒、不回复，管理员亦不例外) */
  group_blacklist?: BlacklistItem[];
  /** 私聊新建会话默认权限模式 (默认 'workspace-write') */
  session_permission_private_default?: DshPermissionPreset;
  /** 群聊新建会话默认权限模式 (默认 'read-only') */
  session_permission_group_default?: DshPermissionPreset;
  /** 会话权限模式自定义覆盖例外列表 */
  session_permission_overrides?: SessionPermissionOverride[];
  /** 私聊新建会话默认是否装载 Coding 工具组 (默认 true) */
  coding_tools_private_default?: boolean;
  /** 群聊新建会话默认是否装载 Coding 工具组 (默认 false) */
  coding_tools_group_default?: boolean;
  /** Coding 工具组自定义覆盖例外列表 */
  coding_tools_overrides?: CodingToolsOverride[];
  /** 一轮 Agent 循环正在进行时收到新消息的行为模式 ('steer' 及时插话并在当前 Step 完成后接纳; 'queue' 加入队列等待整轮结束，默认 'steer') */
  new_message_behavior?: 'steer' | 'queue';
}
