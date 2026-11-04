/**
 * tests/contract/read-chat-history-peer.test.ts
 *
 * 契约测试: read_chat_history 显式 peer 参数寻址与真实装配闭环
 *
 * 缺陷背景:
 * 工具 schema 暴露了 peer 参数，但 execute 无条件以当前会话 session.id 覆盖之，
 * 导致在私聊中传 peer="group_xxx" 仍返回私聊历史（peer 被静默忽略）。
 *
 * 覆盖规范:
 * 1. 显式 peer 优先于当前会话 (真实工具装配路径，非纯函数直调)
 * 2. 支持 qq-group- 形式归一化，并严格保持会话隔离
 * 3. 缺省 peer 时仍回落当前会话
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fsp } from 'node:fs';
import { Context } from '@deepseek-ai/cordis';
import { MessageDatabase } from '../../src/storage/database.js';
import { registerAgentTools } from '../../src/tools/index.js';

const SELF_QQ = '1000000000';
const FRIEND_QQ = '1000000001';
const GROUP_ID = '8000000001';

describe('契约测试: read_chat_history 显式 peer 寻址', () => {
  let tmpDir: string;
  let db: MessageDatabase;
  let historyTool: any;

  function save(record: {
    msg_id: number;
    peer: string;
    user_id: string;
    sender_name: string;
    time: number;
    content: string;
  }): void {
    db.saveMessage({
      ...record,
      type: 'text',
      raw: '{}',
      file_id: null,
      busid: null,
      local_path: null,
      fingerprint: null,
      recalled: 0,
      self: 0,
      reply_to: null,
    });
  }

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-read-history-peer-'));
    db = new MessageDatabase(path.join(tmpDir, 'messages.sqlite'));
    db.init();

    // 当前私聊会话（1503 条等大量历史在真实环境的缩影）
    save({
      msg_id: 10001,
      peer: `user_${FRIEND_QQ}`,
      user_id: FRIEND_QQ,
      sender_name: '测试好友',
      time: 1793716500000,
      content: '私聊里的消息',
    });
    // 目标群聊会话（应可通过 peer 参数读取）
    save({
      msg_id: 20001,
      peer: `group_${GROUP_ID}`,
      user_id: '2000000002',
      sender_name: '群友 A',
      time: 1793716510000,
      content: '111',
    });
    save({
      msg_id: 20002,
      peer: `group_${GROUP_ID}`,
      user_id: '2000000003',
      sender_name: '群友 B',
      time: 1793716520000,
      content: '群里第二条',
    });

    const mockCtx = new Context();
    const registeredTools: any[] = [];
    mockCtx.provide('tools', {
      register: (tool: any) => {
        registeredTools.push(tool);
        return () => {};
      },
    });
    registerAgentTools(mockCtx, {
      db,
      dshHome: tmpDir,
      config: {},
    });
    historyTool = registeredTools.find((t) => t.name === 'read_chat_history');
    expect(historyTool).toBeDefined();
  });

  afterEach(async () => {
    db.close();
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it('缺省 peer 时回落当前会话', async () => {
    const res = await historyTool.execute(
      {},
      { agent: { session: { id: `qq-user-${FRIEND_QQ}` } } }
    );

    expect(res.total).toBe(1);
    expect(res.messages.map((m: any) => m.content)).toEqual(['私聊里的消息']);
  });

  it('显式 peer 优先于当前会话，可在私聊中查看指定群最新消息', async () => {
    const res = await historyTool.execute(
      { peer: `group_${GROUP_ID}` },
      { agent: { session: { id: `qq-user-${FRIEND_QQ}` } } }
    );

    expect(res.total).toBe(2);
    expect(res.messages.map((m: any) => m.content)).toEqual(['群里第二条', '111']);
    // 绝不能把当前私聊消息混入目标群查询结果
    expect(res.messages.some((m: any) => m.content === '私聊里的消息')).toBe(false);
  });

  it('支持 qq-group- 前缀归一化，行为与 group_ 一致', async () => {
    const res = await historyTool.execute(
      { peer: `qq-group-${GROUP_ID}` },
      { agent: { session: { id: `qq-user-${FRIEND_QQ}` } } }
    );

    expect(res.total).toBe(2);
    expect(res.messages.some((m: any) => m.msg_id === 20002)).toBe(true);
    expect(res.messages.some((m: any) => m.content === '私聊里的消息')).toBe(false);
  });

  it('显式 peer 与筛选条件可组合，且 peer 字段不污染筛选参数', async () => {
    const res = await historyTool.execute(
      { peer: `group_${GROUP_ID}`, keyword: '111' },
      { agent: { session: { id: `qq-user-${FRIEND_QQ}` } } }
    );

    expect(res.total).toBe(1);
    expect(res.messages[0].msg_id).toBe(20001);
    expect(res.messages[0].content).toBe('111');
  });
});
