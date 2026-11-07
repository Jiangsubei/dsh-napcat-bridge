/**
 * 隐私守卫（Privacy Guard）
 *
 * 目标：阻止真实 QQ 号 / 群号等身份 ID 进入仓库（含测试夹具、文档采样与提交历史）。
 *
 * 设计原则：
 * 1. 只判定「身份 ID 上下文」中的数字，避免误伤 message_id / msg_id / time / seq 等普通数字；
 * 2. 只允许标准 Mock 段（见 privacy/policy.json）与约定例外值；
 * 3. 违规报告一律掩码输出，绝不把疑似真实 ID 完整打印到日志或测试失败信息中；
 * 4. 本脚本不写入任何真实值，策略全部来自可审计的 privacy/policy.json。
 *
 * 运行方式：`pnpm check:privacy`（契约测试 tests/contract/privacy-guard.test.ts 会强制调用）。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface IdRange {
  from: number;
  to: number;
  note?: string;
}

export interface PrivacyPolicy {
  version: number;
  idLength: { minDigits: number; maxDigits: number };
  allowedRanges: IdRange[];
  allowedLiterals: string[];
  identityKeys: string[];
  ignore: string[];
}

export type ViolationKind = 'identity-key' | 'peer-token' | 'cq-code' | 'log-entry' | 'qq-text';

export interface Violation {
  file: string;
  line: number;
  column: number;
  kind: ViolationKind;
  /** 掩码后的 ID，例如 `16******95` */
  masked: string;
  /** 已掩码的行内片段 */
  snippet: string;
}

const POLICY_PATH = fileURLToPath(new URL('../privacy/policy.json', import.meta.url));

export const DEFAULT_POLICY: PrivacyPolicy = JSON.parse(readFileSync(POLICY_PATH, 'utf8')) as PrivacyPolicy;

/** 对疑似真实 ID 做掩码，只保留前两位与后两位，避免报告本身成为泄漏源 */
export function maskId(id: string): string {
  if (id.length <= 4) return '*'.repeat(id.length);
  return `${id.slice(0, 2)}${'*'.repeat(id.length - 4)}${id.slice(-2)}`;
}

/** 判断一个数字串是否属于允许的 Mock 段 */
export function isAllowedId(id: string, policy: PrivacyPolicy = DEFAULT_POLICY): boolean {
  const { minDigits, maxDigits } = policy.idLength;
  if (!/^\d+$/.test(id)) return true;
  // 过短（序号、毫秒内计数）或过长（时间戳、雪花 ID）不属于 QQ 号形态，不判定为违规
  if (id.length < minDigits || id.length > maxDigits) return true;
  if (policy.allowedLiterals.includes(id)) return true;
  const value = Number(id);
  return policy.allowedRanges.some((range) => value >= range.from && value <= range.to);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface DetectionPattern {
  kind: ViolationKind;
  regex: RegExp;
}

function buildPatterns(policy: PrivacyPolicy): DetectionPattern[] {
  const keys = [...policy.identityKeys].sort((a, b) => b.length - a.length).map(escapeRegExp);
  // 顺序即优先级：越具体的形态越靠前，同一行同一 ID 命中多种形态时保留最具体的 kind
  return [
    {
      kind: 'cq-code',
      regex: /\[CQ:[a-z_]+[^\]]*?\bqq=(\d{5,12})(?!\d)/gi,
    },
    {
      kind: 'log-entry',
      regex: /\[\s*[^[\]()\n]{1,40}\((\d{5,12})\)\s*\]/g,
    },
    {
      kind: 'qq-text',
      regex: /(?<![A-Za-z0-9_])QQ\s*[:：]\s*(\d{5,12})(?!\d)/gi,
    },
    {
      kind: 'peer-token',
      regex: /(?<![A-Za-z0-9_])(?:qq[-_])?(?:user|group|friend)[-_](\d{5,12})(?!\d)/gi,
    },
    {
      kind: 'identity-key',
      regex: new RegExp(
        `(?<![A-Za-z0-9_])(?:${keys.join('|')})\\s*["']?\\s*[:=]\\s*["']?(\\d{5,12})(?!\\d)`,
        'gi',
      ),
    },
  ];
}

/** 扫描一段文本，返回其中疑似真实身份 ID 的违规记录 */
export function scanText(text: string, file: string, policy: PrivacyPolicy = DEFAULT_POLICY): Violation[] {
  const patterns = buildPatterns(policy);
  const violations: Violation[] = [];
  const seen = new Set<string>();
  const lines = text.split(/\r?\n/);

  lines.forEach((line, index) => {
    for (const { kind, regex } of patterns) {
      regex.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = regex.exec(line)) !== null) {
        const digits = match[match.length - 1] ?? '';
        if (isAllowedId(digits, policy)) continue;
        const column = (match.index ?? 0) + 1;
        // 同一行内同一个 ID 可能被多种上下文同时命中（如 peer + groupId），只报一次
        const dedupeKey = `${index}:${digits}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        violations.push({
          file,
          line: index + 1,
          column,
          kind,
          masked: maskId(digits),
          snippet: line.split(digits).join(maskId(digits)).trim().slice(0, 200),
        });
      }
    }
  });

  return violations;
}

function globToRegExp(pattern: string): RegExp {
  const source = pattern.replace(/\\/g, '/');
  let out = '^';
  for (let i = 0; i < source.length; i++) {
    const char = source[i]!;
    if (char === '*') {
      if (source[i + 1] === '*') {
        out += '.*';
        i += 1;
      } else {
        out += '[^/]*';
      }
    } else if ('/.+^${}()|[]\\'.includes(char)) {
      out += `\\${char}`;
    } else {
      out += char;
    }
  }
  return new RegExp(`${out}$`);
}

function isIgnored(file: string, policy: PrivacyPolicy): boolean {
  const normalized = file.replace(/\\/g, '/');
  const basename = normalized.slice(normalized.lastIndexOf('/') + 1);
  return policy.ignore.some((glob) => {
    const regex = globToRegExp(glob);
    return glob.includes('/') ? regex.test(normalized) : regex.test(basename);
  });
}

/** 列出仓库中纳入扫描的文件（已跟踪 + 未忽略的新增文件） */
export function listRepositoryFiles(root: string): string[] {
  const output = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

/** 扫描整个仓库，返回全部违规记录 */
export function scanRepository(root: string, policy: PrivacyPolicy = DEFAULT_POLICY): Violation[] {
  const violations: Violation[] = [];
  for (const file of listRepositoryFiles(root)) {
    if (isIgnored(file, policy)) continue;
    const absolute = resolve(root, file);
    let stat;
    try {
      stat = statSync(absolute);
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.size > 8 * 1024 * 1024) continue;
    let text: string;
    try {
      text = readFileSync(absolute, 'utf8');
    } catch {
      continue;
    }
    // 跳过二进制文件
    if (text.includes('\u0000')) continue;
    violations.push(...scanText(text, file, policy));
  }
  return violations;
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return Boolean(entry) && resolve(entry) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  const root = process.cwd();
  const violations = scanRepository(root);
  if (violations.length === 0) {
    console.log('privacy-guard: 未发现疑似真实身份 ID。');
    process.exit(0);
  }
  console.error(`privacy-guard: 发现 ${violations.length} 处疑似真实身份 ID（已掩码）：`);
  for (const violation of violations) {
    console.error(`  ${violation.file}:${violation.line}:${violation.column} [${violation.kind}] ${violation.masked}`);
    console.error(`    ${violation.snippet}`);
  }
  console.error('\n请改用 privacy/policy.json 中允许的标准 Mock ID，禁止提交真实 QQ 号/群号。');
  process.exit(1);
}
