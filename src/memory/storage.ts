/**
 * dsh-napcat-bridge: Memory 存储管理器
 * 管理 .dsh/napcat/napcat_memory/ 下的 Session 记忆与 User Profile 纯 Markdown 文件读写。
 */

import * as fsSync from 'node:fs';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { atomicWriteFile } from '../utils/atomic-write.js';
import { DEFAULT_MEMORY_DIR, DEFAULT_MEMORY_BUDGET_CHARS } from '../constants/index.js';
import type { ActiveUserInfo } from './types.js';

export class MemoryStorage {
  private baseDir: string;
  private sessionCache: Map<string, string> = new Map();
  private userCache: Map<string, string> = new Map();

  constructor(storageDir?: string) {
    this.baseDir = storageDir ? path.resolve(storageDir) : path.resolve(DEFAULT_MEMORY_DIR);
  }

  public setBaseDir(storageDir?: string): void {
    this.baseDir = storageDir ? path.resolve(storageDir) : path.resolve(DEFAULT_MEMORY_DIR);
    this.invalidateCache();
  }

  public getBaseDir(): string {
    return this.baseDir;
  }

  public invalidateCache(key?: string): void {
    if (key) {
      this.sessionCache.delete(key);
      this.userCache.delete(key);
    } else {
      this.sessionCache.clear();
      this.userCache.clear();
    }
  }

  private sanitizeName(name: string): string {
    return name.replace(/[^a-zA-Z0-9_-]/g, '_');
  }

  public getSessionMemoryPath(peer: string): string {
    const sanitized = this.sanitizeName(peer);
    return path.join(this.baseDir, 'session', `${sanitized}.md`);
  }

  public getUserProfilePath(qq = 'default'): string {
    const target = qq && qq.trim() ? qq.trim() : 'default';
    const sanitized = this.sanitizeName(target);
    return path.join(this.baseDir, 'user', `${sanitized}.md`);
  }

  // ==================== 异步读写方法 ====================

  public async readSessionMemory(peer: string): Promise<string> {
    const key = peer || 'default';
    if (this.sessionCache.has(key)) {
      return this.sessionCache.get(key)!;
    }
    const filePath = this.getSessionMemoryPath(key);
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      this.sessionCache.set(key, content);
      return content;
    } catch {
      this.sessionCache.set(key, '');
      return '';
    }
  }

  public async writeSessionMemory(peer: string, content: string): Promise<void> {
    const key = peer || 'default';
    const filePath = this.getSessionMemoryPath(key);
    await atomicWriteFile(filePath, content);
    this.sessionCache.set(key, content);
  }

  public async appendSessionMemory(peer: string, entry: string): Promise<void> {
    const current = await this.readSessionMemory(peer);
    const dateStr = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const appended = current.trim()
      ? `${current.trimEnd()}\n- [${dateStr}] ${entry.trim()}`
      : `# Session 记忆（${peer}）\n\n- [${dateStr}] ${entry.trim()}`;
    await this.writeSessionMemory(peer, appended);
  }

  public async readUserProfile(qq = 'default'): Promise<string> {
    const key = qq && qq.trim() ? qq.trim() : 'default';
    if (this.userCache.has(key)) {
      return this.userCache.get(key)!;
    }
    const filePath = this.getUserProfilePath(key);
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      if (content.trim().length > 0) {
        this.userCache.set(key, content);
        return content;
      }
    } catch {}

    // 若专属画像不存在且非 default，回退至 default.md
    if (key !== 'default') {
      try {
        const defaultContent = await fs.readFile(this.getUserProfilePath('default'), 'utf-8');
        return defaultContent;
      } catch {
        return '';
      }
    }

    return '';
  }

  public async writeUserProfile(qq: string, content: string): Promise<void> {
    const key = qq && qq.trim() ? qq.trim() : 'default';
    const filePath = this.getUserProfilePath(key);
    await atomicWriteFile(filePath, content);
    this.userCache.set(key, content);
    if (key === 'default') {
      this.userCache.clear();
    }
  }

  public async appendUserProfile(qq: string, entry: string): Promise<void> {
    const key = qq && qq.trim() ? qq.trim() : 'default';
    const current = await this.readUserProfile(key);
    const dateStr = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const appended = current.trim()
      ? `${current.trimEnd()}\n- [${dateStr}] ${entry.trim()}`
      : `# 用户画像（${key}）\n\n- [${dateStr}] ${entry.trim()}`;
    await this.writeUserProfile(key, appended);
  }

  // ==================== 同步读写方法 (供 System Prompt 同步组装) ====================

  public readSessionMemorySync(peer: string): string {
    const key = peer || 'default';
    if (this.sessionCache.has(key)) {
      return this.sessionCache.get(key)!;
    }
    const filePath = this.getSessionMemoryPath(key);
    try {
      const content = fsSync.readFileSync(filePath, 'utf-8');
      this.sessionCache.set(key, content);
      return content;
    } catch {
      return '';
    }
  }

  public writeSessionMemorySync(peer: string, content: string): void {
    const key = peer || 'default';
    const filePath = this.getSessionMemoryPath(key);
    const dir = path.dirname(filePath);
    if (!fsSync.existsSync(dir)) {
      fsSync.mkdirSync(dir, { recursive: true });
    }
    fsSync.writeFileSync(filePath, content, 'utf-8');
    this.sessionCache.set(key, content);
  }

  public readUserProfileSync(qq = 'default'): string {
    const key = qq && qq.trim() ? qq.trim() : 'default';
    if (this.userCache.has(key)) {
      return this.userCache.get(key)!;
    }
    const filePath = this.getUserProfilePath(key);
    try {
      const content = fsSync.readFileSync(filePath, 'utf-8');
      if (content.trim().length > 0) {
        this.userCache.set(key, content);
        return content;
      }
    } catch {}

    if (key !== 'default') {
      try {
        const defaultContent = fsSync.readFileSync(this.getUserProfilePath('default'), 'utf-8');
        return defaultContent;
      } catch {
        return '';
      }
    }

    return '';
  }

  public writeUserProfileSync(qq: string, content: string): void {
    const key = qq && qq.trim() ? qq.trim() : 'default';
    const filePath = this.getUserProfilePath(key);
    const dir = path.dirname(filePath);
    if (!fsSync.existsSync(dir)) {
      fsSync.mkdirSync(dir, { recursive: true });
    }
    fsSync.writeFileSync(filePath, content, 'utf-8');
    this.userCache.set(key, content);
    if (key === 'default') {
      this.userCache.clear();
    }
  }

  /**
   * 组装 System Prompt 动态记忆上下文快照
   * 包含用户画像原子完整性截断保护机制 (放完整当前用户，丢弃后续用户)
   */
  public getPromptSnapshotSync(
    peer: string,
    activeUsers: ActiveUserInfo[] = [],
    maxBudget = DEFAULT_MEMORY_BUDGET_CHARS
  ): string {
    const isPrivate = peer.startsWith('user_') || peer.startsWith('qq-user-');
    const sessionMemory = this.readSessionMemorySync(peer).trim();

    const parts: string[] = [];
    if (sessionMemory) {
      parts.push(sessionMemory);
    }

    const userBlocks: string[] = [];
    let currentLength = sessionMemory.length;

    if (isPrivate) {
      // 私聊单用户画像全量注入（不受 7 天过滤）
      const targetQQ = activeUsers[0]?.qq || peer.replace(/^(user_|qq-user-)/, '').split('-')[0];
      const targetName = activeUsers[0]?.name || targetQQ;
      const profile = this.readUserProfileSync(targetQQ).trim();
      if (profile) {
        if (profile.startsWith('#')) {
          userBlocks.push(profile);
        } else {
          userBlocks.push(`### ${targetName} (${targetQQ})\n${profile}`);
        }
      }
    } else {
      // 群聊多用户：遍历活跃用户画像，并在达到或突破 2200 上限时放完整当前用户、丢弃后续用户
      for (const user of activeUsers) {
        const profile = this.readUserProfileSync(user.qq).trim();
        if (!profile) continue;

        const block = profile.startsWith('#')
          ? profile
          : `### ${user.name} (${user.qq})\n${profile}`;
        userBlocks.push(block);
        currentLength += block.length + 1;

        if (currentLength >= maxBudget) {
          // 当前用户已完整放入 userBlocks，立即终止后续用户追加
          break;
        }
      }
    }

    if (userBlocks.length > 0) {
      parts.push(userBlocks.join('\n\n'));
    }

    return parts.join('\n\n').trim();
  }
}

