/**
 * 全局字体与代码/日志字体（T8 任务·字体设置，2026-10-30 补做；2026-10-31 扩充）。
 *
 * 设计取舍：
 * 1. **不打包字体文件**（用户 2026-10-31 拍板选「纯字体栈」）。思源黑体 / 霞鹜文楷
 *    这类中文字体动辄几十 MB，塞进安装包会让 exe 体积翻倍，而真正在意字体的用户
 *    本机基本都装了。这里只写字体栈，用户没装就自然回退到栈里的下一个（预览框会
 *    立刻暴露差异，不会「选了没反应还以为坏了」）。
 * 2. **只覆盖 CSS 变量，不改样式表**。主题块里 --font / --sans / --display /
 *    --mono 各定义一次，内联样式写在 <html> 上优先级更高，切主题时不会被打回去。
 * 3. `null` 表示「跟随主题」——把内联属性移除，让主题自己的字体栈生效。
 * 4. `custom` 是「用户自己输入系统字体名」：配合 preferences 里的 customUiFont /
 *    customCodeFont 一起用，栈 = `"用户字体", 同类回退链`。
 */

export type UiFontId =
  | "system"
  | "sourceHan"
  | "jetbrainsMono"
  | "inter"
  | "roboto"
  | "lxgw"
  | "yahei"
  | "pingfang"
  | "custom";

export type CodeFontId =
  | "theme"
  | "jetbrainsMono"
  | "consolas"
  | "firaCode"
  | "sourceCodePro"
  | "custom";

export interface FontOption<T extends string> {
  id: T;
  /** i18n 词条 key（下拉项标题）。 */
  labelKey: string;
  /** 覆盖给 --font/--sans/--display 或 --mono/--font-mono 的值；null = 跟随主题。 */
  stack: string | null;
  /** 预览框里用来渲染示例文本的 font-family（null 时用主题默认）。 */
  preview: string;
}

/** 自定义字体的同类回退链：用户输入的字体没装时，落到这些常见字体上。 */
const UI_FALLBACK =
  '"Inter", "Source Han Sans SC", "Noto Sans SC", "Microsoft YaHei UI", "Microsoft YaHei", sans-serif';
const CODE_FALLBACK =
  '"JetBrains Mono", "Cascadia Mono", "Cascadia Code", Consolas, monospace';

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
  {
    id: "inter",
    labelKey: "appearance.fontInter",
    stack: '"Inter", "Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", sans-serif',
    preview: '"Inter", "Segoe UI", sans-serif',
  },
  {
    id: "roboto",
    labelKey: "appearance.fontRoboto",
    stack: '"Roboto", "Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", sans-serif',
    preview: '"Roboto", "Segoe UI", sans-serif',
  },
  {
    id: "lxgw",
    labelKey: "appearance.fontLxgw",
    stack:
      '"LXGW WenKai", "LXGW WenKai Screen", "Kaiti SC", "STKaiti", "Microsoft YaHei UI", serif',
    preview: '"LXGW WenKai", "Kaiti SC", serif',
  },
  {
    id: "yahei",
    labelKey: "appearance.fontYahei",
    stack: '"Microsoft YaHei UI", "Microsoft YaHei", "Segoe UI", sans-serif',
    preview: '"Microsoft YaHei UI", "Microsoft YaHei", sans-serif',
  },
  {
    id: "pingfang",
    labelKey: "appearance.fontPingfang",
    stack: '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei UI", sans-serif',
    preview: '"PingFang SC", "Hiragino Sans GB", sans-serif',
  },
  {
    id: "custom",
    labelKey: "appearance.fontCustomOption",
    stack: null,
    preview: "",
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
  {
    id: "firaCode",
    labelKey: "appearance.fontFiraCode",
    stack:
      '"Fira Code", "Cascadia Code", "JetBrains Mono", Consolas, ui-monospace, monospace',
    preview: '"Fira Code", "Cascadia Code", monospace',
  },
  {
    id: "sourceCodePro",
    labelKey: "appearance.fontSourceCodePro",
    stack:
      '"Source Code Pro", "JetBrains Mono", "Cascadia Mono", Consolas, ui-monospace, monospace',
    preview: '"Source Code Pro", "Cascadia Mono", monospace',
  },
  {
    id: "custom",
    labelKey: "appearance.fontCustomOption",
    stack: null,
    preview: "",
  },
];

const UI_PROPERTIES = ["--font", "--sans", "--display"] as const;
// --mono 是样式表里真正被引用的那个；--font-mono 是 2026-10 之后新增段落用的别名，
// 两处都写，避免「日志页没跟着变」这种半生效状态。
const CODE_PROPERTIES = ["--mono", "--font-mono"] as const;

/** 去掉用户输入里的引号，拼成 `"名字", 回退链`；空名返回 null（= 不覆盖）。 */
function customStack(name: string, fallback: string): string | null {
  const cleaned = name.trim().replace(/["']/g, "");
  return cleaned ? `"${cleaned}", ${fallback}` : null;
}

function uiStackOf(id: UiFontId): string | null {
  return UI_FONTS.find((item) => item.id === id)?.stack ?? null;
}

function codeStackOf(id: CodeFontId): string | null {
  return CODE_FONTS.find((item) => item.id === id)?.stack ?? null;
}

/**
 * 把字体选择写到 <html> 的内联样式上。传 null / 未知 id 视为「跟随主题」，
 * 会移除内联覆盖（而不是写一个错值把主题字体顶掉）。
 * `customUi` / `customCode` 只在对应 id === "custom" 时参与。
 */
export function applyFonts(
  ui: UiFontId,
  code: CodeFontId,
  customUi = "",
  customCode = "",
) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const uiStack =
    ui === "custom" ? customStack(customUi, UI_FALLBACK) : uiStackOf(ui);
  for (const property of UI_PROPERTIES) {
    if (uiStack) root.style.setProperty(property, uiStack);
    else root.style.removeProperty(property);
  }
  const codeStack =
    code === "custom" ? customStack(customCode, CODE_FALLBACK) : codeStackOf(code);
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

export function uiFontPreview(id: UiFontId, custom = ""): string {
  if (id === "custom") {
    const cleaned = custom.trim().replace(/["']/g, "");
    return cleaned ? `"${cleaned}", ${UI_FALLBACK}` : "";
  }
  return UI_FONTS.find((item) => item.id === id)?.preview ?? "";
}

export function codeFontPreview(id: CodeFontId, custom = ""): string {
  if (id === "custom") {
    const cleaned = custom.trim().replace(/["']/g, "");
    return cleaned ? `"${cleaned}", ${CODE_FALLBACK}` : "";
  }
  return CODE_FONTS.find((item) => item.id === id)?.preview ?? "";
}
