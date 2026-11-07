/**
 * tests/contract/read-chat-history-sticker-path.test.ts
 *
 * 契约测试: read_chat_history 表情包路径补齐与格式归一化契约
 *
 * 覆盖规范:
 * 1. 库内表情新记录：含 [表情包: face_id (情绪: mood) 路径: <local_path>]，文本渲染带路径，下游可直接调用 read_image；
 * 2. 库内表情存量旧记录：content 仅含 face_id + 情绪、local_path 为 NULL，readHistory 自动查 faces 表兜底补齐路径；
 * 3. 普通表情存量旧记录：含 [表情包:[动画表情] 已保存: <path>]，自动清洗嵌套方括号为 [表情包: 动画表情 路径: <path>]；
 * 4. 真实工具装配闭环：通过 read_chat_history defineTool execute 与 output.render 验证 Markdown 文本与结构化结果。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fsp } from 'node:fs';
import { Context } from '@deepseek-ai/cordis';
import { MessageDatabase } from '../../src/storage/database.js';
import { registerAgentTools, renderChatHistoryText } from '../../src/tools/index.js';
import type { ReadChatHistoryResult } from '../../src/types/index.js';

const FRIEND_QQ = '1000000001';
const GROUP_ID = '8000000001';

describe('契约测试: read_chat_history 表情包路径补齐与历史回放', () => {
  let tmpDir: string;
  let db: MessageDatabase;
  let historyTool: any;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-read-sticker-path-'));
    db = new MessageDatabase(path.join(tmpDir, 'messages.sqlite'));
    db.init();

    // 预置表情库资产
    db.insertFace({
      id: 'face_mock_cat',
      file_path: path.join(tmpDir, 'cat.png'),
      md5: 'mock_cat_md5',
      source: 'collect',
      tags: ['猫猫'],
      mood: '嘲讽',
      enabled: true,
      size: 100,
      format: 'png',
    });

    const mockCtx = new Context();
    const registeredTools: any[] = [];
    mockCtx.provide('tools', {
      register: (tool: any) => {
        registeredTools.push(tool);
        return () => {};
      },
    });
    registerAgentTools(mockCtx, {
      db,
      dshHome: tmpDir,
      config: {},
    });
    historyTool = registeredTools.find((t) => t.name === 'read_chat_history');
  });

  afterEach(async () => {
    if (db) db.close();
    if (tmpDir) {
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('契约 1: 库内表情新记录入库后查询 → local_path 保留且 content 与渲染文本均带路径', () => {
    const filePath = path.join(tmpDir, 'cat.png');
    db.saveMessage({
      msg_id: 101,
      peer: `group_${GROUP_ID}`,
      user_id: FRIEND_QQ,
      sender_name: '群友 A',
      time: 1793716500000,
      type: 'sticker',
      content: `[表情包: face_mock_cat (情绪: 嘲讽) 路径: ${filePath}]`,
      raw: '{}',
      file_id: null,
      busid: null,
      local_path: filePath,
      fingerprint: null,
      recalled: 0,
      self: 0,
      reply_to: null,
    });

    const res = db.readHistory(`group_${GROUP_ID}`);
    expect(res.messages).toHaveLength(1);
    expect(res.messages[0].local_path).toBe(filePath);
    expect(res.messages[0].content).toContain(`路径: ${filePath}`);

    const rendered = renderChatHistoryText(res);
    expect(rendered).toContain(`[表情包: face_mock_cat (情绪: 嘲讽) 路径: ${filePath}]`);
  });

  it('契约 2: 库内表情存量旧记录（local_path 为空、content 无路径）→ 自动从 faces 表补齐路径', () => {
    const expectedFilePath = path.join(tmpDir, 'cat.png');
    // 模拟存量老数据：旧格式只写了语义，local_path 为 null
    db.saveMessage({
      msg_id: 102,
      peer: `group_${GROUP_ID}`,
      user_id: FRIEND_QQ,
      sender_name: '群友 B',
      time: 1793716510000,
      type: 'sticker',
      content: '[表情包: face_mock_cat (情绪: 嘲讽)]',
      raw: '{}',
      file_id: null,
      busid: null,
      local_path: null,
      fingerprint: null,
      recalled: 0,
      self: 0,
      reply_to: null,
    });

    const res = db.readHistory(`group_${GROUP_ID}`);
    expect(res.messages).toHaveLength(1);
    expect(res.messages[0].local_path).toBe(expectedFilePath);
    expect(res.messages[0].content).toBe(`[表情包: face_mock_cat (情绪: 嘲讽) 路径: ${expectedFilePath}]`);

    const rendered = renderChatHistoryText(res);
    expect(rendered).toContain(`[表情包: face_mock_cat (情绪: 嘲讽) 路径: ${expectedFilePath}]`);
  });

  it('契约 3: 普通表情存量旧记录（带 [动画表情] 与 已保存:）→ 自动清洗为统一规范路径格式', () => {
    const stickerPath = path.join(tmpDir, 'old_sticker.gif');
    // 模拟 NapCat 原生旧格式：[表情包:[动画表情] 已保存: <path>]
    db.saveMessage({
      msg_id: 103,
      peer: `user_${FRIEND_QQ}`,
      user_id: FRIEND_QQ,
      sender_name: '好友 C',
      time: 1793716520000,
      type: 'sticker',
      content: `[表情包:[动画表情] 已保存: ${stickerPath}]`,
      raw: '{}',
      file_id: null,
      busid: null,
      local_path: stickerPath,
      fingerprint: null,
      recalled: 0,
      self: 0,
      reply_to: null,
    });

    const res = db.readHistory(`user_${FRIEND_QQ}`);
    expect(res.messages).toHaveLength(1);
    expect(res.messages[0].local_path).toBe(stickerPath);
    // 验证清洗：消灭嵌套方括号，消灭「已保存:」，替换为「路径:」
    expect(res.messages[0].content).toBe(`[表情包: 动画表情 路径: ${stickerPath}]`);

    const rendered = renderChatHistoryText(res);
    expect(rendered).toContain(`[表情包: 动画表情 路径: ${stickerPath}]`);
    expect(rendered).not.toContain('[:[');
    expect(rendered).not.toContain('已保存:');
  });

  it('契约 4: 真实 read_chat_history 工具调用装配闭环', async () => {
    const filePath = path.join(tmpDir, 'cat.png');
    db.saveMessage({
      msg_id: 104,
      peer: `group_${GROUP_ID}`,
      user_id: FRIEND_QQ,
      sender_name: '群友 A',
      time: 1793716530000,
      type: 'sticker',
      content: `[表情包: face_mock_cat (情绪: 嘲讽) 路径: ${filePath}]`,
      raw: '{}',
      file_id: null,
      busid: null,
      local_path: filePath,
      fingerprint: null,
      recalled: 0,
      self: 0,
      reply_to: null,
    });

    expect(historyTool).toBeDefined();
    const result: ReadChatHistoryResult = await historyTool.execute(
      { peer: `group_${GROUP_ID}` },
      { agent: { session: { id: `group_${GROUP_ID}` } } }
    );

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].local_path).toBe(filePath);

    const renderedOutput = historyTool.output.render({}, result);
    expect(renderedOutput).toHaveLength(1);
    expect(renderedOutput[0].type).toBe('text');
    expect(renderedOutput[0].text).toContain(`[表情包: face_mock_cat (情绪: 嘲讽) 路径: ${filePath}]`);
  });
});
