/**
 * tests/contract/attachment-image-input.test.ts
 *
 * 契约测试: 入站 payload.images 接通 DSH ImageBlock
 *
 * 背景:
 * WakeupPayload.images 一直只存在于唤醒包与文本占位里，模型实际收不到图片。
 * DSH 真实契约要求图片块必须由 ctx.attachments.saveImage() 生成
 * ImageAttachmentRef，不能伪造路径或 base64 URL。
 *
 * 覆盖规范:
 * 1. 真实 boot 装配下 dispatchWakeup(payload.images) → user message 含 image block；
 * 2. 文件不存在 / 魔数无法识别 / attachments 服务缺失 → 降级纯文本，不抛错；
 * 3. 多张图片顺序与 payload.images 一致。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fsp } from 'node:fs';
import { bootDshNapcatBridge, type BootedDsh } from '../../src/boot.js';
import type { WakeupPayload } from '../../src/types/index.js';

const BOT_QQ = '1000000000';
const GROUP_ID = '8000000001';

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);

function wakeupPayload(images: string[]): WakeupPayload {
  return {
    peer: `group_${GROUP_ID}`,
    trigger: 'direct',
    from_user: '1000000001',
    from_name: '测试成员',
    content: '[图片: 见附件]',
    timestamp: 1793800000000,
    images,
  };
}

function imageBlocks(userMsg: any): any[] {
  const content = userMsg?.content;
  if (!Array.isArray(content)) return [];
  return content.filter((block) => block && block.type === 'image');
}

describe('契约测试: payload.images → DSH ImageBlock 真实装配', () => {
  let tmpHome: string;
  let booted: BootedDsh | undefined;

  async function waitFor<T>(probe: () => T | undefined, timeoutMs = 8000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = probe();
      if (value !== undefined) return value;
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('等待装配就绪超时');
  }

  beforeEach(async () => {
    tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-attachment-image-'));
    booted = await bootDshNapcatBridge({
      dshHome: tmpHome,
      mountPlugin: true,
      config: {
        bot_qq: BOT_QQ,
        ws_port: 29874,
        ws_token: 'test-mock-token',
      },
    });
  });

  afterEach(async () => {
    if (booted) {
      await booted.dispose().catch(() => {});
      booted = undefined;
    }
    if (tmpHome) {
      await fsp.rm(tmpHome, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('契约 1: 本地 PNG 图片 → user message 含 image block 与持久化引用', async () => {
    const sessionManager: any = await waitFor(() => {
      const c: any = booted!.ctx;
      return (c.get?.('napcat-session') || c['napcat-session']) as any;
    });

    const imgPath = path.join(tmpHome, 'inbound-1.png');
    await fsp.writeFile(imgPath, PNG_1X1);

    const userMsg = await sessionManager.dispatchWakeup(wakeupPayload([imgPath]));

    const blocks = imageBlocks(userMsg);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].attachment).toBeDefined();
    expect(blocks[0].attachment.attachmentId).toBeTruthy();
    expect(blocks[0].attachment.mediaType).toBe('image/png');
    expect(blocks[0].attachment.bytes).toBe(PNG_1X1.length);

    // 文本占位必须保留，模型仍能看到消息正文与图片说明
    expect(userMsg.content.some((b: any) => b.type === 'text' && b.text.includes('[图片'))).toBe(true);
  });

  it('契约 2: 文件不存在 / 魔数未知 → 降级纯文本，不抛错', async () => {
    const sessionManager: any = await waitFor(() => {
      const c: any = booted!.ctx;
      return (c.get?.('napcat-session') || c['napcat-session']) as any;
    });

    const unknown = path.join(tmpHome, 'unknown.bin');
    await fsp.writeFile(unknown, Buffer.from('not an image at all'));

    const userMsg = await sessionManager.dispatchWakeup(
      wakeupPayload([path.join(tmpHome, 'missing.png'), unknown])
    );

    expect(imageBlocks(userMsg)).toHaveLength(0);
    expect(userMsg.content.some((b: any) => b.type === 'text')).toBe(true);
  });

  it('契约 3: 多张图片顺序与 payload.images 一致', async () => {
    const sessionManager: any = await waitFor(() => {
      const c: any = booted!.ctx;
      return (c.get?.('napcat-session') || c['napcat-session']) as any;
    });

    const first = path.join(tmpHome, 'first.png');
    const second = path.join(tmpHome, 'second.png');
    await fsp.writeFile(first, PNG_1X1);
    await fsp.writeFile(second, PNG_1X1);

    const userMsg = await sessionManager.dispatchWakeup(wakeupPayload([first, second]));

    const blocks = imageBlocks(userMsg);
    expect(blocks).toHaveLength(2);
    // DSH 的 attachment name 会保留调用方显示名（不含路径），据此断言入参顺序
    expect(blocks[0].attachment.name).toBe('first.png');
    expect(blocks[1].attachment.name).toBe('second.png');
  });
});
