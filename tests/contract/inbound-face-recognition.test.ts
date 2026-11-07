import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import { MessageDatabase } from '../../src/storage/database.js';
import Database from 'better-sqlite3';
import WebSocket from 'ws';
import { bootDshNapcatBridge, type BootedDsh } from '../../src/boot.js';
import * as NapCatBridgePlugin from '../../src/index.js';
import {
  parseNormalizedContent,
  formatFacePlaceholder,
  shouldWakeup,
} from '../../src/gateway/wakeup.js';
import { computeFileMd5 } from '../../src/storage/media.js';
import type { OneBotMessageEvent } from '../../src/types/index.js';

describe('契约测试: 入站图片/表情包识别本地表情库并替换语义 (Inbound Face Recognition Contract)', () => {
  let tmpDir: string;
  let dbPath: string;
  let db: MessageDatabase;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-inbound-face-'));
    dbPath = path.join(tmpDir, 'messages.sqlite');
    db = new MessageDatabase(dbPath);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function createMockImageFile(content: string, name = 'test.png'): { filePath: string; md5: string } {
    const filePath = path.join(tmpDir, name);
    const buf = Buffer.from(content);
    fs.writeFileSync(filePath, buf);
    const md5 = crypto.createHash('md5').update(buf).digest('hex');
    return { filePath, md5 };
  }

  describe('1. formatFacePlaceholder 格式化语义占位符', () => {
    it('契约 1.1: 包含情绪与标签时仅拼入情绪与 face_id，省略详细标签', () => {
      const res = formatFacePlaceholder({
        id: 'face_a1b2c3d4',
        mood: '嘲讽',
        tags: ['猫猫', '叹气'],
      });
      expect(res).toBe('[表情包: face_a1b2c3d4 (情绪: 嘲讽)]');
    });

    it('契约 1.2: 仅包含情绪，无标签', () => {
      const res = formatFacePlaceholder({
        id: 'face_a1b2c3d4',
        mood: '卖萌',
        tags: [],
      });
      expect(res).toBe('[表情包: face_a1b2c3d4 (情绪: 卖萌)]');
    });

    it('契约 1.3: 仅包含标签，无情绪时降级为仅 face_id', () => {
      const res = formatFacePlaceholder({
        id: 'face_a1b2c3d4',
        tags: ['柴犬', '蔑视'],
      });
      expect(res).toBe('[表情包: face_a1b2c3d4]');
    });

    it('契约 1.4: 情绪与标签均为空', () => {
      const res = formatFacePlaceholder({
        id: 'face_a1b2c3d4',
      });
      expect(res).toBe('[表情包: face_a1b2c3d4]');
    });
  });

  describe('2. parseNormalizedContent 入站表情识别契约', () => {
    it('契约 2.1: sticker 表情包若命中已收藏表情库，content 输出语义占位符且不包含本地文件路径', () => {
      const { filePath, md5 } = createMockImageFile('cat-sigh-image-bytes', 'cat.png');

      db.insertFace({
        id: 'face_cat_sigh',
        file_path: '/faces/cat.png',
        md5,
        source: 'collect',
        tags: ['猫猫', '叹气'],
        mood: '嘲讽',
        enabled: true,
        size: 100,
        format: 'png',
      });

      const event: OneBotMessageEvent = {
        time: 1700000000,
        self_id: 1000000000,
        post_type: 'message',
        message_type: 'group',
        sub_type: 'normal',
        message_id: 10001,
        user_id: 2000000001,
        group_id: 3000000001,
        message: [
          {
            type: 'image',
            data: {
              sub_type: 1,
              summary: '[动画表情]',
              local_path: filePath,
            },
          },
        ],
        raw_message: '[CQ:image,subType=1]',
        font: 0,
        sender: { user_id: 2000000001, nickname: '测试用户' },
      };

      const { content, images } = parseNormalizedContent(event, {
        getFaceByMd5: (hash) => db.getFaceByMd5(hash),
      });

      // 验证语义替换成功并携带规范本地路径
      expect(content).toBe(`[表情包: face_cat_sigh (情绪: 嘲讽) 路径: ${filePath}]`);
      // 验证 images 数组仍保留该物理路径供多模态视觉消费
      expect(images).toEqual([filePath]);
    });

    it('契约 2.2: 普通 image 段（非 sub_type 1）若 MD5 命中已收藏表情库，同样归一化识别为表情包', () => {
      const { filePath, md5 } = createMockImageFile('doge-look-bytes', 'doge.jpg');

      db.insertFace({
        id: 'face_doge',
        file_path: '/faces/doge.jpg',
        md5,
        source: 'collect',
        tags: ['柴犬'],
        mood: '蔑视',
        enabled: true,
        size: 200,
        format: 'jpg',
      });

      const event: OneBotMessageEvent = {
        time: 1700000000,
        self_id: 1000000000,
        post_type: 'message',
        message_type: 'group',
        sub_type: 'normal',
        message_id: 10002,
        user_id: 2000000001,
        group_id: 3000000001,
        message: [
          {
            type: 'image',
            data: {
              file: `${md5}.image`,
              local_path: filePath,
            },
          },
        ],
        raw_message: `[CQ:image,file=${md5}.image]`,
        font: 0,
        sender: { user_id: 2000000001, nickname: '测试用户' },
      };

      const { content, images } = parseNormalizedContent(event, {
        getFaceByMd5: (hash) => db.getFaceByMd5(hash),
      });

      expect(content).toBe(`[表情包: face_doge (情绪: 蔑视) 路径: ${filePath}]`);
      expect(content).not.toContain('[图片:');
      expect(images).toEqual([filePath]);
    });

    it('契约 2.3: 未收藏的表情包保持 [表情包:表情 已保存: /path] 格式不变', () => {
      const { filePath } = createMockImageFile('uncollected-sticker-bytes', 'new_sticker.png');

      const event: OneBotMessageEvent = {
        time: 1700000000,
        self_id: 1000000000,
        post_type: 'message',
        message_type: 'group',
        sub_type: 'normal',
        message_id: 10003,
        user_id: 2000000001,
        group_id: 3000000001,
        message: [
          {
            type: 'image',
            data: {
              sub_type: 1,
              summary: '滑稽',
              local_path: filePath,
            },
          },
        ],
        raw_message: '[CQ:image,subType=1]',
        font: 0,
        sender: { user_id: 2000000001, nickname: '测试用户' },
      };

      const { content } = parseNormalizedContent(event, {
        getFaceByMd5: (hash) => db.getFaceByMd5(hash),
      });

      expect(content).toBe(`[表情包: 滑稽 路径: ${filePath}]`);
      expect(content).toContain(filePath);
    });

    it('契约 2.4: 未收藏的普通图片保持 [图片:/path] 格式不变', () => {
      const { filePath } = createMockImageFile('uncollected-photo-bytes', 'scenery.jpg');

      const event: OneBotMessageEvent = {
        time: 1700000000,
        self_id: 1000000000,
        post_type: 'message',
        message_type: 'group',
        sub_type: 'normal',
        message_id: 10004,
        user_id: 2000000001,
        group_id: 3000000001,
        message: [
          {
            type: 'image',
            data: {
              local_path: filePath,
            },
          },
        ],
        raw_message: '[CQ:image]',
        font: 0,
        sender: { user_id: 2000000001, nickname: '测试用户' },
      };

      const { content } = parseNormalizedContent(event, {
        getFaceByMd5: (hash) => db.getFaceByMd5(hash),
      });

      expect(content).toBe(`[图片:${filePath}]`);
    });

    it('契约 2.5: 已被软删除或已禁用的表情包绝不触发表情识别', () => {
      const { filePath, md5 } = createMockImageFile('deleted-face-bytes', 'deleted.png');

      db.insertFace({
        id: 'face_deleted',
        file_path: '/faces/deleted.png',
        md5,
        source: 'collect',
        tags: ['已删'],
        mood: '无',
        enabled: true,
        size: 100,
        format: 'png',
      });
      // 软删除
      db.deleteFace('face_deleted');

      const event: OneBotMessageEvent = {
        time: 1700000000,
        self_id: 1000000000,
        post_type: 'message',
        message_type: 'group',
        sub_type: 'normal',
        message_id: 10005,
        user_id: 2000000001,
        group_id: 3000000001,
        message: [
          {
            type: 'image',
            data: {
              sub_type: 1,
              summary: '已删表情',
              local_path: filePath,
            },
          },
        ],
        raw_message: '[CQ:image]',
        font: 0,
        sender: { user_id: 2000000001, nickname: '测试用户' },
      };

      const { content } = parseNormalizedContent(event, {
        getFaceByMd5: (hash) => db.getFaceByMd5(hash),
      });

      // 软删除后不应匹配为 face_deleted
      expect(content).toBe(`[表情包: 已删表情 路径: ${filePath}]`);
      expect(content).not.toContain('face_deleted');
    });

    it('契约 2.6: 段内已预先绑定 data.face 时直接使用，不重复查库', () => {
      const event: OneBotMessageEvent = {
        time: 1700000000,
        self_id: 1000000000,
        post_type: 'message',
        message_type: 'group',
        sub_type: 'normal',
        message_id: 10006,
        user_id: 2000000001,
        group_id: 3000000001,
        message: [
          {
            type: 'image',
            data: {
              sub_type: 1,
              local_path: '/tmp/test.png',
              face: {
                id: 'face_pre_bound',
                mood: '得意',
                tags: ['哈哈'],
              },
            },
          },
        ],
        raw_message: '[CQ:image]',
        font: 0,
        sender: { user_id: 2000000001, nickname: '测试用户' },
      };

      const { content } = parseNormalizedContent(event);
      expect(content).toBe('[表情包: face_pre_bound (情绪: 得意) 路径: /tmp/test.png]');
    });
  });

  describe('3. shouldWakeup 唤醒流程协同契约', () => {
    it('契约 3.1: 唤醒决策 payload.content 正确携带识别后的表情包语义', async () => {
      const { filePath, md5 } = createMockImageFile('cat-happy-bytes', 'happy.png');

      db.insertFace({
        id: 'face_happy_cat',
        file_path: '/faces/happy.png',
        md5,
        source: 'collect',
        tags: ['猫', '开心'],
        mood: '喜悦',
        enabled: true,
        size: 150,
        format: 'png',
      });

      const event: OneBotMessageEvent = {
        time: 1700000000,
        self_id: 1000000000,
        post_type: 'message',
        message_type: 'group',
        sub_type: 'normal',
        message_id: 10007,
        user_id: 2000000001,
        group_id: 3000000001,
        message: [
          { type: 'at', data: { qq: '1000000000' } },
          { type: 'text', data: { text: ' 看这个表情 ' } },
          {
            type: 'image',
            data: {
              local_path: filePath,
            },
          },
        ],
        raw_message: '[CQ:at,qq=1000000000] 看这个表情 [CQ:image]',
        font: 0,
        sender: { user_id: 2000000001, nickname: '测试用户' },
      };

      const decision = await shouldWakeup(event, {
        bot_qq: '1000000000',
        getFaceByMd5: (hash) => db.getFaceByMd5(hash),
      });

      expect(decision.wakeup).toBe(true);
      expect(decision.payload?.content).toContain(`[表情包: face_happy_cat (情绪: 喜悦) 路径: ${filePath}]`);
      expect(decision.payload?.images).toContain(filePath);
    });
  });

  describe('4. 装配闭环契约测试 (Full Assembly Lifecycle via bootDshNapcatBridge)', () => {
    const WS_PORT = 29851;
    const BOT_QQ = '1000000001';
    const USER_QQ = '2000000001';
    let bootedDsh: BootedDsh | null = null;
    let wsClient: WebSocket | null = null;
    let asmHome: string | null = null;
    let capturedFollowups: Array<{ content: string }> = [];

    function asmDbPath(): string {
      return path.join(asmHome!, 'napcat/messages.sqlite');
    }

    beforeEach(async () => {
      asmHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-face-asm-recog-'));
      capturedFollowups = [];

      bootedDsh = await bootDshNapcatBridge({ dshHome: asmHome, mountPlugin: false });
      await bootedDsh.ctx.plugin(NapCatBridgePlugin, {
        bot_qq: BOT_QQ,
        ws_token: 'test-token',
        ws_port: WS_PORT,
        face_enabled: true,
      });

      const agents: any = bootedDsh.ctx.get('agents');
      const handle = await agents.create({
        sessionId: `qq-user-${USER_QQ}`,
        agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
        meta: { cwd: path.join(asmHome, 'agent-cwd') },
      });
      const agent = handle.agent || handle;
      agent.followup = (msg: any) => {
        const text = Array.isArray(msg?.content)
          ? msg.content.map((c: any) => c?.text || '').join('')
          : String(msg?.content || '');
        capturedFollowups.push({ content: text });
      };

      wsClient = new WebSocket(`ws://127.0.0.1:${WS_PORT}?access_token=test-token`);
      await new Promise<void>((resolve, reject) => {
        wsClient!.once('open', () => resolve());
        wsClient!.once('error', reject);
      });
    });

    afterEach(async () => {
      if (wsClient && wsClient.readyState === WebSocket.OPEN) {
        wsClient.close();
      }
      await new Promise((r) => setTimeout(r, 100));
      if (bootedDsh) {
        await bootedDsh.dispose();
        bootedDsh = null;
      }
      if (asmHome && fs.existsSync(asmHome)) {
        try {
          fs.rmSync(asmHome, { recursive: true, force: true });
        } catch {}
        asmHome = null;
      }
    });

    it('装配-契约 4.1: 真实入站消息中图片命中已收藏表情包时，入库 content 与 Agent 唤醒 content 均替换为语义格式', async () => {
      const imgBytes = Buffer.from('mock-panda-roll-image-data-for-asm');
      const md5 = crypto.createHash('md5').update(imgBytes).digest('hex');
      const imageDir = path.join(asmHome!, 'agent-cwd');
      fs.mkdirSync(imageDir, { recursive: true });
      const imgPath = path.join(imageDir, `${md5}.png`);
      fs.writeFileSync(imgPath, imgBytes);

      // 在已初始化的 SQLite 数据库中插入一条已收藏表情记录
      const rawDb = new Database(asmDbPath());
      try {
        rawDb.prepare(`
          INSERT INTO faces (id, file_path, md5, added_at, source, tags, mood, enabled, size, format, use_count)
          VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, 'png', 0)
        `).run('face_panda_roll', imgPath, md5, Date.now(), 'collect', JSON.stringify(['滚滚', '熊猫']), '卖萌', imgBytes.length);
      } finally {
        rawDb.close();
      }

      // 通过真实 WebSocket 发送带有该本地路径的表情包消息
      const msgId = 88001;
      const nowSec = Math.floor(Date.now() / 1000);
      wsClient!.send(
        JSON.stringify({
          post_type: 'message',
          message_type: 'private',
          sub_type: 'friend',
          message_id: msgId,
          user_id: USER_QQ,
          sender: { user_id: USER_QQ, nickname: '测试好友' },
          message: [
            {
              type: 'image',
              data: {
                local_path: imgPath,
                sub_type: 1,
                summary: '熊猫打滚',
              },
            },
          ],
          raw_message: '[CQ:image]',
          time: nowSec,
          self_id: BOT_QQ,
        })
      );

      // 等待异步流转与入库唤醒
      await new Promise((r) => setTimeout(r, 400));

      // 1. 验证 Agent 唤醒收到的 Prompt 包含表情包语义与规范路径
      expect(capturedFollowups.length).toBe(1);
      expect(capturedFollowups[0].content).toContain('[表情包: face_panda_roll (情绪: 卖萌) 路径:');

      // 2. 验证 SQLite messages 表中落库的 content 包含规范路径
      const queryDb = new Database(asmDbPath(), { readonly: true });
      try {
        const row: any = queryDb.prepare('SELECT * FROM messages WHERE msg_id = ?').get(msgId);
        expect(row).toBeDefined();
        expect(row.content).toContain('[表情包: face_panda_roll (情绪: 卖萌) 路径:');
      } finally {
        queryDb.close();
      }
    });

    it('装配-契约 4.2: 未收藏的图片入站时，入库 content 与唤醒正常保留原始路径不被误篡改', async () => {
      const imgBytes = Buffer.from('uncollected-scene-image-for-asm');
      const md5 = crypto.createHash('md5').update(imgBytes).digest('hex');
      const imageDir = path.join(asmHome!, 'agent-cwd');
      fs.mkdirSync(imageDir, { recursive: true });
      const imgPath = path.join(imageDir, `${md5}.jpg`);
      fs.writeFileSync(imgPath, imgBytes);

      const msgId = 88002;
      const nowSec = Math.floor(Date.now() / 1000);
      wsClient!.send(
        JSON.stringify({
          post_type: 'message',
          message_type: 'private',
          sub_type: 'friend',
          message_id: msgId,
          user_id: USER_QQ,
          sender: { user_id: USER_QQ, nickname: '测试好友' },
          message: [
            {
              type: 'image',
              data: {
                local_path: imgPath,
              },
            },
          ],
          raw_message: '[CQ:image]',
          time: nowSec,
          self_id: BOT_QQ,
        })
      );

      await new Promise((r) => setTimeout(r, 400));

      expect(capturedFollowups.length).toBe(1);
      expect(capturedFollowups[0].content).toMatch(/\[图片:.*downloads[/\\]image[/\\]user_2000000001.*\.png\]/);

      const queryDb = new Database(asmDbPath(), { readonly: true });
      try {
        const row: any = queryDb.prepare('SELECT * FROM messages WHERE msg_id = ?').get(msgId);
        expect(row).toBeDefined();
        expect(row.content).toMatch(/\[图片:.*downloads[/\\]image[/\\]user_2000000001.*\.png\]/);
      } finally {
        queryDb.close();
      }
    });
  });
});
