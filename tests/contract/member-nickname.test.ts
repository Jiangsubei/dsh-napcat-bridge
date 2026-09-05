import { describe, it, expect } from 'vitest';
import { CachedGroupMemberResolver } from '../../src/gateway/members.js';

/**
 * 契约测试: EN-001 群成员昵称解析器 (Group Member Nickname Resolver)
 * - 命中缓存（TTL 内）不再调用 get_group_member_info；
 * - 未命中调用 gateway.getGroupMemberInfo，card 优先于 nickname；
 * - 单次 API 失败返回 undefined（调用方回退裸 QQ 号），不中断、不缓存失败。
 */

function stubMemberGateway(overrides: Record<string, any> = {}) {
  const calls: Array<Record<string, any>> = [];
  const gateway = {
    getGroupMemberInfo: async (groupId: any, userId: any) => {
      calls.push({ groupId, userId });
      if (overrides.fail === true) {
        throw new Error('NapCat 未连接');
      }
      return { status: 'ok', retcode: 0, data: { user_id: userId, nickname: 'BotNickname', card: '群名片BotNickname' } };
    },
  };
  return { gateway, calls };
}

describe('契约测试: 群成员昵称缓存解析器 (EN-001)', () => {
  it('契约 1: 未命中时调用 get_group_member_info，card 优先于 nickname', async () => {
    const { gateway, calls } = stubMemberGateway();
    const resolver = new CachedGroupMemberResolver(gateway as any, 60_000);
    const nick = await resolver.resolve(3000000001, '1000000001');
    expect(nick).toBe('群名片BotNickname');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ groupId: 3000000001, userId: 1000000001 });
  });

  it('契约 2: TTL 内二次解析命中缓存，不再调用 API', async () => {
    const { gateway, calls } = stubMemberGateway();
    const resolver = new CachedGroupMemberResolver(gateway as any, 60_000);
    await resolver.resolve(3000000001, '1000000001');
    await resolver.resolve(3000000001, '1000000001');
    await resolver.resolve(3000000001, '1000000001');
    expect(calls).toHaveLength(1);
  });

  it('契约 3: 不同群/不同用户各自独立缓存', async () => {
    const { gateway, calls } = stubMemberGateway();
    const resolver = new CachedGroupMemberResolver(gateway as any, 60_000);
    await resolver.resolve(3000000001, '1000000001');
    await resolver.resolve(3000000001, '2000000001');
    await resolver.resolve(10086, '1000000001');
    expect(calls).toHaveLength(3);
  });

  it('契约 4: TTL 过期后重新调用 API 刷新缓存', async () => {
    const { gateway, calls } = stubMemberGateway();
    const resolver = new CachedGroupMemberResolver(gateway as any, 10);
    await resolver.resolve(3000000001, '1000000001');
    await new Promise((resolve) => setTimeout(resolve, 30));
    await resolver.resolve(3000000001, '1000000001');
    expect(calls).toHaveLength(2);
  });

  it('契约 5: API 失败返回 undefined，不抛出、不缓存', async () => {
    const { gateway, calls } = stubMemberGateway({ fail: true });
    const resolver = new CachedGroupMemberResolver(gateway as any, 60_000);
    const nick = await resolver.resolve(3000000001, '1000000001');
    expect(nick).toBeUndefined();
    // 失败不缓存：下一次仍会尝试调用
    const nick2 = await resolver.resolve(3000000001, '1000000001');
    expect(nick2).toBeUndefined();
    expect(calls).toHaveLength(2);
  });

  it('契约 6: gateway 返回空数据（无 nickname/card）时返回 undefined', async () => {
    const { gateway } = stubMemberGateway();
    const resolver = new CachedGroupMemberResolver(
      {
        getGroupMemberInfo: async () => ({ status: 'ok', retcode: 0, data: {} }),
      } as any,
      60_000
    );
    const nick = await resolver.resolve(3000000001, '1000000001');
    expect(nick).toBeUndefined();
    void gateway;
  });
});