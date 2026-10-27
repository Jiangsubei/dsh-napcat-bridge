/**
 * 自动同步脚本：根据 src/constants/preset.ts 生成根目录 cordis.patch.yml
 * 确保代码运行时预设与静态 Bundle Patch 预设保持 100% 严格一致
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  QQ_PRESET_ID,
  QQ_PRESET_NAME,
  QQ_PRESET_DESCRIPTION,
  QQ_PRESET_ORDER,
  QQ_PRESET_PLUGINS,
} from '../src/constants/preset.js';

export function generateCordisPatch(): string {
  const lines: string[] = [
    '# dsh-napcat-bridge bundle patch: inserts this plugin and the qq-session preset into the profile layer stack.',
    '# Generated automatically by scripts/sync-patch.ts - DO NOT EDIT MANUALLY.',
    '- insert:',
    '    - id: dsh-napcat-bridge',
    '      name: dsh-napcat-bridge',
    '',
    '    - id: preset-qq-session',
    "      name: '@deepseek-ai/dsh-agent-preset'",
    '      config:',
    `        id: ${QQ_PRESET_ID}`,
    `        name: ${QQ_PRESET_NAME}`,
    `        description: ${QQ_PRESET_DESCRIPTION}`,
    `        order: ${QQ_PRESET_ORDER}`,
    '        plugins:',
  ];

  for (let i = 0; i < QQ_PRESET_PLUGINS.length; i++) {
    const item = QQ_PRESET_PLUGINS[i];
    if (item.comment) {
      lines.push(`          # ${i + 1}. ${item.comment}`);
    }
    lines.push(`          - id: ${item.id}`);
    lines.push(`            name: '${item.name}'`);

    if (item.yamlDisabledExpr) {
      lines.push(`            disabled: !!js ${JSON.stringify(item.yamlDisabledExpr)}`);
    } else if (typeof item.disabled === 'boolean') {
      lines.push(`            disabled: ${item.disabled}`);
    }

    if (item.config || item.yamlConfigExpr) {
      lines.push('            config:');
      if (item.config) {
        for (const [k, v] of Object.entries(item.config)) {
          if (item.yamlConfigExpr && item.yamlConfigExpr[k]) {
            continue;
          }
          if (typeof v === 'string') {
            lines.push(`              ${k}: ${JSON.stringify(v)}`);
          } else if (typeof v === 'boolean' || typeof v === 'number') {
            lines.push(`              ${k}: ${v}`);
          } else {
            lines.push(`              ${k}: ${JSON.stringify(v)}`);
          }
        }
      }
      if (item.yamlConfigExpr) {
        for (const [k, expr] of Object.entries(item.yamlConfigExpr)) {
          lines.push(`              ${k}: !!js ${JSON.stringify(expr)}`);
        }
      }
    }
    lines.push('');
  }

  return lines.join('\n').trimEnd() + '\n';
}

function main() {
  const targetPath = path.resolve('cordis.patch.yml');
  const yamlContent = generateCordisPatch();
  fs.writeFileSync(targetPath, yamlContent, 'utf8');
  console.log(`[sync-patch] Successfully generated ${targetPath}`);
}

main();
