/**
 * dsh-napcat-bridge: 共享 per-peer 串行发送器 (Spec §7.3)
 * 正文回复、提问卡片、审批通知、主动发文件均须经由同一条 per-peer 串行队列下发，
 * 彻底根治同 turn 内"提问卡片先于正文到达"的竞发乱序问题 (P-02)。
 * 每个 peer 维护单一 Promise 链，任务依入队顺序依次执行；单任务失败不会阻塞后续任务。
 */

import type { SerialSender } from '../types/index.js';

/**
 * 按 peer 串行化异步任务的发送器。
 * - 同一 peer 的 enqueue 任务严格按入队顺序执行；
 * - 不同 peer 之间互不阻塞；
 * - 单个任务 reject 只影响其调用方，串行链继续推进。
 */
export class PerPeerSerialSender implements SerialSender {
  private chains = new Map<string, Promise<unknown>>();

  enqueue<T>(peer: string, task: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(peer) ?? Promise.resolve();
    const run = prev.then(() => task());
    // 链上以"已消化结果"的 promise 接续，保证前置任务 reject 也不阻塞后续任务
    this.chains.set(
      peer,
      run.then(
        () => undefined,
        () => undefined
      )
    );
    return run;
  }

  /** 清空全部队列 (dispose 时调用，队列中未完成任务的调用方仍会收到对应结果/错误) */
  clear(): void {
    this.chains.clear();
  }
}