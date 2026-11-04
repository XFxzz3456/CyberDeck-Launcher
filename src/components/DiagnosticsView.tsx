import { useEffect, useState, useSyncExternalStore } from "react";
import {
  AlertTriangle,
  Archive,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Clock,
  Cpu,
  ExternalLink,
  FileText,
  FolderOpen,
  Gauge,
  HardDrive,
  Info,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  ShieldX,
  Stethoscope,
  Terminal,
} from "lucide-react";
import type { DiagnosticIssue, DiagnosticsReport, EnvDiagnosis, Settings } from "../types";
import type { View } from "./Sidebar";
import {
  clearAllDependencyIgnores,
  depIgnoresVersion,
  ignoreDependency,
  nexusSearchUrl,
  readDepIgnores,
  subscribeDepIgnores,
} from "../lib/dependencies";
import { compactPath, relativeTime } from "../lib/format";
import { api } from "../lib/api";
import { t } from "../i18n";
import { Badge, ConfirmDialog, Spinner } from "./ui";
import { AiDiagnosisPanel } from "./AiDiagnosisPanel";

/** 版本串本身带 v 时不要再拼一次，否则会渲染成 `vv0.9.0`。 */
function withV(version: string): string {
  const value = version.trim();
  if (!value) return "—";
  return /^v/i.test(value) ? value : `v${value}`;
}
import { LogViewerDialog } from "./LogViewerDialog";
import { gameVersionText } from "../lib/gameVersion";

function SeverityIcon({ severity }: { severity: DiagnosticIssue["severity"] }) {
  if (severity === "error") return <CircleAlert size={17} />;
  if (severity === "warning") return <AlertTriangle size={17} />;
  if (severity === "ok") return <CheckCircle2 size={17} />;
  return <Info size={17} />;
}

/** #3 缺失前置的官方发布页。只做引导，不代下载、不代安装。 */
const RELEASE_PAGE: Record<string, string> = {
  red4ext: "https://github.com/WopsS/RED4ext/releases/latest",
  cet: "https://github.com/maximegmd/CyberEngineTweaks/releases/latest",
  redscript: "https://github.com/jac3km4/redscript/releases/latest",
  archivexl: "https://github.com/psiberx/ArchiveXL/releases/latest",
  tweakxl: "https://github.com/psiberx/TweakXL/releases/latest",
  codeware: "https://github.com/psiberx/Codeware/releases/latest",
  modsettings: "https://www.nexusmods.com/cyberpunk2077/mods/7968",
};

export function DiagnosticsView({
  report,
  loading,
  onRefresh,
  onCreateBackup,
  onRestore,
  onOpenLogs,
  onNavigate,
  onOpenPath,
  onAdopt,
  onOpenUrl,
  settings,
  onSettings,
  onError,
  openLogsRequest = 0,
  onOpenAiSettings,
}: {
  report: DiagnosticsReport | null;
  loading: boolean;
  onRefresh: () => void;
  onCreateBackup: () => void;
  onRestore: () => void;
  onOpenLogs: () => void;
  onNavigate: (view: View) => void;
  onOpenPath: (path: string) => void;
  /** 诊断里 action="adopt"（未受管 archive）的路由：打开收编预览。 */
  onAdopt: () => void;
  /** #3 前置引导闭环：打开框架官方发布页（走 open_url，不代下载）。 */
  onOpenUrl: (url: string) => void;
  settings: Settings;
  onSettings: (settings: Settings) => void;
  onError: (error: unknown, title?: string) => void;
  openLogsRequest?: number;
  /** 「前往 AI 配置」：跳到设置页 AI 分区。 */
  onOpenAiSettings?: () => void;
}) {
  const [env, setEnv] = useState<EnvDiagnosis | null>(null);
  const [envLoading, setEnvLoading] = useState(false);
  const [healing, setHealing] = useState(false);
  const [healNote, setHealNote] = useState<string | null>(null);
  const [confirmHeal, setConfirmHeal] = useState(false);

  const loadEnv = async () => {
    setEnvLoading(true);
    try {
      setEnv(await api.diagnoseEnvironment());
    } catch (error) {
      onError(error, t("diagnostics.envCheckFailed"));
    } finally {
      setEnvLoading(false);
    }
  };

  // 每次刷新诊断报告时顺带跑一次体检，两者共用同一个「刷新」心智。
  useEffect(() => {
    if (report) void loadEnv();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [report?.generatedAt]);

  const runHeal = async () => {
    setConfirmHeal(false);
    setHealing(true);
    try {
      const result = await api.healEnvironment();
      setHealNote(result.message);
      await loadEnv();
      onRefresh();
    } catch (error) {
      onError(error, t("diagnostics.healFailed"));
    } finally {
      setHealing(false);
    }
  };
  const [logViewerOpen, setLogViewerOpen] = useState(false);
  const [issuesOpen, setIssuesOpen] = useState(true);
  const [frameworksOpen, setFrameworksOpen] = useState(true);
  const [depsOpen, setDepsOpen] = useState(true);
  // 忽略表存在 localStorage，不在 React 状态树里。这里订阅它的版本号：
  // 不管改动来自本页按钮还是详情抽屉，都会触发本页重算（以前靠手动戳计数器，
  // 只能覆盖「自己点的」这一种来源）。返回值故意不取，订阅本身就是目的。
  useSyncExternalStore(subscribeDepIgnores, depIgnoresVersion);

  useEffect(() => {
    if (openLogsRequest > 0) setLogViewerOpen(true);
  }, [openLogsRequest]);

  if (!report) {
    return (
      <div className="page diagnostics-page">
        <div className="diagnostics-loading">
          <Stethoscope size={34} />
          <h2>{t("diagnostics.scanning")}</h2>
          <p>{t("diagnostics.scanningDetail")}</p>
          <Spinner size={22} />
        </div>
      </div>
    );
  }

  const installedFrameworks = report.frameworks.filter((framework) => framework.installed).length;
  const issueCount = report.issues.filter((issue) => issue.severity !== "info").length;

  // ── 依赖检查（deps.rs 的产出）──────────────────────────────
  // 每次渲染都读一遍：readDepIgnores 走进程内缓存，返回的是写时替换的共享快照，
  // 成本只有一次函数调用，不值得再套 useMemo（还会破坏上面的提前 return）。
  const ignoreMap = readDepIgnores();
  const isIgnored = (modId: string, frameworkId: string) =>
    (ignoreMap[modId] ?? []).includes(frameworkId);
  const depMods = (report.dependencies?.mods ?? []).filter(
    (item) => item.status !== "healthy" || item.requirements.some((req) => !req.satisfied),
  );
  const depIssues = depMods
    .map((item) => ({
      ...item,
      visible: item.requirements.filter(
        (req) => (!req.satisfied || !req.versionOk) && !isIgnored(item.modId, req.id),
      ),
    }))
    .filter((item) => item.visible.length > 0);
  const depIgnoredCount = depMods.reduce(
    (total, item) =>
      total + item.requirements.filter((req) => isIgnored(item.modId, req.id)).length,
    0,
  );
  const verdictTitle =
    report.summaryLevel === "error"
      ? t("diagnostics.verdictErrorTitle", { count: issueCount })
      : report.summaryLevel === "warning"
        ? t("diagnostics.verdictWarnTitle", { count: issueCount })
        : t("diagnostics.verdictOkTitle");
  const unmanagedIssue = report.issues.find((issue) => issue.id === "unmanaged-archives");

  return (
    <div className="page diagnostics-page">
      <header className="page-head">
        <div>
          <div className="eyebrow">// DIAGNOSTICS / LOCAL FIRST</div>
          <h1>
            {t("diagnostics.title")}<span className="h1-accent">.</span>
          </h1>
          <p className="page-sub">{t("diagnostics.pageSub")}</p>
        </div>
        <div className="head-actions">
          <span className="scan-time">
            <Clock size={13} /> {relativeTime(report.generatedAt)}
          </span>
          <button className="btn btn-primary" onClick={onRefresh} disabled={loading}>
            {loading ? <Spinner size={15} /> : <RefreshCw size={15} />}
            {t("diagnostics.rescan")}
          </button>
        </div>
      </header>

      <div className={`diagnostic-summary summary-${report.summaryLevel}`}>
        <div className="summary-icon">
          {report.summaryLevel === "error" ? (
            <ShieldX size={26} />
          ) : report.summaryLevel === "warning" ? (
            <AlertTriangle size={26} />
          ) : (
            <ShieldCheck size={26} />
          )}
        </div>
        <div className="summary-copy">
          <h2>{verdictTitle}</h2>
          <p>{report.summary}</p>
          <small className="summary-detail">
            {t("diagnostics.summaryLine", {
              enabled: report.enabledMods,
              deployed: report.deployedMods,
              conflicts: report.conflictCount,
              installed: installedFrameworks,
              total: report.frameworks.length,
            })}
          </small>
        </div>
        <div className="summary-metrics">
          <div>
            <strong title={report.game?.version ?? undefined}>
              {report.game?.version ? `v${gameVersionText(report.game.version) ?? report.game.version}` : "—"}
            </strong>
            <span>GAME</span>
          </div>
          <div>
            <strong>{report.enabledMods}</strong>
            <span>MODS</span>
          </div>
          <div className={issueCount > 0 ? "is-warning" : undefined}>
            <strong>{issueCount}</strong>
            <span>ISSUES</span>
          </div>
        </div>
      </div>

      {/* #5 External Changes 沟通：未受管文件从 issue 列表提到摘要第一屏，
          核心信息是「启动器永远不会自动删它们」——这是 CDL 与其他管理器的本质差异。 */}
      {unmanagedIssue ? (
        <div className="unmanaged-callout">
          <Archive size={17} />
          <div>
            <strong>{unmanagedIssue.title}</strong>
            <p>
              {t("diagnostics.unmanagedLead")}
              <b>{t("diagnostics.unmanagedStrong")}</b>
              {t("diagnostics.unmanagedTail")}
            </p>
          </div>
          <button className="btn btn-sm" onClick={onAdopt}>
            {t("diagnostics.startAdopt")} <ChevronRight size={12} />
          </button>
        </div>
      ) : null}

      <section className="panel env-panel">
        <div className="panel-head">
          <div>
            <div className="panel-eyebrow">// ENVIRONMENT / SELF CHECK</div>
            <h2>{t("diagnostics.envTitle")}</h2>
          </div>
          <div className="env-head-right">
            {env ? (
              <span className={`env-level env-${env.level}`}>
                {env.level === "healthy"
                  ? "HEALTHY"
                  : env.level === "info"
                    ? t("diagnostics.envLevelInfo")
                    : env.level === "warning"
                      ? "WARNING"
                      : "CRITICAL"}
              </span>
            ) : null}
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => void loadEnv()}
              disabled={envLoading}
            >
              {envLoading ? <Spinner size={12} /> : null} {t("diagnostics.recheck")}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => setConfirmHeal(true)}
              disabled={
                healing ||
                !env ||
                // 只有时间戳这类状态变化时没有可重建的链接，点了也是白点。
                env.issues.every((issue) => issue.kind === "time")
              }
            >
              {t("diagnostics.oneClickFix")}
            </button>
          </div>
        </div>

        {env ? (
          <>
            <div className="env-metrics">
              <div>
                <span>{t("diagnostics.checkedMods")}</span>
                <strong>{env.checkedMods}</strong>
              </div>
              <div>
                <span>{t("diagnostics.checkedFiles")}</span>
                <strong>{env.checkedFiles}</strong>
              </div>
              <div>
                <span>{t("diagnostics.foundIssues")}</span>
                <strong>{env.issues.length}</strong>
              </div>
            </div>
            <p className="env-summary">{env.summary}</p>
            {env.issues.length > 0 ? (
              <ul className="env-issues">
                {env.issues.slice(0, 6).map((issue, index) => (
                  <li key={`${issue.modId}-${issue.relativePath}-${index}`} className={`env-issue env-issue-${issue.kind}`}>
                    <span className="env-issue-kind">
                      {issue.kind === "missing"
                        ? t("diagnostics.kindMissing")
                        : issue.kind === "source_missing"
                          ? t("diagnostics.kindSourceMissing")
                          : issue.kind === "size"
                            ? t("diagnostics.kindSize")
                            : t("diagnostics.kindRewritten")}
                    </span>
                    <span className="env-issue-mod">{issue.modName}</span>
                    <code>{issue.relativePath}</code>
                  </li>
                ))}
              </ul>
            ) : null}
            {env.issues.length > 6 ? (
              <p className="panel-note">
                {t("diagnostics.moreIssues", { count: env.issues.length - 6 })}
              </p>
            ) : null}
            {env.issues.length > 0 ? (
              <p className="env-tolerance-hint">{t("diagnostics.envToleranceHint")}</p>
            ) : null}
            {healNote ? <p className="env-heal-note">{healNote}</p> : null}
          </>
        ) : (
          <p className="panel-note">
            {envLoading ? t("diagnostics.envLoading") : t("diagnostics.envEmpty")}
          </p>
        )}
      </section>
      <AiDiagnosisPanel
        report={report}
        settings={settings}
        onSettings={onSettings}
        onError={onError}
        onOpenAiSettings={onOpenAiSettings}
        // 动作执行完（启用态/加载顺序变了）立刻重拉整份诊断，别让界面说谎。
        onAfterAction={onRefresh}
      />

      <div className="diagnostics-grid">
        <div className="diagnostics-main">
          <section className={`panel panel-collapsible ${issuesOpen ? "" : "is-collapsed"}`}>
            <div className="panel-head">
              <div>
                <div className="panel-eyebrow">// ISSUES</div>
                <h2>{t("diagnostics.issuesTitle")}</h2>
              </div>
              <div className="panel-head-actions">
                <Badge
                  tone={
                    report.summaryLevel === "error"
                      ? "red"
                      : report.summaryLevel === "warning"
                        ? "yellow"
                        : "green"
                  }
                >
                  {report.issues.length} ITEMS
                </Badge>
                <button
                  className="panel-toggle"
                  onClick={() => setIssuesOpen((value) => !value)}
                  aria-expanded={issuesOpen}
                  title={issuesOpen ? t("diagnostics.collapse") : t("diagnostics.expand")}
                >
                  <ChevronDown size={14} />
                </button>
              </div>
            </div>
            <div className="issue-list">
              {report.issues.length === 0 ? (
                <div className="issue-row issue-ok">
                  <span className="issue-icon"><CheckCircle2 size={17} /></span>
                  <div>
                    <strong>{t("diagnostics.noIssuesTitle")}</strong>
                    <p>{t("diagnostics.noIssuesDetail")}</p>
                  </div>
                </div>
              ) : (
                report.issues.map((issue) => (
                  <div key={issue.id} className={`issue-row issue-${issue.severity}`}>
                    <span className="issue-icon"><SeverityIcon severity={issue.severity} /></span>
                    <div className="issue-copy">
                      <strong>{issue.title}</strong>
                      <p>{issue.detail}</p>
                    </div>
                    {issue.action ? (
                      <button
                        className="issue-action"
                        onClick={() => {
                          if (issue.action === "adopt") {
                            onAdopt();
                            return;
                          }
                          // 依赖类问题就地展开并滚到依赖面板——跳回本页顶部
                          // 等于什么都没做，用户还得自己往下找。
                          if (issue.action === "dependencies") {
                            setDepsOpen(true);
                            document
                              .getElementById("cdl-deps-panel")
                              ?.scrollIntoView({ behavior: "smooth", block: "start" });
                            return;
                          }
                          onNavigate(
                            issue.action === "settings"
                              ? "settings"
                              : issue.action === "loadorder"
                                ? "loadorder"
                                : "diagnostics",
                          );
                        }}
                      >
                        {issue.action === "adopt" ? t("diagnostics.startAdopt") : t("diagnostics.handleIssue")}{" "}
                        <ChevronRight size={13} />
                      </button>
                    ) : null}
                  </div>
                ))
              )}
            </div>
          </section>

          <section className={`panel panel-collapsible ${frameworksOpen ? "" : "is-collapsed"}`}>
            <div className="panel-head">
              <div>
                <div className="panel-eyebrow">// FRAMEWORKS</div>
                <h2>{t("diagnostics.frameworksTitle")}</h2>
              </div>
              <div className="panel-head-actions">
                <span className="panel-meta">
                  {installedFrameworks}/{report.frameworks.length} INSTALLED
                </span>
                <button
                  className="panel-toggle"
                  onClick={() => setFrameworksOpen((value) => !value)}
                  aria-expanded={frameworksOpen}
                  title={frameworksOpen ? t("diagnostics.collapse") : t("diagnostics.expand")}
                >
                  <ChevronDown size={14} />
                </button>
              </div>
            </div>
            <div className="framework-grid">
              {report.frameworks.map((framework) => (
                <div
                  key={framework.id}
                  className={`framework-card ${framework.installed ? "installed" : "missing"}`}
                >
                  <div className="framework-head">
                    <Cpu size={16} />
                    <span>{framework.name}</span>
                    <span className={`framework-state ${framework.installed ? "on" : ""}`}>
                      {framework.installed ? "OK" : "MISSING"}
                    </span>
                  </div>
                  <div className="framework-version">
                    {framework.version ? withV(framework.version) : framework.installed ? t("diagnostics.installed") : t("diagnostics.notDetected")}
                  </div>
                  <p>{framework.note}</p>
                  <code title={framework.path ?? ""}>{compactPath(framework.path, 38)}</code>
                  {!framework.installed && RELEASE_PAGE[framework.id] ? (
                    <button
                      className="framework-get-btn"
                      onClick={() => onOpenUrl(RELEASE_PAGE[framework.id])}
                      title={t("diagnostics.openReleasePage", { name: framework.name })}
                    >
                      <ExternalLink size={11} /> {t("diagnostics.releasePage")}
                    </button>
                  ) : null}
                </div>
              ))}
            </div>
          </section>

          <section
            id="cdl-deps-panel"
            className={`panel panel-collapsible ${depsOpen ? "" : "is-collapsed"}`}
          >
            <div className="panel-head">
              <div>
                <div className="panel-eyebrow">// DEPENDENCIES</div>
                <h2>{t("diagnostics.depsTitle")}</h2>
              </div>
              <div className="panel-head-actions">
                <span className="panel-meta">
                  {depIssues.length} / {report.dependencies?.checkedMods ?? 0} CHECKED
                </span>
                <button
                  className="panel-toggle"
                  onClick={() => setDepsOpen((value) => !value)}
                  aria-expanded={depsOpen}
                  title={depsOpen ? t("diagnostics.collapse") : t("diagnostics.expand")}
                >
                  <ChevronDown size={14} />
                </button>
              </div>
            </div>
            {depIssues.length === 0 ? (
              <div className="deps-empty">
                <ShieldCheck size={18} />
                <div>
                  <strong>{t("diagnostics.depsAllOk")}</strong>
                  <p>{t("diagnostics.depsAllOkDetail")}</p>
                </div>
              </div>
            ) : (
              <div className="deps-list">
                {depIssues.map((item) => (
                  <div key={item.modId} className="deps-row">
                    <div className="deps-row-main">
                      <span className="deps-mod">{item.modName}</span>
                      <div className="deps-chips">
                        {item.visible.map((req) => (
                          <span
                            key={req.id}
                            className={`deps-chip ${req.satisfied ? "is-version" : "is-missing"}`}
                            title={req.detail}
                          >
                            {req.name}
                            {req.satisfied && !req.versionOk
                              ? ` ${req.installedVersion ?? "?"} < ${req.requiredVersion ?? "?"}`
                              : ""}
                          </span>
                        ))}
                      </div>
                      <span className="deps-reason">
                        {item.visible[0]?.detail ?? ""}
                        {item.enabled ? "" : ` · ${t("diagnostics.depsDisabledMod")}`}
                      </span>
                    </div>
                    <div className="deps-row-actions">
                      {item.visible[0] ? (
                        <button
                          className="btn btn-ghost btn-sm"
                          onClick={() =>
                            onOpenUrl(
                              RELEASE_PAGE[item.visible[0].id] ??
                                nexusSearchUrl(item.visible[0].name),
                            )
                          }
                        >
                          <ExternalLink size={11} /> {t("diagnostics.depsGet")}
                        </button>
                      ) : null}
                      <button
                        className="btn btn-ghost btn-sm"
                        title={t("diagnostics.depsIgnoreHint")}
                        onClick={() => {
                          item.visible.forEach((req) => ignoreDependency(item.modId, req.id));
                        }}
                      >
                        {t("diagnostics.depsIgnore")}
                      </button>
                    </div>
                  </div>
                ))}
                {depIgnoredCount > 0 ? (
                  <button
                    className="deps-restore"
                    onClick={() => {
                      clearAllDependencyIgnores();
                    }}
                  >
                    <RotateCcw size={11} /> {t("diagnostics.depsRestoreAll", { count: depIgnoredCount })}
                  </button>
                ) : null}
              </div>
            )}
          </section>
        </div>

        <aside className="diagnostics-side">
          <section className="panel">
            <div className="panel-head">
              <div>
                <div className="panel-eyebrow">// GAME</div>
                <h2>{t("diagnostics.gameEnvTitle")}</h2>
              </div>
              <Gauge size={18} />
            </div>
            <div className="kv-list">
              <div className="kv">
                <span>{t("diagnostics.gameVersion")}</span>
                <strong title={report.game?.version ?? undefined}>
                  {report.game?.version
                    ? `v${gameVersionText(report.game.version) ?? report.game.version}`
                    : t("common.unknown")}
                </strong>
              </div>
              <div className="kv">
                <span>{t("diagnostics.gameSource")}</span>
                <strong>{report.game?.source?.toUpperCase() ?? "—"}</strong>
              </div>
              <div className="kv">
                <span>{t("diagnostics.gameLanguage")}</span>
                <strong>{report.game?.language ?? t("diagnostics.notRead")}</strong>
              </div>
              <div className="kv">
                <span>{t("diagnostics.gamePath")}</span>
                <button className="path-link" onClick={() => report.game && onOpenPath(report.game.root)}>
                  {compactPath(report.game?.root, 28)}
                </button>
              </div>
            </div>
            {report.game?.gameUpdated ? (
              <div className="inline-warning compact">
                <AlertTriangle size={14} />
                <span>{t("diagnostics.gameUpdated")}</span>
              </div>
            ) : (
              <div className="inline-ok">
                <CheckCircle2 size={14} /> {t("diagnostics.noGameUpdate")}
              </div>
            )}
          </section>

          <section className="panel">
            <div className="panel-head">
              <div>
                <div className="panel-eyebrow">// BACKUP</div>
                <h2>{t("diagnostics.backupTitle")}</h2>
              </div>
              <HardDrive size={18} />
            </div>
            {report.backup ? (
              <div className="backup-box">
                <div className="backup-row">
                  <span>{t("diagnostics.snapshot")}</span>
                  <strong>{report.backup.id}</strong>
                </div>
                <div className="backup-row">
                  <span>{t("diagnostics.created")}</span>
                  <strong>{relativeTime(report.backup.createdAt)}</strong>
                </div>
                <div className="backup-row">
                  <span>{t("diagnostics.files")}</span>
                  <strong>{t("diagnostics.fileCount", { count: report.backup.files.length })}</strong>
                </div>
              </div>
            ) : (
              <div className="inline-warning compact">
                <Info size={14} /> {t("diagnostics.noBackup")}
              </div>
            )}
            <div className="backup-actions">
              <button className="btn btn-ghost btn-sm" onClick={onCreateBackup}>
                <Archive size={13} /> {t("diagnostics.createBackup")}
              </button>
              <button className="btn btn-ghost btn-sm danger-text" onClick={onRestore}>
                <RotateCcw size={13} /> {t("diagnostics.restore")}
              </button>
            </div>
            <p className="panel-note">
              {t("diagnostics.restoreNote")}
            </p>
          </section>

          <section className="panel">
            <div className="panel-head">
              <div>
                <div className="panel-eyebrow">// LOGS</div>
                <h2>{t("diagnostics.logsTitle")}</h2>
              </div>
              <FileText size={18} />
            </div>
            <div className="log-list">
              {report.logPaths.length === 0 ? (
                <div className="muted-line">{t("diagnostics.noLogs")}</div>
              ) : (
                report.logPaths.map((path, index) => (
                  <button key={path} className="log-row" onClick={() => onOpenPath(path)}>
                    <span className="log-index">0{index + 1}</span>
                    <span className="log-path">{compactPath(path, 44)}</span>
                    <FolderOpen size={13} />
                  </button>
                ))
              )}
            </div>
            <button className="btn btn-ghost btn-sm full" onClick={() => setLogViewerOpen(true)}>
              <Terminal size={13} /> {t("diagnostics.viewLogs")}
            </button>
            <button className="btn btn-ghost btn-sm full" onClick={onOpenLogs}>
              <FolderOpen size={13} /> {t("diagnostics.logsFolder")}
            </button>
            <p className="panel-note">
              {t("diagnostics.logsNote")}
            </p>
          </section>
        </aside>
      </div>

      <ConfirmDialog
        open={confirmHeal}
        title={t("diagnostics.fixEnvTitle")}
        detail={
          <>
            <p>
              {t("diagnostics.fixEnvLead")}
              <b>{t("diagnostics.fixEnvStrong")}</b>
              {t("diagnostics.fixEnvTail")}
            </p>
            <p className="panel-note">
              {t("diagnostics.fixEnvNote")}
            </p>
          </>
        }
        confirmLabel={t("diagnostics.startFix")}
        busy={healing}
        onConfirm={() => void runHeal()}
        onClose={() => setConfirmHeal(false)}
      />
      <LogViewerDialog
        open={logViewerOpen}
        onClose={() => setLogViewerOpen(false)}
        onError={onError}
        onOpenLogs={onOpenLogs}
      />
    </div>
  );
}
