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
  ManageFacesParams,
  ManageFacesResult,
  SendQqMessageParams,
  SendQqMessageResult,
  BridgePluginConfig,
  MessageRecord,
} from '../types/index.js';
export type { ManageFacesParams, ManageFacesResult, SendQqMessageParams, SendQqMessageResult };
import { EMOJI_MAP } from '../types/index.js';
export { EMOJI_MAP };
import { stripMarkdown } from '../outbound/render.js';
import { manageFaces } from './manage-faces.js';
export { manageFaces };
import type { MessageDatabase } from '../storage/database.js';
import { formatDateTime } from '../storage/database.js';
import type { MediaStorageManager } from '../storage/media.js';
import type { NapCatGatewayServer } from '../gateway/server.js';
import type { MessageWaitRegistry, WaitCollectedMessage } from '../gateway/server.js';
import type { SerialSender } from '../types/index.js';
import { classifySendFileSource, detectSendFileType } from './file-source.js';
import { downloadPrivateFile } from './private-file.js';
import { resolveDshPath } from '../utils/path.js';
import { DEFAULT_FACE_STORE_DIR } from '../constants/index.js';

export interface ToolExecutionContext {
  db?: MessageDatabase | null;
  gateway?: NapCatGatewayServer | null;
  mediaManager?: MediaStorageManager | null;
  /** 共享 per-peer 串行发送器 (Spec §7.3)：主动发文件与正文/提问/审批同队列 */
  sender?: SerialSender | null;
  peer?: string;
  groupId?: string | number;
  dshHome?: string;
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

export function getGlobalToolContext(): ToolExecutionContext {
  return globalToolContext;
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
    // 移除 file_type 参数，直接按扩展名自动推导
    const fileKind = detectSendFileType(undefined, src.value);

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
    return { success: false, error: '你需要指定 user_id（目标用户的 QQ 号）' };
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

  // 2. 会话 peer 校验（非 QQ 会话不支持等待）
  const peer = normalizePeer(ctx.peer || '');
  if (!peer.startsWith('group_') && !peer.startsWith('user_')) {
    return { success: false, error: '当前会话不是 QQ 会话，无法等待用户消息' };
  }

  // 3. user_id 语法级校验（依赖层）：格式非法 → 原文报错；私聊对象不符 → 原文报错
  let userId: string | undefined;
  if (params?.user_id !== undefined && params?.user_id !== null) {
    const uid = String(params.user_id).trim();
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
 * 清洗对象以确保严格符合 DSH Lossless JSON 约束 (递归剥离所有 undefined 字段)
 * 彻底避免 DSH snapshotJsonValue 抛出 "value is not lossless JSON" 错误
 */
export function toLosslessJson<T>(val: T): T {
  if (val === undefined || val === null) return val;
  return JSON.parse(JSON.stringify(val));
}

/**
 * 6.9 检索表情包工具 (list_faces)
 * 按情绪 (mood) 或内容标签 (tag) 检索本地可用表情包。
 * 强制分页，仅返回语义元数据 (id, tags, mood, format)，坚决不出 URL。
 */
export async function listFaces(
  params: ListFacesParams,
  context?: ToolExecutionContext
): Promise<ListFacesResult> {
  const ctx = { ...globalToolContext, ...context };
  if (!ctx.db) {
    return { faces: [], total: 0 };
  }
  const limit = Math.min(Math.max(params?.limit ?? 100, 1), 100);
  const queryRes = ctx.db.queryFaces({
    mood: params?.mood,
    tag: params?.tag,
    untagged: params?.untagged,
    limit,
    offset: 0,
    enabledOnly: true,
  });

  const faces: FaceSummaryItem[] = queryRes.faces.map((f) => {
    const item: FaceSummaryItem = {
      id: f.id,
      tags: f.tags || [],
      format: f.format,
    };
    if (f.mood !== undefined && f.mood !== null && String(f.mood).trim() !== '') {
      item.mood = f.mood;
    }
    if (f.file_path) {
      item.file_path = path.isAbsolute(f.file_path)
        ? f.file_path
        : resolveDshPath(ctx.dshHome, f.file_path, DEFAULT_FACE_STORE_DIR);
    }
    return item;
  });

  const res: ListFacesResult = {
    faces,
    total: queryRes.total,
  };

  return toLosslessJson(res);
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

  const rawPath = face.file_path;
  let localPath = path.isAbsolute(rawPath)
    ? rawPath
    : resolveDshPath(ctx.dshHome, rawPath, DEFAULT_FACE_STORE_DIR);

  // 物理文件存在性校验与自动自愈回退
  if (!fs.existsSync(localPath)) {
    const canonicalDir = resolveDshPath(ctx.dshHome, ctx.faceDir, DEFAULT_FACE_STORE_DIR);
    const canonicalPath = path.resolve(canonicalDir, `${face.md5}.${face.format}`);
    if (fs.existsSync(canonicalPath)) {
      localPath = canonicalPath;
      ctx.db.updateFaceFilePath(face.id, canonicalPath);
    } else {
      // 检查是否落入工作区或 profiles 目录
      const dshHome = ctx.dshHome || process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '', '.dsh');
      const candidates = [
        path.resolve(process.cwd(), rawPath),
        path.join(dshHome, 'profiles', 'desktop', '.dsh', 'napcat', 'faces', `${face.md5}.${face.format}`),
        path.join(dshHome, 'profiles', 'desktop', rawPath),
      ];
      for (const cand of candidates) {
        if (cand && fs.existsSync(cand)) {
          try {
            fs.mkdirSync(canonicalDir, { recursive: true });
            fs.copyFileSync(cand, canonicalPath);
            localPath = canonicalPath;
            ctx.db.updateFaceFilePath(face.id, canonicalPath);
            break;
          } catch {}
        }
      }
    }
  }

  if (!fs.existsSync(localPath)) {
    return { success: false, error: `表情包本地文件不存在: ${localPath}` };
  }

  const sessionPeer = ctx.peer || '';
  const inGroup =
    (ctx.groupId !== undefined && ctx.groupId !== null && String(ctx.groupId).trim() !== '') ||
    sessionPeer.startsWith('group_') ||
    sessionPeer.startsWith('qq-group-');

  const normalizedPath = localPath.replace(/\\/g, '/');
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
      const sendRes: SendFaceResult = {
        success: true,
      };
      if (typeof messageId === 'number') {
        sendRes.message_id = messageId;
      }
      return toLosslessJson(sendRes);
    } catch (err: any) {
      return toLosslessJson({
        success: false,
        error: `发送表情异常: ${err?.message || '未知错误'}`,
      });
    }
  };

  if (ctx.sender) {
    return ctx.sender.enqueue(sessionPeer || 'common', doSend);
  }
  return doSend();
}

/**
 * 6.11 偷表情/收藏工具 (collect_face)
 * 从指定消息（或当前正在回复的入站消息）中提取图片并收录进本地表情库。
 * 修改已有表情标签或删除表情请使用 manage_faces。
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

  // 偷图/收藏新表情
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

    const rawStoreDir = context?.faceDir || ctx.faceDir || '.dsh/napcat/faces';
    const storeDir = resolveDshPath(context?.dshHome || ctx.dshHome, rawStoreDir, DEFAULT_FACE_STORE_DIR);
    fs.mkdirSync(storeDir, { recursive: true });
    const targetFile = path.resolve(storeDir, `${md5}.${ext}`);

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
      return toLosslessJson({
        success: true,
        duplicated: true,
        face_id: res.id,
        message: `该表情包已在你的表情库中存在（已有标签: [${res.tags.join(', ')}]，情绪: ${res.mood || '未设置'}）`,
      });
    }

    return toLosslessJson({
      success: true,
      face_id: res.id,
      message: `已成功收藏表情包，标签: [${safeTags.join(', ')}]，情绪: ${safeMood}`,
    });
  } catch (err: any) {
    return toLosslessJson({ success: false, error: `表情入库失败: ${err?.message || '未知错误'}` });
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
 * 6.9 发送 QQ 消息工具 (send_qq_message)
 * 向当前 QQ 会话发送普通文本消息。
 * 支持显式引用消息 (reply_to) 与艾特用户 (at_user)，超长自动分段，透明重试。
 * 执行成功后绝不调用 concludeTurn()，回合保持开放供后续顺手维护。
 */
export async function sendQqMessage(
  params: SendQqMessageParams,
  context?: ToolExecutionContext
): Promise<SendQqMessageResult> {
  const ctx = { ...globalToolContext, ...context };

  // 1. 参数非空校验（空文本/纯空白/stripMarkdown 后为空）
  if (!params || typeof params.text !== 'string') {
    return { success: false, error: '发送内容不能为空。' };
  }
  const plainText = stripMarkdown(params.text).trim();
  if (!plainText) {
    return { success: false, error: '发送内容不能为空。' };
  }

  // 2. QQ 聊天会话上下文校验
  const rawPeer = ctx.peer || '';
  const peer = normalizePeer(rawPeer);
  const isGroup = peer.startsWith('group_') || peer.startsWith('qq-group-');
  const isUser = peer.startsWith('user_') || peer.startsWith('qq-user-');

  if (!isGroup && !isUser) {
    return { success: false, error: 'send_qq_message 需在 QQ 聊天会话中执行' };
  }

  if (!ctx.gateway) {
    return { success: false, error: 'NapCat Gateway 未连接' };
  }

  // 3. 超长文本自动分段（默认 1500 字符）
  const chunks = splitMessageText(plainText, 1500);
  let lastMessageId: number | undefined;

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    let payload: string | Array<Record<string, any>> = chunk;

    // 显式引用与艾特（仅首段携带，不重复注入后续分段）
    if (i === 0) {
      const segments: Array<Record<string, any>> = [];
      let replyId: number | undefined;
      if (params.reply_to !== undefined && params.reply_to !== null) {
        const num = typeof params.reply_to === 'number' ? params.reply_to : Number(String(params.reply_to).trim());
        if (Number.isSafeInteger(num) && num > 0) {
          replyId = num;
        }
      }
      const atQQ =
        isGroup && typeof params.at_user === 'string' && params.at_user.trim().length > 0
          ? params.at_user.trim()
          : undefined;

      if (replyId !== undefined) {
        segments.push({ type: 'reply', data: { id: replyId } });
      }
      if (atQQ !== undefined) {
        segments.push({ type: 'at', data: { qq: atQQ } });
      }

      if (segments.length > 0) {
        segments.push({ type: 'text', data: { text: chunk } });
        payload = segments;
      }
    }

    const sendTask = () => ctx.gateway!.sendMsg(peer, payload);
    let chunkSuccess = false;
    let lastError = '';

    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        const res = ctx.sender
          ? await ctx.sender.enqueue(peer, sendTask)
          : await sendTask();

        if (res && (res.status === 'ok' || res.retcode === 0)) {
          chunkSuccess = true;
          if (res.data?.message_id) {
            lastMessageId = res.data.message_id;
          }
          break;
        } else {
          lastError = res?.message || res?.wording || '网关返回错误';
        }
      } catch (err: any) {
        lastError = err?.message || String(err);
      }
      if (attempt < 5) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }

    if (!chunkSuccess) {
      return {
        success: false,
        error: `消息分段 ${i + 1}/${chunks.length} 发送失败: ${lastError}`,
      };
    }
  }

  return {
    success: true,
    message_id: lastMessageId,
    sent_preview: plainText.length > 60 ? `${plainText.slice(0, 60)}...` : plainText,
  };
}

export interface AgentToolsOptions {
  db: MessageDatabase;
  gateway?: NapCatGatewayServer;
  mediaManager: MediaStorageManager;
  sender?: SerialSender;
  dshHome?: string;
  waitRegistry?: MessageWaitRegistry;
  inboundMsgIdGetter?: (peer: string) => number | undefined;
  config?: (() => BridgePluginConfig) | BridgePluginConfig;
}

/**
 * 注册 Agent 工具集至 DSH 工具运行时 (ctx.tools)
 */
export function registerAgentTools(
  ctx: Context,
  options: AgentToolsOptions
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
    dshHome: options.dshHome,
    waitRegistry: options.waitRegistry,
    inboundMsgIdGetter: options.inboundMsgIdGetter,
    faceDir: resolveDshPath(options.dshHome, currentCfg.face_store_dir, DEFAULT_FACE_STORE_DIR),
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
            '检索当前会话的本地历史聊天记录。在群聊中查询两条消息之间有什么其他的消息，需要查询指定的时间段，建议在两条消息之间间隔超过 5 分钟时调用，根据聊天节奏决定是否每次查询；亦用于指代不明追溯前情、响应用户查询/复述历史发言，或为贴表情/收藏表情等下游工具捞取目标消息的 message_id。查找群文件请使用专用的 list_group_files。',
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
          description:
            '根据资源 file_id（群文件需附带 busid）将外部文件或富媒体拉取到本地磁盘。用于需要深入阅读、分析聊天中的文档、音视频或图片内容时；下载完成后返回本地物理路径（local_path），供后续文件或图片读取工具消费。',
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
            '展开聊天记录合并转发（多条消息聚合卡片）的内部真实对话。用于会话中用户分享合并转发记录并要求查看、总结或评价其中内容时；返回层级消息列表，内层图片会自动缓存并附带本地路径。',
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
          description:
            '向当前聊天发送本地磁盘上的文件、生成的图片或导出报告。用于向用户交付具体的文件或图片实体产物；系统会自动根据文件扩展名选择以图片或文件卡片形式下发。切勿用于发送普通文本聊天消息。',
          parameters: {
            file_path: { type: 'string', required: true, description: '本地绝对路径、file:// URI 或 URL (必填)' },
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
          description: '在群内戳指定用户，或在私聊窗口向对方发送抖动。用于趣味调侃、打招呼，或对方主动要求“戳我一下”时。',
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
            '获取当前群聊已上传的文件列表与索引清单。用于用户查找群共享文件、查询资料是否已存在时；返回结果包含文件名、上传者、file_id 和 busid。如需读取文件内容，需将返回的 file_id 与 busid 传给 fetch_chat_resource 下载。切勿用于检索聊天文字。',
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
            const res = await listGroupFiles(args, {
              db: options.db,
              peer,
            });
            return toLosslessJson(res) as any;
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
            '临时挂起会话并等待用户继续发送消息，在指定窗口时间内收集到达的新消息后统一恢复执行。用于用户话只说了半句、提示“等等还有”、连续多段发言或正在补充报错截图时；窗口内收集到消息后一次性返回供综合答复。',
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
          description:
            '为当前或指定入站消息贴一个小表情回应。用于对调侃、搞笑图、日常问候做快速情绪化表态，或确认收到指令；无需冗长文字即可生动闭环。',
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
            const rawPeer = session?.id || (exec.agent as any)?.sessionId || '';
            const peer = normalizePeer(rawPeer);
            const isQQGroup = Boolean(
              rawPeer.startsWith('qq-group-') ||
              peer.startsWith('group_') ||
              rawPeer.startsWith('group_')
            );
            if (!isQQGroup) {
              throw new Error('dsh-napcat-bridge: react_message 工具仅限群聊调用，当前会话不可执行');
            }
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

    // 9. send_qq_message
    unregisters.push(
      tools.register(
        defineTool({
          name: 'send_qq_message',
          description:
            '向当前 QQ 会话发送文本消息。注意：你的直接文本回复不会自动显示给 QQ 用户，若要向用户发言、回答问题、同步进展或输出结论，必须调用本工具传入 text 参数，否则用户看不到任何内容。若要发送的内容较长，或包含多个不同要点、转折与独立意思，可以拆分成多条简短消息，多次调用本工具分开发送。如需引用消息，请显式传入其数字 reply_to；如需艾特特定用户，请显式传入 at_user。发送图片或文件请使用 send_file，发送表情包请使用 send_face，向用户提问或抉择可使用 ask_user_question。',
          parameters: {
            text: {
              type: 'string',
              required: true,
              description: '要发送给用户的纯文本内容。',
            },
            reply_to: {
              type: 'number',
              description: '需要引用的目标消息数字 ID（来自当前入站消息头部 [消息ID: <id>] 或 read_chat_history）。',
            },
            at_user: {
              type: 'string',
              description: '需要艾特的目标用户 QQ 号（仅群聊有效）。',
            },
          },
          output: {
            schema: { type: 'json' },
            render: (_args, value) => {
              const v = value as any;
              if (v?.success) {
                return [
                  {
                    type: 'text',
                    text: `消息已发出${v.message_id ? ` (ID: ${v.message_id})` : ''}`,
                  },
                ];
              }
              return [
                {
                  type: 'text',
                  text: `消息发送失败: ${v?.error}`,
                },
              ];
            },
          },
          async execute(args, exec) {
            const session = (exec.agent as any)?.session;
            const rawPeer = session?.id || (exec.agent as any)?.sessionId || (exec.agent as any)?.id || '';
            const peer = normalizePeer(rawPeer);
            return (await sendQqMessage(args, {
              gateway: options.gateway,
              sender: options.sender,
              peer,
            })) as any;
          },
        })
      )
    );

    // 10. 表情包能力 (由 face_enabled 总开关前置门控)
    if (getConfig().face_enabled) {
      // 9.1 list_faces
      unregisters.push(
        tools.register(
          defineTool({
            name: 'list_faces',
            description:
              '在机器人本地表情库中检索可用的表情包。用于斗图或需要情绪表达前，按情绪（mood）或标签（tag）查验可用库存；返回合法 face_id、标签、情绪及本地路径。检索到心仪表情后，使用其 face_id 配合 send_face 发送。',
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
                return [{ type: 'text', text: lines.join('\n') }];
              },
            },
            async execute(args, _exec) {
              const res = await listFaces(args, { db: options.db, dshHome: options.dshHome });
              return toLosslessJson(res) as any;
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
              '根据表情 ID 将一张本地表情包作为独立表情消息发送到聊天中。用于聊天中需要精准表达情绪、接梗斗图时；表情 ID 需来自 list_faces 检索结果。业务图片产物请使用 send_file。',
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
              const res = await sendFace(args, {
                db: options.db,
                gateway: options.gateway,
                sender: options.sender,
                peer,
                groupId,
                dshHome: options.dshHome,
                faceDir: resolveDshPath(options.dshHome, cfg.face_store_dir, DEFAULT_FACE_STORE_DIR),
                faceSubType: cfg.face_sub_type,
              });
              return toLosslessJson(res) as any;
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
              '将聊天中的图片收录入本地表情库，并打上初始标签与情绪。用于用户要求“把这图存成表情”、聊天中出现值得收藏的好梗图时。修改已有表情标签或删除表情请使用 manage_faces。',
            parameters: {
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
              const res = await collectFace(args, {
                db: options.db,
                peer,
                inboundMsgIdGetter: options.inboundMsgIdGetter,
                dshHome: options.dshHome,
                faceDir: resolveDshPath(options.dshHome, cfg.face_store_dir, DEFAULT_FACE_STORE_DIR),
                faceStoreMax: cfg.face_store_max,
                faceEvictPolicy: cfg.face_evict_policy,
              });
              return toLosslessJson(res) as any;
            },
          })
        )
      );

      // 9.4 manage_faces
      unregisters.push(
        tools.register(
          defineTool({
            name: 'manage_faces',
            description:
              '管理与维护本地表情包库。用于补充或修改已有表情的标签/情绪、按 ID 删除表情、查询当前表情库存储配额占用，以及在库容满时按 LRU 或指定规则清理淘汰冷门表情。',
            parameters: {
              action: {
                type: 'string',
                required: true,
                enum: ['update', 'delete', 'query_quota', 'evict'],
                description: '操作类型: update (改标签/情绪), delete (删除表情), query_quota (查存储配额), evict (按 LRU 淘汰冷门表情)',
              },
              face_id: {
                type: 'string',
                description: '目标表情 ID（action 为 update 或 delete 时必填）',
              },
              tags: {
                type: 'array',
                items: { type: 'string' },
                description: '更新表情时的内容画面标签列表（action 为 update 时使用）',
              },
              mood: {
                type: 'string',
                description: '更新表情时的情绪意图（action 为 update 时使用）',
              },
              count: {
                type: 'number',
                description: '淘汰表情数量（action 为 evict 时使用，默认 10）',
              },
            },
            output: {
              schema: { type: 'json' },
              render: (_args, value) => {
                const v = value as any;
                if (!v) return [{ type: 'text', text: '表情管理操作完成。' }];
                if (v.success) {
                  return [{ type: 'text', text: v.message || '操作成功' }];
                }
                return [{ type: 'text', text: `表情管理操作失败: ${v.error}` }];
              },
            },
            async execute(args, _exec) {
              const cfg = getConfig();
              const res = await manageFaces(args, {
                db: options.db,
                dshHome: options.dshHome,
                faceStoreMax: cfg.face_store_max,
                faceEvictPolicy: cfg.face_evict_policy,
              });
              return toLosslessJson(res) as any;
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
