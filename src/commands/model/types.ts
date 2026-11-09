/**
 * dsh-napcat-bridge: 模型与思考能力类型定义
 */

export interface DiscoveredModelInfo {
  provider: string;
  providerName?: string;
  model: string;
  modelName?: string;
}

export interface ModelReasoningMetadata {
  supported: boolean;
  efforts: Array<{ id: string; name: string; description?: string }>;
  defaultEffort?: string;
  currentEffort?: string;
  isDefault: boolean;
}
