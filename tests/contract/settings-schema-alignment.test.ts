import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { BridgeConfigSchema } from '../../src/config/schema.js';
import { DEFAULT_BASE_CONFIG } from '../../src/server/routes.js';
import { migrateLegacyConfig, readLegacyConfig } from '../../src/config/migrate.js';

describe('阶段 2 契约测试：设置系统收尾与三方键一致性 (Settings Alignment Contract)', () => {
  it('A8: Schema、服务端默认值、客户端默认值三方键严格一致，且旧记忆预算键彻底移除', () => {
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

    // 断言 1: 三方键数量均为 30
    expect(schemaKeys.length).toBe(30);
    expect(serverKeys.length).toBe(30);
    expect(clientKeys.length).toBe(30);

    // 断言 2: 三方键集合完全恒等
    expect(schemaKeys).toEqual(serverKeys);
    expect(clientKeys).toEqual(serverKeys);

    // 断言 3: 废弃字段不存在于任何一方
    const deadKeys = [
      'memory_budget_chars',
      'group_memory_budget_chars',
      'private_memory_budget_chars',
      'review_enabled',
      'review_turns_interval',
      'review_tool_calls_interval',
      'review_model',
      'face_auto_curate',
      'face_curate_cron',
      'face_curate_interval_mins',
      'at_questioner',
      'quote_original',
    ];
    for (const deadKey of deadKeys) {
      expect(schemaKeys.includes(deadKey)).toBe(false);
      expect(serverKeys.includes(deadKey)).toBe(false);
      expect(clientKeys.includes(deadKey)).toBe(false);
    }
  });

  it('A7: 运行时配置字段均标记为 .volatile()（包含 bot_qq），以支持 DSH 0.2.1 设置面板保存与热更新', () => {
    const schemaShape = (BridgeConfigSchema as any).dict || (BridgeConfigSchema as any).shape || {};
    const schemaKeys = Object.keys(schemaShape);

    // 验证全量 30 项配置字段均必须带有 .volatile() 标记（包含 bot_qq）
    expect(schemaKeys.length).toBe(30);
    expect(schemaShape.bot_qq?.meta?.volatile).toBe(true);

    for (const field of schemaKeys) {
      expect(
        schemaShape[field]?.meta?.volatile,
        `field ${field} should be marked .volatile()`
      ).toBe(true);
    }
  });

  it('A8: migrateLegacyConfig 旧配置单向迁移：旧记忆预算键映射至新键且不保留旧键', () => {
    // 构造旧版 yaml 内容
    const legacyYaml = `
dsh-napcat-bridge:
  bot_qq: "987654321"
  ws_port: 8099
  memory_budget_chars: 3333
  private_memory_budget_chars: 5555
`;
    const tmpDir = path.resolve(process.cwd(), 'tmp/test-migrate-legacy');
    fs.mkdirSync(tmpDir, { recursive: true });
    const legacyPath = path.join(tmpDir, 'settings.yaml');
    fs.writeFileSync(legacyPath, legacyYaml, 'utf8');

    try {
      const parsed = readLegacyConfig(tmpDir);
      expect(parsed).toBeTruthy();
      // memory_budget_chars 链式迁移到群聊画像总预算
      expect(parsed!.group_memory_total_budget_chars).toBe(3333);
      // 私聊旧预算映射到单个用户画像预算
      expect(parsed!.user_profile_budget_chars).toBe(5555);
      // 旧键必须被剔除，绝不保留在迁移结果字典中
      expect((parsed as any).memory_budget_chars).toBeUndefined();
      expect((parsed as any).private_memory_budget_chars).toBeUndefined();
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
