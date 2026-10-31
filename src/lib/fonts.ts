/**
 * 全局字体与代码/日志字体（T8 任务·字体设置，2026-10-30 补做）。
 *
 * 设计取舍：
 * 1. **不打包字体文件**。思源黑体 / JetBrains Mono 都是几十 MB，塞进安装包会让
 *    exe 体积翻倍，而真正在意字体的用户本机基本都装了。这里只写字体栈，用户没装
 *    就自然回退到栈里的下一个（预览框会立刻暴露差异，不会「选了没反应还以为坏了」）。
 * 2. **只覆盖 CSS 变量，不改样式表**。主题块里 --font / --sans / --display /
 *    --mono 各定义一次，内联样式写在 <html> 上优先级更高，切主题时不会被打回去。
 * 3. `null` 表示「跟随主题」——把内联属性移除，让主题自己的字体栈生效。
 */

export type UiFontId = "system" | "sourceHan" | "jetbrainsMono";
export type CodeFontId = "theme" | "jetbrainsMono" | "consolas";

export interface FontOption<T extends string> {
  id: T;
  /** i18n 词条 key（下拉项标题）。 */
  labelKey: string;
  /** 覆盖给 --font/--sans/--display 或 --mono/--font-mono 的值；null = 跟随主题。 */
  stack: string | null;
  /** 预览框里用来渲染示例文本的 font-family（null 时用主题默认）。 */
  preview: string;
}

export const UI_FONTS: FontOption<UiFontId>[] = [
  {
    id: "system",
    labelKey: "appearance.fontSystem",
    stack: null,
    preview: "",
  },
  {
    id: "sourceHan",
    labelKey: "appearance.fontSourceHan",
    stack:
      '"Source Han Sans SC", "Noto Sans SC", "Source Han Sans CN", "Microsoft YaHei UI", "Microsoft YaHei", sans-serif',
    preview:
      '"Source Han Sans SC", "Noto Sans SC", "Microsoft YaHei UI", "Microsoft YaHei", sans-serif',
  },
  {
    id: "jetbrainsMono",
    labelKey: "appearance.fontJetBrains",
    stack:
      '"JetBrains Mono", "Cascadia Mono", "Cascadia Code", Consolas, "Microsoft YaHei UI", monospace',
    preview: '"JetBrains Mono", "Cascadia Mono", Consolas, monospace',
  },
];

export const CODE_FONTS: FontOption<CodeFontId>[] = [
  {
    id: "theme",
    labelKey: "appearance.codeFontTheme",
    stack: null,
    preview: "",
  },
  {
    id: "jetbrainsMono",
    labelKey: "appearance.fontJetBrains",
    stack: '"JetBrains Mono", "Cascadia Mono", "Cascadia Code", Consolas, monospace',
    preview: '"JetBrains Mono", "Cascadia Mono", Consolas, monospace',
  },
  {
    id: "consolas",
    labelKey: "appearance.codeFontConsolas",
    stack: 'Consolas, "Cascadia Mono", ui-monospace, monospace',
    preview: 'Consolas, "Cascadia Mono", monospace',
  },
];

const UI_PROPERTIES = ["--font", "--sans", "--display"] as const;
// --mono 是样式表里真正被引用的那个；--font-mono 是 2026-10 之后新增段落用的别名，
// 两处都写，避免「日志页没跟着变」这种半生效状态。
const CODE_PROPERTIES = ["--mono", "--font-mono"] as const;

function uiStackOf(id: UiFontId): string | null {
  return UI_FONTS.find((item) => item.id === id)?.stack ?? null;
}

function codeStackOf(id: CodeFontId): string | null {
  return CODE_FONTS.find((item) => item.id === id)?.stack ?? null;
}

/**
 * 把字体选择写到 <html> 的内联样式上。传 null / 未知 id 视为「跟随主题」，
 * 会移除内联覆盖（而不是写一个错值把主题字体顶掉）。
 */
export function applyFonts(ui: UiFontId, code: CodeFontId) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const uiStack = uiStackOf(ui);
  for (const property of UI_PROPERTIES) {
    if (uiStack) root.style.setProperty(property, uiStack);
    else root.style.removeProperty(property);
  }
  const codeStack = codeStackOf(code);
  for (const property of CODE_PROPERTIES) {
    if (codeStack) root.style.setProperty(property, codeStack);
    else root.style.removeProperty(property);
  }
}

export function isUiFont(id: unknown): id is UiFontId {
  return UI_FONTS.some((item) => item.id === id);
}

export function isCodeFont(id: unknown): id is CodeFontId {
  return CODE_FONTS.some((item) => item.id === id);
}

export function uiFontPreview(id: UiFontId): string {
  return UI_FONTS.find((item) => item.id === id)?.preview ?? "";
}

export function codeFontPreview(id: CodeFontId): string {
  return CODE_FONTS.find((item) => item.id === id)?.preview ?? "";
}
