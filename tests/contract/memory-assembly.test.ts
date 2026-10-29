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
      budgetChars: 2200,
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

    // 3. 验证 systemPrompt.context 动态段渲染
    const systemPrompt = ctx.get('systemPrompt') || (ctx as any).systemPrompt;
    expect(systemPrompt).toBeDefined();

    // 模拟组装群聊 System Prompt
    const assembledGroup = await systemPrompt.assemble({
      session: { id: 'qq-group-3000000001-1' },
    });

    const memCtxGroup = assembledGroup.contexts.find((c: any) => c.name === 'napcat:memory');
    expect(memCtxGroup).toBeDefined();
    expect(memCtxGroup?.text).toContain('### Session 记忆（group_3000000001）');
    expect(memCtxGroup?.text).toContain('群规：技术交流');
    expect(memCtxGroup?.text).not.toContain('### 用户偏好与画像');
    expect(memCtxGroup?.text).toContain('### BotNickname (2000000001)\n项目架构师');

    // 4. 验证 Web UI 普通会话（非 QQ）不注入 QQ 记忆
    const assembledWeb = await systemPrompt.assemble({
      session: { id: 'web-session-123' },
    });
    const memCtxWeb = assembledWeb.contexts.find((c: any) => c.name === 'napcat:memory');
    expect(memCtxWeb?.text || '').toBe('');

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
      budgetChars: 2200,
    });

    const toolsService = ctx.get('tools') || (ctx as any).tools;
    const createTool = toolsService.get('create_memory');
    const systemPrompt = ctx.get('systemPrompt') || (ctx as any).systemPrompt;

    // 第一轮：初始无记忆
    const prompt1 = await systemPrompt.assemble({
      session: { id: 'qq-user-99999-1' },
    });
    const memCtx1 = prompt1.contexts.find((c: any) => c.name === 'napcat:memory');
    expect(memCtx1?.text || '').toBe('');

    // 模拟 Agent 在第 1 轮中通过 create_memory 首次写入会话记忆
    await createTool.execute(
      { type: 'session', content: '私聊约定：只发代码不废话' },
      { agent: { session: { id: 'qq-user-99999-1' } } }
    );

    // 第二轮：动态重算立即包含新记忆
    const prompt2 = await systemPrompt.assemble({
      session: { id: 'qq-user-99999-1' },
    });
    const memCtx2 = prompt2.contexts.find((c: any) => c.name === 'napcat:memory');
    expect(memCtx2?.text).toContain('### Session 记忆（user_99999）');
    expect(memCtx2?.text).toContain('私聊约定：只发代码不废话');

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
      user_id: '1111111111',
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
      user_id: '2222222222',
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
      user_id: '4444444444',
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
      budgetChars: 2200,
      getCurrentSpeaker: (peer) => (peer === 'group_3000000002' ? '3333333333' : undefined),
      db,
    });

    // 写入 UserA(1000字), UserB(1400字), 以及刚刚冒泡发言但不在活跃前列的 UserC(300字), 以及活跃成员 UserD(500字)
    await memoryService.storage.writeUserProfile('1111111111', 'A'.repeat(1000));
    await memoryService.storage.writeUserProfile('2222222222', 'B'.repeat(1400));
    await memoryService.storage.writeUserProfile('3333333333', 'C'.repeat(300));
    await memoryService.storage.writeUserProfile('4444444444', 'D'.repeat(500));

    const systemPrompt = ctx.get('systemPrompt') || (ctx as any).systemPrompt;

    // 当前收到来自 UserC (3333333333) 的消息，正在组装该轮 prompt (D2/B13: 真实上下文，不假造 userId)
    const assembledGroup = await systemPrompt.assemble({
      session: { id: 'qq-group-3000000002-1' },
    });

    const memCtx = assembledGroup.contexts.find((c: any) => c.name === 'napcat:memory');
    expect(memCtx).toBeDefined();
    // 验证 UserC 被动态阶梯提拔至最前，并成功注入
    expect(memCtx?.text).toContain('3333333333');
    const idxUserC = memCtx?.text.indexOf('3333333333');
    const idxUserA = memCtx?.text.indexOf('1111111111');
    expect(idxUserC).toBeGreaterThan(-1);
    expect(idxUserA).toBeGreaterThan(-1);
    expect(idxUserC).toBeLessThan(idxUserA);

    // 验证因为达到预算导致后续画像省略，注入了通用的截断提示
    expect(memCtx?.text).toContain('受字符预算限制');
    expect(memCtx?.text).toContain("read_memory(type='user', qq='<QQ号>')");

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

    const systemPrompt = ctx.get('systemPrompt') || (ctx as any).systemPrompt;
    const assembled = await systemPrompt.assemble({
      session: { id: 'qq-group-3000000001-1' },
    });

    const personaCtx = assembled.contexts.find(
      (c: any) => c.name === 'napcat:behavior_persona'
    );
    expect(personaCtx).toBeDefined();
    expect(personaCtx?.text).toContain('测试人格');
    // 验证包含记忆工具规则与自然顺手维护引导
    expect(personaCtx?.text).toContain('记忆工具规则');
    expect(personaCtx?.text).toContain('不必每轮都调用记忆工具');
    expect(personaCtx?.text).toContain('create_memory');

    disposePrompt();
  });
});
