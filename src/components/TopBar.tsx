import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Bell, Package, Play, Search, Square, Upload, X } from "lucide-react";
import type { GameInfo, ProfileList } from "../types";
import type { ActivityItem } from "../lib/tasks";
import type { View } from "./Sidebar";
import { ProfileMenu } from "./ProfileMenu";
import { Kbd, Spinner } from "./ui";
import { t } from "../i18n";
import { currentUiZoom } from "../lib/uiScale";

/**
 * 只有这几页才有「搜索模组 / 切播放集 / 导入压缩包」的语义。
 *
 * 设置、存档、诊断、下载页放这几个控件是噪音：搜索框会把焦点抢走、
 * 播放集下拉在那里点了也没意义、导入按钮更和当前页无关。
 * 通知铃铛与「开始游戏」不属于任何页面，永远保留（见下方渲染）。
 */
const MOD_TOOL_VIEWS: View[] = ["library", "discover", "loadorder"];

/** 时间格式跟随显示语言；接多语言时把此处的 locale 换成当前 locale 即可。 */
function clockTime(at: number): string {
  return new Date(at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

/** 通知中心「已读到哪一刻」：存上次打开铃铛的时间戳，早于它的活动不再计入未读。 */
const BELL_SEEN_KEY = "ncl.ui.bellSeenAt.v1";

/** 铃铛面板尺寸：与 styles.css 的 .bell-panel 保持一致，用于视口夹取。 */
const BELL_PANEL_WIDTH = 340;
const BELL_PANEL_MAX_HEIGHT = 380;
const BELL_PANEL_GAP = 8;
const BELL_VIEWPORT_MARGIN = 10;

type BellPanelPos = { top: number; left: number; width: number; maxHeight: number };

function loadBellSeenAt(): number {
  try {
    const raw = window.localStorage.getItem(BELL_SEEN_KEY);
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
}

function storeBellSeenAt(at: number) {
  try {
    window.localStorage.setItem(BELL_SEEN_KEY, String(at));
  } catch {
    /* localStorage 不可用时退化为仅会话内已读，不影响功能 */
  }
}

export function TopBar({
  view,
  search,
  onSearch,
  game,
  launching,
  profiles,
  switchingProfile,
  onSwitchProfile,
  onImport,
  onOpenModpack,
  onOpenPalette,
  onLaunch,
  gameRunning = false,
  stopping = false,
  onStopGame,
  activities = [],
  updateCount = 0,
}: {
  /** 当前页面：决定搜索框 / 播放集 / 导入这三个「模组工具」是否显示。 */
  view: View;
  search: string;
  onSearch: (value: string) => void;
  game: GameInfo | null;
  launching: boolean;
  profiles: ProfileList | null;
  switchingProfile: boolean;
  onSwitchProfile: (profileId: string) => void;
  onImport: () => void;
  /** 整合包（导出 / 导入共用同一个对话框的两个页签）。 */
  onOpenModpack: () => void;
  onOpenPalette: () => void;
  onLaunch: () => void;
  /** 游戏主进程正在运行：主按钮切换成「关闭游戏」。 */
  gameRunning?: boolean;
  /** 正在结束进程，按钮先禁用避免连点。 */
  stopping?: boolean;
  onStopGame: () => void;
  /** #7 通知中心：与任务中心同一份活动流（时间 + 动作 + 文件数）。 */
  activities?: ActivityItem[];
  /** #1 有更新的模组数量，铃铛上叠加显示。 */
  updateCount?: number;
}) {
  const searchRef = useRef<HTMLInputElement>(null);
  const modTools = MOD_TOOL_VIEWS.includes(view);
  const [bellOpen, setBellOpen] = useState(false);
  const [bellSeenAt, setBellSeenAt] = useState<number>(() => loadBellSeenAt());
  /** 本次打开面板「之前」的已读水位：用来给这次新到的活动标未读，打开后角标清零但视觉反馈还在。 */
  const [bellEntrySeenAt, setBellEntrySeenAt] = useState<number>(() => loadBellSeenAt());
  const bellRef = useRef<HTMLDivElement>(null);
  const bellButtonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [panelPos, setPanelPos] = useState<BellPanelPos | null>(null);

  /**
   * 面板必须挂到 body 并用 fixed 定位：.topbar 是 `position: relative; z-index: 10`，
   * 会创建层叠上下文；面板留在里面的话，子元素的 z-index 再高也逃不出父级的 10，
   * 而 .library-toolbar 是 30 → 整条工具栏画在面板之上（2026-11-14 #10②）。
   * 坐标与 ProfileMenu 一致：先在视觉坐标（含 zoom）里夹取，最后除以 zoom 写回。
   */
  const placePanel = () => {
    const anchor = bellButtonRef.current;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    const zoom = currentUiZoom();
    const viewW = window.innerWidth;
    const viewH = window.innerHeight;
    const width = Math.min(BELL_PANEL_WIDTH, viewW - BELL_VIEWPORT_MARGIN * 2);
    // 右缘对齐铃铛右缘；左右都夹在视口内。
    const left = Math.min(
      Math.max(BELL_VIEWPORT_MARGIN, Math.round(rect.right - width)),
      Math.max(BELL_VIEWPORT_MARGIN, viewW - width - BELL_VIEWPORT_MARGIN),
    );
    const top = Math.max(BELL_VIEWPORT_MARGIN, Math.round(rect.bottom + BELL_PANEL_GAP));
    const maxHeight = Math.max(
      120,
      Math.min(BELL_PANEL_MAX_HEIGHT, viewH - top - BELL_VIEWPORT_MARGIN),
    );
    setPanelPos({
      top: top / zoom,
      left: left / zoom,
      width: width / zoom,
      maxHeight: maxHeight / zoom,
    });
  };

  useLayoutEffect(() => {
    if (bellOpen) placePanel();
  }, [bellOpen]);

  // 点击面板外关闭；Esc 也可关闭。面板已 portal 到 body，命中判定要同时看两处。
  useEffect(() => {
    if (!bellOpen) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (bellRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      setBellOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setBellOpen(false);
    };
    // 窗口尺寸变了浮层坐标会失效：直接收起，避免错位残影（同 ProfileMenu）。
    const onViewportChange = () => setBellOpen(false);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", onViewportChange);
    window.addEventListener("blur", onViewportChange);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onViewportChange);
      window.removeEventListener("blur", onViewportChange);
    };
  }, [bellOpen]);

  const feed = activities.slice(-12).reverse();
  // 角标只表示「未读活动」。待更新模组数是待办、不是消息，点开铃铛不该被当成已读，
  // 因此它只留在面板头（bellUpdates）与按钮 tooltip，绝不加进角标——
  // 否则点开后角标纹丝不动，用户会以为「已读」功能坏了（2026-11-14 #10①）。
  const unreadCount = activities.filter((item) => item.at > bellSeenAt).length;
  const badgeCount = unreadCount;

  const toggleBell = () => {
    if (!bellOpen) {
      const now = Date.now();
      setBellEntrySeenAt(bellSeenAt);
      setBellSeenAt(now);
      storeBellSeenAt(now);
    }
    setBellOpen((value) => !value);
  };

  // 拖动把手只靠 data-tauri-drag-region="deep"（r41 重构，原因见 TitleBar）。
  // 搜索框 / 档案选择器 / 右侧按钮组都标 "false"：点它们的边缘要聚焦或展开，
  // 不能被窗口拖动吃掉；左内边距、搜索框与档案选择器之间的空档仍可拖。
  // 非模组工具页隐藏搜索与播放集后，这块空档本身就成了拖动把手（.topbar 是 deep）。
  return (
    <header className="topbar" data-tauri-drag-region="deep">
      {modTools ? (
        <div className="topbar-search" data-tauri-drag-region="false">
          <Search size={15} className="search-icon" />
          <input
            ref={searchRef}
            value={search}
            onChange={(event) => onSearch(event.target.value)}
            placeholder={t("topBar.searchPlaceholder")}
            spellCheck={false}
          />
          {search ? (
            <button className="search-clear" onClick={() => onSearch("")} aria-label={t("topBar.clearSearch")}>
              <X size={13} />
            </button>
          ) : (
            <button
              type="button"
              className="search-hint search-palette-trigger"
              onClick={onOpenPalette}
              title={t("topBar.openPalette")}
            >
              <Kbd>Ctrl</Kbd>
              <Kbd>K</Kbd>
            </button>
          )}
        </div>
      ) : null}

      {modTools ? (
        <ProfileMenu profiles={profiles} switching={switchingProfile} onSwitch={onSwitchProfile} />
      ) : null}

      <div className="topbar-actions" data-tauri-drag-region="false">
        <div className="bell-wrap" ref={bellRef}>
          <button
            ref={bellButtonRef}
            className="btn btn-ghost btn-bell"
            onClick={toggleBell}
            title={
              badgeCount > 0
                ? t("topBar.bellUnread", { count: badgeCount })
                : updateCount > 0
                  ? t("topBar.bellUpdates", { count: updateCount })
                  : t("topBar.bellRecent")
            }
            aria-label={t("topBar.bellAria")}
            aria-expanded={bellOpen}
          >
            <Bell size={15} />
          </button>
          {/* 角标必须挂在 .bell-wrap 上：.btn 带 clip-path，放按钮内部会被切掉一角。 */}
          {badgeCount > 0 ? (
            <i className="bell-badge" aria-hidden="true">
              {badgeCount > 9 ? "9+" : badgeCount}
            </i>
          ) : null}
          {bellOpen && panelPos
            ? createPortal(
                <div
                  ref={panelRef}
                  className="bell-panel"
                  data-bell-panel="1"
                  role="dialog"
                  aria-label={t("topBar.bellAria")}
                  style={{
                    top: panelPos.top,
                    left: panelPos.left,
                    width: panelPos.width,
                    maxHeight: panelPos.maxHeight,
                  }}
                >
                  <div className="bell-head">
                    <span>{t("topBar.bellHead")}</span>
                    {updateCount > 0 ? <b>{t("topBar.bellUpdates", { count: updateCount })}</b> : null}
                  </div>
                  {feed.length === 0 ? (
                    <div className="bell-empty">{t("topBar.bellEmpty")}</div>
                  ) : (
                    feed.map((item) => (
                      <div
                        key={item.id}
                        className={`activity-row ${item.at > bellEntrySeenAt ? "is-unread" : ""}`}
                        aria-label={item.at > bellEntrySeenAt ? t("topBar.bellUnreadRow") : undefined}
                      >
                        <span className="activity-time">{clockTime(item.at)}</span>
                        <span className="activity-copy">
                          <strong title={item.title}>{item.title}</strong>
                          {item.detail ? <span title={item.detail}>{item.detail}</span> : null}
                        </span>
                      </div>
                    ))
                  )}
                </div>,
                document.body,
              )
            : null}
        </div>
        {modTools ? (
          <button className="btn btn-ghost btn-import" onClick={onImport}>
            <Upload size={15} />
            {t("topBar.importMods")}
          </button>
        ) : null}
        {modTools ? (
          <button
            className="btn btn-ghost btn-import"
            data-pack-entry
            onClick={onOpenModpack}
            title={t("topBar.modpackTitle")}
          >
            <Package size={15} />
            {t("pack.title")}
          </button>
        ) : null}
        {gameRunning ? (
          <button
            className="btn btn-danger btn-launch btn-stop-game"
            onClick={onStopGame}
            disabled={stopping}
            title={t("topBar.stopGameTitle")}
          >
            {stopping ? <Spinner size={16} /> : <Square size={13} fill="currentColor" />}
            <span>{stopping ? t("topBar.stopping") : t("topBar.stopGame")}</span>
          </button>
        ) : (
          <button
            className="btn btn-primary btn-launch"
            onClick={onLaunch}
            disabled={launching}
            title={game ? t("topBar.launchTitle") : t("topBar.launchNeedsGame")}
          >
            {launching ? <Spinner size={16} /> : <Play size={15} fill="currentColor" />}
            <span>{launching ? t("topBar.launching") : t("topBar.launch")}</span>
            <span className="launch-shortcut">Ctrl ↵</span>
          </button>
        )}
      </div>
    </header>
  );
}
