/**
 * tests/contract/memory-storage.test.ts
 *
 * 契约测试: EN-003 MemoryStorage 存储层与两层记忆体系
 *
 * 覆盖场景:
 * 1. 目录结构 (.dsh/napcat/napcat_memory/session/ 与 user/) 及原子写入
 * 2. Session 记忆 (per-peer) 读写与追加
 * 3. User Profile (per-QQ) 读写与追加及 default.md 兜底
 * 4. 私聊场景 Snapshot 组装 (全量加载，不受 7 天过滤)
 * 5. 群聊场景 Snapshot 组装与 2200 字符【用户画像原子完整性截断保护】
 * 6. 7 天活跃机制 (不活跃不注入，文件永不删除)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fsp } from 'node:fs';
import { MemoryStorage } from '../../src/memory/storage.js';

describe('契约测试: EN-003 MemoryStorage 存储层与两层记忆体系', () => {
  let tmpDir: string;
  let storage: MemoryStorage;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-napcat-memory-test-'));
    storage = new MemoryStorage(tmpDir);
  });

  afterEach(async () => {
    if (tmpDir) {
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('契约 1: 目录结构初始化与原子写入 (atomicWriteFile)', async () => {
    await storage.writeSessionMemory('group_3000000001', '# 群聊规则\n- 主要讨论 TypeScript');
    await storage.writeUserProfile('2000000001', '# 用户画像\n- 喜欢详细解释');

    const sessionFile = path.join(tmpDir, 'session', 'group_3000000001.md');
    const userFile = path.join(tmpDir, 'user', '2000000001.md');

    expect(await fsp.readFile(sessionFile, 'utf-8')).toContain('主要讨论 TypeScript');
    expect(await fsp.readFile(userFile, 'utf-8')).toContain('喜欢详细解释');
  });

  it('契约 2: Session 记忆读写、追加与缓存', async () => {
    // 1. 读取不存在的 session 记忆返回空字符串
    expect(await storage.readSessionMemory('group_100')).toBe('');

    // 2. 写入与读取
    await storage.writeSessionMemory('group_100', '群主是BotNickname');
    expect(await storage.readSessionMemory('group_100')).toBe('群主是BotNickname');

    // 3. 追加条目
    await storage.appendSessionMemory('group_100', '禁止发广告');
    const updated = await storage.readSessionMemory('group_100');
    expect(updated).toContain('群主是BotNickname');
    expect(updated).toContain('禁止发广告');
    expect(updated).toMatch(/-\s*\[\d{4}-\d{2}-\d{2}.+?\]\s*禁止发广告/);
  });

  it('契约 3: User Profile 读写、追加与 default.md 兜底', async () => {
    // 1. 无专属画像且无 default.md 时返回空字符串
    expect(await storage.readUserProfile('112233')).toBe('');

    // 2. 写入 default.md
    await storage.writeUserProfile('default', '通用画像：新用户，待探索偏好');
    // 读取未建立画像的用户自动回退到 default.md
    expect(await storage.readUserProfile('112233')).toBe('通用画像：新用户，待探索偏好');

    // 3. 写入专属画像后优先返回专属画像
    await storage.writeUserProfile('112233', '资深 Rust 工程师');
    expect(await storage.readUserProfile('112233')).toBe('资深 Rust 工程师');

    // 4. 追加条目
    await storage.appendUserProfile('112233', '偏好简洁代码示例');
    const profile = await storage.readUserProfile('112233');
    expect(profile).toContain('资深 Rust 工程师');
    expect(profile).toContain('偏好简洁代码示例');
  });

  it('契约 4: 私聊场景 Snapshot 组装 (全量加载，不受 7 天过滤限制)', () => {
    storage.writeSessionMemorySync('user_2000000001', '私聊约定：每周五汇报周报');
    storage.writeUserProfileSync('2000000001', '昵称BotNickname，项目负责人');

    // 私聊 peer 为 user_2000000001，activeUsers 传当前私聊用户
    const snapshot = storage.getPromptSnapshotSync('user_2000000001', [
      { qq: '2000000001', name: 'BotNickname' },
    ]);

    expect(snapshot).toContain('### Session 记忆（user_2000000001）');
    expect(snapshot).toContain('私聊约定：每周五汇报周报');
    expect(snapshot).toContain('### 用户偏好与画像');
    expect(snapshot).toContain('BotNickname (2000000001): 昵称BotNickname，项目负责人');
  });

  it('契约 5: 群聊场景 Snapshot 组装与 2200 字符【用户画像原子完整性截断保护】', () => {
    storage.writeSessionMemorySync('group_3000000001', '群聊规则：技术探讨群');

    // 制造 3 位用户画像
    // 用户 1: 800 字符画像
    const user1Content = 'A'.repeat(800);
    storage.writeUserProfileSync('111', user1Content);

    // 用户 2: 1600 字符画像 (用户 1 + 用户 2 达到 2400 字符，突破 2200 预算)
    const user2Content = 'B'.repeat(1600);
    storage.writeUserProfileSync('222', user2Content);

    // 用户 3: 500 字符画像
    const user3Content = 'C'.repeat(500);
    storage.writeUserProfileSync('333', user3Content);

    const snapshot = storage.getPromptSnapshotSync(
      'group_3000000001',
      [
        { qq: '111', name: 'User1' },
        { qq: '222', name: 'User2' },
        { qq: '333', name: 'User3' },
      ],
      2200
    );

    // 断言 1: 用户 1 完整存在
    expect(snapshot).toContain(user1Content);

    // 断言 2: 用户 2 正好让总长度达到/突破 2200 预算，必须完整包含用户 2 的全部 1600 字符，绝不断裂
    expect(snapshot).toContain(user2Content);

    // 断言 3: 用户 3 必须被截断舍弃，不包含在最终 prompt 中
    expect(snapshot).not.toContain(user3Content);
    expect(snapshot).not.toContain('User3 (333)');
  });

  it('契约 6: 7 天活跃机制 - 未在活跃列表的用户不注入，但文件永久保留', async () => {
    storage.writeUserProfileSync('444', '历史用户画像：离线超过7天');
    storage.writeUserProfileSync('555', '近期活跃用户画像');

    // 活跃列表仅传入 555
    const snapshot = storage.getPromptSnapshotSync('group_3000000001', [
      { qq: '555', name: 'ActiveUser' },
    ]);

    // 555 被注入，444 不注入
    expect(snapshot).toContain('ActiveUser (555): 近期活跃用户画像');
    expect(snapshot).not.toContain('444');

    // 444 的文件依然完整存在
    expect(await storage.readUserProfile('444')).toBe('历史用户画像：离线超过7天');
  });
});
