import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  Archive,
  Check,
  Copy,
  Database,
  Download,
  FolderOpen,
  FolderSearch,
  ExternalLink,
  Gamepad2,
  HardDrive,
  Info,
  Layers,
  MonitorPlay,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  ScrollText,
  ShieldCheck,
  Sparkles,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import type { DownloadQueueSettings, DriveSuggestion, LaunchCheck, NxmStatus, Settings, Snapshot } from "../types";
import { compactPath, formatBytes, relativeTime } from "../lib/format";
import { useAppVersion } from "../lib/appVersion";
import { api, normalizeError } from "../lib/api";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Badge, Spinner, SwitchRow } from "./ui";
import { ExternalToolsCard } from "./ExternalToolsCard";
import type { HiddenViewsMap, HideableView } from "../lib/uiPrefs";
import { NexusSettingsCard } from "./NexusSettingsCard";
import { AiSettingsCard } from "./AiSettingsCard";
import { AppearanceSettings, type BackgroundFit } from "./AppearanceSettings";
import type { CodeFontId, UiFontId } from "../lib/fonts";
import { ConfigPackCard } from "./ConfigPackCard";
import { GlossaryShareCard } from "./GlossaryShareCard";
import { HelpCenterView } from "./HelpCenterView";
import { SafeModeCard } from "./SafeModeCard";
import { VortexTakeoverCard } from "./VortexTakeoverCard";
import { gameVersionText } from "../lib/gameVersion";
import { SettingsTabs, type SettingsTabId } from "./SettingsTabs";
import type { Preferences, ThemeId } from "../lib/preferences";
import type {
  NotificationCategory,
  NotificationDuration,
  NotificationPrefs,
} from "../lib/notify";
import {
  clampNotificationSeconds,
  DEFAULT_NOTIFICATION_DURATION,
  NOTIFICATION_DURATION_MAX,
  NOTIFICATION_DURATION_MIN,
  NOTIFICATION_DURATION_PRESETS,
} from "../lib/notify";
import { t } from "../i18n";

/**
 * 2D 通知停留时长分段控件：3 / 5 / 10 / 自定义（1–60 整数秒）/ 不自动隐藏。
 *
 * 复用外观页缩放控件的 `.scale-segmented` 一族样式（同一套分段视觉语言），
 * 自定义档同样「原地变输入框」：非数字字符直接拦在 onChange，越界在提交时
 * 自动修正并闪一条提示，不弹窗不打断。
 */
function NotificationDurationRow({
  value,
  onChange,
}: {
  value: NotificationDuration;
  onChange: (value: NotificationDuration) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(DEFAULT_NOTIFICATION_DURATION));
  const [hint, setHint] = useState("");
  const hintTimer = useRef<number | null>(null);

  const customActive = typeof value === "number" && !NOTIFICATION_DURATION_PRESETS.includes(value as 3 | 5 | 10);

  const flash = (message: string) => {
    setHint(message);
    if (hintTimer.current !== null) window.clearTimeout(hintTimer.current);
    hintTimer.current = window.setTimeout(() => setHint(""), 2400);
  };

  const commit = (raw: string) => {
    const parsed = Number.parseInt(raw.replace(/[^\d]/g, ""), 10);
    // 空输入 / 纯非法字符：安静回退到当前生效值，不报错。
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setDraft(String(typeof value === "number" ? value : DEFAULT_NOTIFICATION_DURATION));
      setEditing(false);
      return;
    }
    if (parsed < NOTIFICATION_DURATION_MIN) flash(t("settings.notifDurationMinHint"));
    else if (parsed > NOTIFICATION_DURATION_MAX) flash(t("settings.notifDurationMaxHint"));
    const clamped = clampNotificationSeconds(parsed);
    onChange(clamped);
    setDraft(String(clamped));
    setEditing(false);
  };

  const startEditing = () => {
    setDraft(String(typeof value === "number" ? value : DEFAULT_NOTIFICATION_DURATION));
    setEditing(true);
  };

  return (
    <div className="notif-duration-row">
      <div className="notif-duration-copy">
        <strong>{t("settings.notifDuration")}</strong>
        <span>{t("settings.notifDurationDesc")}</span>
      </div>
      <div className="scale-segmented" role="group" aria-label={t("settings.notifDuration")}>
        {NOTIFICATION_DURATION_PRESETS.map((seconds) => (
          <button
            key={seconds}
            type="button"
            className={`scale-seg ${value === seconds ? "selected" : ""}`}
            aria-pressed={value === seconds}
            onClick={() => onChange(seconds)}
          >
            {t("settings.notifDurationSeconds", { count: seconds })}
          </button>
        ))}
        {editing ? (
          <span className="scale-seg scale-seg-input">
            <input
              type="text"
              inputMode="numeric"
              value={draft}
              autoFocus
              aria-label={t("settings.notifDurationCustom")}
              onChange={(event) => setDraft(event.target.value.replace(/[^\d]/g, "").slice(0, 3))}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  commit(draft);
                } else if (event.key === "Escape") {
                  setEditing(false);
                }
              }}
              onBlur={() => commit(draft)}
            />
            <i>{t("settings.notifDurationUnit")}</i>
          </span>
        ) : (
          <button
            type="button"
            className={`scale-seg scale-seg-custom ${customActive ? "selected" : ""}`}
            aria-pressed={customActive}
            onClick={startEditing}
            title={t("settings.notifDurationCustom")}
          >
            <Pencil size={11} />
            {t("settings.notifDurationCustom")}
            {customActive && typeof value === "number" ? (
              <em className="notif-duration-current">
                {value}
                {t("settings.notifDurationUnit")}
              </em>
            ) : null}
          </button>
        )}
        <button
          type="button"
          className={`scale-seg ${value === "never" ? "selected" : ""}`}
          aria-pressed={value === "never"}
          onClick={() => onChange("never")}
        >
          {t("settings.notifDurationNever")}
        </button>
      </div>
      {hint ? <span className="scale-hint notif-duration-hint">{hint}</span> : null}
    </div>
  );
}

export function SettingsView({
  snapshot,
  backgroundLoading = false,
  appData,
  stagingBytes,
  demoMode,
  onPickGame,
  onAutoDetect,
  onClearGame,
  onSettings,
  onAdjustBackground,
  onCheckAppUpdate,
  appUpdating = false,
  onRefreshMods,
  onToggleWrite,
  onOpenPath,
  onCreateBackup,
  onRestore,
  onResetDemo,
  onError,
  preferences,
  onSelectTheme,
  onAccent,
  onResetAccent,
  onScale,
  onUiFont,
  onCodeFont,
  onCustomUiFont,
  onCustomCodeFont,
  onSplash,
  onSidebarCollapsed,
  onAnimations,
  onMotionSpeed,
  notificationPrefs,
  onNotificationPrefsChange,
  notificationDuration,
  onNotificationDurationChange,
  onTestNotification,
  onShowEula,
  initialTab = "appearance",
  onTabChange,
  hiddenViews = {},
  onToggleHiddenView,
}: {
  snapshot: Snapshot;
  /** 3D：背景图读盘+压缩进行中（选图后到应用前）。 */
  backgroundLoading?: boolean;
  appData: string;
  stagingBytes: number;
  demoMode: boolean;
  onPickGame: () => void;
  onAutoDetect: () => void;
  onClearGame: () => void;
  onSettings: (settings: Settings) => void;
  /** 3A-3：打开背景构图模态（App 持有 dataUrl，弹窗只能挂在那里）。 */
  onAdjustBackground: () => void;
  /** P5-5C：检查启动器自身更新。 */
  onCheckAppUpdate?: () => void;
  appUpdating?: boolean;
  onRefreshMods: () => void;
  onToggleWrite: (enabled: boolean) => void;
  onOpenPath: (path: string) => void;
  onCreateBackup: () => void;
  onRestore: () => void;
  onResetDemo: () => void;
  onError: (error: unknown, title?: string) => void;
  preferences: Preferences;
  onSelectTheme: (theme: ThemeId) => void;
  onAccent: (accent: string) => void;
  onResetAccent: () => void;
  onScale: (scale: number) => void;
  onUiFont: (font: UiFontId) => void;
  onCodeFont: (font: CodeFontId) => void;
  onCustomUiFont: (font: string) => void;
  onCustomCodeFont: (font: string) => void;
  onSidebarCollapsed: (collapsed: boolean) => void;
  onAnimations: (value: boolean) => void;
  /** 动画速度百分比（个性化 → 高级设置）。 */
  onMotionSpeed: (value: number) => void;
  onSplash: (value: boolean) => void;
  /** 通知分类偏好（r12）。 */
  notificationPrefs: NotificationPrefs;
  onNotificationPrefsChange: (prefs: NotificationPrefs) => void;
  /** 2D 通知停留时长（秒或 "never"）。 */
  notificationDuration: NotificationDuration;
  onNotificationDurationChange: (value: NotificationDuration) => void;
  onTestNotification: (category: NotificationCategory) => void;
  /** 在「关于」里重新打开使用协议（只展示，不拦截）。 */
  onShowEula: () => void;
  /** 打开时默认选中的分区。 */
  initialTab?: SettingsTabId;
  /** 分区切换回调（可选，用于外部联动）。 */
  onTabChange?: (tab: SettingsTabId) => void;
  /** 界面显示管理（deepseek 任务·模块四）。 */
  hiddenViews?: HiddenViewsMap;
  onToggleHiddenView?: (view: HideableView, hidden: boolean) => void;
}) {
  // 版本号统一从 Tauri getVersion() 取，禁止硬编码（见 docs/AGENTS.md 版本更新自动化规范）。
  const appVersion = useAppVersion();
  const state = snapshot.state;
  const game = snapshot.game;
  const settings = state.settings;
  const deployedCount = state.mods.filter((mod) => mod.deployedFiles.length > 0).length;
  const [archiveTool, setArchiveTool] = useState(settings.archiveToolPath);
  const [wolvenkitPath, setWolvenkitPath] = useState(settings.wolvenkitCliPath);
  const [wolvenkitTimeout, setWolvenkitTimeout] = useState(settings.wolvenkitTimeoutSecs);
  const [launchCheck, setLaunchCheck] = useState<LaunchCheck | null>(null);
  // 暂存区迁移与工具探测的回显：这类操作结果就地显示，不占用全局 toast。
  const [stagingNote, setStagingNote] = useState<string | null>(null);
  // 暂存区建议（deepseek 任务·模块一）：null = 未查询，[] = 查过但没结果。
  const [stagingSuggestions, setStagingSuggestions] = useState<DriveSuggestion[] | null>(null);
  const [toolNote, setToolNote] = useState<Record<string, string>>({});

  // ── 下载设置（r20 从下载中心搬进来：下载中心只留任务列表） ──
  const [queueSettings, setQueueSettings] = useState<DownloadQueueSettings | null>(null);
  const [proxyDraft, setProxyDraft] = useState("");
  const [queueNote, setQueueNote] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void api
      .downloadQueueGetSettings()
      .then((loaded) => {
        if (!alive) return;
        setQueueSettings(loaded);
        setProxyDraft(loaded.proxy ?? "");
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  const flashQueue = (message: string) => {
    setQueueNote(message);
    window.setTimeout(() => setQueueNote((current) => (current === message ? null : current)), 2600);
  };
  // 下载设置是「全量参数」接口（concurrency/autoImport/dir/proxy/speedLimit 一起传），
  // 以前每次都从闭包里取旧值拼参：刚改完并发数、请求还没回来时再切一次自动导入，
  // 就用旧的并发数把新值覆盖回去。这里改成「ref 立即合并 + 请求串行」：
  //   - ref 拿到的是最新一次 patch 之后的值，不会再回退；
  //   - 串行链保证落盘顺序与点击顺序一致，也不再有响应乱序。
  const queueSettingsRef = useRef<DownloadQueueSettings | null>(null);
  const queueChainRef = useRef<Promise<void>>(Promise.resolve());
  useEffect(() => {
    queueSettingsRef.current = queueSettings;
  }, [queueSettings]);
  const commitQueueSettings = (patch: Partial<DownloadQueueSettings>): Promise<void> => {
    const base = queueSettingsRef.current;
    if (!base) return Promise.resolve();
    const merged: DownloadQueueSettings = { ...base, ...patch };
    queueSettingsRef.current = merged;
    setQueueSettings(merged);
    queueChainRef.current = queueChainRef.current.then(async () => {
      try {
        const next = await api.downloadQueueSetSettings(
          merged.concurrency,
          merged.autoImport,
          merged.dir,
          merged.proxy,
          merged.speedLimitMbps,
        );
        // 只有这次仍是"最后一笔"时才用后端返回值覆盖，否则会把用户刚改的
        // 下一项拉回旧值（后端返回的是它落盘那一刻的整份设置）。
        if (queueSettingsRef.current === merged) {
          queueSettingsRef.current = next;
          setQueueSettings(next);
        }
        flashQueue(t("downloads.savedNote"));
      } catch (error) {
        // 失败就把 UI 拉回这次合并之前的值，不要留一个没落盘的假象。
        if (queueSettingsRef.current === merged) {
          queueSettingsRef.current = base;
          setQueueSettings(base);
        }
        flashQueue(normalizeError(error).message);
      }
    });
    return queueChainRef.current;
  };
  // NXM 协议归属（deepseek 任务·模块二）：下载设置里显示归属 + 一键修复（接管协议）。
  const [nxmState, setNxmState] = useState<NxmStatus | null>(null);
  useEffect(() => {
    let alive = true;
    api
      .nxmStatus()
      .then((status) => {
        if (alive) setNxmState(status);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  const repairNxm = async () => {
    try {
      setNxmState(await api.nxmTakeover());
      flashQueue(t("downloads.nxmRepaired"));
    } catch (error) {
      flashQueue(error instanceof Error ? error.message : String(error));
    }
  };
  const pickDownloadDir = async () => {
    if (!queueSettingsRef.current) return;
    try {
      const picked = await openDialog({ directory: true, multiple: false });
      if (typeof picked !== "string" || !picked) return;
      await commitQueueSettings({ dir: picked });
      flashQueue(t("downloads.dirSaved", { path: picked }));
    } catch {
      flashQueue(t("downloads.dirPickFailed"));
    }
  };
  // 名字沿用原调用点：内部已经改成 ref 合并 + 串行落盘（见 commitQueueSettings）。
  const updateQueueSettings = (patch: Partial<DownloadQueueSettings>) => {
    void commitQueueSettings(patch);
  };

  // 分区切换只改 state，不给内容区加 key —— 六个面板常驻 DOM，
  // 未保存的输入和子组件内部状态不会因为切换而丢失。
  const [activeTab, setActiveTab] = useState<SettingsTabId>(initialTab);
  // 外部入口（如存档页「去配置」）在组件已挂载时也能切换 Tab：
  // initialTab 只决定首次渲染，后续请求靠这个 effect 跟上。
  useEffect(() => {
    setActiveTab(initialTab);
  }, [initialTab]);
  const contentRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setArchiveTool(settings.archiveToolPath);
    setWolvenkitPath(settings.wolvenkitCliPath);
    setWolvenkitTimeout(settings.wolvenkitTimeoutSecs);
  }, [settings.archiveToolPath, settings.wolvenkitCliPath, settings.wolvenkitTimeoutSecs]);

  // 换分区后内容区回到顶部。用 useLayoutEffect 让复位发生在绘制前，
  // 避免短暂露出上一个分区的滚动位置。
  useLayoutEffect(() => {
    if (contentRef.current) contentRef.current.scrollTop = 0;
  }, [activeTab]);

  const update = (patch: Partial<Settings>) => onSettings({ ...settings, ...patch });

  // ── 自定义背景图（看板【皮肤 UI 优化】P0 子项）────────────────────
  // 选图只把路径写进设置；读图/渲染由 App 统一走 read_background_image。
  const pickBackgroundImage = async () => {
    try {
      const picked = await openDialog({
        multiple: false,
        directory: false,
        title: t("appearance.backgroundPickTitle"),
        filters: [
          {
            name: t("appearance.backgroundFilter"),
            extensions: ["png", "jpg", "jpeg", "webp", "bmp", "gif"],
          },
        ],
      });
      if (typeof picked !== "string" || !picked) return;
      update({ backgroundImage: picked });
      // 3A-3：选完图直接进构图调整——App 等 dataUrl 就绪后才真正弹窗。
      onAdjustBackground();
    } catch (error) {
      onError(error, t("appearance.backgroundPickFailed"));
    }
  };

  // 滑块的连续输入不需要在这里防抖：App 的 handleSettings 已经把落盘做成
  // 「只保留最新值 + 250ms 合并窗口 + 串行写」，界面走的是乐观更新，拖动照样实时。
  // 在这里再加一层 debounce 只会让滑块和画面不同步。
  const backgroundControl = {
    path: settings.backgroundImage ?? "",
    opacity: settings.backgroundOpacity ?? 45,
    blur: settings.backgroundBlur ?? 0,
    dim: settings.backgroundDim ?? 50,
    fit: settings.backgroundFit ?? "cover",
    posX: settings.backgroundPosX ?? 50,
    posY: settings.backgroundPosY ?? 50,
    loading: backgroundLoading,
    onPick: () => void pickBackgroundImage(),
    // 恢复默认连填充方式/焦点/缩放/遮罩一起复位，否则「清掉图再选一张」会带着
    // 上一张的焦点位置和缩放倍率，用户以为是新图自己偏了。
    onClear: () =>
      update({
        backgroundImage: "",
        backgroundOpacity: 45,
        backgroundBlur: 0,
        backgroundDim: 50,
        backgroundFit: "cover",
        backgroundPosX: 50,
        backgroundPosY: 50,
        backgroundZoom: 1,
      }),
    onOpacity: (value: number) => update({ backgroundOpacity: value }),
    onBlur: (value: number) => update({ backgroundBlur: value }),
    onDim: (value: number) => update({ backgroundDim: value }),
    onFit: (value: BackgroundFit) => update({ backgroundFit: value }),
    onAdjust: onAdjustBackground,
    // 单轴更新：两个滑块各自只改自己那一轴，互不覆盖。
    onPos: (axis: "x" | "y", value: number) =>
      update(axis === "x" ? { backgroundPosX: value } : { backgroundPosY: value }),
    onResetPos: () => update({ backgroundPosX: 50, backgroundPosY: 50 }),
  };

  // 更改暂存区：选目录 → 后端搬迁 + 重写路径 → 刷新快照。
  const moveStagingTo = async (target: string) => {
    setStagingNote(null);
    try {
      const report = await api.changeStagingDir(target);
      const failed = report.failed.length
        ? t("settings.stagingFailedSuffix", {
            count: report.failed.length,
            names: report.failed.slice(0, 2).join("、"),
          })
        : "";
      setStagingNote(t("settings.stagingMoved", { moved: report.moved, failed }));
      onRefreshMods();
    } catch (error) {
      onError(error, t("settings.stagingChangeFailed"));
    }
  };

  const changeStagingDir = async () => {
    try {
      const picked = await openDialog({
        directory: true,
        multiple: false,
        title: t("settings.stagingDirPickTitle"),
      });
      if (!picked || Array.isArray(picked)) return;
      await moveStagingTo(picked);
    } catch (error) {
      onError(error, t("settings.stagingChangeFailed"));
    }
  };

  // 暂存区建议：按剩余空间列磁盘，点击候选直接迁到该盘的 CyberDeck-Staging。
  const suggestStaging = async () => {
    try {
      const list = await api.suggestStagingDir();
      setStagingSuggestions(list);
    } catch (error) {
      onError(error, t("settings.stagingSuggestFailed"));
    }
  };

  // 手动选择：不信任自动探测时，直接指到具体的 exe。
  const browseTool = async (tool: "archive" | "wolvenkit") => {
    try {
      const picked = await openDialog({
        directory: false,
        multiple: false,
        title:
          tool === "archive"
            ? t("settings.pickArchiveTitle")
            : t("settings.pickWolvenkitTitle"),
        filters: [{ name: t("settings.executableFilter"), extensions: ["exe"] }],
      });
      if (!picked || Array.isArray(picked)) return;
      if (tool === "archive") {
        setArchiveTool(picked);
        update({ archiveToolPath: picked });
      } else {
        setWolvenkitPath(picked);
        update({ wolvenkitCliPath: picked });
      }
      setToolNote((notes) => ({
        ...notes,
        [tool]: t("settings.toolSelected", { path: picked }),
      }));
    } catch (error) {
      onError(error, t("settings.toolPickFailed"));
    }
  };

  // 自动查找工具位置：找到就填入并保存，找不到就把原因显示出来。
  const autoFindTool = async (tool: "archive" | "wolvenkit") => {
    try {
      const probe = await api.detectTool(tool);
      // 提到局部常量：类型窄化不会传进 setState 回调的闭包，否则 t() 插值拿到 string | null。
      const foundPath = probe.path;
      if (probe.found && foundPath) {
        if (tool === "archive") {
          setArchiveTool(foundPath);
          update({ archiveToolPath: foundPath });
        } else {
          setWolvenkitPath(foundPath);
          update({ wolvenkitCliPath: foundPath });
        }
        setToolNote((notes) => ({
          ...notes,
          [tool]: t("settings.toolFound", { path: foundPath }),
        }));
      } else {
        setToolNote((notes) => ({ ...notes, [tool]: probe.message }));
      }
    } catch (error) {
      onError(error, t("settings.toolAutoFindFailed"));
    }
  };

  // 启动能力探测（只读命令）：游戏目录或启动方式变了就重算，
  // 让「能不能跳过 REDprelauncher」在设置页就有答案，而不是点下去才知道。
  useEffect(() => {
    if (!game) {
      setLaunchCheck(null);
      return;
    }
    let alive = true;
    api
      .inspectLaunch()
      .then((check) => {
        if (alive) setLaunchCheck(check);
      })
      .catch(() => {
        if (alive) setLaunchCheck(null);
      });
    return () => {
      alive = false;
    };
  }, [game?.root, settings.launchMethod]);

  const changeTab = (tab: SettingsTabId) => {
    setActiveTab(tab);
    onTabChange?.(tab);
  };

  // ── 播放集（Profile）──────────────────────────────────────
  const profiles = state.profiles ?? [];
  const activeProfileId = state.activeProfileId ?? null;
  const activeProfile = profiles.find((item) => item.id === activeProfileId) ?? null;
  const [profileBusy, setProfileBusy] = useState<string | null>(null);
  const [creatingProfile, setCreatingProfile] = useState(false);
  const [newProfileName, setNewProfileName] = useState("");
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  // modlist 导入/导出的结果回显（路径、对上/没对上几条）。
  const [profileNote, setProfileNote] = useState<string | null>(null);

  /**
   * 统一处理播放集操作：出错走 onError，成功后刷新快照。
   * 返回是否成功——需要「成功后才知道要不要收表单」的调用点靠它判断，
   * 免得名称冲突/写盘失败时把用户刚敲的名字一起清掉。
   */
  const runProfileAction = async (label: string, run: () => Promise<unknown>): Promise<boolean> => {
    setProfileBusy(label);
    try {
      await run();
      onRefreshMods();
      return true;
    } catch (error) {
      onError(error, t("settings.profileActionFailed"));
      return false;
    } finally {
      setProfileBusy(null);
    }
  };

  const submitCreateProfile = async () => {
    const name = newProfileName.trim();
    if (!name) return;
    const ok = await runProfileAction("create", () => api.createProfile(name, true));
    // 失败时保留输入框内容与表单，用户改个名字直接回车重试即可。
    if (!ok) return;
    setNewProfileName("");
    setCreatingProfile(false);
  };

  const submitRename = async () => {
    if (!renaming) return;
    const name = renaming.name.trim();
    if (!name) {
      setRenaming(null);
      return;
    }
    const ok = await runProfileAction("rename", () => api.renameProfile(renaming.id, name));
    if (!ok) return;
    setRenaming(null);
  };

  // ── modlist 导入导出（看板【mod 列表及切换功能】）────────────────
  const exportProfileModlist = (profileId: string, profileName: string) => {
    void runProfileAction("export", async () => {
      const path = await api.exportProfileModlist(profileId);
      setProfileNote(t("settings.profileExported", { name: profileName, path }));
    });
  };

  const importProfileModlist = async () => {
    try {
      const picked = await openDialog({
        multiple: false,
        directory: false,
        title: t("settings.profileImportTitle"),
        filters: [{ name: t("settings.profileImportFilter"), extensions: ["json"] }],
      });
      if (typeof picked !== "string" || !picked) return;
      await runProfileAction("import", async () => {
        const report = await api.importProfileModlist(picked);
        setProfileNote(
          report.unmatched.length > 0
            ? t("settings.profileImportedPartial", {
                name: report.profileName,
                matched: report.matched,
                unmatched: report.unmatched.length,
              })
            : t("settings.profileImported", {
                name: report.profileName,
                matched: report.matched,
              }),
        );
      });
    } catch (error) {
      onError(error, t("settings.profileImportFailed"));
    }
  };


  return (
    <div className="page settings-page settings-shell">
      <header className="page-head">
        <div>
          <div className="eyebrow">// SETTINGS / LOCAL CONFIG</div>
          <h1>
            {t("settings.pageTitle")}<span className="h1-accent">.</span>
          </h1>
          <p className="page-sub">
            {t("settings.pageSub")}
          </p>
        </div>
        {demoMode ? <Badge tone="cyan">BROWSER PREVIEW · DEMO DATA</Badge> : <Badge tone="green">LOCAL ONLY</Badge>}
      </header>

      <SettingsTabs active={activeTab} onChange={changeTab} />

      <div className="settings-content" ref={contentRef}>
        {/* ── 外观与主题 ─────────────────────────────────── */}
        <section
          className="settings-tab-panel settings-grid"
          role="tabpanel"
          id="settings-panel-appearance"
          aria-labelledby="settings-tab-appearance"
          hidden={activeTab !== "appearance"}
        >
          <AppearanceSettings
            preferences={preferences}
            onSelectTheme={onSelectTheme}
            onAccent={onAccent}
            onResetAccent={onResetAccent}
            onScale={onScale}
            onUiFont={onUiFont}
            onCodeFont={onCodeFont}
            onCustomUiFont={onCustomUiFont}
            onCustomCodeFont={onCustomCodeFont}
            onSidebarCollapsed={onSidebarCollapsed}
            onAnimations={onAnimations}
            onMotionSpeed={onMotionSpeed}
            onSplash={onSplash}
            closeBehavior={settings.closeBehavior}
            onCloseBehavior={(value) => update({ closeBehavior: value })}
            closeAsk={settings.closeAsk}
            onCloseAsk={(value) => update({ closeAsk: value })}
            background={backgroundControl}
            hiddenViews={hiddenViews}
            onToggleHiddenView={onToggleHiddenView}
          />
        </section>

        {/* ── 通知 ──────────────────────────────────────── */}
        <section
          className="settings-tab-panel settings-grid settings-grid--single"
          role="tabpanel"
          id="settings-panel-notifications"
          aria-labelledby="settings-tab-notifications"
          hidden={activeTab !== "notifications"}
        >
          <section className="panel">
            <header className="panel-head">
              <div>
                <div className="panel-eyebrow">// NOTIFICATIONS</div>
                <h2>{t("settings.notifTitle")}</h2>
              </div>
              {/* 3B-1：全局测试入口。走 system 类别（不受分类开关影响），
                  让用户在任意开关组合下都能预览当前的停留时长效果。 */}
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => onTestNotification("download")}
                title={t("settings.notifGlobalTestTitle")}
              >
                <Sparkles size={12} /> {t("settings.notifGlobalTest")}
              </button>
            </header>

            <p className="profile-intro">{t("settings.notifIntro")}</p>

            <div className="switch-stack">
              <SwitchRow
                title={t("settings.notifDownload")}
                description={t("settings.notifDownloadDesc")}
                checked={notificationPrefs.download}
                onChange={(checked) =>
                  onNotificationPrefsChange({ ...notificationPrefs, download: checked })
                }
              />
              <SwitchRow
                title={t("settings.notifDeploy")}
                description={t("settings.notifDeployDesc")}
                checked={notificationPrefs.deploy}
                onChange={(checked) =>
                  onNotificationPrefsChange({ ...notificationPrefs, deploy: checked })
                }
              />
              <SwitchRow
                title={t("settings.notifConflict")}
                description={t("settings.notifConflictDesc")}
                checked
                disabled
              />
              <SwitchRow
                title={t("settings.notifUpdate")}
                description={t("settings.notifUpdateDesc")}
                checked={notificationPrefs.update}
                onChange={(checked) =>
                  onNotificationPrefsChange({ ...notificationPrefs, update: checked })
                }
              />
            </div>

            <NotificationDurationRow value={notificationDuration} onChange={onNotificationDurationChange} />
          </section>
        </section>

        {/* ── 游戏与路径 ─────────────────────────────────── */}
        <section
          className="settings-tab-panel settings-grid"
          role="tabpanel"
          id="settings-panel-game"
          aria-labelledby="settings-tab-game"
          hidden={activeTab !== "game"}
        >
          <section className="panel settings-card span-2">
            <div className="panel-head">
              <div>
                <div className="panel-eyebrow">// GAME DIRECTORY</div>
                <h2>{t("settings.gameDirTitle")}</h2>
              </div>
              <Badge tone={game ? "green" : "red"}>{game ? "LINKED" : "NOT LINKED"}</Badge>
            </div>
            <div className={`game-dir-box ${game ? "is-linked" : "is-unlinked"}`}>
              <span className="game-dir-scan" aria-hidden="true" />
              <div className={`dir-icon ${game ? "ok" : ""}`}>
                <Gamepad2 size={22} />
              </div>
              <div className="dir-copy">
                <strong>{game ? "Cyberpunk 2077" : t("settings.gameNotLocated")}</strong>
                <code title={game?.root ?? ""}>{game?.root ?? t("settings.gameRootPlaceholder")}</code>
                <div className="dir-meta">
                  {game ? (
                    <>
                      {/* 显示社区叫法（2.5），exe 内部四段号放 title 供排查对照。 */}
                      <span title={game.version ?? undefined}>
                        v{gameVersionText(game.version) ?? t("common.unknown")}
                      </span>
                      <span>·</span>
                      <span>{game.source.toUpperCase()}</span>
                      <span>·</span>
                      <span>{game.language ?? t("settings.languageUnread")}</span>
                    </>
                  ) : (
                    <span>{t("settings.gameRootHint")}</span>
                  )}
                </div>
              </div>
              <div className="dir-actions">
                <button className="btn btn-primary btn-sm" onClick={onPickGame}>
                  <FolderSearch size={14} /> {t("settings.gameBrowse")}
                </button>
                <button className="btn btn-ghost btn-sm" onClick={onAutoDetect}>
                  {t("settings.gameAutoDetect")}
                </button>
                {game ? (
                  <button className="btn btn-ghost btn-sm danger-text" onClick={onClearGame}>
                    <Trash2 size={13} /> {t("settings.gameClear")}
                  </button>
                ) : null}
              </div>
            </div>
            {deployedCount > 0 ? (
              <div className="inline-warning compact">
                <Info size={14} />
                <span>{t("settings.deployedWarning", { count: deployedCount })}</span>
              </div>
            ) : (
              <p className="panel-note">
                {t("settings.gameCheckLead")}{" "}
                <code>bin\\x64\\Cyberpunk2077.exe</code>{" "}
                {t("settings.gameCheckTail")}
              </p>
            )}
          </section>

          <section className="panel settings-card">
            <div className="panel-head">
              <div>
                <div className="panel-eyebrow">// LAUNCH</div>
                <h2>{t("settings.launchMethodTitle")}</h2>
              </div>
              <MonitorPlay size={18} />
            </div>
            <div className="launch-options">
              {[
                {
                  id: "auto" as const,
                  title: t("settings.launchAutoTitle"),
                  detail: t("settings.launchAutoDetail"),
                },
                {
                  id: "steam" as const,
                  title: "Steam",
                  detail: t("settings.launchSteamDetail"),
                },
                {
                  id: "direct" as const,
                  title: t("settings.launchDirectTitle"),
                  detail: t("settings.launchDirectDetail"),
                },
              ].map((option) => (
                <button
                  key={option.id}
                  className={`launch-option ${settings.launchMethod === option.id ? "selected" : ""}`}
                  onClick={() => update({ launchMethod: option.id })}
                >
                  <span className="launch-radio" />
                  <div>
                    <strong>{option.title}</strong>
                    <span>{option.detail}</span>
                  </div>
                </button>
              ))}
            </div>
            {game ? (
              <div className={`launch-status ${launchCheck && !launchCheck.canDirect ? "is-blocked" : ""}`}>
                <span className="launch-status-dot" aria-hidden="true" />
                <div className="launch-status-copy">
                  <strong>
                    {launchCheck
                      ? `${launchCheck.canDirect ? t("settings.launchReady") : t("settings.launchBlocked")} · ${launchCheck.platformLabel}`
                      : t("settings.launchChecking")}
                  </strong>
                  <span>
                    {launchCheck
                      ? launchCheck.canDirect
                        ? launchCheck.prelauncherPresent
                          ? t("settings.launchDirectNote")
                          : t("settings.launchNoPrelauncher")
                        : (launchCheck.reasons[0] ?? t("settings.launchPreconditionFail"))
                      : t("settings.launchReading")}
                  </span>
                  {launchCheck && launchCheck.notes.length > 0 ? (
                    <ul className="launch-status-notes">
                      {launchCheck.notes.slice(0, 2).map((note) => (
                        <li key={note}>{note}</li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              </div>
            ) : null}
            <div className="platform-row">
              <span className="platform-label">{t("settings.platformLabel")}</span>
              <div className="platform-chips">
                {(
                  [
                    { id: "auto", label: t("settings.platformAuto") },
                    { id: "steam", label: "Steam" },
                    { id: "gog", label: "GOG" },
                    { id: "epic", label: "Epic" },
                    { id: "manual", label: t("settings.platformManual") },
                  ] as const
                ).map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={`platform-chip ${settings.platformPref === item.id ? "selected" : ""}`}
                    onClick={() => update({ platformPref: item.id })}
                    title={
                      item.id === "auto"
                        ? t("settings.platformAutoTip")
                        : t("settings.platformPreferTip", { label: item.label })
                    }
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="launch-args-row">
              <span className="platform-label">{t("settings.launchArgsLabel")}</span>
              <input
                className="input launch-args-input"
                type="text"
                value={settings.launchArgs}
                onChange={(event) => update({ launchArgs: event.target.value })}
                placeholder={t("settings.launchArgsPlaceholder")}
                spellCheck={false}
                maxLength={256}
              />
            </div>
            <p className="panel-note">
              {t("settings.launchArgsNoteLead")}{" "}
              <code>-modded --launcher-skip</code>{t("settings.launchArgsNoteTail")}
            </p>
            {/* 启动高级选项（deepseek 任务·模块一） */}
            <div className="platform-row">
              <span className="platform-label">{t("settings.gpuPrefLabel")}</span>
              <div className="platform-chips">
                {(
                  [
                    { id: "auto", label: t("settings.gpuPrefAuto") },
                    { id: "dedicated", label: t("settings.gpuPrefDedicated") },
                    { id: "integrated", label: t("settings.gpuPrefIntegrated") },
                  ] as const
                ).map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={`platform-chip ${(settings.launchGpuPref ?? "auto") === item.id ? "selected" : ""}`}
                    onClick={() => update({ launchGpuPref: item.id })}
                    title={t("settings.gpuPrefTip", { label: item.label })}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="platform-row">
              <span className="platform-label">{t("settings.priorityLabel")}</span>
              <div className="platform-chips">
                {(
                  [
                    { id: "low", label: t("settings.priorityLow") },
                    { id: "normal", label: t("settings.priorityNormal") },
                    { id: "high", label: t("settings.priorityHigh") },
                  ] as const
                ).map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={`platform-chip ${(settings.launchPriority ?? "normal") === item.id ? "selected" : ""}`}
                    onClick={() => update({ launchPriority: item.id })}
                    title={t("settings.priorityTip")}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="launch-args-row">
              <span className="platform-label">{t("settings.preCommandLabel")}</span>
              <input
                className="input launch-args-input"
                type="text"
                value={settings.launchPreCommand ?? ""}
                onChange={(event) => update({ launchPreCommand: event.target.value })}
                placeholder={t("settings.preCommandPlaceholder")}
                spellCheck={false}
                maxLength={512}
              />
            </div>
            <p className="panel-note">{t("settings.preCommandNote")}</p>
          </section>

          <section className="panel settings-card">
            <div className="panel-head">
              <div>
                <div className="panel-eyebrow">// STORAGE</div>
                <h2>{t("settings.storageTitle")}</h2>
              </div>
              <HardDrive size={18} />
            </div>
            <div className="storage-summary">
              <div>
                <span>STAGING</span>
                <strong>{formatBytes(stagingBytes)}</strong>
              </div>
              <div>
                <span>MODS</span>
                <strong>{state.mods.length}</strong>
              </div>
              <div>
                <span>BACKUP</span>
                <strong>{state.backup ? relativeTime(state.backup.createdAt) : t("common.none")}</strong>
              </div>
            </div>
            <div className="path-list">
              <div className="path-row-group">
                <button className="path-row" onClick={() => onOpenPath(state.stagingDir)}>
                  <Database size={14} />
                  <span>
                    <strong>{t("settings.stagingDir")}</strong>
                    <code>{compactPath(state.stagingDir, 42)}</code>
                  </span>
                  <FolderOpen size={13} />
                </button>
                <button
                  className="btn btn-ghost btn-sm path-row-action"
                  onClick={() => void suggestStaging()}
                  title={t("settings.stagingSuggestTip")}
                >
                  <Sparkles size={13} /> {t("settings.stagingSuggestBtn")}
                </button>
                <button
                  className="btn btn-ghost btn-sm path-row-action"
                  onClick={() => void changeStagingDir()}
                  title={t("settings.stagingMoveTip")}
                >
                  <FolderSearch size={13} /> {t("settings.stagingChangeBtn")}
                </button>
              </div>
              {stagingSuggestions ? (
                stagingSuggestions.length ? (
                  <div className="drive-suggest">
                    {stagingSuggestions.map((drive) => (
                      <button
                        key={drive.drive}
                        type="button"
                        className="drive-suggest-row"
                        onClick={() => {
                          setStagingSuggestions(null);
                          void moveStagingTo(`${drive.drive}\\CyberDeck-Staging`);
                        }}
                      >
                        <HardDrive size={13} />
                        <strong>{drive.drive}</strong>
                        <span>
                          {formatBytes(drive.freeBytes)} / {formatBytes(drive.totalBytes)}
                        </span>
                      </button>
                    ))}
                    <small className="path-note">{t("settings.stagingSuggestNote")}</small>
                  </div>
                ) : (
                  <small className="path-note">{t("settings.stagingSuggestEmpty")}</small>
                )
              ) : null}
              {stagingNote ? <small className="path-note">{stagingNote}</small> : null}
              <div className="settings-field">
                <span>{t("settings.deployModeLabel")}</span>
                <div className="settings-field-row">
                  <div className="btn-group" role="group" aria-label={t("settings.deployModeLabel")}>
                    {(
                      [
                        { id: "hardlink" as const, label: t("settings.deployModeHardlink") },
                        { id: "symlink" as const, label: t("settings.deployModeSymlink") },
                        { id: "copy" as const, label: t("settings.deployModeCopy") },
                      ]
                    ).map((option) => (
                      <button
                        key={option.id}
                        type="button"
                        className={`btn btn-sm ${(settings.deployMode ?? "hardlink") === option.id ? "btn-primary" : "btn-ghost"}`}
                        aria-pressed={(settings.deployMode ?? "hardlink") === option.id}
                        onClick={() => update({ deployMode: option.id })}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                </div>
                <small className="settings-hint">{t("settings.deployModeHint")}</small>
              </div>
              <button className="path-row" onClick={() => onOpenPath(appData)}>
                <HardDrive size={14} />
                <span>
                  <strong>{t("settings.appDataLabel")}</strong>
                  <code>{compactPath(appData, 42)}</code>
                </span>
                <FolderOpen size={13} />
              </button>
            </div>
          </section>
        </section>

        {/* ── AI 配置 ─────────────────────────────────────── */}
        <section
          className="settings-tab-panel settings-grid settings-grid--single"
          role="tabpanel"
          id="settings-panel-ai"
          aria-labelledby="settings-tab-ai"
          hidden={activeTab !== "ai"}
        >
          <AiSettingsCard settings={settings} onSettings={onSettings} onError={onError} />
          <GlossaryShareCard onError={onError} />
        </section>

        {/* ── 工具组件 ───────────────────────────────────── */}
        <section
          className="settings-tab-panel settings-grid settings-grid--single"
          role="tabpanel"
          id="settings-panel-tools"
          aria-labelledby="settings-tab-tools"
          hidden={activeTab !== "tools"}
        >
          {/* Vortex 接管体检：P0 只读取证，不写状态库、不删文件 */}
          <VortexTakeoverCard onError={onError} />

          {/* ── 播放集 / PROFILES ─────────────────────────── */}
          <section className="panel profile-panel">
            <header className="panel-head">
              <div>
                <div className="panel-eyebrow">// PROFILES / PRESETS</div>
                <h2>{t("settings.profilesTitle")}</h2>
              </div>
              <div className="profile-admin-actions">
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => void importProfileModlist()}
                  disabled={profileBusy !== null}
                  title={t("settings.profileImportTitle")}
                >
                  {profileBusy === "import" ? <Spinner size={13} /> : <Upload size={13} />}
                  {t("settings.profileImport")}
                </button>
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() =>
                    void runProfileAction("save", () => api.saveProfileState(activeProfileId ?? ""))
                  }
                  disabled={!activeProfileId || profileBusy !== null}
                  title={t("settings.profileSaveTip")}
                >
                  {profileBusy === "save" ? <Spinner size={13} /> : <Save size={13} />}
                  {t("settings.profileSaveBtn")}
                </button>
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => setCreatingProfile((open) => !open)}
                  disabled={profileBusy !== null}
                >
                  <Plus size={13} />
                  {t("settings.profileNew")}
                </button>
              </div>
            </header>

            <p className="profile-intro">
              {t("settings.profileIntro")}
            </p>

            {profileNote ? <small className="profile-note">{profileNote}</small> : null}

            {creatingProfile ? (
              <div className="profile-create">
                <input
                  value={newProfileName}
                  onChange={(event) => setNewProfileName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void submitCreateProfile();
                    if (event.key === "Escape") setCreatingProfile(false);
                  }}
                  placeholder={t("settings.profileNewPlaceholder")}
                  spellCheck={false}
                  autoFocus
                />
                <button
                  className="btn btn-primary btn-sm"
                  onClick={() => void submitCreateProfile()}
                  disabled={!newProfileName.trim() || profileBusy !== null}
                >
                  {profileBusy === "create" ? <Spinner size={13} /> : null}
                  {t("settings.profileCreate")}
                </button>
                <button className="btn btn-ghost btn-sm" onClick={() => setCreatingProfile(false)}>
                  <X size={13} />
                </button>
              </div>
            ) : null}

            <ul className="profile-list">
              {profiles.map((item) => {
                const isActive = item.id === activeProfileId;
                const isRenaming = renaming?.id === item.id;
                return (
                  <li key={item.id} className={`profile-row${isActive ? " is-active" : ""}`}>
                    <div className="profile-row-main">
                      {isRenaming ? (
                        <input
                          className="profile-rename-input"
                          value={renaming?.name ?? ""}
                          onChange={(event) => setRenaming({ id: item.id, name: event.target.value })}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") void submitRename();
                            if (event.key === "Escape") setRenaming(null);
                          }}
                          onBlur={() => void submitRename()}
                          autoFocus
                        />
                      ) : (
                        <strong className="profile-row-name">
                          {item.name}
                          {item.builtin ? <span className="profile-badge">{t("settings.profileBuiltin")}</span> : null}
                        </strong>
                      )}
                      <small>
                        {t("settings.profileMeta", {
                          mods: item.enabledModIds.length,
                          archives: item.loadOrder.length,
                          time: relativeTime(item.updatedAt),
                        })}
                      </small>
                    </div>

                    <div className="profile-row-actions">
                      {isActive ? (
                        <span className="profile-active-tag">
                          <Check size={12} />
                          {t("settings.profileActive")}
                        </span>
                      ) : (
                        <button
                          className="btn btn-ghost btn-sm"
                          onClick={() =>
                            void runProfileAction("switch", () => api.switchProfile(item.id))
                          }
                          disabled={profileBusy !== null}
                        >
                          {profileBusy === "switch" ? <Spinner size={13} /> : <Layers size={13} />}
                          {t("common.toggle")}
                        </button>
                      )}
                      <button
                        className="btn btn-ghost btn-sm btn-icon-only"
                        onClick={() => setRenaming({ id: item.id, name: item.name })}
                        disabled={item.builtin || profileBusy !== null}
                        title={item.builtin ? t("settings.profileRenameBuiltinTip") : t("settings.profileRename")}
                      >
                        <Pencil size={13} />
                      </button>
                      <button
                        className="btn btn-ghost btn-sm btn-icon-only"
                        onClick={() => exportProfileModlist(item.id, item.name)}
                        disabled={profileBusy !== null}
                        title={t("settings.profileExportTip")}
                      >
                        {profileBusy === "export" ? <Spinner size={13} /> : <Download size={13} />}
                      </button>
                      <button
                        className="btn btn-ghost btn-sm btn-icon-only"
                        onClick={() =>
                          void runProfileAction("duplicate", () =>
                            api.duplicateProfile(
                              item.id,
                              t("settings.profileCopySuffix", { name: item.name }),
                            ),
                          )
                        }
                        disabled={profileBusy !== null}
                        title={t("settings.profileDuplicateTip")}
                      >
                        <Copy size={13} />
                      </button>
                      <button
                        className="btn btn-ghost btn-sm btn-icon-only"
                        onClick={() =>
                          void runProfileAction("delete", () => api.deleteProfile(item.id))
                        }
                        disabled={item.builtin || isActive || profileBusy !== null}
                        title={item.builtin ? t("settings.profileDeleteBuiltinTip") : isActive ? t("settings.profileDeleteActiveTip") : t("common.delete")}
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>

            {activeProfile ? (
              <small className="profile-foot">
                {t("settings.profileFoot", {
                  name: activeProfile.name,
                  count: activeProfile.enabledModIds.length,
                })}
              </small>
            ) : null}
          </section>

          <NexusSettingsCard settings={settings} onSettings={onSettings} onError={onError} />

          {/* 外部工具链管理器（deepseek 任务·模块三） */}
          <ExternalToolsCard onError={onError} />

          {/* ── 存档与工具（任务 865759）：自动快照 / 上限 / 外部编辑器 ── */}
          <section className="panel settings-card">
            <div className="panel-head">
              <div>
                <div className="panel-eyebrow">// SAVES / SNAPSHOTS</div>
                <h2>{t("saves.settingsCardTitle")}</h2>
              </div>
            </div>
            <div className="sidebar-pref">
              <SwitchRow
                title={t("saves.settingsAutoSnapshot")}
                description={t("saves.settingsAutoSnapshotDesc")}
                checked={settings.autoSnapshot}
                onChange={(value) => update({ autoSnapshot: value })}
              />
            </div>
            <div className="setting-row">
              <div className="setting-copy">
                <strong>{t("saves.settingsSnapshotLimit")}</strong>
                <p>{t("saves.settingsSnapshotLimitDesc")}</p>
              </div>
              <select
                className="font-select save-limit-select"
                value={settings.snapshotLimit}
                onChange={(event) => update({ snapshotLimit: Number(event.target.value) })}
                aria-label={t("saves.settingsSnapshotLimit")}
              >
                {[5, 10, 20, 30, 50].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </div>
            <div className="setting-row">
              <div className="setting-copy">
                <strong>{t("saves.settingsEditorPath")}</strong>
                <p>{t("saves.settingsEditorPathDesc")}</p>
              </div>
              <div className="save-editor-row">
                <input
                  className="save-editor-input"
                  value={settings.saveEditorPath}
                  placeholder={t("saves.editorNotConfigured")}
                  onChange={(event) => update({ saveEditorPath: event.target.value })}
                  spellCheck={false}
                />
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => {
                    void openDialog({
                      directory: false,
                      multiple: false,
                      filters: [{ name: t("settings.executableFilter"), extensions: ["exe"] }],
                    })
                      .then((picked) => {
                        if (typeof picked === "string" && picked) {
                          update({ saveEditorPath: picked });
                        }
                      })
                      .catch((error) => onError(error, t("saves.editorPickFailed")));
                  }}
                >
                  {t("saves.editorBrowse")}
                </button>
              </div>
            </div>
          </section>

          {/* ── 下载设置（r20 从下载中心页搬入；下载中心只留任务列表） ── */}
          <section className="panel settings-card">
            <div className="panel-head">
              <div>
                <div className="panel-eyebrow">// DOWNLOADS</div>
                <h2>{t("downloads.settingsTitle")}</h2>
              </div>
              {queueNote ? <span className="downloads-note">{queueNote}</span> : null}
            </div>
            {queueSettings ? (
              <>
                <div className="settings-field">
                  <span>{t("downloads.dirLabel")}</span>
                  <div className="settings-field-row">
                    <code className="dl-dir-value" title={queueSettings.dir ?? undefined}>
                      {queueSettings.dir ?? t("downloads.dirDefault")}
                    </code>
                    <button className="btn btn-ghost btn-sm" onClick={() => void pickDownloadDir()}>
                      <FolderOpen size={13} /> {t("downloads.dirPick")}
                    </button>
                  </div>
                </div>
                <div className="settings-field">
                  <span>{t("downloads.concurrencyLabel")}</span>
                  <div className="settings-field-row">
                    <div className="btn-group" role="group" aria-label={t("downloads.concurrencyLabel")}>
                      {[1, 2, 3].map((value) => (
                        <button
                          key={value}
                          type="button"
                          className={`btn btn-sm ${queueSettings.concurrency === value ? "btn-primary" : "btn-ghost"}`}
                          aria-pressed={queueSettings.concurrency === value}
                          onClick={() => void updateQueueSettings({ concurrency: value })}
                        >
                          {value}
                        </button>
                      ))}
                    </div>
                    <small className="settings-hint">{t("downloads.concurrencyHint")}</small>
                  </div>
                </div>
                <div className="settings-field">
                  <span>{t("downloads.speedLimitLabel")}</span>
                  <div className="settings-field-row">
                    <div className="btn-group" role="group" aria-label={t("downloads.speedLimitLabel")}>
                      {(
                        [
                          { value: 0, label: t("downloads.speedLimitOff") },
                          { value: 5, label: "5" },
                          { value: 10, label: "10" },
                          { value: 20, label: "20" },
                          { value: 50, label: "50" },
                          { value: 100, label: "100" },
                        ] as const
                      ).map((item) => (
                        <button
                          key={item.value}
                          type="button"
                          className={`btn btn-sm ${queueSettings.speedLimitMbps === item.value ? "btn-primary" : "btn-ghost"}`}
                          aria-pressed={queueSettings.speedLimitMbps === item.value}
                          onClick={() => void updateQueueSettings({ speedLimitMbps: item.value })}
                        >
                          {item.label}
                        </button>
                      ))}
                    </div>
                    <small className="settings-hint">{t("downloads.speedLimitHint")}</small>
                  </div>
                </div>
                <SwitchRow
                  title={t("downloads.autoImportTitle")}
                  description={t("downloads.autoImportDesc")}
                  checked={queueSettings.autoImport}
                  onChange={(checked) => void updateQueueSettings({ autoImport: checked })}
                />
                <div className="settings-field">
                  <span>{t("downloads.proxyLabel")}</span>
                  <div className="settings-field-row">
                    <input
                      value={proxyDraft}
                      onChange={(event) => setProxyDraft(event.target.value)}
                      placeholder={t("downloads.proxyPlaceholder")}
                      spellCheck={false}
                    />
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={() =>
                        void updateQueueSettings({ proxy: proxyDraft.trim() ? proxyDraft.trim() : null })
                      }
                    >
                      {t("downloads.proxySave")}
                    </button>
                  </div>
                </div>
                <div className="settings-field">
                  <span>{t("downloads.nxmLabel")}</span>
                  <div className="settings-field-row">
                    <code className="dl-dir-value">{nxmState?.ours ? t("downloads.nxmOurs") : t("downloads.nxmForeign")}</code>
                    <button className="btn btn-ghost btn-sm" onClick={() => void repairNxm()}>
                      {t("downloads.nxmRepair")}
                    </button>
                  </div>
                  <small className="settings-hint">{t("downloads.nxmHint")}</small>
                </div>
              </>
            ) : (
              <Spinner />
            )}
          </section>
        </section>

        {/* ── 安全与维护 ─────────────────────────────────── */}
        <section
          className="settings-tab-panel settings-grid settings-grid--single"
          role="tabpanel"
          id="settings-panel-security"
          aria-labelledby="settings-tab-security"
          hidden={activeTab !== "security"}
        >
          <SafeModeCard onError={onError} gameVersion={game?.version ?? null} />
          <ConfigPackCard onError={onError} />

          <section className="panel settings-card">
            <div className="panel-head">
              <div>
                <div className="panel-eyebrow">// SAFETY</div>
                <h2>{t("settings.safetyTitle")}</h2>
              </div>
              <ShieldCheck size={18} />
            </div>
            <div className="switch-stack">
              <SwitchRow
                title={t("settings.autoBackupTitle")}
                description={t("settings.autoBackupDesc")}
                checked={settings.autoBackup}
                onChange={(checked) => update({ autoBackup: checked })}
              />
              <SwitchRow
                title={t("settings.confirmUninstallTitle")}
                description={t("settings.confirmUninstallDesc")}
                checked={settings.confirmUninstall}
                onChange={(checked) => update({ confirmUninstall: checked })}
              />
              <SwitchRow
                title={t("settings.writeModlistTitle")}
                description={t("settings.writeModlistDesc")}
                checked={settings.writeModlist}
                onChange={onToggleWrite}
              />
            </div>

            <div className="settings-field archive-tool-field">
              <span>{t("settings.archiveToolLabel")}</span>
              <div className="settings-field-row">
                <input
                  value={archiveTool}
                  onChange={(event) => setArchiveTool(event.target.value)}
                  placeholder={t("settings.archiveToolPlaceholder")}
                  title={archiveTool}
                  spellCheck={false}
                />
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => void autoFindTool("archive")}
                  title={t("settings.archiveAutoTip")}
                >
                  <FolderSearch size={13} /> {t("settings.toolAutoFind")}
                </button>
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => void browseTool("archive")}
                  title={t("settings.archiveManualTip")}
                >
                  <FolderOpen size={13} /> {t("settings.toolManualPick")}
                </button>
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => update({ archiveToolPath: archiveTool.trim() })}
                  disabled={archiveTool.trim() === settings.archiveToolPath}
                >
                  {t("common.save")}
                </button>
              </div>
              <small>
                {t("settings.archiveToolNote")}
              </small>
              {toolNote.archive ? (
                <small className="path-note">{toolNote.archive}</small>
              ) : null}
            </div>
            <div className="settings-field archive-tool-field">
              <span>{t("settings.wolvenkitLabel")}</span>
              <div className="settings-field-row">
                <input
                  value={wolvenkitPath}
                  onChange={(event) => setWolvenkitPath(event.target.value)}
                  placeholder={t("settings.wolvenkitPlaceholder")}
                  title={wolvenkitPath}
                  spellCheck={false}
                />
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => void autoFindTool("wolvenkit")}
                  title={t("settings.wolvenkitAutoTip")}
                >
                  <FolderSearch size={13} /> {t("settings.toolAutoFind")}
                </button>
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => void browseTool("wolvenkit")}
                  title={t("settings.wolvenkitManualTip")}
                >
                  <FolderOpen size={13} /> {t("settings.toolManualPick")}
                </button>
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() =>
                    update({
                      wolvenkitCliPath: wolvenkitPath.trim(),
                      wolvenkitTimeoutSecs: wolvenkitTimeout,
                    })
                  }
                  disabled={
                    wolvenkitPath.trim() === settings.wolvenkitCliPath &&
                    wolvenkitTimeout === settings.wolvenkitTimeoutSecs
                  }
                >
                  {t("common.save")}
                </button>
              </div>
              <div className="settings-field-row wolvenkit-timeout-row">
                <span className="platform-label">{t("settings.wolvenkitTimeoutLabel")}</span>
                <input
                  className="input wolvenkit-timeout-input"
                  type="number"
                  min={10}
                  max={600}
                  step={10}
                  value={wolvenkitTimeout}
                  onChange={(event) => {
                    const next = Number(event.target.value);
                    if (Number.isFinite(next)) setWolvenkitTimeout(Math.round(next));
                  }}
                  aria-label={t("settings.wolvenkitTimeoutAria")}
                />
              </div>
              <small>
                {t("settings.wolvenkitNoteLead")}{" "}
                <code>dotnet tool install -g wolvenkit.cli</code>{" "}
                {t("settings.wolvenkitNoteTail")}
              </small>
              {toolNote.wolvenkit ? (
                <small className="path-note">{toolNote.wolvenkit}</small>
              ) : null}
            </div>
          </section>

          <section className="panel settings-card">
            <div className="panel-head">
              <div>
                <div className="panel-eyebrow">// BACKUP</div>
                <h2>{t("settings.backupTitle")}</h2>
              </div>
              <Archive size={18} />
            </div>
            {state.backup ? (
              <div className="backup-box">
                <div className="backup-row">
                  <span>{t("settings.backupLatest")}</span>
                  <strong>{state.backup.id}</strong>
                </div>
                <div className="backup-row">
                  <span>{t("settings.backupCreatedAt")}</span>
                  <strong>{relativeTime(state.backup.createdAt)}</strong>
                </div>
                <div className="backup-row">
                  <span>{t("settings.backupContains")}</span>
                  <strong>{t("settings.backupFileCount", { count: state.backup.files.length })}</strong>
                </div>
              </div>
            ) : (
              <div className="inline-warning compact">
                <Info size={14} /> {t("settings.backupEmpty")}
              </div>
            )}
            <div className="inline-actions">
              <button className="btn btn-ghost btn-sm" onClick={onCreateBackup}>
                <Archive size={13} /> {t("settings.backupCreate")}
              </button>
              <button className="btn btn-ghost btn-sm danger-text" onClick={onRestore}>
                <RotateCcw size={13} /> {t("settings.backupRestore")}
              </button>
            </div>
          </section>
        </section>

        {/* ── 帮助 ─────────────────────────────────────────
            从侧栏挪进来的（r22）：帮助不是高频操作，不该占左侧主菜单黄金位置。
            内容组件原样复用，搜索 / 分段 / 折叠面板都保持原行为。 */}
        <section
          className="settings-tab-panel"
          role="tabpanel"
          id="settings-panel-help"
          aria-labelledby="settings-tab-help"
          hidden={activeTab !== "help"}
        >
          <section className="panel settings-card">
            <div className="panel-head">
              <div>
                <div className="panel-eyebrow">// GUIDE</div>
                <h2>{t("helpCenter.title")}</h2>
              </div>
            </div>
            <HelpCenterView embedded />
          </section>
        </section>

        {/* ── 关于 ───────────────────────────────────────── */}
        <section
          className="settings-tab-panel settings-grid"
          role="tabpanel"
          id="settings-panel-about"
          aria-labelledby="settings-tab-about"
          hidden={activeTab !== "about"}
        >
          <section className="panel settings-card about-card">
            <div className="panel-head">
              <div>
                {/* 4B：v1.0 起是正式版，极客标签带上稳定版标记。 */}
                <div className="panel-eyebrow">// ABOUT / STABLE RELEASE</div>
                <h2>{t("settings.aboutTitle")}</h2>
              </div>
              <span className="about-version">{appVersion}</span>
            </div>
            <p className="panel-copy">
              {t("settings.aboutIntro")}
            </p>
            <ul className="about-list">
              <li>{t("settings.aboutZip")}</li>
              <li>{t("settings.aboutModSettings")}</li>
              <li>{t("settings.aboutNexus")}</li>
              <li>{t("settings.aboutNoInject")}</li>
              <li>{t("settings.aboutConflicts")}</li>
              <li>{t("settings.aboutAi")}</li>
            </ul>
            <div className="about-actions">
              <button
                className="btn btn-ghost btn-sm"
                onClick={onCheckAppUpdate}
                disabled={appUpdating || !onCheckAppUpdate}
                title={t("settings.checkUpdateTitle")}
              >
                {appUpdating ? <Spinner size={13} /> : <RefreshCw size={13} />}
                {t("settings.checkUpdate")}
              </button>
              <button className="btn btn-ghost btn-sm" onClick={onShowEula}>
                <ScrollText size={13} /> {t("eula.showInAbout")}
              </button>
              {/* 4B：开源协议与仓库入口（v1.0 起开源在 GitHub）。 */}
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => {
                  void api
                    .openUrl("https://github.com/XFxzz3456/CyberDeck-Launcher")
                    .catch((error) => onError(error, t("err.openPath")));
                }}
                title={t("settings.aboutRepoTitle")}
              >
                <ExternalLink size={13} /> {t("settings.aboutRepo")}
              </button>
            </div>
            {demoMode ? (
              <div className="demo-reset">
                <div>
                  <strong>{t("settings.demoDataTitle")}</strong>
                  <p>{t("settings.demoDataDesc")}</p>
                </div>
                <button className="btn btn-ghost btn-sm" onClick={onResetDemo}>
                  <RotateCcw size={13} /> {t("settings.demoReset")}
                </button>
              </div>
            ) : null}
          </section>
        </section>
      </div>
    </div>
  );
}
