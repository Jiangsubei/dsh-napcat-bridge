/**
 * dsh-napcat-bridge: 表情管理工具 (manage_faces)
 * 专职负责表情库生命周期治理：修改标签/情绪、按 ID 删除表情、查询存储配额占用、淘汰冷门表情。
 */

import type { ManageFacesParams, ManageFacesResult } from '../types/index.js';
import { getGlobalToolContext, toLosslessJson, type ToolExecutionContext } from './index.js';

export async function manageFaces(
  params: ManageFacesParams,
  context?: ToolExecutionContext
): Promise<ManageFacesResult> {
  const ctx = { ...getGlobalToolContext(), ...context };

  if (!ctx.db) {
    return toLosslessJson({
      success: false,
      error: '数据库不可用，无法管理表情',
    });
  }

  const action = params?.action;
  if (!action || !['update', 'delete', 'query_quota', 'evict'].includes(action)) {
    return toLosslessJson({
      success: false,
      error: 'action 参数无效，必须为 update | delete | query_quota | evict 之一',
    });
  }

  // 1. query_quota: 查库统计当前表情总数、配额上限 faceStoreMax、占用字节数，返回 { total, max_quota, available }
  if (action === 'query_quota') {
    const rawDb = typeof (ctx.db as any).ensureDb === 'function'
      ? (ctx.db as any).ensureDb()
      : (ctx.db as any).db;

    let total = 0;
    let totalBytes = 0;

    if (rawDb && typeof rawDb.prepare === 'function') {
      const row = rawDb.prepare(`
        SELECT COUNT(*) as total, COALESCE(SUM(size), 0) as total_bytes
        FROM faces
        WHERE deleted_at IS NULL AND enabled = 1
      `).get() as { total: number; total_bytes: number } | undefined;
      total = row ? Number(row.total) : 0;
      totalBytes = row ? Number(row.total_bytes) : 0;
    } else {
      const q = ctx.db.queryFaces({ enabledOnly: true, limit: 1 });
      total = q.total;
    }

    const maxQuota = ctx.faceStoreMax ?? 100;
    const available = Math.max(0, maxQuota - total);

    return toLosslessJson({
      success: true,
      action: 'query_quota',
      total,
      max_quota: maxQuota,
      available,
      total_bytes: totalBytes,
      message: `当前表情总数: ${total}，配额上限: ${maxQuota}，剩余可用: ${available}，存储占用: ${(totalBytes / 1024).toFixed(1)} KB`,
    });
  }

  // 2. update: 根据 face_id 更新该表情的 tags 和 mood，返回 { success: true, face_id }；若 face_id 不存在返回错误
  if (action === 'update') {
    const faceId = params.face_id?.trim();
    if (!faceId) {
      return toLosslessJson({
        success: false,
        error: 'update 操作缺少必填参数 face_id',
      });
    }

    const existing = ctx.db.getFaceById(faceId);
    if (!existing) {
      return toLosslessJson({
        success: false,
        error: `表情 ID "${faceId}" 不存在`,
      });
    }

    if (params.tags === undefined && params.mood === undefined) {
      return toLosslessJson({
        success: false,
        error: 'update 操作至少需提供 tags 或 mood 之一',
      });
    }

    const updated = ctx.db.updateFace(faceId, {
      tags: params.tags,
      mood: params.mood?.trim(),
    });

    return toLosslessJson({
      success: true,
      action: 'update',
      face_id: faceId,
      message: `已成功更新表情 "${faceId}"（标签: [${(updated?.tags || []).join(', ')}]，情绪: ${updated?.mood || '未设置'}）`,
    });
  }

  // 3. delete: 根据 face_id 软删除该表情（设置 enabled = false, deleted_at = Date.now()），返回 { success: true, face_id }；若不存在返回错误
  if (action === 'delete') {
    const faceId = params.face_id?.trim();
    if (!faceId) {
      return toLosslessJson({
        success: false,
        error: 'delete 操作缺少必填参数 face_id',
      });
    }

    const existing = ctx.db.getFaceById(faceId);
    if (!existing) {
      return toLosslessJson({
        success: false,
        error: `表情 ID "${faceId}" 不存在或已被删除`,
      });
    }

    const deleted = ctx.db.deleteFace(faceId);
    if (!deleted) {
      return toLosslessJson({
        success: false,
        error: `删除表情 "${faceId}" 失败`,
      });
    }

    return toLosslessJson({
      success: true,
      action: 'delete',
      face_id: faceId,
      message: `已成功删除表情 "${faceId}"`,
    });
  }

  // 4. evict: 当库容超限或按需淘汰时，根据 LRU 或创建时间淘汰最旧的 count（默认 10）张表情，返回 { success: true, evicted_count }
  if (action === 'evict') {
    const count = Math.max(1, typeof params.count === 'number' && Number.isFinite(params.count) ? Math.floor(params.count) : 10);
    const rawDb = typeof (ctx.db as any).ensureDb === 'function'
      ? (ctx.db as any).ensureDb()
      : (ctx.db as any).db;

    let candidateIds: string[] = [];

    if (rawDb && typeof rawDb.prepare === 'function') {
      const nonManual = rawDb.prepare(`
        SELECT id FROM faces
        WHERE deleted_at IS NULL AND source != 'manual'
        ORDER BY COALESCE(last_used_at, 0) ASC, added_at ASC
        LIMIT ?
      `).all(count) as Array<{ id: string }>;
      candidateIds = nonManual.map((r) => r.id);

      if (candidateIds.length < count) {
        const remaining = count - candidateIds.length;
        const notIn = candidateIds.length > 0 ? `AND id NOT IN (${candidateIds.map(() => '?').join(', ')})` : '';
        const fallback = rawDb.prepare(`
          SELECT id FROM faces
          WHERE deleted_at IS NULL ${notIn}
          ORDER BY COALESCE(last_used_at, 0) ASC, added_at ASC
          LIMIT ?
        `).all(...candidateIds, remaining) as Array<{ id: string }>;
        candidateIds.push(...fallback.map((r) => r.id));
      }
    } else {
      const q = ctx.db.queryFaces({
        enabledOnly: true,
        orderBy: 'last_used_at',
        order: 'asc',
        limit: count,
      });
      candidateIds = q.faces.map((f) => f.id);
    }

    let evictedCount = 0;
    for (const id of candidateIds) {
      if (ctx.db.deleteFace(id)) {
        evictedCount++;
      }
    }

    return toLosslessJson({
      success: true,
      action: 'evict',
      evicted_count: evictedCount,
      message: `已成功淘汰 ${evictedCount} 张冷门表情`,
    });
  }

  return toLosslessJson({
    success: false,
    error: `未知操作: ${action}`,
  });
}
