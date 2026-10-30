import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import * as http from 'node:http';
import Database from 'better-sqlite3';
import WebSocket from 'ws';
import { bootDshNapcatBridge, type BootedDsh } from '../../src/boot.js';
import * as NapCatBridgePlugin from '../../src/index.js';

/**
 * 契约测试: 入站图片落盘真实装配闭环 (Inbound Image Assembly)
 *
 * 真实装配路径（非 mock 桩自测）：boot 挂载插件 → 真实 WS 网关 → 模拟 NapCat 客户端 →
 * 真实入站 message 事件 → 真实 resolver → 真实文件复制 → 真实 SQLite 入库。
 * mock 仅隔离 NapCat 应答与网络（外部依赖）。
 *
 * ASM-1: 直链不可用（死端口）→ get_image 返回 NapCat 本地路径 → 消息 local_path 指向
 *        我们自己的 downloads/<type>/<peer>/，content 替换为真实路径（不再只剩图名）。
 * ASM-2: 四段全失败 → 保持基线：local_path 为空、content 仍为 [图片:<QQ 伪名>]、消息照常入库。
 */

const BOT_QQ = '1000000001';
const GROUP_ID = '3000000001';
const MEMBER_QQ = '2000000001';
const WS_PORT = 18345;
const PNG_BYTES = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 3)]);

describe('契约测试: 入站图片落盘真实装配闭环 (Inbound Image Assembly)', () => {
  let tmpHome: string;
  let booted: BootedDsh;
  let client: WebSocket;
  let servers: http.Server[] = [];
  let actions: string[] = [];
  let reply: (action: string, frame: any) => any = () => null;

  function inboundImageMessage(fileName: string, url: string | undefined, messageId: number) {
    const data: Record<string, any> = { file: fileName, sub_type: 0, file_size: String(PNG_BYTES.length) };
    if (url) data.url = url;
    return {
      post_type: 'message',
      message_type: 'group',
      sub_type: 'normal',
      message_id: messageId,
      user_id: MEMBER_QQ,
      group_id: GROUP_ID,
      sender: { user_id: MEMBER_QQ, nickname: '测试成员' },
      message: [{ type: 'image', data }],
      raw_message: '',
      time: Math.floor(Date.now() / 1000),
      self_id: BOT_QQ,
    };
  }

  async function startLoopback(status: number, body: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const srv = http.createServer((_req, res) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(body);
      });
      srv.on('error', reject);
      servers.push(srv);
      srv.listen(0, '127.0.0.1', () => {
        resolve(`http://127.0.0.1:${(srv.address() as any).port}/image`);
      });
    });
  }

  async function waitForRow(fileId: string, timeoutMs = 5000): Promise<any> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const db = new Database(path.join(tmpHome, 'napcat', 'messages.sqlite'), { readonly: true });
      try {
        const row = db.prepare('SELECT * FROM messages WHERE file_id = ?').get(fileId);
        if (row) return row;
      } finally {
        db.close();
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`等待消息记录超时 (file_id: ${fileId})`);
  }

  beforeEach(async () => {
    tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-napcat-inbound-assembly-'));
    actions = [];
    servers = [];
    booted = await bootDshNapcatBridge({ dshHome: tmpHome, mountPlugin: false });
    await booted.ctx.plugin(NapCatBridgePlugin, { bot_qq: BOT_QQ, ws_port: WS_PORT });

    client = new WebSocket(`ws://127.0.0.1:${WS_PORT}`);
    await new Promise<void>((resolve, reject) => {
      client.once('open', () => resolve());
      client.once('error', reject);
    });
    client.on('message', (data) => {
      const frame = JSON.parse(data.toString());
      const action = String(frame.action || '');
      actions.push(action);
      const payload = reply(action, frame);
      client.send(JSON.stringify({ echo: frame.echo, retcode: payload?.status === 'ok' ? 0 : 1404, ...payload }));
    });
  });

  afterEach(async () => {
    if (client) client.terminate();
    for (const s of servers) await new Promise<void>((r) => s.close(() => r())).catch(() => {});
    if (booted) await booted.dispose().catch(() => {});
    if (tmpHome) await fsp.rm(tmpHome, { recursive: true, force: true }).catch(() => {});
  });

  it('ASM-1: get_image 本地路径 → local_path 落在 downloads/ 且 content 不再是裸图名', async () => {
    const cached = path.join(tmpHome, 'qq-cache', 'origin.png');
    await fsp.mkdir(path.dirname(cached), { recursive: true });
    await fsp.writeFile(cached, PNG_BYTES);

    reply = (action) => {
      if (action === 'get_image') {
        return { status: 'ok', data: { file: cached, file_size: String(PNG_BYTES.length), file_name: 'origin.png' } };
      }
      return { status: 'failed', data: null, wording: 'unexpected action' };
    };
    // 死端口直链：万一退化回「直链优先」会立刻连接失败，不会误判本用例通过
    // eslint-disable-next-line
    const deadUrl = 'http://127.0.0.1:1/x.png';
    client.send(JSON.stringify(inboundImageMessage('972D03EAEE2FCEAAB0C6378255A2F6BD.png', deadUrl, 61001)));

    const row = await waitForRow('972D03EAEE2FCEAAB0C6378255A2F6BD.png');
    expect(row.local_path).toBeTruthy();
    expect(String(row.local_path).startsWith(path.join(tmpHome, 'napcat', 'downloads', 'image', `group_${GROUP_ID}`))).toBe(true);
    expect(fs.existsSync(row.local_path)).toBe(true);
    expect(Buffer.compare(fs.readFileSync(row.local_path), PNG_BYTES)).toBe(0);
    expect(String(row.content)).toContain('downloads');
    expect(String(row.content)).not.toBe('[图片:972D03EAEE2FCEAAB0C6378255A2F6BD.png]');
    expect(actions).toContain('get_image');
  });

  it('ASM-2: 四段全失败 → 保持基线（local_path 为空、content 为裸图名、消息照常入库）', async () => {
    const deadUrl = await startLoopback(400, '{"retcode":-5503007,"retmsg":"download url has expired"}');
    reply = () => ({ status: 'failed', data: null, wording: 'not available' });

    client.send(JSON.stringify(inboundImageMessage('0123456789ABCDEF0123456789ABCDEF.png', deadUrl, 61002)));

    const row = await waitForRow('0123456789ABCDEF0123456789ABCDEF.png');
    expect(row.local_path).toBeNull();
    expect(row.content).toBe('[图片:0123456789ABCDEF0123456789ABCDEF.png]');
    expect(actions).toEqual(expect.arrayContaining(['get_image', 'get_file', 'get_msg']));
  });
});
