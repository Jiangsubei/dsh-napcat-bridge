/**
 * dsh-napcat-bridge: 核心类型聚合门面
 * 领域化拆解统一入口：OneBot 协议、唤醒包、运行时队列、存储表模型、社交关系链、Agent 工具及配置类型。
 */

export * from './system-event.js';
export * from './protocol.js';
export * from './wakeup.js';
export * from './runtime.js';
export * from './storage.js';
export * from './relations.js';
export * from './tools.js';
export * from './config.js';

// 向下兼容导出常数字典
export { EMOJI_MAP } from '../constants/emoji.js';
