/**
 * dsh-napcat-bridge: SQLite 消息存储模块 (Facade 门面)
 * 管理数据库生命周期并将具体的领域操作委托给专职 Repository
 */

import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DEFAULT_FACE_STORE_MAX } from '../constants/index.js';
import type {
  SlangEntry,
  ListGroupFilesParams,
  ListGroupFilesResult,
  MessageRecord,
  ReadChatHistoryParams,
  ReadChatHistoryResult,
  FaceRecord,
  FaceQueryOptions,
  FaceMoodSummary,
  ScheduledTaskRecord,
  ScheduledTaskStatus,
} from '../types/index.js';

import { initDatabaseSchema } from './schema.js';
import {
  KvRepository,
  SessionRepository,
  type SessionStateRecord,
  TaskRepository,
  SlangRepository,
  FaceRepository,
  MessageRepository,
} from './repositories/index.js';

export { formatDateTime, parseTimeValue } from './time-parser.js';
export type { SessionStateRecord } from './repositories/session.repo.js';

type DatabaseType = any;

export class MessageDatabase {
  public readonly dbPath: string;
  private db: DatabaseType | null = null;

  public readonly kvRepo: KvRepository;
  public readonly sessionRepo: SessionRepository;
  public readonly taskRepo: TaskRepository;
  public readonly slangRepo: SlangRepository;
  public readonly faceRepo: FaceRepository;
  public readonly messageRepo: MessageRepository;

  constructor(dbPath: string) {
    this.dbPath = path.resolve(dbPath);
    const getDb = () => this.ensureDb();
    this.kvRepo = new KvRepository(getDb);
    this.sessionRepo = new SessionRepository(getDb);
    this.taskRepo = new TaskRepository(getDb);
    this.slangRepo = new SlangRepository(getDb);
    this.faceRepo = new FaceRepository(getDb);
    this.messageRepo = new MessageRepository(getDb, (id, opts) => this.faceRepo.getFaceById(id, opts));
  }

  init(): void {
    const dir = path.dirname(this.dbPath);
    if (dir && dir !== '.' && !fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');

    initDatabaseSchema(this.db, this.kvRepo);
  }

  private ensureDb(): DatabaseType {
    if (!this.db) {
      this.init();
    }
    return this.db!;
  }

  // ==================== 消息持久化与多维查询 ====================

  saveMessage(record: MessageRecord): void {
    this.messageRepo.saveMessage(record);
  }

  hasMessage(msgId: number): boolean {
    return this.messageRepo.hasMessage(msgId);
  }

  getLatestMessageTime(peer: string): number | null {
    return this.messageRepo.getLatestMessageTime(peer);
  }

  saveMessageIfNotExists(record: MessageRecord): boolean {
    return this.messageRepo.saveMessageIfNotExists(record);
  }

  readHistory(peer: string, params: ReadChatHistoryParams = {}): ReadChatHistoryResult {
    return this.messageRepo.readHistory(peer, params);
  }

  listGroupFiles(peer: string, params: ListGroupFilesParams = {}): ListGroupFilesResult {
    return this.messageRepo.listGroupFiles(peer, params);
  }

  findGroupFileSibling(
    peer: string,
    fileName: string,
    time: number,
    size?: number
  ): MessageRecord | null {
    return this.messageRepo.findGroupFileSibling(peer, fileName, time, size);
  }

  getActiveUsers(peer: string, days = 7, limit = 20): Array<{ user_id: string; sender_name: string; last_active: number }> {
    return this.messageRepo.getActiveUsers(peer, days, limit);
  }

  hasNewImageMessages(peer: string, sinceMsgId: number = 0): { hasNew: boolean; latestMsgId: number } {
    return this.messageRepo.hasNewImageMessages(peer, sinceMsgId);
  }

  getLatestMsgId(peer: string): number {
    return this.messageRepo.getLatestMsgId(peer);
  }

  markRecalled(msgId: number): void {
    this.messageRepo.markRecalled(msgId);
  }

  getMessage(msgId: number): MessageRecord | null {
    return this.messageRepo.getMessage(msgId);
  }

  getByFileId(fileId: string): MessageRecord | null {
    return this.messageRepo.getByFileId(fileId);
  }

  getByFingerprint(fingerprint: string): MessageRecord | null {
    return this.messageRepo.getByFingerprint(fingerprint);
  }

  updateLocalPath(msgId: number, localPath: string, fingerprint?: string | null): void {
    this.messageRepo.updateLocalPath(msgId, localPath, fingerprint);
  }

  updateMessageMedia(
    msgId: number,
    patch: {
      file_id?: string | null;
      busid?: number | null;
      local_path?: string | null;
      raw?: string;
      attachments?: string | null;
    }
  ): void {
    this.messageRepo.updateMessageMedia(msgId, patch);
  }

  updateLocalPathByFileId(fileId: string, localPath: string, fingerprint?: string | null): void {
    this.messageRepo.updateLocalPathByFileId(fileId, localPath, fingerprint);
  }

  clearLocalPath(localPath: string): void {
    this.messageRepo.clearLocalPath(localPath);
  }

  // ==================== 会话状态管理 ====================

  saveSessionState(state: SessionStateRecord): void {
    this.sessionRepo.saveSessionState(state);
  }

  getSessionState(peer: string): SessionStateRecord | null {
    return this.sessionRepo.getSessionState(peer);
  }

  getAllSessionStates(): SessionStateRecord[] {
    return this.sessionRepo.getAllSessionStates();
  }

  // ==================== 插件键值配置 ====================

  getPluginConfig(key: string): string | null {
    return this.kvRepo.getPluginConfig(key);
  }

  setPluginConfig(key: string, value: string): void {
    this.kvRepo.setPluginConfig(key, value);
  }

  // ==================== 表情包资产库管理 ====================

  insertFace(
    record: {
      id: string;
      file_path: string;
      md5: string;
      source: 'curate' | 'manual' | 'collect';
      tags: string[];
      mood?: string;
      enabled?: boolean;
      size: number;
      format: string;
    },
    options?: { max?: number; evictPolicy?: 'reject' | 'evict_lru' }
  ): FaceRecord & { duplicated?: boolean; restored?: boolean } {
    return this.faceRepo.insertFace(record, options);
  }

  getFaceById(id: string, options?: { includeDeleted?: boolean }): FaceRecord | null {
    return this.faceRepo.getFaceById(id, options);
  }

  getFaceByMd5(md5: string, options?: { includeDeleted?: boolean }): FaceRecord | null {
    return this.faceRepo.getFaceByMd5(md5, options);
  }

  getFaceMoodSummary(limitMoods: number = 8): FaceMoodSummary {
    return this.faceRepo.getFaceMoodSummary(limitMoods);
  }

  getActiveFacesForContext(limit: number = DEFAULT_FACE_STORE_MAX): { faces: FaceRecord[]; total: number } {
    return this.faceRepo.getActiveFacesForContext(limit);
  }

  queryFaces(options: FaceQueryOptions = {}): { faces: FaceRecord[]; total: number; has_more: boolean } {
    return this.faceRepo.queryFaces(options);
  }

  updateFace(id: string, updates: { tags?: string[]; mood?: string }): FaceRecord | null {
    return this.faceRepo.updateFace(id, updates);
  }

  updateFaceFilePath(id: string, filePath: string): void {
    this.faceRepo.updateFaceFilePath(id, filePath);
  }

  deleteFace(id: string): boolean {
    return this.faceRepo.deleteFace(id);
  }

  restoreFace(id: string): boolean {
    return this.faceRepo.restoreFace(id);
  }

  purgeExpiredFaces(graceDays: number = 7): string[] {
    return this.faceRepo.purgeExpiredFaces(graceDays);
  }

  recordFaceUsage(id: string): void {
    this.faceRepo.recordFaceUsage(id);
  }

  // ==================== 定时任务管理 ====================

  createScheduledTask(task: ScheduledTaskRecord): void {
    this.taskRepo.createScheduledTask(task);
  }

  getScheduledTask(id: string): ScheduledTaskRecord | null {
    return this.taskRepo.getScheduledTask(id);
  }

  listScheduledTasks(peer: string, status?: ScheduledTaskStatus): ScheduledTaskRecord[] {
    return this.taskRepo.listScheduledTasks(peer, status);
  }

  updateScheduledTask(
    id: string,
    updates: Partial<Pick<ScheduledTaskRecord, 'prompt' | 'next_run_at' | 'recurring_rule' | 'type'>>
  ): boolean {
    return this.taskRepo.updateScheduledTask(id, updates);
  }

  cancelScheduledTask(id: string): boolean {
    return this.taskRepo.cancelScheduledTask(id);
  }

  completeScheduledTask(id: string, nextRunAt?: number): boolean {
    return this.taskRepo.completeScheduledTask(id, nextRunAt);
  }

  getPendingScheduledTasks(thresholdTime: number = Date.now()): ScheduledTaskRecord[] {
    return this.taskRepo.getPendingScheduledTasks(thresholdTime);
  }

  // ==================== 社群黑话词典 ====================

  getSlangEntry(term: string, incrementQueryCount = false): SlangEntry | null {
    return this.slangRepo.getSlangEntry(term, incrementQueryCount);
  }

  insertSlangEntry(entry: {
    term: string;
    tags?: string;
    definition: string;
    example?: string;
  }): SlangEntry {
    return this.slangRepo.insertSlangEntry(entry);
  }

  updateSlangEntry(
    term: string,
    updates: {
      new_term?: string;
      tags?: string;
      definition?: string;
      example?: string;
    }
  ): SlangEntry | null {
    return this.slangRepo.updateSlangEntry(term, updates);
  }

  deleteSlangEntry(term: string): boolean {
    return this.slangRepo.deleteSlangEntry(term);
  }

  querySlangEntries(options: { keyword?: string; offset?: number; limit?: number } = {}): {
    entries: SlangEntry[];
    total: number;
  } {
    return this.slangRepo.querySlangEntries(options);
  }

  getAllSlangEntriesForContext(): Array<{ term: string; tags: string }> {
    return this.slangRepo.getAllSlangEntriesForContext();
  }

  getSlangCount(): number {
    return this.slangRepo.getSlangCount();
  }

  evictSlangEntryLru(): SlangEntry | null {
    return this.slangRepo.evictSlangEntryLru();
  }

  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}
