/**
 * dsh-napcat-bridge: Memory 插件类型定义
 */

export type MemoryType = 'session' | 'user';

export interface ActiveUserInfo {
  qq: string;
  name: string;
}

export interface MemoryOperationResult {
  success: boolean;
  message?: string;
  type?: MemoryType;
  target?: string;
  content?: string;
  preview?: string;
}

