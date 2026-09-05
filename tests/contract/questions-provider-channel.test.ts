import { describe, it, expect } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import {
  NapCatQuestionProvider,
  registerNapCatQuestionChannel,
} from '../../src/approval/responder.js';

/**
 * 契约测试: TD-001 提问 provider 级联路由接入（DSH 0.1.2-rc.1 官方 user-questions/request waterfall 机制）
 *
 * 验证：
 * - 情况 1: QQ 会话由 NapCat 渠道拦截并由 NapCatQuestionProvider 处理；
 * - 情况 2: 非 QQ 会话（如 Web 会话）调用 next() 委托给宿主/其他提问处理者；
 * - 情况 3: 多处理者在 waterfall 中并存，无 DUPLICATE_PROVIDER 互斥；
 * - 情况 4: 自定义 isQQSession 判定生效；
 * - 情况 5: unregister 注销清理监听器，后续请求不再拦截。
 */

/** 构造 NapCatQuestionProvider：gateway 不可达 → ask 立即 reject（可 await，不悬挂） */
function makeQuestionProvider(rejectsMessage: string) {
  const qp = new NapCatQuestionProvider({
    gateway: {
      sendMsg: async () => {
        throw new Error(rejectsMessage);
      },
    } as any,
    sessionManager: {
      sessionIdToPeer: (id: string) => (id.startsWith('qq-group-') ? `group_${id.slice(9)}` : id),
    } as any,
  });
  const originalAsk = qp.ask.bind(qp);
  let askCount = 0;
  qp.ask = (async (request: any) => {
    askCount += 1;
    return originalAsk(request);
  }) as any;
  (qp as any)._askCount = () => askCount;
  return qp;
}

describe('契约测试: TD-001 提问 provider 组合路由 (Composite Question Provider via Waterfall)', () => {
  it('情况 1: QQ 会话触发 user-questions/request 时由 NapCat 渠道拦截处理', async () => {
    const ctx = new Context();
    const qp = makeQuestionProvider('napcat offline');

    const unregister = registerNapCatQuestionChannel(ctx, { questionProvider: qp });

    // QQ 会话请求
    const req = {
      agent: { id: 'qq-group-1001', session: { id: 'qq-group-1001' } },
      questions: [{ id: 'q1', question: '请选择' }],
    };

    await expect(
      ctx.waterfall('user-questions/request', req as any, () => Promise.reject(new Error('no provider')))
    ).rejects.toThrow('napcat offline');

    unregister();
  });

  it('情况 2: 非 QQ 会话（Web 会话）触发 user-questions/request 时，级联委托给宿主处理者', async () => {
    const ctx = new Context();
    const qp = makeQuestionProvider('napcat offline');

    // 宿主处理者
    ctx.on('user-questions/request', async (req: any, next: any) => {
      const sid = req.agent?.session?.id || req.agent?.id || '';
      if (!sid.startsWith('qq-')) {
        return { answers: [{ id: 'q1', selected: ['web-answer'] }] };
      }
      return next();
    });

    const unregister = registerNapCatQuestionChannel(ctx, { questionProvider: qp });

    // Web 会话请求
    const webReq = {
      agent: { id: 'web-session-1', session: { id: 'web-session-1' } },
      questions: [{ id: 'q1', question: '请选择' }],
    };

    const res = await ctx.waterfall(
      'user-questions/request',
      webReq as any,
      () => Promise.reject(new Error('no provider'))
    );
    expect(res).toEqual({ answers: [{ id: 'q1', selected: ['web-answer'] }] });

    unregister();
  });

  it('情况 3: 多渠道共存与时序无序性（先注宿主或先注 NapCat 均能级联共存）', async () => {
    const ctx = new Context();
    const qp = makeQuestionProvider('napcat offline');

    const unregisterNapcat = registerNapCatQuestionChannel(ctx, { questionProvider: qp });

    let hostCalled = false;
    const offHost = ctx.on('user-questions/request', async (req: any, next: any) => {
      hostCalled = true;
      return { answers: [{ id: 'q1', selected: ['host-ok'] }] };
    });

    // 1. QQ 会话走 NapCat
    await expect(
      ctx.waterfall(
        'user-questions/request',
        { agent: { session: { id: 'qq-group-1002' } }, questions: [{ id: 'q1', question: 'x' }] } as any,
        () => Promise.reject(new Error('no answerer'))
      )
    ).rejects.toThrow('napcat offline');

    // 2. 非 QQ 会话穿透到宿主
    const webRes = await ctx.waterfall(
      'user-questions/request',
      { agent: { session: { id: 'web-session-2' } }, questions: [{ id: 'q1', question: 'x' }] } as any,
      () => Promise.reject(new Error('no answerer'))
    );
    expect(hostCalled).toBe(true);
    expect(webRes).toEqual({ answers: [{ id: 'q1', selected: ['host-ok'] }] });

    unregisterNapcat();
    offHost();
  });

  it('情况 4: 路由判定支持自定义 isQQSession 函数', async () => {
    const ctx = new Context();
    const qp = makeQuestionProvider('napcat offline');

    // 仅针对 'qq-42' 进行拦截
    const unregister = registerNapCatQuestionChannel(ctx, {
      questionProvider: qp,
      isQQSession: (sessionId) => sessionId === 'qq-42',
    });

    let hostCalled = false;
    const offHost = ctx.on('user-questions/request', async (req: any, next: any) => {
      hostCalled = true;
      return { answers: [] };
    });

    // 'qq-other' 应该穿透至宿主
    const res = await ctx.waterfall(
      'user-questions/request',
      { agent: { id: 'qq-other' }, questions: [{ id: 'q1', question: 'x' }] } as any,
      () => Promise.reject(new Error('no answerer'))
    );
    expect(hostCalled).toBe(true);
    expect(res).toEqual({ answers: [] });

    // 'qq-42' 应该由 NapCat 拦截
    await expect(
      ctx.waterfall(
        'user-questions/request',
        { agent: { session: { id: 'qq-42' } }, questions: [{ id: 'q1', question: 'x' }] } as any,
        () => Promise.reject(new Error('no answerer'))
      )
    ).rejects.toThrow('napcat offline');

    unregister();
    offHost();
  });

  it('情况 5: 注销 unregister 清除监听器，后续请求全部穿透', async () => {
    const ctx = new Context();
    const qp = makeQuestionProvider('napcat offline');

    const unregister = registerNapCatQuestionChannel(ctx, { questionProvider: qp });
    unregister();

    let defaultReached = false;
    await ctx.waterfall(
      'user-questions/request',
      { agent: { session: { id: 'qq-group-1001' } }, questions: [{ id: 'q1', question: 'x' }] } as any,
      () => {
        defaultReached = true;
        return Promise.resolve({ answers: [{ id: 'q1', selected: ['fallback'] }] });
      }
    );
    expect(defaultReached).toBe(true);
  });
});