/**
 * tests/contract/face-assembly.test.ts
 * 契约测试: 表情包模块真实装配闭环 (Real Assembly via bootDshNapcatBridge)
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { bootDshNapcatBridge, type BootedDsh } from '../../src/boot.js';
import * as NapCatBridgePlugin from '../../src/index.js';

describe('契约测试: 表情包系统真实装配闭环 (Face Assembly Contract)', () => {
  let booted: BootedDsh | null = null;
  let tmpHome: string | null = null;

  afterEach(async () => {
    if (booted) {
      await booted.dispose();
      booted = null;
    }
    if (tmpHome && fs.existsSync(tmpHome)) {
      try {
        fs.rmSync(tmpHome, { recursive: true, force: true });
      } catch {}
      tmpHome = null;
    }
  });

  it('装配 1: 默认状态 (face_enabled=false) 真实装配下绝不暴露表情工具', async () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-face-asm-off-'));
    booted = await bootDshNapcatBridge({
      dshHome: tmpHome,
      mountPlugin: false,
    });

    // 以默认配置 (face_enabled: false) 挂载插件
    await booted.ctx.plugin(NapCatBridgePlugin, {
      ws_port: 29991,
      face_enabled: false,
    });

    const toolsService = (booted.ctx.get('tools') || (booted.ctx as any).tools) as any;
    expect(toolsService).toBeDefined();

    expect(toolsService.get('list_faces')).toBeUndefined();
    expect(toolsService.get('send_face')).toBeUndefined();
    expect(toolsService.get('collect_face')).toBeUndefined();
  });

  it('装配 2: 开启总开关 (face_enabled=true) 真实装配下完整挂载表情工具并可执行', async () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-face-asm-on-'));
    booted = await bootDshNapcatBridge({
      dshHome: tmpHome,
      mountPlugin: false,
    });

    // 开启表情总开关挂载插件
    await booted.ctx.plugin(NapCatBridgePlugin, {
      ws_port: 29992,
      face_enabled: true,
      face_store_max: 50,
      face_sub_type: 1,
    });

    const toolsService = (booted.ctx.get('tools') || (booted.ctx as any).tools) as any;
    expect(toolsService).toBeDefined();

    const listFacesTool = toolsService.get('list_faces');
    const sendFaceTool = toolsService.get('send_face');
    const collectFaceTool = toolsService.get('collect_face');

    expect(listFacesTool).toBeDefined();
    expect(sendFaceTool).toBeDefined();
    expect(collectFaceTool).toBeDefined();

    // 验证真实工具可执行且返回结构符合契约
    const res = await listFacesTool.execute({}, { agent: { session: { id: 'qq-group-8000000002' } } });
    expect(res).toBeDefined();
    expect(res.faces).toEqual([]);
    expect(res.total).toBe(0);

    // 验证插入未打标表情后执行 list_faces 返回结果严格满足 Lossless JSON
    const dbPath = path.join(tmpHome, 'napcat', 'messages.sqlite');
    const { MessageDatabase } = await import('../../src/storage/database.js');
    const db = new MessageDatabase(dbPath);
    db.init();
    db.insertFace({
      id: 'face_test_lossless',
      file_path: '/fake/path/lossless.png',
      md5: 'md5_lossless_test',
      source: 'manual',
      tags: [],
      size: 100,
      format: 'png',
    });
    db.close();

    const res2 = await listFacesTool.execute({}, { agent: { session: { id: 'qq-group-8000000002' } } });
    expect(res2.faces).toHaveLength(1);
    expect(res2.faces[0].id).toBe('face_test_lossless');
    expect(Object.hasOwn(res2.faces[0], 'mood')).toBe(false);
    expect(Object.hasOwn(res2, 'next_cursor')).toBe(false);
  });
});
