/**
 * dsh-napcat-bridge Client WebUI Bundle Builder
 * Compiles src/client/index.tsx into DSH lazy-CJS bundle format:
 * window.__ModuleLoader__.load({ id: "dsh-napcat-bridge/client", factory: (require) => { ... } })
 */

import * as esbuild from 'esbuild';
import * as fs from 'node:fs';
import * as path from 'node:path';

const OUT_DIR = path.resolve('dist');
const OUT_FILE = path.join(OUT_DIR, 'client.js');

async function buildClientBundle() {
  if (!fs.existsSync(OUT_DIR)) {
    fs.mkdirSync(OUT_DIR, { recursive: true });
  }

  const buildResult = await esbuild.build({
    entryPoints: ['src/client/index.tsx'],
    bundle: true,
    format: 'cjs',
    target: 'es2022',
    jsx: 'automatic',
    write: false,
    external: [
      'react',
      'react/jsx-runtime',
      'react-dom',
      '@deepseek-ai/cordis',
      '@deepseek-ai/dsh-client-ui-slots',
      '@deepseek-ai/dsh-client-runtime/client',
      '@deepseek-ai/dsh-client-ui-primitives',
    ],
  });

  if (!buildResult.outputFiles || buildResult.outputFiles.length === 0) {
    throw new Error('esbuild produced no output files');
  }

  const rawCjs = buildResult.outputFiles[0].text;

  // Wrap in DSH lazy-CJS module loader format
  const wrappedBundle = [
    'window.__ModuleLoader__.load({',
    '  id: "dsh-napcat-bridge/client",',
    '  factory: (require) => {',
    '    var module = { exports: {} };',
    '    var exports = module.exports;',
    rawCjs,
    '    return module.exports;',
    '  }',
    '});\n',
  ].join('\n');

  fs.writeFileSync(OUT_FILE, wrappedBundle, 'utf-8');
  console.log(`[build-client] Successfully built ${OUT_FILE} (${wrappedBundle.length} bytes)`);
}

buildClientBundle().catch((err) => {
  console.error('[build-client] Build failed:', err);
  process.exit(1);
});
