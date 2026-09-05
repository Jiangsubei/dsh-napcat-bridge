/**
 * dsh-napcat-bridge: 斜杠命令模块
 * 管理员白名单门控、/mode、/model、/think、/clear、/help 命令调度与 per-session 权限隔离。
 */

import type { Context } from '@deepseek-ai/cordis';
import type { Session } from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-permission-presets';
import type { SessionManager } from '../gateway/session.js';

export interface CommandContext {
  userId: string;
  admins: string[];
  session: Session;
  ctx: Context;
  /** 可选：per-session 模型选择落位 (Spec §8.1 /model 为 Per-Session 语义) */
  sessionManager?: SessionManager;
}

export interface CommandResult {
  handled: boolean;
  success?: boolean;
  reply?: string;
  error?: string;
}

export interface DiscoveredModelInfo {
  provider: string;
  providerName?: string;
  model: string;
  modelName?: string;
}

export async function getDiscoveredModels(ctx: Context): Promise<DiscoveredModelInfo[]> {
  const llm = ctx.get('llm') || (ctx as any).llm;
  if (llm && typeof llm.listProviders === 'function') {
    try {
      const providers = llm.listProviders();
      const discovered: DiscoveredModelInfo[] = [];
      for (const provider of providers) {
        try {
          const models = await llm.listModels(provider.id);
          for (const m of models) {
            discovered.push({
              provider: provider.id,
              providerName: provider.name,
              model: m.id,
              modelName: m.name,
            });
          }
        } catch {}
      }
      if (discovered.length > 0) return discovered;
    } catch {}
  }

  // 保底默认已知模型列表
  return [
    { provider: 'deepseek-official', providerName: 'DeepSeek', model: 'deepseek-v4-flash', modelName: 'DeepSeek-V4-Flash' },
    { provider: 'deepseek-official', providerName: 'DeepSeek', model: 'deepseek-v4-pro', modelName: 'DeepSeek-V4-Pro' },
  ];
}

/**
 * 判断输入文本是否为斜杠命令
 */
export function isSlashCommand(text: string): boolean {
  if (typeof text !== 'string') return false;
  return text.trim().startsWith('/');
}

/**
 * 处理斜杠命令并执行管理员门控
 */
export async function handleSlashCommand(
  commandText: string,
  context: CommandContext
): Promise<CommandResult> {
  if (!isSlashCommand(commandText)) {
    return { handled: false };
  }

  const trimmed = commandText.trim();
  const match = trimmed.match(/^\/([^\s]+)(?:\s+(.*))?$/s);
  if (!match) {
    return { handled: false };
  }

  const command = match[1].toLowerCase();
  const args = (match[2] || '').trim();

  // 1. 管理员白名单权限门控
  const admins = (context.admins || []).map((a) => String(a).trim());
  const user = String(context.userId || '').trim();
  const isAdmin = admins.length > 0 && admins.includes(user);

  if (!isAdmin) {
    return {
      handled: true,
      success: false,
      error: '权限不足：仅管理员白名单用户允许执行斜杠命令',
    };
  }

  // 2. 命令分发处理
  switch (command) {
    case 'mode': {
      const permissionPresets = context.ctx.get('permissionPresets') || (context.ctx as any).permissionPresets;
      if (!args) {
        const current = permissionPresets?.current?.(context.session);
        return {
          handled: true,
          success: true,
          reply: `当前会话权限模式为: ${current || 'workspace-write'}`,
        };
      }

      const modeArg = args.toLowerCase();
      let targetPreset: string;
      if (modeArg === 'edit' || modeArg === 'workspace-write') {
        targetPreset = 'workspace-write';
      } else if (modeArg === 'yolo' || modeArg === 'danger-full-access') {
        targetPreset = 'danger-full-access';
      } else if (modeArg === 'readonly' || modeArg === 'read-only') {
        const names = permissionPresets?.names || [];
        targetPreset = names.includes('readonly') ? 'readonly' : 'read-only';
      } else {
        targetPreset = modeArg;
      }

      if (permissionPresets && typeof permissionPresets.set === 'function') {
        try {
          permissionPresets.set(context.session, targetPreset);
          return {
            handled: true,
            success: true,
            reply: `权限模式已切换为: ${targetPreset}`,
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

    case 'model': {
      const discovered = await getDiscoveredModels(context.ctx);
      const agents = context.ctx.get('agents') || (context.ctx as any).agents;
      const agent = agents?.get(context.session.id);

      // 安全更新 apiProxy 内部会话选择，但临时拦截抑制全局宿主 settings 保存
      const safeSyncApiProxy = async (sessionId: string, provider: string, model: string) => {
        const apiProxy = context.ctx.get('apiProxy') || (context.ctx as any).apiProxy;
        if (!apiProxy?.sessions?.selectModel) return;

        const defaultModelSvc =
          context.ctx.get('agentDefaultModel') || (context.ctx as any).agentDefaultModel;
        const originalSave = defaultModelSvc?.saveSelection;
        if (defaultModelSvc) {
          defaultModelSvc.saveSelection = async () => {};
        }
        try {
          await apiProxy.sessions.selectModel({
            rpcId: 'cmd-' + Math.random().toString(36).slice(2),
            payload: {
              sessionId,
              provider,
              model,
            },
          });
        } catch {} finally {
          if (defaultModelSvc && originalSave) {
            defaultModelSvc.saveSelection = originalSave;
          }
        }
      };

      // 1. 参数拆解：分离 --global / -g 与目标模型参数
      let isGlobal = false;
      const rawArgs = (args || '').trim();
      const tokens = rawArgs.split(/\s+/).filter(Boolean);
      const filteredTokens: string[] = [];
      for (const tok of tokens) {
        if (tok === '--global' || tok === '-g') {
          isGlobal = true;
        } else {
          filteredTokens.push(tok);
        }
      }
      const modelArg = filteredTokens.join(' ').trim();

      const curSel =
        context.sessionManager?.getModelSelection(context.session.id) ||
        (agent as any)?.modelSelection?.current;
      const curProv = curSel?.provider || (agent as any)?.options?.provider || 'deepseek-official';
      const curMod = curSel?.model || (agent as any)?.options?.model || 'deepseek-v4-flash';
      const napcatDefault = context.sessionManager?.getNapcatDefaultModel() || {
        provider: curProv,
        model: curMod,
      };
      const hostDefault = context.sessionManager?.getHostDefaultModelSelection() || {
        provider: 'deepseek-official',
        model: 'deepseek-v4-flash',
      };

      // 2. 空模型参数时：列出当前 QQ 会话、NapCat 全局默认以及全量多供应商可用列表
      if (!modelArg) {
        const groups = new Map<string, DiscoveredModelInfo[]>();
        for (const item of discovered) {
          const key = item.providerName ? `${item.providerName} (${item.provider})` : item.provider;
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key)!.push(item);
        }

        const listSections: string[] = [];
        for (const [groupName, items] of groups.entries()) {
          const lines = items.map(
            (m) => `• \`${m.model}\`${m.modelName && m.modelName !== m.model ? ` (${m.modelName})` : ''}`
          );
          listSections.push(`【${groupName}】\n${lines.join('\n')}`);
        }

        const reply = [
          `🤖 当前 QQ 会话模型: \`${curProv} / ${curMod}\``,
          `🐧 QQ 插件全局默认: \`${napcatDefault.provider} / ${napcatDefault.model}\``,
          `🌐 Web UI 宿主默认: \`${hostDefault.provider} / ${hostDefault.model}\``,
          '',
          '📋 可用模型列表:',
          listSections.join('\n\n'),
          '',
          '💡 切换方法:',
          '• 仅当前 QQ 会话: /model <模型名> (例如: /model deepseek-v4-flash)',
          '• 所有 QQ 会话全局: /model <模型名> --global (例如: /model deepseek-v4-flash --global)',
          '• 指定供应商: /model <供应商> <模型名> [--global]',
          '• 供应商斜杠语法: /model <供应商>/<模型名> [--global]',
        ].join('\n');

        return {
          handled: true,
          success: true,
          reply,
        };
      }

      // 3. 有参数时：智能多供应商匹配与解析
      let targetProvider: string | undefined;
      let targetModel: string | undefined;

      // 3.1 显式供应商/模型语法: <provider>/<model> 或 <provider> <model>
      if (modelArg.includes('/')) {
        const parts = modelArg.split('/');
        const p0 = parts[0]?.trim();
        const p1 = parts.slice(1).join('/').trim();
        if (p0 && p1) {
          targetProvider = p0;
          targetModel = p1;
        }
      } else if (/\s+/.test(modelArg)) {
        const parts = modelArg.split(/\s+/);
        const p0 = parts[0]?.trim();
        const p1 = parts.slice(1).join(' ').trim();
        if (p0 && p1) {
          targetProvider = p0;
          targetModel = p1;
        }
      }

      // 3.2 单 token 智能检索匹配
      if (!targetProvider || !targetModel) {
        const modelCandidate = modelArg;
        const matches = discovered.filter(
          (m) =>
            m.model === modelCandidate ||
            m.model.toLowerCase() === modelCandidate.toLowerCase()
        );

        if (matches.length === 1 && matches[0]) {
          targetProvider = matches[0].provider;
          targetModel = matches[0].model;
        } else if (matches.length > 1) {
          const candidates = matches
            .map((m) => `• \`/model ${m.provider} ${m.model}${isGlobal ? ' --global' : ''}\``)
            .join('\n');
          return {
            handled: true,
            success: false,
            error: `⚠️ 发现多个供应商提供同名模型 [${modelCandidate}]，请指定供应商切换：\n${candidates}`,
          };
        } else {
          targetProvider = curProv || 'deepseek-official';
          targetModel = modelCandidate;
        }
      }

      if (!targetProvider || !targetModel) {
        return {
          handled: true,
          success: false,
          error: '切换模型失败: 未能解析目标模型，请检查输入格式',
        };
      }

      if (!context.sessionManager && !agent) {
        return {
          handled: true,
          success: false,
          error: '切换模型失败: 当前会话缺少可用的模型选择服务 (sessionManager/agent 均不可用)',
        };
      }

      try {
        if (isGlobal) {
          // NapCat 插件全局模式：更新插件全局默认模型，并批量同步已知的所有 QQ 会话
          context.sessionManager?.setNapcatDefaultModel(targetProvider, targetModel);

          const allSids = context.sessionManager?.getAllQQSessionIds() || [context.session.id];
          for (const sid of allSids) {
            await safeSyncApiProxy(sid, targetProvider, targetModel);
          }

          return {
            handled: true,
            success: true,
            reply: [
              `✅ NapCat 插件全局 QQ 会话模型已切换为: ${targetProvider} / ${targetModel}`,
              `🌐 范围：已同步切换所有 QQ 会话；未来新建立的 QQ 会话也将默认使用此模型。`,
              `🛡️ 隔离：未修改 Web UI 宿主全局设置。`,
            ].join('\n'),
          };
        } else {
          // 仅当前 QQ 会话模式：仅落位本会话，不修改插件全局默认，亦不污染宿主全局设置
          context.sessionManager?.setModelSelection(
            context.session.id,
            targetProvider,
            targetModel
          );

          await safeSyncApiProxy(context.session.id, targetProvider, targetModel);

          return {
            handled: true,
            success: true,
            reply: [
              `✅ 当前 QQ 会话模型已切换为: ${targetProvider} / ${targetModel}`,
              `📌 提示：仅对当前 QQ 会话生效；如需切换所有 QQ 会话请加 --global 参数。`,
            ].join('\n'),
          };
        }
      } catch (err: any) {
        return {
          handled: true,
          success: false,
          error: `切换模型失败: ${err?.message || String(err)}`,
        };
      }
    }

    case 'think': {
      if (!args) {
        return {
          handled: true,
          success: false,
          error: '请指定思考深度，可选值: off, low, medium, high',
        };
      }

      const level = args.toLowerCase();
      const validLevels = ['off', 'low', 'medium', 'high'];
      if (!validLevels.includes(level)) {
        return {
          handled: true,
          success: false,
          error: `无效的思考深度: ${args}，支持: ${validLevels.join(', ')}`,
        };
      }

      try {
        const agents = context.ctx.get?.('agents') || (context.ctx as any).agents;
        const agent = agents?.get(context.session.id);
        if (agent && (agent as any).modelSelection?.current) {
          (agent as any).modelSelection.current.reasoningEffort = level;
        }
        return {
          handled: true,
          success: true,
          reply: `当前会话思考深度已设置为: ${level}`,
        };
      } catch (err: any) {
        return {
          handled: true,
          success: false,
          error: `设置思考深度失败: ${err?.message || String(err)}`,
        };
      }
    }

    case 'clear': {
      // 真正执行"开启新会话"：推进该 peer 的会话版本号并失效缓存（不归档旧会话）。
      // 下一次唤醒将自动创建全新会话，上下文真正清空 (用户确认语义: 直接开启新对话)。
      if (!context.sessionManager) {
        return {
          handled: true,
          success: false,
          error: '执行 /clear 失败: 当前环境缺少 SessionManager 服务',
        };
      }
      try {
        context.sessionManager.markSessionCleared(context.session.id);
        return {
          handled: true,
          success: true,
          reply: '✅ 会话已开启新对话（原会话保留，不再接收新消息；新消息将计入全新会话）。',
        };
      } catch (err: any) {
        return {
          handled: true,
          success: false,
          error: `执行 /clear 失败: ${err?.message || String(err)}`,
        };
      }
    }

    case 'help': {
      const helpText = [
        '【DSH × NapCat 快捷指令】',
        '• /mode <readonly|edit|yolo> : 切换当前会话权限模式',
        '• /model <model_id> : 切换当前会话绑定的 LLM 模型',
        '• /think <off|low|medium|high> : 切换当前会话思考深度',
        '• /clear : 开启新会话（原会话保留，不再接收新消息）',
        '• /help : 查看帮助信息',
      ].join('\n');

      return {
        handled: true,
        success: true,
        reply: helpText,
      };
    }

    default: {
      return {
        handled: true,
        success: false,
        error: `未知命令: /${command}，输入 /help 查看可用指令`,
      };
    }
  }
}

