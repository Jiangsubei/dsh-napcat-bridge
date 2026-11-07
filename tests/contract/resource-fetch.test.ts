import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import { fetchChatResource, pokeUser, expandForwardMessage } from '../../src/tools/index.js';
import { clearGroupFileResolverCache } from '../../src/tools/group-file-resolve.js';

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
  beforeEach(() => {
    clearGroupFileResolverCache();
  });

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
  it('方案A-契约 1: 批量传入 files 列表，单次调用依次拉取多个文件并返回结构化清单', async () => {
    const { gateway, calls } = stubGateway();
    const { mediaManager, mediaCalls } = stubMedia();

    const res = await fetchChatResource(
      {
        files: [
          { file_id: 'file-1', busid: 102, file_name: 'mod1.vpk' },
          { file_id: 'file-2', busid: 104, file_name: 'mod2.vpk' },
        ],
      },
      { peer: GROUP_PEER, groupId: 3000000001, gateway, mediaManager }
    );

    expect(res.success).toBe(true);
    expect(res.total).toBe(2);
    expect(res.downloaded_count).toBe(2);
    expect(res.results).toHaveLength(2);
    expect(res.results?.[0].file_id).toBe('file-1');
    expect(res.results?.[0].success).toBe(true);
    expect(res.results?.[0].local_path).toBeDefined();
    expect(res.results?.[1].file_id).toBe('file-2');
    expect(res.results?.[1].success).toBe(true);
    expect(res.results?.[1].local_path).toBeDefined();

    // 验证 gateway 和 mediaManager 依次被调用
    expect(calls).toHaveLength(2);
    expect(mediaCalls).toHaveLength(2);
  });

  it('方案A-契约 2: 批量下载遇到部分文件失败时（Partial Success），不阻断其他文件并返回明细', async () => {
    const calls: any[] = [];
    const gateway = {
      getGroupFileUrl: async (groupId: any, fileId: any, busid: any) => {
        calls.push({ groupId, fileId, busid });
        if (fileId === 'file-fail') {
          return { status: 'failed', retcode: 100, wording: '该文件已被管理员删除' };
        }
        return { status: 'ok', retcode: 0, data: { url: 'https://example.com/dl/success.vpk' } };
      },
    };
    const { mediaManager } = stubMedia();

    const res = await fetchChatResource(
      {
        files: [
          { file_id: 'file-ok', busid: 102, file_name: 'ok.vpk' },
          { file_id: 'file-fail', busid: 104, file_name: 'fail.vpk' },
        ],
      },
      { peer: GROUP_PEER, groupId: 3000000001, gateway, mediaManager }
    );

    // 存在部分成功时整体 success 为 true (Partial Success)
    expect(res.success).toBe(true);
    expect(res.total).toBe(2);
    expect(res.downloaded_count).toBe(1);
    expect(res.results).toHaveLength(2);
    expect(res.results?.[0].success).toBe(true);
    expect(res.results?.[1].success).toBe(false);
    expect(res.results?.[1].error).toContain('已被管理员删除');
  });

  it('方案A-契约 3: 未提供 file_id 且未提供 files 返回清晰错误', async () => {
    const res = await fetchChatResource({}, { peer: GROUP_PEER, groupId: 3000000001 });
    expect(res.success).toBe(false);
    expect(res.error).toContain('file_id 或 files');
  });

  it('方案A-契约 4: 批量中已落盘的文件走一级去重，未落盘文件走真实下载', async () => {
    const { gateway, calls } = stubGateway();
    const { mediaManager, mediaCalls } = stubMedia();

    const cachedFile = `/tmp/dsh-test-cached-${Date.now()}.txt`;
    fs.writeFileSync(cachedFile, 'already-downloaded');

    try {
      const db = {
        getByFileId: (id: string) => {
          if (id === 'cached-file') {
            return { local_path: cachedFile, fingerprint: 'fp-cached' };
          }
          return null;
        },
      } as any;

      const res = await fetchChatResource(
        {
          files: [
            { file_id: 'cached-file', busid: 102, file_name: 'cached.txt' },
            { file_id: 'new-file', busid: 104, file_name: 'new.vpk' },
          ],
        },
        { peer: GROUP_PEER, groupId: 3000000001, gateway, mediaManager, db }
      );

      expect(res.success).toBe(true);
      expect(res.total).toBe(2);
      expect(res.downloaded_count).toBe(2);
      // cached-file 命中去重，未请求 gateway；new-file 请求 gateway
      expect(calls).toHaveLength(1);
      expect(calls[0].fileId).toBe('new-file');
      expect(mediaCalls).toHaveLength(1);
      expect(res.results?.[0].local_path).toBe(cachedFile);
      expect(res.results?.[1].local_path).toContain('test.txt');
    } finally {
      fs.rmSync(cachedFile, { force: true });
    }
  });

  /**
   * SnowLuma 兼容：群文件 notice 事件落库的是 32 位 hex file_id，SnowLuma 的
   * get_group_file_url 只接受消息段 /uuid。这里覆盖「本地兄弟记录优先」与
   * 「群根目录列表兜底」两级解析，并确保成功路径不会多打协议端接口。
   */
  const HEX_NOTICE_ID = 'ae4d1ec67ebe8500b712d3d181e64b29';
  const SEGMENT_FILE_ID = '/820dde00-d032-47a9-8726-dc5369c6a463';

  function snowLumaGateway(rootFiles: any[] = []) {
    const calls: Array<Record<string, any>> = [];
    const rootCalls: any[] = [];
    const gateway = {
      getGroupFileUrl: async (groupId: any, fileId: any, busid: any) => {
        calls.push({ groupId, fileId, busid });
        if (String(fileId).startsWith('/')) {
          return { status: 'ok', retcode: 0, data: { url: 'https://example.com/dl/resolved.txt' } };
        }
        return {
          status: 'failed',
          retcode: 100,
          wording: 'group file url failed: code=4294966993 msg=文件 file_id 错误',
        };
      },
      getGroupRootFiles: async (groupId: any) => {
        rootCalls.push(groupId);
        return { status: 'ok', retcode: 0, data: { files: rootFiles, folders: [] } };
      },
      getGroupFilesByFolder: async () => ({ status: 'ok', retcode: 0, data: { files: [], folders: [] } }),
    };
    return { gateway, calls, rootCalls };
  }

  it('SnowLuma-契约 8: notice 32hex 首次失败后优先用本地兄弟消息段 /uuid 重试，不请求群根目录', async () => {
    const { gateway, calls, rootCalls } = snowLumaGateway();
    const { mediaManager } = stubMedia();
    const db = {
      getByFileId: (id: string) =>
        id === HEX_NOTICE_ID
          ? {
              msg_id: 1001,
              peer: GROUP_PEER,
              time: 1793946745000,
              type: 'group_file',
              content: `[群文件:demo.mp4 (ID:${HEX_NOTICE_ID})]`,
              raw: JSON.stringify({ post_type: 'notice', file: { id: HEX_NOTICE_ID, name: 'demo.mp4', size: 4096, busid: 102 } }),
              file_id: HEX_NOTICE_ID,
              busid: 102,
              local_path: null,
            }
          : null,
      findGroupFileSibling: () => ({ file_id: SEGMENT_FILE_ID, busid: 102, msg_id: 1002 }),
    } as any;

    const res = await fetchChatResource(
      { file_id: HEX_NOTICE_ID, busid: 102, file_name: 'demo.mp4' },
      { peer: GROUP_PEER, groupId: 3000000001, gateway, mediaManager, db }
    );

    expect(res.success).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ fileId: HEX_NOTICE_ID, busid: 102 });
    expect(calls[1]).toMatchObject({ fileId: SEGMENT_FILE_ID, busid: 102 });
    expect(rootCalls).toHaveLength(0);
  });

  it('SnowLuma-契约 9: 本地无兄弟记录时，通过群根目录文件名匹配 /uuid 并重试下载', async () => {
    const { gateway, calls, rootCalls } = snowLumaGateway([
      { file_id: SEGMENT_FILE_ID, file_name: 'demo.mp4', busid: 102, file_size: 4096, upload_time: 1793946740 },
    ]);
    const { mediaManager } = stubMedia();
    const db = {
      getByFileId: (id: string) =>
        id === HEX_NOTICE_ID
          ? {
              msg_id: 1001,
              peer: GROUP_PEER,
              time: 1793946745000,
              type: 'group_file',
              content: `[群文件:demo.mp4 (ID:${HEX_NOTICE_ID})]`,
              raw: '{}',
              file_id: HEX_NOTICE_ID,
              busid: 102,
              local_path: null,
            }
          : null,
      findGroupFileSibling: () => null,
    } as any;

    const res = await fetchChatResource(
      { file_id: HEX_NOTICE_ID, busid: 102, file_name: 'demo.mp4' },
      { peer: GROUP_PEER, groupId: 3000000001, gateway, mediaManager, db }
    );

    expect(res.success).toBe(true);
    expect(rootCalls).toEqual([3000000001]);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({ fileId: SEGMENT_FILE_ID, busid: 102 });
  });

  it('SnowLuma-契约 10: 消息段 /uuid 首次成功时绝不触发根目录兜底（NapCat 主路径零回归）', async () => {
    const { gateway, calls, rootCalls } = snowLumaGateway();
    const { mediaManager } = stubMedia();

    const res = await fetchChatResource(
      { file_id: SEGMENT_FILE_ID, busid: 102, file_name: 'demo.mp4' },
      { peer: GROUP_PEER, groupId: 3000000001, gateway, mediaManager }
    );

    expect(res.success).toBe(true);
    expect(calls).toHaveLength(1);
    expect(rootCalls).toHaveLength(0);
  });

  it('SnowLuma-契约 11: 首次与兜底解析均失败时保留协议端原始报错', async () => {
    const { gateway } = snowLumaGateway([]);
    const { mediaManager } = stubMedia();
    const db = {
      getByFileId: () => null,
      findGroupFileSibling: () => null,
    } as any;

    const res = await fetchChatResource(
      { file_id: HEX_NOTICE_ID, busid: 102, file_name: 'demo.mp4' },
      { peer: GROUP_PEER, groupId: 3000000001, gateway, mediaManager, db }
    );

    expect(res.success).toBe(false);
    expect(res.error).toContain('文件 file_id 错误');
  });
});
