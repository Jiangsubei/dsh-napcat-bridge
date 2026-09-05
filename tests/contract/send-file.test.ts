import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { sendFile } from '../../src/tools/index.js';
import {
  classifySendFileSource,
  detectSendFileType,
} from '../../src/tools/file-source.js';

/**
 * 契约测试: 出方向文件发送 (IS-S1/IS-S2/IS-S4)
 *
 * - IS-S1: send_file 支持 本地路径 / file:// URI / URL / Base64 四种形态 + WSL→Windows 路径翻译
 * - IS-S2: file_type 参数强制生效
 * - IS-S4: 发送前路径校验 + 无 gateway/peer 不假成功
 */

const GROUP_PEER = 'group_3000000001';

/** WSL 共享盘 /mnt/c 是否可用（本机测试环境恒存在） */
const MNT_C_AVAILABLE = fs.existsSync('/mnt/c');

function stubGateway(overrides: Record<string, any> = {}) {
  const calls: Array<Record<string, any>> = [];
  const gateway = {
    sendMsg: async (_peer: any, message: any) => {
      calls.push({ action: 'sendMsg', message });
      return { status: 'ok', retcode: 0, data: { message_id: 12345 } };
    },
    ...overrides,
  };
  return { gateway, calls };
}

describe('契约测试: send_file 四形态归一化与路径翻译 (SendFile Source Contract IS-S1)', () => {
  it('IS-S1-契约 1: Base64 (base64://) 原样直传 NapCat', async () => {
    const { gateway, calls } = stubGateway();
    const res = await sendFile(
      { file_path: 'base64://aGVsbG8=' },
      { peer: GROUP_PEER, gateway }
    );
    expect(res.success).toBe(true);
    expect(calls[0].message).toEqual([{ type: 'file', data: { file: 'base64://aGVsbG8=' } }]);
  });

  it('IS-S1-契约 2: data:;base64 前缀归一化为 base64:// 交付', async () => {
    const { gateway, calls } = stubGateway();
    const res = await sendFile(
      { file_path: 'data:application/octet-stream;base64,aGVsbG8=' },
      { peer: GROUP_PEER, gateway }
    );
    expect(res.success).toBe(true);
    expect(calls[0].message).toEqual([{ type: 'file', data: { file: 'base64://aGVsbG8=' } }]);
  });

  it('IS-S1-契约 3: URL 原样直传，图片扩展名自动判定 image 段', async () => {
    const { gateway, calls } = stubGateway();
    const res = await sendFile(
      { file_path: 'https://example.com/a.png?v=2' },
      { peer: GROUP_PEER, gateway }
    );
    expect(res.success).toBe(true);
    expect(calls[0].message).toEqual([
      { type: 'image', data: { file: 'https://example.com/a.png?v=2' } },
    ]);
  });

  it(
    'IS-S1-契约 4: WSL /mnt/c 本地路径存在时翻译为 file:///C:/ 交付 NapCat',
    { skip: !MNT_C_AVAILABLE },
    async () => {
      const tmpDir = fs.mkdtempSync('/mnt/c/Users/Nyara/AppData/Local/Temp/dsh-b1-');
      try {
        const file = path.join(tmpDir, 'report.pdf');
        fs.writeFileSync(file, 'fake pdf');
        const { gateway, calls } = stubGateway();
        const res = await sendFile({ file_path: file }, { peer: GROUP_PEER, gateway });
        expect(res.success).toBe(true);
        const delivered = calls[0].message[0].data.file;
        expect(delivered.startsWith('file:///C:/')).toBe(true);
        expect(calls[0].message[0].type).toBe('file');
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    }
  );

  it('IS-S1-契约 5: file:// URI（指向 /mnt/c 共享文件）归一化为 file:///C:/ 交付', { skip: !MNT_C_AVAILABLE }, async () => {
    const tmpDir = fs.mkdtempSync('/mnt/c/Users/Nyara/AppData/Local/Temp/dsh-b1f-');
    try {
      const file = path.join(tmpDir, 'photo.png');
      fs.writeFileSync(file, 'fake png');
      const { gateway, calls } = stubGateway();
      const res = await sendFile(
        { file_path: `file://${file}` },
        { peer: GROUP_PEER, gateway }
      );
      expect(res.success).toBe(true);
      expect(calls[0].message[0].data.file.startsWith('file:///C:/')).toBe(true);
      expect(calls[0].message[0].type).toBe('image');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('IS-S1-契约 6: Windows 绝对路径 (C:\\...) 输入归一化为 file:///C:/ 交付', { skip: !MNT_C_AVAILABLE }, async () => {
    const tmpDir = fs.mkdtempSync('/mnt/c/Users/Nyara/AppData/Local/Temp/dsh-b1w-');
    try {
      const file = path.join(tmpDir, 'doc.txt');
      fs.writeFileSync(file, 'fake doc');
      // 转换为 Windows 侧路径 C:\Users\... 作为输入
      const winPath = file.replace(/^\/mnt\/([a-z])\/(.*)$/, (_m, d, rest) => `${d.toUpperCase()}:\\${rest.replace(/\//g, '\\')}`);
      const { gateway, calls } = stubGateway();
      const res = await sendFile({ file_path: winPath }, { peer: GROUP_PEER, gateway });
      expect(res.success).toBe(true);
      expect(calls[0].message[0].data.file.startsWith('file:///C:/')).toBe(true);
      expect(calls[0].message[0].data.file.endsWith('doc.txt')).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('IS-S1-契约 7: WSL 内部路径（/home、/tmp 等非共享）明确报错并提示共享目录，绝不发假成功', async () => {
    const file = `/tmp/dsh-napcat-b1-${Date.now()}.txt`;
    fs.writeFileSync(file, 'x');
    try {
      const { gateway } = stubGateway();
      const res = await sendFile({ file_path: file }, { peer: GROUP_PEER, gateway });
      expect(res.success).toBe(false);
      expect(res.error).toContain('无法访问');
    } finally {
      fs.rmSync(file, { force: true });
    }
  });
});

describe('契约测试: send_file 类型判定与错误分层 (SendFile Type & Error Contract IS-S2/IS-S4)', () => {
  it('IS-S2-契约 1: file_type=image 强制 image 段（即使扩展名是 .pdf）', async () => {
    const { gateway, calls } = stubGateway();
    const res = await sendFile(
      { file_path: 'https://example.com/report.pdf', file_type: 'image' },
      { peer: GROUP_PEER, gateway }
    );
    expect(res.success).toBe(true);
    expect(calls[0].message).toEqual([{ type: 'image', data: { file: 'https://example.com/report.pdf' } }]);
  });

  it('IS-S2-契约 2: file_type=file 强制 file 段（即使扩展名是 .png）', async () => {
    const { gateway, calls } = stubGateway();
    const res = await sendFile(
      { file_path: 'https://example.com/photo.png', file_type: 'file' },
      { peer: GROUP_PEER, gateway }
    );
    expect(res.success).toBe(true);
    expect(calls[0].message).toEqual([{ type: 'file', data: { file: 'https://example.com/photo.png' } }]);
  });

  it('IS-S4-契约 3: 无 gateway/peer 返回 success:false 与清晰错误（不假成功、不写死 message_id）', async () => {
    const res = await sendFile({ file_path: 'https://example.com/a.pdf' });
    expect(res.success).toBe(false);
    expect(res.error).toContain('NapCat 未连接');
    expect(res.message_id).toBeUndefined();
  });

  it('IS-S4-契约 4: 本地路径不存在返回"本地路径不存在"，不做任何发送', async () => {
    const missing = '/mnt/c/Users/Nyara/AppData/Local/Temp/definitely-missing-98765.txt';
    const { gateway, calls } = stubGateway();
    const res = await sendFile({ file_path: missing }, { peer: GROUP_PEER, gateway });
    expect(res.success).toBe(false);
    expect(res.error).toContain('本地路径不存在');
    expect(calls).toHaveLength(0);
  });

  it('IS-S4-契约 5: NapCat 返回失败时透传 API 错误', async () => {
    const { gateway } = stubGateway({
      sendMsg: async () => ({ status: 'failed', retcode: 100, data: {}, wording: 'file 参数解析失败' }),
    });
    const res = await sendFile(
      { file_path: 'https://example.com/a.pdf' },
      { peer: GROUP_PEER, gateway }
    );
    expect(res.success).toBe(false);
    expect(res.error).toContain('file 参数解析失败');
  });

  it('IS-S4-契约 6: NapCat 成功但未返回 message_id 时按错误处理（不写死假 id）', async () => {
    const { gateway } = stubGateway({
      sendMsg: async () => ({ status: 'ok', retcode: 0, data: {} }),
    });
    const res = await sendFile(
      { file_path: 'https://example.com/a.pdf' },
      { peer: GROUP_PEER, gateway }
    );
    expect(res.success).toBe(false);
    expect(res.error).toContain('message_id');
  });

  it('IS-S4-契约 7: NapCat 返回真实 message_id 时成功', async () => {
    const calls: Array<Record<string, any>> = [];
    const gateway = {
      sendMsg: async (_peer: any, message: any) => {
        calls.push({ action: 'sendMsg', message });
        return { status: 'ok', retcode: 0, data: { message_id: 8801 } };
      },
    } as any;
    const res = await sendFile(
      { file_path: 'https://example.com/a.pdf' },
      { peer: GROUP_PEER, gateway }
    );
    expect(res.success).toBe(true);
    expect(res.message_id).toBe(8801);
    expect(calls[0].message[0].type).toBe('file');
  });
});

describe('契约测试: classifySendFileSource 归一化单元 (SendFile Source Classification)', () => {
  it('IS-S1-契约 8: 四形态识别与 WSL→Windows 路径翻译', () => {
    // Base64
    const b64 = classifySendFileSource('base64://aGVsbG8=');
    expect(b64.source).toMatchObject({ kind: 'base64', value: 'base64://aGVsbG8=' });

    // data: URI → 归一为 base64://
    const dataUri = classifySendFileSource('data:application/octet-stream;base64,aGVsbG8=');
    expect(dataUri.source).toMatchObject({ kind: 'base64', value: 'base64://aGVsbG8=' });

    // URL
    const url = classifySendFileSource('https://example.com/a.png?x=1');
    expect(url.source).toMatchObject({ kind: 'url', value: 'https://example.com/a.png?x=1' });

    // /mnt/c → file:///C:/
    const mnt = classifySendFileSource('/mnt/c/napcat_share/a.txt');
    expect(mnt.source).toMatchObject({ kind: 'local', value: 'file:///C:/napcat_share/a.txt' });
    expect(mnt.source?.localCheckPath).toBe('/mnt/c/napcat_share/a.txt');

    // file:// URI (Windows 形态) 保留
    const winUri = classifySendFileSource('file:///C:/Users/Nyara/a.png');
    expect(winUri.source).toMatchObject({ kind: 'file-uri', value: 'file:///C:/Users/Nyara/a.png' });

    // Windows 路径 → 归一为 file:///C:/
    const winPath = classifySendFileSource('C:\\napcat_share\\a.txt');
    expect(winPath.source).toMatchObject({ kind: 'windows-path', value: 'file:///C:/napcat_share/a.txt' });

    // 相对路径不可识别
    const rel = classifySendFileSource('relative/path.txt');
    expect(rel.error).toBeDefined();

    // WSL 内部路径（非 /mnt 共享）拒绝
    const homePath = classifySendFileSource('/home/testuser/x.txt');
    expect(homePath.error).toBeDefined();
    expect(homePath.error).toContain('无法访问');
  });

  it('IS-S2-契约 3: detectSendFileType 强制与自动推导', () => {
    expect(detectSendFileType('image', 'https://example.com/report.pdf')).toBe('image');
    expect(detectSendFileType('file', 'https://example.com/photo.png')).toBe('file');
    expect(detectSendFileType(undefined, 'https://example.com/photo.png')).toBe('image');
    expect(detectSendFileType(undefined, '/tmp/report.pdf')).toBe('file');
    expect(detectSendFileType(undefined, 'base64://aGVsbG8=')).toBe('file');
  });
});
