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
    expect(toolsService.get('append_memory')).toBeDefined();
    expect(toolsService.get('update_memory')).toBeDefined();

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
    expect(memCtxGroup?.text).not.toContain('### Session 记忆');
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
    const appendTool = toolsService.get('append_memory');
    const systemPrompt = ctx.get('systemPrompt') || (ctx as any).systemPrompt;

    // 第一轮：初始无记忆
    const prompt1 = await systemPrompt.assemble({
      session: { id: 'qq-user-99999-1' },
    });
    const memCtx1 = prompt1.contexts.find((c: any) => c.name === 'napcat:memory');
    expect(memCtx1?.text || '').toBe('');

    // 模拟 Agent 在第 1 轮中遵循 read-before-write 规范，先 read_memory 后 append_memory
    const readTool = toolsService.get('read_memory');
    await readTool.execute(
      { type: 'session' },
      { agent: { session: { id: 'qq-user-99999-1' } } }
    );
    await appendTool.execute(
      { type: 'session', content: '私聊约定：只发代码不废话' },
      { agent: { session: { id: 'qq-user-99999-1' } } }
    );

    // 第二轮：动态重算立即包含新记忆
    const prompt2 = await systemPrompt.assemble({
      session: { id: 'qq-user-99999-1' },
    });
    const memCtx2 = prompt2.contexts.find((c: any) => c.name === 'napcat:memory');
    expect(memCtx2?.text).not.toContain('### Session 记忆');
    expect(memCtx2?.text).toContain('# Session 记忆（user_99999）');
    expect(memCtx2?.text).toContain('私聊约定：只发代码不废话');

    memoryService.dispose();
  });
});
