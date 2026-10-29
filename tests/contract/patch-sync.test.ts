import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import {
  QQ_PRESET_ID,
  QQ_PRESET_PERSONA_PREFIX,
  QQ_PRESET_PLUGINS,
} from '../../src/constants/preset.js';

describe('cordis.patch.yml 与预设单一真相源同步契约测试', () => {
  const patchPath = path.resolve('cordis.patch.yml');

  it('根目录 cordis.patch.yml 文件必须存在', () => {
    expect(fs.existsSync(patchPath)).toBe(true);
  });

  it('cordis.patch.yml 中的 preset-qq-session 必须包含所有必要插件与最新提示词', () => {
    const rawContent = fs.readFileSync(patchPath, 'utf8');

    // 1. 文本层面核验 !!js 关键字段与提示词
    expect(rawContent).toContain('tool-ask-user');
    expect(rawContent).toContain('@deepseek-ai/dsh-tool-ask-user');
    // YAML 以 JSON 字符串形式写入 prefix，多段文本中的换行会被转义为 \n
    expect(rawContent).toContain(JSON.stringify(QQ_PRESET_PERSONA_PREFIX));

    // 2. 结构解析核验
    // 注意：Cordis 的 !!js 自定义 tag 在普通 yaml 解析时需要自定义 Type 避免抛错
    const JS_TYPE = new yaml.Type('!js', {
      kind: 'scalar',
      construct: (data) => data,
    });
    const JS_EXPR_TYPE = new yaml.Type('tag:yaml.org,2002:js', {
      kind: 'scalar',
      construct: (data) => data,
    });
    const SCHEMA = yaml.DEFAULT_SCHEMA.extend([JS_TYPE, JS_EXPR_TYPE]);

    const parsed: any = yaml.load(rawContent, { schema: SCHEMA });
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeGreaterThan(0);

    const insertBlock = parsed.find((item: any) => Array.isArray(item.insert));
    expect(insertBlock).toBeDefined();

    const qqPresetEntry = insertBlock.insert.find(
      (entry: any) => entry.id === 'preset-qq-session'
    );
    expect(qqPresetEntry).toBeDefined();
    expect(qqPresetEntry.config?.id).toBe(QQ_PRESET_ID);

    const plugins: any[] = qqPresetEntry.config?.plugins;
    expect(Array.isArray(plugins)).toBe(true);

    // 验证插件清单 ID 顺序与 SSOT 严格一致
    const expectedIds = QQ_PRESET_PLUGINS.map((p) => p.id);
    const actualIds = plugins.map((p: any) => p.id);
    expect(actualIds).toEqual(expectedIds);

    // 验证 persona prefix 严格一致
    const personaPlugin = plugins.find((p: any) => p.id === 'persona');
    expect(personaPlugin?.config?.prefix).toBe(QQ_PRESET_PERSONA_PREFIX);
    expect(personaPlugin?.config?.complete).toBe(true);
  });
});
