/**
 * dsh-napcat-bridge: 群成员昵称解析器 (EN-001)
 *
 * NapCat 的 at 消息段 data 只有 qq（QQ 号），不含昵称（issue EN-001 已核实事实）；
 * 被@者的昵称需调 OneBot 11 get_group_member_info({group_id, user_id}) 获取
 * （返回 nickname + card，展示统一 card 优先）。发送者昵称在 sender 字段可直接取。
 *
 * 为避免一条含多个 at 段的消息触发多次 API 调用，提供 per-(group,user) 缓存 + TTL
 * （默认 5 分钟）；单次 API 失败返回 undefined（调用方回退裸 QQ 号），不缓存失败、不上抛。
 */

import type { OneBotActionResponse } from '../types/index.js';

export interface GroupMemberInfoData {
  nickname?: string;
  card?: string;
  [key: string]: unknown;
}

export interface GroupMemberGateway {
  getGroupMemberInfo(
    groupId: number | string,
    userId: number | string
  ): Promise<OneBotActionResponse<GroupMemberInfoData>>;
}

export interface MemberNicknameResolver {
  resolve(groupId: number | string, qq: string): Promise<string | undefined>;
}

export class CachedGroupMemberResolver implements MemberNicknameResolver {
  private cache = new Map<string, { nickname: string; expires: number }>();

  constructor(
    private readonly gateway: GroupMemberGateway,
    private readonly ttlMs = 5 * 60 * 1000
  ) {}

  async resolve(groupId: number | string, qq: string): Promise<string | undefined> {
    const key = `${groupId}:${qq}`;
    const hit = this.cache.get(key);
    if (hit && hit.expires > Date.now()) {
      return hit.nickname;
    }

    try {
      const res = await this.gateway.getGroupMemberInfo(Number(groupId), Number(qq));
      const data = res?.data;
      const nickname = data?.card || data?.nickname;
      if (typeof nickname === 'string' && nickname.trim() !== '') {
        const normalized = nickname.trim();
        this.cache.set(key, { nickname: normalized, expires: Date.now() + this.ttlMs });
        return normalized;
      }
    } catch {
      // 单次失败不缓存、不上抛：调用方回退裸 @QQ号，绝不中断消息归一化
    }
    return undefined;
  }

  /** 清空全部缓存（测试/昵称更新时可用） */
  clear(): void {
    this.cache.clear();
  }
}

/** 便捷工厂 */
export function createMemberNicknameResolver(
  gateway: GroupMemberGateway,
  ttlMs?: number
): MemberNicknameResolver {
  return new CachedGroupMemberResolver(gateway, ttlMs);
}