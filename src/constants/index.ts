/**
 * dsh-napcat-bridge: 静态常量与默认配置
 */

export const PLUGIN_NAME = 'dsh-napcat-bridge';

export const SETTINGS_NAMESPACE = 'dsh-napcat-bridge';

export const DEFAULT_WS_PORT = 8080;

export const DEFAULT_IMAGE_TTL_DAYS = 7;

export const DEFAULT_WORKSPACE_ROOT = '.dsh/workspace/napcat';

export const DEFAULT_DOWNLOAD_ROOT = '.dsh/workspace/napcat_download';

export const DEFAULT_PERSONA =
  '你是一个得力的 QQ 群聊与私聊智能助手，请友好、精炼、真实地回答用户的问题。';

export const DEFAULT_BEHAVIOR =
  '重要约束：QQ 消息不支持复杂的 Markdown 格式，请严格使用清晰的纯文本结构排版，避免输出多余的 Markdown 标记语法。' +
  '部署环境：NapCat 运行在 Windows 宿主机，本环境是 WSL（同一物理机，/mnt/c 即 C:\）。' +
  '你生成并需要发送给用户的文件/图片，应保存到两边共享目录（如 /mnt/c/napcat_share/），并在调用 send_file 时传递 Windows 侧可访问的路径（file:///C:/... 形式；传 /mnt/c/... 也会自动翻译为 file:///C:/...）。' +
  '请勿传 WSL 内部路径（/home/...、/tmp/...），否则 NapCat 无法读取导致发送失败。';

export const DEFAULT_PROACTIVE_REPLY_ENABLED = false;
export const DEFAULT_PROACTIVE_RANDOM_ENABLED = false;
export const DEFAULT_PROACTIVE_RANDOM_PROBABILITY = 0.05;
export const DEFAULT_PROACTIVE_IDLE_ENABLED = false;
export const DEFAULT_PROACTIVE_IDLE_TIMEOUT_MINS = 120;
export const DEFAULT_PROACTIVE_COOLDOWN_MINS = 10;
export const DEFAULT_PROACTIVE_NIGHT_DND = true;

export const DEFAULT_MEMORY_DIR = '.dsh/napcat/napcat_memory';
export const DEFAULT_MEMORY_BUDGET_CHARS = 2200;
export const DEFAULT_REVIEW_ENABLED = true;
export const DEFAULT_REVIEW_TURNS_INTERVAL = 10;
export const DEFAULT_REVIEW_TOOL_CALLS_INTERVAL = 10;

