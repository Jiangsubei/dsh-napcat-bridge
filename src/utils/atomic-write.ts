/**
 * dsh-napcat-bridge: 原子文件写入工具
 * 将内容安全写入临时文件后，通过原子重命名 (fs.rename) 替换目标文件，防止并发与写入中途断电损坏。
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

export async function atomicWriteFile(
  targetPath: string,
  content: string | Buffer,
  encoding: BufferEncoding = 'utf-8'
): Promise<void> {
  const dir = path.dirname(targetPath);
  await fs.mkdir(dir, { recursive: true });

  const randomSuffix = crypto.randomBytes(8).toString('hex');
  const tempPath = path.join(dir, `.${path.basename(targetPath)}.${randomSuffix}.tmp`);

  try {
    if (typeof content === 'string') {
      await fs.writeFile(tempPath, content, { encoding });
    } else {
      await fs.writeFile(tempPath, content);
    }
    await fs.rename(tempPath, targetPath);
  } catch (err) {
    try {
      await fs.unlink(tempPath);
    } catch {
      // Ignore cleanup error
    }
    throw err;
  }
}
