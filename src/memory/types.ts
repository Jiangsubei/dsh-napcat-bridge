/**
 * dsh-napcat-bridge: Memory 插件类型定义
 */

export type MemoryType = 'session' | 'user';

export interface ActiveUserInfo {
  qq: string;
  name: string;
}

export interface MemorySnapshot {
  sessionMemory: string;
  userProfiles: string;
}

export interface MemoryOperationResult {
  success: boolean;
  message?: string;
  type?: MemoryType;
  target?: string;
  content?: string;
  preview?: string;
}

export interface MemoryPluginConfig {
  /** 记忆 Markdown 文件存储根目录 (默认 .dsh/napcat/napcat_memory) */
  storage_dir?: string;
  /** 群聊用户画像注入总字符预算上限 (默认 2200) */
  memory_budget_chars?: number;
  /** 是否启用后台自动回顾 (默认 true) */
  review_enabled?: boolean;
  /** 触发后台回顾的对话轮次间隔 (默认 10) */
  review_turns_interval?: number;
  /** 触发后台回顾的工具调用次数间隔 (默认 10) */
  review_tool_calls_interval?: number;
  /** 用于后台回顾的独立子模型 (可选，默认继承主模型) */
  review_model?: string;
}
