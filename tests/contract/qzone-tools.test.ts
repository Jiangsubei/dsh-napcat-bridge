/**
 * 契约测试: QQ 空间动态互动工具集 (Qzone Tools Contract)
 *
 * 覆盖规范清单:
 * 契约 1: 真实装配下，QQ 会话 assemble 结果中包含 read_qzone_feeds, publish_qzone_feed, comment_qzone_feed, delete_qzone_feed 工具；
 * 契约 2: readQzoneFeeds 执行契约（好友流、指定好友、自身动态、limit 截断保护、评论区解析与 is_self 标记、多模态图片下载本地化）；
 * 契约 3: publishQzoneFeed 执行契约（纯文本发布、图片绝对路径转 file:///、发布成功返回 feed_id 与冷却时间门控拦截）；
 * 契约 4: commentQzoneFeed 执行契约（参数必填校验、评论发送与评论冷却时间门控拦截）；
 * 契约 5: deleteQzoneFeed 执行契约（参数校验、调用 delete_qzone_msg 物理删除）；
 * 契约 6: DSH Lossless JSON 红线契约（执行返回值所有嵌套键值深度递归断言绝无 undefined）。
 */

import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fsp } from 'node:fs';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { bootDshNapcatBridge, type BootedDsh } from '../../src/boot.js';
import {
  readQzoneFeeds,
  publishQzoneFeed,
  commentQzoneFeed,
  deleteQzoneFeed,
  QzoneRateLimiter,
} from '../../src/tools/qzone.js';
import type {
  ReadQzoneFeedsParams,
  PublishQzoneFeedParams,
  CommentQzoneFeedParams,
  DeleteQzoneFeedParams,
} from '../../src/types/index.js';

/** 深度断言对象中绝无 undefined 字段 (Lossless JSON 红线) */
function assertNoUndefinedDeep(obj: any, pathStr = 'root') {
  if (obj === undefined) {
    throw new Error(`Lossless JSON violation: field at ${pathStr} is undefined!`);
  }
  if (obj === null || typeof obj !== 'object') {
    return;
  }
  if (Array.isArray(obj)) {
    obj.forEach((item, index) => {
      assertNoUndefinedDeep(item, `${pathStr}[${index}]`);
    });
    return;
  }
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined) {
      throw new Error(`Lossless JSON violation: key "${key}" at ${pathStr} has undefined value!`);
    }
    assertNoUndefinedDeep(value, `${pathStr}.${key}`);
  }
}

describe('契约 1: QQ 空间动态工具组真实装配与存在性契约', () => {
  let tmpHome: string;
  let booted: BootedDsh;
  const TEST_PORT = 29915;

  beforeEach(async () => {
    tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-qzone-tool-asm-'));
    booted = await bootDshNapcatBridge({
      dshHome: tmpHome,
      mountPlugin: true,
      config: {
        bot_qq: '1000000001',
        ws_port: TEST_PORT,
      },
    });
  });

  afterEach(async () => {
    if (booted) {
      await booted.dispose().catch(() => {});
    }
    if (tmpHome) {
      await fsp.rm(tmpHome, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('1.1 真实装配下：QQ 会话 assemble 结果中包含全部 4 个 QQ 空间工具', async () => {
    const ctx = booted.ctx;
    const presetsSvc: any = (ctx as any).agentPresets || ctx.get?.('agentPresets');
    const qqWs = path.join(tmpHome, 'qq-ws-session');
    await fsp.mkdir(qqWs, { recursive: true });

    const qqHandle = await ctx.agents.create({
      sessionId: 'qq-user-1000000002',
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      meta: { cwd: qqWs },
      setup: async (agentCtx: any) => {
        if (presetsSvc?.mount) {
          await presetsSvc.mount(agentCtx, 'qq-session');
        } else {
          (ctx as any).napcatBridgeTools?.registerTools?.(agentCtx);
        }
      },
    });

    const qqAgent = qqHandle.agent || qqHandle;
    const asm = await ctx.systemPrompt.assemble({ scope: qqAgent, agent: qqAgent } as any);
    const toolNames = (asm.tools as any[]).map((t: any) => t.name);

    expect(toolNames).toContain('read_qzone_feeds');
    expect(toolNames).toContain('publish_qzone_feed');
    expect(toolNames).toContain('comment_qzone_feed');
    expect(toolNames).toContain('delete_qzone_feed');
  });
});

describe('契约 2: readQzoneFeeds 核心执行与数据转换契约', () => {
  it('2.1 好友流模式 (scope=friends)：正确映射结构化数据并下载多模态图片', async () => {
    const mockGateway: any = {
      callAction: vi.fn().mockImplementation((action: string) => {
        if (action === 'get_qzone_feeds') {
          return Promise.resolve({
            status: 'ok',
            retcode: 0,
            data: {
              feeds: [
                {
                  uin: 1000000002,
                  nickname: '好友小张',
                  time: 1793740000,
                  tid: 'tid_feed_001',
                  content: '今天去公园散步了！',
                  images: ['https://example.com/photo1.jpg'],
                  like_count: 5,
                  comment_count: 2,
                },
              ],
              attach_info: 'cursor_123',
            },
          });
        }
        if (action === 'get_qzone_msg_detail') {
          return Promise.resolve({
            status: 'ok',
            retcode: 0,
            data: {
              tid: 'tid_feed_001',
              comments: [
                {
                  uin: 1000000001,
                  name: 'AI助手',
                  time: 1793740500,
                  content: '风景真漂亮！',
                },
                {
                  uin: 1000000003,
                  name: '好友小李',
                  time: 1793740600,
                  content: '下次一起去',
                },
              ],
            },
          });
        }
        return Promise.resolve({ status: 'ok', retcode: 0, data: null });
      }),
    };

    const mockMediaManager: any = {
      downloadAndCacheMedia: vi.fn().mockResolvedValue('/data/cache/qzone/photo1.jpg'),
    };

    const res = await readQzoneFeeds(
      { scope: 'friends', limit: 5 },
      {
        gateway: mockGateway,
        mediaManager: mockMediaManager,
        botQq: '1000000001',
      }
    );

    expect(res.success).toBe(true);
    expect(res.scope).toBe('friends');
    expect(res.feeds).toHaveLength(1);

    const feed = res.feeds[0];
    expect(feed.feed_id).toBe('tid_feed_001');
    expect(feed.author.user_id).toBe(1000000002);
    expect(feed.author.nickname).toBe('好友小张');
    expect(feed.content).toBe('今天去公园散步了！');
    expect(feed.images).toHaveLength(1);
    expect(feed.images[0].url).toBe('https://example.com/photo1.jpg');
    expect(feed.images[0].local_path).toBe('/data/cache/qzone/photo1.jpg');

    // 验证评论区与 is_self 标识（1000000001 为 AI 自身）
    expect(feed.comments).toHaveLength(2);
    expect(feed.comments[0].is_self).toBe(true);
    expect(feed.comments[1].is_self).toBe(false);

    assertNoUndefinedDeep(res);
  });

  it('2.2 指定好友列表 (scope=user)：传递 target_uin 并做 limit 硬截断上限', async () => {
    const mockGateway: any = {
      callAction: vi.fn().mockResolvedValue({
        status: 'ok',
        retcode: 0,
        data: {
          total: 1,
          msglist: [
            {
              tid: 'tid_user_002',
              content: '好友独家动态',
              time: 1793741000,
              comment_num: 0,
              images: [],
            },
          ],
        },
      }),
    };

    const res = await readQzoneFeeds(
      { scope: 'user', target_qq: '1000000002', limit: 50 }, // 传入 50，应截断为 10
      { gateway: mockGateway, botQq: '1000000001' }
    );

    expect(res.success).toBe(true);
    expect(mockGateway.callAction).toHaveBeenCalledWith(
      'get_qzone_msg_list',
      expect.objectContaining({
        target_uin: 1000000002,
        num: 10, // 截断生效
      })
    );
    expect(res.feeds[0].feed_id).toBe('tid_user_002');
    assertNoUndefinedDeep(res);
  });

  it('2.3 自身动态为空时保底 (scope=self，msglist=null 兼容)', async () => {
    const mockGateway: any = {
      callAction: vi.fn().mockResolvedValue({
        status: 'ok',
        retcode: 0,
        data: {
          msglist: null, // 实测自身空间无说说时返回 null
        },
      }),
    };

    const res = await readQzoneFeeds(
      { scope: 'self' },
      { gateway: mockGateway, botQq: '1000000001' }
    );

    expect(res.success).toBe(true);
    expect(res.feeds).toEqual([]);
    assertNoUndefinedDeep(res);
  });
});

describe('契约 3: publishQzoneFeed 执行契约与冷却时间拦截', () => {
  it('3.1 正常发布纯文本说说与图片路径转换 (file:// 格式标准化)', async () => {
    const mockGateway: any = {
      callAction: vi.fn().mockResolvedValue({
        status: 'ok',
        retcode: 0,
        data: {
          tid: 'new_tid_001',
          time: 1793760000,
        },
      }),
    };

    const rateLimiter = new QzoneRateLimiter(60000, 15000);

    const res = await publishQzoneFeed(
      {
        content: '你好世界！',
        images: ['D:/mock/images/sample.png'],
      },
      {
        gateway: mockGateway,
        rateLimiter,
      }
    );

    expect(res.success).toBe(true);
    expect(res.feed_id).toBe('new_tid_001');
    expect(mockGateway.callAction).toHaveBeenCalledWith('send_qzone_msg', {
      content: '你好世界！',
      images: ['file:///D:/mock/images/sample.png'],
    });

    assertNoUndefinedDeep(res);
  });

  it('3.2 连续调用受到发动态冷却时间拦截 (60s 冷却)', async () => {
    const mockGateway: any = {
      callAction: vi.fn().mockResolvedValue({
        status: 'ok',
        retcode: 0,
        data: { tid: 'tid_ok' },
      }),
    };

    const rateLimiter = new QzoneRateLimiter(60000, 15000);

    // 第一次调用成功
    const res1 = await publishQzoneFeed(
      { content: '第一条动态' },
      { gateway: mockGateway, rateLimiter }
    );
    expect(res1.success).toBe(true);

    // 紧接着发起第二次调用，应被冷却拦截
    const res2 = await publishQzoneFeed(
      { content: '第二条动态' },
      { gateway: mockGateway, rateLimiter }
    );
    expect(res2.success).toBe(false);
    expect(res2.message).toContain('冷却保护中');

    assertNoUndefinedDeep(res2);
  });
});

describe('契约 4: commentQzoneFeed 评论执行契约与冷却拦截', () => {
  it('4.1 评论参数必填校验与发送', async () => {
    const mockGateway: any = {
      callAction: vi.fn().mockResolvedValue({
        status: 'ok',
        retcode: 0,
        data: null,
      }),
    };

    const rateLimiter = new QzoneRateLimiter(60000, 15000);

    const res = await commentQzoneFeed(
      {
        feed_id: 'tid_target',
        target_qq: '1000000002',
        content: '赞同这个想法！',
      },
      {
        gateway: mockGateway,
        rateLimiter,
      }
    );

    expect(res.success).toBe(true);
    expect(mockGateway.callAction).toHaveBeenCalledWith('comment_qzone', {
      tid: 'tid_target',
      target_uin: 1000000002,
      content: '赞同这个想法！',
    });

    assertNoUndefinedDeep(res);
  });

  it('4.2 评论冷却保护 (15s 冷却)', async () => {
    const mockGateway: any = {
      callAction: vi.fn().mockResolvedValue({ status: 'ok', retcode: 0 }),
    };

    const rateLimiter = new QzoneRateLimiter(60000, 15000);

    await commentQzoneFeed(
      { feed_id: 'tid_1', target_qq: 1000000002, content: '评1' },
      { gateway: mockGateway, rateLimiter }
    );

    const res2 = await commentQzoneFeed(
      { feed_id: 'tid_2', target_qq: 1000000002, content: '评2' },
      { gateway: mockGateway, rateLimiter }
    );

    expect(res2.success).toBe(false);
    expect(res2.message).toContain('冷却保护中');
    assertNoUndefinedDeep(res2);
  });
});

describe('契约 5: deleteQzoneFeed 删除动态契约', () => {
  it('5.1 删除动态成功调用 delete_qzone_msg', async () => {
    const mockGateway: any = {
      callAction: vi.fn().mockResolvedValue({
        status: 'ok',
        retcode: 0,
        data: null,
      }),
    };

    const res = await deleteQzoneFeed(
      { feed_id: 'tid_to_delete' },
      { gateway: mockGateway }
    );

    expect(res.success).toBe(true);
    expect(res.feed_id).toBe('tid_to_delete');
    expect(mockGateway.callAction).toHaveBeenCalledWith('delete_qzone_msg', {
      tid: 'tid_to_delete',
    });

    assertNoUndefinedDeep(res);
  });

  it('5.2 缺少 feed_id 时直接报错并满足 Lossless JSON', async () => {
    const res = await deleteQzoneFeed(
      { feed_id: '' } as any,
      { gateway: {} as any }
    );

    expect(res.success).toBe(false);
    expect(res.message).toContain('缺少');
    assertNoUndefinedDeep(res);
  });
});
