import * as path from 'node:path';
import * as os from 'node:os';

/**
 * 将相对路径或带 .dsh 前缀的路径规范化为基于 dshHome 的绝对路径。
 * 若传入绝对路径，则直接返回绝对路径。
 */
export function resolveDshPath(dshHome?: string, targetPath?: string, defaultRelative = ''): string {
  const fallbackHome = dshHome || process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const effectiveHome = path.resolve(fallbackHome);
  const candidate = targetPath && targetPath.trim() ? targetPath.trim() : defaultRelative;
  if (!candidate) {
    return effectiveHome;
  }
  if (path.isAbsolute(candidate)) {
    return path.resolve(candidate);
  }
  const cleanRelative = candidate.replace(/^(?:\.\/|\.\\)?\.dsh(?:[\\/]|$)/, '');
  return path.resolve(effectiveHome, cleanRelative);
}
