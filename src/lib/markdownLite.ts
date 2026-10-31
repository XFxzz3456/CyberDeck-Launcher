/**
 * 极简 Markdown 解析：只认协议正文用到的几种块。
 *
 * 为什么不用 react-markdown：EULA 只有标题、段落和少量加粗，
 * 为它拉一个完整 AST 渲染器（外加 mdast 一串依赖）不划算，
 * 而离线安装依赖在这个项目上是已知的麻烦事。
 *
 * 认得的语法：`#`/`##`/`###` 标题、`-` 列表项、空行分段、行内 `**加粗**`。
 * 认不出的行一律当段落输出，不会吞掉内容——这对法务文本比"渲染好看"重要。
 */

export type MdBlockKind = "h1" | "h2" | "h3" | "li" | "p";

export interface MdBlock {
  kind: MdBlockKind;
  text: string;
}

export function parseMarkdownLite(source: string): MdBlock[] {
  const blocks: MdBlock[] = [];
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("### ")) {
      blocks.push({ kind: "h3", text: line.slice(4).trim() });
    } else if (line.startsWith("## ")) {
      blocks.push({ kind: "h2", text: line.slice(3).trim() });
    } else if (line.startsWith("# ")) {
      blocks.push({ kind: "h1", text: line.slice(2).trim() });
    } else if (line.startsWith("- ")) {
      blocks.push({ kind: "li", text: line.slice(2).trim() });
    } else {
      blocks.push({ kind: "p", text: line });
    }
  }
  return blocks;
}

/** 把一行里的 `**粗体**` 切成 [文本, 是否加粗] 片段。没有标记时返回单段。 */
export function splitInlineBold(text: string): Array<{ text: string; bold: boolean }> {
  const parts: Array<{ text: string; bold: boolean }> = [];
  const pattern = /\*\*(.+?)\*\*/g;
  let cursor = 0;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    if (match.index > cursor) {
      parts.push({ text: text.slice(cursor, match.index), bold: false });
    }
    parts.push({ text: match[1], bold: true });
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor), bold: false });
  return parts;
}
