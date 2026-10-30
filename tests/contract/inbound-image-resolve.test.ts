import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import * as http from 'node:http';
import { MediaStorageManager } from '../../src/storage/media.js';
import { MessageDatabase } from '../../src/storage/database.js';
import { resolveInboundImage } from '../../src/gateway/inbound-media.js';

/**
 * 契约测试: 入站图片四段式解析 (Inbound Image Resolve)
 *
 * 背景（devlog/修复方案-媒体直链失效与回退落盘_261030.md §1）：
 *   QQ 下发的 gchat.qpic.cn/download?rkey=… 直链对第三方进程 100% 返回
 *   {"retcode":-5503007,"retmsg":"download url has expired"}（收到后 100ms 即失败，改 header/参数无效），
 *   而 NapCat get_image / get_file 19/19 能拿到本地原图。
 *   因此主路改为「NapCat 本地优先 → 直链 → get_msg 刷新直链」四段式，且拿到字节后必须
 *   复制进我们自己的 downloads/<type>/<peer>/ 落盘（不能只引用 NapCat 缓存路径）。
 *
 * 本文件只 mock NapCat 应答与网络（外部依赖隔离），MediaStorageManager / MessageDatabase 均为真实实现。
 *
 * DC-1 直链不可用 → get_image 本地路径 → 复制进 downloads（魔数纠正后缀）
 * DC-2 get_image 失败 → get_file 兜住
 * DC-3 前两段失败 → 直链成功（multimedia / gchatpic_new 这类仍可用的 host 不回归）
 * DC-4 前三段失败 → get_msg 刷新直链后成功
 * DC-5 四段全失败 → ok=false + 四段 attempts 齐全 + 不落盘
 * DC-6 同 file_id 二次入站 → 一级去重直接命中，不再调用 NapCat
 * DC-7 本地文件小于段内声明尺寸 → 仍落盘，但标记 sizeMismatch
 */

const PEER = 'group_3000000001';
const PNG_BYTES = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(48, 7)]);
const GIF_BYTES = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(24, 1)]);

describe('契约测试: 入站图片四段式解析 (Inbound Image Resolve)', () => {
  let tmpHome: string;
  let db: MessageDatabase;
  let manager: MediaStorageManager;
  let servers: http.Server[] = [];

  const ok = (data: any) => ({ status: 'ok' as const, retcode: 0, data });

  async function startLoopback(body: Buffer, status = 200): Promise<string> {
    return new Promise((resolve, reject) => {
      const srv = http.createServer((_req, res) => {
        res.writeHead(status, { 'Content-Type': 'image/gif' });
        res.end(body);
      });
      srv.on('error', reject);
      servers.push(srv);
      srv.listen(0, '127.0.0.1', () => {
        const addr = srv.address() as any;
        resolve(`http://127.0.0.1:${addr.port}/image.gif`);
      });
    });
  }

  async function makeLocalImage(name = 'origin.png'): Promise<string> {
    const p = path.join(tmpHome, 'napcat-cache', name);
    await fsp.mkdir(path.dirname(p), { recursive: true });
    await fsp.writeFile(p, PNG_BYTES);
    return p;
  }

  beforeEach(async () => {
    tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-napcat-inbound-image-'));
    db = new MessageDatabase(path.join(tmpHome, 'messages.sqlite'));
    manager = new MediaStorageManager({ dshHome: tmpHome, downloadDir: 'downloads', db });
    servers = [];
  });

  afterEach(async () => {
    for (const s of servers) await new Promise<void>((r) => s.close(() => r())).catch(() => {});
    db.close();
    await fsp.rm(tmpHome, { recursive: true, force: true }).catch(() => {});
  });

  it('DC-1: 直链不可用 → get_image 本地路径 → 复制进 downloads 并按魔数纠正后缀', async () => {
    const origin = await makeLocalImage();
    const getImage = async () => ok({ file: origin, file_size: String(PNG_BYTES.length), file_name: 'origin.png' });

    const res = await resolveInboundImage({
      peer: PEER,
      isSticker: false,
      file: 'DEADBEEF.png',
      fileId: 'DEADBEEF.png',
      url: 'http://127.0.0.1:1/never-used.png',
      declaredSize: PNG_BYTES.length,
      msgId: 9001,
      gateway: { getImage },
      mediaManager: manager,
    });

    expect(res.ok).toBe(true);
    expect(res.via).toBe('get_image');
    expect(res.localPath).toBeTruthy();
    expect(res.localPath!).not.toBe(origin); // 必须是复制件，不是引用 NapCat 缓存
    expect(res.localPath!.startsWith(path.join(tmpHome, 'downloads', 'image', PEER))).toBe(true);
    expect(res.localPath!.endsWith('.png')).toBe(true);
    expect(Buffer.compare(fs.readFileSync(res.localPath!), PNG_BYTES)).toBe(0);
    expect(res.fingerprint).toBeTruthy();
  });

  it('DC-2: get_image 失败 → get_file 本地路径兜住', async () => {
    const origin = await makeLocalImage();
    const getImage = async () => ({ status: 'failed' as const, retcode: 1404, data: null as any, wording: 'unknown action' });
    const getFile = async () => ok({ file: origin, file_size: String(PNG_BYTES.length) });

    const res = await resolveInboundImage({
      peer: PEER,
      isSticker: true,
      file: 'CAFEBABE.jpg',
      fileId: 'CAFEBABE',
      url: 'http://127.0.0.1:1/never-used.png',
      gateway: { getImage: getImage as any, getFile: getFile as any },
      mediaManager: manager,
    });

    expect(res.ok).toBe(true);
    expect(res.via).toBe('get_file');
    expect(fs.existsSync(res.localPath!)).toBe(true);
  });

  it('DC-3: 前两段失败 → 直链下载成功（multimedia/gchatpic_new 不回归）', async () => {
    const url = await startLoopback(GIF_BYTES);
    const getImage = async () => ({ status: 'failed' as const, retcode: 1404, data: null as any });
    const getFile = async () => ({ status: 'failed' as const, retcode: 1404, data: null as any });

    const res = await resolveInboundImage({
      peer: PEER,
      isSticker: true,
      file: 'FEEDFACE.jpg',
      fileId: 'FEEDFACE',
      url,
      gateway: { getImage: getImage as any, getFile: getFile as any },
      mediaManager: manager,
    });

    expect(res.ok).toBe(true);
    expect(res.via).toBe('url');
    expect(res.localPath!.endsWith('.gif')).toBe(true);
  });

  it('DC-4: 前三段失败 → get_msg 刷新直链后成功', async () => {
    const url = await startLoopback(GIF_BYTES);
    const getImage = async () => ({ status: 'failed' as const, retcode: 1404, data: null as any });
    const getFile = async () => ({ status: 'failed' as const, retcode: 1404, data: null as any });
    const getMsg = async () =>
      ok({ message: [{ type: 'image', data: { url, file: 'CAFEBABE.jpg' } }] });

    const res = await resolveInboundImage({
      peer: PEER,
      isSticker: false,
      file: 'CAFEBABE.jpg',
      fileId: 'CAFEBABE',
      url: await startLoopback(Buffer.from('{}'), 400),
      msgId: 9002,
      gateway: { getImage: getImage as any, getFile: getFile as any, getMsg: getMsg as any },
      mediaManager: manager,
    });

    expect(res.ok).toBe(true);
    expect(res.via).toBe('get_msg_url');
    expect(res.attempts.map((a) => a.via)).toEqual(['get_image', 'get_file', 'url', 'get_msg_url']);
  });

  it('DC-5: 四段全失败 → ok=false、attempts 齐全、目录无落盘', async () => {
    const deadUrl = await startLoopback(Buffer.from('{"retcode":-5503007,"retmsg":"download url has expired"}'), 400);
    const fail = async () => ({ status: 'failed' as const, retcode: 1404, data: null as any });

    const res = await resolveInboundImage({
      peer: PEER,
      isSticker: false,
      file: '0123456789ABCDEF.png',
      fileId: '0123456789ABCDEF.png',
      url: deadUrl,
      msgId: 9003,
      gateway: { getImage: fail as any, getFile: fail as any, getMsg: fail as any },
      mediaManager: manager,
    });

    expect(res.ok).toBe(false);
    expect(res.localPath).toBeUndefined();
    expect(res.attempts).toHaveLength(4);
    expect(res.attempts.every((a) => a.ok === false)).toBe(true);
    expect(res.error).toBeTruthy();
    const targetDir = path.join(tmpHome, 'downloads', 'image', PEER);
    expect(fs.existsSync(targetDir) ? fs.readdirSync(targetDir).length : 0).toBe(0);
  });

  it('DC-6: 同 file_id 二次入站 → 一级去重直接命中，不再调用 NapCat', async () => {
    const origin = await makeLocalImage();
    let getImageCalls = 0;
    const getImage = async () => {
      getImageCalls++;
      return ok({ file: origin, file_size: String(PNG_BYTES.length) });
    };

    const base = {
      peer: PEER,
      isSticker: false,
      file: 'SAMESAME.png',
      fileId: 'SAMESAME.png',
      url: 'http://127.0.0.1:1/never-used.png',
      gateway: { getImage },
      mediaManager: manager,
    };
    const first = await resolveInboundImage(base);
    // 模拟调用方（index.ts）在处理完首条消息后落库：resolver 自身不写 messages 表，
    // 一级去重依赖消息行上的 file_id/local_path。
    db.saveMessage({
      msg_id: 9101,
      peer: PEER,
      user_id: '2000000001',
      sender_name: '测试成员',
      time: Date.now(),
      type: 'image',
      content: '[图片:SAMESAME.png]',
      raw: '{}',
      file_id: 'SAMESAME.png',
      busid: null,
      local_path: first.localPath!,
      fingerprint: first.fingerprint ?? null,
      recalled: 0,
      self: 0,
      reply_to: null,
    });
    const second = await resolveInboundImage(base);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(second.via).toBe('cache');
    expect(second.localPath).toBe(first.localPath);
    expect(getImageCalls).toBe(1);
  });

  it('DC-8: 段内已带 local_path → 直接复制，不再调用 NapCat', async () => {
    const origin = await makeLocalImage('prefetched.png');
    let calls = 0;
    const getImage = async () => {
      calls++;
      return ok({ file: origin, file_size: String(PNG_BYTES.length) });
    };

    const res = await resolveInboundImage({
      peer: PEER,
      isSticker: false,
      file: 'PREFETCH.png',
      fileId: 'PREFETCH.png',
      localPath: origin,
      gateway: { getImage },
      mediaManager: manager,
    });

    expect(res.ok).toBe(true);
    expect(res.via).toBe('segment_local_path');
    expect(calls).toBe(0);
    expect(res.localPath!.startsWith(path.join(tmpHome, 'downloads', 'image', PEER))).toBe(true);
    expect(Buffer.compare(fs.readFileSync(res.localPath!), PNG_BYTES)).toBe(0);
  });

  it('DC-9: 段内 local_path 不可读 → 快速失败，不调用 NapCat（消息链路不被卡住）', async () => {
    let calls = 0;
    const getImage = async () => {
      calls++;
      return ok({ file: path.join(tmpHome, 'napcat-cache', 'origin.png') });
    };

    const res = await resolveInboundImage({
      peer: PEER,
      isSticker: false,
      file: 'GONE.png',
      fileId: 'GONE.png',
      localPath: path.join(tmpHome, 'napcat-cache', 'gone.png'),
      msgId: 9005,
      gateway: { getImage, getFile: getImage as any, getMsg: getImage as any },
      mediaManager: manager,
    });

    expect(res.ok).toBe(false);
    expect(calls).toBe(0);
    expect(res.attempts.map((a) => a.via)).toEqual(['segment_local_path']);
  });

  it('DC-7: 本地字节小于段内声明尺寸 → 仍落盘但标记 sizeMismatch', async () => {
    const origin = await makeLocalImage('thumb.png');
    const getImage = async () => ok({ file: origin, file_size: String(PNG_BYTES.length) });

    const res = await resolveInboundImage({
      peer: PEER,
      isSticker: false,
      file: 'THUMBTHUMB.png',
      fileId: 'THUMBTHUMB.png',
      declaredSize: PNG_BYTES.length * 10,
      msgId: 9004,
      gateway: { getImage },
      mediaManager: manager,
    });

    expect(res.ok).toBe(true);
    expect(res.sizeMismatch).toBe(true);
  });
});
