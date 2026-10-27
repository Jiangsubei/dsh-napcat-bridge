import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fsp } from 'node:fs';
import WebSocket from 'ws';
import { bootDshNapcatBridge, type BootedDsh } from '../../src/boot.js';
import { MessageDatabase } from '../../src/storage/database.js';

describe('契约测试: 离线消息补全端到端装配与闭环验证 (Offline Sync Assembly Contract)', () => {
  let tmpHome: string;
  let booted: BootedDsh;
  let client: WebSocket | null = null;
  const testPort = 28091;

  beforeEach(async () => {
    tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-napcat-sync-assembly-'));
    booted = await bootDshNapcatBridge({
      dshHome: tmpHome,
      config: {
        bot_qq: '1000000000',
        ws_port: testPort,
      },
    });
  });

  afterEach(async () => {
    if (client) {
      client.terminate();
      client = null;
    }
    if (booted) {
      await booted.dispose().catch(() => {});
    }
    if (tmpHome) {
      await fsp.rm(tmpHome, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('装配契约: 模拟 NapCat 建立 WS 连接后，自动触发增量离线同步并成功将历史消息写入 SQLite 数据库', async () => {
    const receivedActions: Array<{ action: string; echo: string; params: any }> = [];

    // 建立模拟 NapCat 客户端连接
    client = new WebSocket(`ws://127.0.0.1:${testPort}`);

    await new Promise<void>((resolve, reject) => {
      client!.once('open', () => resolve());
      client!.once('error', reject);
    });

    // 监听来自网关的 Action 请求并模拟 NapCat 回复
    client.on('message', (data) => {
      const parsed = JSON.parse(data.toString());
      if (parsed.action) {
        receivedActions.push(parsed);

        if (parsed.action === 'get_recent_contact') {
          // 模拟返回最近联系人（包含离线群聊）
          client!.send(
            JSON.stringify({
              echo: parsed.echo,
              status: 'ok',
              retcode: 0,
              data: [
                {
                  peerUin: '8000000002',
                  chatType: 2,
                  msgTime: '1793072657',
                  peerName: '测试群',
                },
              ],
            })
          );
        } else if (parsed.action === 'get_group_msg_history') {
          // 模拟返回群历史消息
          client!.send(
            JSON.stringify({
              echo: parsed.echo,
              status: 'ok',
              retcode: 0,
              data: {
                messages: [
                  {
                    message_id: 888123,
                    group_id: 8000000002,
                    user_id: 1000000004,
                    time: 1793072657,
                    message_type: 'group',
                    sender: {
                      user_id: 1000000004,
                      nickname: '小影',
                      card: '群友小影',
                    },
                    raw_message: '插件离线期间发出的历史消息',
                    message: [
                      {
                        type: 'text',
                        data: { text: '插件离线期间发出的历史消息' },
                      },
                    ],
                  },
                ],
              },
            })
          );
        }
      }
    });

    // 等待自动同步触发与完成（连接后有 500ms 延时保护）
    await new Promise((resolve) => setTimeout(resolve, 1200));

    // 验证 Action 交互链路闭环
    const recentAction = receivedActions.find((a) => a.action === 'get_recent_contact');
    expect(recentAction).toBeDefined();

    const historyAction = receivedActions.find((a) => a.action === 'get_group_msg_history');
    expect(historyAction).toBeDefined();
    expect(historyAction?.params).toMatchObject({
      group_id: 8000000002,
    });

    // 验证消息已真实入库到装配的 SQLite 数据库
    const dbPath = path.join(tmpHome, 'napcat/messages.sqlite');
    const db = new MessageDatabase(dbPath);
    db.init();
    try {
      expect(db.hasMessage(888123)).toBe(true);
      const record = db.getMessage(888123);
      expect(record?.peer).toBe('group_8000000002');
      expect(record?.sender_name).toBe('群友小影');
      expect(record?.content).toBe('插件离线期间发出的历史消息');
      expect(record?.time).toBe(1793072657000);
    } finally {
      db.close();
    }
  });
});
