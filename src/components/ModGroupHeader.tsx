import { ChevronRight } from "lucide-react";
import { categoryLabel, t } from "../i18n";

/**
 * 列表视图的分组头高度。虚拟滚动按固定值切片，改这里必须同步 `.mod-group-head`
 * 的 CSS 高度，否则滚到后面会错位。
 */
export const GROUP_HEADER_HEIGHT = 34;

/**
 * 列表视图的分组标题栏：分类名 + 数量 + 折叠箭头。
 *
 * 折叠不做高度过渡：虚拟列表按估算高度切片，动画过程中的实际高度和估算值对不上，
 * 滚动条会抖。这里只旋转箭头 + hover 反馈，动作够清楚。
 */
export function ModGroupHeader({
  category,
  count,
  collapsed,
  onToggle,
}: {
  category: string;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const label = categoryLabel(category);
  return (
    <button
      type="button"
      className={`mod-group-head ${collapsed ? "is-collapsed" : ""}`}
      onClick={onToggle}
      aria-expanded={!collapsed}
      aria-label={t("library.groupToggleAria", { name: label, count })}
    >
      <ChevronRight size={13} strokeWidth={2.4} className="group-caret" />
      <span className="group-name">{label}</span>
      <span className="group-count">{count}</span>
      <span className="group-rule" aria-hidden="true" />
    </button>
  );
}
