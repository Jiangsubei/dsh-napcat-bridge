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

    // 3. existsSessionMemory 与 readSessionMemoryRaw
    expect(await storage.existsSessionMemory('group_100')).toBe(true);
    expect(await storage.existsSessionMemory('group_non_existent')).toBe(false);
    expect(await storage.readSessionMemoryRaw('group_100')).toBe('群主是BotNickname');
  });

  it('契约 3: User Profile 读写与 default.md 兜底，及 raw 读取与存在判断', async () => {
    // 1. 无专属画像且无 default.md 时返回空字符串
    expect(await storage.readUserProfile('112233')).toBe('');

    // 2. 写入 default.md
    await storage.writeUserProfile('default', '通用画像：新用户，待探索偏好');
    // 读取未建立画像的用户自动回退到 default.md
    expect(await storage.readUserProfile('112233')).toBe('通用画像：新用户，待探索偏好');

    // 3. 写入专属画像后优先返回专属画像
    await storage.writeUserProfile('112233', '资深 Rust 工程师');
    expect(await storage.readUserProfile('112233')).toBe('资深 Rust 工程师');

    // 4. existsUserProfile 与 readUserProfileRaw（无 default.md 兜底）
    expect(await storage.existsUserProfile('112233')).toBe(true);
    expect(await storage.existsUserProfile('998877')).toBe(false);
    expect(await storage.readUserProfileRaw('112233')).toBe('资深 Rust 工程师');
    // readUserProfileRaw 对未建立画像的用户返回空串，不回退到 default.md
    expect(await storage.readUserProfileRaw('998877')).toBe('');
    // 普通 readUserProfile 仍会兜底到 default.md
    expect(await storage.readUserProfile('998877')).toBe('通用画像：新用户，待探索偏好');
  });

  it('契约 4: 私聊场景 Snapshot 组装 (全量加载，不受 7 天过滤限制，无外层冗余标题)', () => {
    storage.writeSessionMemorySync('user_2000000001', '# Session 记忆（user_2000000001）\n\n私聊约定：每周五汇报周报');
    storage.writeUserProfileSync('2000000001', '昵称BotNickname，项目负责人');

    // 私聊 peer 为 user_2000000001，activeUsers 传当前私聊用户
    const snapshot = storage.getPromptSnapshotSync('user_2000000001', [
      { qq: '2000000001', name: 'BotNickname' },
    ]);

    expect(snapshot).not.toContain('### Session 记忆');
    expect(snapshot).toContain('# Session 记忆（user_2000000001）');
    expect(snapshot).toContain('私聊约定：每周五汇报周报');
    expect(snapshot).not.toContain('### 用户偏好与画像');
    expect(snapshot).toContain('### BotNickname (2000000001)\n昵称BotNickname，项目负责人');
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
    expect(snapshot).toContain('### ActiveUser (555)\n近期活跃用户画像');
    expect(snapshot).not.toContain('444');

    // 444 的文件依然完整存在
    expect(await storage.readUserProfile('444')).toBe('历史用户画像：离线超过7天');
  });

  it('契约 7: 注入标题去重 — profile 自带 # 标题时原样注入，无 # 标题时补 ### 标识 (A1-A4)', () => {
    storage.writeSessionMemorySync(
      'group_646988881',
      '# Session 记忆（group_646988881）\n\n### 群友互动\n- 张三喜欢 Rust'
    );
    storage.writeUserProfileSync('10001', '# 用户画像（10001）\n\n### 偏好\n喜欢函数式编程');
    storage.writeUserProfileSync('10002', '无标题旧格式画像');

    const snapshot = storage.getPromptSnapshotSync('group_646988881', [
      { qq: '10001', name: '张三' },
      { qq: '10002', name: '李四' },
    ]);

    // A1: 无 ### Session 记忆 外层包装，保留文件自带的 # 标题与 ### 子标题
    expect(snapshot).not.toContain('### Session 记忆');
    expect(snapshot).toContain('# Session 记忆（group_646988881）');
    expect(snapshot).toContain('### 群友互动\n- 张三喜欢 Rust');

    // A2: 无 ### 用户偏好与画像 外层包装
    expect(snapshot).not.toContain('### 用户偏好与画像');

    // A4: profile 自带 # 标题时原样注入
    expect(snapshot).toContain('# 用户画像（10001）\n\n### 偏好\n喜欢函数式编程');
    expect(snapshot).not.toContain('### 张三 (10001)');

    // A3: profile 无 # 标题时补充 ### Name (QQ) 标识
    expect(snapshot).toContain('### 李四 (10002)\n无标题旧格式画像');
  });

  it('契约 8: 私聊与群聊解耦预算 — 私聊支持独立 privateBudget 截断保护，群聊支持独立 groupBudget', () => {
    // 1. 私聊独立预算截断保护 (如设定预算为 300 字符，画像有 800 字符)
    const longPrivateProfile = '# 用户画像（9999）\n' + 'D'.repeat(800);
    storage.writeUserProfileSync('9999', longPrivateProfile);

    const snapshotPrivate = storage.getPromptSnapshotSync(
      'user_9999',
      [{ qq: '9999', name: 'UserPrivate' }],
      300 // 传入私聊预算 300
    );
    expect(snapshotPrivate.length).toBeLessThanOrEqual(300);
    expect(snapshotPrivate).toContain('...(超预算截断)');

    // 2. 群聊独立预算截断 (设定群聊预算为 500 字符)
    storage.writeSessionMemorySync('group_custom_budget', '群规');
    storage.writeUserProfileSync('u1', 'A'.repeat(300));
    storage.writeUserProfileSync('u2', 'B'.repeat(300));

    const snapshotGroup = storage.getPromptSnapshotSync(
      'group_custom_budget',
      [
        { qq: 'u1', name: 'User1' },
        { qq: 'u2', name: 'User2' },
      ],
      250 // 群聊预算设为 250，u1(300)+群规(2)放完后，u2 必须被舍弃
    );
    expect(snapshotGroup).toContain('User1');
    expect(snapshotGroup).not.toContain('User2');
  });

  it('契约 9: 截断显式通用提示 — 当用户画像超出预算截断时注入通用提示，未截断时绝不注入', () => {
    storage.writeSessionMemorySync('group_trunc_test', '群规');
    storage.writeUserProfileSync('u1', 'A'.repeat(1000));
    storage.writeUserProfileSync('u2', 'B'.repeat(1400));
    storage.writeUserProfileSync('u3', 'C'.repeat(500));

    // 1. 发生截断：u1(1000) + u2(1400) 突破 2200 预算，u3 被截断
    const truncatedSnapshot = storage.getPromptSnapshotSync(
      'group_trunc_test',
      [
        { qq: 'u1', name: 'User1' },
        { qq: 'u2', name: 'User2' },
        { qq: 'u3', name: 'User3' },
      ],
      2200
    );
    expect(truncatedSnapshot).toContain('User1');
    expect(truncatedSnapshot).toContain('User2');
    expect(truncatedSnapshot).not.toContain('User3');
    expect(truncatedSnapshot).toContain(
      "[提示：受字符预算限制，用户画像未完全展示。如需了解特定用户的完整画像，可按需调用 read_memory(type='user', qq='<QQ号>') 获取。]"
    );

    // 2. 未发生截断：短画像完全容纳在预算内
    storage.writeUserProfileSync('u_short', '短画像偏好');
    const normalSnapshot = storage.getPromptSnapshotSync(
      'group_trunc_test',
      [{ qq: 'u_short', name: 'ShortUser' }],
      2200
    );
    expect(normalSnapshot).toContain('ShortUser');
    expect(normalSnapshot).not.toContain('受字符预算限制');
  });

  it('契约 10: 动态阶梯排序 — 自然顺序下会被截断的发言用户提拔至首位，若本在预算内则保持顺序保护缓存', () => {
    storage.writeSessionMemorySync('group_tiered_test', '群规');
    // u1: 800 字符, u2: 1500 字符 (两者合计 2300 > 2200), u3: 400 字符
    storage.writeUserProfileSync('u1', 'A'.repeat(800));
    storage.writeUserProfileSync('u2', 'B'.repeat(1500));
    storage.writeUserProfileSync('u3', 'C'.repeat(400));

    const activeUsers = [
      { qq: 'u1', name: 'User1' },
      { qq: 'u2', name: 'User2' },
      { qq: 'u3', name: 'User3' },
    ];

    // 场景 A: 当前发言用户为 u3。
    // 在自然顺序下 u1(800) + u2(1500) 突破预算，u3 会被截断挤出。
    // 动态阶梯排序应将 u3 提拔至首位，确保当前说话用户的画像注入成功！
    const snapshotU3 = storage.getPromptSnapshotSync(
      'group_tiered_test',
      activeUsers,
      2200,
      'u3' // 当前发言人 u3
    );
    expect(snapshotU3).toContain('User3 (u3)');
    // 验证 u3 排在最前面（出现在 User1 之前）
    const idxU3 = snapshotU3.indexOf('User3 (u3)');
    const idxU1 = snapshotU3.indexOf('User1 (u1)');
    expect(idxU3).toBeGreaterThan(-1);
    expect(idxU1).toBeGreaterThan(-1);
    expect(idxU3).toBeLessThan(idxU1);

    // 场景 B: 当前发言用户为 u1。
    // 在自然顺序下 u1 本就在第 1 位、完全在预算内。
    // 动态排序应严格保持自然活跃顺序不变（u1 在前，u2 在后），保护 Prefix Cache。
    const snapshotU1 = storage.getPromptSnapshotSync(
      'group_tiered_test',
      activeUsers,
      2200,
      'u1' // 当前发言人 u1
    );
    const idxU1_normal = snapshotU1.indexOf('User1 (u1)');
    const idxU2_normal = snapshotU1.indexOf('User2 (u2)');
    expect(idxU1_normal).toBeGreaterThan(-1);
    expect(idxU2_normal).toBeGreaterThan(-1);
    expect(idxU1_normal).toBeLessThan(idxU2_normal);
  });
});
