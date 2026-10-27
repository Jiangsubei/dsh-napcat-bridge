import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fsp } from 'node:fs';
import { MessageDatabase } from '../../src/storage/database.js';
import { OfflineMessageSyncer } from '../../src/gateway/sync.js';
import type { MessageRecord } from '../../src/types/index.js';

describe('契约测试: 离线消息同步与去重引擎 (OfflineMessageSyncer Contract)', () => {
  let tmpDir: string;
  let db: MessageDatabase;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-napcat-sync-engine-'));
    const dbFile = path.join(tmpDir, 'test_messages.sqlite');
    db = new MessageDatabase(dbFile);
    db.init();
  });

  afterEach(async () => {
    if (db) db.close();
    if (tmpDir) {
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('契约 1: 增量比对 — 若远端联系人最新时间 <= 本地最新时间，跳过不调用历史 API', async () => {
    // 本地群已有一条最新消息，时间 1700000050000 (秒级 1700000050)
    db.saveMessage({
      msg_id: 100,
      peer: 'group_8000000002',
      user_id: '100',
      sender_name: '测试员',
      time: 1700000050000,
      type: 'text',
      content: '已有最新消息',
      raw: '{}',
      file_id: null,
      busid: null,
      local_path: null,
      fingerprint: null,
      recalled: 0,
      self: 0,
      reply_to: null,
    });

    const mockGateway: any = {
      getRecentContact: vi.fn().mockResolvedValue({
        status: 'ok',
        data: [
          {
            peerUin: '8000000002',
            chatType: 2, // 群聊
            msgTime: '1700000050', // 与本地时间相同
            peerName: '群名称',
          },
        ],
      }),
      getGroupMsgHistory: vi.fn(),
      getFriendMsgHistory: vi.fn(),
    };

    const syncer = new OfflineMessageSyncer({
      gateway: mockGateway,
      db,
    });

    const res = await syncer.sync();
    expect(res.peersChecked).toBe(1);
    expect(res.peersSynced).toBe(0);
    expect(res.messagesInserted).toBe(0);
    expect(mockGateway.getGroupMsgHistory).not.toHaveBeenCalled();
  });

  it('契约 2: 离线补全 — 对有增量变动的会话拉取历史，正确解析并安全入库', async () => {
    // 本地群最后一条消息为 1700000000000 (秒级 1700000000)
    db.saveMessage({
      msg_id: 100,
      peer: 'group_8000000002',
      user_id: '100',
      sender_name: '测试员',
      time: 1700000000000,
      type: 'text',
      content: '旧消息',
      raw: '{}',
      file_id: null,
      busid: null,
      local_path: null,
      fingerprint: null,
      recalled: 0,
      self: 0,
      reply_to: null,
    });

    const mockGateway: any = {
      getRecentContact: vi.fn().mockResolvedValue({
        status: 'ok',
        data: [
          {
            peerUin: '8000000002',
            chatType: 2, // 群聊
            msgTime: '1700000080', // 远端有最新消息
            peerName: '群名称',
          },
        ],
      }),
      getGroupMsgHistory: vi.fn().mockResolvedValue({
        status: 'ok',
        data: {
          messages: [
            // 离线新消息 1
            {
              message_id: 101,
              group_id: 8000000002,
              user_id: 200,
              time: 1700000020,
              message_type: 'group',
              sender: { user_id: 200, nickname: '新用户A', card: '名片A' },
              raw_message: '离线消息1',
              message: [{ type: 'text', data: { text: '离线消息1' } }],
            },
            // 离线新消息 2
            {
              message_id: 102,
              group_id: 8000000002,
              user_id: 201,
              time: 1700000080,
              message_type: 'group',
              sender: { user_id: 201, nickname: '新用户B' },
              raw_message: '离线消息2',
              message: [{ type: 'text', data: { text: '离线消息2' } }],
            },
            // 本地已有旧消息（触碰历史边界）
            {
              message_id: 100,
              group_id: 8000000002,
              user_id: 100,
              time: 1700000000,
              message_type: 'group',
              sender: { user_id: 100, nickname: '测试员' },
              raw_message: '旧消息',
              message: [{ type: 'text', data: { text: '旧消息' } }],
            },
          ],
        },
      }),
      getFriendMsgHistory: vi.fn(),
    };

    const syncer = new OfflineMessageSyncer({
      gateway: mockGateway,
      db,
    });

    const res = await syncer.sync();
    expect(res.peersChecked).toBe(1);
    expect(res.peersSynced).toBe(1);
    expect(res.messagesInserted).toBe(2); // 仅 101 和 102 两条新消息入库

    expect(db.hasMessage(101)).toBe(true);
    expect(db.hasMessage(102)).toBe(true);
    const m101 = db.getMessage(101);
    expect(m101?.content).toBe('离线消息1');
    expect(m101?.sender_name).toBe('名片A');
    expect(m101?.time).toBe(1700000020000);
  });

  it('契约 3: 去重与防覆盖保护 — 离线重复消息绝不冲刷本地已有的 local_path', async () => {
    // 本地库中已有记录 200，带有 local_path
    db.saveMessage({
      msg_id: 200,
      peer: 'user_3001',
      user_id: '3001',
      sender_name: '好友A',
      time: 1700000010000,
      type: 'image',
      content: '[图片:/path/img.png]',
      raw: '{}',
      file_id: 'img.png',
      busid: null,
      local_path: '/path/img.png',
      fingerprint: 'sha_existing',
      recalled: 0,
      self: 0,
      reply_to: null,
    });

    const mockGateway: any = {
      getRecentContact: vi.fn().mockResolvedValue({
        status: 'ok',
        data: [
          {
            peerUin: '3001',
            chatType: 1, // 好友
            msgTime: '1700000010',
          },
        ],
      }),
      getGroupMsgHistory: vi.fn(),
      getFriendMsgHistory: vi.fn().mockResolvedValue({
        status: 'ok',
        data: {
          messages: [
            {
              message_id: 200,
              user_id: 3001,
              time: 1700000010,
              message_type: 'private',
              sender: { user_id: 3001, nickname: '好友A' },
              raw_message: '[图片]',
              message: [{ type: 'image', data: { file: 'img.png' } }],
            },
          ],
        },
      }),
    };

    const syncer = new OfflineMessageSyncer({
      gateway: mockGateway,
      db,
    });

    await syncer.sync();
    const fetched = db.getMessage(200);
    expect(fetched?.local_path).toBe('/path/img.png');
    expect(fetched?.fingerprint).toBe('sha_existing');
  });

  it('契约 4: 并发互斥锁 — 多次触发 sync() 时第二次直接跳过', async () => {
    let finishFirstCall: () => void;
    const firstCallPromise = new Promise<any>((resolve) => {
      finishFirstCall = () => resolve({ status: 'ok', data: [] });
    });

    const mockGateway: any = {
      getRecentContact: vi.fn().mockImplementation(() => firstCallPromise),
      getGroupMsgHistory: vi.fn(),
      getFriendMsgHistory: vi.fn(),
    };

    const syncer = new OfflineMessageSyncer({
      gateway: mockGateway,
      db,
    });

    const p1 = syncer.sync();
    const p2 = syncer.sync(); // 并发触发

    finishFirstCall!();
    const [res1, res2] = await Promise.all([p1, p2]);

    expect(res2.peersChecked).toBe(0);
    expect(mockGateway.getRecentContact).toHaveBeenCalledTimes(1);
  });

  it('契约 5: 异常容错 — 单个好友拉取抛错时记录错误且不中断后续联系人同步', async () => {
    const mockGateway: any = {
      getRecentContact: vi.fn().mockResolvedValue({
        status: 'ok',
        data: [
          { peerUin: '4001', chatType: 1, msgTime: '1700000099' },
          { peerUin: '4002', chatType: 1, msgTime: '1700000099' },
        ],
      }),
      getGroupMsgHistory: vi.fn(),
      getFriendMsgHistory: vi.fn()
        .mockRejectedValueOnce(new Error('好友消息不存在'))
        .mockResolvedValueOnce({
          status: 'ok',
          data: {
            messages: [
              {
                message_id: 888,
                user_id: 4002,
                time: 1700000099,
                message_type: 'private',
                sender: { user_id: 4002, nickname: '用户4002' },
                raw_message: '正常入库',
                message: [{ type: 'text', data: { text: '正常入库' } }],
              },
            ],
          },
        }),
    };

    const syncer = new OfflineMessageSyncer({
      gateway: mockGateway,
      db,
    });

    const res = await syncer.sync();
    expect(res.peersChecked).toBe(2);
    expect(res.errors.length).toBe(1);
    expect(res.errors[0].peer).toBe('user_4001');
    expect(res.messagesInserted).toBe(1);
    expect(db.hasMessage(888)).toBe(true);
  });
});
