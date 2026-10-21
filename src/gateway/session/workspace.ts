/**
 * dsh-napcat-bridge: 工作区与 CWD 解析模块
 * 负责解析 DSH 宿主环境根路径、为对端分配独立隔离的工作区目录，并注册至 DSH 工作区服务。
 */

import * as path from 'node:path';
import * as os from 'node:os';
import { promises as fsp } from 'node:fs';
import type { Context } from '@deepseek-ai/cordis';
import { DEFAULT_WORKSPACE_ROOT } from '../../constants/index.js';
import { resolveDshPath } from '../../utils/path.js';

export class SessionWorkspaceManager {
  private readonly dshHome: string;

  constructor(
    private readonly ctx?: Context,
    dshHome?: string
  ) {
    this.dshHome = path.resolve(dshHome || process.env.DSH_HOME || path.join(os.homedir(), '.dsh'));
  }

  public getDshHome(): string {
    return this.dshHome;
  }

  public resolveCwd(_peerOrSessionId?: string): string {
    return resolveDshPath(this.dshHome, undefined, DEFAULT_WORKSPACE_ROOT);
  }

  public async registerWorkspace(
    cwd: string,
    sessionId?: string,
    title = 'NapCat'
  ): Promise<void> {
    const wsRegistry = this.ctx?.get?.('workspaceRegistry') || (this.ctx as any)?.workspaceRegistry;
    if (!wsRegistry || typeof wsRegistry.create !== 'function') return;
    try {
      const resolvedCwd = resolveDshPath(this.dshHome, cwd, DEFAULT_WORKSPACE_ROOT);
      await fsp.mkdir(resolvedCwd, { recursive: true });
      const ws = await wsRegistry.create(resolvedCwd, title);
      if (ws && sessionId && typeof ws.attachSession === 'function') {
        await ws.attachSession(sessionId).catch(() => {});
      }
    } catch (err) {
      this.ctx?.logger?.('dsh-napcat-bridge')?.warn?.(`[SessionWorkspaceManager] 注册工作区 ${cwd} 失败:`, err);
    }
  }
}
