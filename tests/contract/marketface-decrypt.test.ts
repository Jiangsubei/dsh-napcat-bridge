import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import {
  MediaStorageManager,
  isEncryptedNtqqMarketFace,
  decryptNtqqMarketFace,
} from '../../src/storage/media.js';
import { MessageDatabase } from '../../src/storage/database.js';

/**
 * 契约测试: NTQQ 商城表情 (marketface) 混淆解密与透明落盘自愈契约
 *
 * 背景与规范契约：
 *   NTQQ 客户端将商城表情动图保存在本地 nt_data/Emoji/marketface/<pkg>/<id> 时，
 *   采用 50 字节周期的混淆加密（每 50 字节前 20 字节与 0xFF 异或，后 30 字节明文不变）。
 *   这导致文件头被混淆为 B8 B6 B9 C7 C6 9E（GIF89a ^ 0xFF），下游 read_animation / read_image 报格式错误。
 *
 * 契约要求：
 *   1. isEncryptedNtqqMarketFace: 准确识别 B8 B6 B9 C7 (C6|C8) 9E 混淆头，对正常 GIF/PNG/普通文件不误报；
 *   2. decryptNtqqMarketFace: 精准执行 50 字节周期按位逆向恢复，使混淆数据 100% 还原为合法标准 GIF；
 *   3. saveBuffer: 接收到混淆 Buffer 时，在魔数检测与计算指纹前自动透明解密，推断出 .gif 扩展名，落盘为明文 GIF；
 *   4. downloadAndSave: 接收到本地加密文件路径时，落盘为解密后的标准 GIF；
 *   5. 一级去重命中历史落盘的未解密遗留文件时，自动就地解密自愈并刷新指纹。
 */

const TEST_PEER = 'user_1000000001';

// 构造一个合法的简易 GIF89a 字节流（含 Header + Logical Screen Descriptor + 终止符 0x3b）
function createValidGifBuffer(length = 120): Buffer {
  const buf = Buffer.alloc(length, 0);
  // Header: GIF89a
  buf.write('GIF89a', 0, 6, 'ascii');
  // Logical Screen Descriptor: width=200, height=200, packed=0, bg=0, aspect=0
  buf.writeUInt16LE(200, 6);
  buf.writeUInt16LE(200, 8);
  buf[10] = 0x00; // No Global Color Table
  buf[11] = 0x00;
  buf[12] = 0x00;
  // 填充一些伪图像数据
  for (let i = 13; i < length - 1; i++) {
    buf[i] = (i * 7) & 0xff;
  }
  // Trailer
  buf[length - 1] = 0x3b;
  return buf;
}

// 模拟 NTQQ 混淆加密算法
function obfuscateNtqqMarketFace(buf: Buffer): Buffer {
  const obfuscated = Buffer.alloc(buf.length);
  for (let i = 0; i < buf.length; i++) {
    obfuscated[i] = i % 50 < 20 ? buf[i] ^ 0xff : buf[i];
  }
  return obfuscated;
}

describe('契约测试: NTQQ 商城表情混淆解密与透明落盘自愈', () => {
  let tmpHome: string;
  let db: MessageDatabase;
  let manager: MediaStorageManager;

  beforeEach(async () => {
    tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-marketface-test-'));
    db = new MessageDatabase(path.join(tmpHome, 'messages.sqlite'));
    manager = new MediaStorageManager({
      dshHome: tmpHome,
      db,
    });
  });

  afterEach(async () => {
    try {
      db.close();
    } catch {}
    try {
      await fsp.rm(tmpHome, { recursive: true, force: true });
    } catch {}
  });

  it('MF-契约 1: isEncryptedNtqqMarketFace 正确识别混淆特征，且不误伤正常文件', () => {
    const rawGif = createValidGifBuffer(100);
    const encryptedGif89a = obfuscateNtqqMarketFace(rawGif);

    // 1. 成功识别 GIF89a 混淆 (B8 B6 B9 C7 C6 9E)
    expect(isEncryptedNtqqMarketFace(encryptedGif89a)).toBe(true);

    // 2. 成功识别 GIF87a 混淆 (B8 B6 B9 C7 C8 9E)
    const rawGif87a = Buffer.from(rawGif);
    rawGif87a.write('GIF87a', 0, 6, 'ascii');
    const encryptedGif87a = obfuscateNtqqMarketFace(rawGif87a);
    expect(isEncryptedNtqqMarketFace(encryptedGif87a)).toBe(true);

    // 3. 正常明文 GIF 不应被误判
    expect(isEncryptedNtqqMarketFace(rawGif)).toBe(false);

    // 4. 正常 PNG (\x89PNG) 不应被误判
    const pngBuf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
    expect(isEncryptedNtqqMarketFace(pngBuf)).toBe(false);

    // 5. 过短 Buffer 不应抛错且返回 false
    expect(isEncryptedNtqqMarketFace(Buffer.from([0xb8, 0xb6, 0xb9]))).toBe(false);
    expect(isEncryptedNtqqMarketFace(Buffer.alloc(0))).toBe(false);
  });

  it('MF-契约 2: decryptNtqqMarketFace 准确按 50 字节周期还原数据', () => {
    const original = createValidGifBuffer(160);
    const encrypted = obfuscateNtqqMarketFace(original);

    // 混淆后前 6 字节应为 B8 B6 B9 C7 C6 9E
    expect(encrypted.subarray(0, 6).toString('hex')).toBe('b8b6b9c7c69e');

    // 解密
    const decrypted = decryptNtqqMarketFace(encrypted);

    // 解密后前 6 字节恢复为 GIF89a
    expect(decrypted.subarray(0, 6).toString('ascii')).toBe('GIF89a');
    // 解密后末尾 0x3B 恢复
    expect(decrypted[decrypted.length - 1]).toBe(0x3b);
    // 全字节无损还原
    expect(decrypted.equals(original)).toBe(true);
  });

  it('MF-契约 3: saveBuffer 遇到混淆数据自动透明解密，落盘为标准合法 GIF', async () => {
    const original = createValidGifBuffer(120);
    const encrypted = obfuscateNtqqMarketFace(original);

    // 直接给 saveBuffer 传入加密混淆数据（模拟从 NTQQ 本地缓存直读出来的数据）
    const result = await manager.saveBuffer(encrypted, {
      type: 'sticker',
      sessionId: TEST_PEER,
      fileId: 'mock_marketface_file_1',
    });

    expect(result.deduplicated).toBe(false);
    expect(result.localPath).toBeTruthy();
    expect(result.localPath.endsWith('.gif')).toBe(true);

    // 验证落盘文件内容已是解密后的标准明文 GIF
    const savedBytes = await fsp.readFile(result.localPath);
    expect(savedBytes.subarray(0, 6).toString('ascii')).toBe('GIF89a');
    expect(savedBytes[savedBytes.length - 1]).toBe(0x3b);
    expect(savedBytes.equals(original)).toBe(true);

    // 验证返回的指纹与 MD5 是解密后数据的指纹
    expect(result.fingerprint).toBe(manager.computeHash(original));
  });

  it('MF-契约 4: downloadAndSave 遇到本地已加密源文件时，落盘自动解密', async () => {
    const original = createValidGifBuffer(150);
    const encrypted = obfuscateNtqqMarketFace(original);

    // 模拟 NTQQ 本地缓存目录中存放的无后缀加密文件
    const fakeNtqqCachePath = path.join(tmpHome, '3e6f4431112b2ff27e532e527b7cfdf1');
    await fsp.writeFile(fakeNtqqCachePath, encrypted);

    const result = await manager.downloadAndSave(fakeNtqqCachePath, {
      type: 'sticker',
      sessionId: TEST_PEER,
      fileId: 'mock_marketface_file_2',
    });

    expect(result.localPath.endsWith('.gif')).toBe(true);
    const savedBytes = await fsp.readFile(result.localPath);
    expect(savedBytes.subarray(0, 6).toString('ascii')).toBe('GIF89a');
    expect(savedBytes.equals(original)).toBe(true);
  });

  it('MF-契约 5: 一级去重命中历史未解密的遗留文件时，自动就地解密自愈', async () => {
    const original = createValidGifBuffer(140);
    const encrypted = obfuscateNtqqMarketFace(original);

    // 手动在磁盘伪造一个历史遗留的未解密 .gif 文件
    const legacyDir = manager.getDownloadDir('sticker', TEST_PEER);
    await fsp.mkdir(legacyDir, { recursive: true });
    const legacyPath = path.join(legacyDir, 'legacy_encrypted.gif');
    await fsp.writeFile(legacyPath, encrypted);

    // 数据库中登记该文件
    const legacyFileId = 'legacy_encrypted_file_id';
    db.saveMessage({
      msg_id: 9999001,
      peer: TEST_PEER,
      user_id: '1000000001',
      sender_name: 'TestUser',
      time: Date.now(),
      type: 'sticker',
      content: '[表情包]',
      raw: '[]',
      file_id: legacyFileId,
      local_path: legacyPath,
      fingerprint: 'legacy_old_fingerprint',
      self: 0,
      recalled: 0,
    });

    // 再次调用 saveBuffer（带同一 fileId，触发一级去重）
    const result = await manager.saveBuffer(encrypted, {
      type: 'sticker',
      sessionId: TEST_PEER,
      fileId: legacyFileId,
    });

    expect(result.deduplicated).toBe(true);
    expect(result.level).toBe(1);
    expect(result.localPath).toBe(legacyPath);

    // 验证磁盘上的遗留文件已被就地自愈解密为标准 GIF
    const repairedBytes = await fsp.readFile(legacyPath);
    expect(repairedBytes.subarray(0, 6).toString('ascii')).toBe('GIF89a');
    expect(repairedBytes.equals(original)).toBe(true);
  });
});
