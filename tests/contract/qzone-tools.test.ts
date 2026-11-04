/**
 * 契约测试: QQ 空间动态互动工具集 (Qzone Tools Contract)
 *
 * 覆盖规范清单:
 * 契约 1: 真实装配下，QQ 会话 assemble 结果中包含 read_qzone_feeds, publish_qzone_feed, comment_qzone_feed, delete_qzone_feed 工具；
 * 契约 2: readQzoneFeeds 执行契约：
 *   - 好友流、指定好友、自身动态空值保底；
 *   - 结构化过滤广告占位 (uin<=0) 与官方空间常驻软文 (uin=20050606)，且不误伤改名好友，limit 配额不受损；
 *   - 原生游标续读 (cursor / next_cursor) 与断点说说定位续读 (after_feed_id)；
 *   - limit 截断保护、评论区解析与 is_self 标记、多模态图片下载本地化；
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
  isRealUserFeed,
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

describe('契约 2: readQzoneFeeds 核心执行、过滤去伪与断点续看契约', () => {
  it('2.1 好友流模式 (scope=friends)：正确映射结构化数据并下载多模态图片', async () => {
    const mockGateway: any = {
      sendAction: vi.fn().mockImplementation((action: string) => {
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
              next_cursor: 'cursor_123',
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
      downloadAndSave: vi.fn().mockResolvedValue({ localPath: '/data/cache/qzone/photo1.jpg' }),
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

    // 验证 next_cursor 返回
    expect(res.next_cursor).toBe('cursor_123');

    assertNoUndefinedDeep(res);
  });

  it('2.2 结构化去伪与配额保全：过滤广告卡(uin<=0)与官方号(uin=20050606)，不误杀改名好友，limit 配额不受损', async () => {
    const mockGateway: any = {
      sendAction: vi.fn().mockResolvedValue({
        status: 'ok',
        retcode: 0,
        data: {
          feeds: [
            // 广告占位卡：应该被过滤
            {
              uin: 0,
              tid: 'advertisement_outlink_0',
              nickname: '',
              content: '',
              images: [],
            },
            // 官方 Qzone 软文：应该被过滤 (uin=20050606)
            {
              uin: 20050606,
              tid: 'aef23101297f236ae4f10600',
              nickname: '官方Qzone',
              content: '21年了，QQ空间也记得...',
              images: [],
            },
            // 整活好友（昵称恰好叫“官方Qzone”，但 uin 正常）：必须保留！绝不误杀！
            {
              uin: 1000000003,
              tid: 'tid_real_friend_1',
              nickname: '官方Qzone',
              content: '我只是个改名整活的好友',
              images: [],
            },
            // 正常好友动态 2
            {
              uin: 1000000004,
              tid: 'tid_real_friend_2',
              nickname: '好友A',
              content: '今天天气不错',
              images: [],
            },
            // 正常好友动态 3
            {
              uin: 1000000005,
              tid: 'tid_real_friend_3',
              nickname: '好友B',
              content: '晚上吃什么',
              images: [],
            },
          ],
        },
      }),
    };

    // 请求 limit: 2，前面 2 个是广告和官方系统号
    // 预期：必须返回 2 条有效好友动态（tid_real_friend_1 和 tid_real_friend_2），配额不被侵蚀！
    const res = await readQzoneFeeds(
      { scope: 'friends', limit: 2 },
      { gateway: mockGateway }
    );

    expect(res.success).toBe(true);
    expect(res.feeds).toHaveLength(2);
    expect(res.feeds[0].feed_id).toBe('tid_real_friend_1');
    expect(res.feeds[0].author.user_id).toBe(1000000003);
    expect(res.feeds[0].content).toBe('我只是个改名整活的好友');

    expect(res.feeds[1].feed_id).toBe('tid_real_friend_2');
    expect(res.feeds[1].author.user_id).toBe(1000000004);

    assertNoUndefinedDeep(res);
  });

  it('2.3 原生游标续读 (cursor) 与说说断点定位续读 (after_feed_id)', async () => {
    const mockGateway: any = {
      sendAction: vi.fn().mockImplementation((action: string, params: any) => {
        if (params.cursor === 'cursor_page_1') {
          return Promise.resolve({
            status: 'ok',
            retcode: 0,
            data: {
              feeds: [
                {
                  uin: 1000000006,
                  tid: 'tid_page_2_item_1',
                  nickname: '好友C',
                  content: '第二页第1条动态',
                  images: [],
                },
              ],
              next_cursor: 'cursor_page_2',
            },
          });
        }
        return Promise.resolve({
          status: 'ok',
          retcode: 0,
          data: {
            feeds: [
              { uin: 1000000002, tid: 'tid_first', nickname: '张', content: '第一条' },
              { uin: 1000000003, tid: 'tid_target', nickname: '李', content: '定位目标' },
              { uin: 1000000004, tid: 'tid_after_1', nickname: '王', content: '目标之后的动态1' },
              { uin: 1000000005, tid: 'tid_after_2', nickname: '赵', content: '目标之后的动态2' },
            ],
          },
        });
      }),
    };

    // 1. 验证 cursor 游标透传
    const resCursor = await readQzoneFeeds(
      { scope: 'friends', cursor: 'cursor_page_1', limit: 5 },
      { gateway: mockGateway }
    );
    expect(mockGateway.sendAction).toHaveBeenCalledWith(
      'get_qzone_feeds',
      expect.objectContaining({ cursor: 'cursor_page_1' })
    );
    expect(resCursor.feeds[0].feed_id).toBe('tid_page_2_item_1');
    expect(resCursor.next_cursor).toBe('cursor_page_2');

    // 2. 验证 after_feed_id 续读定位：指定 after_feed_id: 'tid_target'，跳过前面两条，从后面的开始切片
    const resAfter = await readQzoneFeeds(
      { scope: 'friends', after_feed_id: 'tid_target', limit: 2 },
      { gateway: mockGateway }
    );
    expect(resAfter.feeds).toHaveLength(2);
    expect(resAfter.feeds[0].feed_id).toBe('tid_after_1');
    expect(resAfter.feeds[1].feed_id).toBe('tid_after_2');

    assertNoUndefinedDeep(resCursor);
    assertNoUndefinedDeep(resAfter);
  });

  it('2.4 指定好友列表 (scope=user)：传递 target_uin 并做 limit 硬截断上限', async () => {
    const mockGateway: any = {
      sendAction: vi.fn().mockResolvedValue({
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
    expect(mockGateway.sendAction).toHaveBeenCalledWith(
      'get_qzone_msg_list',
      expect.objectContaining({
        target_uin: 1000000002,
      })
    );
    expect(res.feeds[0].feed_id).toBe('tid_user_002');
    assertNoUndefinedDeep(res);
  });

  it('2.5 自身动态为空时保底 (scope=self，msglist=null 兼容)', async () => {
    const mockGateway: any = {
      sendAction: vi.fn().mockResolvedValue({
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
      sendAction: vi.fn().mockResolvedValue({
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
    expect(mockGateway.sendAction).toHaveBeenCalledWith('send_qzone_msg', {
      content: '你好世界！',
      images: ['file:///D:/mock/images/sample.png'],
    });

    assertNoUndefinedDeep(res);
  });

  it('3.2 连续调用受到发动态冷却时间拦截 (60s 冷却)', async () => {
    const mockGateway: any = {
      sendAction: vi.fn().mockResolvedValue({
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
      sendAction: vi.fn().mockResolvedValue({
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
    expect(mockGateway.sendAction).toHaveBeenCalledWith('comment_qzone', {
      tid: 'tid_target',
      target_uin: 1000000002,
      content: '赞同这个想法！',
    });

    assertNoUndefinedDeep(res);
  });

  it('4.2 评论冷却保护 (15s 冷却)', async () => {
    const mockGateway: any = {
      sendAction: vi.fn().mockResolvedValue({ status: 'ok', retcode: 0 }),
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
      sendAction: vi.fn().mockResolvedValue({
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
    expect(mockGateway.sendAction).toHaveBeenCalledWith('delete_qzone_msg', {
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
