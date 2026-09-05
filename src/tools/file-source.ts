/**
 * dsh-napcat-bridge: send_file 文件源归一化与 WSL→Windows 路径翻译 (IS-S1/IS-S2/IS-S4)
 *
 * 部署拓扑（docs/桌面 Dshnapcat-部署备忘.md）：NapCat 跑在 Windows 宿主机，DSH 在 WSL（同一物理机，
 * /mnt/<drive> 即 <drive>:）。NapCat 解析 data.file 失败为跨文件系统部署的实锤坑（NapCat issue #198）。
 * 本模块负责把 agent 提交的四种文件源形态统一归一化：
 *   1. 本地绝对路径     /mnt/c/... → 校验存在后翻译为 file:///C:/... 交付；
 *   2. file:// URI     file:///mnt/c/... → file:///C:/...；file:///C:/... 原样；
 *   3. URL             http(s):// 直传（NapCat 侧需能访问外网）；
 *   4. Base64          base64:// 直传；data:...;base64, 归一为 base64://。
 * 无法翻译的 WSL 内部路径（/home/...、/tmp/...）直接返回清晰错误（成功:false），绝不假成功。
 */

import * as fs from 'node:fs';

export type SendFileSourceKind = 'local' | 'file-uri' | 'url' | 'base64' | 'windows-path';

export interface NormalizedSendFileSource {
  kind: SendFileSourceKind;
  /** 归一化后交付给 NapCat data.file 的值 */
  value: string;
  /** WSL 侧存在性校验路径（仅当该路径可可靠校验时提供，如 /mnt/c 已挂载） */
  localCheckPath?: string;
  /** 该值 NapCat(Windows) 侧是否可访问 */
  napcatAccessible: boolean;
}

export type ClassifyResult = { source: NormalizedSendFileSource } | { error: string };

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|svg|ico|avif)$/i;

/**
 * IS-S2: 文件类型判定 —— file_type 参数强制生效；未显式指定时按路径/URL 扩展名自动推导
 * （URL 带 query/hash 时先剥离 query/hash 再取扩展名）。
 */
export function detectSendFileType(
  fileType: 'image' | 'file' | undefined,
  sourceValue: string
): 'image' | 'file' {
  if (fileType === 'image' || fileType === 'file') {
    return fileType;
  }
  const pathPart = sourceValue.split(/[?#]/)[0] || '';
  return IMAGE_EXT_RE.test(pathPart) ? 'image' : 'file';
}

/** WSL 路径 /mnt/<drive>/... → Windows file:///<DRIVE>:/... （无法翻译返回 null） */
export function wslPathToWindowsFileUri(wslPath: string): string | null {
  const m = wslPath.match(/^\/mnt\/([a-zA-Z])(?:\/(.*))?$/);
  if (!m) return null;
  const drive = m[1].toUpperCase();
  const rest = m[2] || '';
  return `file:///${drive}:/${rest}`;
}

/** Windows 路径 C:\... / C:/... → WSL 路径 /mnt/<drive>/... （无法映射返回 null） */
export function windowsPathToWsl(windowsPath: string): string | null {
  const m = windowsPath.match(/^([a-zA-Z]):[\\/](.*)$/);
  if (!m) return null;
  return `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`;
}

/** 判断 WSL 侧 /mnt/<drive> 是否挂载（存在性校验是否可靠） */
function driveMounted(windowsDrive: string): boolean {
  try {
    return fs.existsSync(`/mnt/${windowsDrive.toLowerCase()}`);
  } catch {
    return false;
  }
}

/**
 * IS-S1: 文件源归一化 —— 本地路径 / file:// URI / URL / Base64 四种形态 +
 * WSL→Windows 路径翻译层。纯函数（含少量挂载探测），sendFile 外部再做存在性校验。
 */
export function classifySendFileSource(input: string): ClassifyResult {
  const trimmed = (input || '').trim();
  if (!trimmed) {
    return { error: '发送文件失败: 你需要指定 file_path' };
  }

  // 1. Base64: base64:// 前缀原样；data:...;base64, 归一为 base64://
  if (/^base64:\/\//i.test(trimmed)) {
    return { source: { kind: 'base64', value: trimmed, napcatAccessible: true } };
  }
  if (/^data:[^,]*;base64,/i.test(trimmed)) {
    const b64 = trimmed.replace(/^data:[^,]*;base64,/i, '');
    return { source: { kind: 'base64', value: `base64://${b64}`, napcatAccessible: true } };
  }

  // 2. URL: 直传
  if (/^https?:\/\//i.test(trimmed)) {
    return { source: { kind: 'url', value: trimmed, napcatAccessible: true } };
  }

  // 3. file:// URI：剥离前缀后按路径形态归类
  if (trimmed.startsWith('file://')) {
    const rest = trimmed.replace(/^file:\/\//, '');
    const pathPart = rest.startsWith('/') ? rest.slice(1) : rest; // file:///C:/... -> C:/...
    const win = pathPart.match(/^([a-zA-Z]):[\\/](.*)$/);
    if (win) {
      const value = `file:///${win[1].toUpperCase()}:/${win[2].replace(/\\/g, '/')}`;
      const mapped = windowsPathToWsl(`${win[1]}:\\${win[2].replace(/\//g, '\\')}`);
      const checkable = mapped !== null && driveMounted(win[1]);
      return {
        source: {
          kind: 'file-uri',
          value,
          ...(checkable && mapped ? { localCheckPath: mapped } : {}),
          napcatAccessible: true,
        },
      };
    }
    // file:///mnt/c/... → 翻译为 file:///C:/...
    const mntUri = wslPathToWindowsFileUri(rest);
    if (mntUri) {
      return {
        source: { kind: 'file-uri', value: mntUri, localCheckPath: rest, napcatAccessible: true },
      };
    }
    // 其他 POSIX 绝对路径（WSL 内部、非共享盘）→ NapCat 侧无法访问
    if (rest.startsWith('/')) {
      return {
        error: `发送文件失败: file:// 指向 WSL 内部路径 (${rest})，NapCat(Windows 宿主机) 侧无法访问该路径；请将文件放入共享目录（如 /mnt/c/napcat_share/）后改传 /mnt/c/... 或 file:///C:/... 路径`,
      };
    }
    return { error: `发送文件失败: 无法识别 file:// URI: ${trimmed}` };
  }

  // 4. Windows 绝对路径 C:\... / C:/... → 归一为 file:///C:/...
  const winPath = trimmed.match(/^([a-zA-Z]):[\\/](.*)$/);
  if (winPath) {
    const value = `file:///${winPath[1].toUpperCase()}:/${winPath[2].replace(/\\/g, '/')}`;
    const mapped = `/mnt/${winPath[1].toLowerCase()}/${winPath[2].replace(/\\/g, '/')}`;
    const checkable = driveMounted(winPath[1]);
    return {
      source: {
        kind: 'windows-path',
        value,
        ...(checkable ? { localCheckPath: mapped } : {}),
        napcatAccessible: true,
      },
    };
  }

  // 5. POSIX 绝对路径
  if (trimmed.startsWith('/')) {
    const mnt = wslPathToWindowsFileUri(trimmed);
    if (mnt) {
      return {
        source: { kind: 'local', value: mnt, localCheckPath: trimmed, napcatAccessible: true },
      };
    }
    return {
      error: `发送文件失败: 路径 (${trimmed}) 是 WSL 内部路径，NapCat(Windows 宿主机) 侧无法访问；请将文件放入共享目录（如 /mnt/c/napcat_share/）后传 /mnt/c/... 路径，或改用 file:///C:/... / URL / base64`,
    };
  }

  // 6. 无法识别（相对路径等）
  return {
    error: `发送文件失败: 无法识别的文件源（需本地绝对路径 / file:// URI / URL / base64）: ${trimmed}`,
  };
}