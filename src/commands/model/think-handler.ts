/**
 * dsh-napcat-bridge: /思考 命令处理器
 */

import { safeGetService } from '../../gateway/session/agent-runner.js';
import type { CommandContext, CommandResult } from '../types.js';
import { safeSyncSessionModel } from './sync.js';
import { getModelReasoningInfo } from './reasoning.js';

export async function handleThinkCommand(
  args: string,
  context: CommandContext
): Promise<CommandResult> {
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

  const agents = safeGetService(context.ctx, 'agents');
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
        try {
          await safeSyncSessionModel(context.ctx, sid, curProv, curMod, targetEffort);
        } catch (syncErr: any) {
          context.ctx.logger?.('dsh-napcat-bridge')?.debug?.(
            `[Command] 全局切换思考深度同步宿主会话 ${sid} 失败 (已跳过离线/失效会话):`,
            syncErr?.message || syncErr
          );
        }
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
        ].filter(Boolean).join('\n'),
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
