import {
  ChevronRight,
  Compass,
  Download,
  HardDrive,
  HardDriveDownload,
  LayoutGrid,
  ListOrdered,
  PanelLeftClose,
  PanelLeftOpen,
  Settings,
  Stethoscope,
} from "lucide-react";
import type { Snapshot, ExternalToolEntry } from "../types";
import { compactPath, formatBytes } from "../lib/format";
import { gameVersionText } from "../lib/gameVersion";
import { useAppVersion } from "../lib/appVersion";
import { t } from "../i18n";
import type { HiddenViewsMap } from "../lib/uiPrefs";
import { LogoMark } from "./LogoMark";
import type { SettingsTabId } from "./SettingsTabs";

export type View =
  | "library"
  | "discover"
  | "loadorder"
  | "downloads"
  | "diagnostics"
  | "saves"
  | "settings";

type NavEntry = { id: View; label: string; en: string; icon: typeof LayoutGrid };

/**
 * 主操作区：日常真正会反复点的四个。
 *
 * 帮助中心不在这里——它不是高频操作，占着左侧黄金位置只会挤压主流程，
 * 已挪进「设置 → 帮助」（Tab 列表里「关于」的左边）。
 */
const PRIMARY_NAV: NavEntry[] = [
  { id: "library", label: t("sidebar.library"), en: t("sidebar.libraryEn"), icon: LayoutGrid },
  { id: "discover", label: t("sidebar.discover"), en: t("sidebar.discoverEn"), icon: Compass },
  { id: "loadorder", label: t("sidebar.loadOrder"), en: t("sidebar.loadOrderEn"), icon: ListOrdered },
  { id: "diagnostics", label: t("sidebar.diagnostics"), en: t("sidebar.diagnosticsEn"), icon: Stethoscope },
  { id: "saves", label: t("sidebar.saves"), en: t("sidebar.savesEn"), icon: HardDriveDownload },
];

/**
 * 底部辅助区：永远贴在 GAME LINK 正上方。
 *
 * 沉底靠的是上面 .sidebar-scroll 的 flex:1 —— 它把中间空白全部吃掉，
 * 辅助区自然被顶到底部。这里**没有** position:absolute：窗口再怎么缩放，
 * 辅助区和 GAME LINK 都不会重叠，也不会在某档缩放下漂到中间。
 */
const AUX_NAV: NavEntry[] = [
  { id: "downloads", label: t("sidebar.downloads"), en: t("sidebar.downloadsEn"), icon: Download },
  { id: "settings", label: t("sidebar.settings"), en: t("sidebar.settingsEn"), icon: Settings },
];

/** B1 侧栏徽标推广：任何需要用户行动的状态，必须在侧栏有一个可达的数字。
 *  值为 undefined 时不显示；"!" 用于非计量的状态（如 Nexus 未连接）。 */
export type SidebarBadges = Partial<Record<View, number | string>>;

export function Sidebar({
  view,
  onNavigate,
  snapshot,
  stagingBytes,
  conflictCount,
  badges = {},
  collapsed = false,
  onToggleCollapsed,
  hiddenViews = {},
  pinnedTools = [],
  onLaunchTool,
}: {
  view: View;
  onNavigate: (view: View, tab?: SettingsTabId) => void;
  snapshot: Snapshot;
  stagingBytes: number;
  conflictCount: number;
  badges?: SidebarBadges;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
  /** 界面显示管理（deepseek 任务·模块四）：被隐藏的入口不渲染。 */
  hiddenViews?: HiddenViewsMap;
  /** 固定到侧栏的外部工具（deepseek 任务·模块三）。 */
  pinnedTools?: ExternalToolEntry[];
  onLaunchTool?: (id: string) => void;
}) {
  // 版本号动态读取，禁止硬编码（见 docs/AGENTS.md 版本更新自动化规范）。
  const appVersion = useAppVersion();
  const enabled = snapshot.state.mods.filter((mod) => mod.enabled).length;
  const game = snapshot.game;

  /** 主操作区与辅助区共用同一个渲染器：高亮、徽标、计数三条规则只写一遍。 */
  const renderNav = (item: NavEntry) => {
    const Icon = item.icon;
    const active = view === item.id;
    // 徽标优先级：显式 badges > 既有规则（diagnostics 冲突数）。
    const badge =
      badges[item.id] ??
      (item.id === "diagnostics" && conflictCount > 0 ? conflictCount : undefined);
    return (
      <button
        key={item.id}
        className={`nav-item ${active ? "active" : ""}`}
        onClick={() => onNavigate(item.id)}
        title={item.label}
        aria-label={item.label}
        aria-current={active ? "page" : undefined}
      >
        <Icon size={17} strokeWidth={1.7} />
        <span className="nav-copy">
          <span className="nav-label">{item.label}</span>
          <span className="nav-en">{item.en}</span>
        </span>
        {item.id === "library" ? <span className="nav-count">{snapshot.state.mods.length}</span> : null}
        {badge !== undefined ? (
          <span className={`nav-alert ${typeof badge !== "number" ? "nav-alert-mark" : ""}`}>
            {badge}
          </span>
        ) : null}
        {active ? <ChevronRight className="nav-chevron" size={13} /> : null}
      </button>
    );
  };

  return (
    <aside
      className={`sidebar ${collapsed ? "is-collapsed" : ""}`}
      data-collapsed={collapsed ? "true" : "false"}
    >
      {/* Logo 是个真按钮：以前是可点击的 div，键盘 / 读屏用户根本点不到
          （2026-11-10 自检 P2·可访问性）。外观仍由 .sidebar-logo 控制。 */}
      <button
        type="button"
        className="sidebar-logo"
        onClick={() => onNavigate("library")}
        aria-label={t("sidebar.logoAria")}
      >
        {/* 2026-11-03：Logo 改图形徽章（纯 SVG，主色走 currentColor）。
            三个方案见 components/LogoMark.tsx，className 沿用 logo-glyph
            以继承既有的 hover 缩放 + 发光。 */}
        <div className="logo-mark">
          <LogoMark className="logo-glyph" size={30} />
        </div>
        <div className="logo-copy">
          <strong>{t("app.brand")}</strong>
          <span>{t("app.brandSub")}</span>
          <em className="logo-sys">{t("sidebar.sysCheck")}</em>
        </div>
      </button>

      {/* 主操作区：整条侧栏里唯一可伸缩的一段。
          flex:1 吃掉中间空白 → 下面的辅助区被自然顶到底部。 */}
      <div className="sidebar-scroll">
        <div className="sidebar-section-label">{t("sidebar.sectionOperations")}</div>
        <nav className="sidebar-nav" aria-label={t("sidebar.sectionOperations")}>
          {PRIMARY_NAV.filter((item) => !hiddenViews[item.id as keyof HiddenViewsMap]).map(renderNav)}
        </nav>
        {pinnedTools.length > 0 ? (
          <>
            <div className="sidebar-section-label">{t("sidebar.sectionTools")}</div>
            {/* 独立 class（sidebar-tools-nav）：check-sidebar 的「主操作区 4 项」
                断言数的是 .sidebar-nav .nav-item，工具区不能混进去。 */}
            <nav className="sidebar-tools-nav" aria-label={t("sidebar.sectionTools")}>
              {pinnedTools.map((tool) => (
                <button
                  key={tool.id}
                  className="tool-nav-item"
                  onClick={() => onLaunchTool?.(tool.id)}
                  title={t("sidebar.toolLaunchTip", { name: tool.name })}
                  aria-label={t("sidebar.toolLaunchTip", { name: tool.name })}
                >
                  <span className="nav-tool-icon" aria-hidden="true">
                    {tool.icon?.trim() ? tool.icon : tool.name.trim().charAt(0).toUpperCase() || "?"}
                  </span>
                  <span className="nav-copy">
                    <span className="nav-label">{tool.name}</span>
                    <span className="nav-en">{t("sidebar.toolExternal")}</span>
                  </span>
                </button>
              ))}
            </nav>
          </>
        ) : null}
      </div>

      {/* 辅助区：flex:0 0 auto，不参与伸缩，永远紧贴 GAME LINK 上方。 */}
      <nav className="sidebar-nav sidebar-aux" aria-label={t("sidebar.sectionAux")}>
        {AUX_NAV.filter((item) => !hiddenViews[item.id as keyof HiddenViewsMap]).map(renderNav)}
      </nav>

      <div className={`sidebar-game ${game ? "linked" : ""}`}>
        <div className="sidebar-section-label">
          {t("sidebar.sectionGameLink")}
        </div>
        <div className="game-link-row">
          <span className={`status-dot ${game ? "ok" : "off"}`} />
          <div>
            <strong>{game ? t("sidebar.gameLinkedTitle") : t("sidebar.gameNotLinked")}</strong>
            {/* 版本号用社区叫法（2.5），exe 内部四段号放 title：
                玩家跟作者沟通说的是 2.5，但排查问题需要原始号。 */}
            <span
              title={
                game?.version
                  ? t("sidebar.gameVersionRaw", { version: game.version })
                  : undefined
              }
            >
              {game
                ? t("sidebar.gameVersionLine", {
                    version: gameVersionText(game.version) ?? t("common.unknown"),
                    source: game.source.toUpperCase(),
                  })
                : t("sidebar.gameLocateHint")}
            </span>
          </div>
        </div>
        <div className="game-path" title={game?.root ?? ""}>
          {compactPath(game?.root, 34)}
        </div>
        <button className="game-link-btn" onClick={() => onNavigate("settings", "game")}>
          {t("sidebar.gamePathButton")} <ChevronRight size={12} />
        </button>
      </div>

      <div className="sidebar-storage">
        <div className="storage-head">
          <span><HardDrive size={13} /> {t("sidebar.storageLabel")}</span>
          <span>{formatBytes(stagingBytes)}</span>
        </div>
        <div className="storage-bar">
          <i style={{ width: `${Math.min(92, 8 + enabled * 5)}%` }} />
        </div>
        <div className="storage-foot">
          <span>{t("sidebar.storageActive", { count: enabled })}</span>
          <span>{t("sidebar.storageStaged", { count: snapshot.state.mods.length - enabled })}</span>
        </div>
      </div>

      <button
        type="button"
        className="sidebar-collapse"
        onClick={onToggleCollapsed}
        title={collapsed ? t("sidebar.expand") : t("sidebar.collapse")}
        aria-label={collapsed ? t("sidebar.expand") : t("sidebar.collapse")}
        aria-expanded={!collapsed}
        disabled={!onToggleCollapsed}
      >
        {collapsed ? <PanelLeftOpen size={15} /> : <PanelLeftClose size={15} />}
        <span>{collapsed ? t("sidebar.expandPanel") : t("sidebar.collapsePanel")}</span>
      </button>

      <div className="sidebar-footer">
        <span>{appVersion}</span>
        <span>{t("app.codename")}</span>
      </div>
    </aside>
  );
}
