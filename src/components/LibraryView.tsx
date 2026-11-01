import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowDownUp,
  ChevronDown,
  FileJson,
  FolderTree,
  Languages,
  Layers,
  LayoutGrid,
  List,
  ListChecks,
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
import { api, isTauri } from "../lib/api";
import { isCollectionManifestPath } from "../lib/collection";
import type { LibraryView as LibraryViewMode } from "../lib/preferences";
import { VirtualModGrid } from "./VirtualModGrid";
import { buildLibraryList } from "../lib/libraryList";
import { missingDependencyNames } from "../lib/dependencies";
import { ModContextMenu, type ModContextMenuState } from "./ModContextMenu";
import { AiToolsDialog } from "./AiToolsDialog";
import { CollectionWizard } from "./CollectionWizard";
import { ConfirmDialog, EmptyState, Modal, Spinner } from "./ui";
import { categoryLabel, t, type MessageKey } from "../i18n";

export type SortMode = "name" | "recent" | "size" | "status";

/** 列表视图的状态筛选。分类型筛选（左侧导航）和状态筛选是两条独立维度，可以叠加。 */
type StatusFilter = "all" | "enabled" | "disabled" | "missing";

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

const SORTS: Array<{ id: SortMode; label: string }> = [
  { id: "name", label: t("library.sortName") },
  { id: "recent", label: t("library.sortRecent") },
  { id: "size", label: t("library.sortSize") },
  { id: "status", label: t("library.sortStatus") },
];

/** 展示名：有中文译名时用译名，否则回退原名。排序与卡片标题共用同一规则。 */
function displayNameOf(mod: ModEntry): string {
  const translated = (mod.translatedName ?? "").trim();
  return translated.length > 0 ? translated : mod.name;
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
  onVortexImport,
  onRefresh,
  onReclassify,
  reclassifying = false,
  view,
  onViewChange,
}: {
  snapshot: Snapshot;
  conflicts: ConflictInfo[];
  frameworks: FrameworkStatus[] | null;
  /** 前置依赖报告（后端 deps.rs 产出）；卡片徽标用它算缺失项。 */
  dependencyReport?: DependencyReport | null;
  search: string;
  category: Category;
  sort: SortMode;
  busyId: string | null;
  onCategory: (category: Category) => void;
  onSort: (sort: SortMode) => void;
  onToggle: (mod: ModEntry, enabled: boolean) => void;
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
  /** 从 Vortex 本地数据库导入元数据（需关闭 Vortex）。 */
  onVortexImport?: () => void;
  /** 智能归类：默认只动「其他 / 工具」；传 true 时重算全部分类。 */
  onReclassify?: (all: boolean) => void;
  reclassifying?: boolean;
  /** 翻译完成、封面补全等场景下让上层重拉快照。 */
  onRefresh: () => void;
  /** 卡片 / 列表切换（bf7889 反馈）：状态存在偏好里，重启后保持。 */
  view: LibraryViewMode;
  onViewChange: (view: LibraryViewMode) => void;
}) {
  const mods = snapshot.state.mods;
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
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

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    let result = mods.filter((mod) => {
      if (mod.parentModId) return false;
      // 状态筛选与左侧分类筛选是两条独立维度，可以叠加（例：框架 + 已禁用）。
      if (statusFilter === "enabled" && !mod.enabled) return false;
      if (statusFilter === "disabled" && mod.enabled) return false;
      if (
        statusFilter === "missing" &&
        missingDependencyNames(mod, dependencyReport, frameworks).length === 0
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
    result = [...result].sort((a, b) => {
      // 名称排序统一走「展示名」，中文列表才不会中英混排。
      if (sort === "name") return displayNameOf(a).localeCompare(displayNameOf(b), "zh-CN");
      if (sort === "recent") return (b.installedAt ?? "").localeCompare(a.installedAt ?? "");
      if (sort === "size") return b.sizeBytes - a.sizeBytes;
      return (
        Number(b.enabled) - Number(a.enabled) ||
        displayNameOf(a).localeCompare(displayNameOf(b), "zh-CN")
      );
    });
    return result;
  }, [mods, category, search, sort, statusFilter, dependencyReport, frameworks]);

  const toggleGroup = (categoryKey: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(categoryKey)) next.delete(categoryKey);
      else next.add(categoryKey);
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
  const listItems = useMemo(
    () => (view === "list" && groupMode ? buildLibraryList(filtered, collapsedGroups, true) : undefined),
    [filtered, collapsedGroups, groupMode, view],
  );

  const conflictTargets = new Set(conflicts.map((conflict) => conflict.target.toLowerCase())).size;
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
  // 手动改分类：右键菜单选中模组后弹这个面板，写入即锁定。
  const [categoryTarget, setCategoryTarget] = useState<ModEntry | null>(null);
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
  // AI 汉化下拉：与导入下拉同构，但动作是批量任务（进度走任务中心）。
  const [aiMenuOpen, setAiMenuOpen] = useState(false);
  const aiMenuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!importMenuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (importMenuRef.current && !importMenuRef.current.contains(event.target as Node)) {
        setImportMenuOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setImportMenuOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [importMenuOpen]);

  useEffect(() => {
    if (!aiMenuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (aiMenuRef.current && !aiMenuRef.current.contains(event.target as Node)) {
        setAiMenuOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setAiMenuOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [aiMenuOpen]);

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
      setMenuNote(error instanceof Error ? error.message : t("library.repairFailed"));
    }
  };

  const handleOpenFolder = async (mod: ModEntry) => {
    try {
      await api.openInExplorer(mod.stagingPath);
    } catch (error) {
      setMenuNote(error instanceof Error ? error.message : t("library.openFolderFailed"));
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
          <div className="library-toolbar">
            <div className="toolbar-left">
              <div className="result-line">
                <span className="result-count">{String(filtered.length).padStart(2, "0")}</span>
                <span className="result-label">{t("library.resultsLabel")}</span>
                {search ? <span className="result-query">“{search}”</span> : null}
              </div>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={(event) => onReclassify?.(event.shiftKey)}
                disabled={reclassifying || !onReclassify}
                title={t("library.reclassifyTitle")}
              >
                {reclassifying ? <Spinner size={13} /> : <FolderTree size={13} />}
                {t("library.reclassify")}
                {unclassifiedCount > 0 ? ` (${unclassifiedCount})` : ""}
              </button>
              <label className="sort-control" title={t("library.statusFilterTitle")}>
                <ListFilter size={13} />
                <select
                  value={statusFilter}
                  onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}
                  aria-label={t("library.statusFilterAria")}
                >
                  {STATUS_FILTERS.map((item) => (
                    <option key={item.id} value={item.id}>
                      {t(item.labelKey)}
                    </option>
                  ))}
                </select>
              </label>
              {view === "list" ? (
                <button
                  type="button"
                  className={`btn btn-ghost btn-sm ${groupMode ? "btn-accent" : ""}`}
                  onClick={toggleGroupMode}
                  aria-pressed={groupMode}
                  title={t("library.groupModeTitle")}
                >
                  <Layers size={13} />
                  {groupMode ? t("library.groupModeGrouped") : t("library.groupModeFlat")}
                </button>
              ) : null}
              <label className="sort-control">
                <ArrowDownUp size={13} />
                <select value={sort} onChange={(event) => onSort(event.target.value as SortMode)}>
                  {SORTS.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className={`btn btn-ghost btn-sm ${selectMode ? "btn-accent" : ""}`}
                onClick={() => (selectMode ? exitSelectMode() : setSelectMode(true))}
                aria-pressed={selectMode}
                title={t("library.selectModeTitle")}
              >
                <ListChecks size={13} />
                {t("library.selectMode")}
                {selectMode && selectedIds.size > 0 ? ` (${selectedIds.size})` : ""}
              </button>
            </div>

            <div className="toolbar-right">
              {/* 视图切换：网格 / 列表。放在右侧操作区的第一位，紧邻导入与批量动作，
                  图标按钮不带文字，靠 title + aria-pressed 表达状态。 */}
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
              {/* AI 汉化批量入口：选中优先，其次全库。真正执行在 App（任务中心可见进度）。 */}
              <div className="import-dropdown" ref={aiMenuRef}>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => setAiMenuOpen((value) => !value)}
                  aria-expanded={aiMenuOpen}
                  title={t("library.aiLocMenuTitle")}
                  disabled={!onAiLocBatch}
                >
                  <Languages size={13} />
                  {t("library.aiLocMenu")}
                  <ChevronDown size={12} className={`dropdown-caret ${aiMenuOpen ? "is-open" : ""}`} />
                </button>
                {aiMenuOpen ? (
                  <div className="import-menu" role="menu">
                    <button
                      type="button"
                      role="menuitem"
                      disabled={selectedIds.size === 0 || aiLocBusy}
                      onClick={() => {
                        setAiMenuOpen(false);
                        onAiLocBatch?.([...selectedIds]);
                      }}
                    >
                      {aiLocBusy ? <Spinner size={13} /> : <Languages size={13} />}
                      {t("library.aiLocSelected", { count: selectedIds.size })}
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      disabled={aiLocBusy || mods.length === 0}
                      onClick={() => {
                        setAiMenuOpen(false);
                        onAiLocBatch?.(mods.map((mod) => mod.id));
                      }}
                    >
                      <Languages size={13} />
                      {t("library.aiLocAll", { count: mods.length })}
                    </button>
                  </div>
                ) : null}
              </div>

              {/* 低频导入收成下拉：Vortex 元数据 + 集合清单 ZIP */}
              <div className="import-dropdown" ref={importMenuRef}>
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
                  <div className="import-menu" role="menu">
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
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={onEnrichMetadata}
                disabled={enriching || !onEnrichMetadata}
                title={t("library.enrichTitle")}
              >
                {enriching ? <Spinner size={13} /> : <Wand2 size={13} />}
                {t("library.enrich")}
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm btn-accent"
                onClick={() => setConfirmTranslate(true)}
                disabled={translating || untranslated === 0}
                title={
                  untranslated === 0
                    ? t("library.translateAllDone")
                    : t("library.translateTitle", { count: untranslated })
                }
              >
                {translating ? <Spinner size={13} /> : <Languages size={13} />}
                {t("library.translate")}
              </button>
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
              filterKey={`${category}:${sort}:${statusFilter}`}
              view={view}
              mods={filtered}
              listItems={listItems}
              onToggleGroup={toggleGroup}
              conflicts={conflicts}
              frameworks={frameworks}
              dependencyReport={dependencyReport}
              translationCounts={translationCounts}
              busyId={busyId}
              updateIds={
                updateMap && updateMap.size > 0 ? new Set(updateMap.keys()) : undefined
              }
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
          onChangeCategory={setCategoryTarget}
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
        open={categoryTarget !== null}
        title={t("library.categoryDialogTitle")}
        eyebrow="// CATEGORY"
        onClose={() => setCategoryTarget(null)}
        width={460}
      >
        <p className="category-dialog-hint">{t("library.categoryDialogHint")}</p>
        <div className="category-picker">
          {/* 「全部」「已启用」是筛选用的伪分类，不是可选的目标分类（B 类持久化值） */}
          {CATEGORIES.filter((item) => item !== "全部" && item !== "已启用").map((item) => { // i18n-ignore
            const current = categoryTarget?.category === item;
            return (
              <button
                key={item}
                type="button"
                className={`category-chip${current ? " is-current" : ""}`}
                disabled={categorySaving}
                onClick={() => {
                  const target = categoryTarget;
                  if (!target || current) {
                    setCategoryTarget(null);
                    return;
                  }
                  setCategorySaving(true);
                  void api
                    .setModCategory(target.id, item)
                    .then(() => {
                      setCategoryTarget(null);
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
