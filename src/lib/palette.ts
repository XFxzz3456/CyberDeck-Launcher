import { contrastRatio, mix, relativeLuminance, rgb, toHex } from "./preferences";
import { getResolvedMode, setPaletteRefresher } from "./theme";

/**
 * 自定义调色板：在「视觉风格」之上再叠一层玩家自选颜色。
 *
 * 为什么单独成层、而不是再复制一套主题预设：赛博风的切角与发光、现代风的
 * 纯色圆角都是 CSS 里 `[data-style]` 选择器写死的**结构特征**，玩家要改的只是
 * **色值**。所以这里只往 documentElement 写内联 CSS 变量 —— 内联优先级高于
 * 任何选择器，主题切换不会被覆盖；清空覆盖就一字不差地回到主题原色。
 *
 * 变量按语义收敛成三档，不把 20 个变量甩给玩家：
 *   background → --bg / --bg-2 / --bg-rgb
 *   surface    → --panel / --panel-2 / --panel-3（面板与卡片）
 *   text       → --text / --text-2 / --text-3 / --muted / --muted-2
 * 边框与次要文字由这三个颜色按比例派生，避免「卡片换了色、边框还是原来的灰」
 * 那种拼接感；次要文字再按 4.5:1 兜底，防止自定义底色把说明文字压成背景。
 */

export const PALETTE_STORAGE_KEY = "ncl.ui.palette.v1";

export type PaletteSlot = "background" | "surface" | "text";

export interface PaletteOverrides {
  /** 页面底色（`--bg`）。null = 跟随当前主题。 */
  background: string | null;
  /** 卡片 / 面板底色（`--panel-2`）。 */
  surface: string | null;
  /** 主文字色（`--text`）。 */
  text: string | null;
}

export const EMPTY_PALETTE: PaletteOverrides = {
  background: null,
  surface: null,
  text: null,
};

export const PALETTE_SLOTS: PaletteSlot[] = ["background", "surface", "text"];

const HEX_RE = /^#[0-9a-f]{6}$/i;

/** 覆盖时写过的全部变量，清空时按这张表逐项 removeProperty。 */
const PALETTE_PROPS = [
  "--bg",
  "--bg-rgb",
  "--bg-2",
  "--panel",
  "--panel-2",
  "--panel-3",
  "--text",
  "--text-2",
  "--text-3",
  "--muted",
  "--muted-2",
  "--line",
  "--line-soft",
  "--line-hot",
] as const;

/** 对比度低于这个值就提醒：正文 4.5:1 是 AA，但低到 3.0 以下已经明显读不动。 */
export const LOW_CONTRAST_THRESHOLD = 3;

function sanitize(value: unknown): string | null {
  return typeof value === "string" && HEX_RE.test(value) ? value.toLowerCase() : null;
}

export function loadPalette(): PaletteOverrides {
  if (typeof window === "undefined") return { ...EMPTY_PALETTE };
  try {
    const raw = window.localStorage.getItem(PALETTE_STORAGE_KEY);
    if (!raw) return { ...EMPTY_PALETTE };
    const parsed = JSON.parse(raw) as Partial<Record<PaletteSlot, unknown>>;
    return {
      background: sanitize(parsed.background),
      surface: sanitize(parsed.surface),
      text: sanitize(parsed.text),
    };
  } catch {
    return { ...EMPTY_PALETTE };
  }
}

export function savePalette(overrides: PaletteOverrides): void {
  if (typeof window === "undefined") return;
  try {
    if (!overrides.background && !overrides.surface && !overrides.text) {
      window.localStorage.removeItem(PALETTE_STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(PALETTE_STORAGE_KEY, JSON.stringify(overrides));
  } catch {
    // webview 拒绝写盘时仅本次会话生效，与其它 UI 偏好同一策略。
  }
}

export function hasOverrides(overrides: PaletteOverrides): boolean {
  return Boolean(overrides.background || overrides.surface || overrides.text);
}

/** 解析计算样式里的颜色：`#rgb` / `#rrggbb` / `rgb()` / `rgba()` 都认。 */
function parseColor(input: string): [number, number, number] | null {
  const value = input.trim();
  if (!value) return null;
  if (value.startsWith("#")) {
    const hex = value.slice(1);
    if (hex.length === 3) {
      const expanded = hex
        .split("")
        .map((char) => char + char)
        .join("");
      return rgb(`#${expanded}`);
    }
    return HEX_RE.test(`#${hex}`) ? rgb(`#${hex}`) : null;
  }
  const match = /rgba?\(([^)]+)\)/i.exec(value);
  if (!match) return null;
  const parts = match[1]
    .split(/[,\s/]+/)
    .map((part) => Number.parseFloat(part))
    .filter((part) => Number.isFinite(part));
  if (parts.length < 3) return null;
  return [parts[0], parts[1], parts[2]];
}

interface BaseColors {
  bg: string;
  surface: string;
  text: string;
}

/** 清掉覆盖后读主题真实颜色；读不到（首帧 / 变量未定义）按明暗兜底。 */
function readBase(): BaseColors {
  const fallback =
    typeof window !== "undefined" && getResolvedMode() === "light"
      ? { bg: "#ffffff", surface: "#ffffff", text: "#111827" }
      : { bg: "#07090c", surface: "#14161b", text: "#e8e8ea" };
  if (typeof document === "undefined") return fallback;
  const style = window.getComputedStyle(document.documentElement);
  const pick = (property: string, backup: string) => {
    const parsed = parseColor(style.getPropertyValue(property));
    return parsed ? toHex(parsed) : backup;
  };
  return {
    bg: pick("--bg", fallback.bg),
    surface: pick("--panel-2", fallback.surface),
    text: pick("--text", fallback.text),
  };
}

/** 读当前生效的 CSS 颜色（`#rrggbb`）。给设置页显示「跟随主题」时的实际色值用。 */
export function readCssColor(property: string, fallback: string): string {
  if (typeof document === "undefined") return fallback;
  const parsed = parseColor(
    window.getComputedStyle(document.documentElement).getPropertyValue(property),
  );
  return parsed ? toHex(parsed) : fallback;
}

/** 朝背景的反方向逐档混合，直到与背景的对比度达标（保住色相、只调明度）。 */
function ensureReadable(hex: string, background: string, target: number): string {
  const towards = relativeLuminance(background) > 0.35 ? "#000000" : "#ffffff";
  let current = hex;
  for (let step = 1; step <= 20; step += 1) {
    if (contrastRatio(current, background) >= target) return current;
    current = mix(hex, towards, Math.min(1, step * 0.06));
  }
  return towards;
}

let active: PaletteOverrides = { ...EMPTY_PALETTE };

/**
 * 应用覆盖：先清掉上一次写的内联变量，再读主题原色，最后写本次的配色。
 *
 * 「先清后读」是必须的：如果直接 getComputedStyle，读到的是上一次自己的
 * 内联值，玩家把「背景色」改回「跟随主题」时会拿到旧值而不是主题色。
 */
export function applyPalette(overrides: PaletteOverrides): void {
  active = { ...overrides };
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  for (const property of PALETTE_PROPS) root.style.removeProperty(property);
  if (!hasOverrides(overrides)) return;

  const base = readBase();
  const bg = overrides.background ?? base.bg;
  const surface = overrides.surface ?? base.surface;
  const text = overrides.text ?? base.text;
  const light = relativeLuminance(bg) > 0.45;

  root.style.setProperty("--bg", bg);
  root.style.setProperty("--bg-rgb", rgb(bg).join(", "));
  // 次层背景：深色底更亮一点、浅色底更灰一点，侧栏与主区才有层次。
  root.style.setProperty("--bg-2", mix(bg, text, light ? 0.045 : 0.06));

  root.style.setProperty("--panel-2", surface);
  root.style.setProperty("--panel", mix(surface, bg, 0.45));
  root.style.setProperty("--panel-3", mix(surface, text, 0.08));

  root.style.setProperty("--text", text);
  root.style.setProperty("--text-2", mix(text, bg, 0.18));
  root.style.setProperty("--text-3", mix(text, bg, 0.34));
  // 次要文字按 4.5:1 兜底：自定义底色最容易踩的坑就是灰字糊在浅底上。
  root.style.setProperty("--muted", ensureReadable(mix(text, bg, 0.42), bg, 4.5));
  root.style.setProperty("--muted-2", ensureReadable(mix(text, bg, 0.5), bg, 4.5));

  root.style.setProperty("--line", mix(bg, text, 0.22));
  root.style.setProperty("--line-soft", mix(bg, text, 0.12));
  root.style.setProperty("--line-hot", mix(bg, text, 0.38));
}

/** 主题 / 明暗切换后重算（派生色依赖新的主题原色）。 */
export function refreshPalette(): void {
  applyPalette(active);
}

/** 主题切换时由 theme.ts 回调，避免 palette ←→ theme 的循环 import。 */
setPaletteRefresher(refreshPalette);

export interface ContrastReport {
  /** 最小对比度（1–21）。 */
  ratio: number;
  /** 是否低到影响阅读。 */
  low: boolean;
  /** 最低的那条是谁对谁（`text-on-background` / `text-on-surface`）。 */
  worst: "background" | "surface" | null;
}

/** 读当前**已生效**的配色算对比度（在 applyPalette 之后调用）。 */
export function readAppliedContrast(): ContrastReport {
  if (typeof document === "undefined") return { ratio: 21, low: false, worst: null };
  const style = window.getComputedStyle(document.documentElement);
  const bg = parseColor(style.getPropertyValue("--bg"));
  const surface = parseColor(style.getPropertyValue("--panel-2"));
  const text = parseColor(style.getPropertyValue("--text"));
  if (!bg || !surface || !text) return { ratio: 21, low: false, worst: null };

  const textHex = toHex(text);
  const onBg = contrastRatio(textHex, toHex(bg));
  const onSurface = contrastRatio(textHex, toHex(surface));
  const ratio = Math.min(onBg, onSurface);
  return {
    ratio,
    low: ratio < LOW_CONTRAST_THRESHOLD,
    worst: onBg <= onSurface ? "background" : "surface",
  };
}
