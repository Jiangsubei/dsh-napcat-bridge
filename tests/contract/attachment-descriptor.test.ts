/**
 * tests/contract/attachment-descriptor.test.ts
 *
 * 契约测试: 统一附件描述符 (Attachment Descriptor)
 *
 * 背景:
 * 入站/出站各自推导 kind / file_id / local_path / 渲染文本，导致
 *  - 出站表情只落 file:/// URI，历史里没有 face_id 与情绪；
 *  - 远端 file_id（自带 .png 伪后缀）与本地魔数格式（jpg）混为一谈。
 *
 * 本契约锁定唯一事实源：
 * 1. classifySegment 是唯一 kind 判定；
 * 2. 远端 fileId 与本地 format 彻底解耦；
 * 3. renderAttachment 是唯一渲染入口，入站/出站文案一致；
 * 4. serializeAttachments / deserializeAttachments 无损往返；
 * 5. describeMessage / toMessageMediaFields 与入站落库口径一致。
 */

import { describe, it, expect } from 'vitest';
import {
  classifySegment,
  describeSegment,
  describeMessage,
  toMessageMediaFields,
} from '../../src/attachment/classify.js';
import { renderAttachment } from '../../src/attachment/render.js';
import {
  serializeAttachments,
  deserializeAttachments,
} from '../../src/attachment/store.js';
import type { AttachmentDescriptor } from '../../src/attachment/types.js';

const GROUP = { isGroup: true };
const PRIVATE = { isGroup: false };

describe('契约测试: 附件 kind 判定唯一化', () => {
  it('契约 1: image / sticker / file / group_file / record / video / forward 判定一致', () => {
    expect(classifySegment({ type: 'image', data: {} }, GROUP)).toBe('image');
    expect(classifySegment({ type: 'image', data: { sub_type: 1 } }, GROUP)).toBe('sticker');
    expect(classifySegment({ type: 'image', data: { emoji_package_id: 123 } }, GROUP)).toBe('sticker');
    expect(classifySegment({ type: 'file', data: {} }, GROUP)).toBe('group_file');
    expect(classifySegment({ type: 'file', data: {} }, PRIVATE)).toBe('file');
    expect(classifySegment({ type: 'record', data: {} }, GROUP)).toBe('record');
    expect(classifySegment({ type: 'video', data: {} }, GROUP)).toBe('video');
    expect(classifySegment({ type: 'forward', data: {} }, GROUP)).toBe('forward');
    expect(classifySegment({ type: 'text', data: { text: 'hi' } }, GROUP)).toBeNull();
    expect(classifySegment({ type: 'at', data: { qq: '1' } }, GROUP)).toBeNull();
  });
});

describe('契约测试: 远端标识与本地事实解耦', () => {
  it('契约 2: file:/// URI 转为 OS 路径，且不写入 remote.fileId', () => {
    const d = describeSegment(
      {
        type: 'image',
        data: { file: 'file:///C:/tmp/outbound-image.png', local_format: 'png' },
      },
      { origin: 'outbound', isGroup: true }
    )!;

    expect(d.kind).toBe('image');
    expect(d.local?.path?.endsWith('outbound-image.png')).toBe(true);
    expect(d.local?.path?.startsWith('file:///')).toBe(false);
    expect(d.remote?.fileId).toBeUndefined();
  });

  it('契约 3: file_id 带 .png 伪后缀、本地魔数实际为 jpg → 两者分别保留', () => {
    const d = describeSegment(
      {
        type: 'image',
        data: {
          file: 'ABCDEF0123456789ABCDEF0123456789.png',
          local_path: '/data/downloads/image/group_1/abc.jpg',
          local_format: 'jpg',
          file_size: 4567,
        },
      },
      { origin: 'inbound', isGroup: true }
    )!;

    expect(d.remote?.fileId).toBe('ABCDEF0123456789ABCDEF0123456789.png');
    expect(d.local?.path).toBe('/data/downloads/image/group_1/abc.jpg');
    expect(d.local?.format).toBe('jpg');
    expect(d.local?.size).toBe(4567);
  });

  it('契约 4: 出站 data.file 为 file:/// 时不会被误当成远端 file_id', () => {
    const d = describeSegment(
      { type: 'file', data: { file: 'file:///C:/tmp/report.pdf' } },
      { origin: 'outbound', isGroup: false }
    )!;

    expect(d.kind).toBe('file');
    expect(d.remote?.fileId).toBeUndefined();
    expect(d.local?.path?.endsWith('report.pdf')).toBe(true);
  });
});

describe('契约测试: 唯一渲染入口', () => {
  function render(d: AttachmentDescriptor): string {
    const text = renderAttachment(d);
    expect(text).not.toBeNull();
    return text as string;
  }

  it('契约 5: 命中表情库时入站/出站文案完全一致（face_id + 情绪 + 路径）', () => {
    const base = {
      kind: 'sticker' as const,
      local: { path: '/faces/face_x.png', format: 'png' },
      face: { id: 'face_x', mood: '嘲讽' },
      summary: '滑稽',
    };
    const inbound = render({ ...base, origin: 'inbound' });
    const outbound = render({ ...base, origin: 'outbound' });

    expect(inbound).toBe('[表情包: face_x (情绪: 嘲讽) 路径: /faces/face_x.png]');
    expect(outbound).toBe(inbound);
  });

  it('契约 6: 未命中表情库但有本地路径 → 规范路径展示且清洗方括号，不展示 file:///', () => {
    const text = render({
      kind: 'sticker',
      origin: 'outbound',
      summary: '滑稽',
      local: { path: '/faces/funny.png' },
    });
    expect(text).toBe('[表情包: 滑稽 路径: /faces/funny.png]');
    expect(text).not.toContain('file:///');

    // 嵌套方括号清洗验证：[动画表情] -> 动画表情
    const textNested = render({
      kind: 'sticker',
      origin: 'inbound',
      summary: '[动画表情]',
      local: { path: '/faces/c393b.jpg' },
    });
    expect(textNested).toBe('[表情包: 动画表情 路径: /faces/c393b.jpg]');
  });

  it('契约 7: 普通图片本地路径优先，file:/// 转为 OS 路径', () => {
    const text = render({
      kind: 'image',
      origin: 'outbound',
      local: { path: '/tmp/outbound-image.png' },
      remote: { url: 'https://example.com/a.png' },
    });
    expect(text).toBe('[图片:/tmp/outbound-image.png]');
    expect(text).not.toContain('file:///');
  });

  it('契约 8: 无本地文件时普通图片优先展示远程 URL', () => {
    expect(
      render({
        kind: 'image',
        origin: 'inbound',
        remote: { fileId: 'ABC.png', url: 'https://multimedia.example/a' },
      })
    ).toBe('[图片:https://multimedia.example/a]');
  });

  it('契约 9: 私聊文件落盘失败如实标注；群文件保留 ID 占位', () => {
    expect(
      render({
        kind: 'file',
        origin: 'inbound',
        fileName: '报告.pdf',
        unavailable: 'inbound_failed',
      })
    ).toBe('[文件:报告.pdf (入站落盘失败)]');

    expect(
      render({
        kind: 'group_file',
        origin: 'inbound',
        fileName: '周报.pdf',
        remote: { fileId: 'group-file-1', busid: 102 },
      })
    ).toBe('[群文件:周报.pdf (ID:group-file-1)]');
  });

  it('契约 10: 私聊文件有本地路径 → 已保存真实路径', () => {
    expect(
      render({
        kind: 'file',
        origin: 'inbound',
        fileName: '报告.pdf',
        local: { path: '/data/downloads/file/user_1/report.pdf' },
      })
    ).toBe('[文件:报告.pdf 已保存: /data/downloads/file/user_1/report.pdf]');
  });

  it('契约 11: 语音 / 视频 / 合并转发保持既有占位', () => {
    expect(render({ kind: 'record', origin: 'inbound' })).toBe('[语音]');
    expect(render({ kind: 'video', origin: 'inbound' })).toBe('[视频]');
    expect(render({ kind: 'forward', origin: 'inbound', remote: { forwardId: 'fw_1' } })).toBe(
      '[合并转发 (ID:fw_1)]'
    );
  });
});

describe('契约测试: 描述符落库映射与序列化', () => {
  it('契约 12: describeMessage 与入站主导类型/媒体字段口径一致', () => {
    const summary = describeMessage(
      [
        { type: 'text', data: { text: '看图' } },
        {
          type: 'image',
          data: {
            file: 'REMOTE_IMAGE.png',
            local_path: '/data/downloads/image/group_1/real.jpg',
            local_format: 'jpg',
            fingerprint: 'fp-1',
          },
        },
        {
          type: 'file',
          data: { file_id: 'group-file-1', file_name: '周报.pdf', busid: 102 },
        },
      ],
      { origin: 'inbound', isGroup: true }
    );

    // 与既有入站口径一致：file 段无条件覆盖主导类型（即便前面已有图片）
    expect(summary.type).toBe('group_file');
    expect(summary.attachments).toHaveLength(2);
    expect(summary.attachments[0].kind).toBe('image');
    expect(summary.attachments[1].kind).toBe('group_file');

    const fields = toMessageMediaFields(summary);
    expect(fields.file_id).toBe('REMOTE_IMAGE.png');
    expect(fields.local_path).toBe('/data/downloads/image/group_1/real.jpg');
    expect(fields.fingerprint).toBe('fp-1');
    expect(fields.busid).toBe(102);
  });

  it('契约 13: 非附件段主导类型（reply/at/poke/json）保持既有口径', () => {
    expect(
      describeMessage([{ type: 'reply', data: { id: 1 } }, { type: 'text', data: { text: 'x' } }], {
        origin: 'inbound',
        isGroup: true,
      }).type
    ).toBe('reply');
    expect(
      describeMessage([{ type: 'at', data: { qq: '1' } }], { origin: 'inbound', isGroup: true }).type
    ).toBe('at');
    expect(
      describeMessage([{ type: 'poke', data: {} }], { origin: 'inbound', isGroup: true }).type
    ).toBe('poke');
    expect(
      describeMessage([{ type: 'json', data: {} }], { origin: 'inbound', isGroup: true }).type
    ).toBe('json');
  });

  it('契约 14: serializeAttachments / deserializeAttachments 无损往返且非法 JSON 回退空数组', () => {
    const descriptors: AttachmentDescriptor[] = [
      {
        kind: 'sticker',
        origin: 'outbound',
        local: { path: '/faces/a.png', format: 'png', md5: 'abc' },
        face: { id: 'face_a', mood: '开心', tags: ['猫猫'] },
        summary: '猫',
      },
      {
        kind: 'group_file',
        origin: 'inbound',
        fileName: '周报.pdf',
        remote: { fileId: 'gf-1', busid: 102 },
      },
    ];

    const json = serializeAttachments(descriptors);
    expect(typeof json).toBe('string');
    const restored = deserializeAttachments(json);
    expect(restored).toEqual(descriptors);

    expect(deserializeAttachments(null)).toEqual([]);
    expect(deserializeAttachments('')).toEqual([]);
    expect(deserializeAttachments('{not-json')).toEqual([]);
    expect(deserializeAttachments('{"foo":1}')).toEqual([]);
  });

  it('契约 15: 描述符 JSON 中不出现 undefined 字段', () => {
    const json = serializeAttachments([
      { kind: 'image', origin: 'outbound', local: { path: '/tmp/a.png' } },
    ])!;
    const parsed = JSON.parse(json);
    expect(JSON.stringify(parsed)).not.toContain('undefined');
    expect(Object.keys(parsed[0]).sort()).toEqual(['kind', 'local', 'origin']);
  });
});
