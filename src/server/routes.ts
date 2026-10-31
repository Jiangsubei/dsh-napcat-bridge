/**
 * dsh-napcat-bridge Server Configuration REST Routes
 *
 * 为 DSH 桌面端与 Web 端客户端提供独立的 HTTP 配置读取与更新通道。
 * 遵循 DSH 0.2.1 规范：
 *   - GET  /plugins/dsh-napcat-bridge/config: 获取当前配置（脱敏秘钥）
 *   - POST /plugins/dsh-napcat-bridge/config: 保存新配置，防误清空秘钥，触发热更新与持久化
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Context } from '@deepseek-ai/cordis';
import type { BridgePluginConfig } from '../types/index.js';
import { sanitizeConfigPayload, healProfileConfigFile } from '../config/heal.js';
import {
  DEFAULT_WS_PORT,
  DEFAULT_IMAGE_TTL_DAYS,
  DEFAULT_PERSONA,
  DEFAULT_BEHAVIOR,
  DEFAULT_PROACTIVE_REPLY_ENABLED,
  DEFAULT_PROACTIVE_ONLY_TEXT_ENABLED,
  DEFAULT_PROACTIVE_INTERVAL_MINS,
  DEFAULT_PROACTIVE_BUFFER_SIZE,
  DEFAULT_PROACTIVE_RANDOM_ENABLED,
  DEFAULT_PROACTIVE_RANDOM_PROBABILITY,
  DEFAULT_PROACTIVE_IDLE_ENABLED,
  DEFAULT_PROACTIVE_IDLE_TIMEOUT_MINS,
  DEFAULT_PROACTIVE_COOLDOWN_MINS,
  DEFAULT_PROACTIVE_NIGHT_DND,
  DEFAULT_MEMORY_DIR,
  DEFAULT_USER_PROFILE_BUDGET_CHARS,
  DEFAULT_SESSION_MEMORY_BUDGET_CHARS,
  DEFAULT_GROUP_MEMORY_TOTAL_BUDGET_CHARS,
  DEFAULT_FACE_ENABLED,
  DEFAULT_FACE_STORE_MAX,
  DEFAULT_FACE_STORE_DIR,
  DEFAULT_FACE_SUB_TYPE,
  DEFAULT_FACE_EVICT_POLICY,
  DEFAULT_SLANG_ENABLED,
  DEFAULT_SLANG_BUDGET_CHARS,
  DEFAULT_SLANG_STORAGE_PATH,
  SETTINGS_NAMESPACE,
} from '../constants/index.js';

export const CONFIG_ROUTE_PATH = '/plugins/dsh-napcat-bridge/config';

export const DEFAULT_BASE_CONFIG: Partial<BridgePluginConfig> = {
  ws_port: DEFAULT_WS_PORT,
  ws_token: '',
  bot_qq: '',
  admins: [],
  aliases: [],
  image_ttl_days: DEFAULT_IMAGE_TTL_DAYS,
  persona: DEFAULT_PERSONA,
  behavior: DEFAULT_BEHAVIOR,
  proactive_reply_enabled: DEFAULT_PROACTIVE_REPLY_ENABLED,
  proactive_interval_mins: DEFAULT_PROACTIVE_INTERVAL_MINS,
  proactive_buffer_size: DEFAULT_PROACTIVE_BUFFER_SIZE,
  proactive_only_text: DEFAULT_PROACTIVE_ONLY_TEXT_ENABLED,
  proactive_random_enabled: DEFAULT_PROACTIVE_RANDOM_ENABLED,
  proactive_random_probability: DEFAULT_PROACTIVE_RANDOM_PROBABILITY,
  proactive_idle_enabled: DEFAULT_PROACTIVE_IDLE_ENABLED,
  proactive_idle_timeout_mins: DEFAULT_PROACTIVE_IDLE_TIMEOUT_MINS,
  proactive_cooldown_mins: DEFAULT_PROACTIVE_COOLDOWN_MINS,
  proactive_night_dnd: DEFAULT_PROACTIVE_NIGHT_DND,
  memory_storage_dir: DEFAULT_MEMORY_DIR,
  user_profile_budget_chars: DEFAULT_USER_PROFILE_BUDGET_CHARS,
  session_memory_budget_chars: DEFAULT_SESSION_MEMORY_BUDGET_CHARS,
  group_memory_total_budget_chars: DEFAULT_GROUP_MEMORY_TOTAL_BUDGET_CHARS,
  face_enabled: DEFAULT_FACE_ENABLED,
  face_store_max: DEFAULT_FACE_STORE_MAX,
  face_store_dir: DEFAULT_FACE_STORE_DIR,
  face_sub_type: DEFAULT_FACE_SUB_TYPE,
  face_evict_policy: DEFAULT_FACE_EVICT_POLICY,
  slang_enabled: DEFAULT_SLANG_ENABLED,
  slang_budget_chars: DEFAULT_SLANG_BUDGET_CHARS,
  slang_storage_path: DEFAULT_SLANG_STORAGE_PATH,
};

export function sendJson(res: ServerResponse, status: number, data: unknown): void {
  const payload = JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

export function parseJsonBody<T = any>(req: IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf-8');
        if (!text.trim()) {
          resolve({} as T);
          return;
        }
        resolve(JSON.parse(text));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

export function registerConfigRoute(
  ctx: Context,
  currentConfigGetter: () => BridgePluginConfig,
  queueReconcile: (cfg?: BridgePluginConfig) => Promise<void>
): () => void {
  const logger = typeof (ctx as any).logger === 'function' ? (ctx as any).logger(SETTINGS_NAMESPACE) : console;
  let unregister: (() => void) | undefined;
  let isDisposed = false;

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const method = (req.method || 'GET').toUpperCase();

    if (method === 'GET') {
      try {
        const rawCfg = currentConfigGetter() || {};
        const { valid: cfg } = sanitizeConfigPayload(rawCfg);
        const hasSecret = Boolean(cfg.ws_token && String(cfg.ws_token).trim().length > 0);
        const safeConfig = {
          ...cfg,
          ws_token: '', // 绝不泄漏明文
        };
        sendJson(res, 200, {
          ok: true,
          hasSecret,
          config: safeConfig,
          baseDefaults: DEFAULT_BASE_CONFIG,
        });
      } catch (err: any) {
        sendJson(res, 500, { ok: false, error: err?.message || 'Internal Server Error' });
      }
      return;
    }

    if (method === 'POST') {
      try {
        const body = (await parseJsonBody(req)) || {};
        const current = currentConfigGetter() || {};
        const mergedCandidate: Record<string, any> = { ...body };

        // 秘钥防误清空逻辑：若未提交 ws_token（为空或未定义），但现有配置存在 ws_token，自动保留现有 token
        if (
          (!mergedCandidate.ws_token || String(mergedCandidate.ws_token).trim() === '') &&
          current.ws_token
        ) {
          mergedCandidate.ws_token = current.ws_token;
        }

        // 自愈过滤：提取 100% 符合当前 Schema 的干净配置字段，剔除任何已下线或未知字段
        const { valid: cleanPayload, removed } = sanitizeConfigPayload(mergedCandidate);

        if (removed.length > 0) {
          logger.info?.(
            `[Config] 保存时检测到并自愈过滤过时配置项 (${removed.length} 项): ${removed.join(', ')}`
          );
          // 异步触发物理配置文件自愈，清理持久层残留的死键
          try {
            healProfileConfigFile(undefined, undefined, logger);
          } catch {
            // 物理自愈静默
          }
        }

        // 持久化到 settings (仅提交通过 Schema 白名单校验的干净字段，杜绝 DSH isVolatilePath 500 报错)
        const settings = (ctx as any).get?.('settings');
        if (settings) {
          try {
            if (typeof settings.mutate === 'function') {
              const ops = Object.entries(cleanPayload).map(([key, value]) => ({
                op: 'set' as const,
                path: [key],
                value,
              }));
              await settings.mutate(SETTINGS_NAMESPACE, ops);
            } else if (typeof settings.update === 'function') {
              await settings.update(SETTINGS_NAMESPACE, cleanPayload);
            }
          } catch (err: any) {
            logger.error?.('[Plugin] 持久化配置到 settings 失败:', err);
            sendJson(res, 500, {
              ok: false,
              error: err?.message || 'Failed to persist settings',
            });
            return;
          }
        }

        // 触发热更新
        await queueReconcile(cleanPayload);

        sendJson(res, 200, {
          ok: true,
          config: cleanPayload,
          healedKeys: removed,
          hasSecret: Boolean(
            cleanPayload.ws_token && String(cleanPayload.ws_token).trim().length > 0
          ),
        });
      } catch (err: any) {
        sendJson(res, 500, { ok: false, error: err?.message || 'Failed to update config' });
      }
      return;
    }

    sendJson(res, 405, { ok: false, error: 'Method Not Allowed' });
  };

  const doRegister = (server: any) => {
    if (isDisposed) return;
    if (typeof server?.register === 'function') {
      try {
        unregister = server.register({
          kind: 'exact',
          path: CONFIG_ROUTE_PATH,
          handler,
        });
      } catch (err: any) {
        const logger = typeof (ctx as any).logger === 'function' ? (ctx as any).logger(SETTINGS_NAMESPACE) : console;
        logger.warn?.(`[routes] Failed to register ${CONFIG_ROUTE_PATH}: ${err?.message || err}`);
      }
    }
  };

  const directServer = typeof (ctx as any).get === 'function' ? (ctx as any).get('webServer') : undefined;
  if (directServer) {
    doRegister(directServer);
  } else if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (subCtx: any) => {
      const server = subCtx?.webServer ?? (typeof (ctx as any).get === 'function' ? (ctx as any).get('webServer') : undefined);
      doRegister(server);
    });
  }

  const disposeRoute = () => {
    isDisposed = true;
    if (typeof unregister === 'function') {
      try {
        unregister();
      } catch {
        // ignore
      }
      unregister = undefined;
    }
  };

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      disposeRoute();
    });
  }

  return disposeRoute;
}
