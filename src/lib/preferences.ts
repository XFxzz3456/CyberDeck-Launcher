import { useEffect, useLayoutEffect, useMemo, useState, useSyncExternalStore } from "react";
import {
  applyFonts,
  isCodeFont,
  isUiFont,
  type CodeFontId,
  type UiFontId,
} from "./fonts";
import {
  getCurrentStyleTheme,
  getResolvedMode,
  setStyleTheme as applyStyleTheme,
  useTheme,
  type StyleTheme,
} from "./theme";

/** 外观风格 id。旧名字保留给现有调用方。 */
export type ThemeId = StyleTheme;

export interface Preferences {
  /** 当前视觉风格。与 theme.ts 的 store 同源，这里只是镜像一份。 */
  theme: ThemeId;
  /** True only when the user picked an accent that is not the theme default. */
  useCustomAccent: boolean;
  accent: string;
  /** UI 缩放，0.8–1.5（r20 从三档扩成连续档，落盘前钳制）。 */
  scale: number;
  sidebarCollapsed: boolean;
  /** 界面动效总开关（framer-motion 与 CSS 过渡共用）。false = 一切瞬移。 */
  animations: boolean;
  /**
   * 动画速度百分比（0–150，默认 100）。
   *
   * 语义按「时长倍率」而不是「速度倍率」：150 = 动画时长 ×1.5（更慢、余韵更长），
   * 50 = ×0.5（更快），**0 = 完全关闭动画**（等同于 animations=false）。
   * 用户把滑块拖到 0 时，`applyPreferences` 会把 data-motion 一并写 off，
   * 这样 framer 的 layoutId 与 CSS 过渡会同时退位，不会出现"半关"状态。
   */
  motionSpeed: number;
  /** 启动时的首帧 splash（≤800ms，可跳过）。false = 直接进主界面。 */
  splash: boolean;
  /** 模组库显示方式：卡片网格 / 紧凑列表（bf7889 反馈新增，落盘记住）。 */
  libraryView: LibraryView;
  /** 全局界面字体（T8 字体设置）：跟随系统 / 思源黑体 / JetBrains Mono。 */
  uiFont: UiFontId;
  /** 代码与日志字体（T8 字体设置），默认跟随主题等宽。 */
  codeFont: CodeFontId;
  /** uiFont === "custom" 时用户输入的系统字体名（空 = 跟随主题）。 */
  customUiFont: string;
  /** codeFont === "custom" 时用户输入的系统字体名（空 = 跟随主题）。 */
  customCodeFont: string;
}

/** 模组库的两种显示方式。 */
export type LibraryView = "grid" | "list";

export const PREFERENCES_KEY = "ncl.ui.preferences.v1";

export const DEFAULT_PREFERENCES: Preferences = {
  theme: "ncpd",
  useCustomAccent: false,
  accent: "#fcee0a",
  scale: 1,
  sidebarCollapsed: false,
  animations: true,
  motionSpeed: 100,
  splash: true,
  libraryView: "grid",
  uiFont: "system",
  codeFont: "theme",
  customUiFont: "",
  customCodeFont: "",
};

const HEX_RE = /^#[0-9a-f]{6}$/i;

/**
 * 缩放钳制：0.8–1.5（80%–150%）。
 *
 * 2026-10-31 起不再按 5% 取整：界面缩放从滑块改成「固定档位 + 自定义输入」，
 * 自定义允许 80–150 之间任意整数百分比（如 113%），取整会把用户输入悄悄改掉。
 */
function clampScale(value: unknown): number {
  const numeric = typeof value === "number" && Number.isFinite(value) ? value : 1;
  return Math.min(1.5, Math.max(0.8, numeric));
}

/**
 * 动画速度钳制：0–150 的整数百分比。
 *
 * 缺省按 100 处理（老配置里没有这个字段，升级后手感不该突变）。
 * 不按步长取整：滑块步长由 UI 定义，存储层只保证范围合法。
 */
export function clampMotionSpeed(value: unknown): number {
  const numeric = typeof value === "number" && Number.isFinite(value) ? value : 100;
  return Math.min(150, Math.max(0, Math.round(numeric)));
}

/**
 * v1 只负责外观偏好（强调色 / 缩放 / 侧边栏）。视觉风格与明暗模式由
 * theme.ts 的 ncl.ui.theme.v2 负责；v1 里的 theme 字段仅作为迁移来源保留。
 */
interface StoredPreferences {
  theme: ThemeId;
  useCustomAccent: boolean;
  accent: string;
  scale: number;
  sidebarCollapsed: boolean;
  animations: boolean;
  motionSpeed: number;
  splash: boolean;
  libraryView: LibraryView;
  uiFont: UiFontId;
  codeFont: CodeFontId;
  customUiFont: string;
  customCodeFont: string;
}

function loadStored(): StoredPreferences {
  try {
    const raw = window.localStorage.getItem(PREFERENCES_KEY);
    if (!raw) return { ...DEFAULT_PREFERENCES };
    const value = JSON.parse(raw) as Partial<StoredPreferences>;
    return {
      // 视觉风格以 theme.ts 的 store 为准，这里只保留旧字段做迁移兜底。
      theme: getCurrentStyleTheme(),
      useCustomAccent: value.useCustomAccent === true,
      accent:
        typeof value.accent === "string" && HEX_RE.test(value.accent)
          ? value.accent
          : DEFAULT_PREFERENCES.accent,
      scale: clampScale(value.scale),
      sidebarCollapsed: value.sidebarCollapsed === true,
      // 缺省视为开：老用户升级后不该发现界面变「僵」了。
      animations: value.animations !== false,
      // 老配置里没有：按 100%（原始手感）兜底。
      motionSpeed: clampMotionSpeed(value.motionSpeed),
      // 缺省视为开：首帧 splash 是 0.9.0 的新默认观感，但老配置里没有这个字段。
      splash: value.splash !== false,
      // 老配置里没有这个字段：默认卡片视图，和升级前看到的界面一致。
      libraryView: value.libraryView === "list" ? "list" : "grid",
      // 字体：老配置没有该字段，一律「跟随主题」，升级后界面字体不该突变。
      uiFont: isUiFont(value.uiFont) ? value.uiFont : "system",
      codeFont: isCodeFont(value.codeFont) ? value.codeFont : "theme",
      customUiFont: typeof value.customUiFont === "string" ? value.customUiFont : "",
      customCodeFont:
        typeof value.customCodeFont === "string" ? value.customCodeFont : "",
    };
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
}

export function loadPreferences(): Preferences {
  return { ...loadStored() };
}

export function savePreferences(preferences: Preferences) {
  try {
    window.localStorage.setItem(PREFERENCES_KEY, JSON.stringify(preferences));
  } catch {
    // A locked-down webview can reject localStorage; the UI still works for this session.
  }
}

function rgb(hex: string): [number, number, number] {
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
}

function toHex(values: [number, number, number]): string {
  return `#${values
    .map((value) => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, "0"))
    .join("")}`;
}

function mix(hex: string, target: string, amount: number): string {
  const from = rgb(hex);
  const to = rgb(target);
  return toHex([
    from[0] + (to[0] - from[0]) * amount,
    from[1] + (to[1] - from[1]) * amount,
    from[2] + (to[2] - from[2]) * amount,
  ]);
}

/** WCAG relative luminance is enough here: pick black or white text for the accent button. */
function contrastInk(hex: string): string {
  const luminance = relativeLuminance(hex);
  return luminance > 0.46 ? "#08090b" : "#ffffff";
}

/** WCAG 2.x 相对亮度（sRGB 线性化后加权）。 */
function relativeLuminance(hex: string): number {
  const [r, g, b] = rgb(hex).map((value) => {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.x 对比度（1 = 完全相同，21 = 纯黑对纯白）。 */
function contrastRatio(a: string, b: string): number {
  const first = relativeLuminance(a);
  const second = relativeLuminance(b);
  const lighter = Math.max(first, second);
  const darker = Math.min(first, second);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * 把颜色朝黑（浅底）或朝白（深底）逐档混合，直到与背景的对比度达标。
 *
 * 为什么需要它：玩家可以自选强调色，`#fcee0a` 这种亮黄在深色主题里是品牌色，
 * 搬到白底上就是「亮黄字配白底」，对比度只有 1.2:1，等于看不见。强调色当填充
 * （按钮底、进度条）时不需要动，但**当文字色时必须压深**。这里算出一档安全的
 * 同色相颜色写进 `--accent-text`，`--accent` 本身保持玩家选的原色。
 */
function ensureContrastOn(hex: string, background: string, target: number): string {
  const towards = relativeLuminance(background) > 0.35 ? "#000000" : "#ffffff";
  let current = hex;
  // 20 档、每档 6%，足以从纯白走到纯黑，同时尽量保住色相。
  for (let step = 1; step <= 20; step += 1) {
    if (contrastRatio(current, background) >= target) return current;
    current = mix(hex, towards, Math.min(1, step * 0.06));
  }
  return towards;
}

/** 当前页面的实际底色：优先读计算样式里的 --bg，读不到就按明暗兜底。 */
function resolvePageBackground(): string {
  const mode = getResolvedMode();
  const fallback = mode === "light" ? "#ffffff" : "#07090c";
  if (typeof window === "undefined") return fallback;
  const value = window
    .getComputedStyle(document.documentElement)
    .getPropertyValue("--bg")
    .trim();
  return HEX_RE.test(value) ? value : fallback;
}

function applyCustomAccent(hex: string) {
  const root = document.documentElement;
  const [r, g, b] = rgb(hex);
  const ink = contrastInk(hex);
  const inkRgb = rgb(ink).join(", ");
  const light = getResolvedMode() === "light";
  // 浅色底上的强调色要往深里压，深色底上往浅里提，否则 --accent-soft 会看不清。
  const towards = light ? "#000000" : "#ffffff";
  // 文字目标：浅色底 AAA（7:1），深色底 AA（4.5:1）。深色底追 7:1 会把品牌色
  // 冲成近乎纯白，反而丢识别度；浅色底的白字场景没这个问题。
  const textTarget = light ? 7 : 4.5;
  const textAccent = ensureContrastOn(hex, resolvePageBackground(), textTarget);
  root.style.setProperty("--accent", hex);
  root.style.setProperty("--accent-rgb", `${r}, ${g}, ${b}`);
  root.style.setProperty("--accent-soft", mix(hex, towards, light ? 0.42 : 0.28));
  root.style.setProperty("--accent-hover", mix(hex, towards, 0.18));
  root.style.setProperty("--accent-ink", ink);
  root.style.setProperty("--accent-ink-rgb", inkRgb);
  root.style.setProperty("--accent-text", textAccent);
  root.style.setProperty("--accent-text-rgb", rgb(textAccent).join(", "));
  root.style.setProperty(
    "--accent-text-hover",
    mix(textAccent, light ? "#000000" : "#ffffff", 0.25),
  );
}

function clearCustomAccent() {
  const root = document.documentElement;
  for (const property of [
    "--accent",
    "--accent-rgb",
    "--accent-soft",
    "--accent-hover",
    "--accent-ink",
    "--accent-ink-rgb",
    "--accent-text",
    "--accent-text-rgb",
    "--accent-text-hover",
  ]) {
    root.style.removeProperty(property);
  }
}

export function applyPreferences(preferences: Preferences) {
  const root = document.documentElement;
  root.style.setProperty("--ui-scale", String(preferences.scale));
  // 字体覆盖写在内联样式上（T8 字体设置）；「跟随主题」时移除覆盖，回到主题自带栈。
  applyFonts(
    preferences.uiFont,
    preferences.codeFont,
    preferences.customUiFont,
    preferences.customCodeFont,
  );
  // data-style / data-mode / data-theme 全部由 theme.ts 负责，这里不碰。
  if (preferences.useCustomAccent && HEX_RE.test(preferences.accent)) {
    applyCustomAccent(preferences.accent);
  } else {
    clearCustomAccent();
  }
  // 动效开关写在 DOM 属性上：CSS（过渡/动画停用）和 framer（useMotionEnabled）都从这读。
  // 速度 0% 等同于关：两条路径必须一起退位，否则 layoutId 停摆但 CSS 还在动。
  const speed = clampMotionSpeed(preferences.motionSpeed);
  const motionOn = preferences.animations && speed > 0;
  // 时长倍率写进 CSS 变量：CSS 过渡按 var(--motion-scale) 换算（100% = 1）。
  root.style.setProperty("--motion-scale", String(motionOn ? speed / 100 : 0));
  if (root.dataset.motion !== (motionOn ? "on" : "off")) {
    root.dataset.motion = motionOn ? "on" : "off";
    notifyMotionListeners(motionOn);
  }
  // 速度变了要通知订阅者重建弹簧（framer 的参数是构建时算好的）。
  if (motionSpeedCached !== speed) {
    motionSpeedCached = speed;
    motionListeners.forEach((listener) => listener());
  }
}

/* ── 动效开关的轻量订阅 ────────────────────────────────────────────── */

const motionListeners = new Set<() => void>();
let motionEnabledCached = true;
let motionSpeedCached = 100;

function notifyMotionListeners(next: boolean) {
  motionEnabledCached = next;
  motionListeners.forEach((listener) => listener());
}

function subscribeMotion(listener: () => void): () => void {
  motionListeners.add(listener);
  return () => motionListeners.delete(listener);
}

function getMotionEnabledSnapshot(): boolean {
  // 首次调用时以 DOM 为准（applyPreferences 可能在别的组件里先跑过）。
  if (typeof document !== "undefined" && document.documentElement.dataset.motion) {
    motionEnabledCached = document.documentElement.dataset.motion !== "off";
  }
  return motionEnabledCached;
}

/** 当前是否允许动画。framer 组件用它决定要不要挂 whileHover / layoutId。 */
export function useMotionEnabled(): boolean {
  return useSyncExternalStore(subscribeMotion, getMotionEnabledSnapshot, getMotionEnabledSnapshot);
}

function getMotionSpeedSnapshot(): number {
  if (typeof document !== "undefined" && document.documentElement.style.getPropertyValue("--motion-scale")) {
    const raw = Number(document.documentElement.style.getPropertyValue("--motion-scale"));
    if (Number.isFinite(raw) && raw > 0) motionSpeedCached = Math.round(raw * 100);
  }
  return motionSpeedCached;
}

/**
 * 动画时长倍率（0.01–1.5）；0 表示动效已关闭。
 *
 * framer 的 transition 参数在渲染时就固化了，改速度必须让订阅者重算——
 * 所以这里走 useSyncExternalStore，而不是读一次全局变量。
 */
export function useMotionFactor(): number {
  const enabled = useMotionEnabled();
  const speed = useSyncExternalStore(subscribeMotion, getMotionSpeedSnapshot, getMotionSpeedSnapshot);
  return enabled && speed > 0 ? speed / 100 : 0;
}

export function usePreferences() {
  // 订阅主题 store：风格一变，偏好里的 theme 镜像跟着变，App 也会重渲染。
  const theme = useTheme();
  const [stored, setStored] = useState<StoredPreferences>(loadStored);

  const preferences = useMemo<Preferences>(
    () => ({ ...stored, theme: theme.styleTheme }),
    [stored, theme.styleTheme],
  );

  // 强调色写在 <html> 的内联样式上，必须和主题 DOM 一起在 layout 阶段落地，
  // 否则切换时会闪一帧旧色。
  useLayoutEffect(() => {
    applyPreferences(preferences);
  }, [preferences, theme.resolvedMode]);

  useEffect(() => {
    savePreferences(preferences);
  }, [preferences]);

  return {
    preferences,
    /** 切换视觉风格：风格进 theme.ts，同时丢弃自定义强调色，回到该风格自带的配色。 */
    selectTheme: (style: ThemeId) => {
      applyStyleTheme(style);
      setStored((current) => (current.useCustomAccent ? { ...current, useCustomAccent: false } : current));
    },
    setAccent: (accent: string) =>
      setStored((current) =>
        HEX_RE.test(accent)
          ? { ...current, accent, useCustomAccent: true }
          : current,
      ),
    resetAccent: () =>
      setStored((current) => ({ ...current, useCustomAccent: false })),
    setScale: (scale: number) =>
      setStored((current) => ({ ...current, scale: clampScale(scale) })),
    setSidebarCollapsed: (sidebarCollapsed: boolean) =>
      setStored((current) => ({ ...current, sidebarCollapsed })),
    setAnimations: (animations: boolean) =>
      setStored((current) => ({ ...current, animations })),
    setMotionSpeed: (motionSpeed: number) =>
      setStored((current) => ({ ...current, motionSpeed: clampMotionSpeed(motionSpeed) })),
    setSplash: (splash: boolean) => setStored((current) => ({ ...current, splash })),
    setLibraryView: (libraryView: LibraryView) =>
      setStored((current) => ({ ...current, libraryView })),
    setUiFont: (uiFont: UiFontId) => setStored((current) => ({ ...current, uiFont })),
    setCodeFont: (codeFont: CodeFontId) => setStored((current) => ({ ...current, codeFont })),
    setCustomUiFont: (customUiFont: string) =>
      setStored((current) => ({ ...current, customUiFont })),
    setCustomCodeFont: (customCodeFont: string) =>
      setStored((current) => ({ ...current, customCodeFont })),
  };
}
