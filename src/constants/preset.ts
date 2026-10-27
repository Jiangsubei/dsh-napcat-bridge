/**
 * QQ 会话专属预设定义规范与单一真相源 (Single Source of Truth, SSOT)
 * 供运行时注册 (src/index.ts) 与构建期 YAML 同步 (scripts/sync-patch.ts) 统一消费
 */

export const QQ_PRESET_ID = 'qq-session';
export const QQ_PRESET_NAME = 'QQ 智能助手';
export const QQ_PRESET_DESCRIPTION =
  'QQ 会话专属预设，包含工作区文件与跨平台 Shell、官方 Web 搜索与 NapCat QQ 交互能力';
export const QQ_PRESET_ORDER = 10;

export const QQ_PRESET_PERSONA_PREFIX =
  '当前会话是 QQ 会话。注意：你的直接文本回复为内部日志、用户不可见，向用户回复或发言必须显式调用 `send_qq_message`。当本轮处理完毕、无需回复或无需继续调用工具时，直接输出 [结束] 或 [已回复] 即可。';

export interface PresetPluginItem {
  id: string;
  name: string;
  comment?: string;
  config?: Record<string, any>;
  disabled?: boolean;
  yamlDisabledExpr?: string;
  yamlConfigExpr?: Record<string, string>;
}

export const QQ_PRESET_PLUGINS: PresetPluginItem[] = [
  {
    id: 'persona',
    name: '@deepseek-ai/dsh-persona',
    comment: '专属轻量提示词（complete: true 彻底屏蔽 DSH 繁杂的 Coding 提示词）',
    config: {
      prefix: QQ_PRESET_PERSONA_PREFIX,
      complete: true,
    },
  },
  {
    id: 'agent-instructions',
    name: '@deepseek-ai/dsh-agent-instructions',
    comment: '工作区指令扫描（扫描 AGENTS.md / CLAUDE.md 并注入模型上下文）',
    config: {
      maxBytes: 65536,
    },
  },
  {
    id: 'tool-fs',
    name: '@deepseek-ai/dsh-tool-fs',
    comment: '基础工作区与文件工具（edit, write, read, read_image）',
  },
  {
    id: 'tool-working-directory',
    name: '@deepseek-ai/dsh-tool-working-directory',
    comment: '工作区路径',
  },
  {
    id: 'tool-workspace-dependencies',
    name: '@deepseek-ai/dsh-tool-workspace-dependencies',
    comment: '工作区依赖工具 (有运行时环境时自动激活)',
    disabled: !(process.env.DSH_PRIMARY_RUNTIME || process.env.DSH_BUNDLED_PRIMARY_RUNTIME),
    yamlDisabledExpr: '!(process.env.DSH_PRIMARY_RUNTIME ?? process.env.DSH_BUNDLED_PRIMARY_RUNTIME)',
    config: {
      source: process.env.DSH_PRIMARY_RUNTIME || process.env.DSH_BUNDLED_PRIMARY_RUNTIME || '',
    },
    yamlConfigExpr: {
      source: "process.getBuiltinModule('node:path').resolve(process.env.DSH_PRIMARY_RUNTIME ?? process.env.DSH_BUNDLED_PRIMARY_RUNTIME ?? '')",
    },
  },
  {
    id: 'tool-bash',
    name: '@deepseek-ai/dsh-tool-bash',
    comment: '跨平台 Shell：Windows 激活 pwsh，macOS/Linux 激活 bash',
    disabled: process.platform === 'win32',
    yamlDisabledExpr: "process.platform === 'win32'",
  },
  {
    id: 'tool-pwsh',
    name: '@deepseek-ai/dsh-tool-pwsh',
    disabled: process.platform !== 'win32',
    yamlDisabledExpr: "process.platform !== 'win32'",
  },
  {
    id: 'tool-web',
    name: '@deepseek-ai/dsh-tool-web',
    comment: '官方联网搜索 (web_search, web_fetch)',
    config: { fetch: true, searchTimeoutMs: 30000 },
  },
  {
    id: 'skill-filesystem',
    name: '@deepseek-ai/dsh-skill-filesystem',
    comment: '技能系统（本地与项目技能发现及技能加载工具）',
  },
  {
    id: 'tool-skill',
    name: '@deepseek-ai/dsh-tool-skill',
  },
  {
    id: 'tool-ask-user',
    name: '@deepseek-ai/dsh-tool-ask-user',
    comment: '提问工具（允许主动向用户提问与选项确认）',
  },
  {
    id: 'napcat-tools',
    name: 'dsh-napcat-bridge/tools',
    comment: 'NapCat 专属工具组 (标准 Cordis 插件导出)',
  },
];

/** 获取供运行时 agentPresetsSvc.register(...) 使用的纯运行时定义对象 */
export function getRuntimePresetDefinition() {
  return {
    id: QQ_PRESET_ID,
    name: QQ_PRESET_NAME,
    description: QQ_PRESET_DESCRIPTION,
    order: QQ_PRESET_ORDER,
    plugins: QQ_PRESET_PLUGINS.map((item) => {
      const plugin: any = {
        id: item.id,
        name: item.name,
      };
      if (typeof item.disabled === 'boolean') {
        plugin.disabled = item.disabled;
      }
      if (item.config) {
        plugin.config = { ...item.config };
      }
      return plugin;
    }),
  };
}
