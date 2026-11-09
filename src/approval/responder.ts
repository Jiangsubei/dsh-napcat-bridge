/**
 * dsh-napcat-bridge: 审批响应器与提问 Provider 门面模块
 * 向前兼容门面，统一重导出提问与审批能力。
 */

export * from './question-provider.js';
export * from './tool-approval.js';
export { resolveWakeupInitiator } from './turn-initiator.js';
