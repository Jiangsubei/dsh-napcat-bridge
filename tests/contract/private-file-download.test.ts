import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { downloadPrivateFile } from '../../src/tools/private-file.js';
import { windowsPathToWsl } from '../../src/tools/file-source.js';

/**
 * PF-001 单测环境隔离：本测试机（非 WSL 宿主机）不存在 /mnt/<drive> 挂载点，
 * 无法物化「Windows 盘 → /mnt/c/... 真实读取」。以 vi.mock 模拟这些路径存在
 * （仅隔离『宿主机是否挂载盘』这一外部环境事实；翻译结果、downloadAndSave 收到
 * 的翻译路径、落盘参数契约等全部为真断言）。
 * 注：变量名以 mock 开头是 vitest hoisting 安全约定，fixture 内不得引用其他顶层变量。
 */
const mockMountedPaths = new Set<string>();

vi.mock('node:fs', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('node:fs');
  return {
    ...actual,
    existsSync: ((p: fs.PathLike) => {
      const key = String(p);
      if (mockMountedPaths.has(key)) return true;
      return actual.existsSync(p);
    }) as typeof fs.existsSync,
  };
});

/**
 * 契约测试: 私聊文件两级退化下载助手 (Private File Download Contract PF-001)
 *
 * 引用 src 真实模块（downloadPrivateFile），mock 仅隔离网络/第三方（gateway 应答、mediaManager 落盘），
 * 装配路径（index.ts 入站 file 段 → 真实 WS → 落盘 → 消息记录）由 private-file-save.test.ts 覆盖。
 *
 * 两级退化（用户拍板，任务包 §3.1）：
 *   首选 get_private_file_url → data.url 直链 → downloadAndSave；
 *   回退 get_file        → data.file 本地路径 → windowsPathToWsl 翻译 → 校验存在 → 落盘；
 *   双失败               → 清晰错误（文件下载失败: <环节原因>...），绝不返回占位假路径。
 */

const PEER = 'user_2000000001';
const FILE_ID = 'N_private_file_001';

function stubGateway(overrides: Record<string, any> = {}) {
  const calls: Array<Record<string, any>> = [];
  const defaults = {
    getPrivateFileUrl: async () => ({ status: 'ok', retcode: 0, data: { url: 'https://example.com/dl/pf.txt' } }),
    getFile: async () => ({ status: 'ok', retcode: 0, data: { file: '', url: '', file_size: '', file_name: '' } }),
  };
  // 录制器恒记录调用（不被 overrides 覆盖），实现委托给 override（若有）否则走默认
  const gateway = {
    getPrivateFileUrl: async (fileId: string) => {
      calls.push({ action: 'get_private_file_url', fileId });
      const impl = overrides.getPrivateFileUrl || defaults.getPrivateFileUrl;
      return impl(fileId);
    },
    getFile: async (fileId: string) => {
      calls.push({ action: 'get_file', fileId });
      const impl = overrides.getFile || defaults.getFile;
      return impl(fileId);
    },
  };
  return { gateway, calls };
}

function stubMedia() {
  const mediaCalls: Array<Record<string, any>> = [];
  const mediaManager = {
    downloadAndSave: async (urlOrPath: string, opts: any) => {
      mediaCalls.push({ urlOrPath, opts });
      return {
        localPath: `/tmp/downloads/files/${opts?.sessionId || 'common'}/${opts?.filename || 'file.dat'}`,
        fingerprint: 'fp-001',
        deduplicated: false,
      };
    },
  };
  return { mediaManager, mediaCalls };
}

describe('契约测试: 私聊文件两级退化下载助手 (PF-001)', () => {
  it('PF-001-契约 U1: 首选路径 —— get_private_file_url 成功返回 HTTP 直链 → downloadAndSave 落盘 (files/<peer>/)', async () => {
    const { gateway, calls } = stubGateway();
    const { mediaManager, mediaCalls } = stubMedia();

    const res = await downloadPrivateFile({
      fileId: FILE_ID,
      peer: PEER,
      filename: '报告.pdf',
      gateway,
      mediaManager,
    });

    expect(res.ok).toBe(true);
    expect(res.via).toBe('url');
    expect(res.localPath).toBeDefined();
    // 动作契约：只调用 get_private_file_url，不触发回退 get_file
    expect(calls.map((c) => c.action)).toEqual(['get_private_file_url']);
    // 落盘契约：真实文件名 + sessionId=peer → files/<peer>/
    expect(mediaCalls).toHaveLength(1);
    expect(mediaCalls[0].urlOrPath).toBe('https://example.com/dl/pf.txt');
    expect(mediaCalls[0].opts.fileId).toBe(FILE_ID);
    expect(mediaCalls[0].opts.type).toBe('files');
    expect(mediaCalls[0].opts.sessionId).toBe(PEER);
    expect(mediaCalls[0].opts.filename).toBe('报告.pdf');
  });

  it('PF-001-契约 U2: 退化路径 —— get_private_file_url 失败 → 回退 get_file 本地路径 → 翻译 WSL → 落盘成功', async () => {
    // 模拟 C 盘已挂载（WSL 宿主机外部环境事实；翻译路径存在性校验通过后走真实 downloadAndSave）
    mockMountedPaths.add('/mnt/c/napcat/download/报告.pdf');
    try {
      const { gateway, calls } = stubGateway({
        getPrivateFileUrl: async () => ({
          status: 'failed',
          retcode: 100,
          data: {},
          wording: 'real fileUUID not found!',
        }),
        getFile: async (fileId: string) => ({
          status: 'ok',
          retcode: 0,
          data: { file: 'C:\\napcat\\download\\报告.pdf', url: 'C:\\napcat\\download\\报告.pdf', file_size: '1024', file_name: '报告.pdf' },
        }),
      });
      const { mediaManager, mediaCalls } = stubMedia();

      const res = await downloadPrivateFile({
        fileId: FILE_ID,
        peer: PEER,
        filename: '报告.pdf',
        gateway,
        mediaManager,
      });

      expect(res.ok).toBe(true);
      expect(res.via).toBe('local');
      expect(res.localPath).toBeDefined();
      expect(calls.map((c) => c.action)).toEqual(['get_private_file_url', 'get_file']);
      // 回退落盘：本地路径已被正确翻译为 WSL 路径再交给 downloadAndSave 读取拷入
      expect(mediaCalls).toHaveLength(1);
      expect(mediaCalls[0].urlOrPath).toBe('/mnt/c/napcat/download/报告.pdf');
      expect(mediaCalls[0].opts.sessionId).toBe(PEER);
    } finally {
      mockMountedPaths.clear();
    }
  });

  it('PF-001-契约 U3: 退化路径 —— get_private_file_url 返回 ok 但 url 非 HTTP 直链（packet 不可用残留）→ 仍回退 get_file', async () => {
    mockMountedPaths.add('/mnt/d/tmp/data.txt');
    try {
      const { gateway, calls } = stubGateway({
        getPrivateFileUrl: async () => ({
          status: 'ok',
          retcode: 0,
          data: { url: '' },
        }),
        getFile: async (fileId: string) => ({
          status: 'ok',
          retcode: 0,
          data: { file: 'D:\\tmp\\data.txt', url: 'D:\\tmp\\data.txt' },
        }),
      });
      const { mediaManager, mediaCalls } = stubMedia();

      const res = await downloadPrivateFile({ fileId: FILE_ID, peer: PEER, gateway, mediaManager });

      expect(res.ok).toBe(true);
      expect(res.via).toBe('local');
      expect(res.localPath).toBeDefined();
      expect(calls.map((c) => c.action)).toEqual(['get_private_file_url', 'get_file']);
      expect(mediaCalls).toHaveLength(1);
      expect(mediaCalls[0].urlOrPath).toBe('/mnt/d/tmp/data.txt');
    } finally {
      mockMountedPaths.clear();
    }
  });

  it('PF-001-契约 U4: 双失败 —— 返回清晰错误、local_path 为空、不抛未捕获异常', async () => {
    const { gateway } = stubGateway({
      getPrivateFileUrl: async () => ({ status: 'failed', retcode: 34001, data: {}, wording: 'packet 后端不可用' }),
      getFile: async (fileId: string) => ({ status: 'failed', retcode: 100, data: {}, wording: 'file not found' }),
    });
    const { mediaManager } = stubMedia();

    let res: any;
    await expect(
      (async () => {
        res = await downloadPrivateFile({ fileId: FILE_ID, peer: PEER, gateway, mediaManager });
      })()
    ).resolves.toBeUndefined();

    expect(res.ok).toBe(false);
    expect(res.localPath).toBeNull();
    expect(res.via).toBeNull();
    // 清晰报错：前缀 + 首选环节原因 + 回退环节原因（绝不占位假路径）
    expect(res.error).toContain('文件下载失败');
    expect(res.error).toContain('packet 后端不可用');
    expect(res.error).toContain('file not found');
  });

  it('PF-001-契约 U5: get_file 返回空 data（无 file 字段）→ 清晰错误且两路原因齐全', async () => {
    const { gateway } = stubGateway({
      getPrivateFileUrl: async () => ({ status: 'failed', retcode: 1, data: {}, message: 'timeout' }),
      getFile: async () => ({ status: 'ok', retcode: 0, data: { url: '', file: '', file_size: '', file_name: '' } }),
    });
    const { mediaManager } = stubMedia();

    const res = await downloadPrivateFile({ fileId: FILE_ID, peer: PEER, gateway, mediaManager });

    expect(res.ok).toBe(false);
    expect(res.localPath).toBeNull();
    expect(res.error).toContain('文件下载失败');
    expect(res.error).toContain('timeout');
    expect(res.error).toContain('未返回可用的本地路径');
  });

  it('PF-001-契约 U6: 无 gateway / 无 mediaManager → 各自清晰错误（不抛异常）', async () => {
    const noGw = await downloadPrivateFile({ fileId: FILE_ID, gateway: null, mediaManager: null as any });
    expect(noGw.ok).toBe(false);
    expect(noGw.error).toContain('NapCat 未连接');

    const { gateway } = stubGateway();
    const noMedia = await downloadPrivateFile({ fileId: FILE_ID, gateway, mediaManager: null as any });
    expect(noMedia.ok).toBe(false);
    expect(noMedia.error).toContain('媒体存储服务不可用');
  });

  it('PF-001-契约 U7: 文件名安全 —— 路径穿越/子目录名被规整为 basename', async () => {
    const { gateway } = stubGateway();
    const { mediaManager, mediaCalls } = stubMedia();

    await downloadPrivateFile({
      fileId: FILE_ID,
      peer: PEER,
      filename: '../../evil.txt',
      gateway,
      mediaManager,
    });

    expect(mediaCalls[0].opts.filename).toBe('evil.txt');
  });

  it('PF-001-契约 U8: windowsPathToWsl 纯函数翻译契约（任务包 §3.1 回退路径核心）', () => {
    expect(windowsPathToWsl('C:\\napcat\\download\\report.pdf')).toBe('/mnt/c/napcat/download/report.pdf');
    expect(windowsPathToWsl('D:/tmp/数据.txt')).toBe('/mnt/d/tmp/数据.txt');
    expect(windowsPathToWsl('C:foobar')).toBeNull(); // 非盘符绝对路径
    expect(windowsPathToWsl('/mnt/c/x')).toBeNull(); // 非 Windows 路径
  });

  it('PF-001-契约 U9: 回退路径存在性校验 —— 翻译后 WSL 路径不存在 → 清晰错误（绝不让占位冒充）', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-napcat-pf-'));
    const realFile = path.join(tmpDir, 'real.txt');
    fs.writeFileSync(realFile, 'content');
    const fakeFile = path.join(tmpDir, 'missing.txt');
    try {
      const run = async (napcatPath: string, expectCandidate: string | null) => {
        const { gateway } = stubGateway({
          getPrivateFileUrl: async () => ({ status: 'failed', retcode: 1, data: {}, wording: 'pf-err' }),
          getFile: async () => ({ status: 'ok', retcode: 0, data: { file: napcatPath } }),
        });
        const { mediaManager } = stubMedia();
        return downloadPrivateFile({ fileId: FILE_ID, peer: PEER, gateway, mediaManager });
      };

      // 存在 → 成功（Linux/直落形态，无需翻译）
      const okRes = await run(realFile, realFile);
      expect(okRes.ok).toBe(true);
      expect(okRes.via).toBe('local');

      // 不存在 → 清晰错误，含翻译后路径
      const missRes = await run(fakeFile, fakeFile);
      expect(missRes.ok).toBe(false);
      expect(missRes.error).toContain('本地文件不存在');
      expect(missRes.error).toContain(fakeFile);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});