/**
 * dsh-napcat-bridge: 出站文本渲染模块
 * 实现 Markdown 语法剥离与 NapCat 纯文本排版转换。
 */

/**
 * 剥离 Markdown 格式符号，转换为适合 QQ 客户端阅读的整洁纯文本排版。
 * 遵循规格 §7.2：
 * 1. 标题: #+ Title -> 【Title】
 * 2. 粗体/斜体/下划线: **text** / *text* / __text__ / _text_ -> text
 * 3. 行内代码与代码块: `code` -> code, 移除 ```lang
 * 4. 超链接: [title](url) -> title (url)
 * 5. 表格: 移除 |---| 分隔线，归一化单元格
 * 6. 引用与分割线等语法符号剥离
 */
export function stripMarkdown(markdown: string): string {
  if (!markdown || typeof markdown !== 'string') {
    return '';
  }

  let text = markdown;

  // 1. 处理多行代码块 ```lang ... ```
  text = text.replace(/```[^\n]*\r?\n([\s\S]*?)```/g, (_match, code) => {
    return code;
  });
  // 清理任何残留的反引号围栏
  text = text.replace(/```[^\n]*/g, '');

  // 2. 处理行内代码 `code`
  text = text.replace(/`([^`\r\n]+)`/g, '$1');
  text = text.replace(/`/g, '');

  // 3. 处理标题 #+ Title -> 【Title】
  text = text.replace(/^(\s*)#{1,6}\s+(.+?)(?:\s+#+)?$/gm, '$1【$2】');

  // 4. 处理图片链接 ![alt](url) -> [图片: url]
  text = text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '[图片: $2]');

  // 5. 处理超链接 [text](url) -> text (url)
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');

  // 6. 处理粗体与斜体
  // 粗斜体 ***text*** 或 ___text___
  text = text.replace(/\*\*\*([^*\n]+)\*\*\*/g, '$1');
  text = text.replace(/___([^_]+)___/g, '$1');
  // 粗体 **text** 或 __text__
  text = text.replace(/\*\*([^*\n]+)\*\*/g, '$1');
  text = text.replace(/__([^_]+)__/g, '$1');
  // 斜体 *text*
  text = text.replace(/\*([^*\n]+)\*/g, '$1');
  // 斜体 _text_
  text = text.replace(/_([^_]+)_/g, '$1');

  // 7. 处理删除线 ~~text~~ -> text
  text = text.replace(/~~([^~\n]+)~~/g, '$1');

  // 8. 处理表格
  // 移除表格表头分隔线 |---|---| 或 |:---|---:|
  text = text.replace(/^\s*\|?(\s*:?-+:?\s*\|)+\s*(:?-+:?\s*)?\|?\s*$/gm, '');

  // 格式化普通表格数据行 | a | b | -> a | b
  text = text.replace(/^\s*\|\s*(.*?)\s*\|\s*$/gm, (_match, rowContent) => {
    const cells = rowContent
      .split('|')
      .map((c: string) => c.trim())
      .filter((c: string) => c.length > 0);
    return cells.join(' | ');
  });

  // 9. 处理引用块 > text -> text
  text = text.replace(/^(\s*)>\s?/gm, '$1');

  // 10. 去除行尾多余空白，收缩多余空行 (至多保留连续两换行)
  text = text.replace(/[ \t]+$/gm, '');
  text = text.replace(/\n{3,}/g, '\n\n');

  return text.trim();
}
