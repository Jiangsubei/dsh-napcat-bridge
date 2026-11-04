/**
 * dsh-napcat-bridge: 本地稳定消息 ID 生成工具
 *
 * 内部协同通讯等「非 OneBot 消息」没有外部 message_id，需要本地生成稳定主键，
 * 以便写入 messages 表后可被引用、可幂等去重（同一 seed 恒得同一 ID）。
 */

/**
 * 以 FNV-1a 32-bit 从文本派生稳定正整数 ID（0 会被替换为 1，避免主键空值语义）。
 * 同一 seed 必定得到同一 ID；不同 seed 的碰撞概率与 32-bit 散列同级。
 */
export function stableLocalMsgId(seed: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) || 1;
}
