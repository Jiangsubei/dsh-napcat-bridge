/**
 * dsh-napcat-bridge: DSH 真实服务装配运行时 (Boot Helper)
 * 通过 @deepseek-ai/dsh-app-boot 装配真实的 DeepSeek Harness 基础环境，
 * 加载 storage, agents, llm, user-questions, user-approval, permission-presets 等官方服务，
 * 并支持挂载 dsh-napcat-bridge 插件。
 */

import { createRequire } from 'node:module';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import { Context } from '@deepseek-ai/cordis';
import {
  boot,
  loadOverlayPatches,
  healProfilesModuleFallback,
  resolveBundleDir,
} from '@deepseek-ai/dsh-app-boot';
import type { BridgePluginConfig } from './types/index.js';
import * as NapCatBridgePlugin from './index.js';

const require = createRequire(import.meta.url);

export interface BootDshOptions {
  dshHome?: string;
  configPath?: string;
  config?: BridgePluginConfig;
  extraPatches?: any[];
  prepare?: (ctx: Context) => Promise<void> | void;
  mountPlugin?: boolean;
}

export interface BootedDsh {
  ctx: Context;
  dshHome: string;
  dispose: () => Promise<void>;
}

export function resolveDshHome(customHome?: string): string {
  if (customHome) return customHome;
  if (process.env.DSH_HOME) return process.env.DSH_HOME;
  const home = process.env.HOME || process.env.USERPROFILE || '/tmp';
  return path.join(home, '.dsh');
}

/**
 * 装配并启动真实的 DeepSeek Harness 服务栈。
 */
export async function bootDshNapcatBridge(options: BootDshOptions = {}): Promise<BootedDsh> {
  const dshHome = resolveDshHome(options.dshHome);
  process.env.DSH_HOME = dshHome;

  // 1. 定位 DSH 安装锚点
  let installAnchor: string;
  try {
    installAnchor = require.resolve('@deepseek-ai/dsh/package.json');
  } catch {
    installAnchor = path.resolve(process.cwd(), 'node_modules/@deepseek-ai/dsh/package.json');
  }

  await healProfilesModuleFallback({ installAnchor, home: dshHome });

  // 2. 准备 profile 目录与 cordis.yml 根配置
  const profileDir = path.join(dshHome, 'profiles', 'napcat-test');
  await fsp.mkdir(profileDir, { recursive: true });

  const rootConfig = path.join(profileDir, 'cordis.yml');
  if (!fs.existsSync(rootConfig)) {
    await fsp.writeFile(rootConfig, '[]\n', 'utf8');
  }

  const profilePackageJson = path.join(profileDir, 'package.json');
  if (!fs.existsSync(profilePackageJson)) {
    const manifest = {
      name: 'dsh-profile-napcat-test',
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
    };
    await fsp.writeFile(profilePackageJson, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  }

  // 3. 加载 @deepseek-ai/dsh-base 的 bundle patch
  const baseDir = resolveBundleDir('napcat-test', '@deepseek-ai/dsh-base', installAnchor, profileDir);
  const baseManifest = JSON.parse(await fsp.readFile(path.join(baseDir, 'package.json'), 'utf8'));
  const declaredPatch = baseManifest.dsh?.bundle?.patch || 'cordis.patch.yml';
  const basePatchPath = path.join(baseDir, declaredPatch);
  const basePatches = loadOverlayPatches('napcat-test', basePatchPath);

  // 4. 组装 overlay patches
  const storagesDir = path.join(dshHome, 'storages');
  await fsp.mkdir(storagesDir, { recursive: true });

  const configPath = options.configPath || path.join(dshHome, 'settings.yaml');

  const defaultOverlays: any[] = [
    { id: 'hmr', disabled: true },
    {
      id: 'settings',
      config: {
        path: configPath,
        dshHome,
        watch: false,
      },
    },
    {
      id: 'credentials',
      config: {
        dshHome,
        watch: false,
      },
    },
    {
      id: 'session-query-sqlite',
      config: {
        path: ':memory:',
        openAt: 'never',
      },
    },
    {
      id: 'storage-json',
      config: {
        root: storagesDir,
      },
    },
    {
      insert: [
        {
          id: 'workspace',
          name: '@deepseek-ai/dsh-workspace',
        },
      ],
    },
    ...(options.extraPatches || []),
  ];

  // 5. 调用 DSH 官方 boot()
  const ctx = await boot('dsh-napcat-bridge', rootConfig, [...basePatches, ...defaultOverlays], async (hostCtx) => {
    if (options.prepare) {
      await options.prepare(hostCtx);
    }
  });

  // 6. 若要求挂载本插件，则挂载 NapCatBridgePlugin
  if (options.mountPlugin !== false) {
    ctx.plugin(NapCatBridgePlugin, options.config || {});
  }

  const dispose = async () => {
    await (ctx as any).emit?.('dispose');
    await (ctx as any).fiber?.dispose?.();
  };

  return {
    ctx,
    dshHome,
    dispose,
  };
}
