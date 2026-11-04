/**
 * dsh-napcat-bridge: 统一提示词与上下文格式化模块 (PromptFormatter)
 * 集中管理所有注入到 SystemPrompt 动态段的排版契约与 Markdown 规范。
 * 强制顶层采用统一的二级标题 `## <中文模块名> (<English Subtitle>)`，
 * 消除各业务各自拼接、格式碎片化与层级漂移。
 */

import type { FaceRecord } from '../types/index.js';

export interface PromptSectionOptions {
  title: string;
  subtitle?: string;
  description?: string;
  content: string;
}

/**
 * 基础 Section 格式化原语
 */
export function formatPromptSection(options: PromptSectionOptions): string {
  const trimmedContent = options.content?.trim();
  if (!trimmedContent) {
    return '';
  }

  const header = options.subtitle
    ? `## ${options.title} (${options.subtitle})`
    : `## ${options.title}`;

  const parts = [header];
  if (options.description?.trim()) {
    parts.push(options.description.trim());
  }
  parts.push(trimmedContent);

  return parts.join('\n\n');
}

/**
 * 格式化表情包全量上下文注入 (带情绪分组与详细标签、ID)
 */
export function formatFaceLibraryContext(
  faces: FaceRecord[],
  totalCount?: number
): string {
  const total = typeof totalCount === 'number' ? totalCount : faces.length;

  if (total === 0 || faces.length === 0) {
    return [
      '## 本地表情包库存 (Sticker & Meme Library)',
      '当前本地表情库为空。若聊天中出现有趣的表情包，可调用 `collect_face` 进行收录打标。',
    ].join('\n\n');
  }

  // 1. 按情绪分组聚合
  const groups = new Map<string, FaceRecord[]>();
  const defaultMoodKey = '通用/其他';

  for (const face of faces) {
    const rawMood = face.mood?.trim();
    const moodKey = rawMood ? rawMood : defaultMoodKey;
    let list = groups.get(moodKey);
    if (!list) {
      list = [];
      groups.set(moodKey, list);
    }
    list.push(face);
  }

  // 2. 情绪分组排序：数量降序，通用/其他置底
  const sortedMoods = Array.from(groups.keys()).sort((a, b) => {
    if (a === defaultMoodKey) return 1;
    if (b === defaultMoodKey) return -1;
    const countA = groups.get(a)?.length || 0;
    const countB = groups.get(b)?.length || 0;
    if (countB !== countA) {
      return countB - countA;
    }
    return a.localeCompare(b);
  });

  // 3. 组装各组表情条目
  const groupBlocks: string[] = [];
  for (const mood of sortedMoods) {
    const items = groups.get(mood) || [];
    const lines = items.map((f) => {
      const tagsStr = (f.tags || []).filter((t) => t && t.trim()).join(', ');
      return `- ${f.id}: 标签: ${tagsStr || '无'}`;
    });
    groupBlocks.push(`### ${mood} (${items.length})\n${lines.join('\n')}`);
  }

  const descNotice =
    total > faces.length
      ? `当前本地库共 ${total} 张可用表情包（当前已列出前 ${faces.length} 张，其余可按需调用 list_faces 检索）。在聊天中需要表达情绪、调侃或斗图时，可根据以下各情绪分组下的表情条目直接调用 \`send_face(face_id="...")\` 发送对应表情，无需额外检索：`
      : `当前本地库共 ${total} 张可用表情包。在聊天中需要表达情绪、调侃或斗图时，可根据以下各情绪分组下的表情条目直接调用 \`send_face(face_id="...")\` 发送对应表情，无需额外检索：`;

  return formatPromptSection({
    title: '本地表情包库存',
    subtitle: 'Sticker & Meme Library',
    description: descNotice,
    content: groupBlocks.join('\n\n'),
  });
}

/**
 * 格式化人格设定 (Persona)
 */
export function formatPersonaContext(persona: string): string {
  return formatPromptSection({
    title: '人格设定',
    subtitle: 'Persona',
    content: persona,
  });
}

/**
 * 格式化行为准则 (Behavior Guidelines)
 */
export function formatBehaviorContext(behavior: string): string {
  return formatPromptSection({
    title: '行为准则',
    subtitle: 'Behavior Guidelines',
    content: behavior,
  });
}

/**
 * 格式化社群黑话知识库 (Slang & Memes)
 */
export function formatSlangContext(slangContent: string): string {
  return formatPromptSection({
    title: '社群黑话知识库',
    subtitle: 'Slang & Memes',
    description:
      '以下为社群黑话及其触发情境与招牌句式索引（若对方发言契合对应场景、出现标志句式或玩梗，且前文未查过该词条时，构思回复前应调用 query_slang 工具查询详细释义与例句，已掌握则无需重复查询，严禁未查明即凭空臆测）：',
    content: slangContent,
  });
}

/**
 * 格式化会话规则与用户画像 (Memory & Profiles)
 */
export function formatMemoryContext(memoryContent: string): string {
  return formatPromptSection({
    title: '会话规则与用户画像',
    subtitle: 'Memory & Profiles',
    content: memoryContent,
  });
}
