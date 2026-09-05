/**
 * tests/contract/list-group-files.test.ts
 *
 * 契约测试: EN-001 list_group_files 群文件列表工具
 *
 * 覆盖场景:
 * 1. 数据库多维筛选 (since/until, sender_name, user_id, file_name, limit, order)
 * 2. 存量/增量兼容 (file_name 从 raw/content 提取，sender_name 为空时回退 user_id)
 * 3. Agent 工具执行与格式化渲染 (群聊正常列出、私聊防御拦截)
 * 4. 真实装配闭环 (bootDshNapcatBridge 挂载后 tools 注册表包含 list_group_files)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { MessageDatabase } from '../../src/storage/database.js';
import { listGroupFiles, renderGroupFilesText } from '../../src/tools/index.js';
import { bootDshNapcatBridge } from '../../src/boot.js';
import type { ListGroupFilesParams } from '../../src/types/index.js';

const TEST_DB_PATH = path.join(process.cwd(), 'tests', 'fixtures', 'test-group-files.db');

describe('契约测试: EN-001 list_group_files 群文件列表工具', () => {
  let db: MessageDatabase;

  beforeEach(() => {
    try {
      if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
      if (fs.existsSync(`${TEST_DB_PATH}-wal`)) fs.unlinkSync(`${TEST_DB_PATH}-wal`);
      if (fs.existsSync(`${TEST_DB_PATH}-shm`)) fs.unlinkSync(`${TEST_DB_PATH}-shm`);
    } catch {}
    db = new MessageDatabase(TEST_DB_PATH);
    db.init();
  });

  afterEach(() => {
    if (db) {
      try {
        db.close();
      } catch {}
    }
    try {
      if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
      if (fs.existsSync(`${TEST_DB_PATH}-wal`)) fs.unlinkSync(`${TEST_DB_PATH}-wal`);
      if (fs.existsSync(`${TEST_DB_PATH}-shm`)) fs.unlinkSync(`${TEST_DB_PATH}-shm`);
    } catch {}
  });

  it('契约 1: MessageDatabase.listGroupFiles 支持按 peer 筛选并正确返回文件名与元数据', () => {
    const now = Date.now();
    // 写入 2 条群文件与 1 条普通文本消息
    db.saveMessage({
      msg_id: 1001,
      peer: 'group_3000000001',
      user_id: '2000000001',
      sender_name: 'BotNickname',
      time: now - 3600 * 1000,
      type: 'group_file',
      content: '[群文件:需求规格说明书_v1.0.pdf (ID:uuid-file-01)]',
      raw: JSON.stringify({
        post_type: 'notice',
        notice_type: 'group_upload',
        group_id: 3000000001,
        user_id: 2000000001,
        file: { id: 'uuid-file-01', name: '需求规格说明书_v1.0.pdf', size: 1048576, busid: 102 },
      }),
      file_id: 'uuid-file-01',
      busid: 102,
      local_path: null,
      fingerprint: null,
      recalled: 0,
      self: 0,
      reply_to: null,
    });

    db.saveMessage({
      msg_id: 1002,
      peer: 'group_3000000001',
      user_id: '470250799',
      sender_name: '张三',
      time: now - 1800 * 1000,
      type: 'group_file',
      content: '[群文件:架构设计图.png (ID:uuid-file-02)]',
      raw: JSON.stringify({
        post_type: 'notice',
        notice_type: 'group_upload',
        group_id: 3000000001,
        user_id: 470250799,
        file: { id: 'uuid-file-02', name: '架构设计图.png', size: 524288, busid: 103 },
      }),
      file_id: 'uuid-file-02',
      busid: 103,
      local_path: null,
      fingerprint: null,
      recalled: 0,
      self: 0,
      reply_to: null,
    });

    // 异群文件
    db.saveMessage({
      msg_id: 1003,
      peer: 'group_999999999',
      user_id: '470250799',
      sender_name: '张三',
      time: now,
      type: 'group_file',
      content: '[群文件:异群文件.zip (ID:uuid-file-03)]',
      raw: JSON.stringify({
        post_type: 'notice',
        notice_type: 'group_upload',
        group_id: 999999999,
        user_id: 470250799,
        file: { id: 'uuid-file-03', name: '异群文件.zip', size: 2048, busid: 104 },
      }),
      file_id: 'uuid-file-03',
      busid: 104,
      local_path: null,
      fingerprint: null,
      recalled: 0,
      self: 0,
      reply_to: null,
    });

    // 查询 group_3000000001
    const result = db.listGroupFiles('group_3000000001');
    expect(result.total).toBe(2);
    expect(result.files.length).toBe(2);
    // 默认 desc 倒序：架构设计图排前面
    expect(result.files[0].file_name).toBe('架构设计图.png');
    expect(result.files[0].file_id).toBe('uuid-file-02');
    expect(result.files[0].busid).toBe(103);
    expect(result.files[0].sender_name).toBe('张三');
    expect(result.files[0].size).toBe(524288);

    expect(result.files[1].file_name).toBe('需求规格说明书_v1.0.pdf');
    expect(result.files[1].file_id).toBe('uuid-file-01');
    expect(result.files[1].busid).toBe(102);
  });

  it('契约 2: 支持 file_name / sender_name / since 多维组合过滤', () => {
    const now = Date.now();
    db.saveMessage({
      msg_id: 2001,
      peer: 'group_100',
      user_id: '111',
      sender_name: 'Alice',
      time: now - 3600 * 1000 * 24 * 5, // 5 天前
      type: 'group_file',
      content: '[群文件:财务报表.xlsx (ID:f-01)]',
      raw: JSON.stringify({ file: { id: 'f-01', name: '财务报表.xlsx', busid: 1 } }),
      file_id: 'f-01',
      busid: 1,
      local_path: null,
      fingerprint: null,
      recalled: 0,
      self: 0,
      reply_to: null,
    });

    db.saveMessage({
      msg_id: 2002,
      peer: 'group_100',
      user_id: '222',
      sender_name: 'Bob',
      time: now - 3600 * 1000 * 2, // 2 小时前
      type: 'group_file',
      content: '[群文件:技术总结.pdf (ID:f-02)]',
      raw: JSON.stringify({ file: { id: 'f-02', name: '技术总结.pdf', busid: 2 } }),
      file_id: 'f-02',
      busid: 2,
      local_path: null,
      fingerprint: null,
      recalled: 0,
      self: 0,
      reply_to: null,
    });

    // 1. 按文件名搜索
    const res1 = db.listGroupFiles('group_100', { file_name: '报表' });
    expect(res1.total).toBe(1);
    expect(res1.files[0].file_name).toBe('财务报表.xlsx');

    // 2. 按发送者搜索
    const res2 = db.listGroupFiles('group_100', { sender_name: 'Bob' });
    expect(res2.total).toBe(1);
    expect(res2.files[0].file_name).toBe('技术总结.pdf');

    // 3. 按相对时间 since='1d' (过去1天内)
    const res3 = db.listGroupFiles('group_100', { since: '1d' });
    expect(res3.total).toBe(1);
    expect(res3.files[0].file_name).toBe('技术总结.pdf');
  });

  it('契约 3: 存量数据 sender_name 为空时回退到 user_id，content 解析兜底提取文件名', () => {
    db.saveMessage({
      msg_id: 3001,
      peer: 'group_200',
      user_id: '998877',
      sender_name: '', // 历史存量数据为空
      time: Date.now(),
      type: 'group_file',
      content: '[群文件:纯文本提取测试.doc (ID:doc-uuid)]',
      raw: '', // raw 为空或非 json 字符串
      file_id: 'doc-uuid',
      busid: 55,
      local_path: null,
      fingerprint: null,
      recalled: 0,
      self: 0,
      reply_to: null,
    });

    const res = db.listGroupFiles('group_200');
    expect(res.total).toBe(1);
    expect(res.files[0].file_name).toBe('纯文本提取测试.doc');
    expect(res.files[0].sender_name).toBe('998877'); // 回退为 user_id
    expect(res.files[0].file_id).toBe('doc-uuid');
    expect(res.files[0].busid).toBe(55);
  });

  it('契约 4: Agent 工具 list_group_files 执行与渲染', async () => {
    db.saveMessage({
      msg_id: 4001,
      peer: 'group_3000000001',
      user_id: '2000000001',
      sender_name: 'BotNickname',
      time: Date.now(),
      type: 'group_file',
      content: '[群文件:开发计划.md (ID:plan-01)]',
      raw: JSON.stringify({ file: { id: 'plan-01', name: '开发计划.md', busid: 10, size: 4096 } }),
      file_id: 'plan-01',
      busid: 10,
      local_path: null,
      fingerprint: null,
      recalled: 0,
      self: 0,
      reply_to: null,
    });

    // 模拟群聊环境调用
    const groupResult = await listGroupFiles(
      { file_name: '开发' },
      { db, peer: 'group_3000000001' }
    );
    expect(groupResult.success).toBe(true);
    expect(groupResult.total).toBe(1);
    expect(groupResult.files[0].file_name).toBe('开发计划.md');

    // 检查渲染文本
    const rendered = renderGroupFilesText(groupResult);
    expect(rendered).toContain('开发计划.md');
    expect(rendered).toContain('plan-01');
    expect(rendered).toContain('busid: 10');

    // 模拟私聊环境防御
    const userResult = await listGroupFiles(
      {},
      { db, peer: 'user_2000000001' }
    );
    expect(userResult.success).toBe(false);
    expect(userResult.error).toContain('当前会话不是群聊');
  });

  it('契约 5: 真实装配闭环 - bootDshNapcatBridge 挂载后 tools 注册表包含 list_group_files', async () => {
    const booted = await bootDshNapcatBridge({
      port: 19821,
      auto_connect: false,
    });

    try {
      const tools = booted.ctx.get('tools') || (booted.ctx as any).tools;
      expect(tools).toBeDefined();
      expect(typeof tools.get).toBe('function');
      const toolDef = tools.get('list_group_files');
      expect(toolDef).toBeDefined();
      expect(toolDef.name).toBe('list_group_files');
      expect(toolDef.description).toContain('群聊的历史上传文件列表');
    } finally {
      await booted.dispose();
    }
  });
});
