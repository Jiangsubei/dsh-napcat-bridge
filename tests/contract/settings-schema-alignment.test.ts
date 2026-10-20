import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { BridgeConfigSchema } from '../../src/config/schema.js';
import { DEFAULT_BASE_CONFIG } from '../../src/server/routes.js';
import { migrateLegacyConfig, readLegacyConfig } from '../../src/config/migrate.js';

describe('阶段 2 契约测试：设置系统收尾与三方键一致性 (Settings Alignment Contract)', () => {
  it('A8: Schema、服务端默认值、客户端默认值三方键严格一致，且 memory_budget_chars 彻底移除', () => {
    // 1. 读取 Schema 键
    const schemaShape = (BridgeConfigSchema as any).dict || (BridgeConfigSchema as any).shape || {};
    const schemaKeys = Object.keys(schemaShape).sort();

    // 2. 读取服务端默认值键
    const serverKeys = Object.keys(DEFAULT_BASE_CONFIG).sort();

    // 3. 读取客户端 card.tsx 源码中的 DEFAULT_BASE_CONFIG 键
    const cardContent = fs.readFileSync(path.resolve(process.cwd(), 'src/client/card.tsx'), 'utf8');
    const match = cardContent.match(/const DEFAULT_BASE_CONFIG: Partial<BridgePluginConfig> = \{([\s\S]*?)\};/);
    expect(match).toBeTruthy();
    const cardBlock = match![1];
    const clientKeys = cardBlock
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('//') && line.includes(':'))
      .map((line) => line.split(':')[0].trim())
      .sort();

    // 断言 1: 三方键数量均为 25
    expect(schemaKeys.length).toBe(25);
    expect(serverKeys.length).toBe(25);
    expect(clientKeys.length).toBe(25);

    // 断言 2: 三方键集合完全恒等
    expect(schemaKeys).toEqual(serverKeys);
    expect(clientKeys).toEqual(serverKeys);

    // 断言 3: memory_budget_chars 不存在于任何一方
    expect(schemaKeys.includes('memory_budget_chars')).toBe(false);
    expect(serverKeys.includes('memory_budget_chars')).toBe(false);
    expect(clientKeys.includes('memory_budget_chars')).toBe(false);
  });

  it('A7: 运行时热更字段标记为 .volatile()，核心身份 bot_qq 保留为非 volatile', () => {
    const schemaShape = (BridgeConfigSchema as any).dict || (BridgeConfigSchema as any).shape || {};

    // 验证 bot_qq 不应易失
    expect(schemaShape.bot_qq?.meta?.volatile).toBeFalsy();

    // 验证可热更新的业务字段必须带有 .volatile() 标记
    const volatileFields = [
      'ws_port',
      'ws_token',
      'persona',
      'behavior',
      'admins',
      'aliases',
      'at_questioner',
      'quote_original',
      'image_ttl_days',
      'proactive_reply_enabled',
      'proactive_only_text',
      'group_memory_budget_chars',
      'private_memory_budget_chars',
      'review_enabled',
      'memory_storage_dir',
    ];

    for (const field of volatileFields) {
      expect(
        schemaShape[field]?.meta?.volatile,
        `field ${field} should be marked .volatile()`
      ).toBe(true);
    }
  });

  it('A8: migrateLegacyConfig 旧配置单向迁移：映射 memory_budget_chars 至 group 键并不写回旧键', () => {
    // 构造旧版 yaml 内容
    const legacyYaml = `
dsh-napcat-bridge:
  bot_qq: "987654321"
  ws_port: 8099
  memory_budget_chars: 3333
`;
    const tmpDir = path.resolve(process.cwd(), 'tmp/test-migrate-legacy');
    fs.mkdirSync(tmpDir, { recursive: true });
    const legacyPath = path.join(tmpDir, 'settings.yaml');
    fs.writeFileSync(legacyPath, legacyYaml, 'utf8');

    try {
      const parsed = readLegacyConfig(tmpDir);
      expect(parsed).toBeTruthy();
      // 必须映射到新键
      expect(parsed!.group_memory_budget_chars).toBe(3333);
      // 旧键必须被剔除，绝不保留在迁移结果字典中
      expect((parsed as any).memory_budget_chars).toBeUndefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('A15: locale 多语言资源与 package.json 规范导出', () => {
    const enPath = path.resolve(process.cwd(), 'locale/en.json');
    const zhPath = path.resolve(process.cwd(), 'locale/zh.json');
    expect(fs.existsSync(enPath)).toBe(true);
    expect(fs.existsSync(zhPath)).toBe(true);

    const en = JSON.parse(fs.readFileSync(enPath, 'utf8'));
    const zh = JSON.parse(fs.readFileSync(zhPath, 'utf8'));

    expect(en.title).toBeTruthy();
    expect(en.description).toBeTruthy();
    expect(zh.title).toBeTruthy();
    expect(zh.description).toBeTruthy();

    const pkg = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf8'));
    expect(pkg.exports?.['./locale/*']).toBe('./locale/*');
    expect(pkg.files?.includes('locale')).toBe(true);
  });
});
