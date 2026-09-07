/**
 * dsh-napcat-bridge: 出站文本渲染模块
 * 实现 Markdown 语法剥离与 NapCat 纯文本排版转换。
 */

/**
 * 判断字符串是否"确凿地"像一个 URL（用于链接剥离前甄别，避免误伤字面文本）。
 * 识别：scheme://、scheme: 协议、www. 前缀、以及带顶级域的域名（可含端口/路径）。
 */
function looksLikeUrl(value: string): boolean {
  return (
    /^(?:[a-z][a-z0-9+.-]*:\/\/|www\.)[^\s)]*$/i.test(value) ||
    /^[a-z][a-z0-9+.-]*:[^\s)]*$/i.test(value) ||
    /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?::\d+)?(?:\/[^\s)]*)?$/i.test(
      value
    )
  );
}

/**
 * 剥离 Markdown 格式符号，转换为适合 QQ 客户端阅读的整洁纯文本排版。
 * 遵循规格 §7.2：
 * 1. 标题: #+ Title -> 【Title】
 * 2. 粗体/斜体/下划线: **text** / *text* / __text__ / _text_ -> text
 * 3. 行内代码与代码块: `code` -> code, 移除 ```lang
 * 4. 超链接: [title](url) -> title (url)
 * 5. 表格: 移除 |---| 分隔线，归一化单元格
 * 6. 引用与分割线等语法符号剥离
 *
 * 误伤防护（宁可少剥不可误伤）：
 * - 斜体/粗体的 `*`/`_` 强调符号两侧须紧贴非空白、非数字文字（`3 * 4`、`2 * 3` 不受影响）；
 * - `*`/`_` 不在单词/标识符内部开强调（`a_b_c`、`read_memory`、`foo_bar_baz` 不受影响）；
 * - `#` 仅当行首且后跟空白才算标题（`C#` 不受影响）；
 * - `[text](url)` 仅当 url 确凿为 URL 才展开（字面 `[标题](url)` 文本不受影响）；
 * - 无闭合的孤立符号（如列表项 `* foo`、`*单独行`）原样保留。
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

  // 3. 处理标题 #+ Title -> 【Title】；仅行首且 # 后紧跟空白，避免误伤 C#/#tag
  text = text.replace(/^(\s*)#{1,6}[ \t]+(.+?)(?:\s+#+)?$/gm, '$1【$2】');

  // 4. 处理图片链接 ![alt](url) -> [图片: url]
  text = text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '[图片: $2]');

  // 5. 处理超链接 [text](url) -> text (url)
  // 仅当目标确凿为 URL 才展开，字面 [标题](url) 文本原样保留
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (whole, label, url) => {
    return looksLikeUrl(url) ? `${label} (${url})` : whole;
  });

  // 6. 处理粗体与斜体（两侧约束：非空白、非数字、不跨单词字符，宁可少剥不可误伤）
  // 粗斜体 ***text*** 或 ___text___
  text = text.replace(/(?<!\w)\*\*\*(?![\s\d])([^*\n]+?)(?<![\s\d])\*\*\*(?!\w)/g, '$1');
  text = text.replace(/(?<!\w)___(?!\s)([^_\n]+?)(?<!\s)___(?!\w)/g, '$1');
  // 粗体 **text** 或 __text__
  text = text.replace(/(?<!\w)\*\*(?![\s\d])([^*\n]+?)(?<![\s\d])\*\*(?!\w)/g, '$1');
  text = text.replace(/(?<!\w)__(?!\s)([^_\n]+?)(?<!\s)__(?!\w)/g, '$1');
  // 斜体 *text*
  text = text.replace(/(?<!\w)\*(?![\s\d])([^*\n]+?)(?<![\s\d])\*(?!\w)/g, '$1');
  // 斜体 _text_
  text = text.replace(/(?<!\w)_(?!\s)([^_\n]+?)(?<!\s)_(?!\w)/g, '$1');

  // 7. 处理删除线 ~~text~~ -> text（两侧约束：非空白）
  text = text.replace(/(?<!\s)~~(?!\s)([^~\n]+?)(?<!\s)~~(?!\s)/g, '$1');

  // 8. 处理表格（仅用 [ \t]，避免 \s 吞换行造成表格行粘连）
  // 移除表格表头分隔线 |---|---| 或 |:---|---:|
  text = text.replace(/^[ \t]*\|?([ \t]*:?-+:?[ \t]*\|)+[ \t]*(:?-+:?[ \t]*)?\|?[ \t]*$/gm, '');

  // 格式化普通表格数据行 | a | b | -> a | b
  text = text.replace(/^[ \t]*\|[ \t]*(.*?)[ \t]*\|[ \t]*$/gm, (_match, rowContent) => {
    const cells = rowContent
      .split('|')
      .map((c: string) => c.trim())
      .filter((c: string) => c.length > 0);
    return cells.join(' | ');
  });

  // 9. 处理引用块 > text -> text（仅当 > 后紧跟空格/Tab，避免误伤行首比较式）
  text = text.replace(/^(\s*)>[ \t]/gm, '$1');

  // 10. 去除行尾多余空白，收缩多余空行 (至多保留连续两换行)
  text = text.replace(/[ \t]+$/gm, '');
  text = text.replace(/\n{3,}/g, '\n\n');

  return text.trim();
}
