export const PLUGIN_NAME = 'dsh-napcat-bridge';

export const SETTINGS_NAMESPACE = 'dsh-napcat-bridge';

export const DEFAULT_WS_PORT = 8080;

export const DEFAULT_IMAGE_TTL_DAYS = 7;

export const DEFAULT_WORKSPACE_ROOT = '.dsh/workspace/napcat';

export const DEFAULT_DATABASE_PATH = '.dsh/napcat/messages.sqlite';

export const DEFAULT_DOWNLOAD_ROOT = '.dsh/napcat/downloads';

export const DEFAULT_PERSONA =
  '你是一个得力的 QQ 群聊与私聊智能助手，请友好、精炼、真实地回答用户的问题。';

export const TRUNCATED_USER_PROFILE_NOTICE =
  "[提示：受字符预算限制，用户画像未完全展示。如需了解特定用户的完整画像，可按需调用 read_memory(type='user', qq='<QQ号>') 获取。]";

export const DEFAULT_MEMORY_GUIDANCE =
  '记忆工具规则：日常对话不必每轮都调用记忆工具（create_memory、edit_memory），但在用户明确要求记住/修改设定，或交流中提炼出长期稳定事实与偏好时，应当调用；严禁记录琐碎流水账；若上下文快照提示画像未完全展示，可按需使用 read_memory 查询。';

export const DEFAULT_BEHAVIOR =
  '## 交互与输出规范\n' +
  '- 消息排版：QQ 不支持复杂的 Markdown 格式，请严格使用清晰的纯文本结构排版，避免输出多余的 Markdown 标记语法。\n' +
  '- 消息下发：向用户回复消息、告知结论或同步长任务进展时，必须调用 send_qq_message 工具。请将正文完整传入 text 参数，并根据需要显式传入 reply_to（引用目标消息 ID）与 at_user（艾特目标 QQ）。严禁在直接回复中重复输出已发送的正文内容。\n' +
  '- 用户提问与抉择：若需要用户澄清需求、提供缺失信息或在多选项中进行抉择确认，可调用官方 ask_user_question 工具发起结构化交互。\n' +
  '- 文件与表情：生成或需发送给用户的文件/图片必须保存到本地持久化路径或共享目录，并调用 send_file 下发；发送表情包请调用 send_face。\n' +
  '- ' + DEFAULT_MEMORY_GUIDANCE;

export const DEFAULT_PROACTIVE_REPLY_ENABLED = false;
export const DEFAULT_PROACTIVE_ONLY_TEXT_ENABLED = false;
export const DEFAULT_PROACTIVE_INTERVAL_MINS = 3;
export const DEFAULT_PROACTIVE_BUFFER_SIZE = 10;
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
export const DEFAULT_FACE_ENABLED = false;
export const DEFAULT_FACE_STORE_MAX = 100;
export const DEFAULT_FACE_STORE_DIR = '.dsh/napcat/faces';
export const DEFAULT_FACE_QUERY_LIMIT = 100;
export const DEFAULT_FACE_SUB_TYPE = 1;
export const DEFAULT_FACE_EVICT_POLICY = 'evict_lru';
export const DEFAULT_FACE_GRACE_PERIOD_DAYS = 7;

export const DEFAULT_SLANG_ENABLED = true;
export const DEFAULT_SLANG_BUDGET_CHARS = 5000;
export const DEFAULT_SLANG_STORAGE_PATH = '.dsh/napcat/slang/slang.md';

