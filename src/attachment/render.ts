/**
 * 唯一附件文本渲染入口。
 *
 * 入站、出站、引用重解析、历史重放共用同一套文案：
 * - 命中表情库 → `[表情包: <face_id> (情绪: <mood>)]`（入站/出站完全一致）；
 * - 一律展示 OS 路径，绝不把 `file:///` URI 暴露给模型或历史；
 * - 远端 file_id 与本地格式互不推断。
 */

import type { AttachmentDescriptor } from './types.js';

/** 与既有 formatFacePlaceholder 保持完全一致的文案。 */
export function formatFacePlaceholder(face: { id: string; mood?: string | null }): string {
  if (face.mood && typeof face.mood === 'string' && face.mood.trim()) {
    return `[表情包: ${face.id} (情绪: ${face.mood.trim()})]`;
  }
  return `[表情包: ${face.id}]`;
}

function renderSticker(descriptor: AttachmentDescriptor): string {
  if (descriptor.face?.id) {
    return formatFacePlaceholder(descriptor.face);
  }
  const summary = descriptor.summary || descriptor.remote?.url;
  if (descriptor.local?.path) {
    return `[表情包:${summary || '表情'} 已保存: ${descriptor.local.path}]`;
  }
  return summary ? `[表情包:${summary}]` : '[表情包]';
}

function renderImage(descriptor: AttachmentDescriptor): string {
  // 普通图片若命中本地表情库（MD5 命中），与表情包一致输出语义占位符
  if (descriptor.face?.id) {
    return formatFacePlaceholder(descriptor.face);
  }
  const target =
    descriptor.local?.path ||
    descriptor.remote?.url ||
    descriptor.remote?.fileId ||
    '';
  return target ? `[图片:${target}]` : '[图片]';
}

function renderFile(descriptor: AttachmentDescriptor): string {
  const name = descriptor.fileName || '未知文件';
  if (descriptor.local?.path) {
    return `[文件:${name} 已保存: ${descriptor.local.path}]`;
  }
  if (descriptor.unavailable) {
    return `[文件:${name} (入站落盘失败)]`;
  }
  return `[文件:${name}]`;
}

function renderGroupFile(descriptor: AttachmentDescriptor): string {
  const name = descriptor.fileName || '未知文件';
  const id = descriptor.remote?.fileId ? ` (ID:${descriptor.remote.fileId})` : '';
  return `[群文件:${name}${id}]`;
}

/**
 * 渲染单个附件描述符；未知 kind 返回 null（由调用方兜底占位）。
 */
export function renderAttachment(descriptor: AttachmentDescriptor | null | undefined): string | null {
  if (!descriptor) return null;

  switch (descriptor.kind) {
    case 'sticker':
      return renderSticker(descriptor);
    case 'image':
      return renderImage(descriptor);
    case 'file':
      return renderFile(descriptor);
    case 'group_file':
      return renderGroupFile(descriptor);
    case 'record':
      return '[语音]';
    case 'video':
      return '[视频]';
    case 'forward':
      return `[合并转发 (ID:${descriptor.remote?.forwardId || ''})]`;
    default:
      return null;
  }
}

/** 批量渲染；null 项直接跳过。 */
export function renderAttachments(
  descriptors: ReadonlyArray<AttachmentDescriptor>
): string[] {
  const out: string[] = [];
  for (const descriptor of descriptors) {
    const text = renderAttachment(descriptor);
    if (text) out.push(text);
  }
  return out;
}
