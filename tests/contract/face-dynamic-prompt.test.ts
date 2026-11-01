/**
 * tests/contract/face-dynamic-prompt.test.ts
 * 契约测试: 表情包动态情绪锚点 System Prompt 上下文注入
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { MessageDatabase } from '../../src/storage/database.js';
import { registerFacePromptContext } from '../../src/prompt/dynamic.js';

describe('契约测试: 表情包动态情绪锚点 System Prompt 上下文注入', () => {
  let tmpDir: string;
  let db: MessageDatabase;
  let registeredPrompts: Map<string, any>;
  let mockSystemPrompt: any;
  let mockCtx: any;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-face-prompt-'));
    db = new MessageDatabase(path.join(tmpDir, 'test.db'));

    registeredPrompts = new Map();
    mockSystemPrompt = {
      context: vi.fn().mockImplementation((opts: any) => {
        registeredPrompts.set(opts.name, opts);
        return () => {
          registeredPrompts.delete(opts.name);
        };
      }),
    };

    mockCtx = {
      get: (name: string) => {
        if (name === 'systemPrompt') return mockSystemPrompt;
        return undefined;
      },
    };
  });

  afterEach(() => {
    try {
      db.close();
    } catch {}
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it('契约 1: registerFacePromptContext 正确注册 napcat:face_summary 且 order 为 48', () => {
    const unregister = registerFacePromptContext(mockCtx, db, () => true);

    expect(mockSystemPrompt.context).toHaveBeenCalled();
    expect(registeredPrompts.has('napcat:face_summary')).toBe(true);

    const promptObj = registeredPrompts.get('napcat:face_summary');
    expect(promptObj.order).toBe(48);

    // 释放检查
    unregister();
    expect(registeredPrompts.has('napcat:face_summary')).toBe(false);
  });

  it('契约 2: QQ 会话且库内有表情时，注入总数与 Top 情绪分布概览', () => {
    // 注入测试表情
    db.insertFace({
      id: 'f1',
      file_path: '/path/f1.png',
      md5: 'md5_1',
      source: 'manual',
      tags: ['猫猫'],
      mood: '卖萌',
      enabled: true,
      size: 1024,
      format: 'png',
    });
    db.insertFace({
      id: 'f2',
      file_path: '/path/f2.png',
      md5: 'md5_2',
      source: 'manual',
      tags: ['小猫'],
      mood: '卖萌',
      enabled: true,
      size: 1024,
      format: 'png',
    });
    db.insertFace({
      id: 'f3',
      file_path: '/path/f3.png',
      md5: 'md5_3',
      source: 'manual',
      tags: ['熊猫头'],
      mood: '调侃',
      enabled: true,
      size: 1024,
      format: 'png',
    });

    registerFacePromptContext(mockCtx, db, () => true);
    const promptObj = registeredPrompts.get('napcat:face_summary');

    const assembleCtx = {
      agent: {
        session: { id: 'qq-group-12345678' },
      },
    };

    const text = promptObj.text(assembleCtx);
    expect(text).toContain('本地表情库概览');
    expect(text).toContain('共 3 张表情包');
    expect(text).toContain('卖萌(2)');
    expect(text).toContain('调侃(1)');
    expect(text).toContain('list_faces');
    expect(text).toContain('send_face');
  });

  it('契约 3: QQ 会话且库为空时，注入友好收录引导文案', () => {
    registerFacePromptContext(mockCtx, db, () => true);
    const promptObj = registeredPrompts.get('napcat:face_summary');

    const assembleCtx = {
      agent: {
        session: { id: 'qq-user-87654321' },
      },
    };

    const text = promptObj.text(assembleCtx);
    expect(text).toContain('当前库为空');
    expect(text).toContain('collect_face');
  });

  it('契约 4: 当 face_enabled 为 false 时，始终输出空字符串', () => {
    db.insertFace({
      id: 'f1',
      file_path: '/path/f1.png',
      md5: 'md5_1',
      source: 'manual',
      tags: ['猫猫'],
      mood: '卖萌',
      enabled: true,
      size: 1024,
      format: 'png',
    });

    registerFacePromptContext(mockCtx, db, () => false); // 禁用
    const promptObj = registeredPrompts.get('napcat:face_summary');

    const assembleCtx = {
      agent: {
        session: { id: 'qq-group-12345678' },
      },
    };

    const text = promptObj.text(assembleCtx);
    expect(text).toBe('');
  });

  it('契约 5: 非 QQ 会话（如 Web UI）时静默，输出为空字符串', () => {
    db.insertFace({
      id: 'f1',
      file_path: '/path/f1.png',
      md5: 'md5_1',
      source: 'manual',
      tags: ['猫猫'],
      mood: '卖萌',
      enabled: true,
      size: 1024,
      format: 'png',
    });

    registerFacePromptContext(mockCtx, db, () => true);
    const promptObj = registeredPrompts.get('napcat:face_summary');

    const assembleCtx = {
      agent: {
        session: { id: 'web-assistant-session-999' },
      },
    };

    const text = promptObj.text(assembleCtx);
    expect(text).toBe('');
  });
});
