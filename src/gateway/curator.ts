/**
 * dsh-napcat-bridge: 后台表情包整理 Agent (Face Curator)
 * 定期/异步审视群聊与私聊会话中的图片，自动识别表情包并完成语义打标与入库。
 *
 * 核心设计准则：
 * 1. 双重门控: face_enabled && face_auto_curate，关闭时彻底静默；
 * 2. 对齐 Hermes 自动回顾架构：
 *    - 原生 Fork 父会话上下文，天然掌握群聊语境与图片
 *    - 严格工具白名单沙箱 (collect_face, list_faces, read_chat_history, read_image)
 *    - 临时会话用完即焚：内核锁先行释放 -> 内存解绑 -> 物理销毁
 * 3. 纯粹资产归档: 坚决不建 skill、不写记忆；
 * 4. 兜底与去重: 底层 MD5 自动去重，模型无需自行查重。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type { Context } from '@deepseek-ai/cordis';
import type { MessageDatabase } from '../storage/database.js';
import type { BridgePluginConfig } from '../types/index.js';
import { DEFAULT_FACE_CURATE_INTERVAL_MINS } from '../constants/index.js';

export const ALLOWED_FACE_CURATOR_TOOLS: readonly string[] = [
  'collect_face',
  'list_faces',
  'read_chat_history',
  'read_image',
];

export const FACE_CURATOR_PROMPT_TEMPLATE = `# Face & Meme Curator Agent

Review the conversation above and inspect the recent images sent in this chat.
Identify suitable memes, stickers, or funny reaction images, and collect or tag them into the local face library.

## Guidelines:
- Inspect recent images in the conversation.
- If an image is a meme, emoji pack, or reaction image, call \`collect_face\` to add it.
- You MUST provide descriptive \`tags\` (e.g. ['猫猫', '叹气']) and \`mood\` (e.g. '嘲讽', '卖萌', '无奈').
- Do NOT worry about duplication; the storage layer will automatically handle deduplication by MD5.
- If you find untagged faces, inspect them and call \`collect_face(face_id=..., tags=..., mood=...)\` to complete their tags.
- If there are NO suitable reaction images in the conversation, just say "Nothing to save." and finish immediately.
`;

export interface FaceCuratorOptions {
  ctx?: Context;
  db: MessageDatabase;
  faceStoreDir?: string;
  imageScanDirs?: string[];
  llmService?: any;
  memoryStorage?: any;
  sessionManager?: any;
  config?: () => BridgePluginConfig;
  initialCuratedAt?: number;
}

export interface CurateReport {
  scanned: number;
  adopted: number;
  skipped: number;
}

export interface CurateRunResult {
  executed: boolean;
  peer: string;
  adoptedCount?: number;
  message?: string;
  error?: string;
}

export class FaceCurator {
  private isRunning = false;
  private readonly ctx?: Context;
  private startTime: number;
  private lastCuratedAt = new Map<string, number>();
  private lastCuratedMsgId = new Map<string, number>();

  constructor(private readonly options: FaceCuratorOptions) {
    this.ctx = options.ctx;
    this.startTime = options.initialCuratedAt ?? Date.now();
  }

  getStartTime(): number {
    return this.startTime;
  }

  setStartTime(timestamp: number): void {
    this.startTime = timestamp;
  }

  getLastCuratedAt(peer: string): number {
    return this.lastCuratedAt.get(peer) ?? this.startTime;
  }

  setLastCuratedAt(peer: string, timestamp: number): void {
    this.lastCuratedAt.set(peer, timestamp);
  }

  getLastCuratedMsgId(peer: string): number {
    return this.lastCuratedMsgId.get(peer) ?? 0;
  }

  setLastCuratedMsgId(peer: string, msgId: number): void {
    this.lastCuratedMsgId.set(peer, msgId);
  }

  /**
   * 基于会话 Fork 执行原生 Agent 巡检
   */
  async runCurator(peer: string, sessionContext: any = {}): Promise<CurateRunResult> {
    const cfg = this.options.config ? this.options.config() : {};
    if (!cfg.face_enabled || !cfg.face_auto_curate) {
      return {
        executed: false,
        peer,
        message: 'Face curator is disabled by config (face_enabled or face_auto_curate is false)',
      };
    }

    const curatorSessionId = `curator-${peer}-${Date.now()}`;
    let agentHandle: any = null;
    let parentSession: any = sessionContext.parentSession;
    let parentWorkspace: any = undefined;

    try {
      const agentsService =
        (this.ctx as any)?.agents ||
        (typeof (this.ctx as any)?.get === 'function' ? (this.ctx as any).get('agents') : undefined);

      if (agentsService?.create) {
        let parentSessionId =
          parentSession?.header?.id || parentSession?.id || sessionContext.sessionId;
        const parentCwd = parentSession?.header?.cwd || parentSession?.cwd;

        let seed: any[] | undefined = undefined;
        let inheritedEventCount: number | undefined = undefined;

        if (parentSession && typeof parentSession.snapshotEvents === 'function') {
          try {
            const parentEvents = parentSession.snapshotEvents() || [];
            if (parentEvents.length > 0) {
              const lastTurnEndIndex = parentEvents.findLastIndex(
                (ev: any) => ev?.type === 'turn/end'
              );
              if (lastTurnEndIndex >= 0) {
                let cut = lastTurnEndIndex + 1;
                while (cut < parentEvents.length && parentEvents[cut]?.type !== 'turn/start') {
                  cut++;
                }
                seed = parentEvents.slice(0, cut);
                inheritedEventCount = cut;
              }
            }
          } catch {}
        }

        let prompt = `${FACE_CURATOR_PROMPT_TEMPLATE}\n\n## Context\nYou are reviewing peer: ${peer}\nWhen inspecting images or calling collect_face, associate them with this chat context.`;

        agentHandle = await agentsService.create({
          sessionId: curatorSessionId,
          setup: (agentCtx: any) => {
            const toolsSvc =
              (typeof agentCtx.get === 'function' ? agentCtx.get('tools') : undefined) ||
              agentCtx.tools;
            if (toolsSvc && typeof toolsSvc.restrict === 'function') {
              toolsSvc.restrict({ allow: [...ALLOWED_FACE_CURATOR_TOOLS] });
            }
          },
          ...(seed !== undefined ? { seed, inheritedEventCount } : {}),
          meta: {
            parentSession: parentSessionId,
            ...(parentCwd ? { cwd: parentCwd } : {}),
            ...(seed !== undefined ? { isSeeded: true } : {}),
          },
        });

        const agentObj = agentHandle?.agent || agentHandle;

        if (agentObj && typeof agentObj.followup === 'function') {
          const userMsg = {
            content: [{ type: 'text', text: prompt }],
            source: { kind: 'user' },
          };
          try {
            agentObj.followup(userMsg);
          } catch {
            agentObj.followup(prompt);
          }

          if (typeof agentObj.whenIdle === 'function') {
            await agentObj.whenIdle();
          }
        }
      }

      return {
        executed: true,
        peer,
        message: 'Face curator completed successfully',
      };
    } catch (err: any) {
      return {
        executed: false,
        peer,
        error: err?.message || '未知错误',
      };
    } finally {
      // 严格对齐 DSH 用完即焚销毁契约：清理临时会话
      await this.cleanupCuratorSession(curatorSessionId, agentHandle, parentSession, parentWorkspace);
    }
  }

  /**
   * 物理删除已完成的 Curator Session（用完即焚，不占用会话栏）
   */
  async cleanupCuratorSession(
    sessionId: string,
    agentHandle?: any,
    _parentSession?: any,
    parentWorkspace?: any
  ): Promise<void> {
    try {
      // Step 1: 优先释放内核锁与 agent 循环
      if (agentHandle && typeof agentHandle.dispose === 'function') {
        try {
          await agentHandle.dispose();
        } catch {}
      }

      // Step 2: 内存 Session 清理与持久化解绑
      const sessions =
        (this.ctx as any)?.sessions ||
        (typeof (this.ctx as any)?.get === 'function' ? (this.ctx as any).get('sessions') : undefined);
      if (sessions) {
        try {
          const live = sessions.get?.(sessionId);
          if (live) {
            if (typeof sessions.flush === 'function') {
              await sessions.flush(live);
            }
            if (typeof sessions.detachEntered === 'function') {
              const entry =
                typeof sessions.liveEntryFor === 'function' ? sessions.liveEntryFor(live) : live;
              if (entry) sessions.detachEntered(entry);
            }
          }
        } catch {}
      }

      // Step 3: 工作区解绑
      if (parentWorkspace && typeof parentWorkspace.detachSession === 'function') {
        try {
          await parentWorkspace.detachSession(sessionId);
        } catch {}
      }

      // Step 4: 物理删除
      if (sessions && typeof sessions.deleteSession === 'function') {
        try {
          await sessions.deleteSession(sessionId);
        } catch {}
      }
    } catch {}
  }

  /**
   * 执行单次表情包扫描与提炼任务 (本地图片目录轮询兜底)
   */
  async curateOnce(): Promise<CurateReport> {
    const report: CurateReport = { scanned: 0, adopted: 0, skipped: 0 };

    // 1. 双重门控检查
    const cfg = this.options.config ? this.options.config() : {};
    if (!cfg.face_enabled || !cfg.face_auto_curate) {
      return report;
    }

    if (this.isRunning) {
      return report;
    }
    this.isRunning = true;

    try {
      const scanDirs = this.options.imageScanDirs || [];
      const storeDir = this.options.faceStoreDir || path.resolve('.dsh/napcat/faces');
      fs.mkdirSync(storeDir, { recursive: true });

      // 收集待扫描的图片文件
      const imageFiles: string[] = [];
      for (const dir of scanDirs) {
        if (!fs.existsSync(dir)) continue;
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isFile()) {
            const ext = path.extname(entry.name).toLowerCase();
            if (['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(ext)) {
              imageFiles.push(path.join(dir, entry.name));
            }
          }
        }
      }

      for (const filePath of imageFiles) {
        report.scanned++;

        let fileBuf: Buffer;
        try {
          fileBuf = fs.readFileSync(filePath);
        } catch {
          report.skipped++;
          continue;
        }

        const md5 = crypto.createHash('md5').update(fileBuf).digest('hex');
        const ext = path.extname(filePath).replace(/^\./, '').toLowerCase() || 'png';

        // 检查数据库是否已存在该表情
        const existing = this.options.db.getFaceByMd5(md5);
        if (existing && existing.enabled) {
          report.skipped++;
          continue;
        }

        // 调用模型进行图片分析
        let analysis: any = null;
        if (this.options.llmService && typeof this.options.llmService.analyzeImage === 'function') {
          try {
            analysis = await this.options.llmService.analyzeImage(filePath);
          } catch {
            analysis = null;
          }
        }

        // 判定结果
        if (typeof analysis === 'string') {
          const lower = analysis.toLowerCase().trim();
          if (lower.includes('nothing to save') || lower.includes('无可保存')) {
            report.skipped++;
            continue;
          }
        }

        if (analysis && typeof analysis === 'object' && analysis.is_face && Array.isArray(analysis.tags)) {
          const targetFile = path.join(storeDir, `${md5}.${ext}`);
          try {
            if (!fs.existsSync(targetFile)) {
              fs.copyFileSync(filePath, targetFile);
            }

            const faceId = `face_${md5.slice(0, 8)}`;
            this.options.db.insertFace(
              {
                id: faceId,
                file_path: targetFile,
                md5,
                source: 'curate',
                tags: analysis.tags,
                mood: analysis.mood || '搞笑',
                enabled: true,
                size: fileBuf.length,
                format: ext,
              },
              {
                max: cfg.face_store_max,
                evictPolicy: cfg.face_evict_policy,
              }
            );
            report.adopted++;
          } catch {
            report.skipped++;
          }
        } else {
          report.skipped++;
        }
      }

      return report;
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * 巡检所有活跃会话（基于 SQLite 存储的会话状态表），对每个会话执行 Fork 审视
   * 门控标准：
   * 1. 活跃会话校验（硬标准）：仅限当前 peer 绑定的最新活跃会话，排除已归档、已物理删除或非 QQ 会话；
   * 2. 会话独立计时（触发条件 1）：每个 peer 独立计时（默认 60 分钟），任务完成后重置，实现天然错峰；
   * 3. 用户新图与补标门控（触发条件 2）：自上次巡检后有用户发送的新图 (self=0)，或表情库有未打标表情需补标；若无新图且无未打标表情，彻底静默，0 Token 损耗。
   */
  async runAllActivePeers(): Promise<CurateRunResult[]> {
    const cfg = this.options.config ? this.options.config() : {};
    if (!cfg.face_enabled || !cfg.face_auto_curate) {
      return [];
    }

    const intervalMins = cfg.face_curate_interval_mins ?? DEFAULT_FACE_CURATE_INTERVAL_MINS;
    const intervalMs = Math.max(intervalMins, 0) * 60 * 1000;
    const now = Date.now();

    const states = this.options.db.getAllSessionStates();
    const results: CurateRunResult[] = [];
    const sessions =
      (this.ctx as any)?.sessions ||
      (typeof (this.ctx as any)?.get === 'function' ? (this.ctx as any).get('sessions') : undefined);
    const sm = this.options.sessionManager;

    for (const state of states) {
      if (!state.peer || !state.current_session_id) continue;
      const sid = state.current_session_id;

      // 硬标准: 活跃会话校验 (排除已归档、已删除、非QQ会话)
      if (sm) {
        if (typeof sm.isQQSession === 'function' && !sm.isQQSession(sid)) {
          continue;
        }
        if (typeof sm.isSessionArchived === 'function' && sm.isSessionArchived(sid)) {
          continue;
        }
        if (typeof sm.isSessionPhysicallyPresent === 'function' && !sm.isSessionPhysicallyPresent(sid)) {
          continue;
        }
      }

      // 触发条件 1: 会话专属独立倒计时 (默认 60 分钟)
      const lastAt = this.getLastCuratedAt(state.peer);
      if (now - lastAt < intervalMs) {
        continue;
      }

      // 触发条件 2: 用户发了新图 (self = 0) 或表情库有未打标表情需补标
      const lastMsgId = this.getLastCuratedMsgId(state.peer);
      const { hasNew, latestMsgId } = this.options.db.hasNewImageMessages(state.peer, lastMsgId);
      const hasUntagged = this.options.db.queryFaces({ untagged: true, limit: 1 }).total > 0;

      if (!hasNew && !hasUntagged) {
        // 无新图片且无未打标表情，彻底静默，0 Token 消耗
        continue;
      }

      let parentSession: any = undefined;
      if (sessions && typeof sessions.get === 'function') {
        try {
          parentSession = sessions.get(sid);
        } catch {}
      }

      try {
        const res = await this.runCurator(state.peer, {
          sessionId: sid,
          parentSession,
        });
        if (res.executed) {
          const maxId = Math.max(latestMsgId, this.options.db.getLatestMsgId(state.peer));
          this.setLastCuratedMsgId(state.peer, maxId);
          // 明确信号：打标完成，临时会话销毁后，才开启该会话下一次 60 分钟倒计时 (实现各会话天然错峰)
          this.setLastCuratedAt(state.peer, Date.now());
        }
        results.push(res);
      } catch (err: any) {
        results.push({
          executed: false,
          peer: state.peer,
          error: err?.message || '未知错误',
        });
      }
    }
    return results;
  }
}

/**
 * 启动后台表情包定时巡检任务（轻量调度轮询各会话专属倒计时）
 */
export function startCuratorTask(
  _ctx: Context,
  curator: FaceCurator,
  getConfig: () => BridgePluginConfig
): () => void {
  // 轻量调度轮询：每 60 秒检查一次各活跃会话专属倒计时是否到期
  const TICKER_INTERVAL_MS = 60 * 1000;

  const timer = setInterval(async () => {
    try {
      const currentCfg = getConfig();
      if (!currentCfg.face_enabled || !currentCfg.face_auto_curate) {
        return;
      }
      await curator.runAllActivePeers();
    } catch {}
  }, TICKER_INTERVAL_MS);

  return () => {
    clearInterval(timer);
  };
}
