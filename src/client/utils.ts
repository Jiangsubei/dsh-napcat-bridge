export function formatArrayToString(arr?: string[]): string {
  if (!Array.isArray(arr)) return '';
  return arr.join(', ');
}

export function parseStringToArray(str: string): string[] {
  return str
    .split(/[,，\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}
