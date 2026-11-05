/**
 * 统一附件描述符类型。
 *
 * 设计约束：
 * - `remote` 只承载 QQ / NapCat 侧标识（file_id / busid / url / forward_id）；
 * - `local` 只承载本机事实（路径 / 以字节魔数为准的格式 / md5 / 指纹）；
 * - 两者绝不互相推断，`file_id` 的伪后缀不会污染本地路径；
 * - 可选字段一律条件展开，描述符中不出现 `undefined`。
 */

export type AttachmentKind =
  | 'image'
  | 'sticker'
  | 'file'
  | 'group_file'
  | 'record'
  | 'video'
  | 'forward';

export type AttachmentOrigin = 'inbound' | 'outbound';

/** QQ / NapCat 侧的远端标识，原样保留。 */
export interface AttachmentRemoteMeta {
  /** 远端文件标识 / QQ 伪名；可能自带与本地真实格式不一致的后缀。 */
  fileId?: string;
  busid?: number;
  /** 可下载 / 可展示的远程 URL。 */
  url?: string;
  /** 合并转发 ID。 */
  forwardId?: string;
}

/** 本机落盘事实。 */
export interface AttachmentLocalMeta {
  path: string;
  /** 真实格式，以字节魔数为准（png / jpg / gif / webp / dat...）。 */
  format?: string;
  size?: number;
  md5?: string;
  /** 本地去重指纹。 */
  fingerprint?: string;
}

export interface AttachmentFaceMeta {
  id: string;
  mood?: string;
  tags?: string[];
}

export interface AttachmentDescriptor {
  kind: AttachmentKind;
  origin: AttachmentOrigin;
  remote?: AttachmentRemoteMeta;
  local?: AttachmentLocalMeta;
  face?: AttachmentFaceMeta;
  /** 原始文件名 / 群文件名。 */
  fileName?: string;
  /** 表情包摘要（如「[动画表情]」「滑稽」）。 */
  summary?: string;
  /** 入站落盘失败原因标记；供渲染如实标注，不参与猜路径。 */
  unavailable?: string;
}
