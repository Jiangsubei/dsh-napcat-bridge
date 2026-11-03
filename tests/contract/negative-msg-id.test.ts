/**
 * tests/contract/negative-msg-id.test.ts
 * 契约测试: 32位有符号整数回绕产生的负数 message_id 全链路支持契约
 * 
 * 覆盖场景：
 * 1. formatWakeupPrompt 私聊消息透传负数 [消息ID: <id>]
 * 2. formatWakeupPrompt 群聊单条消息透传负数 [消息ID: <id>]
 * 3. formatWakeupPrompt 群聊形态1 (前序缓冲+当前消息) 均精准透传负数消息ID
 * 4. formatWakeupPrompt 主动回复形态透传负数消息ID
 * 5. shouldWakeup 唤醒门控正确解析并保留负数 inboundMsgId
 * 6. send_qq_message 工具支持负数 reply_to (包括数字与数字字符串)
 * 7. collect_face 工具支持负数 message_id (包括传参和隐式入站绑定)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { formatWakeupPrompt } from '../../src/gateway/session/id-resolver.js';
import { shouldWakeup } from '../../src/gateway/wakeup.js';
import { sendQqMessage, collectFace } from '../../src/tools/index.js';
import { MessageDatabase } from '../../src/storage/database.js';

describe('契约测试: 负数 message_id 全链路支持与透传', () => {
  const NEGATIVE_MSG_ID = -837578626;
  const NEGATIVE_BUFFER_MSG_ID = -1510201145;

  let tmpDir: string;
  let dbPath: string;
  let db: MessageDatabase;
  let faceDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-negative-msgid-'));
    dbPath = path.join(tmpDir, 'messages.sqlite');
    db = new MessageDatabase(dbPath);
    faceDir = path.join(tmpDir, 'faces');
    fs.mkdirSync(faceDir, { recursive: true });
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('契约 1: formatWakeupPrompt 私聊消息必须透传负数 [消息ID: <id>]', () => {
    const prompt = formatWakeupPrompt({
      trigger: 'passive',
      peer: 'user_1000000012',
      from_user: '1000000012',
      from_name: '测试用户B',
      msg_id: NEGATIVE_MSG_ID,
      timestamp: 1793716513000,
      content: '[图片:test.png] 哈哈哈，硬梨',
    });

    expect(prompt).toContain(`[消息ID: ${NEGATIVE_MSG_ID}]`);
    expect(prompt).toContain('[QQ私聊]');
    expect(prompt).toContain('发送者: 测试用户B (QQ: 1000000012)');
    expect(prompt).toContain('[图片:test.png] 哈哈哈，硬梨');
  });

  it('契约 2: formatWakeupPrompt 群聊单条消息必须透传负数 [消息ID: <id>]', () => {
    const prompt = formatWakeupPrompt({
      trigger: 'passive',
      peer: 'group_1000000001',
      from_user: '2000000001',
      from_name: '群友A',
      msg_id: NEGATIVE_MSG_ID,
      timestamp: 1793716513000,
      content: '收到请回复',
    });

    expect(prompt).toContain(`[消息ID: ${NEGATIVE_MSG_ID}]`);
    expect(prompt).toContain('[QQ群聊: 1000000001]');
  });

  it('契约 3: formatWakeupPrompt 群聊形态1 (前序缓冲+当前消息) 均必须透传负数 [消息ID: <id>]', () => {
    const prompt = formatWakeupPrompt({
      trigger: 'passive',
      peer: 'group_1000000001',
      from_user: '2000000001',
      from_name: '当前发言人',
      msg_id: NEGATIVE_MSG_ID,
      timestamp: 1793716513000,
      content: '大家看这个',
      buffered_messages: [
        {
          from_user: '2000000002',
          from_name: '前序发言人',
          content: '前一条沙雕图',
          timestamp: 1793716500000,
          msg_id: NEGATIVE_BUFFER_MSG_ID,
        },
      ],
    });

    expect(prompt).toContain(`[消息ID: ${NEGATIVE_BUFFER_MSG_ID}]`);
    expect(prompt).toContain(`[消息ID: ${NEGATIVE_MSG_ID}]`);
    expect(prompt).toContain('--- 未回复消息 ---');
    expect(prompt).toContain('--- 当前消息 ---');
  });

  it('契约 4: formatWakeupPrompt 主动回复 (proactive) 未回复消息列表中必须透传负数 [消息ID: <id>]', () => {
    const prompt = formatWakeupPrompt({
      trigger: 'proactive',
      peer: 'group_1000000001',
      buffered_messages: [
        {
          from_user: '2000000002',
          from_name: '提问者',
          content: '有人在吗？',
          timestamp: 1793716500000,
          msg_id: NEGATIVE_BUFFER_MSG_ID,
        },
      ],
    });

    expect(prompt).toContain(`[消息ID: ${NEGATIVE_BUFFER_MSG_ID}]`);
    expect(prompt).toContain('【主动关注】');
  });

  it('契约 5: shouldWakeup 唤醒门控对负数 message_id 必须精准解析并保留在 payload.msg_id 中', async () => {
    const event: any = {
      post_type: 'message',
      message_type: 'private',
      sub_type: 'friend',
      message_id: NEGATIVE_MSG_ID,
      user_id: 1000000012,
      time: 1793716513,
      raw_message: '测试负数消息ID唤醒',
      message: [{ type: 'text', data: { text: '测试负数消息ID唤醒' } }],
    };

    const decision = await shouldWakeup(event, {
      bot_qq: '1000000000',
    });

    expect(decision.wakeup).toBe(true);
    expect(decision.payload?.msg_id).toBe(NEGATIVE_MSG_ID);
  });

  it('契约 6: send_qq_message 工具支持负数 reply_to (包括数字和数字字符串)', async () => {
    let capturedPayload: any;
    const mockGateway: any = {
      sendMsg: async (_peer: string, payload: any) => {
        capturedPayload = payload;
        return { status: 'ok', retcode: 0, data: { message_id: 12345 } };
      },
    };

    // 6.1 数字格式传入负数 reply_to
    const res1 = await sendQqMessage(
      { text: '回复消息', reply_to: NEGATIVE_MSG_ID },
      { peer: 'user_1000000012', gateway: mockGateway }
    );
    expect(res1.success).toBe(true);
    expect(capturedPayload).toEqual([
      { type: 'reply', data: { id: NEGATIVE_MSG_ID } },
      { type: 'text', data: { text: '回复消息' } },
    ]);

    // 6.2 字符串格式传入负数 reply_to
    const res2 = await sendQqMessage(
      { text: '回复消息2', reply_to: String(NEGATIVE_MSG_ID) as any },
      { peer: 'user_1000000012', gateway: mockGateway }
    );
    expect(res2.success).toBe(true);
    expect(capturedPayload).toEqual([
      { type: 'reply', data: { id: NEGATIVE_MSG_ID } },
      { type: 'text', data: { text: '回复消息2' } },
    ]);
  });

  it('契约 7: collect_face 工具在传入负数 message_id 或隐式入站绑定时均能成功定位并收录', async () => {
    // 构造测试图片文件
    const sampleImgPath = path.join(tmpDir, 'sample_hard_pear.png');
    fs.writeFileSync(sampleImgPath, Buffer.from('mock-pear-image-binary-data'));

    // 保存一条负数 ID 的图文消息入库
    db.saveMessage({
      msg_id: NEGATIVE_MSG_ID,
      peer: 'user_1000000012',
      user_id: '1000000012',
      sender_name: '测试用户',
      time: 1793716513000,
      type: 'image',
      content: `[图片:${sampleImgPath}] 哈哈哈，硬梨`,
      raw: JSON.stringify([{ type: 'image', data: { file: sampleImgPath } }]),
      file_id: null,
      busid: null,
      local_path: sampleImgPath,
      fingerprint: null,
      recalled: 0,
      self: 0,
      reply_to: null,
    });

    // 7.1 显式传入负数 message_id 收录
    const resExplicit = await collectFace(
      {
        message_id: NEGATIVE_MSG_ID,
        tags: ['硬梨', '搞怪'],
        mood: '搞笑',
      },
      {
        peer: 'user_1000000012',
        db,
        faceDir,
        dshHome: tmpDir,
      }
    );
    expect(resExplicit.success).toBe(true);
    expect(resExplicit.face_id).toMatch(/^face_/);

    // 7.2 不传 message_id，依赖 inboundMsgIdGetter 返回的负数 ID 自动绑定收录
    const sampleImgPath2 = path.join(tmpDir, 'sample_hard_pear_2.png');
    fs.writeFileSync(sampleImgPath2, Buffer.from('mock-pear-image-binary-data-2'));
    const ANOTHER_NEGATIVE_ID = -1618069279;
    db.saveMessage({
      msg_id: ANOTHER_NEGATIVE_ID,
      peer: 'user_1000000012',
      user_id: '1000000012',
      sender_name: '测试用户',
      time: 1793716630000,
      type: 'image',
      content: `[图片:${sampleImgPath2}] 第二张图`,
      raw: JSON.stringify([{ type: 'image', data: { file: sampleImgPath2 } }]),
      file_id: null,
      busid: null,
      local_path: sampleImgPath2,
      fingerprint: null,
      recalled: 0,
      self: 0,
      reply_to: null,
    });

    const resImplicit = await collectFace(
      {
        tags: ['第二张', '硬梨'],
        mood: '得瑟',
      },
      {
        peer: 'user_1000000012',
        db,
        faceDir,
        dshHome: tmpDir,
        inboundMsgIdGetter: (_peer: string) => ANOTHER_NEGATIVE_ID,
      }
    );
    expect(resImplicit.success).toBe(true);
    expect(resImplicit.face_id).toMatch(/^face_/);
  });
});
