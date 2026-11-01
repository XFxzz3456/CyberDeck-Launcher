import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, ChevronRight, RefreshCw, ShieldAlert, Upload } from "lucide-react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import type {
  AdoptCandidate,
  AdoptProgress,
  AdoptReport,
  AdoptScanReport,
  Category,
  ConflictInfo,
  DependencyReport,
  DiagnosticsReport,
  FrameworkStatus,
  InstallOutcome,
  ModEntry,
  NexusDownloadProgress,
  NxmLink,
  NexusStatus,
  NexusUpdateItem,
  NexusUpdateReport,  UpdateBackup,
  Settings,
  Snapshot,
  ExternalToolEntry,
} from "./types";
import { api, isTauri, normalizeError, mockApi } from "./lib/api";
import { markEulaAccepted, readEulaAccepted } from "./lib/eula";
import { onNexusStatusChanged } from "./lib/nexusBus";
import { EulaDialog } from "./components/EulaDialog";
import {
  blockingDependencies,
  effectiveDependencies,
  ignoreDependency,
  nexusSearchUrl,
  restoreDependency,
  type EffectiveDependency,
} from "./lib/dependencies";
import { translationChildren } from "./lib/translationMatch";
import { createCoalescer, type Coalescer } from "./lib/feedback";
import { TranslationBindDialog } from "./components/TranslationBindDialog";
import { useMotionEnabled, usePreferences } from "./lib/preferences";
import { useViewportTier } from "./lib/viewportTier";
import type { ActivityItem, TaskItem } from "./lib/tasks";
import type { View, SidebarBadges } from "./components/Sidebar";
import {
  isHideableView,
  loadHiddenViews,
  saveHiddenViews,
  type HiddenViewsMap,
  type HideableView,
} from "./lib/uiPrefs";
import type { SettingsTabId } from "./components/SettingsTabs";
import { Sidebar } from "./components/Sidebar";
import { TitleBar } from "./components/TitleBar";
import { TopBar } from "./components/TopBar";
import { LibraryView, type SortMode } from "./components/LibraryView";
import { SplashScreen } from "./components/SplashScreen";
import { LoadOrderView } from "./components/LoadOrderView";
import { AnimatePresence, MotionConfig, motion } from "framer-motion";
import { makeRouteVariants } from "./lib/motion";
import { ModDetailDrawer } from "./components/ModDetailDrawer";
// E1 按视图拆包：发现页 / 诊断页 / 设置页是天然分割点，
// 首屏主 bundle 只含模组库 + 加载顺序，启动更快。
const NexusView = lazy(() => import("./components/NexusView").then((m) => ({ default: m.NexusView })));
const DiagnosticsView = lazy(() =>
  import("./components/DiagnosticsView").then((m) => ({ default: m.DiagnosticsView })),
);
const SavesView = lazy(() =>
  import("./components/SavesView").then((m) => ({ default: m.SavesView })),
);
const SettingsView = lazy(() =>
  import("./components/SettingsView").then((m) => ({ default: m.SettingsView })),
);
import { ImportDialog } from "./components/ImportDialog";
import { ConflictDialog } from "./components/ConflictDialog";
import { ConflictCenter } from "./components/ConflictCenter";
import { NxmIntake, type NxmItem } from "./components/NxmIntake";
import { CommandPalette } from "./components/CommandPalette";
import { AdoptPreviewDialog } from "./components/AdoptPreviewDialog";
import { BackgroundCropDialog } from "./components/BackgroundCropDialog";
import { DangerConfirmModal } from "./components/DangerConfirmModal";
import { TaskCenter } from "./components/TaskCenter";
import { DownloadsView } from "./components/DownloadsView";
import { ConfirmDialog, ToastHost, type ToastItem } from "./components/ui";
import { BootSkeletonGrid } from "./components/ModCardSkeleton";
import {
  canNotify,
  loadNotificationDuration,
  loadNotificationPrefs,
  saveNotificationDuration,
  saveNotificationPrefs,
  toastTtl,
  type NotificationDuration,
  type NotificationPrefs,
  type ToastCategory,
} from "./lib/notify";
import { t } from "./i18n";

/** 协议遮罩淡出时长（ms），必须与 styles.css 里 .eula-portal 的 transition 一致。 */
const EULA_FADE_MS = 260;

/** 部署 / 撤销反馈的静默合并窗口（ms）：连串开关攒够一批才给一条汇总。 */
const TOGGLE_COALESCE_MS = 2000;

interface ConfirmState {
  title: string;
  detail: ReactNode;
  confirmLabel: string;
  danger: boolean;
  action: () => Promise<void>;
}

interface ConflictState {
  mod: ModEntry;
  conflicts: ConflictInfo[];
}

interface DangerState {
  title: string;
  detail: ReactNode;
  confirmLabel: string;
  action: () => Promise<void>;
}

interface PendingImport {
  taskId: number;
  path: string;
}

/** E1 懒加载视图的分包 loading 占位。 */
function ViewFallback() {
  return (
    <div className="page">
      <div className="view-fallback">
        <span className="spin-inline" aria-hidden="true" />
        <span>LOADING VIEW…</span>
      </div>
    </div>
  );
}

export default function App() {
  const {
    preferences,
    selectTheme,
    setAccent,
    resetAccent,
    setScale,
    setSidebarCollapsed,
    setAnimations,
    setSplash,
    setLibraryView,
    setUiFont,
    setCodeFont,
    setCustomUiFont,
    setCustomCodeFont,
  } = usePreferences();
  const motionEnabled = useMotionEnabled();
  // 侧栏纵向档位：按「窗口高度 ÷ 缩放」算，让矮窗口 / 大缩放时逐级让位（见 viewportTier.ts）。
  useViewportTier(preferences.scale);

  // T8 快捷键：Ctrl + 滚轮快速缩放（步进 5%，与滑块共用同一区间）。
  // 不按 deltaY 大小连乘——触控板一次滑动会连发几十个事件，缩放会一路冲到底。
  // 必须 passive:false，否则 preventDefault 无效、WebView 会自己再缩一次。
  const scaleRef = useRef(preferences.scale);
  scaleRef.current = preferences.scale;
  useEffect(() => {
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      const next = scaleRef.current + (event.deltaY < 0 ? 0.05 : -0.05);
      setScale(Math.min(1.5, Math.max(0.8, Math.round(next * 20) / 20)));
    };
    window.addEventListener("wheel", onWheel, { passive: false });
    return () => window.removeEventListener("wheel", onWheel);
  }, [setScale]);
  // 路由切换用一套固定变体（不随主题分化：换页要的是"利落"，不是"手感"）。
  const routeVariants = useMemo(() => makeRouteVariants(motionEnabled), [motionEnabled]);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  // 首启必须过使用协议。注意：**不短路渲染**——主界面照常渲染在底层，
  // 未同意时只是盖一层毛玻璃遮罩（见下方 eulaGate），这样用户不会看到白屏/黑屏。
  const [eulaAccepted, setEulaAccepted] = useState(readEulaAccepted);
  // 点「同意继续」后先播 260ms 淡出再卸载遮罩；淡出期间仍拦截点击，避免误触底层。
  const [eulaClosing, setEulaClosing] = useState(false);
  const [eulaViewerOpen, setEulaViewerOpen] = useState(false);
  const [view, setView] = useState<View>("library");
  // 界面显示管理（deepseek 任务·模块四）：侧栏入口隐藏 + 被隐藏页跳回模组库。
  const [hiddenViews, setHiddenViews] = useState<HiddenViewsMap>(() => loadHiddenViews());
  // 「去配置」类入口：跳到设置页的指定 Tab（如存档页 → 工具组件）。
  const [settingsTabRequest, setSettingsTabRequest] = useState<SettingsTabId>("appearance");
  const toggleHiddenView = useCallback((key: HideableView, hidden: boolean) => {
    setHiddenViews((current) => {
      const next = { ...current };
      if (hidden) next[key] = true;
      else delete next[key];
      saveHiddenViews(next);
      return next;
    });
  }, []);
  useEffect(() => {
    if (view !== "library" && isHideableView(view) && hiddenViews[view]) {
      setView("library");
    }
  }, [view, hiddenViews]);
  // 固定到侧栏的外部工具（deepseek 任务·模块三）：ExternalToolsCard 变更后发事件，这里监听刷新。
  const [pinnedTools, setPinnedTools] = useState<ExternalToolEntry[]>([]);
  useEffect(() => {
    let alive = true;
    const reload = () => {
      api
        .externalToolsList()
        .then((list) => {
          if (alive) setPinnedTools(list.filter((tool) => tool.pinned));
        })
        .catch(() => {});
    };
    reload();
    window.addEventListener("cdl.tools-changed", reload);
    return () => {
      alive = false;
      window.removeEventListener("cdl.tools-changed", reload);
    };
  }, []);
  // splash 只影响首帧观感：关掉时直接不挂载，不做任何初始化阻塞。
  const [splashDone, setSplashDone] = useState(false);
  const [dropActive, setDropActive] = useState(false);
  const [search, setSearch] = useState("");
  // Category 的取值是持久化数据（B 类，见 types.ts），不可翻译；显示映射见 categoryLabel()。
  const [category, setCategory] = useState<Category>("全部"); // i18n-ignore
  const [sort, setSort] = useState<SortMode>("name");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const [savingCategories, setSavingCategories] = useState(false);
  const [importOutcomes, setImportOutcomes] = useState<InstallOutcome[] | null>(null);
  const [savingOrder, setSavingOrder] = useState(false);
  const [diagnostics, setDiagnostics] = useState<DiagnosticsReport | null>(null);
  const [diagLoading, setDiagLoading] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [appData, setAppData] = useState("");
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  // 游戏更新熔断的解除：点按钮后短暂禁用，避免连点。
  const [unlocking, setUnlocking] = useState(false);
  const [switchingProfile, setSwitchingProfile] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [danger, setDanger] = useState<DangerState | null>(null);
  const [dangerBusy, setDangerBusy] = useState(false);
  const [conflictState, setConflictState] = useState<ConflictState | null>(null);
  const [conflictCenterOpen, setConflictCenterOpen] = useState(false);
  const [frameworks, setFrameworks] = useState<FrameworkStatus[] | null>(null);
  // 前置依赖报告（deps.rs 的产出）。与 frameworks 同一次 getDiagnostics 拿到，
  // 卡片徽标、详情页、启用拦截共用这一份，避免三处各算一遍。
  const [dependencyReport, setDependencyReport] = useState<DependencyReport | null>(null);
  const [depGuard, setDepGuard] = useState<{
    mod: ModEntry;
    blockers: EffectiveDependency[];
  } | null>(null);
  // 忽略列表在 localStorage 里，改完必须让界面重算一次依赖（不重算的话
  // 用户点了「忽略」看不到任何变化，会以为按钮坏了）。
  const [depIgnoreTick, setDepIgnoreTick] = useState(0);
  // 刚导入、还没决定父级的疑似汉化包队列。一次导入可能带多个，逐条问。
  const [bindQueue, setBindQueue] = useState<ModEntry[]>([]);
  // 游戏主进程是否在运行：顶栏按钮据此在「开始游戏 / 关闭游戏」之间切换。
  const [gameRunning, setGameRunning] = useState(false);
  const [stoppingGame, setStoppingGame] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  // C1 活动流：任务完成（或轻操作）后落一条「时间 + 动作 + 文件数」，常驻可查。
  const [activities, setActivities] = useState<ActivityItem[]>([]);
  const [logViewerRequest, setLogViewerRequest] = useState(0);
  // B4 播放集切换步骤指示器：后端无进度事件，按耗时映射三段（撤除→部署→完成）。
  const [switchStep, setSwitchStep] = useState(0);
  // B1 侧栏徽标：Nexus 连接状态（未配置/未连接时发现页打 ! 标）。
  const [nexus, setNexus] = useState<NexusStatus | null>(null);
  // #1 更新检查：结果与进行中标记。updates 按 entryId 索引供列表/抽屉查。
  const [updateReport, setUpdateReport] = useState<NexusUpdateReport | null>(null);
  const [applyingUpdates, setApplyingUpdates] = useState(false);
  const [updateBackups, setUpdateBackups] = useState<UpdateBackup[]>([]);
  const [appUpdating, setAppUpdating] = useState(false);
  const [updateChecking, setUpdateChecking] = useState(false);
  const [enriching, setEnriching] = useState(false);
  // 收编（Adopt）：扫描结果 / 执行进度 / 执行结果 / 任务行 id。
  const [adoptOpen, setAdoptOpen] = useState(false);
  const [adoptScan, setAdoptScan] = useState<AdoptScanReport | null>(null);
  const [adoptScanning, setAdoptScanning] = useState(false);
  const [adoptExecuting, setAdoptExecuting] = useState(false);
  const [adoptProgress, setAdoptProgress] = useState<AdoptProgress | null>(null);
  const [adoptReport, setAdoptReport] = useState<AdoptReport | null>(null);
  const toastCounter = useRef(0);
  const taskCounter = useRef(0);
  // 设置保存队列（见 handleSettings）：target = 待写盘的最新值，saving = 排水阀。
  const settingsSaveTarget = useRef<Settings | null>(null);
  const settingsSaving = useRef(false);
  const settingsRollback = useRef<Settings | null>(null);
  const pendingImports = useRef<PendingImport[]>([]);
  const importRunning = useRef(false);
  const adoptTaskRef = useRef<number | null>(null);

  const [notificationPrefs, setNotificationPrefs] = useState<NotificationPrefs>(() =>
    loadNotificationPrefs(),
  );
  const notifyPrefsRef = useRef(notificationPrefs);
  useEffect(() => {
    notifyPrefsRef.current = notificationPrefs;
  }, [notificationPrefs]);

  // 2D 通知停留时长（秒 / "never"）：toast() 是零依赖回调，走 ref 读最新值，
  // 保证改完时长后新弹出的通知立刻生效，不用重启也不用重新挂载。
  const [notificationDuration, setNotificationDuration] = useState<NotificationDuration>(() =>
    loadNotificationDuration(),
  );
  const notifyDurationRef = useRef(notificationDuration);
  useEffect(() => {
    notifyDurationRef.current = notificationDuration;
  }, [notificationDuration]);

  /**
   * 通知门（r12）：category 缺省为 "system"（直接操作反馈，永远放行）；
   * 打扰型通知（download/deploy/conflict/update）先查用户偏好再弹。
   */
  const toast = useCallback(
    (
      tone: ToastItem["tone"],
      title: string,
      message?: string,
      category: ToastCategory = "system",
      /** ttl 覆盖一切时长规则；sticky = 常驻，只能手动关（冲突 / 权限不足 / 缺前置）。 */
      options?: { ttl?: number; sticky?: boolean },
    ) => {
      if (!canNotify(category, notifyPrefsRef.current)) return;
      toastCounter.current += 1;
      const id = toastCounter.current;
      // 2D：警告/错误强制常驻，普通提示走全局时长配置（默认 5 秒）。
      const ttl = toastTtl(notifyDurationRef.current, tone, options?.ttl);
      setToasts((items) => [
        ...items.slice(-3),
        { id, tone, title, message, sticky: options?.sticky || ttl === Infinity },
      ]);
      if (ttl === Infinity) return;
      window.setTimeout(() => {
        setToasts((items) => items.filter((item) => item.id !== id));
      }, ttl);
    },
    [],
  );

  /** 更新通知分类偏好：写状态 + 落 localStorage（notify.ts 的键 ncl.ui.notifications.v1）。 */
  const handleNotificationPrefsChange = useCallback((prefs: NotificationPrefs) => {
    setNotificationPrefs(prefs);
    saveNotificationPrefs(prefs);
  }, []);

  /** 2D 更新通知停留时长：写状态 + 落 localStorage（键 ncl.ui.notificationDuration.v1）。 */
  const handleNotificationDurationChange = useCallback((value: NotificationDuration) => {
    setNotificationDuration(value);
    saveNotificationDuration(value);
  }, []);

  /**
   * 3B-1 全局「发送测试通知」：走 system 类别（不受分类开关影响），
   * 任何开关组合下都能弹，专门让用户预览当前的停留时长效果。
   */
  const handleTestNotification = useCallback(() => {
    toast("info", t("settings.notifTestTitle"), t("settings.notifTestDetail"), "system");
  }, [toast]);

  // 解除游戏更新熔断：把当前 exe 版本记为已确认版本，随后刷新整个快照。

  const handleClearUpdateLock = useCallback(async () => {
    setUnlocking(true);
    try {
      const next = await api.clearUpdateLock();
      setSnapshot(next);
      toast("ok", t("toast.update.unlocked"), t("toast.update.unlockedDetail"));
    } catch (err) {
      toast("error", t("err.unlockUpdate"), err instanceof Error ? err.message : String(err));
    } finally {
      setUnlocking(false);
    }
  }, [toast]);

  const addTask = useCallback(
    (
      kind: TaskItem["kind"],
      title: string,
      detail?: string,
      retryPaths?: string[],
    ): number => {
      taskCounter.current += 1;
      const id = taskCounter.current;
      setTasks((current) => [
        ...current,
        {
          id,
          kind,
          title,
          detail,
          status: "queued",
          progress: 4,
          retryPaths,
          createdAt: Date.now(),
        },
      ]);
      return id;
    },
    [],
  );

  const patchTask = useCallback((id: number, patch: Partial<TaskItem>) => {
    setTasks((current) =>
      current.map((task) => (task.id === id ? { ...task, ...patch } : task)),
    );
  }, []);

  const dismissTask = useCallback((id: number) => {
    setTasks((current) => current.filter((task) => task.id !== id));
  }, []);

  const clearFinishedTasks = useCallback(() => {
    setTasks((current) =>
      current.filter((task) => task.status === "running" || task.status === "queued"),
    );
  }, []);

  const activityCounter = useRef(0);
  const recordActivity = useCallback((kind: ActivityItem["kind"], title: string, detail?: string) => {
    activityCounter.current += 1;
    const entry: ActivityItem = { id: activityCounter.current, kind, title, detail, at: Date.now() };
    setActivities((current) => [...current.slice(-29), entry]);
  }, []);

  const clearActivities = useCallback(() => setActivities([]), []);

  // 部署 / 撤销的「合并器」：单次开关完全静默（结果在卡片角标上看得见），
  // 2 秒内的连续开关合并成**一条**汇总 toast（走 deploy 类别，受设置页开关约束）。
  // 见 lib/feedback.ts —— 窗口从最后一次操作起算，所以一整串连点必然落在同一批。
  const toggleBatches = useRef<Coalescer | null>(null);
  if (!toggleBatches.current) {
    toggleBatches.current = createCoalescer(TOGGLE_COALESCE_MS, (groups) => {
      const total = groups.reduce((sum, group) => sum + group.count, 0);
      const enabled = groups.find((group) => group.key === "deploy")?.count ?? 0;
      const disabled = groups.find((group) => group.key === "disable")?.count ?? 0;
      if (total <= 0) return;
      toast(
        "info",
        t("toast.batch.toggleTitle", { count: total }),
        t("toast.batch.toggleDetail", { enabled, disabled }),
        "deploy",
      );
    });
  }
  useEffect(() => () => toggleBatches.current?.dispose(), []);

  const showError = useCallback(
    (error: unknown, title = t("err.generic"), options?: { ttl?: number; sticky?: boolean }) => {
      const parsed = normalizeError(error);
      const suffix =
        parsed.conflicts.length > 0
          ? t("err.conflictTargets", {
              targets: parsed.conflicts
                .slice(0, 3)
                .map((conflict) => conflict.target)
                .join(t("common.listSeparator")),
            })
          : "";
      toast("error", title, `${parsed.message}${suffix}`, "system", options);
    },
    [toast],
  );

  // 侧栏固定工具启动（deepseek 任务·模块三）。依赖 showError，必须定义在其后。
  const launchTool = useCallback(
    async (id: string) => {
      try {
        await api.externalToolLaunch(id);
      } catch (error) {
        showError(error, t("err.toolLaunch"));
      }
    },
    [showError],
  );

  // ── 自定义背景图（看板【皮肤 UI 优化】P0 子项）──────────────────────
  // 设置里只存路径；这里负责把路径换成 data URL（read_background_image 校验
  // 类型与体积），路径没变就不重复读盘。加载失败：背景层退场 + 一次性报错，
  // 路径保留（U 盘拔了再插回来还能恢复）。
  const [backgroundData, setBackgroundData] = useState<{
    path: string;
    dataUrl: string | null;
  }>({ path: "", dataUrl: null });
  // 3D：读盘 + 压缩进行中的极简反馈。后端会自动把大图压到长边 1920，
  // 大图要好几秒，不给个状态用户会以为点了没反应，再点一次。
  const [bgLoading, setBgLoading] = useState(false);
  const bgLoadedPathRef = useRef<string | null>(null);
  const bgImagePath = snapshot?.state.settings.backgroundImage ?? "";
  useEffect(() => {
    if (bgLoadedPathRef.current === bgImagePath) return;
    bgLoadedPathRef.current = bgImagePath;
    if (!bgImagePath) {
      setBackgroundData({ path: "", dataUrl: null });
      setBgLoading(false);
      return;
    }
    setBgLoading(true);
    let cancelled = false;
    void api
      .readBackgroundImage(bgImagePath)
      .then((image) => {
        if (!cancelled) setBackgroundData({ path: bgImagePath, dataUrl: image.dataUrl });
      })
      .catch((error) => {
        if (cancelled) return;
        setBackgroundData({ path: bgImagePath, dataUrl: null });
        const parsed = normalizeError(error);
        // 图本身有问题（解码不了 / 大得离谱）：说清楚原因，别糊一层通用的
        // 「加载失败」——用户需要知道是文件坏了还是路径丢了。
        if (parsed.code === "BACKGROUND_DECODE" || parsed.code === "BACKGROUND_TOO_LARGE") {
          toast("warn", t("toast.background.badImageTitle"), parsed.message, "system");
          return;
        }
        showError(error, t("err.backgroundLoad"));
      })
      .finally(() => {
        if (!cancelled) setBgLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [bgImagePath, showError, toast]);

  const refresh = useCallback(async () => {
    const next = await api.bootstrap();
    setSnapshot(next);
    return next;
  }, []);

  // ── NXM 协议接收（计划【3】） ─────────────────────────────────
  //
  // 链路：N 网点「Mod manager download」→ Windows 按注册表把 nxm:// 交给本启动器
  // → 后端把链接塞进收件箱并 emit `nxm-link` → 这里排队、按设置决定是否直接下载。
  // 之所以还要 `nxmPending()` 补拉一次：协议直接拉起进程时，事件早于监听器挂载。
  const [nxmItems, setNxmItems] = useState<NxmItem[]>([]);
  // 下载中心：侧栏角标只关心「还没跑完的任务数」，轻量轮询即可。
  const [downloadActive, setDownloadActive] = useState(0);
  const nxmPremium = useRef(false);
  const nxmBusy = useRef(false);

  const patchNxm = useCallback((uri: string, patch: Partial<NxmItem>) => {
    setNxmItems((items) =>
      items.map((item) => (item.link.uri === uri ? { ...item, ...patch } : item)),
    );
  }, []);

  const addNxmLink = useCallback((link: NxmLink) => {
    setNxmItems((items) =>
      items.some((item) => item.link.uri === link.uri)
        ? items
        : [...items, { link, status: "pending" as const }],
    );
  }, []);

  const runNxm = useCallback(
    async (item: NxmItem) => {
      if (!item.link.fileId || nxmBusy.current) return;
      nxmBusy.current = true;
      patchNxm(item.link.uri, { status: "downloading", received: 0, total: null, message: t("toast.nxm.queuedDetail") });
      try {
        // r13 起走下载队列：NXM 签名（key/expires）一起带上，
        // 免费账号不需要 API Key 也能直接下载；进度与完成都在「下载中心」页。
        await api.downloadQueueAdd(
          item.link.modId,
          item.link.fileId,
          undefined,
          item.link.key ?? undefined,
          item.link.expires ?? undefined,
          true,
        );
        toast("ok", t("toast.nxm.queuedTitle"), t("toast.nxm.queuedDetail"), "download");
      } catch (error) {
        const parsed = normalizeError(error);
        patchNxm(item.link.uri, { status: "error", message: parsed.message });
        showError(error, t("err.nxmDownload"));
      } finally {
        nxmBusy.current = false;
      }
    },
    [patchNxm, toast, showError],
  );

  const openNxmPage = useCallback(
    (item: NxmItem) => {
      void api
        .openUrl(`https://www.nexusmods.com/cyberpunk2077/mods/${item.link.modId}`)
        .catch((error) => showError(error, t("err.openPage")));
    },
    [showError],
  );

  const dismissNxm = useCallback((uri: string) => {
    setNxmItems((items) => items.filter((item) => item.link.uri !== uri));
    void api.nxmDismiss(uri).catch(() => {});
  }, []);

  const dismissAllNxm = useCallback(() => {
    setNxmItems([]);
    void api.nxmDismiss(null).catch(() => {});
  }, []);

  useEffect(() => {
    let alive = true;
    // Premium 才能直链下载；免费账号只能在接受条里点「打开页面」。
    void api
      .nexusStatus()
      .then((status) => {
        nxmPremium.current = Boolean(status.connected && status.user?.isPremium);
      })
      .catch(() => {});
    void api
      .nxmPending()
      .then((links) => {
        if (alive) links.forEach(addNxmLink);
      })
      .catch(() => {});

    let unlistenLink: (() => void) | undefined;
    let unlistenProgress: (() => void) | undefined;
    void (async () => {
      if (!isTauri) return;
      try {
        unlistenLink = await listen<NxmLink>("nxm-link", (event) => addNxmLink(event.payload));
        unlistenProgress = await listen<NexusDownloadProgress>(
          "nexus-download-progress",
          (event) => {
            const { modId, received, total } = event.payload;
            setNxmItems((items) =>
              items.map((item) =>
                item.link.modId === modId && item.status === "downloading"
                  ? { ...item, received, total }
                  : item,
              ),
            );
          },
        );
      } catch {
        // 浏览器预览没有事件 API，靠 nxmPending 那条路就够。
      }
    })();
    return () => {
      alive = false;
      unlistenLink?.();
      unlistenProgress?.();
    };
  }, [addNxmLink]);

  // 下载队列状态事件：完成/失败 → toast（download 类别，可被通知设置关掉）；
  // 完成时顺手收掉对应的 NXM 接收条。进度走下载中心页轮询，不在这刷。
  useEffect(() => {
    if (!isTauri) return;
    let unlisten: (() => void) | undefined;
    void (async () => {
      try {
        unlisten = await listen<{
          id: string;
          name: string;
          fileName: string;
          modId: number;
          fileId: number;
          status: string;
          error: string | null;
          received: number;
          total: number | null;
        }>("download-status", (event) => {
          const payload = event.payload;
          const matchesNxm = (item: NxmItem) =>
            item.status === "downloading" &&
            item.link.modId === payload.modId &&
            item.link.fileId === payload.fileId;
          if (payload.status === "completed") {
            setNxmItems((items) =>
              items.map((item) =>
                matchesNxm(item) ? { ...item, status: "done", message: payload.fileName } : item,
              ),
            );
            recordActivity("import", t("activity.nxmDownload", { modId: payload.modId }), payload.fileName);
            toast("ok", t("toast.nxm.doneTitle"), t("toast.nxm.doneDetail", { name: payload.fileName }), "download");
          } else if (payload.status === "failed") {
            setNxmItems((items) =>
              items.map((item) =>
                matchesNxm(item) ? { ...item, status: "error", message: payload.error ?? undefined } : item,
              ),
            );
            toast("error", t("toast.download.failedTitle", { name: payload.name }), payload.error ?? "", "download");
          }
        });
      } catch {
        // 无事件 API（理论上只在浏览器预览），静默。
      }
    })();
    return () => {
      unlisten?.();
    };
  }, [toast, recordActivity]);

  // 自动下载：设置开着 + 有 Premium + 还没人在下 → 按到达顺序一个个来（不并发抢盘）。
  useEffect(() => {
    if (!snapshot?.state.settings.nxmAutoDownload || !nxmPremium.current) return;
    if (nxmBusy.current) return;
    const next = nxmItems.find((item) => item.status === "pending" && item.link.fileId);
    if (next) void runNxm(next);
  }, [nxmItems, snapshot?.state.settings.nxmAutoDownload, runNxm]);

  /**
   * 切换播放集。会先撤销当前部署、再按目标集合重新部署，
   * 耗时随模组数量增长，所以先弹确认卡（列出将撤除/将部署的差量），
   * 执行时全程显示三段步骤指示器。
   */
  const handleSwitchProfile = useCallback(
    async (profileId: string) => {
      const profiles = snapshot?.state.profiles ?? [];
      const target = profiles.find((item) => item.id === profileId);
      if (!target) return;
      if (snapshot?.state.activeProfileId === profileId) return;

      // B4 差量预览：切换会真实改动的只有「新启用」和「将撤除」两块。
      const mods = snapshot?.state.mods ?? [];
      const targetIds = new Set(target.enabledModIds);
      const keep = mods.filter((mod) => mod.enabled && targetIds.has(mod.id)).length;
      const toRemove = mods.filter((mod) => mod.enabled).length - keep;
      const toDeploy = target.enabledModIds.length - keep;

      setConfirm({
        title: t("confirm.profileSwitch.title", { name: target.name }),
        detail: (
          <div className="confirm-stack">
            <p>{t("confirm.profileSwitch.detail")}</p>
            <p>
              {keep > 0
                ? t("confirm.profileSwitch.countsKeep", {
                    remove: toRemove,
                    deploy: toDeploy,
                    keep,
                  })
                : t("confirm.profileSwitch.counts", { remove: toRemove, deploy: toDeploy })}
            </p>
            <p className="panel-note">{t("confirm.profileSwitch.note")}</p>
          </div>
        ),
        confirmLabel: t("confirm.profileSwitch.confirm"),
        danger: false,
        action: async () => {
          setSwitchingProfile(true);
          setSwitchStep(0);
          // 无后端进度事件：按典型耗时映射三段，撤除通常更快。
          const stepTimer = window.setTimeout(() => setSwitchStep(1), 1600);
          try {
            const report = await api.switchProfile(profileId);
            window.clearTimeout(stepTimer);
            setSwitchStep(2);
            await refresh();
            const warn =
              report.warnings.length > 0
                ? t("toast.warningSuffix", { message: report.warnings[0] })
                : "";
            toast(
              "ok",
              t("toast.profile.switchedTitle", { name: report.profile.name }),
              t("toast.profile.switchedDetail", {
                undeployed: report.undeployed,
                deployed: report.deployed,
                warn,
              }),
              "deploy",
            );
            recordActivity(
              "order",
              t("activity.profileSwitch", { name: report.profile.name }),
              t("activity.profileSwitchDetail", {
                undeployed: report.undeployed,
                deployed: report.deployed,
              }),
            );
          } catch (error) {
            showError(error, t("err.profileSwitch"));
          } finally {
            window.clearTimeout(stepTimer);
            setSwitchingProfile(false);
            setSwitchStep(0);
          }
        },
      });
    },
    [snapshot, refresh, toast, showError, recordActivity],
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [next, dir] = await Promise.all([api.bootstrap(), api.appDataDir()]);
        if (cancelled) return;
        setSnapshot(next);
        setAppData(dir);
      } catch (error) {
        if (!cancelled) setBootError(normalizeError(error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const loadDiagnostics = useCallback(async () => {
    setDiagLoading(true);
    try {
      const report = await api.getDiagnostics();
      setDiagnostics(report);
      setFrameworks(report.frameworks);
      setDependencyReport(report.dependencies ?? null);
    } catch (error) {
      showError(error, t("err.diagnostics"));
    } finally {
      setDiagLoading(false);
    }
  }, [showError]);

  useEffect(() => {
    if (view === "diagnostics") {
      void loadDiagnostics();
    }
  }, [view, loadDiagnostics]);

  // 下载队列角标：3s 轻轮询，只在任务数变化时 setState（列表读取是本地文件级操作）。
  useEffect(() => {
    let cancelled = false;
    let lastCount = -1;
    const tick = async () => {
      try {
        const list = await api.downloadQueueList();
        if (cancelled) return;
        const active = list.filter(
          (task) => task.status === "queued" || task.status === "downloading",
        ).length;
        if (active !== lastCount) {
          lastCount = active;
          setDownloadActive(active);
        }
      } catch {
        // 队列读不出来就不显示角标，不打扰。
      }
    };
    void tick();
    const timer = window.setInterval(() => void tick(), 3000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  /**
   * 游戏进程轮询。
   *
   * 为什么是"轮询"而不是事件：Tauri 没有进程退出事件，玩家也可能从 Steam /
   * 桌面图标直接启动（那时我们连启动动作都没看见）。5 秒一次 `tasklist` 过滤
   * 是本地命令、开销可忽略，比漏掉状态变化要划算得多。
   * 未绑定游戏目录时直接跳过——没有游戏可跑，问也是白问。
   */
  useEffect(() => {
    if (!snapshot?.game) {
      setGameRunning(false);
      return;
    }
    let cancelled = false;
    const tick = async () => {
      try {
        const running = await api.gameProcessRunning();
        if (!cancelled) setGameRunning(running);
      } catch {
        // 取不到就当没运行，不要让顶栏卡在「关闭游戏」上。
        if (!cancelled) setGameRunning(false);
      }
    };
    void tick();
    const timer = window.setInterval(() => void tick(), 5000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [snapshot?.game?.root, snapshot?.game]);

  /** 顶栏「关闭游戏」：先礼后兵交给后端，返回 forced 时提示玩家。 */
  const handleStopGame = useCallback(async () => {
    if (stoppingGame) return;
    setStoppingGame(true);
    try {
      const forced = await api.stopGameProcess();
      setGameRunning(false);
      if (forced) {
        toast("warn", t("toast.stopGame.forcedTitle"), t("toast.stopGame.forcedDetail"));
      } else {
        toast("ok", t("toast.stopGame.doneTitle"), t("toast.stopGame.doneDetail"));
      }
    } catch (error) {
      showError(error, t("err.stopGame"));
    } finally {
      setStoppingGame(false);
    }
  }, [showError, stoppingGame, toast]);

  // Keep prerequisite badges useful even when the user never opens diagnostics.
  // This is read-only and cheap; failures stay silent because a missing game is
  // already explained by the setup banner.
  useEffect(() => {
    if (!snapshot) return;    let cancelled = false;
    void api
      .getDiagnostics()
      .then((report) => {
        if (cancelled) return;
        setFrameworks(report.frameworks);
        setDependencyReport(report.dependencies ?? null);
      })
      .catch(() => {
        if (cancelled) return;
        setFrameworks(null);
        setDependencyReport(null);
      });
    return () => {
      cancelled = true;
    };
  }, [snapshot?.game?.root, snapshot !== null]);

  // B1 侧栏徽标：Nexus 连接状态只在进入发现页/设置页或换快照时刷新，调用很轻。
  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      void api
        .nexusStatus()
        .then((status) => {
          if (!cancelled) setNexus(status);
        })
        .catch(() => {
          if (!cancelled) setNexus(null);
        });
    };
    refresh();
    // 连接/断开发生在设置页或发现页内部，view 不变 → 上面那轮不会重跑，
    // 侧栏「发现」的未连接角标就会一直亮着。订阅广播补上这一跳。
    const off = onNexusStatusChanged("app", refresh);
    return () => {
      cancelled = true;
      off();
    };
  }, [view, snapshot?.demoMode]);



  // 收编进度：后端按 staging/verify/register 每段 emit 一次，这里更新任务行。
  useEffect(() => {
    if (!isTauri) return;
    let dispose: (() => void) | undefined;
    let cancelled = false;
    void listen<AdoptProgress>("adopt-progress", (event) => {
      setAdoptProgress(event.payload);
      const taskId = adoptTaskRef.current;
      if (taskId === null) return;
      const { current, total, name, detail } = event.payload;
      const ratio = total > 0 ? Math.min(96, Math.round(((current + 1) / total) * 100)) : undefined;
      patchTask(taskId, {
        status: "running",
        ...(ratio === undefined ? {} : { progress: ratio }),
        detail: name ? `${name} · ${detail}` : detail,
      });
    }).then((off) => {
      if (cancelled) off();
      else dispose = off;
    });
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, [patchTask]);

  const drainImports = useCallback(async () => {
    if (importRunning.current) return;
    importRunning.current = true;
    setImporting(true);
    const outcomes: InstallOutcome[] = [];

    try {
      while (pendingImports.current.length > 0) {
        const item = pendingImports.current.shift();
        if (!item) break;
        let simulated = 16;
        patchTask(item.taskId, {
          status: "running",
          progress: simulated,
          detail: t("job.extract"),
        });
        const timer = window.setInterval(() => {
          simulated = Math.min(88, simulated + 6);
          patchTask(item.taskId, { progress: simulated });
        }, 420);

        try {
          const result = await api.installMods([item.path]);
          const outcome = result[0] ?? {
            path: item.path,
            success: false,
            modEntry: null,
            error: t("err.installEmptyResult"),
            errorCode: "EMPTY_RESULT",
          };
          outcomes.push(outcome);
          if (outcome.success) {
            patchTask(item.taskId, {
              status: "success",
              progress: 100,
              detail: t("job.importedDetail", {
                name: outcome.modEntry?.name ?? t("common.mod"),
              }),
              error: undefined,
            });
          } else {
            patchTask(item.taskId, {
              status: "error",
              progress: 100,
              detail: undefined,
              error: outcome.error ?? t("err.importNoReason"),
            });
          }
        } catch (error) {
          const parsed = normalizeError(error);
          outcomes.push({
            path: item.path,
            success: false,
            modEntry: null,
            error: parsed.message,
            errorCode: parsed.code,
          });
          patchTask(item.taskId, {
            status: "error",
            progress: 100,
            detail: undefined,
            error: parsed.message,
          });
        } finally {
          window.clearInterval(timer);
        }
      }
    } finally {
      importRunning.current = false;
      setImporting(false);
    }

    if (outcomes.length === 0) return;
    const okCount = outcomes.filter((item) => item.success).length;
    const failCount = outcomes.length - okCount;
    recordActivity(
      "import",
      t("activity.importArchives", { count: outcomes.length }),
      failCount > 0
        ? t("activity.importStagedFailed", { ok: okCount, failed: failCount })
        : t("activity.importStaged", { ok: okCount }),
    );
    try {
      await refresh();
    } catch (error) {
      showError(error, t("err.importRefresh"));
    }
    setImportOutcomes(outcomes);
    setImportOpen(true);
    // 疑似汉化包：导入后立刻问「对应哪个原版」。识别只看名字关键词，
    // 所以默认不绑定，用户点「作为独立 Mod 安装」即维持现状。
    const suspects = outcomes
      .filter((item) => item.success && item.modEntry?.isTranslation && !item.modEntry.parentModId)
      .map((item) => item.modEntry as ModEntry);
    if (suspects.length > 0) setBindQueue(suspects);
    const ok = okCount;
    const failed = failCount;
    if (failed === 0) {
      toast("ok", t("toast.import.doneTitle", { count: ok }), t("toast.import.doneDetail"));
    } else {
      toast(
        "warn",
        t("toast.import.partialTitle", { ok, failed }),
        t("toast.import.partialDetail"),
      );
    }
  }, [patchTask, recordActivity, refresh, showError, toast]);

  /** 整合包导入：拆包在 Rust 侧做（可能几十秒），这里只建一行任务、


  // ── 既有模组收编（Adopt）────────────────────────────────────────

  /** 打开收编预览：先扫描一次（只读），失败时直接落 toast。 */
  const handleAdoptScan = useCallback(async () => {
    setAdoptOpen(true);
    setAdoptReport(null);
    setAdoptProgress(null);
    setAdoptScanning(true);
    try {
      setAdoptScan(await api.adoptScan());
    } catch (error) {
      setAdoptOpen(false);
      showError(error, t("err.adoptScan"));
    } finally {
      setAdoptScanning(false);
    }
  }, [showError]);

  /** 执行收编：进度行交给 adopt-progress 事件，结束后刷新并给摘要。 */
  const handleAdoptExecute = useCallback(
    async (selected: AdoptCandidate[]) => {
      if (selected.length === 0 || adoptExecuting) return;
      const taskId = addTask("adopt", t("job.adoptTitle"), t("job.adoptDetail"));
      adoptTaskRef.current = taskId;
      setAdoptExecuting(true);
      setAdoptReport(null);
      setAdoptProgress(null);
      patchTask(taskId, { status: "running", progress: 8 });
      try {
        const result = await api.adoptExecute(selected);
        setAdoptReport(result);
        const summary = result.cancelled
          ? t("job.adoptSummaryCancelled", { adopted: result.adopted, failed: result.failed })
          : t("job.adoptSummary", { adopted: result.adopted, failed: result.failed });
        recordActivity("adopt", t("job.adoptTitle"), summary);
        patchTask(taskId, {
          status: result.failed > 0 ? "error" : "success",
          progress: 100,
          detail: summary,
          error: result.failed > 0 ? t("job.adoptPartialError") : undefined,
        });
        try {
          await refresh();
        } catch (error) {
          showError(error, t("err.adoptRefresh"));
        }
        // 收编改的是「archive 目录里谁受管」——诊断报告里的未受管计数就靠这个。
        // 只 refresh 快照不重算诊断，会出现「环境体检 0 问题、顶部横幅还写着
        // 发现 N 个未受管 archive」的自相矛盾（2026-10-30 实测反馈）。
        await loadDiagnostics();
        if (result.cancelled) {
          toast("warn", t("toast.adopt.cancelledTitle"), t("toast.adopt.cancelledDetail"));
        } else if (result.failed === 0) {
          toast(
            "ok",
            t("toast.adopt.doneTitle", { count: result.adopted }),
            t("toast.adopt.doneDetail"),
          );
        } else {
          toast(
            "warn",
            t("toast.adopt.partialTitle", { ok: result.adopted, failed: result.failed }),
            t("toast.adopt.partialDetail"),
          );
        }
      } catch (error) {
        const parsed = normalizeError(error);
        patchTask(taskId, { status: "error", progress: 100, detail: undefined, error: parsed.message });
        showError(error, t("err.adopt"));
      } finally {
        setAdoptExecuting(false);
        adoptTaskRef.current = null;
      }
    },
    [
      addTask,
      patchTask,
      recordActivity,
      refresh,
      loadDiagnostics,
      showError,
      toast,
      adoptExecuting,
    ],
  );

  /** 请求取消当前批次：当前模组回滚暂存，已登记的保留。 */
  const handleAdoptCancel = useCallback(() => {
    void api
      .adoptCancel()
      .then(() =>
        toast("info", t("toast.adopt.cancelRequestedTitle"), t("toast.adopt.cancelRequestedDetail")),
      )
      .catch((error) => showError(error, t("err.adoptCancel")));
  }, [showError, toast]);

  const queueImports = useCallback(
    async (paths: string[]) => {
      const archivePaths = paths.filter((path) => /\.(zip|7z|rar)$/i.test(path));
      if (archivePaths.length === 0) {
        toast("warn", t("toast.import.noArchiveTitle"), t("toast.import.noArchiveDetail"));
        return;
      }
      setImportOutcomes(null);
      setImportOpen(false);
      for (const path of archivePaths) {
        const name = path.split(/[\\/]/).pop() ?? path;
        const taskId = addTask("import", t("job.importTitle", { name }), t("job.queued"), [path]);
        pendingImports.current.push({ taskId, path });
      }
      void drainImports();
    },
    [addTask, drainImports, toast],
  );

  /** 拖拽导入：Tauri 原生 drag-drop 事件（WebView 模式下 HTML5 拖拽被禁用）。
   *  enter/over 显示全屏落点层，drop 把文件路径分流：.nxm 进收件箱
   *  （deepseek 任务·模块二），其余喂给既有导入队列。 */
  useEffect(() => {
    if (!isTauri) return;
    const promise = getCurrentWebview().onDragDropEvent((event) => {
      const payload = event.payload;
      if (payload.type === "enter" || payload.type === "over") {
        setDropActive(true);
      } else if (payload.type === "drop") {
        setDropActive(false);
        if (payload.paths.length === 0) return;
        const nxmPaths = payload.paths.filter((path) => path.toLowerCase().endsWith(".nxm"));
        const rest = payload.paths.filter((path) => !path.toLowerCase().endsWith(".nxm"));
        if (nxmPaths.length > 0) {
          void (async () => {
            let links = 0;
            let failed = 0;
            for (const path of nxmPaths) {
              try {
                links += (await api.nxmIntakeFile(path)).length;
              } catch (error) {
                failed += 1;
                showError(error, t("err.nxmFile"));
              }
            }
            if (links > 0) {
              toast("ok", t("toast.nxm.fileTitle"), t("toast.nxm.fileDetail", { count: links }));
            }
            void failed;
          })();
        }
        if (rest.length > 0) void queueImports(rest);
      } else {
        setDropActive(false);
      }
    });
    return () => {
      void promise.then((dispose) => dispose());
    };
  }, [queueImports, showError, toast]);

  const saveImportCategories = useCallback(
    async (updates: Array<{ id: string; category: string }>) => {
      setSavingCategories(true);
      try {
        for (const update of updates) {
          await api.updateMod(update.id, update.category);
        }
        await refresh();
        toast("ok", t("toast.import.categoriesSavedTitle"), t("toast.import.categoriesSavedDetail", { count: updates.length }));
      } catch (error) {
        showError(error, t("err.saveCategories"));
        throw error;
      } finally {
        setSavingCategories(false);
      }
    },
    [refresh, showError, toast],
  );

  const applyToggle = useCallback(
    async (mod: ModEntry, enabled: boolean) => {
      if (enabled && !snapshot?.game) {
        // 缺前置（没挂游戏目录）：必须用户去处理，常驻不自动消失。
        toast("warn", t("toast.game.notLinkedTitle"), t("toast.game.notLinkedSettingsDetail"), "system", {
          sticky: true,
        });
        setView("settings");
        return;
      }
      // 级联：汉化子包不能脱离父级单独存在。
      // - 启用子包前先确保父级已启用，否则会出现「汉化生效了、原版没装」；
      // - 禁用父级时连带禁用所有子包，否则留下往游戏目录写文件的孤儿。
      const children = translationChildren(mod.id, snapshot?.state.mods ?? []);
      if (enabled && mod.parentModId) {
        const parent = snapshot?.state.mods.find((item) => item.id === mod.parentModId);
        if (parent && !parent.enabled) {
          try {
            await api.setModEnabled(parent.id, true);
          } catch (error) {
            showError(error, t("err.deploy"));
            return;
          }
        }
      }
      if (!enabled && children.length > 0) {
        for (const child of children.filter((item) => item.enabled)) {
          try {
            await api.setModEnabled(child.id, false);
          } catch {
            // 子包撤销失败不该阻断父级撤销：父级撤销后子包即便仍启用，
            // 目标文件也已不存在父级提供的资源，冲突检测会把它标出来。
          }
        }
      }
      setBusyId(mod.id);
      try {
        const report = await api.setModEnabled(mod.id, enabled);
        // 暂存文件在外部被删了：后端已清掉残留链接和失效记录，这不是错误，
        // 直接刷新列表并说明一句，别让用户对着红框反复点重试。
        if (report.purged) {
          toast(
            "info",
            t("toast.deploy.purgedTitle"),
            t("toast.deploy.purgedDetail", { name: mod.name }),
            "deploy",
          );
          try {
            await refresh();
          } catch (error) {
            showError(error, t("err.refreshAfterAction"));
          }
          return;
        }
        const linkSummary = t("job.linkSummary", {
          hard: report.hardLinks,
          sym: report.symlinks,
          copies: report.copies,
        });
        // 部署 / 撤销是「看得见结果」的轻操作：卡片角标立刻翻转，所以
        // 不再占一行任务、也不逐次弹 toast。留给用户的两条痕迹：
        //   1) 活动流逐条记录（含 CET / redscript 这类「接下来注意什么」的提示）；
        //   2) 2 秒合并窗口结束后，若这一串有 ≥2 次操作，合起来弹一条汇总。
        const hints: string[] = [];
        if (enabled) {
          if (report.modEntry.hasCet) {
            hints.push(t("toast.deploy.cetDetail"));
          } else if (report.modEntry.layout === "redscript") {
            hints.push(t("toast.deploy.redscriptDetail"));
          }
        }
        try {
          await refresh();
        } catch (error) {
          showError(error, t("err.refreshAfterAction"));
        }
        // 降级 / 降级原因（跨盘、目标被占）仍需用户知晓并处理：保留 toast，且常驻。
        for (const warning of report.warnings.slice(0, 2)) {
          toast("warn", t("toast.deploy.warningTitle"), warning, "deploy", { sticky: true });
        }
        recordActivity(
          enabled ? "deploy" : "disable",
          enabled
            ? t("activity.modDeployed", { name: mod.name })
            : t("activity.modUndeployed", { name: mod.name }),
          [enabled ? linkSummary : t("activity.undeployDetail"), ...hints].join(t("common.listSeparator")),
        );
        toggleBatches.current?.push(enabled ? "deploy" : "disable", mod.name);
      } catch (error) {
        const parsed = normalizeError(error);
        if (enabled && parsed.code === "DEPLOY_CONFLICT" && parsed.conflicts.length > 0) {
          setConflictState({ mod, conflicts: parsed.conflicts });
          toast("error", t("toast.deploy.conflictTitle"), parsed.message, "conflict", { sticky: true });
        } else {
          // 权限不足 / 跨盘硬链接失败：这类失败要用户动手，不能悄悄消失。
          showError(error, enabled ? t("err.deploy") : t("err.disable"), { sticky: true });
        }
      } finally {
        setBusyId(null);
      }
    },
    [refresh, showError, recordActivity, snapshot?.game, toast],
  );

  /**
   * 启用拦截：缺前置的模组先弹一次说明，用户明确点「仍然启用」才继续。
   *
   * 为什么拦：缺前置的表现是「游戏里毫无反应」，玩家通常会以为是模组坏了、
   * 反复重装，比一次性说清楚要痛苦得多。但也不能硬拦——高级玩家可能故意
   * 先启用以排序加载，所以给「仍然启用」并允许在详情页忽略该警告。
   */
  const handleToggle = useCallback(
    async (mod: ModEntry, enabled: boolean) => {
      if (enabled) {
        const blockers = blockingDependencies(mod, dependencyReport, frameworks);
        if (blockers.length > 0) {
          setDepGuard({ mod, blockers });
          return;
        }
      }
      await applyToggle(mod, enabled);
    },
    [applyToggle, dependencyReport, frameworks],
  );

  const confirmDepGuard = useCallback(() => {
    const pending = depGuard;
    setDepGuard(null);
    if (pending) void applyToggle(pending.mod, true);
  }, [applyToggle, depGuard]);

  const resolveConflict = useCallback(
    async (otherModId: string | null) => {
      const pending = conflictState;
      if (!pending) return;
      setBusyId(pending.mod.id);
      try {
        if (otherModId) {
          const other = snapshot?.state.mods.find((item) => item.id === otherModId);
          if (other) {
            await api.setModEnabled(other.id, false);
          }
        }
        const report = await api.setModEnabled(pending.mod.id, true);
        await refresh();
        setConflictState(null);
        setDetailId(null);
        toast(
          "ok",
          t("toast.deploy.doneTitle", { name: pending.mod.name }),
          t("job.linkSummary", {
            hard: report.hardLinks,
            sym: report.symlinks,
            copies: report.copies,
          }),
          "deploy",
        );
        if (report.modEntry.hasCet) {
          toast("info", t("toast.deploy.cetTitle"), t("toast.deploy.cetDetail"), "deploy");
        }
        for (const warning of report.warnings.slice(0, 2)) {
          toast("warn", t("toast.deploy.warningTitle"), warning, "deploy");
        }
      } catch (error) {
        const parsed = normalizeError(error);
        if (parsed.code === "DEPLOY_CONFLICT" && parsed.conflicts.length > 0) {
          setConflictState({ mod: pending.mod, conflicts: parsed.conflicts });
          toast("error", t("toast.deploy.stillConflict"), parsed.message, "conflict", { sticky: true });
        } else {
          showError(error, t("err.deployAfterResolve"));
        }
      } finally {
        setBusyId(null);
      }
    },
    [conflictState, refresh, showError, snapshot?.state.mods, toast],
  );

  const disableConflictMod = useCallback(
    async (modId: string) => {
      const mod = snapshot?.state.mods.find((item) => item.id === modId);
      if (!mod) return;
      setBusyId(mod.id);
      try {
        await api.setModEnabled(mod.id, false);
        await refresh();
        toast(
          "info",
          t("toast.disable.doneTitle", { name: mod.name }),
          t("toast.disable.conflictDetail"),
          "deploy",
        );
      } catch (error) {
        showError(error, t("err.disableConflictMod"));
      } finally {
        setBusyId(null);
      }
    },
    [refresh, showError, snapshot?.state.mods, toast],
  );

  const performUninstall = useCallback(
    async (mod: ModEntry) => {
      // 先卸子包再卸父级：顺序反了会留下引用已删除暂存目录的条目。
      const children = translationChildren(mod.id, snapshot?.state.mods ?? []);
      for (const child of children) {
        try {
          await api.uninstallMod(child.id);
        } catch {
          // 单个子包失败不阻断父级卸载，最后统一刷新状态。
        }
      }
      setBusyId(mod.id);
      const taskId = addTask("uninstall", t("job.uninstallTitle", { name: mod.name }), t("job.uninstallDetail"));
      patchTask(taskId, { status: "running", progress: 35 });
      try {
        await api.uninstallMod(mod.id);
        setDetailId(null);
        patchTask(taskId, {
          status: "success",
          progress: 100,
          detail: t("job.uninstallDone"),
        });
        try {
          await refresh();
        } catch (error) {
          showError(error, t("err.uninstallRefresh"));
        }
        recordActivity("uninstall", t("toast.uninstall.doneTitle", { name: mod.name }), t("job.uninstallDone"));
        toast("ok", t("toast.uninstall.doneTitle", { name: mod.name }));
      } catch (error) {
        const parsed = normalizeError(error);
        patchTask(taskId, {
          status: "error",
          progress: 100,
          detail: undefined,
          error: parsed.message,
        });
        showError(error, t("err.uninstall"));
      } finally {
        setBusyId(null);
      }
    },
    [addTask, patchTask, refresh, showError, recordActivity, snapshot?.state.mods, toast],
  );

  const handleUninstall = useCallback(
    (mod: ModEntry) => {
      const children = translationChildren(mod.id, snapshot?.state.mods ?? []);
      if (!snapshot?.state.settings.confirmUninstall) {
        void performUninstall(mod);
        return;
      }
      setConfirm({
        title: t("confirm.uninstall.title", { name: mod.name }),
        detail: (
          <div className="confirm-stack">
            <p>
              {t("confirm.uninstall.detailPrefix")}
              <code>deployed_files</code>
              {t("confirm.uninstall.detailSuffix")}
            </p>
            {children.length > 0 ? (
              <p className="confirm-danger">
                {t("confirm.uninstall.translationChildren", { count: children.length })}
              </p>
            ) : null}
            <p className="confirm-danger">{t("confirm.uninstall.danger")}</p>
          </div>
        ),
        confirmLabel: t("confirm.uninstall.confirm"),
        danger: true,
        action: () => performUninstall(mod),
      });
    },
    [performUninstall, snapshot?.state.mods, snapshot?.state.settings.confirmUninstall],
  );

  const handleUpdateCategory = useCallback(
    async (mod: ModEntry, nextCategory: string) => {
      try {
        const updated = await api.updateMod(mod.id, nextCategory);
        setSnapshot((current) =>
          current
            ? {
                ...current,
                state: {
                  ...current.state,
                  mods: current.state.mods.map((item) => (item.id === updated.id ? updated : item)),
                },
              }
            : current,
        );
      } catch (error) {
        showError(error, t("err.updateCategory"));
      }
    },
    [showError],
  );

  const handleSaveOrder = useCallback(
    async (order: string[]) => {
      setSavingOrder(true);
      try {
        const viewNext = await api.saveLoadOrder(order);
        setSnapshot((current) =>
          current
            ? {
                ...current,
                loadOrder: viewNext,
                state: { ...current.state, loadOrder: order },
              }
            : current,
        );
      } catch (error) {
        showError(error, t("err.saveOrder"));
        await refresh();
      } finally {
        setSavingOrder(false);
      }
    },
    [refresh, showError],
  );

  const takeoverModlist = useCallback(
    (thenEnable = true) => {
      setConfirm({
        title: t("confirm.takeover.title"),
        detail: (
          <div className="confirm-stack">
            <p>{t("confirm.takeover.detail")}</p>
            <p>{t("confirm.takeover.note")}</p>
          </div>
        ),
        confirmLabel: t("confirm.takeover.confirm"),
        danger: true,
        action: async () => {
          const result = await api.exportModlist(true);
          if (!thenEnable) {
            await api.setWriteModlist(false);
          }
          await refresh();
          toast(
            "ok",
            t("toast.modlist.takenOverTitle"),
            result.backupPath
              ? t("toast.modlist.backupPath", { path: result.backupPath })
              : t("toast.modlist.written"),
          );
        },
      });
    },
    [refresh, toast],
  );

  const handleToggleWrite = useCallback(
    (enabled: boolean) => {
      if (!snapshot) return;
      if (!snapshot.game) {
        toast("warn", t("toast.game.notLinkedTitle"), t("toast.modlist.noGameDetail"), "system", {
          sticky: true,
        });
        setView("settings");
        return;
      }
      if (enabled && snapshot.loadOrder.modlistExists && !snapshot.loadOrder.managedModlist) {
        takeoverModlist(true);
        return;
      }
      void (async () => {
        try {
          const next = await api.setWriteModlist(enabled);
          setSnapshot((current) =>
            current
              ? {
                  ...current,
                  loadOrder: next,
                  state: {
                    ...current.state,
                    settings: { ...current.state.settings, writeModlist: enabled },
                  },
                }
              : current,
          );
          toast(
            enabled ? "ok" : "info",
            enabled ? t("toast.modlist.enabledTitle") : t("toast.modlist.disabledTitle"),
            enabled ? t("toast.modlist.enabledDetail") : t("toast.modlist.disabledDetail"),
            "deploy",
          );
        } catch (error) {
          const parsed = normalizeError(error);
          if (parsed.code === "MODLIST_UNMANAGED") {
            takeoverModlist(true);
          } else {
            showError(error, t("err.toggleModlist"));
          }
        }
      })();
    },
    [showError, snapshot, takeoverModlist, toast],
  );

  const handleExport = useCallback(() => {
    if (!snapshot?.game) {
      toast("warn", t("toast.game.notLinkedTitle"));
      setView("settings");
      return;
    }
    if (snapshot.loadOrder.archives.length === 0) {
      toast("warn", t("toast.modlist.noArchiveTitle"), t("toast.modlist.noArchiveDetail"), "system", {
        sticky: true,
      });
      return;
    }
    if (snapshot.loadOrder.modlistExists && !snapshot.loadOrder.managedModlist) {
      takeoverModlist(true);
      return;
    }
    void (async () => {
      try {
        const result = await api.exportModlist(false);
        await refresh();
        toast("ok", t("toast.modlist.exportedTitle"), result.path ?? "");
      } catch (error) {
        const parsed = normalizeError(error);
        if (parsed.code === "MODLIST_UNMANAGED") takeoverModlist(true);
        else showError(error, t("err.exportModlist"));
      }
    })();
  }, [refresh, showError, snapshot, takeoverModlist, toast]);

  const handleRemoveModlist = useCallback(() => {
    setConfirm({
      title: t("confirm.removeModlist.title"),
      detail: t("confirm.removeModlist.detail"),
      confirmLabel: t("confirm.removeModlist.confirm"),
      danger: true,
      action: async () => {
        await api.removeModlist();
        await refresh();
        toast("ok", t("toast.modlist.removedTitle"), t("toast.modlist.removedDetail"), "deploy");
      },
    });
  }, [refresh, toast]);

  const handleRestore = useCallback(() => {
    setDanger({
      title: t("confirm.restore.title"),
      detail: (
        <div className="confirm-stack">
          <p>
            {t("confirm.restore.detailPrefix")}
            <code>r6/config</code>
            {t("confirm.restore.detailMiddle")}
            <code>modlist.txt</code>
            {t("confirm.restore.detailSuffix")}
          </p>
          <p className="confirm-danger">{t("confirm.restore.danger")}</p>
        </div>
      ),
      confirmLabel: t("confirm.restore.confirm"),
      action: async () => {
        const result = await api.restoreOriginal();
        await refresh();
        await loadDiagnostics();
        recordActivity(
          "system",
          t("activity.restore"),
          t("activity.restoreDetail", {
            undeployed: result.undeployed,
            restored: result.restoredFiles,
          }),
        );
        toast(
          "ok",
          t("toast.restore.doneTitle"),
          t("toast.restore.doneDetail", {
            undeployed: result.undeployed,
            restored: result.restoredFiles,
          }),
          "deploy",
        );
        for (const warning of result.warnings.slice(0, 2)) {
          toast("warn", t("toast.restore.warningTitle"), warning, "deploy");
        }
      },
    });
  }, [loadDiagnostics, recordActivity, refresh, toast]);

  const handleCreateBackup = useCallback(async () => {
    try {
      await api.createBackup();
      await refresh();
      recordActivity("system", t("activity.backupCreated"), t("activity.backupCreatedDetail"));
      toast("ok", t("toast.backup.doneTitle"), t("toast.backup.doneDetail"));
    } catch (error) {
      showError(error, t("err.createBackup"));
    }
  }, [recordActivity, refresh, showError, toast]);

  /** #1 批量检查 Nexus 模组更新：只发现 + 引导跳转，绝不自动安装。 */
  const runUpdateCheck = useCallback(async () => {
    if (updateChecking) return;
    setUpdateChecking(true);
    try {
      const report = await api.nexusCheckUpdates();
      setUpdateReport(report);
      recordActivity("system", t("activity.updateCheck"), report.message);
      if (report.updates.length > 0) {
        toast(
          "info",
          t("toast.update.foundTitle", { count: report.updates.length }),
          t("toast.update.foundDetail"),
          "update",
        );
      } else {
        toast("ok", t("toast.update.allLatest"), report.message, "update");
      }
    } catch (error) {
      showError(error, t("err.updateCheck"));
    } finally {
      setUpdateChecking(false);
    }
  }, [recordActivity, showError, toast, updateChecking]);

  /**
   * P5-5B：执行更新。单个走 nexus_apply_update，多个走批量命令。
   * 更新前每个模组的旧暂存目录都会打一份 zip 备份，所以这里是可回滚的。
   */
  const handleApplyUpdates = useCallback(
    async (entryIds: string[]) => {
      if (applyingUpdates || entryIds.length === 0) return;
      setApplyingUpdates(true);
      try {
        const report =
          entryIds.length === 1
            ? await (async () => {
                const item = await api.nexusApplyUpdate(entryIds[0]);
                return {
                  applied: item.ok ? 1 : 0,
                  failed: item.ok ? 0 : 1,
                  items: [item],
                  message: item.ok ? (item.warning ?? "") : (item.error ?? ""),
                };
              })()
            : await api.nexusApplyUpdates(entryIds);
        refresh();
        setUpdateReport((current) =>
          current
            ? {
                ...current,
                updates: current.updates.filter(
                  (item) => !report.items.some((done) => done.ok && done.entryId === item.entryId),
                ),
              }
            : current,
        );
        if (report.failed > 0) {
          toast(
            "warn",
            t("toast.update.partialTitle", { applied: report.applied, failed: report.failed }),
            report.items
              .filter((item) => !item.ok)
              .map((item) => `${item.name}：${item.error ?? ""}`)
              .join("；"),
            "update",
          );
        } else {
          toast("ok", t("toast.update.appliedTitle"), report.message, "update");
        }
        recordActivity("deploy", t("activity.updateApplied"), report.message);
      } catch (error) {
        showError(error, t("err.applyUpdate"));
      } finally {
        setApplyingUpdates(false);
      }
    },
    [applyingUpdates, recordActivity, refresh, showError, toast],
  );

  /** P5-5B：回滚到更新前的版本（用最近一次留下的备份）。 */
  const handleRollbackUpdate = useCallback(
    async (entryId: string) => {
      if (applyingUpdates) return;
      setApplyingUpdates(true);
      try {
        const item = await api.nexusRollbackUpdate(entryId);
        refresh();
        toast("ok", t("toast.update.rollbackTitle"), t("toast.update.rollbackDetail", { version: item.toVersion ?? "?" }), "update");
        recordActivity("deploy", t("activity.updateRolledBack"), item.name);
      } catch (error) {
        showError(error, t("err.rollbackUpdate"));
      } finally {
        setApplyingUpdates(false);
      }
    },
    [applyingUpdates, recordActivity, refresh, showError, toast],
  );

  /** P5-5C：检查启动器自身更新（走 tauri-plugin-updater + GitHub Releases 的 latest.json）。 */
  const handleCheckAppUpdate = useCallback(async () => {
    if (!isTauri) {
      toast("info", t("settings.updateUnsupportedTitle"), t("settings.updateUnsupportedDetail"));
      return;
    }
    if (appUpdating) return;
    setAppUpdating(true);
    try {
      const { check } = await import("@tauri-apps/plugin-updater");
      const update = await check();
      if (!update) {
        toast("ok", t("settings.upToDateTitle"), t("settings.upToDateDetail"), "update");
        return;
      }
      const go = window.confirm(
        t("settings.updateConfirm", { version: update.version, current: update.currentVersion }),
      );
      if (!go) return;
      await update.downloadAndInstall();
      toast("ok", t("settings.updateInstalledTitle"), t("settings.updateInstalledDetail"), "update");
    } catch (error) {
      showError(error, t("err.checkAppUpdate"));
    } finally {
      setAppUpdating(false);
    }
  }, [appUpdating, showError, toast]);

  /** 补全收编模组的 Nexus 元数据：文件名里的 ModId → 官方名称/作者/版本/封面。 */
  const runEnrichMetadata = useCallback(async () => {
    if (enriching) return;
    setEnriching(true);
    try {
      const report = await api.enrichNexusMetadata();
      await refresh();
      recordActivity("system", t("activity.enrichMetadata"), report.message);
      if (report.updated > 0) {
        toast(
          "ok",
          t("toast.metadata.enrichedTitle", { count: report.updated }),
          report.message,
        );
      } else {
        toast("info", t("toast.metadata.noneTitle"), report.message);
      }
    } catch (error) {
      showError(error, t("err.enrichMetadata"));
    } finally {
      setEnriching(false);
    }
  }, [enriching, recordActivity, refresh, showError, toast]);

  /** 从 Vortex 数据库导入元数据（A 方案）。 */
  const runVortexImport = useCallback(async () => {
    if (enriching) return;
    setEnriching(true);
    try {
      const message = await api.vortexImportMetadata();
      await refresh();
      recordActivity("system", t("activity.vortexImport"), message);
      toast("ok", t("toast.metadata.vortexTitle"), message);
    } catch (error) {
      showError(error, t("err.vortexImport"));
    } finally {
      setEnriching(false);
    }
  }, [enriching, recordActivity, refresh, showError, toast]);

  // 智能归类：默认只动兜底的「其他 / 工具」，Shift+点击重算全部（跳过手动锁定过的）。
  const [reclassifying, setReclassifying] = useState(false);
  const handleReclassify = useCallback(async (all = false) => {
    if (reclassifying) return;
    setReclassifying(true);
    try {
      const changed = all ? await api.reclassifyAll() : await api.reclassifyUnclassified();
      await refresh();
      if (changed > 0) {
        toast("ok", t("toast.reclassify.doneTitle"), t("toast.reclassify.doneDetail", { count: changed }));
      } else {
        toast("info", t("toast.reclassify.doneTitle"), t("toast.reclassify.zero"));
      }
    } catch (error) {
      showError(error, t("err.reclassify"));
    } finally {
      setReclassifying(false);
    }
  }, [reclassifying, refresh, showError, toast]);

  const handlePickGame = useCallback(async () => {    try {
      let path: string | null = null;
      if (isTauri) {
        const picked = await openDialog({ directory: true, multiple: false });
        path = typeof picked === "string" ? picked : null;
      } else {
        path = window.prompt(t("prompt.gameRoot"), snapshot?.game?.root ?? "D:\\Games\\Cyberpunk 2077");
      }
      if (!path) return;
      const next = await api.setGameDir(path);
      setSnapshot(next);
      toast("ok", t("toast.game.linkedTitle"), path);
    } catch (error) {
      showError(error, t("err.useGameDir"));
    }
  }, [showError, snapshot?.game?.root, toast]);

  const handleAutoDetect = useCallback(async () => {
    try {
      const detected = await api.detectGamePath();
      if (!detected) {
        toast("warn", t("toast.game.notFoundTitle"), t("toast.game.notFoundDetail"));
        return;
      }
      // 已经手动绑过路径时，探测到「另一份」装法要先问一句再覆盖，
      // 免得把玩家辛苦配好的目录换掉。
      const bound = snapshot?.state.gameDir ?? null;
      const isDifferent =
        Boolean(bound) && bound!.trim().toLowerCase() !== detected.root.trim().toLowerCase();
      if (isDifferent) {
        setConfirm({
          title: t("confirm.switchDetected.title"),
          detail: (
            <>
              <p>
                {t("confirm.switchDetected.current")}
                <code>{bound}</code>
              </p>
              <p>
                {t("confirm.switchDetected.detected")}
                <code>{detected.root}</code>
              </p>
              <p>{t("confirm.switchDetected.note")}</p>
            </>
          ),
          confirmLabel: t("confirm.switchDetected.confirm"),
          danger: false,
          action: async () => {
            const next = await api.setGameDir(detected.root);
            setSnapshot(next);
            toast("ok", t("toast.game.switchedTitle"), detected.root);
          },
        });
        return;
      }
      const next = await api.setGameDir(detected.root);
      setSnapshot(next);
      toast("ok", t("toast.game.foundTitle"), detected.root);
    } catch (error) {
      showError(error, t("err.autoDetect"));
    }
  }, [setConfirm, showError, snapshot?.state.gameDir, toast]);

  const handleClearGame = useCallback(() => {
    setDanger({
      title: t("confirm.clearGame.title"),
      detail: t("confirm.clearGame.detail"),
      confirmLabel: t("confirm.clearGame.confirm"),
      action: async () => {
        const next = await api.clearGameDir();
        setSnapshot(next);
        toast("info", t("toast.game.cleared"));
      },
    });
  }, [toast]);

  const handleSettings = useCallback(
    (nextSettings: Settings) => {
      const previous = snapshot?.state.settings;
      setSnapshot((current) =>
        current
          ? { ...current, state: { ...current.state, settings: nextSettings } }
          : current,
      );
      // 保存队列：滑块这类连续输入一秒能来几十次，逐次全量写 launcher-state.json
      // 既浪费也乱序。这里只保留「最新值」，写盘串行 + 250ms 合并窗口——乐观更新
      // 已经让 UI 实时到位，落盘慢半拍无感。
      settingsSaveTarget.current = nextSettings;
      settingsRollback.current = previous ?? null;
      if (settingsSaving.current) return;
      settingsSaving.current = true;
      void (async () => {
        while (settingsSaveTarget.current) {
          const target = settingsSaveTarget.current;
          settingsSaveTarget.current = null;
          await new Promise((resolve) => setTimeout(resolve, 250));
          try {
            await api.setSettings(target);
          } catch (error) {
            // 回滚到这次队列开始前的快照，避免界面显示一个没存上的值。
            const rollback = settingsRollback.current;
            if (rollback) {
              setSnapshot((current) =>
                current
                  ? { ...current, state: { ...current.state, settings: rollback } }
                  : current,
              );
            }
            settingsSaveTarget.current = null;
            showError(error, t("err.saveSettings"));
            break;
          }
        }
        settingsSaving.current = false;
      })();
    },
    [showError, snapshot?.state.settings],
  );

  // 3A-3 裁切构图：选完图（或点「调整构图」）打开模态，确认后把拖拽结果
  // 换算回焦点 0–100 + 缩放倍率走常规设置通道（乐观更新 + 队列落盘）。
  // 必须定义在 handleSettings 之后：依赖数组要在其初始化之后求值。
  const [bgCropOpen, setBgCropOpen] = useState(false);
  const applyBackgroundCrop = useCallback(
    (next: { posX: number; posY: number; zoom: number }) => {
      const current = snapshot?.state.settings;
      if (!current) return;
      handleSettings({
        ...current,
        backgroundPosX: Math.min(100, Math.max(0, Math.round(next.posX))),
        backgroundPosY: Math.min(100, Math.max(0, Math.round(next.posY))),
        backgroundZoom: Math.min(3, Math.max(1, next.zoom)),
      });
    },
    [handleSettings, snapshot?.state.settings],
  );

  const handleLaunch = useCallback(async () => {
    if (!snapshot?.game) {
      toast("warn", t("toast.game.notLinkedTitle"), t("toast.game.notLinkedDetail"), "system", {
        sticky: true,
      });
      setView("settings");
      return;
    }
    if (launching) return;
    setLaunching(true);
    try {
      const result = await api.launchGame();
      await refresh();
      if (result.fallbackFrom) {
        // 直启失败但已自动回退：用 warn 而不是 error，玩家确实已经在进游戏了。
        toast("warn", t("toast.game.launchFallbackTitle"), result.detail);
      } else if (result.method === "already-running") {
        toast("info", t("toast.game.alreadyRunning"), result.detail);
      } else {
        toast("ok", t("toast.game.launchRequested"), result.detail);
      }
    } catch (error) {
      showError(error, t("err.launch"));
    } finally {
      setLaunching(false);
    }
  }, [launching, refresh, showError, snapshot?.game, toast]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      // 协议门开着时，全局快捷键一律不响应（window 监听不会被 inert 挡住，只能自己拦）。
      if (!eulaAccepted) return;
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
        event.preventDefault();
        void handleLaunch();
      }
      if (
        (event.ctrlKey || event.metaKey) &&
        !event.altKey &&
        (event.key.toLowerCase() === "k" ||
          (event.shiftKey && event.key.toLowerCase() === "p"))
      ) {
        event.preventDefault();
        setPaletteOpen(true);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [handleLaunch, eulaAccepted]);

  const handleConfirm = async () => {
    if (!confirm) return;
    setConfirmBusy(true);
    try {
      await confirm.action();
      setConfirm(null);
    } catch (error) {
      showError(error, confirm.title);
      setConfirm(null);
    } finally {
      setConfirmBusy(false);
    }
  };

  const handleDangerConfirm = async () => {
    if (!danger) return;
    setDangerBusy(true);
    try {
      await danger.action();
      setDanger(null);
    } catch (error) {
      showError(error, danger.title);
      setDanger(null);
    } finally {
      setDangerBusy(false);
    }
  };

  const handleResetDemo = () => {
    mockApi.resetDemo();
    window.location.reload();
  };

  const handleEulaAccept = () => {
    markEulaAccepted();
    setEulaClosing(true);
    // 与 CSS 的 .eula-portal 过渡时长保持一致，淡完再卸载。
    window.setTimeout(() => setEulaAccepted(true), EULA_FADE_MS);
  };

  /**
   * 拒绝就是退出。不给"稍后再看"的出口——留了就等于没拦。
   * 浏览器预览里没有 Tauri 窗口 API，退回到 window.close()。
   */
  const handleEulaDecline = () => {
    void getCurrentWindow()
      .close()
      .catch(() => window.close());
  };

  /**
   * 协议门遮罩：盖在主界面之上，而不是替换主界面。
   * 三种形态（致命错误 / 启动骨架 / 主界面）都把它挂在最外层，保证首帧就盖上、不闪一下。
   */
  const eulaGate = eulaAccepted ? null : (
    <EulaDialog
      mode="gate"
      closing={eulaClosing}
      onAccept={handleEulaAccept}
      onDecline={handleEulaDecline}
    />
  );

  // 详情抽屉打开时拉一次「可回滚备份」，供「回滚到旧版本」按钮判断。
  useEffect(() => {
    if (!detailId) return;
    let alive = true;
    void api
      .nexusListUpdateBackups()
      .then((list) => {
        if (alive) setUpdateBackups(list);
      })
      .catch(() => {
        /* 备份清单拿不到不影响主流程，静默即可 */
      });
    return () => {
      alive = false;
    };
  }, [detailId]);

  if (bootError) {
    return (
      <>
        <div className="fatal-screen">
          <div className="fatal-mark">CD</div>
          <h1>{t("boot.fatalTitle")}</h1>
          <pre>{bootError}</pre>
          <button className="btn btn-primary" onClick={() => window.location.reload()}>
            <RefreshCw size={15} /> {t("boot.reload")}
          </button>
        </div>
        {eulaGate}
      </>
    );
  }

  if (!snapshot) {
    return (
      <>
        <div className="boot-screen boot-screen-rich">
          <div className="boot-grid" />
          <div className="boot-content">
            <div className="boot-logo">
              <span>C</span>
              <span>D</span>
            </div>
            <div className="boot-title">{t("boot.brandLine")}</div>
            <div className="boot-sub">{t("boot.sub")}</div>
            <div className="boot-lines">
              <span><i /> {t("boot.lineScanGame")}</span>
              <span><i /> {t("boot.lineReadManifest")}</span>
              <span><i /> {t("boot.lineIndexArchive")}</span>
            </div>
          </div>
          <BootSkeletonGrid />
        </div>
        {eulaGate}
      </>
    );
  }

  const detailMod = detailId
    ? snapshot.state.mods.find((mod) => mod.id === detailId) ?? null
    : null;
  const stagingBytes = snapshot.state.mods.reduce((sum, mod) => sum + mod.sizeBytes, 0);
  const conflictTargets =
    new Set(snapshot.conflicts.map((conflict) => conflict.target.toLowerCase())).size;
  // B1 徽标：加载顺序 / 诊断 = 冲突数；发现 = Nexus 未连接；设置 = 游戏目录未链接。
  // （设置项本身即时保存，不存在"未保存变更"状态，所以这里盯的是最需要行动的绑定。）
  const sidebarBadges: SidebarBadges = {
    loadorder: conflictTargets > 0 ? conflictTargets : undefined,
    diagnostics: conflictTargets > 0 ? conflictTargets : undefined,
    discover: nexus !== null && (!nexus.configured || !nexus.connected) ? "!" : undefined,
    settings: snapshot.game ? undefined : 1,
    downloads: downloadActive > 0 ? downloadActive : undefined,
  };
  const switchSteps = [
    t("confirm.profileSwitch.stepRemove"),
    t("confirm.profileSwitch.stepDeploy"),
    t("confirm.profileSwitch.stepRefresh"),
  ];

  // #1 更新检查命中表：entryId → 更新条目，列表徽标与抽屉共用。
  const updateMap = new Map<string, NexusUpdateItem>(
    (updateReport?.updates ?? []).map((item) => [item.entryId, item]),
  );
  // 结构化前置列表：后端报告优先（能读元数据、核对版本、认整合包自带），
  // 后端没返回时退回本地推断。`satisfied` 与 `ignored` 由工具函数统一算好。
  const detailDeps = detailMod
    ? (() => {
        void depIgnoreTick;
        return effectiveDependencies(detailMod, dependencyReport, frameworks);
      })()
    : [];

  // ── 自定义背景层几何（背景图焦点任务）──────────────────────────────
  // 三层分工必须分清，否则「滑块拖了没反应」：
  //   .app-backdrop      只负责「图怎么摆」——size / position / blur；
  //   .app-backdrop-dim  只负责「压多黑」——和图片完全解耦，铺满整个窗口；
  //   .app-shell 的内容层照旧，靠半透明面板透出下面两层。
  // 分开的直接理由：contain 模式会在左右或上下留白，如果压暗是画在图片元素上的
  // （比如 inset box-shadow / 半透明底板），留白处就是全亮的——图与图之间两块亮度，
  // 正文压在上面照样读不清。所以遮罩必须是独立的一层「不以图片尺寸为界」。
  const bgSettings = snapshot?.state.settings;
  const bgFit = bgSettings?.backgroundFit ?? "cover";
  // 3A-3 裁切模态的缩放倍率：>1 时 background-size 等比放大，焦点负责「看哪里」。
  const bgZoomRaw = Number(bgSettings?.backgroundZoom ?? 1);
  const bgZoom = Number.isFinite(bgZoomRaw) ? Math.min(3, Math.max(1, bgZoomRaw)) : 1;
  // stretch 用 100% 100% 强行铺满；cover / contain 直接把关键字交给 CSS。
  // zoom>1 时改用「宽 = zoom×容器」的百分比尺寸：等比放大、纵向溢出按焦点裁掉，
  // 与裁切模态里的预览完全同一套公式，做到所见即所得。
  const bgSize =
    bgZoom > 1
      ? `${Math.round(bgZoom * 1000) / 10}% auto`
      : bgFit === "stretch"
        ? "100% 100%"
        : bgFit;
  const bgPosX = Math.min(100, Math.max(0, bgSettings?.backgroundPosX ?? 50));
  const bgPosY = Math.min(100, Math.max(0, bgSettings?.backgroundPosY ?? 50));
  const bgOpacity = Math.min(100, Math.max(0, bgSettings?.backgroundOpacity ?? 45));
  const bgBlur = Math.min(40, Math.max(0, bgSettings?.backgroundBlur ?? 0));
  const bgDim = Math.min(100, Math.max(0, bgSettings?.backgroundDim ?? 50));
  // 模糊会在容器边界糊出一圈透明毛边，必须先把层放大再把溢出的部分裁掉（.app-shell
  // 是 overflow:hidden）。补偿量跟着半径走：固定 28px 在 blur > 28 时就会露边，
  // 而 blur = 0 时又白扩一圈——contain 模式下那一圈正好把图的上下边裁掉。
  const bgBleed = bgBlur > 0 ? Math.min(Math.ceil(bgBlur * 1.2), 48) : 0;

  return (
    <MotionConfig reducedMotion={motionEnabled ? "user" : "always"}>
    <>
    <div
      className={`app-shell ${tasks.length > 0 ? "has-tasks" : ""} ${
        detailMod ? "has-drawer" : ""
      }`}
      data-backdrop={backgroundData.dataUrl ? "on" : "off"}
      // 供 CSS 按页面裁剪毛玻璃层（设置页的卡片自带玻璃，主容器不再叠一层）。
      data-page={view}
      // 协议门未过时把底层整块设为 inert：鼠标与键盘都进不去（遮罩本身在它外面，不受影响）。
      inert={eulaAccepted ? undefined : true}
    >
      {backgroundData.dataUrl ? (
        <>
          <div
            className="app-backdrop"
            aria-hidden="true"
            data-bg-fit={bgFit}
            style={{
              backgroundImage: `url("${backgroundData.dataUrl}")`,
              backgroundSize: bgSize,
              backgroundPosition: `${bgPosX}% ${bgPosY}%`,
              opacity: bgOpacity / 100,
              // 3A-1：模糊只在滑块 > 0 时存在；0 时 filter 完全移除，DOM 不留痕迹。
              filter: bgBlur > 0 ? `blur(${bgBlur}px)` : undefined,
              // blur 会糊进上层 UI 的真因是模糊层与内容同层合成：强制独立合成层，
              // 模糊就被关在自己这一层里，不再污染卡片。
              transform: bgBlur > 0 ? "translateZ(0)" : undefined,
              willChange: bgBlur > 0 ? "filter" : undefined,
              // 模糊边缘补偿。写进 style 而不是 CSS：`contain` 在 blur=0 时不能外扩，
              // 否则 28px 的旧固定值会把图上下各裁掉一截。
              inset: bgBleed > 0 ? `-${bgBleed}px` : "0px",
            }}
          />
          {/* 暗化遮罩：独立一层、铺满整个 shell，不以图片尺寸为界——
              `contain` 模式上下留白的地方同样被压暗，正文才不会压在白边上。
              浓度 0 时把 opacity 归零而不是不渲染，避免拖动滑块时节点反复挂载。 */}
          <div
            className="app-backdrop-dim"
            aria-hidden="true"
            style={{ opacity: bgDim / 100 }}
          />
        </>
      ) : null}
      <TitleBar demoMode={snapshot.demoMode} />
      <div className="app-body">
        <Sidebar
          view={view}
          onNavigate={setView}
          snapshot={snapshot}
          stagingBytes={stagingBytes}
          collapsed={preferences.sidebarCollapsed}
          onToggleCollapsed={() =>
            setSidebarCollapsed(!preferences.sidebarCollapsed)
          }
          conflictCount={conflictTargets}
          badges={sidebarBadges}
          hiddenViews={hiddenViews}
          pinnedTools={pinnedTools}
          onLaunchTool={(id) => void launchTool(id)}
        />

        <main className="content-shell">
          <TopBar
            view={view}
            search={search}
            onSearch={(value) => {
              setSearch(value);
              if (view !== "library") setView("library");
            }}
            game={snapshot.game}
            launching={launching}
            profiles={snapshot ? { profiles: snapshot.state.profiles ?? [], activeProfileId: snapshot.state.activeProfileId ?? null } : null}
            switchingProfile={switchingProfile}
            onSwitchProfile={(profileId) => void handleSwitchProfile(profileId)}
            onImport={() => {
              setImportOutcomes(null);
              setImportOpen(true);
            }}
            onOpenPalette={() => setPaletteOpen(true)}
            onLaunch={() => void handleLaunch()}
            gameRunning={gameRunning}
            stopping={stoppingGame}
            onStopGame={() => void handleStopGame()}
            activities={activities}
            updateCount={updateReport?.updates.length ?? 0}
          />

          {/* 状态文件读不出来时，用户只会看到「模组全没了」。必须说清原文件在哪。 */}
          {snapshot.stateRecoveredFrom ? (
            <div className="state-recovery-banner" role="alert">
              <span className="state-recovery-signal" aria-hidden="true">
                <ShieldAlert size={17} strokeWidth={2.4} />
              </span>
              <div className="state-recovery-copy">
                <span className="state-recovery-kicker">{t("banner.stateRecovered.kicker")}</span>
                <strong>{t("banner.stateRecovered.title")}</strong>
                <span className="state-recovery-detail">
                  {t("banner.stateRecovered.detailPrefix")}
                  <code>{snapshot.stateRecoveredFrom}</code>
                  {t("banner.stateRecovered.detailSuffix")}
                </span>
              </div>
            </div>
          ) : null}

          {!snapshot.game ? (
            <div className="setup-banner" role="status">
              <span className="setup-banner-signal" aria-hidden="true">
                <AlertTriangle size={17} strokeWidth={2.4} />
              </span>
              <div className="setup-banner-copy">
                <span className="setup-banner-kicker">{t("banner.noGame.kicker")}</span>
                <strong>{t("banner.noGame.title")}</strong>
                <span className="setup-banner-detail">{t("banner.noGame.detail")}</span>
              </div>
              <button className="btn btn-sm setup-banner-action" onClick={() => void handlePickGame()}>
                {t("banner.noGame.action")} <ChevronRight size={13} />
              </button>
            </div>
          ) : null}

          {snapshot.game?.gameUpdated ? (
            <div className="update-lock-banner" role="alert">
              <span className="update-lock-signal" aria-hidden="true">
                <ShieldAlert size={17} strokeWidth={2.4} />
              </span>
              <div className="update-lock-copy">
                <span className="update-lock-kicker">{t("banner.gameUpdated.kicker")}</span>
                <strong>{t("banner.gameUpdated.title")}</strong>
                <span className="update-lock-detail">
                  {t("banner.gameUpdated.versionLine", {
                    from: snapshot.game?.lastGameVersion ?? t("common.unknown"),
                    to: snapshot.game?.version ?? t("common.unknown"),
                  })}
                  {t("banner.gameUpdated.detail1")}
                  {t("banner.gameUpdated.detail2")}
                </span>
              </div>
              <button
                className="btn btn-sm update-lock-action"
                onClick={() => void handleClearUpdateLock()}
                disabled={unlocking}
              >
                {unlocking ? t("banner.gameUpdated.unlocking") : t("banner.gameUpdated.unlock")}
              </button>
            </div>
          ) : null}

          {switchingProfile ? (
            <div className="switch-steps" role="status">
              <span className="switch-steps-label">{t("banner.profileSwitchLabel")}</span>
              {switchSteps.map((label, index) => (
                <span
                  key={label}
                  className={`switch-step ${index === switchStep ? "is-active" : index < switchStep ? "is-done" : ""}`}
                >
                  <i>{index < switchStep ? "✓" : index + 1}</i>
                  {label}
                </span>
              ))}
            </div>
          ) : null}

          <div className={`content ${snapshot.game || snapshot.stateRecoveredFrom ? "" : "with-setup-banner"} ${snapshot.game?.gameUpdated ? "with-update-lock" : ""}`}>
            {/* 换页用 mode="wait"：旧页先淡出再挂新页，避免两个视图同时占布局。
                首帧 initial={false}——冷启动不该看到一次"页面飞入"。 */}
            <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={view}
              className="view-stage"
              variants={routeVariants}
              initial="hidden"
              animate="visible"
              exit="exit"
            >
            {view === "library" ? (
              <LibraryView
                snapshot={snapshot}
                conflicts={snapshot.conflicts}
                frameworks={frameworks}
                dependencyReport={dependencyReport}
                search={search}
                category={category}
                sort={sort}
                busyId={busyId}
                onCategory={setCategory}
                onSort={setSort}
                onToggle={(mod, enabled) => void handleToggle(mod, enabled)}
                onOpen={(mod) => setDetailId(mod.id)}
                onOpenConflicts={() => setConflictCenterOpen(true)}
                onRefresh={() => void refresh()}
                onImport={() => {
                  setImportOutcomes(null);
                  setImportOpen(true);
                }}
                onGoSettings={() => setView("settings")}
                onGoDiscover={() => setView("discover")}
                updateMap={updateMap}
                onUpdateCheck={() => void runUpdateCheck()}
                updateChecking={updateChecking}
                onApplyUpdates={(ids) => void handleApplyUpdates(ids)}
                applyingUpdates={applyingUpdates}
                onEnrichMetadata={() => void runEnrichMetadata()}
                enriching={enriching}
                onVortexImport={() => void runVortexImport()}
                onReclassify={() => void handleReclassify()}
                reclassifying={reclassifying}
                view={preferences.libraryView}
                onViewChange={setLibraryView}
              />
            ) : null}

            {view === "discover" ? (
              <Suspense fallback={<ViewFallback />}>
                <NexusView
                  onImported={async () => {
                    await refresh();
                  }}
                  onError={showError}
                  onToast={toast}
                  onNavigateSettings={() => setView("settings")}
                />
              </Suspense>
            ) : null}

            {view === "loadorder" ? (
              <LoadOrderView
                snapshot={snapshot}
                conflicts={snapshot.conflicts}
                saving={savingOrder}
                onSave={handleSaveOrder}
                onToggleWrite={handleToggleWrite}
                onExport={handleExport}
                onRemoveModlist={handleRemoveModlist}
                onOpenMod={setDetailId}
              />
            ) : null}

            {view === "downloads" ? (
              <DownloadsView onNavigateDiscover={() => setView("discover")} dataDir={appData || null} />
            ) : null}

            {view === "diagnostics" ? (
              <Suspense fallback={<ViewFallback />}>
                <DiagnosticsView
                  report={diagnostics}
                  loading={diagLoading}
                  onRefresh={() => void loadDiagnostics()}
                  onCreateBackup={() => void handleCreateBackup()}
                  onRestore={handleRestore}
                  onOpenLogs={() => {
                    void api.openLogsFolder().catch((error) => showError(error, t("err.openLogs")));
                  }}
                  onNavigate={setView}
                  onOpenPath={(path) => {
                    void api.openPath(path).catch((error) => showError(error, t("err.openPath")));
                  }}
                onAdopt={() => void handleAdoptScan()}
                onOpenUrl={(url) => {
                  void api.openUrl(url).catch((error) => showError(error, t("err.openRelease")));
                }}
                settings={snapshot.state.settings}
                  onSettings={handleSettings}
                  onError={showError}
                  openLogsRequest={logViewerRequest}
                />
              </Suspense>
            ) : null}

            {view === "saves" ? (
              <Suspense fallback={<ViewFallback />}>
                <SavesView
                  saveEditorPath={snapshot.state.settings.saveEditorPath ?? ""}
                  onOpenSettings={() => {
                    // 编辑器路径在「设置 → 工具组件」里配置。
                    setSettingsTabRequest("tools");
                    setView("settings");
                  }}
                  onError={showError}
                />
              </Suspense>
            ) : null}

            {view === "settings" ? (
              <Suspense fallback={<ViewFallback />}>
                <SettingsView
                initialTab={settingsTabRequest}
                snapshot={snapshot}
                backgroundLoading={bgLoading}
                appData={appData}
                stagingBytes={stagingBytes}
                demoMode={snapshot.demoMode}
                onPickGame={() => void handlePickGame()}
                onAutoDetect={() => void handleAutoDetect()}
                onClearGame={handleClearGame}
                onSettings={handleSettings}
                onAdjustBackground={() => setBgCropOpen(true)}
                onCheckAppUpdate={() => void handleCheckAppUpdate()}
                appUpdating={appUpdating}
                onRefreshMods={() => void refresh()}
                onToggleWrite={handleToggleWrite}
                onOpenPath={(path) => {
                  void api.openPath(path).catch((error) => showError(error, t("err.openPath")));
                }}
                onCreateBackup={() => void handleCreateBackup()}
                onRestore={handleRestore}
                onResetDemo={handleResetDemo}
                onError={showError}
                preferences={preferences}
                onSelectTheme={selectTheme}
                onAccent={setAccent}
                onResetAccent={resetAccent}
                onScale={setScale}
                onUiFont={setUiFont}
                onCodeFont={setCodeFont}
                onCustomUiFont={setCustomUiFont}
                onCustomCodeFont={setCustomCodeFont}
                onSidebarCollapsed={setSidebarCollapsed}
            onAnimations={setAnimations}
            onSplash={setSplash}
                notificationPrefs={notificationPrefs}
                onNotificationPrefsChange={handleNotificationPrefsChange}
                notificationDuration={notificationDuration}
                onNotificationDurationChange={handleNotificationDurationChange}
                onTestNotification={handleTestNotification}
                onShowEula={() => setEulaViewerOpen(true)}
                hiddenViews={hiddenViews}
                onToggleHiddenView={toggleHiddenView}
              />
              </Suspense>
            ) : null}
            </motion.div>
            </AnimatePresence>
          </div>
        </main>
      </div>

      {/* AnimatePresence 必须包在抽屉外面：退出动画期间 framer 会继续
          渲染"已经移除"的那份元素，所以 detailMod 变成 null 也不会闪空。
          key 用常量而不是 mod.id——在抽屉里切换模组不该重新滑入一次。 */}
      <AnimatePresence>
      {detailMod ? (
        <ModDetailDrawer
          key="mod-detail-drawer"
          mod={detailMod}
          conflicts={snapshot.conflicts}
          missingDeps={detailDeps}
          translationChildren={translationChildren(
            detailMod.id,
            snapshot.state.mods,
          )}
          onUnbindTranslation={async (childId) => {
            try {
              await api.setTranslationParent(childId, null);
              await refresh();
              toast("info", t("toast.translation.unboundTitle"), t("toast.translation.unboundDetail"));
            } catch (error) {
              showError(error, t("err.bindTranslation"));
            }
          }}
          updateInfo={updateMap.get(detailMod.id) ?? null}
          backupInfo={
            updateBackups.find((item) => item.entryId === detailMod.id) ?? null
          }
          onApplyUpdate={() => void handleApplyUpdates([detailMod.id])}
          onRollbackUpdate={() => void handleRollbackUpdate(detailMod.id)}
          applyingUpdate={applyingUpdates}
          busy={busyId === detailMod.id}
          onClose={() => setDetailId(null)}
          onToggle={(enabled) => void handleToggle(detailMod, enabled)}
          onUninstall={() => handleUninstall(detailMod)}
          onUpdateCategory={(nextCategory) => void handleUpdateCategory(detailMod, nextCategory)}
          onReveal={() => {
            void api.revealMod(detailMod.id).catch((error) => showError(error, t("err.openStaging")));
          }}
          onOpenNexus={(url) => {
            void api.openUrl(url).catch((error) => showError(error, t("err.openNexus")));
          }}
          onGetPrerequisite={(name) => {
            void api
              .openUrl(nexusSearchUrl(name))
              .catch((error) => showError(error, t("err.openPrerequisite")));
          }}
          onIgnoreDependency={(frameworkId) => {
            if (!detailMod) return;
            ignoreDependency(detailMod.id, frameworkId);
            setDepIgnoreTick((value) => value + 1);
            toast("info", t("toast.dependency.ignoredTitle"), t("toast.dependency.ignoredDetail"));
          }}
          onRestoreDependency={(frameworkId) => {
            if (!detailMod) return;
            restoreDependency(detailMod.id, frameworkId);
            setDepIgnoreTick((value) => value + 1);
          }}
          onAttachNexus={async (url) => {
            try {
              await api.attachModFromNexus(detailMod.id, url);
              await refresh();
              toast("ok", t("toast.metadata.attachedTitle"), t("toast.metadata.attachedDetail"));
            } catch (error) {
              showError(error, t("err.attachNexus"));
            }
          }}
          onSaveMetadata={async (fields) => {
            try {
              await api.updateModMetadata(detailMod.id, fields);
              await refresh();
              toast("ok", t("toast.metadata.savedTitle"), t("toast.metadata.savedDetail", { name: fields.name }));
            } catch (error) {
              showError(error, t("err.saveMetadata"));
            }
          }}
          onToast={toast}
          onError={showError}
          onOpenPath={(path) => {
            void api.openPath(path).catch((error) => showError(error, t("err.openStaging")));
          }}
        />
      ) : null}
      </AnimatePresence>

      <ImportDialog
        open={importOpen}
        busy={importing}
        savingCategories={savingCategories}
        outcomes={importOutcomes}
        libraryMods={snapshot.state.mods}
        onClose={() => {
          setImportOpen(false);
          window.setTimeout(() => setImportOutcomes(null), 250);
        }}
        onImport={queueImports}
        onSaveCategories={saveImportCategories}
      />

      <ConfirmDialog
        open={Boolean(confirm)}
        title={confirm?.title ?? ""}
        detail={confirm?.detail}
        confirmLabel={confirm?.confirmLabel}
        danger={confirm?.danger}
        busy={confirmBusy}
        onConfirm={() => void handleConfirm()}
        onClose={() => {
          if (!confirmBusy) setConfirm(null);
        }}
      />

      {/* 汉化包绑定：导入后逐条询问父级，默认维持独立安装。 */}
      <TranslationBindDialog
        mod={bindQueue[0] ?? null}
        mods={snapshot?.state.mods ?? []}
        busy={busyId === bindQueue[0]?.id}
        onSkip={() => setBindQueue((queue) => queue.slice(1))}
        onBind={async (parentId) => {
          const mod = bindQueue[0];
          if (!mod) return;
          try {
            setBusyId(mod.id);
            await api.setTranslationParent(mod.id, parentId);
            await refresh();
            const parent = snapshot?.state.mods.find((item) => item.id === parentId);
            toast(
              "ok",
              t("toast.translation.boundTitle"),
              t("toast.translation.boundDetail", { parent: parent?.name ?? "" }),
            );
            setBindQueue((queue) => queue.slice(1));
          } catch (error) {
            showError(error, t("err.bindTranslation"));
          } finally {
            setBusyId(null);
          }
        }}
      />

      {/* 启用拦截：缺前置时先说清楚代价，用户点「仍然启用」才继续。 */}
      <ConfirmDialog
        open={Boolean(depGuard)}
        title={t("depGuard.title", { name: depGuard?.mod.name ?? "" })}
        confirmLabel={t("depGuard.confirm")}
        detail={
          <div className="dep-guard">
            <p>{t("depGuard.intro")}</p>
            <ul className="dep-guard-list">
              {(depGuard?.blockers ?? []).map((item) => (
                <li key={item.id}>
                  <b>{item.name}</b>
                  <span>{item.detail}</span>
                </li>
              ))}
            </ul>
            <p className="dep-guard-note">{t("depGuard.note")}</p>
          </div>
        }
        onConfirm={confirmDepGuard}
        onClose={() => setDepGuard(null)}
      />

      <ConflictCenter
        open={conflictCenterOpen}
        conflicts={snapshot.conflicts}
        snapshot={snapshot}
        busyId={busyId}
        onClose={() => setConflictCenterOpen(false)}
        onDisable={(modId) => void disableConflictMod(modId)}
        onOpenMod={(modId) => {
          setConflictCenterOpen(false);
          setDetailId(modId);
        }}
        onOpenLoadOrder={() => {
          setConflictCenterOpen(false);
          setView("loadorder");
        }}
        onOpenDiagnostics={() => {
          setConflictCenterOpen(false);
          setView("diagnostics");
        }}
        onError={showError}
      />

      <ConflictDialog
        open={Boolean(conflictState)}
        mod={conflictState?.mod ?? null}
        conflicts={conflictState?.conflicts ?? []}
        snapshot={snapshot}
        busy={Boolean(conflictState && busyId === conflictState.mod.id)}
        onResolve={(otherId) => void resolveConflict(otherId)}
        onClose={() => {
          if (!busyId) setConflictState(null);
        }}
        onOpenPath={(path) => {
          void api.openPath(path).catch((error) => showError(error, t("err.openGameDir")));
        }}
      />

      {/* 右下角浮层栈：toast 在任务面板之上垂直排列，
          两者共用同一容器 ⇒ 结构上不可能互相遮挡（旧版是各自 fixed 定位，靠魔法数字避让）。 */}
      <div className="floating-stack">
        <ToastHost
          toasts={toasts}
          onDismiss={(id) => setToasts((items) => items.filter((item) => item.id !== id))}
        />
        <TaskCenter
          tasks={tasks}
          activities={activities}
          onClearFinished={clearFinishedTasks}
          onClearActivities={clearActivities}
          onDismiss={dismissTask}
          onRetry={(paths) => void queueImports(paths)}
        />
      </div>

      {dropActive ? (
        <div className="drop-overlay" role="status">
          <div className="drop-overlay-box">
            <Upload size={26} strokeWidth={2.2} />
            <strong>{t("drop.title")}</strong>
            <span>{t("drop.detail")}</span>
          </div>
        </div>
      ) : null}

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        mods={snapshot.state.mods}
        conflictCount={
          new Set(snapshot.conflicts.map((conflict) => conflict.target.toLowerCase())).size
        }
        onOpenMod={(mod) => {
          setPaletteOpen(false);
          setDetailId(mod.id);
        }}
        onNavigate={(next) => {
          setPaletteOpen(false);
          setView(next);
        }}
        onImport={() => {
          setPaletteOpen(false);
          setImportOutcomes(null);
          setImportOpen(true);
        }}
        onLaunch={() => {
          setPaletteOpen(false);
          void handleLaunch();
        }}
        onOpenConflicts={() => {
          setPaletteOpen(false);
          setConflictCenterOpen(true);
        }}
        onOpenLogs={() => {
          setPaletteOpen(false);
          setView("diagnostics");
          setLogViewerRequest((value) => value + 1);
        }}
        onOpenStaging={() => {
          setPaletteOpen(false);
          void api
            .openPath(snapshot.state.stagingDir)
            .catch((error) => showError(error, t("err.openStaging")));
        }}
        onExportModlist={() => {
          setPaletteOpen(false);
          handleExport();
        }}
        onAdopt={() => {
          setPaletteOpen(false);
          void handleAdoptScan();
        }}
      />

      {bgCropOpen && backgroundData.dataUrl ? (
        <BackgroundCropDialog
          dataUrl={backgroundData.dataUrl}
          initialPosX={bgPosX}
          initialPosY={bgPosY}
          initialZoom={bgZoom}
          onConfirm={(next) => {
            applyBackgroundCrop(next);
            setBgCropOpen(false);
          }}
          onClose={() => setBgCropOpen(false)}
        />
      ) : null}

      <AdoptPreviewDialog
        open={adoptOpen}
        scan={adoptScan}
        loading={adoptScanning}
        executing={adoptExecuting}
        progress={adoptProgress}
        report={adoptReport}
        onClose={() => {
          if (!adoptExecuting) setAdoptOpen(false);
        }}
        onRefresh={() => void handleAdoptScan()}
        onConfirm={(selected) => void handleAdoptExecute(selected)}
        onCancel={handleAdoptCancel}
      />

      <NxmIntake
        items={nxmItems}
        onInstall={(item) => void runNxm(item)}
        onOpenPage={openNxmPage}
        onDismiss={dismissNxm}
        onDismissAll={dismissAllNxm}
      />

      <DangerConfirmModal
        open={Boolean(danger)}
        title={danger?.title ?? ""}
        detail={danger?.detail}
        confirmLabel={danger?.confirmLabel}
        busy={dangerBusy}
        onConfirm={() => void handleDangerConfirm()}
        onClose={() => {
          if (!dangerBusy) setDanger(null);
        }}
      />

      {eulaViewerOpen ? (
        <EulaDialog mode="viewer" onClose={() => setEulaViewerOpen(false)} />
      ) : null}

    </div>
    {/* 遮罩放在 app-shell 之外：底层会被切成 inert，遮罩自己必须还能收事件。 */}
    {eulaGate}
    {/* 首帧 splash：≤800ms，点击即跳过；关闭时组件立刻 onDone 并返回 null。 */}
    <SplashScreen enabled={!splashDone && preferences.splash} onDone={() => setSplashDone(true)} />
    </>
    </MotionConfig>
  );
}
