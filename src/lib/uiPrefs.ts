import type { View } from "../components/Sidebar";

/**
 * 界面显示管理（deepseek 任务·模块四）：侧栏入口的显示/隐藏。
 *
 * 只存用户偏好，不碰业务状态；沿用 ncl.ui.* 键名约定（A3 兼容锚点）。
 * 模组库与设置是"保护入口"——一个回退目标、一个配置必经之路，不允许隐藏。
 */
export const HIDDEN_VIEWS_KEY = "ncl.ui.hiddenViews.v1";

/** 允许用户隐藏的侧栏入口（模组库/设置刻意不在列）。 */
export const HIDEABLE_VIEWS = ["discover", "loadorder", "downloads", "diagnostics", "saves"] as const;

export type HideableView = (typeof HIDEABLE_VIEWS)[number];

export type HiddenViewsMap = Partial<Record<HideableView, boolean>>;

export function isHideableView(view: View): view is HideableView {
  return (HIDEABLE_VIEWS as readonly string[]).includes(view);
}

export function loadHiddenViews(): HiddenViewsMap {
  try {
    const raw = window.localStorage.getItem(HIDDEN_VIEWS_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const map: HiddenViewsMap = {};
    for (const key of HIDEABLE_VIEWS) {
      if ((parsed as Record<string, unknown>)[key] === true) map[key] = true;
    }
    return map;
  } catch {
    // 锁死的 webview 可能拒绝 localStorage；会话内当默认值用。
    return {};
  }
}

export function saveHiddenViews(map: HiddenViewsMap) {
  try {
    window.localStorage.setItem(HIDDEN_VIEWS_KEY, JSON.stringify(map));
  } catch {
    // 同上：写不进去也不影响本会话。
  }
}
