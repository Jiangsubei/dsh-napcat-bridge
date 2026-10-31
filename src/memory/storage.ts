/**
 * dsh-napcat-bridge: Memory 存储管理器
 * 管理 .dsh/napcat/napcat_memory/ 下的 Session 记忆与 User Profile 纯 Markdown 文件读写。
 */

import * as fsSync from 'node:fs';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { atomicWriteFile, atomicWriteFileSync } from '../utils/atomic-write.js';
import {
  DEFAULT_MEMORY_DIR,
  DEFAULT_GROUP_MEMORY_TOTAL_BUDGET_CHARS,
  TRUNCATED_USER_PROFILE_NOTICE,
} from '../constants/index.js';
import { resolveDshPath } from '../utils/path.js';
import type { ActiveUserInfo } from './types.js';

export class MemoryStorage {
  private baseDir: string;
  private dshHome?: string;
  private sessionCache: Map<string, string> = new Map();
  private userCache: Map<string, string> = new Map();
  private updateLocks: Map<string, Promise<any>> = new Map();

  constructor(storageDir?: string, dshHome?: string) {
    this.dshHome = dshHome;
    this.baseDir = resolveDshPath(this.dshHome, storageDir, DEFAULT_MEMORY_DIR);
  }

  public setBaseDir(storageDir?: string, dshHome?: string): void {
    if (dshHome) {
      this.dshHome = dshHome;
    }
    this.baseDir = resolveDshPath(this.dshHome, storageDir, DEFAULT_MEMORY_DIR);
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

  /**
   * 线程安全 CAS / 原子更新 Session 记忆 (B10)
   */
  public async updateSessionMemory(
    peer: string,
    updater: (current: string) => Promise<string> | string
  ): Promise<{ success: boolean; content: string; error?: string }> {
    const key = peer || 'default';
    const prevLock = this.updateLocks.get(key) || Promise.resolve();
    let releaseLock!: () => void;
    const newLock = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    this.updateLocks.set(key, newLock);

    try {
      await prevLock;
      const current = await this.readSessionMemory(key);
      const updated = await updater(current);
      await this.writeSessionMemory(key, updated);
      return { success: true, content: updated };
    } catch (err: any) {
      return { success: false, content: '', error: err?.message || String(err) };
    } finally {
      releaseLock();
      if (this.updateLocks.get(key) === newLock) {
        this.updateLocks.delete(key);
      }
    }
  }

  public async readSessionMemoryRaw(peer: string): Promise<string> {
    return this.readSessionMemory(peer);
  }

  public async existsSessionMemory(peer: string): Promise<boolean> {
    const key = peer || 'default';
    const filePath = this.getSessionMemoryPath(key);
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      return content.trim().length > 0;
    } catch {
      return false;
    }
  }

  public async readUserProfileRaw(qq = 'default'): Promise<string> {
    const key = qq && qq.trim() ? qq.trim() : 'default';
    if (this.userCache.has(key)) {
      return this.userCache.get(key)!;
    }
    const filePath = this.getUserProfilePath(key);
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      this.userCache.set(key, content);
      return content;
    } catch {
      return '';
    }
  }

  public async existsUserProfile(qq = 'default'): Promise<boolean> {
    const key = qq && qq.trim() ? qq.trim() : 'default';
    const filePath = this.getUserProfilePath(key);
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      return content.trim().length > 0;
    } catch {
      return false;
    }
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

  /**
   * 线程安全 CAS / 原子更新 User Profile (B10)
   */
  public async updateUserProfile(
    qq: string,
    updater: (current: string) => Promise<string> | string
  ): Promise<{ success: boolean; content: string; error?: string }> {
    const key = qq && qq.trim() ? qq.trim() : 'default';
    const prevLock = this.updateLocks.get(key) || Promise.resolve();
    let releaseLock!: () => void;
    const newLock = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    this.updateLocks.set(key, newLock);

    try {
      await prevLock;
      const current = await this.readUserProfile(key);
      const updated = await updater(current);
      await this.writeUserProfile(key, updated);
      return { success: true, content: updated };
    } catch (err: any) {
      return { success: false, content: '', error: err?.message || String(err) };
    } finally {
      releaseLock();
      if (this.updateLocks.get(key) === newLock) {
        this.updateLocks.delete(key);
      }
    }
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
    atomicWriteFileSync(filePath, content);
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
    atomicWriteFileSync(filePath, content);
    this.userCache.set(key, content);
    if (key === 'default') {
      this.userCache.clear();
    }
  }

  /**
   * 组装 System Prompt 动态记忆上下文快照
   * - Session 规则全量注入，永不切割；
   * - 私聊用户画像全量注入，永不切割；
   * - 群聊用户画像按总预算整块装填：放完当前画像后达到/超过预算时，
   *   后续用户不再注入，并追加截断提示。预算只统计用户画像，不包含 Session 规则。
   */
  public getPromptSnapshotSync(
    peer: string,
    activeUsers: ActiveUserInfo[] = [],
    groupUserProfilesBudget = DEFAULT_GROUP_MEMORY_TOTAL_BUDGET_CHARS,
    currentQQ?: string
  ): string {
    const isPrivate = peer.startsWith('user_') || peer.startsWith('qq-user-');
    const sessionMemory = this.readSessionMemorySync(peer).trim();

    const parts: string[] = [];
    if (sessionMemory) {
      if (sessionMemory.startsWith('#')) {
        parts.push(sessionMemory);
      } else {
        parts.push(`### Session 记忆（${peer}）\n${sessionMemory}`);
      }
    }

    const userBlocks: string[] = [];
    let profileLength = 0;
    let truncated = false;

    if (isPrivate) {
      // 私聊单用户画像全量注入
      const targetQQ =
        activeUsers[0]?.qq || currentQQ || peer.replace(/^(user_|qq-user-)/, '').split('-')[0];
      const targetName = activeUsers[0]?.name || targetQQ;
      const profile = this.readUserProfileSync(targetQQ).trim();
      if (profile) {
        userBlocks.push(
          profile.startsWith('#') ? profile : `### ${targetName} (${targetQQ})\n${profile}`
        );
      }
    } else {
      // 群聊多用户：动态阶梯排序 + 快照稳定性保护
      let candidateUsers = [...activeUsers];
      const normalizedCurrentQQ =
        currentQQ && currentQQ !== 'default' ? currentQQ.trim() : null;

      if (normalizedCurrentQQ) {
        const currentProfile = this.readUserProfileSync(normalizedCurrentQQ).trim();
        if (currentProfile) {
          // 模拟按自然活跃顺序装填，检查 normalizedCurrentQQ 是否能被完整/原子纳入预算
          let naturallyIncluded = false;
          let simLength = 0;

          for (const u of candidateUsers) {
            const p = this.readUserProfileSync(u.qq).trim();
            if (!p) continue;
            const b = p.startsWith('#') ? p : `### ${u.name} (${u.qq})\n${p}`;
            simLength += (simLength > 0 ? 2 : 0) + b.length;

            if (u.qq === normalizedCurrentQQ) {
              naturallyIncluded = true;
              break;
            }

            if (simLength >= groupUserProfilesBudget) {
              break;
            }
          }

          if (!naturallyIncluded) {
            // 自然顺序下会被截断挤出（或不在活跃列表中），动态将当前发言人提拔到最前面
            const currentName =
              candidateUsers.find((u) => u.qq === normalizedCurrentQQ)?.name ||
              normalizedCurrentQQ;
            candidateUsers = [
              { qq: normalizedCurrentQQ, name: currentName },
              ...candidateUsers.filter((u) => u.qq !== normalizedCurrentQQ),
            ];
          }
        }
      }

      // 按确定的顺序装填用户画像（整块原子装填）
      for (let i = 0; i < candidateUsers.length; i++) {
        const user = candidateUsers[i];
        const profile = this.readUserProfileSync(user.qq).trim();
        if (!profile) continue;

        const block = profile.startsWith('#')
          ? profile
          : `### ${user.name} (${user.qq})\n${profile}`;

        // 已达/超过预算时，当前及后续用户均不注入（含"放完当前块后再判断"语义）
        if (profileLength >= groupUserProfilesBudget) {
          truncated = true;
          break;
        }

        userBlocks.push(block);
        profileLength += (profileLength > 0 ? 2 : 0) + block.length;

        if (profileLength >= groupUserProfilesBudget) {
          // 达到或突破预算，检查后续候选用户中是否还有未装入的有画像用户
          for (let j = i + 1; j < candidateUsers.length; j++) {
            if (this.readUserProfileSync(candidateUsers[j].qq).trim()) {
              truncated = true;
              break;
            }
          }
          break;
        }
      }
    }

    if (userBlocks.length > 0) {
      parts.push(userBlocks.join('\n\n'));
    }

    if (truncated) {
      parts.push(TRUNCATED_USER_PROFILE_NOTICE);
    }

    return parts.join('\n\n').trim();
  }
}

