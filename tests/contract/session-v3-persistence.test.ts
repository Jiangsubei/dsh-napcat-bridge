import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import { Context } from '@deepseek-ai/cordis';
import { bootDshNapcatBridge, type BootedDsh } from '../../src/boot.js';
import {
  SessionManager,
  encodeSegment,
} from '../../src/gateway/session.js';
import { MessageDatabase } from '../../src/storage/database.js';

describe('契约测试: DSH 0.1.5 V3 路径编码寻址与存量 V2/旧版会话探测 (Session V3 Persistence Contract)', () => {
  let tmpHome: string;
  let booted: BootedDsh | null = null;
  let db: MessageDatabase | null = null;

  beforeEach(async () => {
    tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-v3-persistence-'));
  });

  afterEach(async () => {
    if (db) {
      db.close();
      db = null;
    }
    if (booted) {
      await booted.dispose().catch(() => {});
      booted = null;
    }
    if (tmpHome) {
      await fsp.rm(tmpHome, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('契约 1: encodeSegment 转义算法完全对齐 DSH 0.1.5 规范', () => {
    // 1. 空段抛错
    expect(() => encodeSegment('')).toThrow('cannot encode an empty path segment');

    // 2. 单双点特殊转义防 traversal
    expect(encodeSegment('.')).toBe('~002E');
    expect(encodeSegment('..')).toBe('~002E~002E');

    // 3. 安全字符原样保留
    expect(encodeSegment('qq-user-123456_abc.xyz-DEF')).toBe('qq-user-123456_abc.xyz-DEF');

    // 4. 特殊字符转义：冒号、波浪号、斜杠、空格
    expect(encodeSegment('group:123')).toBe('group~003A123');
    expect(encodeSegment('session~01')).toBe('session~007E01');
    expect(encodeSegment('a/b/c')).toBe('a~002Fb~002Fc');
    expect(encodeSegment('hello world')).toBe('hello~0020world');
  });

  it('契约 2: 包含特殊字符（冒号/波浪号）的 SessionId 能在 V3 编码目录中准确寻址探测', async () => {
    const ctx = new Context();
    const sessionManager = new SessionManager(ctx, tmpHome);

    const specialSessionId = 'qq-user-12345:6789~v3';
    const encodedDirName = encodeSegment(specialSessionId);
    expect(encodedDirName).toBe('qq-user-12345~003A6789~007Ev3');

    // 模拟 DSH 在 sessions/default/<encodedDirName>/ 下生成 session.v3.jsonl
    const projectSessionsDir = path.join(tmpHome, 'sessions', 'default', encodedDirName);
    await fsp.mkdir(projectSessionsDir, { recursive: true });
    await fsp.writeFile(
      path.join(projectSessionsDir, 'session.v3.jsonl'),
      JSON.stringify({ type: 'session', version: 3, id: specialSessionId }) + '\n'
    );

    // 探测应准确返回 true
    expect(sessionManager.isSessionPhysicallyPresent(specialSessionId)).toBe(true);

    // 未存在的特殊字符 sessionId 应返回 false
    expect(sessionManager.isSessionPhysicallyPresent('qq-user-not-exists:123')).toBe(false);
  });

  it('契约 3: 存量 V2 与旧版候选会话文件兼容性探测', async () => {
    const ctx = new Context();
    const sessionManager = new SessionManager(ctx, tmpHome);

    // 场景 A: session.v2.jsonl
    const sidV2 = 'qq-group-v2-legacy';
    const dirV2 = path.join(tmpHome, 'sessions', 'default', sidV2);
    await fsp.mkdir(dirV2, { recursive: true });
    await fsp.writeFile(
      path.join(dirV2, 'session.v2.jsonl'),
      JSON.stringify({ type: 'session', version: 2, id: sidV2 }) + '\n'
    );
    expect(sessionManager.isSessionPhysicallyPresent(sidV2)).toBe(true);

    // 场景 B: session.v2.jsonl.zstd
    const sidV2Zstd = 'qq-group-v2-zstd';
    const dirV2Zstd = path.join(tmpHome, 'sessions', 'default', sidV2Zstd);
    await fsp.mkdir(dirV2Zstd, { recursive: true });
    await fsp.writeFile(path.join(dirV2Zstd, 'session.v2.jsonl.zstd'), 'mock-zstd-binary');
    expect(sessionManager.isSessionPhysicallyPresent(sidV2Zstd)).toBe(true);

    // 场景 C: session.jsonl (极旧版本)
    const sidV1 = 'qq-user-old-v1';
    const dirV1 = path.join(tmpHome, 'sessions', 'default', sidV1);
    await fsp.mkdir(dirV1, { recursive: true });
    await fsp.writeFile(path.join(dirV1, 'session.jsonl'), '{"type":"session"}\n');
    expect(sessionManager.isSessionPhysicallyPresent(sidV1)).toBe(true);

    // 场景 D: session.v3.jsonl.zstd (V3 压缩格式)
    const sidV3Zstd = 'qq-user-v3-zstd';
    const dirV3Zstd = path.join(tmpHome, 'sessions', 'default', encodeSegment(sidV3Zstd));
    await fsp.mkdir(dirV3Zstd, { recursive: true });
    await fsp.writeFile(path.join(dirV3Zstd, 'session.v3.jsonl.zstd'), 'mock-zstd-binary');
    expect(sessionManager.isSessionPhysicallyPresent(sidV3Zstd)).toBe(true);
  });

  it('契约 4: isSessionPhysicallyPresentAsync 优先利用 sessionPersistence.stat 进行无锁轻量探测', async () => {
    const ctx = new Context();
    const sessionId = 'qq-group-stat-probe';

    let statCalled = false;
    const mockStat = vi.fn().mockImplementation(async (id: string) => {
      statCalled = true;
      if (id === sessionId) {
        return {
          id,
          createdAt: Date.now(),
          eventCount: 42,
        };
      }
      return undefined;
    });

    (ctx as any).sessionPersistence = {
      stat: mockStat,
    };

    const sessionManager = new SessionManager(ctx, tmpHome);

    // 1. stat 命中快照时，无需磁盘文件即可异步探测成功
    const resultTrue = await sessionManager.isSessionPhysicallyPresentAsync(sessionId);
    expect(resultTrue).toBe(true);
    expect(mockStat).toHaveBeenCalledWith(sessionId);

    // 2. stat 未命中 (返回 undefined) 且磁盘亦不存在时，回退探针返回 false
    const resultFalse = await sessionManager.isSessionPhysicallyPresentAsync('qq-group-not-stat');
    expect(resultFalse).toBe(false);

    // 3. stat 抛出异常时，优雅降级回退至磁盘文件系统物理探测
    mockStat.mockRejectedValueOnce(new Error('stat query error'));
    // 在磁盘上建立文件
    const dirFallback = path.join(tmpHome, 'sessions', 'default', sessionId);
    await fsp.mkdir(dirFallback, { recursive: true });
    await fsp.writeFile(path.join(dirFallback, 'session.v3.jsonl'), '{"type":"session"}\n');

    const resultFallback = await sessionManager.isSessionPhysicallyPresentAsync(sessionId);
    expect(resultFallback).toBe(true);
  });

  it('契约 5: 真实装配路径下 flush 会话与物理探针双向闭环', async () => {
    booted = await bootDshNapcatBridge({
      dshHome: tmpHome,
      mountPlugin: false,
    });

    const sessionManager = new SessionManager(booted.ctx, tmpHome);
    const peer = 'user_9876543210';

    const agent = await sessionManager.getOrCreateAgent(peer);
    const sessionId = agent.session.id;
    expect(sessionId).toBe('qq-user-9876543210');

    // 真实 flush 会话落盘
    await booted.ctx.sessions.flush(agent.session);

    // 异步探针与同步探针均应能探测到
    expect(sessionManager.isSessionPhysicallyPresent(sessionId)).toBe(true);
    const asyncPresent = await sessionManager.isSessionPhysicallyPresentAsync(sessionId);
    expect(asyncPresent).toBe(true);

    await sessionManager.dispose();
  });
});
