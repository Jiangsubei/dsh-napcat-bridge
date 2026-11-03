import { describe, it, expect } from 'vitest';
import {
  formatPromptSection,
  formatFaceLibraryContext,
  formatPersonaContext,
  formatBehaviorContext,
  formatSlangContext,
  formatMemoryContext,
} from '../../src/prompt/formatter.js';
import type { FaceRecord } from '../../src/types/index.js';

describe('契约测试: 统一提示词与上下文格式化模块 (PromptFormatter Contract)', () => {
  describe('1. 基础 Section 格式化原语 (formatPromptSection)', () => {
    it('1.1 仅标题与正文时，生成规范的二级 Markdown 标题', () => {
      const res = formatPromptSection({
        title: '测试标题',
        content: '这是测试正文内容',
      });
      expect(res).toBe('## 测试标题\n\n这是测试正文内容');
    });

    it('1.2 带有中英文副标题与导语时，生成统一格式段落', () => {
      const res = formatPromptSection({
        title: '人格设定',
        subtitle: 'Persona',
        description: '请严格遵守以下人设要求：',
        content: '你是一个热心的群友。',
      });
      expect(res).toBe(
        '## 人格设定 (Persona)\n\n请严格遵守以下人设要求：\n\n你是一个热心的群友。'
      );
    });

    it('1.3 当正文为空或全为空白字符时，返回空字符串（静默防御）', () => {
      expect(formatPromptSection({ title: '空段', content: '' })).toBe('');
      expect(formatPromptSection({ title: '空白段', content: '   \n  ' })).toBe('');
    });
  });

  describe('2. 表情包全量上下文注入 (formatFaceLibraryContext)', () => {
    it('2.1 表情库为空时，返回标准二级标题与友好收录指引', () => {
      const res = formatFaceLibraryContext([], 0);
      expect(res).toContain('## 本地表情包库存 (Sticker & Meme Library)');
      expect(res).toContain('当前本地表情库为空');
      expect(res).toContain('collect_face');
    });

    it('2.2 表情库有数据时，按情绪分组列出各表情的 ID 与详细标签，且包含一步直发指引', () => {
      const mockFaces: FaceRecord[] = [
        {
          id: 'face_001',
          file_path: '/path/f1.png',
          md5: 'md5_1',
          source: 'manual',
          tags: ['猫咪', '摇尾巴', '可爱'],
          mood: '开心',
          enabled: true,
          size: 1024,
          format: 'png',
          use_count: 5,
          added_at: 1000,
        },
        {
          id: 'face_002',
          file_path: '/path/f2.png',
          md5: 'md5_2',
          source: 'manual',
          tags: ['欢呼', '撒花'],
          mood: '开心',
          enabled: true,
          size: 1024,
          format: 'png',
          use_count: 3,
          added_at: 1001,
        },
        {
          id: 'face_003',
          file_path: '/path/f3.png',
          md5: 'md5_3',
          source: 'manual',
          tags: ['熊猫头', '就这'],
          mood: '调侃',
          enabled: true,
          size: 1024,
          format: 'png',
          use_count: 1,
          added_at: 1002,
        },
        {
          id: 'face_004',
          file_path: '/path/f4.png',
          md5: 'md5_4',
          source: 'manual',
          tags: ['问号', '疑惑'],
          enabled: true,
          size: 1024,
          format: 'png',
          use_count: 0,
          added_at: 1003,
        },
      ];

      const res = formatFaceLibraryContext(mockFaces, 4);

      // 验证顶层大标题与指引
      expect(res).toContain('## 本地表情包库存 (Sticker & Meme Library)');
      expect(res).toContain('共 4 张可用表情包');
      expect(res).toContain('send_face(face_id="..."');

      // 验证情绪分组标题
      expect(res).toContain('### 开心 (2)');
      expect(res).toContain('### 调侃 (1)');
      expect(res).toContain('### 通用/其他 (1)');

      // 验证组内表情项排版（ID 与详细标签）
      expect(res).toContain('- face_001: 标签: 猫咪, 摇尾巴, 可爱');
      expect(res).toContain('- face_002: 标签: 欢呼, 撒花');
      expect(res).toContain('- face_003: 标签: 熊猫头, 就这');
      expect(res).toContain('- face_004: 标签: 问号, 疑惑');
    });

    it('2.3 标签为空时优雅回退为 "无"', () => {
      const mockFaces: FaceRecord[] = [
        {
          id: 'face_empty_tag',
          file_path: '/path/f.png',
          md5: 'md5_e',
          source: 'manual',
          tags: [],
          mood: '淡定',
          enabled: true,
          size: 1024,
          format: 'png',
          use_count: 0,
          added_at: 1000,
        },
      ];
      const res = formatFaceLibraryContext(mockFaces, 1);
      expect(res).toContain('### 淡定 (1)');
      expect(res).toContain('- face_empty_tag: 标签: 无');
    });
  });

  describe('3. 人格、行为、黑话与记忆统一格式化', () => {
    it('3.1 formatPersonaContext 产生统一的 ## 人格设定 (Persona) 格式', () => {
      const res = formatPersonaContext('你是一个智能小助手。');
      expect(res).toBe('## 人格设定 (Persona)\n\n你是一个智能小助手。');
    });

    it('3.2 formatBehaviorContext 产生统一的 ## 行为准则 (Behavior Guidelines) 格式', () => {
      const res = formatBehaviorContext('严格使用纯文本。');
      expect(res).toBe('## 行为准则 (Behavior Guidelines)\n\n严格使用纯文本。');
    });

    it('3.3 formatSlangContext 产生统一的 ## 社群黑话知识库 (Slang & Memes) 格式', () => {
      const res = formatSlangContext('- **草率了**：指决定过快');
      expect(res).toContain('## 社群黑话知识库 (Slang & Memes)');
      expect(res).toContain('query_slang');
      expect(res).toContain('- **草率了**：指决定过快');
    });

    it('3.4 formatMemoryContext 产生统一的 ## 会话规则与用户画像 (Memory & Profiles) 格式', () => {
      const res = formatMemoryContext('### Session 记忆\n- 规则一');
      expect(res).toContain('## 会话规则与用户画像 (Memory & Profiles)');
      expect(res).toContain('### Session 记忆\n- 规则一');
    });
  });
});
