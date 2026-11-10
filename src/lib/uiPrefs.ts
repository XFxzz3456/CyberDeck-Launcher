import type { View } from "../components/Sidebar";
import type { MessageKey } from "../i18n";

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

/**
 * 可隐藏入口的显示名词条。
 *
 * 为什么是一张显式表而不是 `t(\`hiddenView.${view}\` as MessageKey)`：模板串必须
 * `as MessageKey` 才能过 tsc，这一步同时废掉了两道校验——tsc 不再检查 key 是否
 * 存在，`--unused` 只能按前缀匹配也查不出缺项。结果是新增视图忘了加词条时，
 * 界面上直接把 `hiddenView.xxx` 显示给用户。写成 `Record<HideableView, MessageKey>`
 * 后，加一个视图不补词条就是编译错误。
 */
export const HIDEABLE_VIEW_LABEL_KEYS: Record<HideableView, MessageKey> = {
  diagnostics: "hiddenView.diagnostics",
  discover: "hiddenView.discover",
  downloads: "hiddenView.downloads",
  loadorder: "hiddenView.loadorder",
  saves: "hiddenView.saves",
};

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
