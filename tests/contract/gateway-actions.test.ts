import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import WebSocket from 'ws';
import { NapCatGatewayServer } from '../../src/gateway/server.js';

/**
 * 契约测试: NapCat 网关 Action 接入点 (Gateway Actions Contract)
 * - IS-S3: upload_group_file / upload_private_file v2 预留接入点（发送动作与参数契约）
 * - EN-001: get_group_member_info 动作参数契约（被@者昵称获取）
 * - IS-F1: get_group_file_url 动作参数契约 {group_id, file_id, busid}
 * - PF-001: get_private_file_url / get_file 动作参数契约（私聊文件入站落盘两级退化用，
 *           参数契约已按 NapCat 源码 GetPrivateFileUrl.ts {file_id} / GetFile.ts {file_id} 实证）
 *
 * 通过真实 WS server + 模拟 NapCat 客户端应答 echo，验证 action 请求面（非自造桩）。
 */

function noopLogger(): any {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  };
}

describe('契约测试: Gateway Action 接入点 (v2 预留 + 成员信息)', () => {
  let server: NapCatGatewayServer;
  let client: WebSocket;
  let received: Array<Record<string, any>> = [];

  beforeEach(async () => {
    received = [];
    server = new NapCatGatewayServer({ port: 0, logger: noopLogger() });
    await server.start();
    const addr: any = (server as any).wss.address();
    client = new WebSocket(`ws://127.0.0.1:${addr.port}`);
    await new Promise<void>((resolve, reject) => {
      client.once('open', () => resolve());
      client.once('error', reject);
    });
    client.on('message', (data) => {
      received.push(JSON.parse(data.toString()));
    });
  });

  afterEach(async () => {
    if (client) {
      client.terminate();
    }
    await server.stop().catch(() => {});
  });

  /** 模拟 NapCat 对 action 的应答（echo 回显即被网关 pending 表认领） */
  async function respondTo(action: string): Promise<Record<string, any>> {
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    const pending = received.find((r) => r.action === action);
    if (!pending) throw new Error(`未收到 action: ${action}, received=${JSON.stringify(received)}`);
    client.send(JSON.stringify({ echo: pending.echo, status: 'ok', retcode: 0, data: {} }));
    return pending;
  }

  it('IS-S3-契约 1: upload_group_file v2 预留接入点 — action 名与参数契约', async () => {
    const pendingAction = server.uploadGroupFile(3000000001, 'C:\\napcat_share\\report.pdf', 'report.pdf', '/v2');
    const sent = await respondTo('upload_group_file');
    const res = await pendingAction;
    expect(sent.action).toBe('upload_group_file');
    expect(sent.params).toMatchObject({
      group_id: 3000000001,
      file: 'C:\\napcat_share\\report.pdf',
      name: 'report.pdf',
      folder: '/v2',
    });
    expect(res.status).toBe('ok');
  });

  it('IS-S3-契约 2: upload_private_file v2 预留接入点 — action 名与参数契约', async () => {
    const pendingAction = server.uploadPrivateFile(2000000001, 'base64://aGVsbG8=', 'note.txt');
    const sent = await respondTo('upload_private_file');
    const res = await pendingAction;
    expect(sent.action).toBe('upload_private_file');
    expect(sent.params).toMatchObject({
      user_id: 2000000001,
      file: 'base64://aGVsbG8=',
      name: 'note.txt',
    });
    expect(res.status).toBe('ok');
  });

  it('EN-001-契约 12: get_group_member_info 动作参数契约 {group_id, user_id}', async () => {
    const pendingAction = server.getGroupMemberInfo(3000000001, '2000000001');
    const sent = await respondTo('get_group_member_info');
    const res = await pendingAction;
    expect(sent.action).toBe('get_group_member_info');
    expect(sent.params).toMatchObject({ group_id: 3000000001, user_id: 2000000001 });
    expect(res.status).toBe('ok');
  });

  it('IS-F1-契约 8: get_group_file_url 动作参数契约 {group_id, file_id, busid}', async () => {
    const pendingAction = server.getGroupFileUrl(3000000001, '/36315f46-af2a-490d-959c-4f37937d0095', 102);
    const sent = await respondTo('get_group_file_url');
    const res = await pendingAction;
    expect(sent.action).toBe('get_group_file_url');
    expect(sent.params).toMatchObject({
      group_id: 3000000001,
      file_id: '/36315f46-af2a-490d-959c-4f37937d0095',
      busid: 102,
    });
    expect(res.status).toBe('ok');
  });

  it('PF-001-契约 G1: get_private_file_url 动作参数契约 {file_id}（首选直链）', async () => {
    const pendingAction = server.getPrivateFileUrl('N_private_file_001');
    const sent = await respondTo('get_private_file_url');
    const res = await pendingAction;
    expect(sent.action).toBe('get_private_file_url');
    // NapCat GetPrivateFileUrl.ts PayloadSchema 实证: 仅 {file_id}
    expect(sent.params).toMatchObject({ file_id: 'N_private_file_001' });
    expect(res.status).toBe('ok');
  });

  it('PF-001-契约 G2: get_file 动作参数契约 {file_id}（退化路径）', async () => {
    const pendingAction = server.getFile('N_private_file_001');
    const sent = await respondTo('get_file');
    const res = await pendingAction;
    expect(sent.action).toBe('get_file');
    // NapCat GetFile.ts GetFilePayloadSchema 实证: {file?, file_id?}，私聊消息标记以 file_id 传入
    expect(sent.params).toMatchObject({ file_id: 'N_private_file_001' });
    expect(res.status).toBe('ok');
  });
});