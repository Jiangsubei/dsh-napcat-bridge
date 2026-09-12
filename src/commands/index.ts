/**
 * dsh-napcat-bridge: 斜杠命令模块
 * 管理员白名单门控、/mode、/model、/think、/clear、/help 命令调度与 per-session 权限隔离。
 */

import type { Context } from '@deepseek-ai/cordis';
import type { Session } from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-permission-presets';
import type { SessionManager } from '../gateway/session.js';
import { formatSessionTitle, parseSessionId } from '../gateway/session.js';

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
 * 判断输入文本是否为斜杠命令（兼容全半角斜杠）
 */
export function isSlashCommand(text: string): boolean {
  if (typeof text !== 'string') return false;
  const trimmed = text.trim();
  return trimmed.startsWith('/') || trimmed.startsWith('／');
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

  const trimmed = commandText.trim().replace(/^／/, '/');
  const match = trimmed.match(/^\/([^\s]+)(?:\s+(.*))?$/s);
  if (!match) {
    return { handled: false };
  }

  const command = match[1];
  const args = (match[2] || '').trim();

  // 1. 管理员白名单权限门控
  const admins = (context.admins || []).map((a) => String(a).trim());
  const user = String(context.userId || '').trim();
  const isAdmin = admins.length > 0 && admins.includes(user);

  if (!isAdmin) {
    return {
      handled: true,
      success: false,
      error: '权限不足：仅管理员允许执行指令',
    };
  }

  // 2. 命令分发处理（纯两字中文命令，不保留英文别名）
  switch (command) {
    case '权限': {
      const permissionPresets = context.ctx.get('permissionPresets') || (context.ctx as any).permissionPresets;
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

    case '模型': {
      const discovered = await getDiscoveredModels(context.ctx);
      const agents = context.ctx.get('agents') || (context.ctx as any).agents;
      const agent = agents?.get(context.session.id);

      const safeSyncApiProxy = (
        sessionId: string,
        provider: string,
        model: string,
        reasoningEffort?: string
      ) => safeSyncSessionModel(context.ctx, sessionId, provider, model, reasoningEffort);

      // 1. 参数拆解：分离 --global / -g / --全局 与目标模型参数
      let isGlobal = false;
      const rawArgs = (args || '').trim();
      const tokens = rawArgs.split(/\s+/).filter(Boolean);
      const filteredTokens: string[] = [];
      for (const tok of tokens) {
        if (tok === '--global' || tok === '-g' || tok === '--全局') {
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

      // 2. 空模型参数时：列出当前会话、全局默认及可用模型列表
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
            (m) => `- ${m.model}${m.modelName && m.modelName !== m.model ? ` (${m.modelName})` : ''}`
          );
          listSections.push(`[${groupName}]\n${lines.join('\n')}`);
        }

        const reply = [
          `当前会话模型：${curProv} / ${curMod}`,
          `QQ全局默认：${napcatDefault.provider} / ${napcatDefault.model}`,
          `宿主全局默认：${hostDefault.provider} / ${hostDefault.model}`,
          '',
          '可用模型列表：',
          listSections.join('\n\n'),
          '',
          '切换说明：',
          '- 单模型名智能匹配：/模型 deepseek-v4-flash',
          '- 空格智能匹配：/模型 deepseek flash',
          '- 指定供应商：/模型 opencode-go deepseek-flash',
          '- 供应商斜杠语法：/模型 deepseek-official/deepseek-v4-pro',
          '- 所有会话全局生效：在末尾追加 -g 或 --全局',
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

      // 3.1 显式供应商斜杠语法: <provider>/<model>
      if (modelArg.includes('/')) {
        const parts = modelArg.split('/');
        const p0 = parts[0]?.trim();
        const p1 = parts.slice(1).join('/').trim();
        if (p0 && p1) {
          targetProvider = p0;
          targetModel = p1;
        }
      }

      // 3.2 空格语法: 优先尝试将整体转换为连字符匹配模型（如 deepseek flash -> deepseek-flash）
      if (!targetProvider && /\s+/.test(modelArg)) {
        const normalized = modelArg.toLowerCase().replace(/[\s_]+/g, '-');
        const exactModelHits = discovered.filter(
          (m) =>
            m.model.toLowerCase() === normalized ||
            m.model.toLowerCase().replace(/[\s_]+/g, '-') === normalized
        );

        if (exactModelHits.length === 1) {
          targetProvider = exactModelHits[0].provider;
          targetModel = exactModelHits[0].model;
        } else if (exactModelHits.length > 1) {
          const candidates = exactModelHits
            .map((m) => `- /模型 ${m.provider} ${m.model}${isGlobal ? ' -g' : ''}`)
            .join('\n');
          return {
            handled: true,
            success: false,
            error: `发现多个供应商提供同名模型 [${modelArg}]，请指定供应商：\n${candidates}`,
          };
        } else {
          // 若整体未命中独立模型，尝试 <provider> <model>
          const parts = modelArg.split(/\s+/);
          const p0 = parts[0]?.trim();
          const p1 = parts.slice(1).join(' ').trim();

          const matchedProvider = discovered.find(
            (m) =>
              m.provider.toLowerCase() === p0.toLowerCase() ||
              (m.providerName && m.providerName.toLowerCase() === p0.toLowerCase())
          );

          if (matchedProvider) {
            targetProvider = matchedProvider.provider;
            const p1Normalized = p1.toLowerCase().replace(/[\s_]+/g, '-');
            const provModelHit = discovered.find(
              (m) =>
                m.provider === matchedProvider.provider &&
                (m.model.toLowerCase() === p1.toLowerCase() ||
                  m.model.toLowerCase() === p1Normalized)
            );
            targetModel = provModelHit ? provModelHit.model : p1;
          }
        }
      }

      // 3.3 单 token 智能检索匹配
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
            .map((m) => `- /模型 ${m.provider} ${m.model}${isGlobal ? ' -g' : ''}`)
            .join('\n');
          return {
            handled: true,
            success: false,
            error: `发现多个供应商提供同名模型 [${modelCandidate}]，请指定供应商：\n${candidates}`,
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
        effortDesc = `\n思考深度：已自动对齐为 ${effortLabel}${
          effortMatched ? ' (继承前序设置)' : ' (模型默认)'
        }`;
      } else {
        targetEffort = undefined;
        effortDesc = '\n思考能力：当前目标模型不支持深度思考（思考已关闭）';
      }

      try {
        if (isGlobal) {
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
              `QQ全局模型已切换为：${targetProvider} / ${targetModel}`,
              effortDesc ? effortDesc.trim() : '',
              '范围：已同步切换所有QQ会话，新建会话也将默认使用此模型。',
            ].filter(Boolean).join('\n'),
          };
        } else {
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
              `当前会话模型已切换为：${targetProvider} / ${targetModel}`,
              effortDesc ? effortDesc.trim() : '',
              '提示：仅对当前会话生效；全局切换请追加 -g 或 --全局。',
            ].filter(Boolean).join('\n'),
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

    case '思考': {
      let isGlobal = false;
      const rawArgs = (args || '').trim();
      const tokens = rawArgs.split(/\s+/).filter(Boolean);
      const filteredTokens: string[] = [];
      for (const tok of tokens) {
        if (tok === '--global' || tok === '-g' || tok === '--全局') {
          isGlobal = true;
        } else {
          filteredTokens.push(tok);
        }
      }
      let thinkArg = filteredTokens.join(' ').trim();
      const zhEffortMap: Record<string, string> = {
        关: 'off',
        关闭: 'off',
        低: 'low',
        高: 'high',
        最大: 'max',
        极高: 'max',
        默认: 'default',
        重置: 'reset',
      };
      if (zhEffortMap[thinkArg]) {
        thinkArg = zhEffortMap[thinkArg];
      }

      const agents = context.ctx.get?.('agents') || (context.ctx as any).agents;
      const agent = agents?.get(context.session.id);
      const curSel =
        context.sessionManager?.getModelSelection(context.session.id) ||
        (agent as any)?.modelSelection?.current;
      const curProv = curSel?.provider || (agent as any)?.options?.provider || 'deepseek-official';
      const curMod = curSel?.model || (agent as any)?.options?.model || 'deepseek-v4-flash';
      const explicitEffort = curSel?.reasoningEffort;

      const reasoningInfo = await getModelReasoningInfo(context.ctx, curProv, curMod, explicitEffort);

      if (!thinkArg) {
        if (!reasoningInfo.supported) {
          return {
            handled: true,
            success: true,
            reply: '当前模型不支持思考强度设置（该模型无深度思考能力或被提供商禁用）',
          };
        }

        const curName =
          reasoningInfo.efforts.find((e) => e.id === reasoningInfo.currentEffort)?.name ||
          reasoningInfo.currentEffort;
        const currentLine = `当前思考强度：${reasoningInfo.currentEffort}${
          curName && curName !== reasoningInfo.currentEffort ? ` (${curName})` : ''
        }${reasoningInfo.isDefault ? ' [默认]' : ''}`;

        const listLines = reasoningInfo.efforts.map((e) => {
          const isDef = e.id === reasoningInfo.defaultEffort ? ' [默认]' : '';
          const isCur = e.id === reasoningInfo.currentEffort ? ' (当前)' : '';
          const desc = e.description ? ` - ${e.description}` : '';
          return `- ${e.id} (${e.name})${isDef}${isCur}${desc}`;
        });

        const reply = [
          `当前模型：${curProv} / ${curMod}`,
          currentLine,
          '',
          '支持的思考档位：',
          listLines.join('\n'),
          '',
          '切换说明：',
          '- 仅当前会话：/思考 <档位>（例如：/思考 low 或 /思考 max）',
          '- 恢复模型默认：/思考 default',
          '- 所有会话全局生效：/思考 <档位> -g（或 --全局）',
        ].join('\n');

        return {
          handled: true,
          success: true,
          reply,
        };
      }

      if (!reasoningInfo.supported) {
        return {
          handled: true,
          success: false,
          error: `切换失败: 当前模型 [${curProv} / ${curMod}] 不支持思考强度设置`,
        };
      }

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
            .map((e) => `${e.id} (${e.name})`)
            .join(', ');
          return {
            handled: true,
            success: false,
            error: `无效的思考深度: [${thinkArg}]\n当前模型 [${curProv} / ${curMod}] 实际支持的档位为: ${validList}`,
          };
        }
        targetEffort = matched.id;
        targetName = `${matched.id} (${matched.name})`;
      }

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
              `QQ全局思考深度已切换为：${targetName}`,
              '范围：已同步切换所有QQ会话，新建会话也将默认使用此思考深度。',
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
              `当前会话思考深度已切换为：${targetName}`,
              '提示：仅对当前会话生效；全局切换请追加 -g 或 --全局。',
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

    case '停止': {
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
          reply: '已停止当前生成。',
        };
      } catch (err: any) {
        return {
          handled: true,
          success: false,
          error: `停止失败: ${err?.message || String(err)}`,
        };
      }
    }

    case '新建': {
      if (!context.sessionManager) {
        return {
          handled: true,
          success: false,
          error: '执行 /新建 失败: 当前环境缺少 SessionManager 服务',
        };
      }
      try {
        context.sessionManager.markSessionCleared(context.session.id);
        return {
          handled: true,
          success: true,
          reply: '已开启新会话（原会话已保留归档，新消息将计入新会话）。',
        };
      } catch (err: any) {
        return {
          handled: true,
          success: false,
          error: `执行 /新建 失败: ${err?.message || String(err)}`,
        };
      }
    }

    case '会话': {
      const sm = context.sessionManager;
      if (!sm) {
        return {
          handled: true,
          success: false,
          error: '执行 /会话 失败: 当前环境缺少 SessionManager 服务',
        };
      }
      const peer = sm.sessionIdToPeer(context.session.id);
      const peerName = sm.getPeerName(peer);
      const sessions = sm.listPeerSessionIds(peer); // 升序：旧→新

      if (!args) {
        const currentSid = sm.peerToSessionId(peer);
        const lines = [...sessions].reverse().map((sid, i) => {
          const num = sessions.length - i;
          const isCurrent = sid === currentSid ? ' [当前]' : '';
          const title = formatSessionTitle(peer, sid, peerName);
          return `${num}.${isCurrent} ${title} (${sid})`;
        });
        const peerDesc = formatSessionTitle(peer, currentSid, peerName).replace(/#\d+.*$/, '').trim();
        return {
          handled: true,
          success: true,
          reply: `历史会话列表（${peerDesc}）：\n${lines.join('\n')}\n\n切换方法：\n- 按序号切换：/会话 <序号>\n- 按标题切换：/会话 <标题>`,
        };
      }

      let targetSid: string | undefined;
      const numArg = parseInt(args, 10);
      if (!isNaN(numArg) && /^\d+$/.test(args)) {
        if (numArg < 1 || numArg > sessions.length) {
          return {
            handled: true,
            success: false,
            error: `序号无效，范围 1~${sessions.length}`,
          };
        }
        targetSid = sessions[numArg - 1];
      } else {
        const matched = sessions.filter((sid) => {
          const title = formatSessionTitle(peer, sid, peerName);
          return title.toLowerCase().includes(args.toLowerCase()) || sid.toLowerCase().includes(args.toLowerCase());
        });
        if (matched.length === 1) {
          targetSid = matched[0];
        } else if (matched.length > 1) {
          const candidates = matched.map((sid) => `- ${formatSessionTitle(peer, sid, peerName)} (${sid})`).join('\n');
          return {
            handled: true,
            success: false,
            error: `发现多个匹配的会话，请使用序号切换：\n${candidates}`,
          };
        } else {
          return {
            handled: true,
            success: false,
            error: '切换失败：未找到匹配的会话，请输入 /会话 查看可用列表',
          };
        }
      }

      if (!targetSid) {
        return {
          handled: true,
          success: false,
          error: '切换失败：未找到匹配的会话，请输入 /会话 查看可用列表',
        };
      }

      const ok = sm.resumeSession(peer, targetSid);
      const targetTitle = formatSessionTitle(peer, targetSid, peerName);
      return ok
        ? {
            handled: true,
            success: true,
            reply: `已切换到会话：${targetTitle} (${targetSid})`,
          }
        : {
            handled: true,
            success: false,
            error: '恢复失败：会话不存在或已归档',
          };
    }

    case '用量': {
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
      let lineHeader = `上下文已用：${fmt(totalTokens)}`;
      if (contextWindow && contextWindow > 0) {
        const percent = Math.min(100, Math.round((totalTokens / contextWindow) * 100));
        lineHeader += ` / ${formatTokens(contextWindow)} (${percent}%)`;
      }

      const lines = [lineHeader];
      const hasBreakdown =
        breakdown !== undefined ||
        systemTokens > 0 ||
        toolsTokens > 0 ||
        messageTokens > 0;

      if (hasBreakdown) {
        lines.push(`- 系统提示词：${fmt(systemTokens)}`);
        lines.push(`- 工具声明：${fmt(toolsTokens)}`);
        lines.push(`- 对话消息：${fmt(messageTokens)}`);
      }

      return {
        handled: true,
        success: true,
        reply: lines.join('\n'),
      };
    }

    case '状态': {
      const sm = context.sessionManager;
      const peer = sm ? sm.sessionIdToPeer(context.session.id) : context.session.id;
      const activeTurn = sm?.getActiveTurn?.(peer);
      const isBusy = activeTurn !== undefined || sm?.isSessionBusy?.(context.session.id);

      let statusStr = '空闲';
      if (activeTurn !== undefined) {
        statusStr = `正在运行（轮次 #${activeTurn}）`;
      } else if (isBusy) {
        statusStr = '正在运行';
      }

      const agents = context.ctx.get?.('agents') || (context.ctx as any).agents;
      const agent = agents?.get?.(context.session.id);
      const curSel = sm?.getModelSelection(context.session.id) || (agent as any)?.modelSelection?.current;
      const curProv = curSel?.provider || (agent as any)?.options?.provider || 'deepseek-official';
      const curMod = curSel?.model || (agent as any)?.options?.model || 'deepseek-v4-flash';
      const curEffort = curSel?.reasoningEffort;

      const reasoningInfo = await getModelReasoningInfo(context.ctx, curProv, curMod, curEffort);
      let effortStr = '不支持';
      if (reasoningInfo.supported) {
        const matched = reasoningInfo.efforts.find((e) => e.id === reasoningInfo.currentEffort);
        effortStr = matched ? `${matched.id} (${matched.name})` : (reasoningInfo.currentEffort || '默认');
      } else {
        effortStr = '当前模型不支持';
      }

      const permissionPresets = context.ctx.get('permissionPresets') || (context.ctx as any).permissionPresets;
      const rawMode = permissionPresets?.current?.(context.session) || 'workspace-write';
      let zhMode = '编辑';
      if (rawMode === 'danger-full-access' || rawMode === 'yolo') zhMode = '完全';
      else if (rawMode === 'readonly' || rawMode === 'read-only') zhMode = '只读';

      let ctxUsageStr = '0';
      const tokenMeter = context.ctx.get('tokenMeter') || (context.ctx as any).tokenMeter;
      if (tokenMeter?.measure) {
        try {
          const usage = tokenMeter.measure(context.session);
          const totalTokens = usage?.totalTokens ?? 0;
          let contextWindow: number | undefined;
          const sessionProjections = context.ctx.get('sessionProjections') || (context.ctx as any).sessionProjections;
          if (sessionProjections && typeof sessionProjections.snapshot === 'function') {
            try {
              const snap = sessionProjections.snapshot(context.session, ['contextPressure']);
              if (snap?.values?.contextPressure?.contextWindow) {
                contextWindow = snap.values.contextPressure.contextWindow;
              }
            } catch {}
          }
          if (contextWindow === undefined) {
            const llm = context.ctx.get('llm') || (context.ctx as any).llm;
            if (llm && typeof llm.resolveModel === 'function') {
              try {
                const info = await llm.resolveModel(curProv, curMod);
                if (info?.context?.contextWindow) contextWindow = info.context.contextWindow;
              } catch {}
            }
          }
          const fmt = (v: number) => (v > 0 ? `~${formatTokens(v)}` : '0');
          if (contextWindow && contextWindow > 0) {
            const percent = Math.min(100, Math.round((totalTokens / contextWindow) * 100));
            ctxUsageStr = `${fmt(totalTokens)} / ${formatTokens(contextWindow)} (${percent}%)`;
          } else {
            ctxUsageStr = fmt(totalTokens);
          }
        } catch {}
      }

      const parsed = parseSessionId(context.session.id);
      const versionStr = parsed ? ` (版本: ${parsed.version})` : '';
      const sessionIdent = `${context.session.id}${versionStr}`;

      const lines = [
        '【当前会话状态】',
        `运行状态：${statusStr}`,
        `当前模型：${curProv} / ${curMod}`,
        `思考等级：${effortStr}`,
        `权限模式：${zhMode}`,
        `上下文用量：${ctxUsageStr}`,
        `会话标识：${sessionIdent}`,
      ];

      return {
        handled: true,
        success: true,
        reply: lines.join('\n'),
      };
    }

    case '帮助': {
      const helpText = [
        '【快捷指令帮助】',
        '- /状态 : 查看当前运行状态、模型、权限与上下文总览',
        '- /模型 [模型名] : 查看或切换当前使用的模型',
        '- /权限 [只读|编辑|完全] : 查看或切换权限模式',
        '- /思考 [档位] : 查看或设置深度思考等级（如 off, low, high, max）',
        '- /会话 [序号|标题] : 列出历史会话或进行切换',
        '- /新建 : 开启全新会话（保留历史）',
        '- /用量 : 查看会话上下文用量明细',
        '- /停止 : 中断当前正在生成的回复',
        '- /帮助 : 查看本帮助说明',
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
        error: `未知指令：/${command}，输入 /帮助 查看可用指令`,
      };
    }
  }
}

