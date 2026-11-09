/**
 * dsh-napcat-bridge: /模型 命令处理器
 */

import { safeGetService } from '../../gateway/session/agent-runner.js';
import type { CommandContext, CommandResult } from '../types.js';
import { getDiscoveredModels } from './discovery.js';
import { safeSyncSessionModel } from './sync.js';
import { getModelReasoningInfo } from './reasoning.js';
import type { DiscoveredModelInfo } from './types.js';

export async function handleModelCommand(
  args: string,
  context: CommandContext
): Promise<CommandResult> {
  const discovered = await getDiscoveredModels(context.ctx);
  const agents = safeGetService(context.ctx, 'agents');
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
        try {
          await safeSyncApiProxy(sid, targetProvider, targetModel, targetEffort);
        } catch (syncErr: any) {
          context.ctx.logger?.('dsh-napcat-bridge')?.debug?.(
            `[Command] 全局切换模型同步宿主会话 ${sid} 失败 (已跳过离线/失效会话):`,
            syncErr?.message || syncErr
          );
        }
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
