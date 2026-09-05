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
 * 契约测试: 私聊文件入站即时落盘装配闭环 (Private File Inbound Save Assembly Contract PF-001)
 *
 * 真实装配路径验证（非 mock 桩自测）：boot 挂载插件 → 真实 WS 网关 → 模拟 NapCat 客户端：
 * - PF-装配-契约 1: 私聊入站 file 段 → 触发 get_private_file_url（首选）→ downloadAndSave 落盘成功
 *                   → 消息记录 local_path 非空（files/<peer>/ 真实文件）+ 唤醒包 content 替换为真实路径；
 * - PF-装配-契约 2: get_private_file_url 失败 → 回退 get_file → 本地路径落盘成功 → local_path 非空；
 * - PF-装配-契约 3: 双失败 → 清晰错误不占位：local_path 置空、content 如实标注「入站落盘失败」、
 *                   不抛未捕获异常（后续消息仍正常流转）；
 * - PF-装配-契约 4: 群聊 file 段不触发私聊落盘逻辑（保持 group_upload notice 懒载）。
 *
 * mock 仅隔离网络/第三方（NapCat 客户端应答、agent followup 落点），装配路径为真。
 */

const PRIVATE_QQ = '2000000001';
const BOT_QQ = '1000000001';
const GROUP_ID = 3000000001;
const WS_PORT = 18323;

describe('契约测试: 私聊文件入站即时落盘装配闭环 (PF-001)', () => {
  let tmpHome: string;
  let booted: BootedDsh;
  let client: WebSocket;
  let frames: Array<Record<string, any>> = [];
  let frameWaiters: Array<{
    action: string;
    resolve: (f: Record<string, any>) => void;
    timer: NodeJS.Timeout;
  }> = [];
  /** 私聊 agent followup 捕获（隔离第三方 LLM 管线，仅记录唤醒包文本） */
  let capturedFollowups: Array<{ content: string }> = [];

  function dbPath(): string {
    return path.join(tmpHome, 'workspace/napcat/messages.sqlite');
  }

  beforeEach(async () => {
    tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-napcat-private-file-'));
    capturedFollowups = [];
    booted = await bootDshNapcatBridge({ dshHome: tmpHome, mountPlugin: false });
    await booted.ctx.plugin(NapCatBridgePlugin, {
      bot_qq: BOT_QQ,
      ws_port: WS_PORT,
    });

    // 预注册私聊 agent 并接管 followup，捕获唤醒包文本（dispacthWakeup → formatWakeupPrompt → followup）
    const agents: any = booted.ctx.get('agents');
    const handle = await agents.create({
      sessionId: `qq-user-${PRIVATE_QQ}`,
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      meta: { cwd: path.join(tmpHome, 'agent-cwd') },
    });
    const agent = handle.agent || handle;
    agent.followup = (msg: any) => {
      const text = Array.isArray(msg?.content)
        ? msg.content.map((c: any) => c?.text || '').join('')
        : String(msg?.content || '');
      capturedFollowups.push({ content: text });
    };

    client = new WebSocket(`ws://127.0.0.1:${WS_PORT}`);
    await new Promise<void>((resolve, reject) => {
      client.once('open', () => resolve());
      client.once('error', reject);
    });
    client.on('message', (data) => {
      const frame = JSON.parse(data.toString());
      const w = frameWaiters.find((x) => x.action === frame.action);
      if (w) {
        clearTimeout(w.timer);
        frameWaiters = frameWaiters.filter((x) => x !== w);
        w.resolve(frame);
      } else {
        frames.push(frame);
      }
    });
  });

  afterEach(async () => {
    if (client) {
      client.terminate();
    }
    if (booted) {
      await booted.dispose().catch(() => {});
    }
    if (tmpHome) {
      await fsp.rm(tmpHome, { recursive: true, force: true }).catch(() => {});
    }
  });

  /** 等待下一个指定 action 的 WS 帧（3s 超时） */
  function waitForAction(action: string, timeoutMs = 3000): Promise<Record<string, any>> {
    const queuedIdx = frames.findIndex((f) => f.action === action);
    if (queuedIdx >= 0) {
      return Promise.resolve(frames.splice(queuedIdx, 1)[0]);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        frameWaiters = frameWaiters.filter((x) => x !== waiter);
        reject(new Error(`等待 action ${action} 超时 (已收到: ${JSON.stringify(frames.map((f) => f.action))})`));
      }, timeoutMs);
      const waiter = { action, resolve, timer };
      frameWaiters.push(waiter as any);
    });
  }

  /** 应答 action 请求（echo 回填 + 指定 data） */
  function respond(frame: Record<string, any>, data: any, status = 'ok') {
    client.send(JSON.stringify({ echo: frame.echo, status, retcode: status === 'ok' ? 0 : 100, data }));
  }

  /** 断言在等待窗口内没有收到指定 action（负例） */
  async function expectNoAction(action: string, waitMs = 300): Promise<void> {
    await new Promise((r) => setTimeout(r, waitMs));
    expect(frames.some((f) => f.action === action)).toBe(false);
    for (const w of frameWaiters) {
      if (w.action === action) {
        clearTimeout(w.timer);
        frameWaiters = frameWaiters.filter((x) => x !== w);
      }
    }
  }

  /** 轮询消息库中 file_id 对应记录（下载经 WS 往返 + 落盘，需等待） */
  async function waitForDbRow(fileId: string, timeoutMs = 4000): Promise<any> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const db = new Database(dbPath(), { readonly: true });
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

  /** 构造 NapCat 入站私聊消息（file 段） */
  function inboundPrivateFileMessage(
    fileId: string,
    opts: { fileName?: string; busid?: number; messageId?: number } = {}
  ) {
    return {
      post_type: 'message',
      message_type: 'private',
      sub_type: 'friend',
      message_id: opts.messageId ?? Math.floor(Math.random() * 1e6),
      user_id: PRIVATE_QQ,
      sender: { user_id: PRIVATE_QQ, nickname: '测试用户' },
      message: [
        {
          type: 'file',
          data: {
            file: opts.fileName || '测试文档.txt',
            file_id: fileId,
            file_size: '12',
            busid: opts.busid ?? 0,
          },
        },
      ],
      raw_message: '',
      time: Math.floor(Date.now() / 1000),
      self_id: BOT_QQ,
    };
  }

  /** 构造 NapCat 入站群消息（file 段，不 @ 机器人 → 不唤醒） */
  function inboundGroupFileMessage(fileId: string) {
    return {
      post_type: 'message',
      message_type: 'group',
      sub_type: 'normal',
      message_id: Math.floor(Math.random() * 1e6),
      user_id: PRIVATE_QQ,
      group_id: GROUP_ID,
      sender: { user_id: PRIVATE_QQ, nickname: '测试用户' },
      message: [
        { type: 'file', data: { file: '群文件.pdf', file_id: fileId, file_size: '99', busid: 102 } },
      ],
      raw_message: '',
      time: Math.floor(Date.now() / 1000),
      self_id: BOT_QQ,
    };
  }

  /** 本地回环 HTTP 文件服务（真实 HTTP 下载链路、零外部网络，隔离外网但不隔离本机装配路径） */
  async function startLoopbackFileServer(content: string | Buffer): Promise<{
    url: string;
    close: () => Promise<void>;
  }> {
    return new Promise((resolve, reject) => {
      const srv = http.createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        res.end(content);
      });
      srv.on('error', reject);
      srv.listen(0, '127.0.0.1', () => {
        const addr = srv.address() as any;
        resolve({
          url: `http://127.0.0.1:${addr.port}/file.bin`,
          close: () =>
            new Promise<void>((r) => {
              srv.close(() => r());
            }),
        });
      });
    });
  }

  it('PF-装配-契约 1: 私聊入站 file 段 → get_private_file_url 首选 → 落盘成功 → 消息记录 local_path 非空 + 唤醒包给真实路径', async () => {
    // 直链应答为本地回环 HTTP 服务（真实 HTTP 下载、零外网；下载逻辑走 mediaManager 真实落盘）
    const fileSrv = await startLoopbackFileServer('hello private file');
    try {
      client.send(JSON.stringify(inboundPrivateFileMessage('pf-assembly-1', { fileName: '演示文件.txt' })));

      // 首选 action：get_private_file_url，参数契约 {file_id}
      const urlFrame = await waitForAction('get_private_file_url');
      expect(urlFrame.params).toEqual({ file_id: 'pf-assembly-1' });
      respond(urlFrame, { url: fileSrv.url });

      const row = await waitForDbRow('pf-assembly-1');
      // 消息记录 local_path 非空 + 真实文件存在于 files/<peer>/
      expect(row.type).toBe('file');
      expect(row.local_path).toBeTruthy();
      expect(row.local_path).toContain(path.join('files', `user_${PRIVATE_QQ}`));
      expect(fs.existsSync(row.local_path)).toBe(true);
      expect(fs.readFileSync(row.local_path, 'utf8')).toBe('hello private file');
      // content 占位被替换为真实路径（与图片 atomic 约定统一）
      expect(row.content).toContain(`[文件:演示文件.txt 已保存: ${row.local_path}]`);
      // 唤醒包 content 同样为真实路径（captured followup 文本）
      expect(capturedFollowups.length).toBeGreaterThan(0);
      expect(capturedFollowups[0].content).toContain('已保存');
      expect(capturedFollowups[0].content).toContain(row.local_path);
    } finally {
      await fileSrv.close().catch(() => {});
    }
  });

  it('PF-装配-契约 2: get_private_file_url 失败 → 回退 get_file → 本地路径落盘成功 → local_path 非空', async () => {
    const srcDir = path.join(tmpHome, 'src');
    await fsp.mkdir(srcDir, { recursive: true });
    const srcFile = path.join(srcDir, 'fallback.pdf');
    await fsp.writeFile(srcFile, '%PDF-fallback');

    client.send(JSON.stringify(inboundPrivateFileMessage('pf-assembly-2', { fileName: '回退文档.pdf' })));

    // 首选失败（packet 后端不可用场景）
    const urlFrame = await waitForAction('get_private_file_url');
    respond(urlFrame, { url: '' }, 'failed');

    // 回退 get_file：NapCat 返回本地路径（Linux/WSL 直落形态，本测试环境可读）
    const fileFrame = await waitForAction('get_file');
    expect(fileFrame.params).toEqual({ file_id: 'pf-assembly-2' });
    respond(fileFrame, { file: srcFile, url: srcFile, file_size: '13', file_name: '回退文档.pdf' });

    const row = await waitForDbRow('pf-assembly-2');
    expect(row.type).toBe('file');
    expect(row.local_path).toBeTruthy();
    expect(fs.existsSync(row.local_path)).toBe(true);
    expect(fs.readFileSync(row.local_path, 'utf8')).toBe('%PDF-fallback');
    // 文件名沿用段内名（basename 规整后）
    expect(row.local_path).toContain('回退文档.pdf');
    expect(row.content).toContain(`[文件:回退文档.pdf 已保存: ${row.local_path}]`);
  });

  it('PF-装配-契约 3: 双失败 → local_path 置空 + content 如实标注入站落盘失败 + 不抛未捕获异常（后续消息正常流转）', async () => {
    client.send(JSON.stringify(inboundPrivateFileMessage('pf-assembly-3')));

    const urlFrame = await waitForAction('get_private_file_url');
    respond(urlFrame, {}, 'failed');
    const fileFrame = await waitForAction('get_file');
    respond(fileFrame, {}, 'failed');

    const row = await waitForDbRow('pf-assembly-3');
    // 消息照常入库，但 local_path 置空，绝不返回占位假路径
    expect(row.type).toBe('file');
    expect(row.local_path).toBeNull();
    expect(row.content).toContain('(入站落盘失败)');

    // 不抛未捕获异常：同一 WS 连接继续处理后续私聊消息（唤醒流仍可达）
    const before = capturedFollowups.length;
    client.send(
      JSON.stringify({
        post_type: 'message',
        message_type: 'private',
        sub_type: 'friend',
        message_id: Math.floor(Math.random() * 1e6),
        user_id: PRIVATE_QQ,
        sender: { user_id: PRIVATE_QQ, nickname: '测试用户' },
        message: [{ type: 'text', data: { text: '还在吗' } }],
        raw_message: '还在吗',
        time: Math.floor(Date.now() / 1000),
        self_id: BOT_QQ,
      })
    );
    await new Promise((r) => setTimeout(r, 800));
    expect(capturedFollowups.length).toBeGreaterThan(before);
    expect(capturedFollowups[capturedFollowups.length - 1].content).toContain('还在吗');
  });

  it('PF-装配-契约 4: 群聊 file 段不触发私聊落盘逻辑（保持 group_upload notice 懒载）', async () => {
    client.send(JSON.stringify(inboundGroupFileMessage('pf-group-file-1')));

    await expectNoAction('get_private_file_url');
    await expectNoAction('get_file');

    const row = await waitForDbRow('pf-group-file-1');
    expect(row.type).toBe('group_file');
    expect(row.local_path).toBeNull();
    // 群文件 content 保持原占位（懒载语义，不经入站落盘）
    expect(row.content).toContain('[群文件:群文件.pdf');
  });

  it('装配-契约 5: 完全为空的消息（如文件下载回执）入站时不落盘且不唤醒 Agent', async () => {
    const beforeFollowups = capturedFollowups.length;
    const emptyMsgId = 999001;

    client.send(
      JSON.stringify({
        post_type: 'message',
        message_type: 'private',
        sub_type: 'friend',
        message_id: emptyMsgId,
        user_id: PRIVATE_QQ,
        sender: { user_id: PRIVATE_QQ, nickname: '测试用户' },
        message: [],
        raw_message: '',
        time: Math.floor(Date.now() / 1000),
        self_id: BOT_QQ,
      })
    );

    // 等待 500ms 确认消息未入库、未唤醒
    await new Promise((r) => setTimeout(r, 500));

    const db = new Database(dbPath(), { readonly: true });
    try {
      const row = db.prepare('SELECT * FROM messages WHERE msg_id = ?').get(emptyMsgId);
      expect(row).toBeUndefined();
    } finally {
      db.close();
    }

    expect(capturedFollowups.length).toBe(beforeFollowups);
  });

  it('装配-契约 6: 纯空格消息含有字符，正常入库落盘并正常唤醒 Agent', async () => {
    const beforeFollowups = capturedFollowups.length;
    const spaceMsgId = 999002;

    client.send(
      JSON.stringify({
        post_type: 'message',
        message_type: 'private',
        sub_type: 'friend',
        message_id: spaceMsgId,
        user_id: PRIVATE_QQ,
        sender: { user_id: PRIVATE_QQ, nickname: '测试用户' },
        message: [{ type: 'text', data: { text: '   ' } }],
        raw_message: '   ',
        time: Math.floor(Date.now() / 1000),
        self_id: BOT_QQ,
      })
    );

    // 等待消息入库并唤醒
    await new Promise((r) => setTimeout(r, 600));

    const db = new Database(dbPath(), { readonly: true });
    try {
      const row: any = db.prepare('SELECT * FROM messages WHERE msg_id = ?').get(spaceMsgId);
      expect(row).toBeDefined();
      expect(row.content).toBe('   ');
    } finally {
      db.close();
    }

    expect(capturedFollowups.length).toBeGreaterThan(beforeFollowups);
    expect(capturedFollowups[capturedFollowups.length - 1].content).toContain('   ');
  });
});