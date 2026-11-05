import { ArrowDown, ArrowUp } from "lucide-react";
import type { SortDir, SortMode } from "../lib/librarySort";
import { t, type MessageKey } from "../i18n";

/**
 * 列表视图的表头。
 *
 * 为什么要它：排序原先只有工具栏下拉里的四个字段，方向还是写死的（名称恒升序、
 * 体积恒降序），想按版本比较只能一行行看。表头把「哪一列、往哪边排」变成可点的
 * 东西，当前列与方向直接显示在列上。
 *
 * 布局约束：每一格必须和 `ModRow` 一一对应（复选框 / 缩略图 / 名称 / 版本 /
 * 分类 / 大小 / 状态 / 开关 / 菜单按钮），所以这里直接复用行内同一套 class
 * （`row-main` / `row-col*` / `row-state`），列宽由那些规则单点决定——
 * 改列宽只动 CSS，不必两边各写一遍 px。
 *
 * 不用 table/row/columnheader 那套 ARIA：视觉上这是一行按钮，DOM 里没有真正的
 * 表格结构，挂上 table 角色反而会让读屏器按不合规的表结构去念。排序状态直接写进
 * 按钮的 aria-label（含「当前升序/降序」），信息不缺、结构也不撒谎。
 */
export function ModListHeader({
  sort,
  sortDir,
  onSort,
  selectable,
  grouped,
}: {
  sort: SortMode;
  sortDir: SortDir;
  onSort: (field: SortMode) => void;
  /** 多选模式下每行前面多一个 15px 复选框，表头要留出同样的空位。 */
  selectable: boolean;
  /** 分组模式下分类已经写在组头上，行里不显示分类列，表头也不显示。 */
  grouped: boolean;
}) {
  const column = (field: SortMode, className: string, labelKey: MessageKey) => {
    const active = sort === field;
    const label = t(labelKey);
    const dirLabel = t(sortDir === "asc" ? "library.sortAsc" : "library.sortDesc");
    return (
      <div className={`mod-list-col ${className}`}>
        <button
          type="button"
          className={`mod-list-sort ${active ? "is-active" : ""}`}
          onClick={() => onSort(field)}
          title={t("library.sortByColumn", { field: label })}
          aria-label={active ? `${label}（${dirLabel}）` : label}
        >
          <span className="mod-list-sort-label">{label}</span>
          {active ? (
            sortDir === "asc" ? (
              <ArrowUp size={9} strokeWidth={3} className="mod-list-sort-dir" />
            ) : (
              <ArrowDown size={9} strokeWidth={3} className="mod-list-sort-dir" />
            )
          ) : null}
        </button>
      </div>
    );
  };

  return (
    <div
      className="mod-list-header"
      role="group"
      aria-label={t("library.tableHeaderAria")}
    >
      {selectable ? <span className="mod-list-slot mod-list-slot-check" aria-hidden="true" /> : null}
      <span className="mod-list-slot mod-list-slot-thumb" aria-hidden="true" />

      {/* 名称列是弹性宽度：和行里的 .row-main 同宽、同起点，其余列才有共同基准。 */}
      {column("name", "row-main", "library.colName")}
      {column("version", "row-col row-col-version is-right", "library.colVersion")}
      {grouped ? null : column("category", "row-col row-col-category", "library.colCategory")}
      {column("size", "row-col row-col-size is-right", "library.colSize")}
      {column("status", "row-state", "library.colStatus")}

      {/* 开关与「更多」按钮不是可排序列，只占位。 */}
      <span className="mod-list-slot mod-list-slot-toggle" aria-hidden="true" />
      <span className="mod-list-slot mod-list-slot-action" aria-hidden="true" />
    </div>
  );
}
