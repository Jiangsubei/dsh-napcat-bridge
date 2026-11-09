/**
 * dsh-napcat-bridge: 黑话学习与管理 Agent 工具集聚合导出
 */

import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { SlangStorage } from '../../slang/storage.js';
import { createQuerySlangTool } from './query-slang.js';
import { createRecordSlangTool } from './record-slang.js';
import { createManageSlangTool } from './manage-slang.js';

export * from './query-slang.js';
export * from './record-slang.js';
export * from './manage-slang.js';

/**
 * 创建供 DSH 注册的黑话 ToolDefinition 列表
 */
export function createSlangToolDefinitions(storage: SlangStorage): ToolDefinition[] {
  return [
    createQuerySlangTool(storage),
    createRecordSlangTool(storage),
    createManageSlangTool(storage),
  ];
}
