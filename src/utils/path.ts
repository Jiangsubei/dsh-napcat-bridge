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

/**
 * 将字符串转义为安全的文件路径段（对齐 DSH 0.1.5 session-persistence-jsonl 的 encodeSegment 规范）
 */
export function encodeSegment(raw: string): string {
  if (raw.length === 0) throw new Error('cannot encode an empty path segment');
  if (raw === '.') return '~002E';
  if (raw === '..') return '~002E~002E';
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch;
    else out += '~' + code.toString(16).toUpperCase().padStart(4, '0');
  }
  return out;
}
