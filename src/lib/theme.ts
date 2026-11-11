import { useCallback, useLayoutEffect, useMemo, useSyncExternalStore } from "react";
import type { MessageKey } from "../i18n";

/**
 * 主题系统：把「视觉风格」和「明暗模式」拆成两个独立维度。
 *
 * - styleTheme 决定界面长什么样（赛博四套 + modern；r20 起 mono 已删，老配置自动迁到 modern）。
 * - colorMode 决定亮还是暗。只有 modern 支持明暗切换，其余强制深色。
 *
 * DOM 契约（写在 documentElement 上）：
 *   data-style          视觉风格 id
 *   data-mode           折算后的明暗（light / dark），system 已被折算
 *   data-mode-capable   该风格是否允许切换明暗（true / false）
 *   data-theme          与 data-style 同值，留给旧的 :root[data-theme="..."] 选择器
 *   data-theme-transition  切换过渡窗口，300ms 后自动摘掉
 */

export type StyleTheme = "ncpd" | "netrunner" | "arasaka" | "militech" | "modern";
export type ColorMode = "light" | "dark" | "system";
export type ResolvedMode = "light" | "dark";

export const THEME_STORAGE_KEY = "ncl.ui.theme.v2";
/** 旧版把 theme 字段存在这个 key 里，升级时用它做一次迁移。 */
export const LEGACY_PREFERENCES_KEY = "ncl.ui.preferences.v1";

export const STYLE_THEME_IDS: readonly StyleTheme[] = [
  "ncpd",
  "netrunner",
  "arasaka",
  "militech",
  "modern",
];

/** 只有这种风格允许在明暗之间切换，其余强制深色。 */
export const MODE_CAPABLE_STYLES: readonly StyleTheme[] = ["modern"];

/**
 * 风格大类：UI 上只呈现两个入口。
 *
 * 赛博四套（NCPD / NETRUNNER / ARASAKA / MILITECH）共用同一套切角与发光结构，
 * 差别只在配色 —— 摆成五张平级卡片时用户看不出「风格」的区别，只觉得冗余。
 * 所以上层按大类呈现，赛博内部再用预设色块切换，底层 CSS 一行都不用改。
 */
export type StyleFamily = "cyber" | "modern";

export function themeFamily(styleTheme: StyleTheme): StyleFamily {
  return styleTheme === "modern" ? "modern" : "cyber";
}

/** 赛博风预设的展示顺序：经典黄黑 → 荒坂暗红 → 冰蓝黑客 → 军用橄榄绿。 */
export const CYBER_PRESET_ORDER: readonly StyleTheme[] = [
  "ncpd",
  "arasaka",
  "netrunner",
  "militech",
];

export interface StylePreset {
  id: StyleTheme;
  name: string;
  /** 中文名与说明都是显示文案，只存 key，渲染层用 t() 取。 */
  labelKey: MessageKey;
  detailKey: MessageKey;
  /** [强调色, 底色]，只用于卡片上的色块预览。 */
  swatch: [string, string];
  /** 首屏缩略图；缺省时用色块代替。 */
  thumb?: string;
  /** 明暗两套都有缩略图时，亮色单独一张（modern 才用得到）。 */
  thumbLight?: string;
}

export const STYLE_PRESETS: StylePreset[] = [
  {
    id: "ncpd",
    name: "NCPD",
    labelKey: "theme.presets.ncpd.label",
    detailKey: "theme.presets.ncpd.detail",
    swatch: ["#fcee0a", "#07090c"],
    thumb: "/theme-thumbs/ncpd.png",
  },
  {
    id: "netrunner",
    name: "NETRUNNER",
    labelKey: "theme.presets.netrunner.label",
    detailKey: "theme.presets.netrunner.detail",
    swatch: ["#31e6ff", "#03080d"],
    thumb: "/theme-thumbs/netrunner.png",
  },
  {
    id: "arasaka",
    name: "ARASAKA",
    labelKey: "theme.presets.arasaka.label",
    detailKey: "theme.presets.arasaka.detail",
    swatch: ["#ff4058", "#0b0507"],
    thumb: "/theme-thumbs/arasaka.png",
  },
  {
    id: "militech",
    name: "MILITECH",
    labelKey: "theme.presets.militech.label",
    detailKey: "theme.presets.militech.detail",
    swatch: ["#b7f04b", "#080b08"],
    thumb: "/theme-thumbs/militech.png",
  },
  {
    id: "modern",
    name: "MODERN",
    labelKey: "theme.presets.modern.label",
    detailKey: "theme.presets.modern.detail",
    swatch: ["#2563eb", "#ffffff"],
    // 明暗各一张，卡片按当前生效的明暗自动换（见 AppearanceSettings）。
    thumb: "/theme-thumbs/modern-dark.png",
    thumbLight: "/theme-thumbs/modern-light.png",
  },
];

interface ThemeState {
  styleTheme: StyleTheme;
  colorMode: ColorMode;
  /** 系统当前是否深色，只在 colorMode === "system" 时参与折算。 */
  systemDark: boolean;
}

/** 旧版 theme 字段 → 新的（风格, 明暗）。daylight 迁移到 modern + light。 */
const LEGACY_THEME_MAP: Record<string, { styleTheme: StyleTheme; colorMode: ColorMode }> = {
  ncpd: { styleTheme: "ncpd", colorMode: "dark" },
  netrunner: { styleTheme: "netrunner", colorMode: "dark" },
  arasaka: { styleTheme: "arasaka", colorMode: "dark" },
  militech: { styleTheme: "militech", colorMode: "dark" },
  mono: { styleTheme: "modern", colorMode: "dark" },
  modern: { styleTheme: "modern", colorMode: "dark" },
  daylight: { styleTheme: "modern", colorMode: "light" },
};

function isStyleTheme(value: unknown): value is StyleTheme {
  return typeof value === "string" && (STYLE_THEME_IDS as readonly string[]).includes(value);
}

function isColorMode(value: unknown): value is ColorMode {
  return value === "light" || value === "dark" || value === "system";
}

function prefersDark(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return true;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

/** 赛博风格强制深色；只有 modern 看 colorMode。 */
export function isModeCapableStyle(styleTheme: StyleTheme): boolean {
  return MODE_CAPABLE_STYLES.includes(styleTheme);
}

function resolveMode(state: ThemeState): ResolvedMode {
  if (!isModeCapableStyle(state.styleTheme)) return "dark";
  if (state.colorMode === "system") return state.systemDark ? "dark" : "light";
  return state.colorMode;
}

function readPersisted(): { styleTheme: StyleTheme; colorMode: ColorMode } {
  if (typeof window === "undefined") return { styleTheme: "ncpd", colorMode: "dark" };
  try {
    const raw = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as { styleTheme?: unknown; colorMode?: unknown };
      // r20 删除 mono 主题：老配置原样迁到 modern，明暗偏好保留。
      const wanted = parsed.styleTheme === "mono" ? "modern" : parsed.styleTheme;
      if (isStyleTheme(wanted)) {
        return {
          styleTheme: wanted,
          colorMode: isColorMode(parsed.colorMode) ? parsed.colorMode : "dark",
        };
      }
    }
    // 没有新 key：读旧 key 的 theme 字段做一次映射。
    const legacyRaw = window.localStorage.getItem(LEGACY_PREFERENCES_KEY);
    if (legacyRaw) {
      const legacy = JSON.parse(legacyRaw) as { theme?: unknown };
      if (typeof legacy.theme === "string") {
        const mapped = LEGACY_THEME_MAP[legacy.theme];
        if (mapped) return mapped;
      }
    }
  } catch {
    // localStorage 不可用（webview 锁定）时退回默认值。
  }
  return { styleTheme: "ncpd", colorMode: "dark" };
}

function persist(state: ThemeState) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      THEME_STORAGE_KEY,
      JSON.stringify({ styleTheme: state.styleTheme, colorMode: state.colorMode }),
    );
  } catch {
    // 存不下就算了，本次会话仍然生效。
  }
}

let state: ThemeState = { ...readPersisted(), systemDark: prefersDark() };
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): ThemeState {
  return state;
}

export function setStyleTheme(styleTheme: StyleTheme) {
  if (state.styleTheme === styleTheme) return;
  state = { ...state, styleTheme };
  persist(state);
  emit();
}

export function setColorMode(colorMode: ColorMode) {
  if (state.colorMode === colorMode) return;
  state = { ...state, colorMode };
  persist(state);
  emit();
}

/** 系统主题变了就跟着变（仅当 colorMode === "system"）。 */
function watchSystemTheme() {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
  const query = window.matchMedia("(prefers-color-scheme: dark)");
  const onChange = (event: MediaQueryListEvent) => {
    if (state.systemDark === event.matches) return;
    state = { ...state, systemDark: event.matches };
    emit();
  };
  if (typeof query.addEventListener === "function") query.addEventListener("change", onChange);
  else if (typeof query.addListener === "function") query.addListener(onChange);
}

watchSystemTheme();

let lastWritten: { styleTheme: StyleTheme; mode: ResolvedMode } | null = null;
let transitionTimer: number | undefined;

/**
 * 自定义调色板（palette.ts）的刷新回调。
 *
 * 用注册而不是直接 import：palette 依赖 theme（要读当前明暗、要挂主题切换后的
 * 重算），反向 import 会成环。注册表只有一项，开销可以忽略。
 */
let paletteRefresher: (() => void) | null = null;

export function setPaletteRefresher(refresher: (() => void) | null): void {
  paletteRefresher = refresher;
}

/**
 * 写 DOM。切换时先挂上 data-theme-transition 并强制一次回流，
 * 让新配色的过渡动画真的跑起来，300ms 后摘掉。
 */
function writeDom(next: ThemeState) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const mode = resolveMode(next);
  const changed = lastWritten !== null && (lastWritten.styleTheme !== next.styleTheme || lastWritten.mode !== mode);

  if (changed) {
    root.setAttribute("data-theme-transition", "true");
    // 强制回流，让浏览器先算一遍带 transition 的旧配色。
    void root.offsetWidth;
  }

  root.dataset.style = next.styleTheme;
  // 旧的 :root[data-theme="..."] 选择器仍然要用，值与 data-style 保持一致。
  root.dataset.theme = next.styleTheme;
  root.dataset.mode = mode;
  root.dataset.modeCapable = isModeCapableStyle(next.styleTheme) ? "true" : "false";

  if (changed) {
    window.clearTimeout(transitionTimer);
    transitionTimer = window.setTimeout(() => {
      root.removeAttribute("data-theme-transition");
    }, 300);
  }

  lastWritten = { styleTheme: next.styleTheme, mode };

  // 主题或明暗变了，派生色要按新的主题原色重算（玩家只覆盖了一部分颜色时
  // 尤其重要：只调卡片底色的人，背景与文字仍应跟随新主题）。
  if (changed) paletteRefresher?.();
}

export interface ThemeController {
  styleTheme: StyleTheme;
  colorMode: ColorMode;
  /** colorMode 折算后的实际明暗。 */
  resolvedMode: ResolvedMode;
  /** 当前风格是否允许切换明暗。 */
  modeCapable: boolean;
  setStyleTheme: (styleTheme: StyleTheme) => void;
  setColorMode: (colorMode: ColorMode) => void;
}

export function useTheme(): ThemeController {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  // 用 layout effect 而不是 effect：DOM 要在浏览器绘制前就换好，不能闪一帧旧配色。
  useLayoutEffect(() => {
    writeDom(snapshot);
  }, [snapshot]);

  const setStyle = useCallback((styleTheme: StyleTheme) => setStyleTheme(styleTheme), []);
  const setMode = useCallback((colorMode: ColorMode) => setColorMode(colorMode), []);

  return useMemo(
    () => ({
      styleTheme: snapshot.styleTheme,
      colorMode: snapshot.colorMode,
      resolvedMode: resolveMode(snapshot),
      modeCapable: isModeCapableStyle(snapshot.styleTheme),
      setStyleTheme: setStyle,
      setColorMode: setMode,
    }),
    [snapshot, setStyle, setMode],
  );
}

/** 当前实际生效的明暗，给非 React 场景（强调色深浅判断）用。 */
export function getResolvedMode(): ResolvedMode {
  return resolveMode(state);
}

/** 当前视觉风格，给非 React 场景（偏好层镜像）用。 */
export function getCurrentStyleTheme(): StyleTheme {
  return state.styleTheme;
}
