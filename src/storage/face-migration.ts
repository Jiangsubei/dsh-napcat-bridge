/**
 * src/storage/face-migration.ts
 * 负责在插件启动时平滑迁移存量表情包的相对路径至规范的绝对路径，
 * 并在工作区发生 cwd 漂移时自动从 profiles 目录寻回物理文件，实现全自动自愈。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { MessageDatabase } from './database.js';
import { resolveDshPath } from '../utils/path.js';
import { DEFAULT_FACE_STORE_DIR } from '../constants/index.js';

export interface FaceMigrationOptions {
  db: MessageDatabase;
  dshHome?: string;
  faceStoreDir?: string;
}

export interface FaceMigrationResult {
  migratedCount: number;
  fixedFilesCount: number;
}

export function migrateFaceStoragePaths(options: FaceMigrationOptions): FaceMigrationResult {
  const dshHome = options.dshHome || process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const canonicalDir = resolveDshPath(dshHome, options.faceStoreDir, DEFAULT_FACE_STORE_DIR);

  try {
    fs.mkdirSync(canonicalDir, { recursive: true });
  } catch {}

  const faces = options.db.queryFaces({ limit: 10000 }).faces;
  let migratedCount = 0;
  let fixedFilesCount = 0;

  for (const face of faces) {
    const canonicalPath = path.resolve(canonicalDir, `${face.md5}.${face.format}`);
    const sourcePath = face.file_path;

    // 1. 若目标规范文件不存在，搜寻候选物理文件位置并拷贝至规范目录
    if (!fs.existsSync(canonicalPath)) {
      const candidates = [
        sourcePath,
        path.isAbsolute(sourcePath) ? '' : path.resolve(process.cwd(), sourcePath),
        path.isAbsolute(sourcePath) ? '' : resolveDshPath(dshHome, sourcePath, DEFAULT_FACE_STORE_DIR),
        path.join(dshHome, 'profiles', 'desktop', '.dsh', 'napcat', 'faces', `${face.md5}.${face.format}`),
        path.join(dshHome, 'profiles', 'desktop', sourcePath),
        path.resolve('.dsh', 'napcat', 'faces', `${face.md5}.${face.format}`),
      ].filter(Boolean);

      for (const cand of candidates) {
        if (cand && fs.existsSync(cand)) {
          try {
            fs.copyFileSync(cand, canonicalPath);
            fixedFilesCount++;
            break;
          } catch {}
        }
      }
    }

    // 2. 若规范路径文件已就绪，且数据库中记录的不是规范路径（如相对路径），更新数据库
    if (fs.existsSync(canonicalPath) && face.file_path !== canonicalPath) {
      try {
        options.db.updateFaceFilePath(face.id, canonicalPath);
        migratedCount++;
      } catch {}
    }
  }

  return { migratedCount, fixedFilesCount };
}
