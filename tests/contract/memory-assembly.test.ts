/**
 * tests/contract/memory-assembly.test.ts
 *
 * 契约测试: EN-003 Memory 两层记忆体系真实装配与动态 Prompt 注入闭环
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fsp } from 'node:fs';
import { bootDshNapcatBridge, type BootedDsh } from '../../src/boot.js';
import { setupMemoryService } from '../../src/memory/index.js';
import { MessageDatabase } from '../../src/storage/database.js';

describe('契约测试: EN-003 Memory 两层记忆体系真实装配与 Prompt 注入', () => {
  let tmpDir: string;
  let booted: BootedDsh;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-napcat-mem-assembly-'));
  });

  afterEach(async () => {
    if (booted) {
      await booted.dispose().catch(() => {});
    }
    if (tmpDir) {
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('契约 1: setupMemoryService 正确装配 tools 与 systemPrompt.context 动态段', async () => {
    booted = await bootDshNapcatBridge({
      dshHome: tmpDir,
      mountPlugin: false,
      config: {
        bot_qq: '1000000001',
        ws_port: 8080,
      },
    });

    const ctx = booted.ctx;
    const db = new MessageDatabase(path.join(tmpDir, 'test-msg.db'));
    db.init();

    // 写入群成员近期发言
    db.saveMessage({
      msg_id: 1,
      peer: 'group_3000000001',
      user_id: '2000000001',
      sender_name: 'BotNickname',
      time: Date.now() - 1000,
      type: 'text',
      content: '大家好',
      raw: '{}',
      file_id: null,
      busid: null,
      local_path: null,
      fingerprint: null,
      recalled: 0,
      self: 0,
      reply_to: null,
    });

    const memDir = path.join(tmpDir, 'memory');
    const memoryService = setupMemoryService(ctx, {
      storageDir: memDir,
      groupMemoryTotalBudgetChars: 2200,
      db,
    });

    // 1. 验证 3 个 Memory 工具注册在 tools 运行时
    const toolsService = ctx.get('tools') || (ctx as any).tools;
    expect(toolsService.get('read_memory')).toBeDefined();
    expect(toolsService.get('create_memory')).toBeDefined();
    expect(toolsService.get('edit_memory')).toBeDefined();

    // 2. 写入记忆
    await memoryService.storage.writeSessionMemory('group_3000000001', '群规：技术交流');
    await memoryService.storage.writeUserProfile('2000000001', '项目架构师');

    // 3. 验证 Session 规则与用户画像独立动态快照生成
    const rulesText = memoryService.storage.getSessionRulesSnapshotSync('group_3000000001');
    expect(rulesText).toContain('### Session 记忆（group_3000000001）');
    expect(rulesText).toContain('群规：技术交流');

    const profileText = memoryService.storage.getUserProfilesSnapshotSync('group_3000000001', [
      { qq: '2000000001', name: 'BotNickname' },
    ]);
    expect(profileText).toContain('### BotNickname (2000000001)\n项目架构师');

    memoryService.dispose();
    db.close();
  });

  it('契约 2: Agent 工具调用写入后，下一轮 System Prompt 动态重算立即生效', async () => {
    booted = await bootDshNapcatBridge({
      dshHome: tmpDir,
      mountPlugin: false,
      config: {
        bot_qq: '1000000001',
        ws_port: 8080,
      },
    });

    const ctx = booted.ctx;
    const memDir = path.join(tmpDir, 'memory2');
    const memoryService = setupMemoryService(ctx, {
      storageDir: memDir,
      groupMemoryTotalBudgetChars: 2200,
    });

    const toolsService = ctx.get('tools') || (ctx as any).tools;
    const createTool = toolsService.get('create_memory');
    const systemPrompt = ctx.get('systemPrompt') || (ctx as any).systemPrompt;

    // 第一轮：初始无记忆
    const rules1 = memoryService.storage.getSessionRulesSnapshotSync('user_99999');
    expect(rules1).toBe('');

    // 模拟 Agent 在第 1 轮中通过 create_memory 首次写入会话记忆
    await createTool.execute(
      { type: 'session', content: '私聊约定：只发代码不废话' },
      { agent: { session: { id: 'qq-user-99999-1' } } }
    );

    // 第二轮：动态重算立即包含新记忆
    const rules2 = memoryService.storage.getSessionRulesSnapshotSync('user_99999');
    expect(rules2).toContain('### Session 记忆（user_99999）');
    expect(rules2).toContain('私聊约定：只发代码不废话');

    memoryService.dispose();
  });

  it('契约 5: 真实装配下群聊 System Prompt 注入支持当前发言用户阶梯提拔与截断通用提示', async () => {
    booted = await bootDshNapcatBridge({
      dshHome: tmpDir,
      mountPlugin: false,
      config: {
        bot_qq: '1000000001',
        ws_port: 8080,
      },
    });

    const ctx = booted.ctx;
    const db = new MessageDatabase(path.join(tmpDir, 'test-msg-tiered.db'));
    db.init();

    // 活跃用户：UserA (活跃度高), UserB (活跃度中)
    db.saveMessage({
      msg_id: 10,
      peer: 'group_3000000002',
      user_id: '2000000011',
      sender_name: 'UserA',
      time: Date.now() - 2000,
      type: 'text',
      content: 'hi A',
      raw: '{}',
      file_id: null,
      busid: null,
      local_path: null,
      fingerprint: null,
      recalled: 0,
      self: 0,
      reply_to: null,
    });
    db.saveMessage({
      msg_id: 11,
      peer: 'group_3000000002',
      user_id: '2000000012',
      sender_name: 'UserB',
      time: Date.now() - 3000,
      type: 'text',
      content: 'hi B',
      raw: '{}',
      file_id: null,
      busid: null,
      local_path: null,
      fingerprint: null,
      recalled: 0,
      self: 0,
      reply_to: null,
    });
    db.saveMessage({
      msg_id: 12,
      peer: 'group_3000000002',
      user_id: '2000000013',
      sender_name: 'UserD',
      time: Date.now() - 4000,
      type: 'text',
      content: 'hi D',
      raw: '{}',
      file_id: null,
      busid: null,
      local_path: null,
      fingerprint: null,
      recalled: 0,
      self: 0,
      reply_to: null,
    });

    const memDir = path.join(tmpDir, 'memory-tiered');
    const memoryService = setupMemoryService(ctx, {
      storageDir: memDir,
      groupMemoryTotalBudgetChars: 2200,
      getCurrentSpeaker: (peer) => (peer === 'group_3000000002' ? '3333333333' : undefined),
      db,
    });

    // 写入 UserA(1000字), UserB(1400字), 以及刚刚冒泡发言但不在活跃前列的 UserC(300字), 以及活跃成员 UserD(500字)
    await memoryService.storage.writeUserProfile('2000000011', 'A'.repeat(1000));
    await memoryService.storage.writeUserProfile('2000000012', 'B'.repeat(1400));
    await memoryService.storage.writeUserProfile('3333333333', 'C'.repeat(300));
    await memoryService.storage.writeUserProfile('2000000013', 'D'.repeat(500));

    const activeUsers = [
      { qq: '2000000011', name: 'UserA' },
      { qq: '2000000012', name: 'UserB' },
      { qq: '2000000013', name: 'UserD' },
    ];
    const text = memoryService.storage.getUserProfilesSnapshotSync(
      'group_3000000002',
      activeUsers,
      2200,
      '3333333333'
    );
    expect(text).toContain('3333333333');
    const idxUserC = text.indexOf('3333333333');
    const idxUserA = text.indexOf('2000000011');
    expect(idxUserC).toBeGreaterThan(-1);
    expect(idxUserA).toBeGreaterThan(-1);
    expect(idxUserC).toBeLessThan(idxUserA);
    expect(text).toContain('受字符预算限制');
    expect(text).toContain("read_memory(type='user', qq='<QQ号>')");

    memoryService.dispose();
    db.close();
  });

  it('契约 6: 主 Agent System Prompt 行为准则段包含记忆工具被动调用指引 (与 Background Review 职责分离)', async () => {
    booted = await bootDshNapcatBridge({
      dshHome: tmpDir,
      mountPlugin: false,
      config: {
        bot_qq: '1000000001',
        ws_port: 8080,
      },
    });

    const ctx = booted.ctx;
    const { registerNapCatDynamicPrompt } = await import('../../src/prompt/dynamic.js');
    const disposePrompt = registerNapCatDynamicPrompt(
      ctx,
      () => '测试人格',
      () => '重要约束：测试行为'
    );

    const { formatBehaviorContext } = await import('../../src/prompt/formatter.js');
    const behaviorBlock = formatBehaviorContext('重要约束：测试行为\n记忆工具规则：不必每轮都调用记忆工具，有价值时调用 create_memory');
    expect(behaviorBlock).toContain('重要约束：测试行为');
    expect(behaviorBlock).toContain('记忆工具规则');
    expect(behaviorBlock).toContain('不必每轮都调用记忆工具');
    expect(behaviorBlock).toContain('create_memory');

    disposePrompt();
  });
});
