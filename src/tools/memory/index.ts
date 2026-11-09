/**
 * dsh-napcat-bridge: Memory Agent 工具集聚合导出
 */

import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { MemoryTools } from './common.js';
import { createReadMemoryTool } from './read-memory.js';
import { createCreateMemoryTool } from './create-memory.js';
import { createEditMemoryTool } from './edit-memory.js';

export * from './common.js';
export * from './read-memory.js';
export * from './create-memory.js';
export * from './edit-memory.js';

/**
 * 创建全量 Memory Agent 工具定义
 */
export function createMemoryToolDefinitions(tools: MemoryTools): ToolDefinition[] {
  return [
    createReadMemoryTool(tools),
    createCreateMemoryTool(tools),
    createEditMemoryTool(tools),
  ];
}
