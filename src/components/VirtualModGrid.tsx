import { useEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { ConflictInfo, DependencyReport, FrameworkStatus, ModEntry } from "../types";
import { missingDependencyNames } from "../lib/dependencies";
import type { LibraryListItem } from "../lib/libraryList";
import type { LibraryView } from "../lib/preferences";
import { ModCard } from "./ModCard";
import { ModCardErrorBoundary } from "./ModCardErrorBoundary";
import { ModGroupHeader, GROUP_HEADER_HEIGHT } from "./ModGroupHeader";
import { ModRow } from "./ModRow";

/** 列表视图单行占位高度（行 42px + 间距 6px）。虚拟滚动按固定值估算，改这里要同步改 CSS。 */
const LIST_ROW_HEIGHT = 48;

export function VirtualModGrid({
  mods,
  conflicts,
  frameworks,
  dependencyReport,
  translationCounts,
  busyId,
  filterKey = "",
  updateIds,
  view = "grid",
  listItems,
  onToggleGroup,
  onToggle,
  onOpen,
  onContextMenu,
  selectable = false,
  selectedIds,
  onSelectChange,
}: {
  mods: ModEntry[];
  conflicts: ConflictInfo[];
  frameworks: FrameworkStatus[] | null;
  /** 后端依赖报告；为空时退回本地推断（演示模式）。 */
  dependencyReport?: DependencyReport | null;
  /** 父级 Mod id → 已绑定的汉化子包数量（卡片上打「中」徽标）。 */
  translationCounts?: Map<string, number>;
  busyId: string | null;
  /** C3 滚动锚点：分类/排序变化时按此 key 记忆并恢复滚动位置，
   *  用户在长列表里来回对比不用每次从头滚。 */
  filterKey?: string;
  /** #1 有新版本的模组 id 集合，卡片上打 UPD 徽标。 */
  updateIds?: Set<string>;
  /** 显示方式：卡片网格 / 紧凑列表（bf7889 反馈）。两种都走虚拟滚动。 */
  view?: LibraryView;
  /** 列表视图的分组行（组头 + 模组）。给了就按它渲染，不给就按 mods 平铺。 */
  listItems?: LibraryListItem[];
  onToggleGroup?: (category: string) => void;
  onToggle: (mod: ModEntry, enabled: boolean) => void;
  onOpen: (mod: ModEntry) => void;
  onContextMenu?: (mod: ModEntry, event: React.MouseEvent) => void;
  /** 批量选择（看板【mod 列表及切换功能】）：多选模式 + 已选集合 + 勾选回调。 */
  selectable?: boolean;
  selectedIds?: Set<string>;
  onSelectChange?: (modId: string, checked: boolean) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const anchors = useRef(new Map<string, number>());
  // 锚点 key 带上视图：网格和列表的行数差一个数量级，互相套用滚动位置只会跳飞。
  const anchorKey = `${filterKey}:${view}`;
  const prevKey = useRef(anchorKey);

  // 筛选键变化：把滚动位置恢复到上一次离开这个分类时的锚点。
  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    if (prevKey.current !== anchorKey) {
      const saved = anchors.current.get(anchorKey);
      node.scrollTop = saved ?? 0;
      prevKey.current = anchorKey;
    }
  });

  // 滚动时持续记录当前筛选键的锚点。
  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    const onScroll = () => anchors.current.set(anchorKey, node.scrollTop);
    node.addEventListener("scroll", onScroll, { passive: true });
    return () => node.removeEventListener("scroll", onScroll);
  }, [anchorKey]);

  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.width ?? 0;
      setWidth(next);
    });
    observer.observe(node);
    setWidth(node.clientWidth);
    return () => observer.disconnect();
  }, []);

  /**
   * 卡片最小宽 300px：窗口缩窄时列数自动减少（1920→4 列、1440→3 列、
   * 1280→2 列、极窄单列），任何尺寸都不会把卡片挤到溢出。
   * 这里等价于静态网格的 repeat(auto-fill, minmax(300px, 1fr))——
   * 虚拟滚动必须显式列数，所以用同一个除法表达。
   */
  const CARD_MIN = 300;
  const CARD_GAP = 14;
  const columns =
    view === "list"
      ? 1
      : Math.max(1, Math.min(6, Math.floor((width + CARD_GAP) / (CARD_MIN + CARD_GAP))));
  const rowHeight = view === "list" ? LIST_ROW_HEIGHT : 328;
  const rows = Math.max(1, Math.ceil(mods.length / columns));

  // 列表视图走 listItems（可能带组头），网格仍按行切模组。
  const list = view === "list" ? listItems : undefined;
  const count = list ? list.length : rows;

  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => {
      if (!list) return rowHeight;
      return list[index]?.type === "header" ? GROUP_HEADER_HEIGHT : LIST_ROW_HEIGHT;
    },
    // key 必须稳定：折叠一下整段列表都在换位，用 index 当 key 会让 React
    // 复用到错的行上（开关状态、hover 都会串行）。
    getItemKey: (index) => {
      if (!list) return index;
      const item = list[index];
      if (!item) return index;
      return item.type === "header" ? `h:${item.category}` : `m:${item.mod.id}`;
    },
    overscan: view === "list" ? 8 : 4,
  });

  // 切换视图时行高整体变了，缓存里的旧测量值必须作废，否则会滚出空白带。
  const viewRef = useRef(view);
  useEffect(() => {
    if (viewRef.current === view) return;
    viewRef.current = view;
    virtualizer.measure();
  }, [view, virtualizer]);

  // 折叠 / 展开会改变总行数与高度，估算表必须重算，否则滚动条长度是错的。
  const layoutKey = list ? `${list.length}` : `${rows}`;
  const layoutRef = useRef(layoutKey);
  useEffect(() => {
    if (layoutRef.current === layoutKey) return;
    layoutRef.current = layoutKey;
    virtualizer.measure();
  }, [layoutKey, virtualizer]);

  const renderRow = (mod: ModEntry) => (
    <ModCardErrorBoundary modId={mod.id} modName={mod.name}>
      <ModRow
        mod={mod}
        conflicts={conflicts}
        missingDeps={missingDependencyNames(mod, dependencyReport, frameworks)}
        translationCount={translationCounts?.get(mod.id) ?? 0}
        hasUpdate={updateIds?.has(mod.id) ?? false}
        busy={busyId === mod.id}
        grouped={Boolean(list)}
        onToggle={(enabled) => onToggle(mod, enabled)}
        onOpen={() => onOpen(mod)}
        onContextMenu={
          onContextMenu
            ? (event) => {
                event.preventDefault();
                onContextMenu(mod, event);
              }
            : undefined
        }
        selectable={selectable}
        selected={selectedIds?.has(mod.id) ?? false}
        onSelectedChange={(checked) => onSelectChange?.(mod.id, checked)}
      />
    </ModCardErrorBoundary>
  );

  return (
    <div className={`grid-scroll view-${view}`} ref={scrollRef}>
      <div className="virtual-grid" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((virtualRow) => {
          if (list) {
            const item = list[virtualRow.index];
            if (!item) return null;
            if (item.type === "header") {
              return (
                <div
                  key={virtualRow.key}
                  className="virtual-row virtual-row-group"
                  style={{ transform: `translateY(${virtualRow.start}px)` }}
                >
                  <ModGroupHeader
                    category={item.category}
                    count={item.count}
                    collapsed={item.collapsed}
                    onToggle={() => onToggleGroup?.(item.category)}
                  />
                </div>
              );
            }
            return (
              <div
                key={virtualRow.key}
                className="virtual-row virtual-row-list"
                style={{ transform: `translateY(${virtualRow.start}px)` }}
              >
                {renderRow(item.mod)}
              </div>
            );
          }
          const start = virtualRow.index * columns;
          const items = mods.slice(start, start + columns);
          if (view === "list") {
            const mod = items[0];
            if (!mod) return null;
            return (
              <div
                key={virtualRow.key}
                className="virtual-row virtual-row-list"
                style={{ transform: `translateY(${virtualRow.start}px)` }}
              >
                {renderRow(mod)}
              </div>
            );
          }
          return (
            <div
              key={virtualRow.key}
              className="virtual-row"
              style={{
                transform: `translateY(${virtualRow.start}px)`,
                gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
              }}
            >
              {items.map((mod) => (
                <ModCardErrorBoundary key={mod.id} modId={mod.id} modName={mod.name}>
                  <ModCard
                    mod={mod}
                    conflicts={conflicts}
                    missingDeps={missingDependencyNames(mod, dependencyReport, frameworks)}
                    translationCount={translationCounts?.get(mod.id) ?? 0}
              aiLocated={mod.aiLoc != null}
                    hasUpdate={updateIds?.has(mod.id) ?? false}
                    busy={busyId === mod.id}
                    onToggle={(enabled) => onToggle(mod, enabled)}
                    onOpen={() => onOpen(mod)}
                    onContextMenu={
                      onContextMenu
                        ? (event) => {
                            event.preventDefault();
                            onContextMenu(mod, event);
                          }
                        : undefined
                    }
                    selectable={selectable}
                    selected={selectedIds?.has(mod.id) ?? false}
                    onSelectedChange={(checked) => onSelectChange?.(mod.id, checked)}
                  />
                </ModCardErrorBoundary>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
