/**
 * dsh-napcat-bridge: 群文件记录解析与双记录合并去重辅助
 */

/** 同一次群文件上传在 notice 与消息段两条记录间允许的最大时间差 */
export const GROUP_FILE_DEDUPE_WINDOW_MS = 30_000;

export interface GroupFileRowInfo {
  fileName: string;
  size?: number;
}

export interface MergedGroupFileEntry extends GroupFileRowInfo {
  row: any;
  fileId: string;
  busid: number;
  userId: string;
}

/**
 * 从群文件消息行解析文件名与大小。
 * 兼容两类历史落库形态：
 * - notice 事件：raw 为对象，文件名在 file.name / 大小在 file.size；
 * - 消息段：raw 为段数组，文件名在 file 段的 data.file / 大小在 data.file_size。
 */
export function parseGroupFileRowInfo(row: any): GroupFileRowInfo {
  let fileName = '';
  let size: number | undefined = undefined;

  if (row?.raw) {
    try {
      const parsed = JSON.parse(row.raw);
      const nodes = Array.isArray(parsed) ? parsed : [parsed];
      for (const node of nodes) {
        const file = node?.file ?? (node?.type === 'file' ? node?.data : null);
        if (!file) continue;
        if (!fileName) {
          const name = file.name ?? file.file_name ?? file.file;
          if (name !== undefined && name !== null && String(name).trim() !== '') {
            fileName = String(name).trim();
          }
        }
        if (size === undefined) {
          const rawSize = typeof file.size === 'number' ? file.size : Number(file.file_size);
          if (Number.isFinite(rawSize) && rawSize >= 0) size = rawSize;
        }
        if (fileName && size !== undefined) break;
      }
    } catch {}
  }

  if (!fileName && row?.content) {
    const match = String(row.content).match(/^\[群文件:(.+?)\s*\(ID:/);
    if (match && match[1]) {
      fileName = match[1].trim();
    } else {
      fileName = String(row.content).replace(/^\[群文件:/, '').replace(/\]$/, '').trim();
    }
  }

  if (!fileName) fileName = '未知文件';
  return { fileName, size };
}

/**
 * 合并同一次群文件上传产生的双记录（notice/group_upload + 消息段）。
 * 判定条件：同 peer（调用方保证）、同文件名、时间差 ≤ 30s、上传者与大小兼容。
 * 合并策略：保留首次出现（notice）的 msg_id/time；file_id 优先 /uuid 形态；busid 优先正数。
 */
export function mergeDuplicateGroupFileRows(rows: any[]): MergedGroupFileEntry[] {
  const merged: MergedGroupFileEntry[] = [];

  for (const row of rows) {
    const info = parseGroupFileRowInfo(row);
    const rowTime = Number(row.time);
    const userId = String(row.user_id ?? '');
    const fileId = String(row.file_id || '');
    const busid = row.busid !== null && row.busid !== undefined ? Number(row.busid) : 0;

    const existing = merged.find((entry) => {
      if (entry.fileName !== info.fileName) return false;
      if (Math.abs(Number(entry.row.time) - rowTime) > GROUP_FILE_DEDUPE_WINDOW_MS) return false;
      if (entry.userId && userId && entry.userId !== userId) return false;
      if (entry.size !== undefined && info.size !== undefined && entry.size !== info.size) return false;
      return true;
    });

    if (!existing) {
      merged.push({ ...info, row, fileId, busid, userId });
      continue;
    }

    // 优先 /uuid 形态 file_id（SnowLuma get_group_file_url 仅接受该形态）
    if (!existing.fileId.startsWith('/') && fileId.startsWith('/')) {
      existing.fileId = fileId;
    }
    // busid 优先保留正数
    if ((!Number.isFinite(existing.busid) || existing.busid <= 0) && Number.isFinite(busid) && busid > 0) {
      existing.busid = busid;
    }
    if (existing.size === undefined && info.size !== undefined) {
      existing.size = info.size;
    }
  }

  return merged;
}
