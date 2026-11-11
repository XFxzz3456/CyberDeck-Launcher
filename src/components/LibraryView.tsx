import {
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useDismissableMenu } from "../lib/useDismissableMenu";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Boxes,
  ChevronDown,
  FileJson,
  FolderTree,
  ImageDown,
  Languages,
  Sparkles,
  Tag,
  Layers,
  LayoutGrid,
  List,
  ListChecks,
  MoreHorizontal,
  ListFilter,
  PackageOpen,
  Plus,
  Download,
  RefreshCw,
  SearchX,
  ShieldCheck,
  Wand2,
  X,
} from "lucide-react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type {
  Category,
  ConflictInfo,
  DependencyReport,
  FrameworkStatus,
  ModEntry,
  Snapshot,
} from "../types";
import { CATEGORIES } from "../types";
import { categoryIcon, formatBytes } from "../lib/format";
import { api, isTauri, normalizeError } from "../lib/api";
import { isCollectionManifestPath } from "../lib/collection";
import type { LibraryView as LibraryViewMode } from "../lib/preferences";
import { VirtualModGrid } from "./VirtualModGrid";
import { ModListHeader } from "./ModListHeader";
import { buildLibraryList, type GroupBy, type StatusFilter } from "../lib/libraryList";
import { groupVersions } from "../lib/modVersions";
import { compareMods, type SortDir, type SortMode } from "../lib/librarySort";
import { depIgnoresVersion, missingDependencyNames, subscribeDepIgnores } from "../lib/dependencies";
import { ModContextMenu, type ModContextMenuState } from "./ModContextMenu";
import { AiToolsDialog } from "./AiToolsDialog";
import { CollectionWizard } from "./CollectionWizard";
import { ConfirmDialog, EmptyState, Modal, Spinner } from "./ui";
import { categoryLabel, t, type MessageKey } from "../i18n";

/**
 * 工具栏密度三档（按实测溢出逐级收紧）：
 *   full    全部显示
 *   compact 收起低频（补全 / 导入方式）→ 换成「更多 ▾」
 *   tight   再收起「归类」与 RESULTS 文字
 *   mini    连「多选」与结果数也收起（多选在「更多」里有入口）
 * 按钮本身永不收缩，只靠这几档腾空间——收缩会让命中区盖住邻居（踩过两次）。
 */
type ToolbarDensity = "full" | "compact" | "tight" | "mini";

const STATUS_FILTERS: Array<{ id: StatusFilter; labelKey: MessageKey }> = [
  { id: "all", labelKey: "library.statusAll" },
  { id: "enabled", labelKey: "library.statusEnabled" },
  { id: "disabled", labelKey: "library.statusDisabled" },
  { id: "missing", labelKey: "library.statusMissing" },
];

/** 折叠状态与「分组/平铺」都放 localStorage：这是视图偏好，不属于要备份的数据。 */
const COLLAPSED_KEY = "ncl.ui.library.collapsedGroups.v1";
const GROUP_MODE_KEY = "ncl.ui.library.groupMode.v1";

function readCollapsedGroups(): Set<string> {
  try {
    const raw = window.localStorage.getItem(COLLAPSED_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((item): item is string => typeof item === "string"));
  } catch {
    return new Set();
  }
}

function readGroupMode(): boolean {
  try {
    return window.localStorage.getItem(GROUP_MODE_KEY) !== "flat";
  } catch {
    return true;
  }
}

/** 工具栏排序下拉的选项。文案存 key，不在模块加载时求值（切语言要能跟着变）。 */
const SORTS: Array<{ id: SortMode; labelKey: MessageKey }> = [
  { id: "name", labelKey: "library.sortName" },
  { id: "version", labelKey: "library.sortVersion" },
  { id: "category", labelKey: "library.sortCategory" },
  { id: "size", labelKey: "library.sortSize" },
  { id: "recent", labelKey: "library.sortRecent" },
  { id: "status", labelKey: "library.sortStatus" },
];

/** 列表视图的分组维度下拉。 */
const GROUP_BYS: Array<{ id: GroupBy; labelKey: MessageKey }> = [
  { id: "category", labelKey: "library.groupByCategory" },
  { id: "status", labelKey: "library.groupByStatus" },
  { id: "author", labelKey: "library.groupByAuthor" },
  { id: "installed", labelKey: "library.groupByInstalled" },
];

/** 窄窗口下「更多 ▾」里的分组维度只有一个入口，所以按固定顺序轮转。 */
const GROUP_BY_ORDER: GroupBy[] = ["category", "status", "author", "installed"];

function labelKeyOfGroupBy(by: GroupBy): MessageKey {
  return GROUP_BYS.find((item) => item.id === by)?.labelKey ?? "library.groupByCategory";
}

export function LibraryView({
  snapshot,
  conflicts,
  frameworks,
  dependencyReport,
  search,
  category,
  sort,
  busyId,
  onCategory,
  onSort,
  onToggle,
  onSwitchVersion,
  onOpen,
  onOpenConflicts,
  onImport,
  onGoSettings,
  onGoDiscover,
  updateMap,
  onUpdateCheck,
  updateChecking = false,
  onApplyUpdates,
  applyingUpdates = false,
  onAiLocBatch,
  aiLocBusy = false,
  onEnrichMetadata,
  enriching = false,
  /** 补全封面（2026-11-01 从设置页挪进工具栏下拉）。 */
  onRefreshCovers,
  refreshingCovers = false,
  onVortexImport,
  onAdopt,
  onRefresh,
  onReclassify,
  reclassifying = false,
  view,
  onViewChange,
  sortDir,
  statusFilter,
  onStatusFilter,
  groupBy,
  onGroupBy,
}: {
  snapshot: Snapshot;
  conflicts: ConflictInfo[];
  frameworks: FrameworkStatus[] | null;
  /** 前置依赖报告（后端 deps.rs 产出）；卡片徽标用它算缺失项。 */
  dependencyReport?: DependencyReport | null;
  search: string;
  category: Category;
  sort: SortMode;
  /** 排序方向。与 sort 分开存，才能表达「体积从小到大」这类反直觉方向。 */
  sortDir: SortDir;
  busyId: string | null;
  onCategory: (category: Category) => void;
  /** 只传字段：方向由上层用 nextSort 推导（换列用默认方向、同列翻转）。 */
  onSort: (field: SortMode) => void;
  onToggle: (mod: ModEntry, enabled: boolean) => void;
  /** 切换同一个 mod 的生效版本（卡片版本下拉的点击回调）。 */
  onSwitchVersion: (mod: ModEntry) => void;
  onOpen: (mod: ModEntry) => void;
  onOpenConflicts: () => void;
  onImport: () => void;
  onGoSettings: () => void;
  onGoDiscover: () => void;
  /** #1 Nexus 更新检查结果（entryId → 条目），卡片打 UPD 徽标。 */
  updateMap?: Map<string, import("../types").NexusUpdateItem>;
  onUpdateCheck: () => void;
  updateChecking?: boolean;
  /** P5-5B：一次性更新所有命中的模组（后端会先备份旧版本）。 */
  onApplyUpdates?: (entryIds: string[]) => void;
  applyingUpdates?: boolean;
  /** AI 汉化批量入口：传入选中的（或全库的）模组 id，进度由 App 里的任务条呈现。 */
  onAiLocBatch?: (entryIds: string[]) => void;
  aiLocBusy?: boolean;
  onEnrichMetadata?: () => void;
  enriching?: boolean;
  /** 批量回查 Nexus 封面（含给丢了引用的收编模组做 ID 溯源）。 */
  onRefreshCovers?: () => void;
  refreshingCovers?: boolean;
  /** 从 Vortex 本地数据库导入元数据（需关闭 Vortex）。 */
  onVortexImport?: () => void;
  /** 收编游戏目录里未受管的模组（多布局扫描）；不传则入口不显示。 */
  onAdopt?: () => void;
  /** 智能归类：默认只动「其他 / 工具」；传 true 时重算全部分类。 */
  onReclassify?: (all: boolean) => void;
  reclassifying?: boolean;
  /** 翻译完成、封面补全等场景下让上层重拉快照。 */
  onRefresh: () => void;
  /** 卡片 / 列表切换（bf7889 反馈）：状态存在偏好里，重启后保持。 */
  view: LibraryViewMode;
  onViewChange: (view: LibraryViewMode) => void;
  /** 状态筛选（全部 / 已启用 / 已禁用 / 缺前置）：存偏好，重启后保持。 */
  statusFilter: StatusFilter;
  onStatusFilter: (filter: StatusFilter) => void;
  /** 列表视图的分组维度（分类 / 状态 / 作者 / 安装月份）：存偏好，重启后保持。 */
  groupBy: GroupBy;
  onGroupBy: (groupBy: GroupBy) => void;
}) {
  const mods = snapshot.state.mods;
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => readCollapsedGroups());
  const [groupMode, setGroupMode] = useState<boolean>(() => readGroupMode());
  const enabledCount = mods.filter((mod) => mod.enabled).length;
  // 「其他」与「工具」都是兜底值：旧引擎把 168 个模组塞进了「工具」，
  // 只数「其他」会让智能归类按钮显示 0，用户以为没得修。
  const unclassifiedCount = mods.filter(
    (mod) =>
      !mod.categoryLocked &&
      (mod.category === "其他" || mod.category === "工具"), // i18n-ignore（B 类持久化值，不是文案）
  ).length;
  const totalBytes = mods.reduce((sum, mod) => sum + mod.sizeBytes, 0);
  // 空状态引导：没绑游戏目录时第一动作是绑定，绑了则引导去发现页/导入。
  const gameLinked = Boolean(snapshot.game?.root);
  const emptyActions =
    mods.length === 0 ? (
      <div className="empty-actions">
        {gameLinked ? (
          <>
            <button className="btn btn-primary" onClick={onImport}>
              <Plus size={15} /> {t("library.import")}
            </button>
            <button className="btn" onClick={onGoDiscover}>
              {t("library.goDiscover")}
            </button>
          </>
        ) : (
          <>
            <button className="btn btn-primary" onClick={onGoSettings}>
              <Plus size={15} /> {t("library.bindFolder")}
            </button>
            <button className="btn" onClick={onImport}>
              {t("library.importZip")}
            </button>
          </>
        )}
      </div>
    ) : undefined;

  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const mod of mods) {
      map.set(mod.category, (map.get(mod.category) ?? 0) + 1);
    }
    // 这两个 key 是筛选用的伪分类（不是持久化数据），与 CATEGORIES 的取值同源。
    map.set("全部", mods.length); // i18n-ignore
    map.set("已启用", enabledCount); // i18n-ignore
    return map;
  }, [mods, enabledCount]);

  // 已绑定父级的汉化包不单独占网格位：它们挂在父级卡片上（「中」徽标 + 详情页
  // 的语言附属包区块）。搜索时如果命中的是子包，父级仍会出现在结果里，因为
  // 子包的名字与父级高度相似，用户几乎不会察觉少了什么。
  const translationCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const mod of mods) {
      if (!mod.parentModId) continue;
      counts.set(mod.parentModId, (counts.get(mod.parentModId) ?? 0) + 1);
    }
    return counts;
  }, [mods]);

  // 前置忽略表变了要重算：`missing` 筛选与卡片上的缺前置徽标都读它。
  // 不订阅的话，在详情页点「忽略此提示」后列表仍是旧结果，用户以为没生效。
  const depIgnoresRev = useSyncExternalStore(subscribeDepIgnores, depIgnoresVersion);

  // 搜索用 deferred 值过滤：输入框的每次按键都不再同步跑一遍全库过滤 + 排序，
  // 251 条时能明显少掉卡顿（2026-11-10 自检 P2·渲染性能）。输入本身仍是即时的。
  const deferredSearch = useDeferredValue(search);

  /**
   * 缺前置清单只跟「模组集合 + 依赖报告 + 框架状态 + 忽略表」有关，跟筛选/排序无关。
   * 先算成一张表：筛选循环和每张可见卡片都查表，避免同一条模组在一次渲染里被算两遍
   * （251 条时可见卡片十几张，每次滚动/输入都重算一遍纯属浪费）。
   */
  const missingDepsById = useMemo(() => {
    const table = new Map<string, string[]>();
    for (const mod of mods) {
      table.set(mod.id, missingDependencyNames(mod, dependencyReport, frameworks));
    }
    return table;
  }, [mods, dependencyReport, frameworks, depIgnoresRev]);

  const filtered = useMemo(() => {
    const needle = deferredSearch.trim().toLowerCase();
    let result = mods.filter((mod) => {
      if (mod.parentModId) return false;
      // 状态筛选与左侧分类筛选是两条独立维度，可以叠加（例：框架 + 已禁用）。
      if (statusFilter === "enabled" && !mod.enabled) return false;
      if (statusFilter === "disabled" && mod.enabled) return false;
      if (
        statusFilter === "missing" &&
        (missingDepsById.get(mod.id)?.length ?? 0) === 0
      ) {
        return false;
      }
      // 以下比较用的是 Category 的原始取值（B 类数据），不可翻译；显示见 categoryLabel()。
      if (category === "已启用" && !mod.enabled) return false; // i18n-ignore
      if (category !== "全部" && category !== "已启用" && mod.category !== category) return false; // i18n-ignore
      if (!needle) return true;
      // 译名可能为 null，空值直接跳过，避免搜索被空串误命中。
      const translated = (mod.translatedName ?? "").trim().toLowerCase();
      return (
        mod.name.toLowerCase().includes(needle) ||
        (translated.length > 0 && translated.includes(needle)) ||
        mod.id.toLowerCase().includes(needle) ||
        (mod.modFolder ?? "").toLowerCase().includes(needle) ||
        (mod.author ?? "").toLowerCase().includes(needle) ||
        mod.category.toLowerCase().includes(needle) ||
        mod.description.toLowerCase().includes(needle)
      );
    });
    // 排序全部交给 compareMods：方向、自然序版本号、并列回落名称都在那里，
    // 这里不再按字段写一串 if——否则每加一列就要在这里再补一遍方向逻辑。
    result = [...result].sort((a, b) => compareMods(a, b, sort, sortDir));
    return result;
  }, [mods, category, deferredSearch, sort, sortDir, statusFilter, missingDepsById]);

  /**
   * 同一 mod 的多版本聚合成一张卡（Vortex 口径：一个 mod 只允许一个版本生效）。
   *
   * 只做展示层聚合，不动库里的数据：代表条目 = 正在启用的那个，否则取版本最高的；
   * 卡上的版本下拉列出全部成员，点击走 `switch_mod_version`（先撤其它版本再部署目标）。
   * 分组与后端 `version_identity` 逐字对应，两边口径必须一致。
   */
  const versionGrouping = useMemo(() => groupVersions(filtered), [filtered]);

  // 折叠键带分组维度前缀（status:on / author:xxx / 分类名…），换维度不会误用旧状态。
  const toggleGroup = (key: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      try {
        window.localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
      } catch {
        // 隐私模式 / 配额满：折叠状态记不住就记不住，不能因此让点击失效。
      }
      return next;
    });
  };

  const toggleGroupMode = () => {
    setGroupMode((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(GROUP_MODE_KEY, next ? "grouped" : "flat");
      } catch {
        // 同上：写不进去只影响下次进来时的默认值。
      }
      return next;
    });
  };

  // 只有「列表视图 + 分组模式」才摊成组头行；其余组合沿用原来的平铺渲染。
  // 传入的是聚合后的代表条目：列表与网格必须同源，否则同一个 mod 在两种视图里
  // 行数不一致，切换视图时滚动锚点也会错位。
  const listItems = useMemo(
    () =>
      view === "list" && groupMode
        ? buildLibraryList(versionGrouping.display, collapsedGroups, true, groupBy)
        : undefined,
    [versionGrouping, collapsedGroups, groupMode, view, groupBy],
  );

  // 这两个集合以前每次渲染都重建：`new Set(...)` 引用不同，会让
  // VirtualModGrid / ModCard 的 props 每帧都变，卡片上的 memo 全部失效
  // （2026-11-10 自检 P2·渲染性能）。
  const conflictTargets = useMemo(
    () => new Set(conflicts.map((conflict) => conflict.target.toLowerCase())).size,
    [conflicts],
  );
  // 有更新的条目集合：传给虚拟列表做角标，同样不能每帧重建。
  const updateIds = useMemo(
    () => (updateMap && updateMap.size > 0 ? new Set(updateMap.keys()) : undefined),
    [updateMap],
  );
  const pendingConflicts = conflicts.filter((conflict) => conflict.pending).length;

  // 「翻译名称」只在真有未翻译的模组时才需要点。
  const untranslated = useMemo(
    () => mods.filter((mod) => (mod.translatedName ?? "").trim().length === 0).length,
    [mods],
  );
  const [confirmTranslate, setConfirmTranslate] = useState(false);
  const [translating, setTranslating] = useState(false);
  const [translateNote, setTranslateNote] = useState<{ ok: boolean; text: string } | null>(null);
  // 右键菜单：记录弹出坐标与目标 Mod；note 是操作结果的轻提示。
  const [contextMenu, setContextMenu] = useState<ModContextMenuState | null>(null);
  // AI 工具弹窗：汉化与补丁共用一个组件，用 mode 区分流程。
  const [aiTool, setAiTool] = useState<{ mod: ModEntry; mode: "loc" | "fix" } | null>(null);
  // 手动改分类：右键菜单（单个）或工具栏「分类」下拉（批量）都走这个面板，
  // 写入即锁定，之后自动归类不再覆盖。
  const [categoryTargets, setCategoryTargets] = useState<ModEntry[]>([]);
  const [categorySaving, setCategorySaving] = useState(false);
  const [menuNote, setMenuNote] = useState<string | null>(null);
  // 集合安装向导：清单路径 + 面板开关。
  const [collectionOpen, setCollectionOpen] = useState(false);
  const [collectionPath, setCollectionPath] = useState<string | null>(null);

  // ── 批量选择（看板【mod 列表及切换功能】）──────────────────────
  // 多选是显式模式：开了才出复选框；选中的集合在关闭模式时清空。
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [batchBusy, setBatchBusy] = useState(false);
  // 结果回显走本页 note（与翻译结果同款），不引 toast。
  const [batchNote, setBatchNote] = useState<{ ok: boolean; text: string } | null>(null);
  const exitSelectMode = () => {
    setSelectMode(false);
    setSelectedIds(new Set());
  };
  const toggleSelected = (modId: string, checked: boolean) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (checked) next.add(modId);
      else next.delete(modId);
      return next;
    });
  };
  const runBatch = async (enabled: boolean) => {
    if (selectedIds.size === 0 || batchBusy) return;
    setBatchBusy(true);
    try {
      const report = await api.setModsEnabled([...selectedIds], enabled);
      onRefresh();
      setBatchNote({
        ok: report.failed.length === 0,
        text:
          report.failed.length > 0
            ? t("library.batchDonePartial", {
                changed: report.changed,
                failed: report.failed.length,
              })
            : t("library.batchDone", { changed: report.changed }),
      });
      exitSelectMode();
    } catch (error) {
      const message =
        error && typeof error === "object" && "message" in error
          ? String((error as { message: unknown }).message)
          : String(error);
      setBatchNote({ ok: false, text: message });
    } finally {
      setBatchBusy(false);
    }
  };
  // 工具栏「导入 ▼」下拉：低频导入动作收进来，给右侧高频操作腾地方。
  const [importMenuOpen, setImportMenuOpen] = useState(false);
  const importMenuRef = useRef<HTMLDivElement | null>(null);
  // 补全下拉：补全信息 + 补全封面合并（原「补全封面」藏在设置页，用户找不到）。
  const [enrichMenuOpen, setEnrichMenuOpen] = useState(false);
  const enrichMenuRef = useRef<HTMLDivElement | null>(null);
  // AI 汉化下拉：与导入下拉同构，但动作是批量任务（进度走任务中心）。
  const [aiMenuOpen, setAiMenuOpen] = useState(false);
  const aiMenuRef = useRef<HTMLDivElement | null>(null);
  // 窄窗口收纳菜单：低频按钮在宽屏直显，窄屏整体收进这个「更多」。两个版本都在 DOM 里，
  // 靠 CSS 切换显示，避免「折叠后事件丢失」那类老坑。
  const [overflowOpen, setOverflowOpen] = useState(false);
  const overflowRef = useRef<HTMLDivElement | null>(null);
  // 工具栏密度：按实测溢出逐级收紧（见下方 useToolbarDensity）。不写死像素阈值。
  const [density, setDensity] = useState<ToolbarDensity>("full");
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  // 批量改分类：选中后直接从工具栏下拉里挑目标分类，一步到位（不弹二次确认）。
  const [catMenuOpen, setCatMenuOpen] = useState(false);
  const catMenuRef = useRef<HTMLDivElement | null>(null);

  useDismissableMenu(importMenuOpen, importMenuRef, () => setImportMenuOpen(false));
  useDismissableMenu(enrichMenuOpen, enrichMenuRef, () => setEnrichMenuOpen(false));
  useDismissableMenu(aiMenuOpen, aiMenuRef, () => setAiMenuOpen(false));
  useDismissableMenu(catMenuOpen, catMenuRef, () => setCatMenuOpen(false));
  useDismissableMenu(overflowOpen, overflowRef, () => setOverflowOpen(false));
  /* 工具栏密度自适应（2026-11-01 用户反馈「列表和补全按钮重叠」）。
   *
   * 为什么不用 @container 固定阈值：全显示实际需要 927px，之前写的 860 留下
   * 860–927 这段「以为装得下、其实装不下」的区间；而 175% 系统缩放、字体渲染差异、
   * 按钮里的数字（归类 (61) / 检查更新 +3）都会改变这个宽度，阈值永远追不上。
   *
   * 这里改为实测：从最宽松一档开始试，量 scrollWidth 是否超过 clientWidth，
   * 装不下就降一档再量，最多三档。收档只改 data-density，按钮本身不收缩，
   * 所以任何时候都不会出现「按钮被压扁、命中区盖住邻居」。
   * 用 rAF 节流 + ResizeObserver（容器变宽变窄）+ MutationObserver（文字/数字变化）。
   */
  // 用 useLayoutEffect：首帧就能定好档位，避免窄窗口下先闪一下「全显示然后溢出」。
  useLayoutEffect(() => {
    const bar = toolbarRef.current;
    if (!bar) return;
    const tiers: ToolbarDensity[] = ["full", "compact", "tight", "mini"];
    let frame = 0;
    const fit = () => {
      // 兜底取最紧一档：全试完还装不下（内容区 < 约 560px，窗口已窄到不像桌面端），
      // 宁可裁掉最右一格，也不要回落到宽松档造成大面积溢出。
      let chosen: ToolbarDensity = "mini";
      for (const tier of tiers) {
        bar.dataset.density = tier;
        if (bar.scrollWidth <= bar.clientWidth + 1) {
          chosen = tier;
          break;
        }
      }
      bar.dataset.density = chosen;
      setDensity((prev) => (prev === chosen ? prev : chosen));
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(fit);
    };
    schedule();
    const observer = new ResizeObserver(schedule);
    observer.observe(bar);
    const mutations = new MutationObserver(schedule);
    mutations.observe(bar, { subtree: true, childList: true, characterData: true });
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      mutations.disconnect();
    };
  }, []);

  /**
   * 选一个集合清单文件（.collection / .json）。
   *
   * 真机上走 Tauri 的系统对话框，能拿到完整路径；浏览器预览模式没有
   * dialog 插件，就先把向导打开，由向导内部的文件选择兜底。
   */
  const pickCollectionManifest = async () => {
    if (!isTauri) {
      setCollectionOpen(true);
      return;
    }
    try {
      const picked = await openDialog({
        multiple: false,
        directory: false,
        filters: [{ name: t("library.collectionFilter"), extensions: ["collection", "json"] }],
      });
      if (typeof picked !== "string") return;
      setCollectionPath(picked);
      setCollectionOpen(true);
    } catch {
      setMenuNote(t("library.openDialogFailed"));
    }
  };

  /**
   * 拖拽导入集合清单。
   *
   * Tauri 的原生拖放事件在 WebView 模式下才有效，HTML5 的 drag/drop 收不到文件。
   * 这里复用 App 里同款 getCurrentWebview().onDragDropEvent，只挑清单文件；
   * 压缩包仍然走 App 自己的导入队列。
   */
  useEffect(() => {
    if (!isTauri) return;
    const promise = getCurrentWebview().onDragDropEvent((event) => {
      if (event.payload.type !== "drop") return;
      const manifest = event.payload.paths.find((path) => isCollectionManifestPath(path));
      if (!manifest) return;
      setCollectionPath(manifest);
      setCollectionOpen(true);
    });
    return () => {
      void promise.then((dispose) => dispose());
    };
  }, []);

  useEffect(() => {
    if (!menuNote) return;
    const timer = window.setTimeout(() => setMenuNote(null), 2800);
    return () => window.clearTimeout(timer);
  }, [menuNote]);

  const handleRepairMod = async (mod: ModEntry) => {
    setMenuNote(t("library.repairing", { name: mod.name }));
    try {
      const report = await api.repairMod(mod.id);
      setMenuNote(t("library.repairDone", { name: mod.name, count: report.deployed }));
      onRefresh();
    } catch (error) {
      // 结构化错误（Rust 回传的 code/message 对象）不是 Error 实例，
      // 直接取 message 会丢掉真实原因，这里统一归一化后再拼。
      const reason = normalizeError(error).message;
      setMenuNote(reason ? t("library.repairFailedDetail", { reason }) : t("library.repairFailed"));
    }
  };

  const handleOpenFolder = async (mod: ModEntry) => {
    try {
      await api.openInExplorer(mod.stagingPath);
    } catch (error) {
      const reason = normalizeError(error).message;
      setMenuNote(reason ? t("library.openFolderFailedDetail", { reason }) : t("library.openFolderFailed"));
    }
  };

  const handleOpenNexus = (mod: ModEntry) => {
    const modId = mod.nexus?.modId;
    if (!modId) {
      setMenuNote(t("library.noNexusPage"));
      return;
    }
    void api
      .openUrl(`https://www.nexusmods.com/cyberpunk2077/mods/${modId}`)
      .catch(() => setMenuNote(t("library.openBrowserFailed")));
  };

  const handleCopyId = async (mod: ModEntry) => {
    try {
      await navigator.clipboard.writeText(mod.id);
      setMenuNote(t("library.copiedId", { id: mod.id.slice(0, 14) }));
    } catch {
      setMenuNote(t("library.clipboardFailed"));
    }
  };

  const runTranslate = async () => {
    setConfirmTranslate(false);
    setTranslating(true);
    setTranslateNote(null);
    try {
      // consent=true：按钮本身就是用户的确认动作，弹窗里也把"会联网"写清楚了。
      const report = await api.translateModNames(true);
      const parts: string[] = [];
      if (report.translated > 0) parts.push(t("library.translateDoneCount", { count: report.translated }));
      if (report.skipped > 0) parts.push(t("library.translateSkipped", { count: report.skipped }));
      if (report.failed > 0) parts.push(t("library.translateFailedCount", { count: report.failed }));
      setTranslateNote({
        ok: report.failed === 0,
        text:
          parts.length > 0
            ? t("library.translateSummary", { parts: parts.join("，") })
            : t("library.translateNothing"),
      });
      if (report.translated > 0) onRefresh();
    } catch (error) {
      const message =
        error && typeof error === "object" && "message" in error
          ? String((error as { message: unknown }).message)
          : String(error);
      setTranslateNote({ ok: false, text: message });
    } finally {
      setTranslating(false);
    }
  };

  return (
    <div className="page library-page">
      <header className="page-head library-head">
        <div>
          <div className="eyebrow">{t("library.eyebrow")}</div>
          <h1>
            {t("sidebar.library")}<span className="h1-accent">.</span>
          </h1>
          <p className="page-sub">
            {t("library.subtitle")}
          </p>
        </div>
        <div className="head-stats">
          <div className="head-stat">
            <span className="head-stat-value">{mods.length}</span>
            <span className="head-stat-label">{t("library.statInstalled")}</span>
          </div>
          <div className="head-stat accent">
            <span className="head-stat-value">{enabledCount}</span>
            <span className="head-stat-label">{t("library.statActive")}</span>
          </div>
          <div className="head-stat">
            <span className="head-stat-value">{formatBytes(totalBytes)}</span>
            <span className="head-stat-label">{t("library.statOnDisk")}</span>
          </div>
          <button
            type="button"
            className={`head-stat conflict-stat ${conflictTargets > 0 ? "danger" : "safe"}`}
            onClick={onOpenConflicts}
            disabled={conflictTargets === 0}
            title={
              conflictTargets > 0
                ? pendingConflicts
                  ? t("library.conflictTitlePending", {
                      count: conflictTargets,
                      pending: pendingConflicts,
                    })
                  : t("library.conflictTitle", { count: conflictTargets })
                : t("library.conflictNone")
            }
          >
            <span className="head-stat-value">
              {conflictTargets > 0 ? conflictTargets : <ShieldCheck size={19} />}
            </span>
            <span className="head-stat-label">
              {conflictTargets > 0 ? t("library.statConflicts") : t("library.statClean")}
            </span>
          </button>
        </div>
      </header>

      <div className="library-layout">
        <aside className="category-rail">
          <div className="rail-label">{t("library.railCollections")}</div>
          <div className="category-list">
            {CATEGORIES.map((item) => {
              // 图标按分类取值选（数据值）；展示文案走 categoryLabel。
              const Icon = categoryIcon(item === "已启用" ? "框架" : item); // i18n-ignore
              const active = category === item;
              const count = counts.get(item) ?? 0;
              return (
                <button
                  key={item}
                  className={`category-item ${active ? "active" : ""}`}
                  onClick={() => onCategory(item)}
                >
                  {item === "全部" ? ( // i18n-ignore
                    <PackageOpen size={14} />
                  ) : item === "已启用" ? ( // i18n-ignore
                    <span className="active-pip" />
                  ) : (
                    <Icon size={14} />
                  )}
                  <span>{categoryLabel(item)}</span>
                  <b>{count}</b>
                </button>
              );
            })}
          </div>

          <div className="rail-note">
            <AlertTriangle size={13} />
            <p>
              {t("library.railNote")}
            </p>
          </div>

          <button className="rail-import" onClick={onImport}>
            <Plus size={15} /> {t("library.import")}
          </button>
        </aside>

        <section className="library-main">
          {/* 工具栏左右分区：左侧 = 视图与过滤（数量 / 智能归类 / 排序），
              右侧 = 操作（导入菜单 / 检查更新 / 补全信息 / 翻译名称）。
              两区都允许换行，窗口窄时右侧自动折行，不挤压变形。 */}
          {/* 工具栏：左「看什么」/ 右「做什么」，两组之间 24px、组内 8px。
              窄窗口不折行：低频按钮（补全信息 / 导入 / 分组）由 CSS 收进右侧「更多 ▾」，
              两个版本都在 DOM 里，只是显示/隐藏切换，事件不会丢。 */}
          <div
            className="library-toolbar"
            role="toolbar"
            aria-label={t("library.toolbarAria")}
            ref={toolbarRef}
            data-density={density}
          >
            {/* ── 视图与过滤组（控制"怎么看"）────────────────────── */}
            <div className="toolbar-group toolbar-group--view">
              <div className="result-line">
                {/* 计数与卡片数一致：多版本聚合成一张卡，这里报的也是「卡数」，
                    否则「显示 251 结果」配 238 张卡会让人以为有卡没渲染出来。
                    真实条目数在右侧「已安装」里仍然完整。 */}
                <span className="result-count">
                  {String(versionGrouping.display.length).padStart(2, "0")}
                </span>
                <span className="result-label">{t("library.resultsLabel")}</span>
                {search ? <span className="result-query">“{search}”</span> : null}
                {versionGrouping.groups.size > 0 ? (
                  <span
                    className="result-merged"
                    title={t("library.versionMergedTitle", { count: versionGrouping.groups.size })}
                  >
                    {t("library.versionMergedChip", { count: versionGrouping.groups.size })}
                  </span>
                ) : null}
              </div>

              <label className="sort-control" title={t("library.statusFilterTitle")}>
                <ListFilter size={13} />
                <select
                  value={statusFilter}
                  onChange={(event) => onStatusFilter(event.target.value as StatusFilter)}
                  aria-label={t("library.statusFilterAria")}
                >
                  {STATUS_FILTERS.map((item) => (
                    <option key={item.id} value={item.id}>
                      {t(item.labelKey)}
                    </option>
                  ))}
                </select>
              </label>

              {/* 排序下拉：换字段时方向走该字段的默认值（体积→大到小、名称→A→Z），
                  与点列头同一套规则，所以这里也只传字段名。 */}
              {/* 方向按钮并进排序框内部，不单独占一个 36px 的格子。
                  原因：1440 下工具栏只剩 24px 余量，独立按钮会把密度档从 full 挤到
                  compact，「补全」「导入方式」就被收进「更多」了（check-toolbar 的
                  「宽屏低频按钮直显」会红）。并进来只多花十几像素，语义也更紧：
                  这个框管的就是「按什么排 + 往哪排」。
                  用 div 不用 label：里面装了 button，label 会把点击转发给 select，
                  点方向箭头时会顺手弹出下拉。 */}
              <div className="sort-control sort-control--dir" title={t("library.sortControlTitle")}>
                <select
                  value={sort}
                  onChange={(event) => onSort(event.target.value as SortMode)}
                  aria-label={t("library.sortControlAria")}
                >
                  {SORTS.map((item) => (
                    <option key={item.id} value={item.id}>
                      {t(item.labelKey)}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="sort-dir-btn"
                  onClick={() => onSort(sort)}
                  title={t("library.sortToggleDir")}
                  aria-label={t("library.sortToggleDir")}
                >
                  {sortDir === "asc" ? (
                    <ArrowUp size={12} strokeWidth={2.6} />
                  ) : (
                    <ArrowDown size={12} strokeWidth={2.6} />
                  )}
                </button>
              </div>

              {view === "list" ? (
                <button
                  type="button"
                  className={`btn btn-ghost btn-sm is-low-frequency ${groupMode ? "btn-accent" : ""}`}
                  onClick={toggleGroupMode}
                  aria-pressed={groupMode}
                  title={t("library.groupModeTitle")}
                >
                  <Layers size={13} />
                  {groupMode ? t("library.groupModeGrouped") : t("library.groupModeFlat")}
                </button>
              ) : null}

              {/* 分组维度：只在「列表 + 已分组」时才有意义，平铺时不出现。 */}
              {view === "list" && groupMode ? (
                <label className="sort-control is-group-by" title={t("library.groupByTitle")}>
                  <Boxes size={13} />
                  <select
                    value={groupBy}
                    onChange={(event) => onGroupBy(event.target.value as GroupBy)}
                    aria-label={t("library.groupByAria")}
                  >
                    {GROUP_BYS.map((item) => (
                      <option key={item.id} value={item.id}>
                        {t(item.labelKey)}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}

              <div className="view-switch" role="group" aria-label={t("library.viewToggleAria")}>
                <button
                  type="button"
                  className={`view-switch-btn ${view === "grid" ? "is-active" : ""}`}
                  onClick={() => onViewChange("grid")}
                  aria-pressed={view === "grid"}
                  data-view="grid"
                  title={t("library.viewGrid")}
                >
                  <LayoutGrid size={13} />
                </button>
                <button
                  type="button"
                  className={`view-switch-btn ${view === "list" ? "is-active" : ""}`}
                  onClick={() => onViewChange("list")}
                  aria-pressed={view === "list"}
                  data-view="list"
                  title={t("library.viewList")}
                >
                  <List size={13} />
                </button>
              </div>
            </div>

            {/* ── 动作与工具组（控制"做什么"）────────────────────── */}
            <div className="toolbar-group toolbar-group--actions">
              <button
                type="button"
                className="btn btn-ghost btn-sm is-medium"
                onClick={(event) => onReclassify?.(event.shiftKey)}
                disabled={reclassifying || !onReclassify}
                title={t("library.reclassifyTitle")}
              >
                {reclassifying ? <Spinner size={13} /> : <FolderTree size={13} />}
                {t("library.reclassify")}
                {unclassifiedCount > 0 ? ` (${unclassifiedCount})` : ""}
              </button>

              <button
                type="button"
                className={`btn btn-ghost btn-sm is-mini-hide ${selectMode ? "btn-accent" : ""}`}
                onClick={() => (selectMode ? exitSelectMode() : setSelectMode(true))}
                aria-pressed={selectMode}
                title={t("library.selectModeTitle")}
              >
                <ListChecks size={13} />
                {t("library.selectMode")}
                {selectMode && selectedIds.size > 0 ? ` (${selectedIds.size})` : ""}
              </button>

              {/* AI 工具：原来的「AI 汉化 ▾」与「翻译名称」合并到这里，
                  三个菜单项各自绑原来的 handler，逻辑一行没动。 */}
              <div className="toolbar-menu" ref={aiMenuRef}>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => setAiMenuOpen((value) => !value)}
                  aria-expanded={aiMenuOpen}
                  title={t("library.aiToolsTitle")}
                >
                  <Sparkles size={13} />
                  {t("library.aiTools")}
                  <ChevronDown size={12} className={`dropdown-caret ${aiMenuOpen ? "is-open" : ""}`} />
                </button>
                {aiMenuOpen ? (
                  <div className="toolbar-menu-panel" role="menu">
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setAiMenuOpen(false);
                        setConfirmTranslate(true);
                      }}
                      disabled={translating || untranslated === 0}
                      title={
                        untranslated === 0
                          ? t("library.translateAllDone")
                          : t("library.translateTitle", { count: untranslated })
                      }
                    >
                      {translating ? <Spinner size={13} /> : <Languages size={13} />}
                      {t("library.translateListNames", { count: untranslated })}
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setAiMenuOpen(false);
                        onAiLocBatch?.([...selectedIds]);
                      }}
                      disabled={selectedIds.size === 0 || aiLocBusy || !onAiLocBatch}
                    >
                      {aiLocBusy ? <Spinner size={13} /> : <Languages size={13} />}
                      {t("library.aiLocSelected", { count: selectedIds.size })}
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setAiMenuOpen(false);
                        onAiLocBatch?.(mods.map((mod) => mod.id));
                      }}
                      disabled={aiLocBusy || mods.length === 0 || !onAiLocBatch}
                    >
                      <Languages size={13} />
                      {t("library.aiLocAll", { count: mods.length })}
                    </button>
                  </div>
                ) : null}
              </div>

              {/* 检查更新：全工具栏唯一的强调按钮（主题色描边 + 文字）。 */}
              <button
                type="button"
                className="btn btn-ghost btn-sm btn-accent"
                onClick={onUpdateCheck}
                disabled={updateChecking}
                title={t("library.checkUpdatesTitle")}
              >
                {updateChecking ? <Spinner size={13} /> : <RefreshCw size={13} />}
                {t("library.checkUpdates")}
                {(updateMap?.size ?? 0) > 0 ? t("library.updateCountSuffix", { count: updateMap!.size }) : ""}
              </button>
              {(updateMap?.size ?? 0) > 0 ? (
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  onClick={() => onApplyUpdates?.([...(updateMap?.keys() ?? [])])}
                  disabled={applyingUpdates || !onApplyUpdates}
                  title={t("library.applyAllTitle")}
                >
                  {applyingUpdates ? <Spinner size={13} /> : <Download size={13} />}
                  {t("library.applyAll")}
                </button>
              ) : null}

              {/* 低频：宽屏直显，窄屏由容器查询收进「更多 ▾」。
                  补全信息 / 补全封面合并成一个下拉——「补全封面」原先藏在设置页
                  最深处，用户反馈根本找不到，挪到工具栏与补全信息并列。 */}
              <div className="toolbar-menu is-low-frequency" ref={enrichMenuRef}>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => setEnrichMenuOpen((value) => !value)}
                  aria-expanded={enrichMenuOpen}
                  title={t("library.enrichTitle")}
                >
                  {enriching || refreshingCovers ? <Spinner size={13} /> : <Wand2 size={13} />}
                  {t("library.enrich")}
                  <ChevronDown size={12} className={`dropdown-caret ${enrichMenuOpen ? "is-open" : ""}`} />
                </button>
                {enrichMenuOpen ? (
                  <div className="toolbar-menu-panel" role="menu">
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setEnrichMenuOpen(false);
                        onEnrichMetadata?.();
                      }}
                      disabled={enriching || refreshingCovers || !onEnrichMetadata}
                      title={t("library.enrichTitle")}
                    >
                      {enriching ? <Spinner size={13} /> : <Wand2 size={13} />}
                      {t("library.enrichInfo")}
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setEnrichMenuOpen(false);
                        onRefreshCovers?.();
                      }}
                      disabled={enriching || refreshingCovers || !onRefreshCovers}
                      title={t("library.enrichCoversTitle")}
                    >
                      {refreshingCovers ? <Spinner size={13} /> : <ImageDown size={13} />}
                      {t("library.enrichCovers")}
                    </button>
                  </div>
                ) : null}
              </div>

              <div className="toolbar-menu is-low-frequency" ref={importMenuRef}>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => setImportMenuOpen((value) => !value)}
                  aria-expanded={importMenuOpen}
                  title={t("library.importMenuTitle")}
                >
                  <Plus size={13} />
                  {t("library.importMenu")}
                  <ChevronDown size={12} className={`dropdown-caret ${importMenuOpen ? "is-open" : ""}`} />
                </button>
                {importMenuOpen ? (
                  <div className="toolbar-menu-panel" role="menu">
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setImportMenuOpen(false);
                        onVortexImport?.();
                      }}
                      disabled={enriching || !onVortexImport}
                      title={t("library.vortexTitle")}
                    >
                      {enriching ? <Spinner size={13} /> : <PackageOpen size={13} />}
                      {t("library.vortexImport")}
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setImportMenuOpen(false);
                        void pickCollectionManifest();
                      }}
                      title={t("library.importManifestTitle")}
                    >
                      <FileJson size={13} />
                      {t("library.importManifest")}
                    </button>
                  </div>
                ) : null}
              </div>

              {/* 窄屏收纳：默认 display:none，容器变窄才出现。 */}
              <div className="toolbar-menu toolbar-overflow" ref={overflowRef}>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => setOverflowOpen((value) => !value)}
                  aria-expanded={overflowOpen}
                  title={t("library.moreTitle")}
                >
                  <MoreHorizontal size={13} />
                  {t("library.more")}
                </button>
                {overflowOpen ? (
                  <div className="toolbar-menu-panel" role="menu">
                    {/* 多选只在 mini 档（按钮已被收起）时补在这里，
                        否则会和工具栏上常驻的「多选」重复。 */}
                    {density === "mini" ? (
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setOverflowOpen(false);
                          if (selectMode) {
                            exitSelectMode();
                          } else {
                            setSelectMode(true);
                          }
                        }}
                      >
                        <ListChecks size={13} />
                        {t("library.selectMode")}
                      </button>
                    ) : null}
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setOverflowOpen(false);
                        onAdopt?.();
                      }}
                      disabled={!onAdopt}
                      title={t("library.adoptTitle")}
                    >
                      <Layers size={13} />
                      {t("library.adoptExisting")}
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setOverflowOpen(false);
                        onEnrichMetadata?.();
                      }}
                      disabled={enriching || refreshingCovers || !onEnrichMetadata}
                    >
                      <Wand2 size={13} />
                      {t("library.enrichInfo")}
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setOverflowOpen(false);
                        onRefreshCovers?.();
                      }}
                      disabled={enriching || refreshingCovers || !onRefreshCovers}
                    >
                      <ImageDown size={13} />
                      {t("library.enrichCovers")}
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setOverflowOpen(false);
                        onVortexImport?.();
                      }}
                      disabled={enriching || !onVortexImport}
                    >
                      <PackageOpen size={13} />
                      {t("library.vortexImport")}
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setOverflowOpen(false);
                        void pickCollectionManifest();
                      }}
                    >
                      <FileJson size={13} />
                      {t("library.importManifest")}
                    </button>
                    {view === "list" ? (
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setOverflowOpen(false);
                          toggleGroupMode();
                        }}
                      >
                        <Layers size={13} />
                        {groupMode ? t("library.groupModeGrouped") : t("library.groupModeFlat")}
                      </button>
                    ) : null}
                    {/* 窄窗口里分组维度的下拉会被工具栏挤没，这里留一个轮转入口：
                        按顺序切下一个维度，标题里写明下一个是什么。 */}
                    {view === "list" && groupMode ? (
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setOverflowOpen(false);
                          const index = GROUP_BY_ORDER.indexOf(groupBy);
                          onGroupBy(GROUP_BY_ORDER[(index + 1) % GROUP_BY_ORDER.length]);
                        }}
                        title={t("library.groupByCycleTitle", {
                          next: t(
                            labelKeyOfGroupBy(
                              GROUP_BY_ORDER[
                                (GROUP_BY_ORDER.indexOf(groupBy) + 1) % GROUP_BY_ORDER.length
                              ],
                            ),
                          ),
                        })}
                      >
                        <Boxes size={13} />
                        {t(labelKeyOfGroupBy(groupBy))}
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </div>
          </div>

          {translateNote ? (
            <p className={`inline-note ${translateNote.ok ? "inline-ok" : "inline-warning"} compact`}>
              {translateNote.text}
            </p>
          ) : null}

          {selectMode ? (
            <div className="batch-bar" role="toolbar" aria-label={t("library.selectModeTitle")}>
              <span className="batch-count">
                {t("library.batchSelected", { count: selectedIds.size })}
              </span>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={() => void runBatch(true)}
                disabled={selectedIds.size === 0 || batchBusy}
              >
                {batchBusy ? <Spinner size={13} /> : null}
                {t("library.batchEnable")}
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => void runBatch(false)}
                disabled={selectedIds.size === 0 || batchBusy}
              >
                {t("library.batchDisable")}
              </button>

              {/* 批量改分类：选完立即写入并锁定（自动归类不再覆盖）。 */}
              <div className="import-dropdown" ref={catMenuRef}>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => setCatMenuOpen((value) => !value)}
                  aria-expanded={catMenuOpen}
                  disabled={selectedIds.size === 0}
                  title={t("library.batchCategoryTitle")}
                >
                  <Tag size={13} />
                  {t("library.batchCategory")}
                  <ChevronDown size={12} className={`dropdown-caret ${catMenuOpen ? "is-open" : ""}`} />
                </button>
                {catMenuOpen ? (
                  <div className="import-menu" role="menu">
                    {CATEGORIES.filter((item) => item !== "全部" && item !== "已启用").map((item) => ( // i18n-ignore
                      <button
                        key={item}
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setCatMenuOpen(false);
                          const ids = [...selectedIds];
                          void api
                            .setModsCategory(ids, item)
                            .then((changed) => {
                              setBatchNote({ ok: true, text: t("library.categorySaved", { count: changed }) });
                              onRefresh();
                            })
                            .catch(() => {
                              setBatchNote({ ok: false, text: t("library.categorySaveFailed") });
                            });
                        }}
                      >
                        {categoryLabel(item)}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => setSelectedIds(new Set(filtered.map((mod) => mod.id)))}
                disabled={batchBusy}
              >
                {t("library.batchSelectAll")}
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm btn-icon-only"
                onClick={exitSelectMode}
                title={t("library.batchCancel")}
              >
                <X size={13} />
              </button>
              {batchNote ? (
                <span className={`batch-note ${batchNote.ok ? "inline-ok" : "inline-warning"}`}>
                  {batchNote.text}
                </span>
              ) : null}
            </div>
          ) : null}

          {filtered.length === 0 ? (
            <EmptyState
              icon={search ? <SearchX size={26} /> : <PackageOpen size={26} />}
              code={
                search
                  ? t("library.emptySearchCode")
                  : mods.length === 0
                    ? t("library.emptyStagingCode")
                    : t("library.emptyCategoryCode")
              }
              kicker={
                search
                  ? t("library.emptySearchKicker")
                  : mods.length === 0
                    ? t("library.emptyStagingKicker")
                    : t("library.emptyCategoryKicker")
              }
              title={
                search
                  ? t("library.emptySearchTitle")
                  : mods.length === 0
                    ? t("library.emptyStagingTitle")
                    : t("library.emptyCategoryTitle")
              }
              detail={
                search
                  ? t("library.emptySearchDetail", { query: search })
                  : mods.length === 0
                    ? t("library.emptyStagingDetail")
                    : t("library.emptyCategoryDetail")
              }
              action={emptyActions}
            />
          ) : (
            <VirtualModGrid
              filterKey={`${category}:${sort}:${sortDir}:${statusFilter}:${groupMode ? groupBy : "flat"}`}
              view={view}
              mods={versionGrouping.display}
              versionGroups={versionGrouping.groups}
              onSwitchVersion={onSwitchVersion}
              listItems={listItems}
              listHeader={
                <ModListHeader
                  sort={sort}
                  sortDir={sortDir}
                  onSort={onSort}
                  selectable={selectMode}
                  grouped={groupMode}
                />
              }
              onToggleGroup={toggleGroup}
              conflicts={conflicts}
              missingDepsById={missingDepsById}
              translationCounts={translationCounts}
              busyId={busyId}
              updateIds={updateIds}
              selectable={selectMode}
              selectedIds={selectedIds}
              onSelectChange={toggleSelected}
              onToggle={onToggle}
              onOpen={onOpen}
              onContextMenu={(mod, event) =>
                setContextMenu({ mod, x: event.clientX, y: event.clientY })
              }
            />
          )}
        </section>
      </div>

      <ConfirmDialog
        open={confirmTranslate}
        title={t("library.translateConfirmTitle")}
        detail={
          <>
            <p>
              {t("library.translateConfirmLead")}
              <b>{untranslated}</b>
              {t("library.translateConfirmTail")}
            </p>
            <p className="panel-note">
              {t("library.translateConfirmNoteLead")}
              <b>{t("library.translateConfirmNoteBold")}</b>
              {t("library.translateConfirmNoteTail")}
            </p>
          </>
        }
        confirmLabel={t("library.translateConfirmCta")}
        busy={translating}
        onConfirm={() => void runTranslate()}
        onClose={() => setConfirmTranslate(false)}
      />

      <CollectionWizard
        open={collectionOpen}
        manifestPath={collectionPath}
        onClose={() => setCollectionOpen(false)}
        onRefresh={onRefresh}
        onImportMods={onImport}
        onPickFile={() => void pickCollectionManifest()}
        onManifestPicked={(path) => setCollectionPath(path)}
      />

      {contextMenu ? (
        <ModContextMenu
          state={contextMenu}
          onClose={() => setContextMenu(null)}
          onToggle={(mod) => onToggle(mod, !mod.enabled)}
          onRepair={(mod) => void handleRepairMod(mod)}
          onOpenFolder={(mod) => void handleOpenFolder(mod)}
          onOpenNexus={handleOpenNexus}
          onCopyId={(mod) => void handleCopyId(mod)}
          onChangeCategory={(mod) => setCategoryTargets([mod])}
          onAiTranslate={(mod) => setAiTool({ mod, mode: "loc" })}
          onAiPatch={(mod) => setAiTool({ mod, mode: "fix" })}
        />
      ) : null}

      <AiToolsDialog
        open={aiTool !== null}
        mod={aiTool?.mod ?? null}
        mode={aiTool?.mode ?? "loc"}
        onClose={() => setAiTool(null)}
        onDone={onRefresh}
      />

      <Modal
        open={categoryTargets.length > 0}
        title={
          categoryTargets.length > 1
            ? t("library.categoryDialogTitleBatch", { count: categoryTargets.length })
            : t("library.categoryDialogTitle")
        }
        eyebrow="// CATEGORY"
        onClose={() => setCategoryTargets([])}
        width={460}
      >
        <p className="category-dialog-hint">{t("library.categoryDialogHint")}</p>
        <div className="category-picker">
          {/* 「全部」「已启用」是筛选用的伪分类，不是可选的目标分类（B 类持久化值） */}
          {CATEGORIES.filter((item) => item !== "全部" && item !== "已启用").map((item) => { // i18n-ignore
            // 批量时只有「全部相同」才算当前值，否则不高亮，避免误导。
            const current =
              categoryTargets.length > 0 && categoryTargets.every((mod) => mod.category === item);
            return (
              <button
                key={item}
                type="button"
                className={`category-chip${current ? " is-current" : ""}`}
                disabled={categorySaving}
                onClick={() => {
                  const targets = categoryTargets;
                  if (targets.length === 0 || current) {
                    setCategoryTargets([]);
                    return;
                  }
                  setCategorySaving(true);
                  const ids = targets.map((mod) => mod.id);
                  const request =
                    ids.length === 1
                      ? api.setModCategory(ids[0], item).then(() => 1)
                      : api.setModsCategory(ids, item);
                  void request
                    .then((changed) => {
                      setCategoryTargets([]);
                      setMenuNote(t("library.categorySaved", { count: changed }));
                      onRefresh();
                    })
                    .catch(() => {
                      setMenuNote(t("library.categorySaveFailed"));
                    })
                    .finally(() => setCategorySaving(false));
                }}
              >
                {categoryLabel(item)}
              </button>
            );
          })}
        </div>
      </Modal>

      {menuNote ? <div className="library-note">{menuNote}</div> : null}
    </div>
  );
}
