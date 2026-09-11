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
    { provider: 'deepseek-official', providerName: 'DeepSeek', model: 'deepseek-flash', modelName: 'DeepSeek-V41-Flash' },
    { provider: 'deepseek-official', providerName: 'DeepSeek', model: 'deepseek-v4-flash', modelName: 'DeepSeek-V4-Flash' },
    { provider: 'deepseek-official', providerName: 'DeepSeek', model: 'deepseek-v4-pro', modelName: 'DeepSeek-V4-Pro' },
  ];
}

let syncModelChain: Promise<void> = Promise.resolve();
let trueOriginalSaveSelection: ((selection: any) => Promise<void>) | null = null;
let activePatchCount = 0;

/**
 * 同步宿主会话模型选择 (包含可选 reasoningEffort)，抑制 agentDefaultModel.saveSelection 避免污染 Web UI 全局设置
 * 采用 Promise 互斥链与 activePatchCount 引用计数，杜绝并发调用及 -g 批量同步时的竞态条件
 */
export async function safeSyncSessionModel(
  ctx: Context,
  sessionId: string,
  provider: string,
  model: string,
  reasoningEffort?: string
): Promise<void> {
  const op = async () => {
    const sessionController = ctx.get('sessionController') || (ctx as any).sessionController;
    if (!sessionController?.selectModel) return;

    const defaultModelSvc =
      ctx.get('agentDefaultModel') || (ctx as any).agentDefaultModel;
    if (defaultModelSvc) {
      if (activePatchCount === 0) {
        trueOriginalSaveSelection = defaultModelSvc.saveSelection;
        defaultModelSvc.saveSelection = async () => {};
      }
      activePatchCount++;
    }
    try {
      await sessionController.selectModel({
        sessionId,
        provider,
        model,
        ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
      });
    } catch {} finally {
      if (defaultModelSvc) {
        activePatchCount--;
        if (activePatchCount === 0 && trueOriginalSaveSelection) {
          defaultModelSvc.saveSelection = trueOriginalSaveSelection;
          trueOriginalSaveSelection = null;
        }
      }
    }
  };

  const next = syncModelChain.then(op, op);
  syncModelChain = next.catch(() => {});
  await next;
}

export interface ModelReasoningMetadata {
  supported: boolean;
  efforts: Array<{ id: string; name: string; description?: string }>;
  defaultEffort?: string;
  currentEffort?: string;
  isDefault: boolean;
}

/**
 * 从 DSH LLM 服务动态获取指定模型的思考深度能力与支持的档位列表
 */
export async function getModelReasoningInfo(
  ctx: Context,
  provider: string,
  model: string,
  explicitEffort?: string
): Promise<ModelReasoningMetadata> {
  const llm = ctx.get('llm') || (ctx as any).llm;
  if (llm && typeof llm.resolveModelInfo === 'function') {
    try {
      const info = await llm.resolveModelInfo(provider, model);
      if (info && info.reasoning && Array.isArray(info.reasoning.efforts) && info.reasoning.efforts.length > 0) {
        const efforts = info.reasoning.efforts.map((e: any) => ({
          id: String(e.id),
          name: String(e.name || e.id),
          description: e.description ? String(e.description) : undefined,
        }));
        const defaultEffort = info.reasoning.defaultEffort
          ? String(info.reasoning.defaultEffort)
          : efforts[0]?.id;
        const currentEffort = explicitEffort || defaultEffort;
        return {
          supported: true,
          efforts,
          defaultEffort,
          currentEffort,
          isDefault: !explicitEffort || explicitEffort === defaultEffort,
        };
      } else if (info && info.reasoning === undefined) {
        // 明确当前模型无思考能力
        return { supported: false, efforts: [], isDefault: true };
      }
    } catch {}
  }

  // 保底：若为官方 DeepSeek 适配器但 resolveModelInfo 失败或为离线测试桩
  if (provider === 'deepseek-official') {
    const efforts = [
      { id: 'off', name: 'Off', description: '关闭思考' },
      { id: 'low', name: 'Low', description: '常规或低延迟任务' },
      { id: 'high', name: 'High', description: '多数任务推荐（默认）' },
      { id: 'max', name: 'Max', description: '复杂任务深度思考' },
    ];
    return {
      supported: true,
      efforts,
      defaultEffort: 'high',
      currentEffort: explicitEffort || 'high',
      isDefault: !explicitEffort || explicitEffort === 'high',
    };
  }

  return { supported: false, efforts: [], isDefault: true };
}

/**
 * 格式化 Token 数量为紧凑字符串（对齐 WebUI formatTokens：<1k 直接显示，<1M 显示 XXK，>=1M 显示 XXM）
 */
export function formatTokens(value: number): string {
  if (typeof value !== 'number' || isNaN(value) || value <= 0) return '0';
  const scaled = (candidate: number) =>
    candidate >= 100
      ? String(Math.round(candidate))
      : String(Math.round(candidate * 10) / 10);
  if (value < 1e3) return String(value);
  if (value < 1e6) return `${scaled(value / 1e3)}K`;
  return `${scaled(value / 1e6)}M`;
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

      // 同步宿主会话模型选择：DSH 0.1.2-rc.1 起统一通过 sessionController.selectModel 同步，
      // 并临时抑制 agentDefaultModel.saveSelection 避免污染 Web UI 宿主全局设置。
      const safeSyncApiProxy = (
        sessionId: string,
        provider: string,
        model: string,
        reasoningEffort?: string
      ) => safeSyncSessionModel(context.ctx, sessionId, provider, model, reasoningEffort);

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
      const curEffort = curSel?.reasoningEffort;
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

      // 动态获取目标模型的思考能力与当前思考档位继承/适配
      const targetReasoning = await getModelReasoningInfo(
        context.ctx,
        targetProvider,
        targetModel,
        curEffort
      );

      let targetEffort: string | undefined;
      let effortDesc = '';
      if (targetReasoning.supported) {
        const effortMatched =
          curEffort && targetReasoning.efforts.some((e) => e.id === curEffort);
        targetEffort = effortMatched ? curEffort : targetReasoning.defaultEffort;
        const effortObj = targetReasoning.efforts.find((e) => e.id === targetEffort);
        const effortLabel = effortObj ? `${effortObj.id} (${effortObj.name})` : targetEffort;
        effortDesc = `\n🧠 思考深度：已自动对齐为 \`${effortLabel}\`${
          effortMatched ? ' (继承前序设置)' : ' (模型默认)'
        }`;
      } else {
        targetEffort = undefined;
        effortDesc = '\n🧠 思考能力：当前目标模型不支持深度思考（思考已关闭）';
      }

      try {
        if (isGlobal) {
          // NapCat 插件全局模式：更新插件全局默认模型，并批量同步已知的所有 QQ 会话
          context.sessionManager?.setNapcatDefaultModel(
            targetProvider,
            targetModel,
            targetEffort
          );

          const allSids = context.sessionManager?.getAllQQSessionIds() || [context.session.id];
          for (const sid of allSids) {
            await safeSyncApiProxy(sid, targetProvider, targetModel, targetEffort);
          }

          return {
            handled: true,
            success: true,
            reply: [
              `✅ NapCat 插件全局 QQ 会话模型已切换为: ${targetProvider} / ${targetModel}`,
              `🌐 范围：已同步切换所有 QQ 会话；未来新建立的 QQ 会话也将默认使用此模型。`,
              `🛡️ 隔离：未修改 Web UI 宿主全局设置。`,
            ].join('\n') + effortDesc,
          };
        } else {
          // 仅当前 QQ 会话模式：仅落位本会话，不修改插件全局默认，亦不污染宿主全局设置
          context.sessionManager?.setModelSelection(
            context.session.id,
            targetProvider,
            targetModel,
            targetEffort
          );

          if (agent && (agent as any).modelSelection?.current) {
            (agent as any).modelSelection.current.provider = targetProvider;
            (agent as any).modelSelection.current.model = targetModel;
            (agent as any).modelSelection.current.reasoningEffort = targetEffort;
          }

          await safeSyncApiProxy(
            context.session.id,
            targetProvider,
            targetModel,
            targetEffort
          );

          return {
            handled: true,
            success: true,
            reply: [
              `✅ 当前 QQ 会话模型已切换为: ${targetProvider} / ${targetModel}`,
              `📌 提示：仅对当前 QQ 会话生效；如需切换所有 QQ 会话请加 --global 参数。`,
            ].join('\n') + effortDesc,
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
      // 1. 参数拆解：分离 --global / -g 与目标思考深度参数
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
      const thinkArg = filteredTokens.join(' ').trim();

      // 2. 获取当前会话生效的模型选择与思考深度
      const agents = context.ctx.get?.('agents') || (context.ctx as any).agents;
      const agent = agents?.get(context.session.id);
      const curSel =
        context.sessionManager?.getModelSelection(context.session.id) ||
        (agent as any)?.modelSelection?.current;
      const curProv = curSel?.provider || (agent as any)?.options?.provider || 'deepseek-official';
      const curMod = curSel?.model || (agent as any)?.options?.model || 'deepseek-v4-flash';
      const explicitEffort = curSel?.reasoningEffort;

      // 3. 从 DSH 动态获取当前模型的思考能力与支持档位
      const reasoningInfo = await getModelReasoningInfo(context.ctx, curProv, curMod, explicitEffort);

      // 4. 空参数时：展示当前思考强度与该模型实际支持的档位列表
      if (!thinkArg) {
        if (!reasoningInfo.supported) {
          return {
            handled: true,
            success: true,
            reply: [
              `🤖 当前会话模型: \`${curProv} / ${curMod}\``,
              '🧠 思考能力: 当前模型不支持思考强度设置（该模型无深度思考能力或被提供商禁用）',
            ].join('\n'),
          };
        }

        const curName =
          reasoningInfo.efforts.find((e) => e.id === reasoningInfo.currentEffort)?.name ||
          reasoningInfo.currentEffort;
        const currentLine = `🧠 当前思考强度: \`${reasoningInfo.currentEffort}\`${
          curName && curName !== reasoningInfo.currentEffort ? ` (${curName})` : ''
        }${reasoningInfo.isDefault ? ' [默认]' : ''}`;

        const listLines = reasoningInfo.efforts.map((e) => {
          const isDef = e.id === reasoningInfo.defaultEffort ? ' [默认]' : '';
          const isCur = e.id === reasoningInfo.currentEffort ? ' (当前)' : '';
          const desc = e.description ? ` - ${e.description}` : '';
          return `• \`${e.id}\` (${e.name})${isDef}${isCur}${desc}`;
        });

        const reply = [
          `🤖 当前会话模型: \`${curProv} / ${curMod}\``,
          currentLine,
          '',
          '📋 支持的思考档位:',
          listLines.join('\n'),
          '',
          '💡 切换方法:',
          '• 仅当前 QQ 会话: /think <档位> (例如: /think low)',
          '• 恢复模型默认: /think default (或 /think reset)',
          '• 所有 QQ 会话全局: /think <档位> --global (例如: /think low --global)',
        ].join('\n');

        return {
          handled: true,
          success: true,
          reply,
        };
      }

      // 5. 有参数时：检查模型是否支持思考能力
      if (!reasoningInfo.supported) {
        return {
          handled: true,
          success: false,
          error: `⚠️ 切换失败: 当前模型 [${curProv} / ${curMod}] 不支持思考强度设置`,
        };
      }

      // 6. 支持 default / reset 恢复模型默认档位
      const lowerArg = thinkArg.toLowerCase();
      let targetEffort: string | undefined;
      let targetName = '';

      if (lowerArg === 'default' || lowerArg === 'reset') {
        targetEffort = undefined;
        targetName = `模型默认 (${reasoningInfo.defaultEffort})`;
      } else {
        const matched = reasoningInfo.efforts.find(
          (e) => e.id.toLowerCase() === lowerArg || e.name.toLowerCase() === lowerArg
        );
        if (!matched) {
          const validList = reasoningInfo.efforts
            .map((e) => `\`${e.id}\` (${e.name})`)
            .join(', ');
          return {
            handled: true,
            success: false,
            error: `⚠️ 无效的思考深度: [${thinkArg}]\n当前模型 [${curProv} / ${curMod}] 实际支持的档位为: ${validList}`,
          };
        }
        targetEffort = matched.id;
        targetName = `${matched.id} (${matched.name})`;
      }

      // 7. 执行切换与会话/全局同步
      try {
        if (isGlobal) {
          context.sessionManager?.setNapcatDefaultModel(curProv, curMod, targetEffort);
          const allSids = context.sessionManager?.getAllQQSessionIds() || [context.session.id];
          for (const sid of allSids) {
            await safeSyncSessionModel(context.ctx, sid, curProv, curMod, targetEffort);
          }
          return {
            handled: true,
            success: true,
            reply: [
              `✅ NapCat 插件全局 QQ 会话思考深度已切换为: ${targetName}`,
              `🌐 范围：已同步切换所有 QQ 会话；未来新建立的 QQ 会话也将默认使用此思考深度。`,
              `🛡️ 隔离：未修改 Web UI 宿主全局设置。`,
            ].join('\n'),
          };
        } else {
          context.sessionManager?.setModelSelection(
            context.session.id,
            curProv,
            curMod,
            targetEffort
          );
          if (agent && (agent as any).modelSelection?.current) {
            (agent as any).modelSelection.current.reasoningEffort = targetEffort;
          }
          await safeSyncSessionModel(
            context.ctx,
            context.session.id,
            curProv,
            curMod,
            targetEffort
          );
          return {
            handled: true,
            success: true,
            reply: [
              `✅ 当前 QQ 会话思考深度已切换为: ${targetName}`,
              `📌 提示：仅对当前 QQ 会话生效；如需切换所有 QQ 会话请加 --global 参数。`,
            ].join('\n'),
          };
        }
      } catch (err: any) {
        return {
          handled: true,
          success: false,
          error: `设置思考深度失败: ${err?.message || String(err)}`,
        };
      }
    }

    case 'stop': {
      const sessionController =
        context.ctx.get('sessionController') || (context.ctx as any).sessionController;
      if (!sessionController?.cancel) {
        return {
          handled: true,
          success: false,
          error: 'sessionController 服务不可用',
        };
      }
      try {
        await sessionController.cancel({ sessionId: context.session.id });
        return {
          handled: true,
          success: true,
          reply: '⏹️ 已停止当前生成。',
        };
      } catch (err: any) {
        return {
          handled: true,
          success: false,
          error: `停止失败: ${err?.message || String(err)}`,
        };
      }
    }

    case 'new':
    case 'clear': {
      // 真正执行"开启新会话"：推进该 peer 的会话版本号并失效缓存（不归档旧会话）。
      // 下一次唤醒将自动创建全新会话，上下文真正清空 (用户确认语义: 直接开启新对话)。
      if (!context.sessionManager) {
        return {
          handled: true,
          success: false,
          error: `执行 /${command} 失败: 当前环境缺少 SessionManager 服务`,
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
          error: `执行 /${command} 失败: ${err?.message || String(err)}`,
        };
      }
    }

    case 'resume': {
      const sm = context.sessionManager;
      if (!sm) {
        return {
          handled: true,
          success: false,
          error: '执行 /resume 失败: 当前环境缺少 SessionManager 服务',
        };
      }
      const peer = sm.sessionIdToPeer(context.session.id);
      if (!args) {
        const sessions = sm.listPeerSessionIds(peer); // 升序：旧→新
        // 渲染：最新在最上面（编号 N），最旧的编号 1 在最下面
        const lines = [...sessions].reverse().map((sid, i) => `${sessions.length - i}. ${sid}`);
        return {
          handled: true,
          success: true,
          reply: `📂 ${peer} 的会话：\n${lines.join('\n')}\n\n用法: /resume <序号>`,
        };
      }
      const idx = parseInt(args, 10);
      const sessions = sm.listPeerSessionIds(peer);
      if (isNaN(idx) || idx < 1 || idx > sessions.length) {
        return {
          handled: true,
          success: false,
          error: `序号无效，范围 1~${sessions.length}`,
        };
      }
      const target = sessions[idx - 1]; // 1=最旧 → sessions[0]
      if (!target) {
        return {
          handled: true,
          success: false,
          error: `序号无效，范围 1~${sessions.length}`,
        };
      }
      const ok = sm.resumeSession(peer, target);
      return ok
        ? {
            handled: true,
            success: true,
            reply: `✅ 已切换到会话 ${target}`,
          }
        : {
            handled: true,
            success: false,
            error: '恢复失败：会话不存在或已归档',
          };
    }

    case 'ctx': {
      const tokenMeter =
        context.ctx.get('tokenMeter') || (context.ctx as any).tokenMeter;
      if (!tokenMeter?.measure) {
        return {
          handled: true,
          success: false,
          error: 'tokenMeter 服务不可用',
        };
      }

      let usage: any;
      try {
        usage = tokenMeter.measure(context.session);
      } catch (err: any) {
        return {
          handled: true,
          success: false,
          error: `计算上下文用量失败: ${err?.message || String(err)}`,
        };
      }

      const totalTokens = usage?.totalTokens ?? 0;

      // 1. 上下文上限 contextWindow
      let contextWindow: number | undefined;
      const sessionProjections =
        context.ctx.get('sessionProjections') || (context.ctx as any).sessionProjections;
      let breakdown: any;

      if (sessionProjections && typeof sessionProjections.snapshot === 'function') {
        try {
          const snap = sessionProjections.snapshot(context.session, [
            'contextPressure',
            'contextBreakdown',
          ]);
          if (snap?.values?.contextPressure?.contextWindow) {
            contextWindow = snap.values.contextPressure.contextWindow;
          }
          if (snap?.values?.contextBreakdown) {
            breakdown = snap.values.contextBreakdown;
          }
        } catch {}
      }

      if (contextWindow === undefined) {
        try {
          const sm = context.sessionManager;
          const curSel = sm?.getModelSelection(context.session.id);
          const provider = curSel?.provider || 'deepseek-official';
          const model = curSel?.model || 'deepseek-v4-flash';
          const llm = context.ctx.get('llm') || (context.ctx as any).llm;
          if (llm && typeof llm.resolveModel === 'function') {
            const info = await llm.resolveModel(provider, model);
            if (info?.context?.contextWindow) {
              contextWindow = info.context.contextWindow;
            }
          }
        } catch {}
      }

      // 2. 分段明细 (系统提示词 / 工具 / 对话消息)
      let systemTokens = breakdown?.systemTokens ?? 0;
      let toolsTokens = breakdown?.toolsTokens ?? 0;
      let messageTokens = breakdown?.messageTokens ?? (usage?.surfaceTokens ?? 0);

      if (!breakdown && usage?.surfaceTokens !== undefined) {
        messageTokens = usage.surfaceTokens;
        if (usage.totalTokens > usage.surfaceTokens) {
          systemTokens = usage.totalTokens - usage.surfaceTokens;
        }
      }

      const fmt = (v: number) => (v > 0 ? `~${formatTokens(v)}` : '0');

      const lines: string[] = [`🧠 上下文已用 ${fmt(totalTokens)}`];
      const details: string[] = [];

      if (contextWindow && contextWindow > 0) {
        const percent = Math.min(100, Math.round((totalTokens / contextWindow) * 100));
        details.push(`${fmt(totalTokens)} / ${formatTokens(contextWindow)} (${percent}%)`);
      }

      const hasBreakdown =
        breakdown !== undefined ||
        systemTokens > 0 ||
        toolsTokens > 0 ||
        messageTokens > 0;

      if (hasBreakdown) {
        details.push(`系统提示词 ${fmt(systemTokens)}`);
        details.push(`工具 ${fmt(toolsTokens)}`);
        details.push(`对话消息 ${fmt(messageTokens)}`);
      }

      if (details.length > 0) {
        lines.push('', details.join('\n'));
      }

      return {
        handled: true,
        success: true,
        reply: lines.join('\n'),
      };
    }

    case 'help': {
      const helpText = [
        '【DSH × NapCat 快捷指令】',
        '• /model <model_id> : 切换当前会话 LLM 模型',
        '• /mode <readonly|edit|yolo> : 切换权限模式',
        '• /think [档位] : 查看或切换当前思考深度',
        '• /new (clear) : 开启新会话（原会话保留）',
        '• /resume : 列出并切换历史会话 (/resume <序号>)',
        '• /ctx : 查看当前会话上下文用量',
        '• /stop : 停止当前生成',
        '• /help : 查看帮助',
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

