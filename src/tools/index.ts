/**
 * dsh-napcat-bridge: Agent 工具集
 * 实现 read_chat_history, fetch_chat_resource, expand_forward_message, send_file, poke_user
 * 及其 DSH defineTool 工具声明与执行逻辑。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';
import type {
  FetchChatResourceParams,
  FetchChatResourceResult,
  ExpandForwardMessageParams,
  ExpandForwardMessageResult,
  SendFileParams,
  SendFileResult,
  PokeUserParams,
  PokeUserResult,
  ReadChatHistoryParams,
  ReadChatHistoryResult,
  ListGroupFilesParams,
  ListGroupFilesResult,
  ForwardNode,
  ReactMessageParams,
  ReactMessageResult,
  ListFacesParams,
  ListFacesResult,
  FaceSummaryItem,
  SendFaceParams,
  SendFaceResult,
  CollectFaceParams,
  CollectFaceResult,
  BridgePluginConfig,
  MessageRecord,
} from '../types/index.js';
import { EMOJI_MAP } from '../types/index.js';
export { EMOJI_MAP };
import type { MessageDatabase } from '../storage/database.js';
import { formatDateTime } from '../storage/database.js';
import type { MediaStorageManager } from '../storage/media.js';
import type { NapCatGatewayServer } from '../gateway/server.js';
import type { MessageWaitRegistry, WaitCollectedMessage } from '../gateway/server.js';
import type { SerialSender } from '../types/index.js';
import { classifySendFileSource, detectSendFileType } from './file-source.js';
import { downloadPrivateFile } from './private-file.js';

export interface ToolExecutionContext {
  db?: MessageDatabase | null;
  gateway?: NapCatGatewayServer | null;
  mediaManager?: MediaStorageManager | null;
  /** 共享 per-peer 串行发送器 (Spec §7.3)：主动发文件与正文/提问/审批同队列 */
  sender?: SerialSender | null;
  peer?: string;
  groupId?: string | number;
  /** EN-005: 入站消息等待收集器（wait_for_user_messages 工具） */
  waitRegistry?: MessageWaitRegistry | null;
  /** EN-005: 当前工具调用的取消信号（Agent 回合中断时中止等待） */
  signal?: AbortSignal;
  /** 当前回合入站消息 ID 获取器（react_message 省略 message_id 时默认绑定） */
  inboundMsgIdGetter?: (peer: string) => number | undefined;
  /** 表情包落盘存储目录 */
  faceDir?: string;
  /** 发送表情使用的 sub_type */
  faceSubType?: number;
  /** 表情包存储配额上限 */
  faceStoreMax?: number;
  /** 表情包淘汰策略 */
  faceEvictPolicy?: 'reject' | 'evict_lru';
}

let globalToolContext: ToolExecutionContext = {};

export function setGlobalToolContext(context: ToolExecutionContext): void {
  globalToolContext = { ...globalToolContext, ...context };
}

export function resetGlobalToolContext(): void {
  globalToolContext = {};
}

/**
 * 6.2 抓取文件/资源工具 (fetch_chat_resource)
 * 凭 file_id（群文件附带 busid）现拉外部文件到本地，返回可读取路径。
 *
 * IS-F1: 群文件判定依据「上下文 peer（group_/user_ 前缀）+ execute 已解析的 groupId +
 *         消息落库类型（group_file）」，不再用 file_id 字符串猜（NapCat 群文件 file_id 是 UUID，
 *         不含 "group"）。
 * IS-F2: 下载落盘携带 sessionId（peer），落 files/<peer>/（Spec §4.1.1/§5.2），而非 common。
 * 失败分级：gateway 未连接 / 拿不到 url / HTTP 下载失败，各自清晰文案，绝不笼统
 * “资源不存在或下载超时”（AGENTS §3.1 禁假成功/占位）。
 */
export async function fetchChatResource(
  params: FetchChatResourceParams,
  context?: ToolExecutionContext
): Promise<FetchChatResourceResult> {
  const ctx = { ...globalToolContext, ...context };

  if (!params || !params.file_id || typeof params.file_id !== 'string' || params.file_id.trim() === '') {
    return { success: false, error: '你需要指定 file_id' };
  }

  const fileId = params.file_id.trim();

  // 1. IS-F1: 判定群文件 —— 依据上下文 peer / groupId / 落库类型 (group_file)
  const sessionPeer = ctx.peer || '';
  const inGroupContext =
    (ctx.groupId !== undefined && ctx.groupId !== null && String(ctx.groupId).trim() !== '') ||
    sessionPeer.startsWith('group_') ||
    sessionPeer.startsWith('qq-group-');
  let isGroupFile = inGroupContext;

  // 落库类型佐证：peer/groupId 缺失时，若库中记录类型为 group_file 仍按群文件处理
  if (!isGroupFile && ctx.db) {
    try {
      const record = ctx.db.getByFileId(fileId);
      if (record?.type === 'group_file') {
        isGroupFile = true;
      }
    } catch {}
  }

  // 2. 一级去重: 查数据库
  if (ctx.db) {
    const record = ctx.db.getByFileId(fileId);
    if (record?.local_path && fs.existsSync(record.local_path)) {
      return { success: true, local_path: record.local_path };
    }
  }

  // 3. 群文件: get_group_file_url({groupid, fileid, busid}) → data.url → 真实落盘
  if (isGroupFile) {
    if (params.busid === undefined || params.busid === null) {
      return { success: false, error: '下载群文件缺少 busid (需同时提供 file_id 与 busid)' };
    }
    if (!ctx.gateway) {
      return {
        success: false,
        error: `下载失败: NapCat 未连接 (gateway 不可用)，无法获取群文件下载地址 (file_id: ${fileId})`,
      };
    }
    if (!ctx.mediaManager) {
      return { success: false, error: '下载失败: 媒体存储服务不可用，无法落盘' };
    }
    if (!ctx.groupId) {
      return {
        success: false,
        error: `下载失败: 缺少群组上下文 (groupId)，无法定位群文件所属群聊 (file_id: ${fileId})`,
      };
    }
    try {
      const res = await ctx.gateway.getGroupFileUrl(ctx.groupId, fileId, params.busid);
      const fileUrl = res.data?.url;
      if (!fileUrl) {
        const apiInfo = [res.wording, res.message].filter(Boolean).join(' ');
        return {
          success: false,
          error: `下载失败: NapCat 未返回群文件下载 URL (file_id: ${fileId})${apiInfo ? ` — NapCat: ${apiInfo}` : ''}`,
        };
      }
      // IS-F2: 落盘带 sessionId=peer → files/<peer>/；peer 缺失时回退 group_<groupId>
      const hasGroupId = ctx.groupId !== undefined && ctx.groupId !== null && String(ctx.groupId).trim() !== '';
      const sessionId = sessionPeer || (hasGroupId ? `group_${ctx.groupId}` : undefined);
      const saved = await ctx.mediaManager.downloadAndSave(fileUrl, {
        fileId,
        type: 'files',
        filename: params.file_name,
        ...(sessionId ? { sessionId } : {}),
      });
      return { success: true, local_path: saved.localPath };
    } catch (err: any) {
      return { success: false, error: `下载群文件失败: ${err?.message || '未知错误'}` };
    }
  }

  // 4. 非群文件（私聊 file_id 资源）：走私聊文件两级退化下载（PF-001 任务包 §3.1）——
  //    首选 get_private_file_url 直链 → 回退 get_file 本地路径翻译 → 落盘 files/<peer>/
  if (!ctx.gateway) {
    return { success: false, error: '资源获取失败: NapCat 未连接，无法拉取远程资源' };
  }
  if (!ctx.mediaManager) {
    return { success: false, error: '下载失败: 媒体存储服务不可用，无法落盘' };
  }
  const dl = await downloadPrivateFile({
    fileId,
    peer: sessionPeer || undefined,
    busid: params.busid ?? null,
    filename: params.file_name,
    gateway: ctx.gateway,
    mediaManager: ctx.mediaManager,
  });
  if (dl.ok && dl.localPath) {
    return { success: true, local_path: dl.localPath };
  }
  return { success: false, error: dl.error || '下载失败: 未知原因' };
}

/**
 * 6.3 展开合并转发工具 (expand_forward_message)
 * 根据 forward_id 调 NapCat get_forward_msg 展开合并转发消息内容。
 *
 * FC-1: 内层图片即时落盘。get_forward_msg 目前可用，且内层 image 段自带
 *       multimedia.nt.qq.com.cn 直链（带 rkey）；rkey 有时效，必须在展开当下立刻下载，
 *       不能存 url 留待以后拉取。NapCat 的 get_file / get_private_file_url 在
 *       packetBackend 不可用时整体失效（QQ 版本不匹配），故此处只走 HTTP 直链，
 *       完全不依赖 NapCat 取文件，落盘后段内写入 local_path 供 read_image 直接读。
 */

/**
 * 单次展开允许下载的内层图片上限：转发记录可能含几十上百个节点，
 * 逐张下载会拖垮整次工具调用；超出上限的段保留原始 url 不阻断。
 */
const MAX_FORWARD_IMAGE_DOWNLOADS = 10;

/** 归一化节点 content 为 OneBot 消息段数组；非 JSON 数组形态（纯文本等）返回 null */
function normalizeForwardSegments(content: unknown): any[] | null {
  if (Array.isArray(content)) return content;
  if (typeof content !== 'string') return null;
  const trimmed = content.trim();
  if (!trimmed.startsWith('[')) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** 仅接受可作为下载源的 http(s) url（QQ 上报的 data.file 常是伪后缀文件名，不可当下载源） */
function isDirectMediaUrl(url: unknown): url is string {
  return typeof url === 'string' && /^https?:\/\//i.test(url);
}

/** 从 url 显式后缀推断扩展名（QQ 的 data.file 常被无脑命名为 MD5.jpg，只有 url 才可信） */
function inferForwardUrlExt(url: string): string | undefined {
  const clean = url.split('?')[0].split('#')[0];
  const match = /\.([a-zA-Z0-9]+)$/.exec(clean);
  return match ? match[1].toLowerCase() : undefined;
}

/**
 * FC-1: 逐段尽力而为地把转发内层图片下载落盘。
 * 单张失败不阻断整次展开（失败的段保留原样，模型仍看得到 url），
 * 缺 mediaManager / url 非 http(s) / 超上限 一律跳过而非报错。
 */
async function materializeForwardImages(
  segments: any[],
  ctx: ToolExecutionContext
): Promise<{ downloaded: number; skipped: number; failed: number }> {
  let downloaded = 0;
  let skipped = 0;
  let failed = 0;

  for (const seg of segments) {
    if (!seg || seg.type !== 'image') continue;
    const data = seg.data && typeof seg.data === 'object' ? seg.data : null;
    if (!data || data.local_path) continue;

    if (!ctx.mediaManager || !isDirectMediaUrl(data.url) || downloaded >= MAX_FORWARD_IMAGE_DOWNLOADS) {
      skipped++;
      continue;
    }

    const url = data.url;
    const fileId = data.file || data.file_id || undefined;
    const isSticker = data.sub_type === 1 || Boolean(data.emoji_package_id);
    const urlExt = inferForwardUrlExt(url);
    try {
      const saved = await ctx.mediaManager.downloadAndSave(url, {
        type: isSticker ? 'sticker' : 'image',
        sessionId: ctx.peer || 'common',
        ...(fileId ? { fileId } : {}),
        ...(urlExt ? { ext: urlExt } : {}),
      });
      data.local_path = saved.localPath;
      downloaded++;
    } catch {
      failed++;
    }
  }

  return { downloaded, skipped, failed };
}
export async function expandForwardMessage(
  params: ExpandForwardMessageParams,
  context?: ToolExecutionContext
): Promise<ExpandForwardMessageResult> {
  const ctx = { ...globalToolContext, ...context };

  if (!params || !params.forward_id || typeof params.forward_id !== 'string' || params.forward_id.trim() === '') {
    return { success: false, error: '你需要指定 forward_id' };
  }

  const forwardId = params.forward_id.trim();

  if (ctx.gateway) {
    try {
      const res = await ctx.gateway.getForwardMsg(forwardId);
      const rawMessages = Array.isArray(res.data?.messages)
        ? res.data.messages
        : Array.isArray(res.data)
        ? res.data
        : [];

      const messages: ForwardNode[] = [];
      let imagesDownloaded = 0;

      for (const msg of rawMessages) {
        const rawSegments = typeof msg.content === 'string' ? msg.content : msg.message;
        const rawContent =
          typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.message || '');
        const segments = normalizeForwardSegments(rawSegments);
        let content = rawContent;

        if (segments && segments.some((seg: any) => seg && seg.type === 'image')) {
          const media = await materializeForwardImages(segments, ctx);
          imagesDownloaded += media.downloaded;
          // 仅当确有图片落盘时回写段内容；无落盘则保持既有输出形态，避免无谓改动
          if (media.downloaded > 0) {
            content = JSON.stringify(segments);
          }
        }

        messages.push({
          sender_name: msg.sender?.nickname || msg.sender_name || '未知发送者',
          user_id: String(msg.sender?.user_id || msg.user_id || ''),
          time: (msg.time || 0) < 10000000000 ? (msg.time || 0) * 1000 : msg.time || 0,
          content,
        });
      }

      return {
        success: true,
        messages,
        ...(imagesDownloaded > 0 ? { images_downloaded: imagesDownloaded } : {}),
      };
    } catch (err: any) {
      return { success: false, error: `展开合并转发失败: ${err?.message || '未知错误'}` };
    }
  }

  return { success: false, error: '展开合并转发失败: NapCat 未连接 (gateway 不可用)，无法获取合并转发内容' };
}

/**
 * 6.4 主动发送文件/图片工具 (send_file)
 * Agent 主动向当前会话发送本地生成的文件、报告或图片产物。
 *
 * IS-S1: 支持 本地绝对路径 / file:// URI / URL / Base64 四种形态，统一经
 *        classifySendFileSource 归一化；WSL(/mnt/c/...) → Windows(file:///C:/...) 路径翻译
 *        （NapCat issue #198 实锤跨文件系统路径 NapCat 解析失败）。
 * IS-S2: file_type 参数强制生效；未显式指定按扩展名自动推导。
 * IS-S4: 发送前校验本地路径存在；失败分级（本地路径不存在 / NapCat 侧无法访问 / API
 *        返回错误 / 未返回 message_id），无 gateway/peer 返回 success:false 不写死假 id。
 */
export async function sendFile(
  params: SendFileParams,
  context?: ToolExecutionContext
): Promise<SendFileResult> {
  const ctx = { ...globalToolContext, ...context };

  if (!params || !params.file_path || typeof params.file_path !== 'string' || params.file_path.trim() === '') {
    return { success: false, error: '你需要指定 file_path' };
  }

  const filePath = params.file_path.trim();

  // IS-S1: 文件源归一化 + WSL→Windows 路径翻译（无法翻译的 WSL 内部路径直接清晰报错）
  const classified = classifySendFileSource(filePath);
  if ('error' in classified) {
    return { success: false, error: classified.error };
  }
  const src = classified.source;

  if (!ctx.gateway || !ctx.peer) {
    return {
      success: false,
      error: `发送文件失败: ${!ctx.gateway ? 'NapCat 未连接 (gateway 不可用)' : '未绑定 QQ 会话(peer)'}，无法下发文件`,
    };
  }

  // IS-S4: 本地源路径存在性校验（WSL 侧可校验时；Windows 路径且盘符未挂载时跳过校验）
  if (src.localCheckPath && !fs.existsSync(src.localCheckPath)) {
    return { success: false, error: `发送文件失败: 本地路径不存在: ${src.localCheckPath}` };
  }

  try {
    // IS-S2: file_type 强制生效，缺省按扩展名自动推导
    // 注意: 返回 'image' | 'file' 均为真值字符串，必须显式比较，严禁 if (isImage) 真值判等
    const fileKind = detectSendFileType(params.file_type, src.value);

    let msgPayload: any;
    if (fileKind === 'image') {
      msgPayload = [{ type: 'image', data: { file: src.value } }];
    } else {
      msgPayload = [{ type: 'file', data: { file: src.value } }];
    }

    // 经共享 per-peer 串行队列下发，与正文/提问/审批保持同 peer 内顺序 (Spec §7.3)
    const sendTask = () => ctx.gateway!.sendMsg(ctx.peer!, msgPayload);
    const res = ctx.sender
      ? await ctx.sender.enqueue(ctx.peer, sendTask)
      : await sendTask();

    if (res && (res.status === 'failed' || (typeof res.retcode === 'number' && res.retcode !== 0))) {
      const errMsg = res.wording || res.message || `NapCat 返回错误 (retcode: ${res.retcode})`;
      return { success: false, error: errMsg };
    }

    const messageId = res?.data?.message_id;
    if (messageId === undefined || messageId === null || messageId === '') {
      // NapCat 未返回 message_id：按错误处理，绝不写死假 id (AGENTS §3.1)
      return { success: false, error: '发送结果未知: NapCat 未返回 message_id，请确认文件已成功下发' };
    }

    return {
      success: true,
      message_id: Number(messageId),
    };
  } catch (err: any) {
    return { success: false, error: `发送文件失败: ${err?.message || '未知错误'}` };
  }
}

/**
 * 6.5 戳一戳互动工具 (poke_user)
 * 主动在群内戳指定用户或在私聊窗口抖动用户。
 */
export async function pokeUser(
  params: PokeUserParams,
  context?: ToolExecutionContext
): Promise<PokeUserResult> {
  const ctx = { ...globalToolContext, ...context };

  if (!params || !params.user_id || typeof params.user_id !== 'string' || params.user_id.trim() === '') {
    return { success: false, error: '你需要指定 User ID' };
  }

  const userId = params.user_id.trim();

  if (ctx.gateway) {
    try {
      const res = await ctx.gateway.sendPoke(userId, ctx.groupId);
      if (res && (res.status === 'failed' || (typeof res.retcode === 'number' && res.retcode !== 0))) {
        const errMsg = res.wording || res.message || `NapCat 返回错误 (retcode: ${res.retcode})`;
        return { success: false, error: errMsg };
      }
      return { success: true };
    } catch (err: any) {
      return { success: false, error: `戳一戳执行失败: ${err?.message || '未知错误'}` };
    }
  }

  return { success: false, error: '戳一戳执行失败: NapCat 未连接 (gateway 不可用)' };
}

export function normalizePeer(peer: string): string {
  const groupMatch = peer.match(/^qq-group-([^-]+)/);
  if (groupMatch) return `group_${groupMatch[1]}`;
  const userMatch = peer.match(/^qq-user-([^-]+)/);
  if (userMatch) return `user_${userMatch[1]}`;
  return peer;
}

/**
 * 6.1 读历史记录工具 (read_chat_history)
 * 检索当前群聊或私聊的历史聊天记录，支持多维度组合筛选。
 */
export async function readChatHistory(
  peerOrParams: string | (ReadChatHistoryParams & { peer?: string }),
  paramsOrDb?: ReadChatHistoryParams | MessageDatabase,
  maybeDb?: MessageDatabase
): Promise<ReadChatHistoryResult> {
  let peer = '';
  let params: ReadChatHistoryParams = {};
  let db = maybeDb || globalToolContext.db;

  if (typeof peerOrParams === 'string') {
    peer = normalizePeer(peerOrParams);
    if (paramsOrDb && typeof (paramsOrDb as any).readHistory === 'function') {
      db = paramsOrDb as MessageDatabase;
    } else {
      params = (paramsOrDb as ReadChatHistoryParams) || {};
    }
  } else if (typeof peerOrParams === 'object' && peerOrParams !== null) {
    peer = normalizePeer(peerOrParams.peer || globalToolContext.peer || '');
    params = peerOrParams;
    if (paramsOrDb && typeof (paramsOrDb as any).readHistory === 'function') {
      db = paramsOrDb as MessageDatabase;
    }
  }

  if (!db) {
    return { messages: [], total: 0 };
  }

  return db.readHistory(peer, params);
}

/**
 * 格式化群文件列表输出为清晰的 Markdown 文本
 */
export function renderGroupFilesText(result: ListGroupFilesResult): string {
  if (!result.success && result.error) {
    return `群文件查询失败: ${result.error}`;
  }
  if (!result.files || result.files.length === 0) {
    return '未查询到符合条件的群文件记录。';
  }
  const lines: string[] = [`共找到 ${result.total} 个群文件 (本次展示 ${result.files.length} 个):`];
  for (const f of result.files) {
    const sizeStr = f.size ? ` (${(f.size / 1024).toFixed(1)} KB)` : '';
    lines.push(`- ${f.file_name}${sizeStr}`);
    lines.push(`  • file_id: ${f.file_id}`);
    lines.push(`  • busid: ${f.busid}`);
    lines.push(`  • 上传者: ${f.sender_name} (${f.user_id})`);
    lines.push(`  • 时间: ${f.formatted_time || f.time}`);
  }
  lines.push('\n提示: 如需读取文件内容，请调用 fetch_chat_resource(file_id=..., busid=...) 下载。');
  return lines.join('\n');
}

/**
 * 6.6 获取群文件列表工具 (list_group_files)
 * 从 SQLite 按 type='group_file' + peer 筛选群文件记录。
 */
export async function listGroupFiles(
  params: ListGroupFilesParams = {},
  context?: ToolExecutionContext
): Promise<ListGroupFilesResult> {
  const ctx = { ...globalToolContext, ...context };
  const rawPeer = ctx.peer || '';
  const peer = normalizePeer(rawPeer);

  if (!peer.startsWith('group_') && !peer.startsWith('qq-group-')) {
    return {
      success: false,
      files: [],
      total: 0,
      error: '当前会话不是群聊，无群文件记录 (私聊文件请使用 read_chat_history)',
    };
  }

  const db = ctx.db;
  if (!db) {
    return {
      success: false,
      files: [],
      total: 0,
      error: '数据库不可用，无法查询群文件列表',
    };
  }

  const result = db.listGroupFiles(peer, params);
  return {
    success: true,
    files: result.files,
    total: result.total,
  };
}

/**
 * EN-005: wait_for_user_messages 工具
 * Agent 在一轮内挂起，收集一段时间内到达的当前会话新消息后返回，实现单轮多消息交互。
 *
 * 两层报错原则：
 * - 状态层：超时 0 条消息 → 'No messages received within the specified timeout'（不给建议，
 *   Agent 自己推理下一步）；timeout 参数缺失/非法、非 QQ 会话、waitRegistry 未装配 → 中文清晰文案
 * - 依赖层：user_id 语法非法（非纯数字 QQ 号）或私聊传给与实际会话对象不符的 user_id →
 *   'Unknown user_id, cannot wait for messages'（语法级校验，用户拍板：不做存在性 API 校验）
 */
export interface WaitForUserMessagesParams {
  timeout?: number;
  user_id?: string;
}

export type WaitForUserMessagesResult =
  | { messages: WaitCollectedMessage[]; total: number }
  | { success: false; error: string };

/** QQ 号语法级校验：5~12 位纯数字（用户拍板「语法级校验」口径） */
const QQ_ID_RE = /^\d{5,12}$/;

export async function waitForUserMessages(
  params: WaitForUserMessagesParams,
  context?: ToolExecutionContext
): Promise<WaitForUserMessagesResult> {
  const ctx = { ...globalToolContext, ...context };

  // 1. timeout 参数校验（状态层）
  const timeout = params?.timeout;
  if (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout <= 0) {
    return { success: false, error: '你需要指定有效的 timeout（等待秒数，>0）' };
  }

  // 2. 会话 peer 校验（review-* 等非 QQ 会话不支持等待）
  const peer = normalizePeer(ctx.peer || '');
  if (!peer.startsWith('group_') && !peer.startsWith('user_')) {
    return { success: false, error: '当前会话不是 QQ 会话，无法等待用户消息' };
  }

  // 3. user_id 语法级校验（依赖层）：格式非法 → 原文报错；私聊对象不符 → 原文报错
  let userId: string | undefined;
  const rawUserId = params?.user_id;
  if (rawUserId !== undefined && rawUserId !== null) {
    const uid = String(rawUserId).trim();
    if (uid === '' || !QQ_ID_RE.test(uid)) {
      return { success: false, error: 'Unknown user_id, cannot wait for messages' };
    }
    if (peer.startsWith('user_') && uid !== peer.slice(5)) {
      return { success: false, error: 'Unknown user_id, cannot wait for messages' };
    }
    userId = uid;
  }

  // 4. registry 未装配 → 状态层明确报错（不悬挂、不走等待）
  if (!ctx.waitRegistry) {
    return { success: false, error: '消息等待服务不可用（waitRegistry 未装配），无法等待用户消息' };
  }

  // 5. 挂起等待（纯超时窗口，Agent 自行决定 timeout；取消由 exec.signal 传导）
  const result = await ctx.waitRegistry.wait(peer, {
    userId,
    timeoutMs: Math.round(timeout * 1000),
    signal: ctx.signal,
  });

  // 6. 结算结果映射（状态层报错原文透传，不给建议）
  if (result.ok) {
    return { messages: result.messages, total: result.messages.length };
  }
  return { success: false, error: result.message };
}

/** EN-005: 等待结果渲染文本（成功列出收集消息；失败显示 error） */
export function renderWaitResultText(value: WaitForUserMessagesResult): string {
  if (!('messages' in value)) {
    return `等待用户消息失败: ${value.error}`;
  }
  const messages = value.messages;
  if (messages.length === 0) {
    return '未收集到新消息。';
  }
  const lines = messages.map((m, i) => {
    const head = m.from || m.user_id || '未知用户';
    const timeStr = m.time ? formatDateTime(m.time) : '';
    return `${i + 1}. [${head}${timeStr ? ` ${timeStr}` : ''}] ${m.content}`;
  });
  return `已收集 ${messages.length} 条新消息:\n${lines.join('\n')}`;
}

/**
 * 6.8 贴表情回应工具 (react_message)
 * 通过 NapCat OneBot 11 扩展接口 set_msg_emoji_like 对群聊消息添加表情回应。
 */
export async function reactMessage(
  params: ReactMessageParams,
  context?: ToolExecutionContext
): Promise<ReactMessageResult> {
  const ctx = { ...globalToolContext, ...context };

  if (!params || !params.emoji || typeof params.emoji !== 'string' || !(params.emoji in EMOJI_MAP)) {
    return {
      success: false,
      error: `未知的表情名 '${params?.emoji}'。请从以下支持的表情中选择: ${Object.keys(EMOJI_MAP).join(', ')}`,
    };
  }

  const key = params.emoji;
  const item = EMOJI_MAP[key];

  let msgId: number | undefined;
  if (params.message_id !== undefined && params.message_id !== null && String(params.message_id).trim() !== '') {
    const parsed = Number(params.message_id);
    if (!Number.isNaN(parsed)) {
      msgId = parsed;
    }
  }

  if (msgId === undefined) {
    const peer = ctx.peer || '';
    if (ctx.inboundMsgIdGetter) {
      msgId = ctx.inboundMsgIdGetter(peer) ?? ctx.inboundMsgIdGetter(normalizePeer(peer));
    }
  }

  if (msgId === undefined || Number.isNaN(msgId)) {
    return {
      success: false,
      error: '未提供 message_id 且当前回合无入站消息上下文',
    };
  }

  if (!ctx.gateway) {
    return {
      success: false,
      error: 'NapCat 未连接 (gateway 不可用)',
    };
  }

  try {
    const res = await ctx.gateway.setMsgEmojiLike(msgId, item.id);
    if (res && (res.status === 'failed' || (typeof res.retcode === 'number' && res.retcode !== 0))) {
      return {
        success: false,
        error: res.wording || res.message || `NapCat API 调用失败 (retcode: ${res.retcode})`,
      };
    }
    return {
      success: true,
      message_id: msgId,
      emoji: key,
      emoji_id: item.id,
    };
  } catch (err: any) {
    return {
      success: false,
      error: err?.message || '未知错误',
    };
  }
}

/**
 * 6.9 检索表情包工具 (list_faces)
 * 按情绪 (mood) 或内容标签 (tag) 检索本地可用表情包。
 * 强制分页，仅返回语义元数据 (id, tags, mood, format)，坚决不出物理路径或 URL。
 */
export async function listFaces(
  params: ListFacesParams,
  context?: ToolExecutionContext
): Promise<ListFacesResult> {
  const ctx = { ...globalToolContext, ...context };
  if (!ctx.db) {
    return { faces: [], total: 0, has_more: false };
  }
  const limit = Math.min(Math.max(params?.limit ?? 100, 1), 100);
  const offset = params?.cursor ? parseInt(params.cursor, 10) || 0 : 0;
  const queryRes = ctx.db.queryFaces({
    mood: params?.mood,
    tag: params?.tag,
    untagged: params?.untagged,
    limit,
    offset,
    enabledOnly: true,
  });

  const faces: FaceSummaryItem[] = queryRes.faces.map((f) => ({
    id: f.id,
    tags: f.tags,
    mood: f.mood,
    format: f.format,
    file_path: f.file_path,
  }));

  return {
    faces,
    total: queryRes.total,
    has_more: queryRes.has_more,
    next_cursor: queryRes.has_more ? String(offset + limit) : undefined,
  };
}

/**
 * 6.10 发送表情包工具 (send_face)
 * 凭 face_id 构造带有 sub_type=1 的 image 消息段，并通过共享串行队列出站。
 */
export async function sendFace(
  params: SendFaceParams,
  context?: ToolExecutionContext
): Promise<SendFaceResult> {
  const ctx = { ...globalToolContext, ...context };
  if (!params || !params.face_id || typeof params.face_id !== 'string' || !params.face_id.trim()) {
    return { success: false, error: '缺少 face_id 参数' };
  }
  if (!ctx.db) {
    return { success: false, error: '数据库不可用' };
  }

  const faceId = params.face_id.trim();
  const face = ctx.db.getFaceById(faceId);
  if (!face) {
    return { success: false, error: `表情 ID "${faceId}" 不存在或已被删除` };
  }
  if (!face.enabled) {
    return { success: false, error: `表情 ID "${faceId}" 已禁用，不可发送` };
  }
  if (!ctx.gateway) {
    return { success: false, error: '网关未连接，无法发送表情' };
  }

  const sessionPeer = ctx.peer || '';
  const inGroup =
    (ctx.groupId !== undefined && ctx.groupId !== null && String(ctx.groupId).trim() !== '') ||
    sessionPeer.startsWith('group_') ||
    sessionPeer.startsWith('qq-group-');

  const normalizedPath = face.file_path.replace(/\\/g, '/');
  const fileUri = normalizedPath.startsWith('file:///')
    ? normalizedPath
    : `file:///${normalizedPath.replace(/^\/+/, '')}`;
  const subType = ctx.faceSubType ?? 1;

  const segments = [
    {
      type: 'image',
      data: {
        file: fileUri,
        sub_type: subType,
      },
    },
  ];

  const doSend = async (): Promise<SendFaceResult> => {
    try {
      let res: any;
      if (inGroup) {
        const groupId = String(ctx.groupId || sessionPeer.replace(/^(qq-group-|group_)/, '').split('-')[0]);
        res = await ctx.gateway!.sendGroupMsg(groupId, segments as any);
      } else {
        const userId = sessionPeer.replace(/^(qq-user-|user_)/, '').split('-')[0];
        res = await ctx.gateway!.sendPrivateMsg(userId, segments as any);
      }

      if (res && (res.status === 'failed' || (typeof res.retcode === 'number' && res.retcode !== 0))) {
        return {
          success: false,
          error: res.wording || res.message || `NapCat 发送表情失败 (retcode: ${res.retcode})`,
        };
      }

      // 发送成功后累加使用频次与刷新时间
      ctx.db!.recordFaceUsage(face.id);
      const messageId = res?.data?.message_id;
      return {
        success: true,
        message_id: typeof messageId === 'number' ? messageId : undefined,
      };
    } catch (err: any) {
      return {
        success: false,
        error: `发送表情异常: ${err?.message || '未知错误'}`,
      };
    }
  };

  if (ctx.sender) {
    return ctx.sender.enqueue(sessionPeer || 'common', doSend);
  }
  return doSend();
}

/**
 * 6.11 即时偷表情/收藏/编辑工具 (collect_face)
 * - 若提供 face_id: 执行表情编辑/补标模式（Agent 必须提供 tags 与 mood）
 * - 若未提供 face_id: 从指定消息（或当前正在回复的入站消息）中提取图片并收录进表情库（Agent 必须提供 tags 与 mood）
 */
export async function collectFace(
  params: CollectFaceParams,
  context?: ToolExecutionContext & { faceDir?: string }
): Promise<CollectFaceResult> {
  const ctx = { ...globalToolContext, ...context };

  if (!params || !params.tags || !Array.isArray(params.tags) || params.tags.length === 0) {
    return { success: false, error: '缺少必填参数 tags (内容画面标签，如 ["猫猫", "叹气"])' };
  }
  if (!params.mood || typeof params.mood !== 'string' || !params.mood.trim()) {
    return { success: false, error: '缺少必填参数 mood (情绪语境意图，如 "嘲讽" / "卖萌" / "感谢")' };
  }
  if (!ctx.db) {
    return { success: false, error: '数据库不可用' };
  }

  // 分支 1: 编辑/补标已有表情
  if (params.face_id && typeof params.face_id === 'string' && params.face_id.trim()) {
    const faceId = params.face_id.trim();
    const existing = ctx.db.getFaceById(faceId);
    if (!existing) {
      return { success: false, error: `表情 ID "${faceId}" 不存在` };
    }
    const updated = ctx.db.updateFace(faceId, {
      tags: params.tags,
      mood: params.mood.trim(),
    });
    return {
      success: true,
      face_id: faceId,
      message: `已成功为表情 "${faceId}" 补全标签与情绪（标签: [${(updated?.tags || []).join(', ')}]，情绪: ${updated?.mood || '未设置'}）`,
    };
  }

  // 分支 2: 偷图/收藏新表情
  const sessionPeer = ctx.peer || '';
  let targetMsgId = params.message_id;
  if (!targetMsgId && ctx.inboundMsgIdGetter && sessionPeer) {
    targetMsgId = ctx.inboundMsgIdGetter(sessionPeer);
  }

  let targetMsg: MessageRecord | null = null;
  if (targetMsgId) {
    targetMsg = ctx.db.getMessage(targetMsgId);
  } else if (sessionPeer) {
    const recent = ctx.db.readHistory(sessionPeer, { has_file: true, limit: 1 });
    if (recent.messages.length > 0) {
      targetMsg = ctx.db.getMessage(recent.messages[0].msg_id);
    }
  }

  if (!targetMsg) {
    return { success: false, error: '未找到指定的消息记录' };
  }

  const hasImg =
    targetMsg.type === 'image' ||
    targetMsg.type === 'sticker' ||
    (typeof targetMsg.raw === 'string' && (targetMsg.raw.includes('"image"') || targetMsg.raw.includes('CQ:image')));

  if (!hasImg) {
    return { success: false, error: '目标消息中未找到图片或表情附件' };
  }

  let localPath = targetMsg.local_path;
  if (!localPath || !fs.existsSync(localPath)) {
    return { success: false, error: '目标消息的图片本地缓存文件不存在，无法转存' };
  }

  try {
    const fileBuf = fs.readFileSync(localPath);
    const md5 = crypto.createHash('md5').update(fileBuf).digest('hex');
    const ext = path.extname(localPath).replace(/^\./, '').toLowerCase() || 'png';
    const size = fileBuf.length;

    const storeDir = context?.faceDir || ctx.faceDir || path.resolve('.dsh/napcat/faces');
    fs.mkdirSync(storeDir, { recursive: true });
    const targetFile = path.join(storeDir, `${md5}.${ext}`);

    if (!fs.existsSync(targetFile)) {
      fs.copyFileSync(localPath, targetFile);
    }

    const faceId = `face_${md5.slice(0, 8)}`;
    const safeTags = params.tags;
    const safeMood = params.mood.trim();

    const res = ctx.db.insertFace(
      {
        id: faceId,
        file_path: targetFile,
        md5,
        source: 'collect',
        tags: safeTags,
        mood: safeMood,
        enabled: true,
        size,
        format: ext,
      },
      {
        max: ctx.faceStoreMax,
        evictPolicy: ctx.faceEvictPolicy,
      }
    );

    if (res.duplicated) {
      return {
        success: true,
        duplicated: true,
        face_id: res.id,
        message: `该表情包已在你的表情库中存在（已有标签: [${res.tags.join(', ')}]，情绪: ${res.mood || '未设置'}）`,
      };
    }

    return {
      success: true,
      face_id: res.id,
      message: `已成功收藏表情包，标签: [${safeTags.join(', ')}]，情绪: ${safeMood}`,
    };
  } catch (err: any) {
    return { success: false, error: `表情入库失败: ${err?.message || '未知错误'}` };
  }
}

/**
 * 将文本按最大长度分段（默认 1500 字符），优先在换行处断句，其次在空格处断句。
 */
export function splitMessageText(text: string, maxLength = 1500): string[] {
  if (!text) return [];
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxLength) {
    let splitIdx = remaining.lastIndexOf('\n', maxLength);
    if (splitIdx < Math.floor(maxLength * 0.5)) {
      splitIdx = remaining.lastIndexOf(' ', maxLength);
    }
    if (splitIdx < Math.floor(maxLength * 0.5)) {
      splitIdx = maxLength;
    }
    const chunk = remaining.slice(0, splitIdx).trim();
    if (chunk) {
      chunks.push(chunk);
    }
    remaining = remaining.slice(splitIdx).trim();
  }
  if (remaining.length > 0) {
    chunks.push(remaining);
  }
  return chunks;
}

/**
 * 注册 Agent 工具集至 DSH 工具运行时 (ctx.tools)
 */
export function registerAgentTools(
  ctx: Context,
  options: {
    db: MessageDatabase;
    gateway?: NapCatGatewayServer;
    mediaManager: MediaStorageManager;
    sender?: SerialSender;
    dshHome?: string;
    waitRegistry?: MessageWaitRegistry;
    inboundMsgIdGetter?: (peer: string) => number | undefined;
    config?: (() => BridgePluginConfig) | BridgePluginConfig;
  }
): () => void {
  const getConfig = (): BridgePluginConfig => {
    if (typeof (options as any).config === 'function') {
      return (options as any).config() || {};
    }
    if ((options as any).config && typeof (options as any).config === 'object') {
      return (options as any).config;
    }
    return {};
  };

  const currentCfg = getConfig();

  setGlobalToolContext({
    db: options.db,
    gateway: options.gateway,
    mediaManager: options.mediaManager,
    sender: options.sender,
    waitRegistry: options.waitRegistry,
    inboundMsgIdGetter: options.inboundMsgIdGetter,
    faceDir: currentCfg.face_store_dir,
    faceSubType: currentCfg.face_sub_type,
    faceStoreMax: currentCfg.face_store_max,
    faceEvictPolicy: currentCfg.face_evict_policy,
  });

  const unregisters: Array<() => void> = [];

  const doRegister = (tools: any) => {
    if (!tools || typeof tools.register !== 'function' || unregisters.length > 0) {
      return;
    }

    // 1. read_chat_history
    unregisters.push(
      tools.register(
        defineTool({
          name: 'read_chat_history',
          description:
            '检索当前群聊或私聊的历史聊天记录，支持关键词、发送者昵称、消息类型、相对时间/自然日期等多维度组合筛选。',
          parameters: {
            keyword: { type: 'string', description: '按消息文本内容关键词模糊搜索' },
            sender_name: { type: 'string', description: '按发送者昵称或群名片模糊搜索' },
            user_id: { type: 'string', description: '按指定发送者 QQ 号精确筛选' },
            type: {
              type: 'string',
              description:
                "按消息类型筛选，如 'text'(文本), 'image'(图片), 'sticker'(表情包), 'file'(私聊文件), 'group_file'(群文件), 'forward'(合并转发), 'poke'(戳一戳)",
            },
            since: {
              type: 'string',
              description:
                "起始时间：支持毫秒时间戳数字、相对时间 (如 '30m', '2h', '1d', '7d') 或自然日期时间字符串 (如 '2026-08-30', '2026-08-30 14:00')",
            },
            until: {
              type: 'string',
              description: '截止时间：支持毫秒时间戳数字、相对时间或自然日期时间字符串',
            },
            relative: {
              type: 'string',
              description: "快捷相对时间窗口：检索过去指定时间段内的消息 (如 '1h', '6h', '1d', '7d')",
            },
            has_file: { type: 'boolean', description: '是否仅筛选带有文件/图片/媒体附件的消息' },
            reply_to: { type: 'number', description: '查询引用了指定 msg_id 的直接回复消息' },
            exclude_self: { type: 'boolean', description: '是否排除机器人自身的发言 (默认 false)' },
            self_only: { type: 'boolean', description: '是否仅查询机器人自身的发言 (默认 false)' },
            limit: { type: 'number', description: '返回最大条数 (默认 20，上限 100)' },
            order: { type: 'string', enum: ['asc', 'desc'], description: "时间排序 (默认 'desc' 倒序，取最新消息)" },
          },
          output: {
            schema: { type: 'json' },
            render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
          },
          async execute(args, exec) {
            const session = (exec.agent as any)?.session;
            const rawPeer = session?.id || 'common';
            const peer = normalizePeer(rawPeer);
            return (await readChatHistory(peer, args, options.db)) as any;
          },
        })
      )
    );

    // 2. fetch_chat_resource
    unregisters.push(
      tools.register(
        defineTool({
          name: 'fetch_chat_resource',
          description: '凭 file_id（群文件附带 busid）现拉外部文件到本地，返回可读取路径。',
          parameters: {
            file_id: { type: 'string', required: true, description: '资源 ID (必填)' },
            busid: { type: 'number', description: '群文件专用 busid (群文件必填)' },
            file_name: { type: 'string', description: '保存文件名建议' },
          },
          output: {
            schema: { type: 'json' },
            render: (_args, value) => [
              {
                type: 'text',
                text: (value as any).success
                  ? `资源已就绪: ${(value as any).local_path}`
                  : `资源抓取失败: ${(value as any).error}`,
              },
            ],
          },
          async execute(args, exec) {
            const session = (exec.agent as any)?.session;
            const rawPeer = session?.id || '';
            const peer = normalizePeer(rawPeer);
            const groupId =
              peer.startsWith('qq-group-') || peer.startsWith('group_')
                ? peer.replace(/^(qq-group-|group_)/, '').split('-')[0]
                : undefined;
            const res = (await fetchChatResource(args, {
              db: options.db,
              gateway: options.gateway,
              mediaManager: options.mediaManager,
              sender: options.sender,
              peer,
              groupId,
            })) as any;
            if (res && res.success === false) {
              throw new Error(res.error || 'fetch_chat_resource 失败');
            }
            return res;
          },
        })
      )
    );

    // 3. expand_forward_message
    unregisters.push(
      tools.register(
        defineTool({
          name: 'expand_forward_message',
          description:
            '根据 forward_id 展开合并转发消息内容。内层图片会自动下载到本地，段内返回 local_path，可直接用 read_image 查看。',
          parameters: {
            forward_id: { type: 'string', required: true, description: '合并转发 ID (必填)' },
          },
          output: {
            schema: { type: 'json' },
            render: (_args, value) => [
              {
                type: 'text',
                text: (value as any).success
                  ? JSON.stringify((value as any).messages, null, 2)
                  : `展开合并转发失败: ${(value as any).error}`,
              },
            ],
          },
          async execute(args, exec) {
            // FC-1: 传入 peer，内层图片落盘到 image/<peer>/ 而非 common（对齐入站图片与 Spec §4.1.1）
            const session = (exec.agent as any)?.session;
            const peer = normalizePeer(session?.id || '');
            const res = (await expandForwardMessage(args, {
              gateway: options.gateway,
              mediaManager: options.mediaManager,
              ...(peer ? { peer } : {}),
            })) as any;
            if (res && res.success === false) {
              throw new Error(res.error || 'expand_forward_message 失败');
            }
            return res;
          },
        })
      )
    );

    // 4. send_file
    unregisters.push(
      tools.register(
        defineTool({
          name: 'send_file',
          description: 'Agent 主动向当前会话发送本地生成的文件、报告或图片产物。',
          parameters: {
            file_path: { type: 'string', required: true, description: '本地绝对路径、file:// URI 或 URL (必填)' },
            file_type: { type: 'string', enum: ['image', 'file'], description: '文件类型 (默认按扩展名自动推导)' },
          },
          output: {
            schema: { type: 'json' },
            render: (_args, value) => [
              {
                type: 'text',
                text: (value as any).success
                  ? `文件发送成功 (message_id: ${(value as any).message_id})`
                  : `文件发送失败: ${(value as any).error}`,
              },
            ],
          },
          async execute(args, exec) {
            const session = (exec.agent as any)?.session;
            const rawPeer = session?.id || '';
            const peer = normalizePeer(rawPeer);
            const res = (await sendFile(args, {
              gateway: options.gateway,
              sender: options.sender,
              peer,
            })) as any;
            if (res && res.success === false) {
              throw new Error(res.error || 'send_file 失败');
            }
            return res;
          },
        })
      )
    );

    // 5. poke_user
    unregisters.push(
      tools.register(
        defineTool({
          name: 'poke_user',
          description: '主动在群内戳指定用户或在私聊窗口抖动用户。',
          parameters: {
            user_id: { type: 'string', required: true, description: '目标用户的 QQ 号 (必填)' },
          },
          output: {
            schema: { type: 'json' },
            render: (args, value) => [
              {
                type: 'text',
                text: (value as any).success
                  ? `已成功戳了用户 ${args.user_id}`
                  : `戳一戳失败: ${(value as any).error}`,
              },
            ],
          },
          async execute(args, exec) {
            const session = (exec.agent as any)?.session;
            const rawPeer = session?.id || '';
            const peer = normalizePeer(rawPeer);
            const groupId =
              peer.startsWith('qq-group-') || peer.startsWith('group_')
                ? peer.replace(/^(qq-group-|group_)/, '').split('-')[0]
                : undefined;
            const res = (await pokeUser(args, { gateway: options.gateway, groupId })) as any;
            if (res && res.success === false) {
              throw new Error(res.error || 'poke_user 失败');
            }
            return res;
          },
        })
      )
    );

    // 6. list_group_files
    unregisters.push(
      tools.register(
        defineTool({
          name: 'list_group_files',
          description:
            '获取当前群聊的历史上传文件列表。返回包含文件名、上传者、时间、file_id 和 busid 的清单。获取到所需文件的 file_id 和 busid 后，可调用 fetch_chat_resource 工具进行下载。',
          parameters: {
            file_name: { type: 'string', description: '按群文件名模糊搜索（如 ".pdf", "周报"）' },
            sender_name: { type: 'string', description: '按上传者昵称或群名片模糊搜索' },
            user_id: { type: 'string', description: '按上传者 QQ 号精确筛选' },
            since: {
              type: 'string',
              description:
                "起始时间：支持相对时间 (如 '7d', '2w') 或自然日期 (如 '2026-08-25', '2026-08-30 14:00')",
            },
            until: {
              type: 'string',
              description: '截止时间：支持相对时间或自然日期时间字符串',
            },
            limit: { type: 'number', description: '返回最大数量 (默认 20，上限 100)' },
            order: {
              type: 'string',
              enum: ['asc', 'desc'],
              description: "排序方式 (默认 'desc' 倒序，取最新上传的文件)",
            },
          },
          output: {
            schema: { type: 'json' },
            render: (_args, value) => [
              {
                type: 'text',
                text: renderGroupFilesText(value as any),
              },
            ],
          },
          async execute(args, exec) {
            const session = (exec.agent as any)?.session;
            const rawPeer = session?.id || '';
            const peer = normalizePeer(rawPeer);
            return (await listGroupFiles(args, {
              db: options.db,
              peer,
            })) as any;
          },
        })
      )
    );

    // 7. wait_for_user_messages (EN-005)
    unregisters.push(
      tools.register(
        defineTool({
          name: 'wait_for_user_messages',
          description:
            '挂起等待当前会话的新用户消息：设置一个等待窗口（timeout 秒），收集窗口内到达的该会话消息后一次性返回。适用于对方只说了半句话、需要用户继续补充内容时（实现单轮多消息交互）。窗口内收到多少条就返回多少条；一条都没收到会返回状态层报错，可反复调用直到收齐或决定结束本轮。',
          parameters: {
            timeout: {
              type: 'number',
              required: true,
              description: '等待秒数（正数），由你自行决定，插件不做限制。例如回答等待补充信息时传 60~180',
            },
            user_id: {
              type: 'string',
              description: '群聊时指定只收集该 QQ 号的消息；私聊无需传（天然单用户）',
            },
          },
          output: {
            schema: { type: 'json' },
            render: (_args, value) => [{ type: 'text', text: renderWaitResultText(value as any) }],
          },
          timeoutMs: 600_000,
          async execute(args, exec) {
            const session = (exec.agent as any)?.session;
            const rawPeer = session?.id || '';
            const peer = normalizePeer(rawPeer);
            const res = (await waitForUserMessages(args, {
              waitRegistry: options.waitRegistry,
              peer,
              signal: exec.signal,
            })) as any;
            if (res && 'error' in res && !('messages' in res)) {
              throw new Error(res.error || 'wait_for_user_messages 失败');
            }
            return res;
          },
        })
      )
    );

    // 8. react_message
    unregisters.push(
      tools.register(
        defineTool({
          name: 'react_message',
          description: '收到消息时可调用本工具，以表情回应。',
          parameters: {
            emoji: {
              type: 'string',
              required: true,
              enum: Object.keys(EMOJI_MAP),
              description:
                '表情语义键（对应 QQ 群消息回应表情）。可选值与具体语境含义：\n' +
                '- thumbs_up: 点赞 / 收到 / 认可\n' +
                '- heart: 爱心 / 喜爱 / 感谢支持\n' +
                '- laugh: 笑哭 / 搞笑 / 无奈破防\n' +
                '- grin: 呲牙 / 开心笑 / 友好打招呼\n' +
                '- snicker: 偷笑 / 窃喜 / 暗爽使坏\n' +
                '- doge: 狗头 / 滑稽调侃 / 友军反讽防误伤\n' +
                '- ok: OK / 确认收到 / 没问题\n' +
                '- cry: 大哭 / 难过 / 心疼太惨了\n' +
                '- grievance: 委屈 / 可怜巴巴 / 受委屈\n' +
                '- hug: 抱抱 / 温暖安慰 / 抱团\n' +
                '- rose: 玫瑰 / 鲜花 / 感谢致意\n' +
                '- cheer: 打call / 加油应援 / 振奋\n' +
                '- touch_fish: 摸鱼 / 划水 / 下班偷闲\n' +
                '- celebrate: 礼花 / 庆祝 / 大吉恭喜\n' +
                '- cute: 卖萌 / 可爱乖巧\n' +
                '- thinking: 托腮 / 思考琢磨 / 好奇观望\n' +
                '- sweat: 辣眼睛 / 尴尬 / 汗颜无语\n' +
                '- cat: 喵喵 / 猫咪卖萌 / 嗷呜\n' +
                '- skull: 骷髅头 / 寄了 / 完蛋暴毙 / 吓人\n' +
                '- poop: 便便 / 恶搞吐槽 / 嫌弃\n' +
                '- pig: 猪头 / 笨蛋调侃 / 亲切吐槽\n' +
                '- button: 狂按按钮 / 强烈赞同(+10086) / 疯狂催促\n' +
                '- hammer: 木槌敲头 / 敲打制裁 / 清醒一下\n' +
                '- baldy: 头秃 / 掉发 / 码农太难了\n' +
                '- victim: 大怨种 / 倒霉背锅 / 冤大头\n' +
                '- rage: 爆筋 / 生气愤怒 / 忍无可忍',
            },
            message_id: {
              type: 'number',
              description: '要回应的目标消息 ID。可省略，省略时自动绑定当前回合正在回复的入站消息',
            },
          },
          output: {
            schema: { type: 'json' },
            render: (args, value) => {
              const v = value as any;
              if (v?.success) {
                const item = EMOJI_MAP[v.emoji || args?.emoji];
                const emojiName = item ? item.name : (v?.emoji || args?.emoji);
                return [
                  {
                    type: 'text',
                    text: `已对消息 ${v.message_id} 贴表情 [${emojiName}]`,
                  },
                ];
              }
              return [
                {
                  type: 'text',
                  text: `贴表情失败: ${v?.error}`,
                },
              ];
            },
          },
          async execute(args, exec) {
            const session = (exec.agent as any)?.session;
            const rawPeer = session?.id || '';
            const peer = normalizePeer(rawPeer);
            const res = (await reactMessage(args, {
              gateway: options.gateway,
              inboundMsgIdGetter: options.inboundMsgIdGetter,
              peer,
            })) as any;
            if (res && res.success === false) {
              throw new Error(res.error || 'react_message 失败');
            }
            return res;
          },
        })
      )
    );

    // 9. 表情包能力 (由 face_enabled 总开关前置门控)
    if (getConfig().face_enabled) {
      // 9.1 list_faces
      unregisters.push(
        tools.register(
          defineTool({
            name: 'list_faces',
            description:
              '检索当前本地表情包库中的可用表情。支持按情绪 (mood)、内容标签 (tag) 或筛选未打标表情 (untagged) 检索，返回表情列表与本地图片路径（可供查看）。严禁在回复中编造不存在的表情 ID。',
            parameters: {
              mood: {
                type: 'string',
                description: '按情绪或语境筛选，如 "嘲讽", "卖萌", "赞同", "无奈", "开心"',
              },
              tag: {
                type: 'string',
                description: '按画面元素或文字标签筛选，如 "猫猫", "熊猫头", "问号"',
              },
              untagged: {
                type: 'boolean',
                description: '是否只检索尚未打标的表情（默认 false）。设为 true 可配合读图查看并调用 collect_face 进行补标。',
              },
              limit: {
                type: 'number',
                description: '返回数量上限 (默认 100，上限 100)',
              },
              cursor: {
                type: 'string',
                description: '分页游标偏移量 (取自上一次返回的 next_cursor)',
              },
            },
            output: {
              schema: { type: 'json' },
              render: (_args, value) => {
                const v = value as any;
                if (!v || !Array.isArray(v.faces) || v.faces.length === 0) {
                  return [{ type: 'text', text: '未找到符合条件的表情包。' }];
                }
                const lines = [`共找到 ${v.total} 个可用表情 (本次返回 ${v.faces.length} 个):`];
                for (const f of v.faces) {
                  const moodStr = f.mood ? ` [情绪: ${f.mood}]` : '';
                  const tagStr = f.tags && f.tags.length > 0 ? ` 标签: [${f.tags.join(', ')}]` : ' [无标签]';
                  const pathStr = f.file_path ? ` | 路径: ${f.file_path}` : '';
                  lines.push(`• ID: ${f.id} (${f.format})${moodStr}${tagStr}${pathStr}`);
                }
                if (v.has_more && v.next_cursor) {
                  lines.push(`(还有更多表情，可传入 cursor: "${v.next_cursor}" 获取下一页)`);
                }
                return [{ type: 'text', text: lines.join('\n') }];
              },
            },
            async execute(args, _exec) {
              return (await listFaces(args, { db: options.db })) as any;
            },
          })
        )
      );

      // 9.2 send_face
      unregisters.push(
        tools.register(
          defineTool({
            name: 'send_face',
            description:
              '根据表情 ID 发送一张表情包到当前群聊或私聊中（独立表情气泡）。请在语境合适且有明确意图时调用，禁止连续刷屏发表情。',
            parameters: {
              face_id: {
                type: 'string',
                required: true,
                description: '要发送的目标表情 ID (必填，通过 list_faces 获取)',
              },
            },
            output: {
              schema: { type: 'json' },
              render: (_args, value) => {
                const v = value as any;
                return [
                  {
                    type: 'text',
                    text: v?.success ? `已成功发送表情包 (message_id: ${v.message_id})` : `发送表情包失败: ${v?.error}`,
                  },
                ];
              },
            },
            async execute(args, exec) {
              const session = (exec.agent as any)?.session;
              const rawPeer = session?.id || '';
              const peer = normalizePeer(rawPeer);
              const groupId =
                peer.startsWith('qq-group-') || peer.startsWith('group_')
                  ? peer.replace(/^(qq-group-|group_)/, '').split('-')[0]
                  : undefined;
              const cfg = getConfig();
              const res = (await sendFace(args, {
                db: options.db,
                gateway: options.gateway,
                sender: options.sender,
                peer,
                groupId,
                faceSubType: cfg.face_sub_type,
              })) as any;
              if (res && res.success === false) {
                throw new Error(res.error || 'send_face 失败');
              }
              return res;
            },
          })
        )
      );

      // 9.3 collect_face
      unregisters.push(
        tools.register(
          defineTool({
            name: 'collect_face',
            description:
              '【收藏/编辑表情】将聊天消息中的图片转存至本地表情库，或为已有表情包补全/编辑标签与情绪。传入 face_id 时为补标编辑模式；不传 face_id 时从指定消息（或当前入站消息）中偷图收藏。注意：调用本工具时必须明确给出你对画面的理解标签 (tags) 和情绪意图 (mood)。',
            parameters: {
              face_id: {
                type: 'string',
                description: '已有表情 ID。若提供此参数，则为补标编辑模式；若省略则为收藏新表情模式',
              },
              tags: {
                type: 'array',
                required: true,
                items: { type: 'string' },
                description: '画面内容与文字标签（如 ["猫猫", "叹气", "生活不易"]，必填）',
              },
              mood: {
                type: 'string',
                required: true,
                description: '情绪与语境意图（如 "嘲讽", "卖萌", "感谢", "无奈", "破防"，必填）',
              },
              message_id: {
                type: 'number',
                description: '收藏新表情时的目标消息 ID。若省略则自动绑定当前回合正在回复的入站消息',
              },
            },
            output: {
              schema: { type: 'json' },
              render: (_args, value) => {
                const v = value as any;
                return [
                  {
                    type: 'text',
                    text: v?.success
                      ? v.duplicated
                        ? `[表情已存在] ${v.message}`
                        : `[成功] ${v.message} (face_id: ${v.face_id})`
                      : `操作表情失败: ${v?.error}`,
                  },
                ];
              },
            },
            async execute(args, exec) {
              const session = (exec.agent as any)?.session;
              const rawPeer = session?.id || '';
              const peer = normalizePeer(rawPeer);
              const cfg = getConfig();
              const res = (await collectFace(args, {
                db: options.db,
                peer,
                inboundMsgIdGetter: options.inboundMsgIdGetter,
                faceDir: cfg.face_store_dir,
                faceStoreMax: cfg.face_store_max,
                faceEvictPolicy: cfg.face_evict_policy,
              })) as any;
              if (res && res.success === false) {
                throw new Error(res.error || 'collect_face 失败');
              }
              return res;
            },
          })
        )
      );
    }
  };

  const initialTools =
    (ctx as any).tools || (typeof (ctx as any).get === 'function' ? (ctx as any).get('tools') : undefined);
  if (initialTools) {
    doRegister(initialTools);
  }

  const checkReadyTools = () => {
    if (unregisters.length === 0) {
      const readyTools =
        (ctx as any).tools || (typeof (ctx as any).get === 'function' ? (ctx as any).get('tools') : undefined);
      if (readyTools) doRegister(readyTools);
    }
  };
  const appReady = typeof (ctx as any).get === 'function' ? (ctx as any).get('appReady') : undefined;
  if (appReady && typeof appReady.onReady === 'function') {
    appReady.onReady(checkReadyTools);
  }
  (ctx as any).on?.('ready', checkReadyTools);

  return () => {
    for (const unreg of unregisters) {
      try {
        unreg();
      } catch {}
    }
  };
}
