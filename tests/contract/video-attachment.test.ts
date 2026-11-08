/**
 * tests/contract/video-attachment.test.ts
 *
 * 契约测试: 视频消息双端适配与按需拉取契约 (TDD)
 *
 * 核心契约保证：
 * 1. 渲染层：renderAttachment 对 video 支持 local.path、remote.fileId、fileName、unavailable 等语义化渲染；
 * 2. 唤醒层：parseNormalizedContent 正确将入站 video 段渲染为语义化占位符（群聊拼 ID、私聊带物理路径）；
 * 3. 工具层：fetch_chat_resource 在群聊上下文中放行无 busid 视频，优先直链下载 -> 回退 get_file -> SnowLuma 错误垫片。
 */

import { describe, it, expect, vi } from 'vitest';
import { renderAttachment } from '../../src/attachment/render.js';
import { parseNormalizedContent } from '../../src/gateway/wakeup.js';
import { fetchChatResource } from '../../src/tools/index.js';
import type { AttachmentDescriptor } from '../../src/attachment/types.js';

describe('契约 1: 视频附件描述符语义化渲染 (renderAttachment)', () => {
  it('无任何元数据时保持兜底 [视频]', () => {
    const desc: AttachmentDescriptor = {
      kind: 'video',
      origin: 'inbound',
    };
    expect(renderAttachment(desc)).toBe('[视频]');
  });

  it('群聊未落盘时呈现 [视频 (ID:<file_id>)]', () => {
    const desc: AttachmentDescriptor = {
      kind: 'video',
      origin: 'inbound',
      remote: {
        fileId: 'BV1o1HN6YExH-1.mp4',
        url: 'https://multimedia.nt.qq.com.cn/download?appid=1415&spec=0',
      },
    };
    expect(renderAttachment(desc)).toBe('[视频 (ID:BV1o1HN6YExH-1.mp4)]');
  });

  it('群聊若带独立文件名则呈现 [视频:<fileName> (ID:<file_id>)]', () => {
    const desc: AttachmentDescriptor = {
      kind: 'video',
      origin: 'inbound',
      fileName: '精彩集锦.mp4',
      remote: {
        fileId: 'adad90e6bacb93d30a9f8e575542befc.mp4',
      },
    };
    expect(renderAttachment(desc)).toBe('[视频:精彩集锦.mp4 (ID:adad90e6bacb93d30a9f8e575542befc.mp4)]');
  });

  it('若文件名与 file_id 完全一致则不产生冗余冒号前缀', () => {
    const desc: AttachmentDescriptor = {
      kind: 'video',
      origin: 'inbound',
      fileName: 'BV1o1HN6YExH-1.mp4',
      remote: {
        fileId: 'BV1o1HN6YExH-1.mp4',
      },
    };
    expect(renderAttachment(desc)).toBe('[视频 (ID:BV1o1HN6YExH-1.mp4)]');
  });

  it('私聊或已落盘时呈现 [视频 已保存: <local_path>]', () => {
    const desc: AttachmentDescriptor = {
      kind: 'video',
      origin: 'inbound',
      local: {
        path: 'C:\\data\\downloads\\files\\user_1000000001\\BV1o1HN6YExH-1.mp4',
      },
    };
    expect(renderAttachment(desc)).toBe(
      '[视频 已保存: C:\\data\\downloads\\files\\user_1000000001\\BV1o1HN6YExH-1.mp4]'
    );
  });

  it('已落盘且带独立文件名呈现 [视频:<fileName> 已保存: <local_path>]', () => {
    const desc: AttachmentDescriptor = {
      kind: 'video',
      origin: 'inbound',
      fileName: '实况录屏.mp4',
      local: {
        path: 'C:\\data\\downloads\\files\\user_1000000001\\live.mp4',
      },
    };
    expect(renderAttachment(desc)).toBe(
      '[视频:实况录屏.mp4 已保存: C:\\data\\downloads\\files\\user_1000000001\\live.mp4]'
    );
  });

  it('落盘失败时如实标记 [视频 (入站落盘失败)]', () => {
    const desc: AttachmentDescriptor = {
      kind: 'video',
      origin: 'inbound',
      remote: {
        fileId: 'bad_video.mp4',
      },
      unavailable: 'inbound_failed',
    };
    expect(renderAttachment(desc)).toBe('[视频 (ID:bad_video.mp4) (入站落盘失败)]');
  });
});

describe('契约 2: 入站唤醒文本解析 (parseNormalizedContent)', () => {
  it('群聊收到视频段未下载时拼入 [视频 (ID:<file_id>)]', () => {
    const event = {
      post_type: 'message',
      message_type: 'group',
      group_id: 3000000001,
      user_id: 1000000002,
      message_id: 12345,
      time: 1700000000,
      message: [
        { type: 'text', data: { text: '看看这个：' } },
        {
          type: 'video',
          data: {
            file: 'BV1o1HN6YExH-1.mp4',
            url: 'https://multimedia.nt.qq.com.cn/download?appid=1415',
          },
        },
      ],
    };

    const res = parseNormalizedContent(event);
    expect(res.content).toBe('看看这个：[视频 (ID:BV1o1HN6YExH-1.mp4)]');
  });

  it('私聊收到已落盘视频段时拼入 [视频 已保存: <local_path>]', () => {
    const event = {
      post_type: 'message',
      message_type: 'private',
      user_id: 1000000001,
      message_id: 12346,
      time: 1700000000,
      message: [
        {
          type: 'video',
          data: {
            file: 'BV1o1HN6YExH-1.mp4',
            local_path: 'C:\\data\\downloads\\files\\user_1000000001\\BV1o1HN6YExH-1.mp4',
          },
        },
      ],
    };

    const res = parseNormalizedContent(event);
    expect(res.content).toBe(
      '[视频 已保存: C:\\data\\downloads\\files\\user_1000000001\\BV1o1HN6YExH-1.mp4]'
    );
  });
});

describe('契约 3: 群聊无 busid 视频按需拉取与双端兼容 (fetch_chat_resource)', () => {
  it('首选直链通道：库中有 remote.url 时优先直接使用直链下载落盘', async () => {
    const fakeDb = {
      getByFileId: vi.fn().mockReturnValue({
        file_id: 'BV1o1HN6YExH-1.mp4',
        type: 'video',
        local_path: null,
        attachments: JSON.stringify([
          {
            kind: 'video',
            origin: 'inbound',
            remote: {
              fileId: 'BV1o1HN6YExH-1.mp4',
              url: 'https://multimedia.nt.qq.com.cn/download?test=1',
            },
          },
        ]),
      }),
      saveMessage: vi.fn(),
      saveMessageIfNotExists: vi.fn(),
    };

    const fakeMediaManager = {
      downloadAndSave: vi.fn().mockResolvedValue({
        localPath: 'C:\\data\\files\\group_3000000001\\BV1o1HN6YExH-1.mp4',
      }),
    };

    const fakeGateway = {
      getFile: vi.fn(),
    };

    const res = await fetchChatResource(
      { file_id: 'BV1o1HN6YExH-1.mp4' },
      {
        db: fakeDb as any,
        mediaManager: fakeMediaManager as any,
        gateway: fakeGateway as any,
        groupId: '3000000001',
        peer: 'group_3000000001',
      }
    );

    expect(res.success).toBe(true);
    expect(res.local_path).toBe('C:\\data\\files\\group_3000000001\\BV1o1HN6YExH-1.mp4');
    expect(fakeMediaManager.downloadAndSave).toHaveBeenCalledWith(
      'https://multimedia.nt.qq.com.cn/download?test=1',
      expect.objectContaining({
        fileId: 'BV1o1HN6YExH-1.mp4',
      })
    );
    // 直链可用时不需要调用 gateway.getFile
    expect(fakeGateway.getFile).not.toHaveBeenCalled();
  });

  it('直链失效时回退 NapCat get_file 动态刷新并落盘', async () => {
    const fakeDb = {
      getByFileId: vi.fn().mockReturnValue(null), // 库中未查到直链
      saveMessage: vi.fn(),
    };

    const fakeMediaManager = {
      downloadAndSave: vi.fn().mockResolvedValue({
        localPath: 'C:\\data\\files\\group_3000000001\\refreshed.mp4',
      }),
    };

    const fakeGateway = {
      getFile: vi.fn().mockResolvedValue({
        status: 'ok',
        retcode: 0,
        data: {
          url: 'https://multimedia.nt.qq.com.cn/download?refreshed=1',
          file_name: 'refreshed.mp4',
        },
      }),
    };

    const res = await fetchChatResource(
      { file_id: 'refreshed.mp4' },
      {
        db: fakeDb as any,
        mediaManager: fakeMediaManager as any,
        gateway: fakeGateway as any,
        groupId: '3000000001',
        peer: 'group_3000000001',
      }
    );

    expect(res.success).toBe(true);
    expect(res.local_path).toBe('C:\\data\\files\\group_3000000001\\refreshed.mp4');
    expect(fakeGateway.getFile).toHaveBeenCalledWith('refreshed.mp4');
  });

  it('SnowLuma 垫片：若 get_file 报错 image/voice cache 限制，返回友好诊断提示', async () => {
    const fakeDb = {
      getByFileId: vi.fn().mockReturnValue(null),
    };

    const fakeMediaManager = {
      downloadAndSave: vi.fn(),
    };

    const fakeGateway = {
      getFile: vi.fn().mockResolvedValue({
        status: 'failed',
        retcode: 100,
        wording: 'file_id not found in the image/voice cache. get_file only resolves cached image/voice ids...',
      }),
    };

    const res = await fetchChatResource(
      { file_id: 'snowluma_expired.mp4' },
      {
        db: fakeDb as any,
        mediaManager: fakeMediaManager as any,
        gateway: fakeGateway as any,
        groupId: '3000000001',
        peer: 'group_3000000001',
      }
    );

    expect(res.success).toBe(false);
    expect(res.error).toContain('SnowLuma');
    expect(res.error).toContain('image/voice cache');
  });
});
