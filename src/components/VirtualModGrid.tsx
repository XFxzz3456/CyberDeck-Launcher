import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { ConflictInfo, ModEntry } from "../types";
import type { LibraryListItem } from "../lib/libraryList";
import type { LibraryView } from "../lib/preferences";
import { ModCard } from "./ModCard";
import { ModCardErrorBoundary } from "./ModCardErrorBoundary";
import { ModGroupHeader, GROUP_HEADER_HEIGHT } from "./ModGroupHeader";
import { ModRow } from "./ModRow";

/** 没有冲突时复用同一个空数组：props 引用稳定，卡片不用为一次渲染新建数组。 */
const NO_CONFLICTS: ConflictInfo[] = [];

/**
 * 滚动锚点表。**刻意放在模块作用域**：
 *
 * 原先它是组件内的 ref，而换页是 `key={view}` + `AnimatePresence`，
 * 离开模组库去设置页再回来时组件是重新挂载的，ref 里的记忆自然就没了——
 * 报告里那条「从设置页回来滚动位置丢失」正是这个原因。
 * key 是「筛选键:视图」，组合数有限（分类 × 排序 × 视图），不会无限增长。
 */
const scrollAnchors = new Map<string, number>();

/** 列表视图单行占位高度（行 42px + 间距 6px）。虚拟滚动按固定值估算，改这里要同步改 CSS。 */
const LIST_ROW_HEIGHT = 48;

export function VirtualModGrid({
  mods,
  conflicts,
  missingDepsById,
  translationCounts,
  busyId,
  filterKey = "",
  updateIds,
  view = "grid",
  listItems,
  listHeader,
  versionGroups,
  onSwitchVersion,
  onDeleteVersion,
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
  /**
   * Mod id → 缺失前置名列表，由上层一次算好。
   *
   * 为什么不在卡片里现算：可见卡片十几张、每次滚动或输入都重算一遍，
   * 而同一条模组的缺失清单在一次渲染里完全相同。上层用 useMemo 建表，
   * 这里只查表，顺便让引用稳定（卡片要不要 memo 化时这就是前提之一）。
   */
  missingDepsById: Map<string, string[]>;
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
  /**
   * 列表视图的固定表头（排序用）。
   *
   * 挂在滚动容器内部、虚拟网格之前：sticky 定位让它跟着滚动停住，而它本身在
   * 文档流里占位，所以行从它下面开始排列。虚拟器的 range 计算会比实际位置
   * 少算一个表头高度（26px），overscan 有 8 行（≈384px），完全盖得住。
   */
  listHeader?: ReactNode;
  /** 代表条目 id → 该 mod 的全部版本（新→旧）。只有多版本的 mod 才在表里。 */
  versionGroups?: Map<string, ModEntry[]>;
  /** 卡片版本下拉的点击回调：切换生效版本。 */
  onSwitchVersion?: (mod: ModEntry) => void;
  /** 删除某个版本（Vortex 托管条目不给）。 */
  onDeleteVersion?: (mod: ModEntry) => void;
  onToggleGroup?: (key: string) => void;
  onToggle: (mod: ModEntry, enabled: boolean) => void;
  onOpen: (mod: ModEntry) => void;
  onContextMenu?: (mod: ModEntry, event: React.MouseEvent) => void;
  /** 批量选择（看板【mod 列表及切换功能】）：多选模式 + 已选集合 + 勾选回调。 */
  selectable?: boolean;
  selectedIds?: Set<string>;
  onSelectChange?: (modId: string, checked: boolean) => void;
}) {
  /**
   * Mod id → 与它相关的冲突。冲突总数不大，但每张卡片各扫一遍全表就是
   * O(卡片数 × 冲突数)，而且每次重渲染都重扫；这里一次分好组，卡片只取自己那份。
   */
  const conflictsById = useMemo(() => {
    const table = new Map<string, ConflictInfo[]>();
    for (const conflict of conflicts) {
      const ids =
        conflict.otherModId && conflict.otherModId !== conflict.modId
          ? [conflict.modId, conflict.otherModId]
          : [conflict.modId];
      for (const id of ids) {
        const list = table.get(id);
        if (list) list.push(conflict);
        else table.set(id, [conflict]);
      }
    }
    return table;
  }, [conflicts]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const anchors = useRef(scrollAnchors);
  // 锚点 key 带上视图：网格和列表的行数差一个数量级，互相套用滚动位置只会跳飞。
  const anchorKey = `${filterKey}:${view}`;
  const prevKey = useRef<string | null>(null);

  /**
   * 筛选键变化 / 组件重新挂载：把滚动位置恢复到上一次离开这个分类时的锚点。
   *
   * 两处细节都是必要的：
   * - `prevKey` 初值是 null 而不是当前 key——否则首帧就判定「键没变」，重新挂载后
   *   永远不会去读模块表里存着的锚点（这正是「从设置页回来回到顶部」的另一半原因）；
   * - 用 `useLayoutEffect` 而不是 `useEffect`：前者在绘制前执行，恢复动作不会先闪一帧
   *   顶部再跳下去。
   */
  useLayoutEffect(() => {
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
  // 2026-11-01：封面 140→160，卡片高度整体 +20（292/300/310 → 312/320/330），
  // 行高同步 +20。行高偏大会留白、偏小会叠卡，主题最高 330 + 间距 14 = 344，
  // 原先 328→348 的余量与旧值（328 覆盖 310+14=324）一致。
  const rowHeight = view === "list" ? LIST_ROW_HEIGHT : 348;
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
      return item.type === "header" ? `h:${item.key}` : `m:${item.mod.id}`;
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

  /**
   * 卡片是否处于忙碌态。
   *
   * 不能只比 `busyId === mod.id`：版本切换时 busyId 是「被点中的那个版本」，
   * 而卡片上的 mod 是代表条目（通常是另一个 id），只比 id 的话点了老版本
   * 卡片不会转圈，用户会以为没反应、连点第二次，于是并发部署。
   */
  const isBusy = (mod: ModEntry) =>
    busyId === mod.id || (versionGroups?.get(mod.id)?.some((item) => item.id === busyId) ?? false);

  const renderRow = (mod: ModEntry) => (
    <ModCardErrorBoundary modId={mod.id} modName={mod.name}>
      <ModRow
        mod={mod}
        modConflicts={conflictsById.get(mod.id) ?? NO_CONFLICTS}
        missingDeps={missingDepsById.get(mod.id) ?? []}
        translationCount={translationCounts?.get(mod.id) ?? 0}
        hasUpdate={updateIds?.has(mod.id) ?? false}
        busy={isBusy(mod)}
        grouped={Boolean(list)}
        versions={versionGroups?.get(mod.id)}
        onSwitchVersion={onSwitchVersion}
        onDeleteVersion={onDeleteVersion}
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
      {view === "list" ? listHeader : null}
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
                    label={item.label}
                    count={item.count}
                    collapsed={item.collapsed}
                    onToggle={() => onToggleGroup?.(item.key)}
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
                    modConflicts={conflictsById.get(mod.id) ?? NO_CONFLICTS}
                    missingDeps={missingDepsById.get(mod.id) ?? []}
                    translationCount={translationCounts?.get(mod.id) ?? 0}
                    aiLocated={mod.aiLoc != null}
                    hasUpdate={updateIds?.has(mod.id) ?? false}
                    busy={isBusy(mod)}
                    versions={versionGroups?.get(mod.id)}
                    onSwitchVersion={onSwitchVersion}
                    onDeleteVersion={onDeleteVersion}
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
