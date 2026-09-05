import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import { fetchChatResource, pokeUser, expandForwardMessage } from '../../src/tools/index.js';

/**
 * 契约测试: 群文件下载链路 (IS-F1/IS-F2)
 *
 * 测试引用 src 真实模块，不造桩自测：
 * - IS-F1: 群文件判定依据上下文 peer/groupId（不再按 file_id 字符串猜）+ 真实下载路径 + 失败分级报错
 * - IS-F2: 群文件下载落盘带 sessionId (files/<peer>/)
 */

const GROUP_PEER = 'group_3000000001';
const REAL_UUID_FILE_ID = '/36315f46-af2a-490d-959c-4f37937d0095';

function stubGateway(overrides: Record<string, any> = {}) {
  const calls: Array<Record<string, any>> = [];
  const gateway = {
    getGroupFileUrl: async (groupId: any, fileId: any, busid: any) => {
      calls.push({ action: 'getGroupFileUrl', groupId, fileId, busid });
      return { status: 'ok', retcode: 0, data: { url: 'https://example.com/dl/test.txt' } };
    },
    ...overrides,
  };
  return { gateway, calls };
}

function stubMedia() {
  const mediaCalls: Array<Record<string, any>> = [];
  const mediaManager = {
    downloadAndSave: async (url: string, opts: any) => {
      mediaCalls.push({ url, opts });
      return {
        localPath: `/tmp/downloads/files/${opts?.sessionId || 'common'}/test.txt`,
        fingerprint: 'fp-123',
        deduplicated: false,
      };
    },
  };
  return { mediaManager, mediaCalls };
}

describe('契约测试: 群文件下载链路 (Group File Download Contract IS-F1/IS-F2)', () => {
  it('IS-F1-契约 1: group_ peer + 真 UUID file_id + busid 必须走真实下载路径（非按 file_id 字符串判定）', async () => {
    const { gateway, calls } = stubGateway();
    const { mediaManager } = stubMedia();

    const res = await fetchChatResource(
      { file_id: REAL_UUID_FILE_ID, busid: 102, file_name: 'test.txt' },
      { peer: GROUP_PEER, groupId: 3000000001, gateway, mediaManager }
    );

    expect(res.success).toBe(true);
    expect(res.local_path).toBeDefined();
    // get_group_file_url 参数契约: {group_id, file_id, busid}
    expect(calls).toHaveLength(1);
    expect(calls[0].action).toBe('getGroupFileUrl');
    expect(calls[0].groupId).toBe(3000000001);
    expect(calls[0].fileId).toBe(REAL_UUID_FILE_ID);
    expect(calls[0].busid).toBe(102);
  });

  it('IS-F2-契约 2: 群文件下载落盘必须携带 sessionId=peer，落 files/<peer>/ 而非 common', async () => {
    const { gateway } = stubGateway();
    const { mediaManager, mediaCalls } = stubMedia();

    await fetchChatResource(
      { file_id: REAL_UUID_FILE_ID, busid: 102, file_name: 'test.txt' },
      { peer: GROUP_PEER, groupId: 3000000001, gateway, mediaManager }
    );

    expect(mediaCalls).toHaveLength(1);
    expect(mediaCalls[0].url).toBe('https://example.com/dl/test.txt');
    expect(mediaCalls[0].opts.sessionId).toBe(GROUP_PEER);
    expect(mediaCalls[0].opts.type).toBe('files');
    expect(mediaCalls[0].opts.fileId).toBe(REAL_UUID_FILE_ID);
  });

  it('IS-F1-契约 3: 群上下文缺少 busid 返回清晰错误（不猜测、不落占位）', async () => {
    const res = await fetchChatResource(
      { file_id: REAL_UUID_FILE_ID },
      { peer: GROUP_PEER, groupId: 3000000001 }
    );
    expect(res.success).toBe(false);
    expect(res.error).toContain('busid');
  });

  it('IS-F1-契约 4: 群上下文 + 无 gateway 返回 success:false 与具体错误（NapCat 未连接）', async () => {
    const res = await fetchChatResource(
      { file_id: REAL_UUID_FILE_ID, busid: 102 },
      { peer: GROUP_PEER, groupId: 3000000001 }
    );
    expect(res.success).toBe(false);
    expect(res.error).toContain('NapCat 未连接');
    expect(res.local_path).toBeUndefined();
  });

  it('IS-F1-契约 5: gateway 未返回下载 URL 时报错并透传 NapCat wording', async () => {
    const { gateway } = stubGateway({
      getGroupFileUrl: async () => ({
        status: 'failed',
        retcode: 100,
        data: {},
        wording: '文件不存在或已被删除',
      }),
    });
    const { mediaManager } = stubMedia();

    const res = await fetchChatResource(
      { file_id: REAL_UUID_FILE_ID, busid: 102 },
      { peer: GROUP_PEER, groupId: 3000000001, gateway, mediaManager }
    );

    expect(res.success).toBe(false);
    expect(res.error).toContain('下载失败');
    expect(res.error).toContain('文件不存在或已被删除');
  });

  it('IS-F1-契约 6: HTTP 下载抛错时返回下载失败而非笼统"资源不存在"', async () => {
    const { gateway } = stubGateway({
      getGroupFileUrl: async () => ({ status: 'ok', retcode: 0, data: { url: 'https://example.com/dl/x.txt' } }),
    });
    const { mediaManager } = stubMedia();
    mediaManager.downloadAndSave = async () => {
      throw new Error('HTTP 下载失败 (status: 404)');
    };

    const res = await fetchChatResource(
      { file_id: REAL_UUID_FILE_ID, busid: 102 },
      { peer: GROUP_PEER, groupId: 3000000001, gateway, mediaManager }
    );

    expect(res.success).toBe(false);
    expect(res.error).toContain('HTTP 下载失败 (status: 404)');
  });

  it('IS-F1-契约 7: 私聊(user_)上下文不按群文件处理；无 gateway 报 NapCat 未连接', async () => {
    const res = await fetchChatResource(
      { file_id: REAL_UUID_FILE_ID, busid: 102 },
      { peer: 'user_2000000001' }
    );
    expect(res.success).toBe(false);
    expect(res.error).toContain('NapCat 未连接');
  });

  it('一级去重: db 已有 local_path 且文件存在时直接复用', async () => {
    const file = `/tmp/dsh-napcat-dedup-${Date.now()}.txt`;
    fs.writeFileSync(file, 'x');
    try {
      const db = {
        // MessageDatabase.getByFileId 为同步查询
        getByFileId: () => ({
          local_path: file,
          fingerprint: 'fp',
        }),
      } as any;
      const res = await fetchChatResource(
        { file_id: 'some-cached-file' },
        { peer: 'group_123', groupId: 123, db }
      );
      expect(res.success).toBe(true);
      expect(res.local_path).toBe(file);
    } finally {
      fs.rmSync(file, { force: true });
    }
  });

  it('pokeUser 无 gateway 返回 success:false 与清晰错误', async () => {
    const res = await pokeUser({ user_id: '2000000001' });
    expect(res.success).toBe(false);
    expect(res.error).toContain('NapCat 未连接');
  });

  it('expandForwardMessage 无 gateway 返回 success:false 与清晰错误', async () => {
    const res = await expandForwardMessage({ forward_id: 'forward_abc' });
    expect(res.success).toBe(false);
    expect(res.error).toContain('NapCat 未连接');
  });
});