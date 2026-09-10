import { describe, it, expect } from 'vitest';
import { expandForwardMessage } from '../../src/tools/index.js';

/**
 * 契约测试: 合并转发内层图片即时落盘 (FC-1: Forward Image Materialization)
 *
 * 背景：合并转发展开走 NapCat get_forward_msg（该 action 可用），内层 image 段自带
 * multimedia.nt.qq.com.cn 直链（带 rkey，有时效）。而 NapCat 的 get_file /
 * get_private_file_url 在 packetBackend 不可用时整体失效（QQ 版本不匹配），
 * 因此本链路只走 HTTP 直链、完全不依赖 NapCat 取文件；rkey 有时效，必须展开当下立刻下载。
 *
 * 测试引用 src 真实模块，仅桩掉 NapCat gateway 与媒体落盘，不造桩自测。
 */

const PEER = 'group_646988881';
const REAL_URL =
  'https://multimedia.nt.qq.com.cn/download?appid=1406&fileid=EhSka0exFitjNgOnKTIe_VV-svbx7BjhnAEg_goo1I_zrtzjlgMyBHByb2RQgLsvWhCUL_LAUZ4g__iruLcLy0MGegLHA4IBAmd6&rkey=CAESME6mnVREHwuSVZv78aWttT6VVDccNb5ZD1zxH3SogcO-6oCwYA0EBxpacEXRv7XQXg';

function node(
  content: unknown,
  opts: { time?: number; nick?: string; uid?: string; useMessage?: boolean } = {}
): any {
  const base = {
    sender: { nickname: opts.nick || '考生', user_id: opts.uid || '10001' },
    time: opts.time ?? 1788999540,
  };
  return opts.useMessage
    ? { ...base, message: content }
    : { ...base, content: typeof content === 'string' ? content : JSON.stringify(content) };
}

function stubGateway(messages: any[]): any {
  return {
    getForwardMsg: async (_id: string) => ({ status: 'ok', retcode: 0, data: { messages } }),
  };
}

function stubMedia(opts: { failWhen?: (url: string, index: number) => boolean } = {}) {
  const calls: Array<{ url: string; opts: any }> = [];
  const mediaManager = {
    downloadAndSave: async (url: string, saveOpts: any) => {
      calls.push({ url, opts: saveOpts });
      if (opts.failWhen?.(url, calls.length)) {
        throw new Error('HTTP 403');
      }
      return {
        localPath: `/tmp/media/image/${PEER}/img_${calls.length}.png`,
        fingerprint: `fp-${calls.length}`,
        deduplicated: false,
      };
    },
  };
  return { mediaManager: mediaManager as any, calls };
}

const imgSeg = (data: any = {}) => ({ type: 'image', data });
const textSeg = (text: string) => ({ type: 'text', data: { text } });

describe('契约测试: 合并转发内层图片即时落盘 (FC-1)', () => {
  it('FC-1 契约 1: 内层 image 段带 http 直链 → 走 downloadAndSave 落盘，段内写入 local_path 供 read_image 直读', async () => {
    const segs = [
      textSeg('我必须立刻分享这段代码'),
      imgSeg({ file: 'ABC.png', url: REAL_URL, file_size: '20065' }),
      textSeg('笑死'),
    ];
    const gateway = stubGateway([node(segs, { nick: 'Cerium' })]);
    const { mediaManager, calls } = stubMedia();

    const res = await expandForwardMessage({ forward_id: 'fwd_1' }, { peer: PEER, gateway, mediaManager });

    expect(res.success).toBe(true);
    expect(res.images_downloaded).toBe(1);
    expect(calls).toHaveLength(1);
    // 落盘参数契约：类型 image / 会话 peer / file_id 透传
    expect(calls[0].opts.type).toBe('image');
    expect(calls[0].opts.sessionId).toBe(PEER);
    expect(calls[0].opts.fileId).toBe('ABC.png');

    const parsed = JSON.parse(res.messages![0].content);
    expect(parsed[1].data.local_path).toContain('/tmp/media/image/');
    // 文本段原样保留，未被改写
    expect(parsed[0].data.text).toBe('我必须立刻分享这段代码');
    expect(parsed[2].data.text).toBe('笑死');
  });

  it('FC-1 契约 2: 真实 multimedia 直链（含 & 与 rkey）逐字透传给下载层，不做 query 改写', async () => {
    const gateway = stubGateway([node([imgSeg({ url: REAL_URL })])]);
    const { mediaManager, calls } = stubMedia();

    await expandForwardMessage({ forward_id: 'fwd_2' }, { peer: PEER, gateway, mediaManager });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(REAL_URL);
    // rkey 必须完整保留，否则 CDN 侧直接 403
    expect(calls[0].url).toContain('rkey=CAESME6mnVREHwuSVZv78aWttT6VVDccNb5ZD1zxH3SogcO-6oCwYA0EBxpacEXRv7XQXg');
  });

  it('FC-1 契约 3: 表情包段（sub_type=1 或 emoji_package_id）按 sticker 落盘', async () => {
    const gateway = stubGateway([
      node([imgSeg({ url: REAL_URL, sub_type: 1 }), imgSeg({ url: REAL_URL, emoji_package_id: 5 })]),
    ]);
    const { mediaManager, calls } = stubMedia();

    const res = await expandForwardMessage({ forward_id: 'fwd_3' }, { peer: PEER, gateway, mediaManager });

    expect(res.images_downloaded).toBe(2);
    expect(calls.map((c) => c.opts.type)).toEqual(['sticker', 'sticker']);
  });

  it('FC-1 契约 4: url 缺失或非 http（仅有伪后缀 data.file）→ 跳过下载，content 原样返回且不报错', async () => {
    const segs = [imgSeg({ file: 'MD5.jpg' }), imgSeg({ url: '/tmp/local/path.jpg' })];
    const gateway = stubGateway([node(segs)]);
    const { mediaManager, calls } = stubMedia();

    const res = await expandForwardMessage({ forward_id: 'fwd_4' }, { peer: PEER, gateway, mediaManager });

    expect(res.success).toBe(true);
    expect(res.images_downloaded).toBeUndefined();
    expect(calls).toHaveLength(0);
    // 无落盘即不回写段内容，保持既有输出形态
    expect(res.messages![0].content).toBe(JSON.stringify(segs));
  });

  it('FC-1 契约 5: 单次展开最多落盘 10 张，超出的段保留原始 url 不阻断', async () => {
    const segs = Array.from({ length: 11 }, (_v, i) => imgSeg({ url: `${REAL_URL}&i=${i}` }));
    const gateway = stubGateway([node(segs)]);
    const { mediaManager, calls } = stubMedia();

    const res = await expandForwardMessage({ forward_id: 'fwd_5' }, { peer: PEER, gateway, mediaManager });

    expect(calls).toHaveLength(10);
    expect(res.images_downloaded).toBe(10);
    const parsed = JSON.parse(res.messages![0].content);
    expect(parsed[9].data.local_path).toBeDefined();
    expect(parsed[10].data.local_path).toBeUndefined();
    expect(parsed[10].data.url).toContain('i=10');
  });

  it('FC-1 契约 6: 单张下载失败不阻断整次展开，其余节点照常落盘', async () => {
    const first = [imgSeg({ url: `${REAL_URL}&bad=1` })];
    const second = [imgSeg({ url: `${REAL_URL}&ok=1` })];
    const gateway = stubGateway([node(first, { nick: 'A' }), node(second, { nick: 'B' })]);
    const { mediaManager, calls } = stubMedia({ failWhen: (url) => url.includes('bad=1') });

    const res = await expandForwardMessage({ forward_id: 'fwd_6' }, { peer: PEER, gateway, mediaManager });

    expect(res.success).toBe(true);
    expect(calls).toHaveLength(2);
    expect(res.images_downloaded).toBe(1);
    // 失败节点保持原样，成功节点带 local_path
    expect(res.messages![0].content).toBe(JSON.stringify(first));
    expect(JSON.parse(res.messages![1].content)[0].data.local_path).toBeDefined();
  });

  it('FC-1 契约 7: 无 mediaManager 时展开仍成功且不下载（向后兼容）', async () => {
    const segs = [imgSeg({ url: REAL_URL })];
    const gateway = stubGateway([node(segs)]);

    const res = await expandForwardMessage({ forward_id: 'fwd_7' }, { peer: PEER, gateway });

    expect(res.success).toBe(true);
    expect(res.images_downloaded).toBeUndefined();
    expect(res.messages![0].content).toBe(JSON.stringify(segs));
  });

  it('FC-1 契约 8: content 为纯文本原样返回；message 数组形态同样支持落盘', async () => {
    const plain = '哈哈哈哈哈';
    const arrNode = [imgSeg({ url: REAL_URL })];
    const gateway = stubGateway([node(plain, { nick: 'A' }), node(arrNode, { nick: 'B', useMessage: true })]);
    const { mediaManager, calls } = stubMedia();

    const res = await expandForwardMessage({ forward_id: 'fwd_8' }, { peer: PEER, gateway, mediaManager });

    expect(calls).toHaveLength(1);
    expect(res.messages![0].content).toBe(plain);
    expect(JSON.parse(res.messages![1].content)[0].data.local_path).toBeDefined();
  });

  it('FC-1 契约 9: 段内已有 local_path 不重复下载', async () => {
    const segs = [imgSeg({ url: REAL_URL, local_path: '/tmp/already/there.png' })];
    const gateway = stubGateway([node(segs)]);
    const { mediaManager, calls } = stubMedia();

    const res = await expandForwardMessage({ forward_id: 'fwd_9' }, { peer: PEER, gateway, mediaManager });

    expect(calls).toHaveLength(0);
    expect(res.images_downloaded).toBeUndefined();
    expect(JSON.parse(res.messages![0].content)[0].data.local_path).toBe('/tmp/already/there.png');
  });

  it('FC-1 契约 10: 节点 sender/user_id/秒级时间戳映射保持既有契约（回归）', async () => {
    const gateway = stubGateway([node([textSeg('hi')], { nick: 'Cerium', uid: '1094950020', time: 1788999540 })]);
    const { mediaManager } = stubMedia();

    const res = await expandForwardMessage({ forward_id: 'fwd_10' }, { peer: PEER, gateway, mediaManager });

    expect(res.messages![0].sender_name).toBe('Cerium');
    expect(res.messages![0].user_id).toBe('1094950020');
    expect(res.messages![0].time).toBe(1788999540000);
  });
});
