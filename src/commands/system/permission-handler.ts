/**
 * dsh-napcat-bridge: /权限 命令处理器
 */

import { safeGetService } from '../../gateway/session/agent-runner.js';
import type { CommandContext, CommandResult } from '../types.js';

export async function handlePermissionCommand(
  args: string,
  context: CommandContext
): Promise<CommandResult> {
  const permissionPresets = safeGetService(context.ctx, 'permissionPresets');
  const toZhMode = (p?: string) => {
    if (!p) return '编辑';
    if (p === 'danger-full-access' || p === 'yolo') return '完全';
    if (p === 'workspace-write' || p === 'edit') return '编辑';
    if (p === 'readonly' || p === 'read-only') return '只读';
    return p;
  };

  if (!args) {
    const current = permissionPresets?.current?.(context.session);
    return {
      handled: true,
      success: true,
      reply: `当前权限模式：${toZhMode(current)}`,
    };
  }

  let targetPreset: string;
  if (args === '只读') {
    const names = permissionPresets?.names || [];
    targetPreset = names.includes('readonly') ? 'readonly' : 'read-only';
  } else if (args === '编辑') {
    targetPreset = 'workspace-write';
  } else if (args === '完全') {
    targetPreset = 'danger-full-access';
  } else {
    return {
      handled: true,
      success: false,
      error: `无效的权限模式：${args}\n可用模式：只读、编辑、完全`,
    };
  }

  if (permissionPresets && typeof permissionPresets.set === 'function') {
    try {
      permissionPresets.set(context.session, targetPreset);
      return {
        handled: true,
        success: true,
        reply: `权限模式已切换为：${args}`,
      };
    } catch (err: any) {
      return {
        handled: true,
        success: false,
        error: `切换权限模式失败: ${err?.message || String(err)}`,
      };
    }
  } else {
    return {
      handled: true,
      success: false,
      error: 'permissionPresets 服务不可用',
    };
  }
}
