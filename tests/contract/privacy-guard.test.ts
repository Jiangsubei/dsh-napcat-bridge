import { describe, it, expect } from 'vitest';
import { isAllowedId, maskId, scanRepository, scanText, DEFAULT_POLICY } from '../../scripts/privacy-guard.js';

/**
 * 隐私守卫契约测试
 *
 * 红线：本文件是「真实 QQ 号 / 群号不得入库」的最后防线。
 * - 严禁为了让测试变绿而放宽断言、删除用例或跳过运行；
 * - 测试夹具中的疑似真实 ID 一律用字符串拼接构造，避免本文件自身成为隐私泄漏源。
 */

/** 拼接构造一串「疑似真实」的 10 位 ID（落在所有 Mock 段之外） */
const suspicious = (...parts: string[]): string => parts.join('');
const SUSPICIOUS_ID = suspicious('16', '17', '30', '72', '95');
const MOCK_BOT = suspicious('1000', '000011');
const MOCK_USER = suspicious('2000', '000011');
const MOCK_GROUP = suspicious('3000', '000011');

describe('契约测试: 隐私守卫（真实 QQ 号/群号不得入库）', () => {
  describe('ID 白名单判定', () => {
    it('放行标准 Mock 段内的用户 / 群 / 测试群 ID', () => {
      expect(isAllowedId(MOCK_BOT)).toBe(true);
      expect(isAllowedId(MOCK_USER)).toBe(true);
      expect(isAllowedId(MOCK_GROUP)).toBe(true);
      expect(isAllowedId(suspicious('8000', '000001'))).toBe(true);
      expect(isAllowedId(suspicious('4000', '000001'))).toBe(true);
      expect(isAllowedId(suspicious('3200', '000001'))).toBe(true);
    });

    it('放行各 Mock 段的边界值，拒绝越界值', () => {
      expect(isAllowedId(suspicious('1000', '000000'))).toBe(true);
      expect(isAllowedId(suspicious('1000', '000099'))).toBe(true);
      expect(isAllowedId(suspicious('1000', '000100'))).toBe(false);
      expect(isAllowedId(suspicious('8000', '000099'))).toBe(true);
      expect(isAllowedId(suspicious('8000', '000100'))).toBe(false);
    });

    it('放行约定的十进制例外值', () => {
      expect(isAllowedId('10000')).toBe(true);
      expect(isAllowedId('20050606')).toBe(true);
    });

    it('位数低于下限的短数字不算身份 ID 违规', () => {
      expect(isAllowedId('10001')).toBe(true);
      expect(isAllowedId('123456')).toBe(true);
      expect(isAllowedId('999999')).toBe(true);
    });

    it('位数超过上限的长数字不算身份 ID 违规（毫秒时间戳等）', () => {
      expect(isAllowedId(suspicious('1793', '80000000', '00'))).toBe(true);
    });

    it('落在 Mock 段之外的常见真实 ID 形态一律拒绝', () => {
      expect(isAllowedId(SUSPICIOUS_ID)).toBe(false);
      expect(isAllowedId(suspicious('888', '888888'))).toBe(false);
      expect(isAllowedId(suspicious('1234', '567890'))).toBe(false);
    });
  });

  describe('身份上下文识别', () => {
    it('识别 user_id / group_id / uin / qq / bot_qq 等键值上下文', () => {
      const text = [
        `user_id: ${SUSPICIOUS_ID}`,
        `{"group_id": ${SUSPICIOUS_ID}}`,
        `uin=${SUSPICIOUS_ID}`,
        `qq: '${SUSPICIOUS_ID}'`,
        `bot_qq: "${SUSPICIOUS_ID}"`,
        `userId: ${SUSPICIOUS_ID}`,
      ].join('\n');

      const violations = scanText(text, 'fixture.ts');
      expect(violations).toHaveLength(6);
      expect(violations.every((v) => v.kind === 'identity-key')).toBe(true);
    });

    it('识别 peer / session 标识中的身份 ID（user_ / group_ / qq-user- / qq-group-）', () => {
      const text = [
        `peer: 'user_${SUSPICIOUS_ID}'`,
        `peer: 'group_${SUSPICIOUS_ID}'`,
        `id: 'qq-user-${SUSPICIOUS_ID}'`,
        `id: 'qq-group-${SUSPICIOUS_ID}'`,
        `getOrCreateAgent('user_${SUSPICIOUS_ID}')`,
      ].join('\n');

      const violations = scanText(text, 'fixture.ts');
      expect(violations).toHaveLength(5);
      expect(violations.every((v) => v.kind === 'peer-token')).toBe(true);
    });

    it('识别 CQ 码、日志括号与文本 `QQ:` 形态', () => {
      const text = [
        `[CQ:at,qq=${SUSPICIOUS_ID}] 你好`,
        `[某用户(${SUSPICIOUS_ID})] 发来一条消息`,
        `[引用回复 某用户 (QQ: ${SUSPICIOUS_ID}): "历史消息"]`,
      ].join('\n');

      const violations = scanText(text, 'fixture.ts');
      expect(violations).toHaveLength(3);
      expect(violations.map((v) => v.kind).sort()).toEqual(['cq-code', 'log-entry', 'qq-text']);
    });

    it('不误伤消息 ID、时间戳与普通数字（message_id / msg_id / time / seq）', () => {
      const text = [
        `message_id: ${SUSPICIOUS_ID}`,
        `msg_id: '${SUSPICIOUS_ID}'`,
        `real_id: ${SUSPICIOUS_ID}`,
        `reply_to: '${SUSPICIOUS_ID}'`,
        `time: ${suspicious('1793', '80000000', '00')}`,
        `message_seq: ${SUSPICIOUS_ID}`,
        `seq: ${SUSPICIOUS_ID}`,
      ].join('\n');

      expect(scanText(text, 'fixture.ts')).toHaveLength(0);
    });

    it('允许的 Mock ID 出现在身份上下文中不报违规', () => {
      const text = [
        `user_id: ${MOCK_USER}`,
        `{"group_id": ${MOCK_GROUP}}`,
        `peer: 'group_${MOCK_GROUP}'`,
        `[CQ:at,qq=${MOCK_BOT}] 你好`,
        `[测试用户A(${MOCK_USER})] 发来一条消息`,
      ].join('\n');

      expect(scanText(text, 'fixture.ts')).toHaveLength(0);
    });

    it('违规记录不泄漏完整 ID，仅保留掩码', () => {
      const violations = scanText(`user_id: ${SUSPICIOUS_ID}`, 'fixture.ts');
      expect(violations).toHaveLength(1);
      expect(violations[0]!.masked).not.toContain(SUSPICIOUS_ID);
      expect(violations[0]!.masked).toBe(maskId(SUSPICIOUS_ID));
      expect(violations[0]!.line).toBe(1);
    });
  });

  it('仓库当前工作树与暂存区不得存在疑似真实身份 ID', () => {
    const violations = scanRepository(process.cwd(), DEFAULT_POLICY);
    const report = violations
      .map((v) => `${v.file}:${v.line} [${v.kind}] ${v.masked}`)
      .join('\n');
    expect(violations, `发现疑似真实身份 ID：\n${report}`).toEqual([]);
  });
});
