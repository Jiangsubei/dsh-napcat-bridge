/**
 * dsh-napcat-bridge: 工具执行上下文定义与全局状态管理
 */

import type { MessageDatabase } from '../../storage/database.js';
import type { MediaStorageManager } from '../../storage/media.js';
import type { NapCatGatewayServer } from '../../gateway/server.js';
import type { MessageWaitRegistry } from '../../gateway/server.js';
import type { SerialSender, BridgePluginConfig } from '../../types/index.js';
import type { TaskScheduler } from '../../scheduler/index.js';
import type { SlangStorage } from '../../slang/index.js';

export interface ToolExecutionContext {
  db?: MessageDatabase | null;
  gateway?: NapCatGatewayServer | null;
  mediaManager?: MediaStorageManager | null;
  /** 共享 per-peer 串行发送器 (Spec §7.3)：主动发文件与正文/提问/审批同队列 */
  sender?: SerialSender | null;
  peer?: string;
  groupId?: string | number;
  dshHome?: string;
  /** EN-005: 入站消息等待收集器（wait_for_user_messages 工具） */
  waitRegistry?: MessageWaitRegistry | null;
  /** EN-005: 当前工具调用的取消信号（Agent 回合中断时中止等待） */
  signal?: AbortSignal;
  /** 当前回合入站消息 ID 获取器（react_message 省略 message_id 时默认绑定） */
  inboundMsgIdGetter?: (peer: string) => number | undefined;
  /** 表情包落盘存储目录 */
  faceDir?: string;
  /** 发送表情使用的 sub_type */
  faceSubType?: number;
  /** 表情包存储配额上限 */
  faceStoreMax?: number;
  /** 表情包淘汰策略 */
  faceEvictPolicy?: 'reject' | 'evict_lru';
  /** 定时任务与周期调度引擎 */
  scheduler?: TaskScheduler | null;
  /** 黑话存储管理器 */
  slangStorage?: SlangStorage;
  /** 当前工具执行所在的 Session ID */
  sessionId?: string;
  /** 会话管理器实例 (供跨 Agent IPC 工具调度) */
  sessionManager?: any;
  /** 配置项提供器或配置快照 */
  config?: (() => BridgePluginConfig) | BridgePluginConfig;
}

export interface AgentToolsOptions {
  db: MessageDatabase;
  gateway?: NapCatGatewayServer;
  mediaManager: MediaStorageManager;
  sender?: SerialSender;
  dshHome?: string;
  waitRegistry?: MessageWaitRegistry;
  inboundMsgIdGetter?: (peer: string) => number | undefined;
  scheduler?: TaskScheduler;
  slangStorage?: SlangStorage;
  /** 当前工具执行所在的 Session ID */
  sessionId?: string;
  /** 会话管理器实例 (供跨 Agent IPC 工具调度) */
  sessionManager?: any;
  config?: (() => BridgePluginConfig) | BridgePluginConfig;
}

let globalToolContext: ToolExecutionContext = {};

export function setGlobalToolContext(context: ToolExecutionContext): void {
  globalToolContext = { ...globalToolContext, ...context };
}

export function resetGlobalToolContext(): void {
  globalToolContext = {};
}

export function getGlobalToolContext(): ToolExecutionContext {
  return globalToolContext;
}

export type ContextSource =
  | ToolExecutionContext
  | AgentToolsOptions
  | (() => ToolExecutionContext)
  | undefined;

export function resolveToolContext(source?: ContextSource): ToolExecutionContext {
  const dynamic = typeof source === 'function' ? source() : (source || {});
  return { ...globalToolContext, ...dynamic };
}

export function normalizePeer(peer: string): string {
  const groupMatch = peer.match(/^qq-group-([^-]+)/);
  if (groupMatch) return `group_${groupMatch[1]}`;
  const userMatch = peer.match(/^qq-user-([^-]+)/);
  if (userMatch) return `user_${userMatch[1]}`;
  return peer;
}

