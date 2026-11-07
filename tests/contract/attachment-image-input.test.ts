/**
 * tests/contract/attachment-image-input.test.ts
 *
 * 契约测试: 入站回归纯文本路径模式（绝不自动注入 ImageBlock，大模型统一通过路径自主按需读图）
 *
 * 背景:
 * 入站若直接塞 ImageBlock，在水群与斗图场景下会巨幅消耗 Vision Token，且入站格式与历史记录 (read_chat_history)
 * 割裂；回归纯文本路径模式后，模型通过文本中的确定性文件路径感知图片，必要时自主调用 read_image。
 *
 * 覆盖规范:
 * 1. 真实 boot 装配下 dispatchWakeup(payload.images) → user message 为纯文本，不注入 image block；
 * 2. 多张图片入站时同样保持纯文本模式，Prompt 保留文本与路径。
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

describe('契约测试: payload.images → 纯文本按需模式真实装配', () => {
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

  it('契约 1: 本地 PNG 图片入站 → user message 为纯文本，绝不注入 image block', async () => {
    const sessionManager: any = await waitFor(() => {
      const c: any = booted!.ctx;
      return (c.get?.('napcat-session') || c['napcat-session']) as any;
    });

    const imgPath = path.join(tmpHome, 'inbound-1.png');
    await fsp.writeFile(imgPath, PNG_1X1);

    const userMsg = await sessionManager.dispatchWakeup(wakeupPayload([imgPath]));

    const blocks = imageBlocks(userMsg);
    expect(blocks).toHaveLength(0);

    // 纯文本形式呈现，包含消息文本内容
    expect(userMsg.content).toHaveLength(1);
    expect(userMsg.content[0].type).toBe('text');
    expect(userMsg.content[0].text).toContain('[图片: 见附件]');
  });

  it('契约 2: 多张图片入站 → 依然保持纯文本模式，不向 context 注入任何 image block', async () => {
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
    expect(blocks).toHaveLength(0);
    expect(userMsg.content).toHaveLength(1);
    expect(userMsg.content[0].type).toBe('text');
  });
});
