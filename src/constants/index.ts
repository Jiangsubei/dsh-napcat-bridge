export const PLUGIN_NAME = 'dsh-napcat-bridge';

export const SETTINGS_NAMESPACE = 'dsh-napcat-bridge';

export const DEFAULT_WS_PORT = 8080;

export const DEFAULT_IMAGE_TTL_DAYS = 7;

export const DEFAULT_WORKSPACE_ROOT = '.dsh/workspace/napcat';

export const DEFAULT_DOWNLOAD_ROOT = '.dsh/workspace/napcat_download';

export const DEFAULT_PERSONA =
  '你是一个得力的 QQ 群聊与私聊智能助手，请友好、精炼、真实地回答用户的问题。';

export const TRUNCATED_USER_PROFILE_NOTICE =
  "[提示：受字符预算限制，用户画像未完全展示。如需了解特定用户的完整画像，可按需调用 read_memory(type='user', qq='<QQ号>') 获取。]";

export const DEFAULT_MEMORY_GUIDANCE =
  '记忆工具规则：持久记忆由系统后台自动打理，日常对话切勿主动调用记忆工具（create_memory、edit_memory），仅在用户明确要求记住、修改或查看设定时才去调用；若上下文快照提示画像未完全展示，可按需使用 read_memory 查询。';

export const DEFAULT_BEHAVIOR =
  '重要约束：QQ 消息不支持复杂的 Markdown 格式，请严格使用清晰的纯文本结构排版，避免输出多余的 Markdown 标记语法。' +
  '文件发送：生成并需要发送给用户的文件或图片，必须保存到 NapCat 能够访问的本地持久化路径或共享目录，并在调用 send_file 时传递有效的文件绝对路径或 file:// URI。若处于跨系统或容器映射环境，请确保路径已正确映射至 NapCat 可读取位置。' +
  DEFAULT_MEMORY_GUIDANCE;

export const DEFAULT_PROACTIVE_REPLY_ENABLED = false;
export const DEFAULT_PROACTIVE_ONLY_TEXT_ENABLED = false;
export const DEFAULT_PROACTIVE_RANDOM_ENABLED = false;
export const DEFAULT_PROACTIVE_RANDOM_PROBABILITY = 0.05;
export const DEFAULT_PROACTIVE_IDLE_ENABLED = false;
export const DEFAULT_PROACTIVE_IDLE_TIMEOUT_MINS = 120;
export const DEFAULT_PROACTIVE_COOLDOWN_MINS = 10;
export const DEFAULT_PROACTIVE_NIGHT_DND = true;

export const DEFAULT_MEMORY_DIR = '.dsh/napcat/napcat_memory';
export const DEFAULT_MEMORY_BUDGET_CHARS = 2200;
export const DEFAULT_GROUP_MEMORY_BUDGET_CHARS = 2200;
export const DEFAULT_PRIVATE_MEMORY_BUDGET_CHARS = 1500;
export const DEFAULT_USER_PROFILE_CHAR_LIMIT = 1500;
export const DEFAULT_SESSION_MEMORY_CHAR_LIMIT = 2200;
export const DEFAULT_REVIEW_ENABLED = true;
export const DEFAULT_REVIEW_TURNS_INTERVAL = 10;
export const DEFAULT_REVIEW_TOOL_CALLS_INTERVAL = 10;

