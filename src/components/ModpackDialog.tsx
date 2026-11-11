import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  ArrowUpRight,
  Boxes,
  Check,
  Download,
  ExternalLink,
  FileDown,
  FileUp,
  FolderOpen,
  Globe,
  Package,
  Sparkles,
  TriangleAlert,
} from "lucide-react";
import { t } from "../i18n";
import { api, isTauri } from "../lib/api";
import { formatBytes } from "../lib/format";
import type {
  BackfillProposal,
  BackfillReport,
  PackApplyReport,
  PackPreview,
  PackQueueReport,
  PackInstallReport,
  PackKind,
} from "../lib/pack";
import { Badge, EmptyState, Modal, Spinner } from "./ui";

/**
 * 整合包导出 / 导入。
 *
 * 两个模式共用一层壳：`mode` 决定初始标签，但两边都能切——从模组库点「导出」
 * 进来想顺手看一眼别人给的包，不该被迫关掉重开。
 *
 * 设计取舍：
 * - 导出只写数据目录 `exports/`，不做「另存为」。只申请了 dialog:allow-open，
 *   固定目录 + 路径回显少一步；重活儿（完整包 3.5 GB）本来也不适合弹框。
 * - 导入的「已装 / 缺失」每次都从后端现算，所以中途关掉软件再打开，
 *   重新预览一次就是最新进度，不需要额外维护会话文件。
 * - 免费号不给「下载」按钮：Nexus 只给 Premium 签 API 直链。免费号的路径是
 *   「逐个打开页面」，页面上点下载后 nxm 会被启动器接管，自动入队。
 */

type Mode = "export" | "import";

const STATUS_TONE: Record<string, "green" | "yellow" | "red" | "muted"> = {
  installed: "green",
  version_mismatch: "yellow",
  missing: "red",
  local_only: "muted",
};

function statusLabel(status: string): string {
  switch (status) {
    case "installed":
      return t("pack.statusInstalled");
    case "version_mismatch":
      return t("pack.statusMismatch");
    case "local_only":
      return t("pack.statusLocalOnly");
    default:
      return t("pack.statusMissing");
  }
}

export function ModpackDialog({
  open,
  mode,
  initialPath,
  premium,
  onClose,
  onError,
  onRefresh,
}: {
  open: boolean;
  mode: Mode;
  /** 拖进来的包路径；有值时直接进导入预览。 */
  initialPath: string | null;
  /** 当前 Nexus 账号是否 Premium：决定「全部下载」能不能点。 */
  premium: boolean;
  onClose: () => void;
  onError: (error: unknown, title?: string) => void;
  onRefresh: () => void;
}) {
  const [tab, setTab] = useState<Mode>(mode);
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number; label: string } | null>(
    null,
  );

  // 导出
  const [name, setName] = useState("");
  const [author, setAuthor] = useState("");
  const [kind, setKind] = useState<PackKind>("list");
  const [includeUnlisted, setIncludeUnlisted] = useState(true);
  const [exported, setExported] = useState<{
    path: string;
    sizeBytes: number;
    mods: number;
    enabled: number;
    configs: number;
    unresolved: number;
    warnings: string[];
  } | null>(null);

  // 回填
  const [backfill, setBackfill] = useState<BackfillReport | null>(null);
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [backfilled, setBackfilled] = useState<number | null>(null);

  // 导入
  const [packPath, setPackPath] = useState<string | null>(initialPath);
  const [preview, setPreview] = useState<PackPreview | null>(null);
  const [queue, setQueue] = useState<PackQueueReport | null>(null);
  const [installReport, setInstallReport] = useState<PackInstallReport | null>(null);
  const [applied, setApplied] = useState<PackApplyReport | null>(null);
  const [showAll, setShowAll] = useState(false);
  const busyRef = useRef(false);

  useEffect(() => {
    if (!open) return;
    setTab(mode);
    setExported(null);
    setApplied(null);
    setQueue(null);
    setInstallReport(null);
    setBackfill(null);
    setBackfilled(null);
    setPicked({});
    setProgress(null);
    setPackPath(initialPath);
    setName(defaultName());
    if (!initialPath) setPreview(null);
  }, [open, mode, initialPath]);

  // 导出/安装进度：事件名与后端 emit 一致，取消订阅要彻底，否则关掉对话框还在刷。
  useEffect(() => {
    if (!open || !isTauri) return;
    let dispose: Array<() => void> = [];
    void (async () => {
      try {
        dispose = await Promise.all([
          listen<{ done: number; total: number; label: string }>("pack-export-progress", (event) =>
            setProgress(event.payload),
          ),
          listen<{ done: number; total: number; label: string }>("pack-install-progress", (event) =>
            setProgress(event.payload),
          ),
        ]);
      } catch {
        // 浏览器预览没有事件 API，进度条不显示而已。
      }
    })();
    return () => dispose.forEach((off) => off());
  }, [open]);

  const loadPreview = useCallback(
    async (path: string) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setBusy("preview");
      setApplied(null);
      setQueue(null);
      try {
        const next = await api.packPreview(path);
        setPreview(next);
        setPackPath(path);
      } catch (error) {
        setPreview(null);
        onError(error, t("pack.errorPreview"));
      } finally {
        busyRef.current = false;
        setBusy(null);
      }
    },
    [onError],
  );

  useEffect(() => {
    if (open && initialPath) void loadPreview(initialPath);
  }, [open, initialPath, loadPreview]);

  const runExport = async () => {
    if (!name.trim()) return;
    setBusy("export");
    setExported(null);
    setProgress({ done: 0, total: 0, label: t("pack.preparing") });
    try {
      const report = await api.packExport({
        kind,
        name: name.trim(),
        author: author.trim() || undefined,
        includeUnlisted: kind === "full" ? true : includeUnlisted,
      });
      setExported(report);
    } catch (error) {
      onError(error, t("pack.errorExport"));
    } finally {
      setBusy(null);
      setProgress(null);
    }
  };

  const runBackfill = async (useRemote: boolean) => {
    setBusy(useRemote ? "remote" : "backfill");
    setBackfilled(null);
    try {
      const report = await api.nexusBackfillPropose(useRemote);
      setBackfill(report);
      // 默认只勾「稳」的：Vortex 精确命中 / 文件名抠出的编号。
      // 联网搜索与包含匹配默认不勾，误绑的代价比留空大。
      const next: Record<string, boolean> = {};
      for (const item of report.proposals) {
        next[item.entryId] = item.source !== "search" && item.confidence === "exact";
      }
      setPicked(next);
    } catch (error) {
      onError(error, t("pack.errorBackfill"));
    } finally {
      setBusy(null);
    }
  };

  const applyBackfill = async () => {
    if (!backfill) return;
    const chosen: BackfillProposal[] = backfill.proposals.filter((item) => picked[item.entryId]);
    if (chosen.length === 0) return;
    setBusy("applyBackfill");
    try {
      const written = await api.nexusBackfillApply(chosen);
      setBackfilled(written);
      setBackfill(null);
      onRefresh();
    } catch (error) {
      onError(error, t("pack.errorBackfill"));
    } finally {
      setBusy(null);
    }
  };

  const pickFile = async () => {
    try {
      const pickedPath = await openDialog({
        multiple: false,
        filters: [
          { name: t("pack.fileFilter"), extensions: ["cdlist", "cdpack"] },
          { name: t("pack.fileFilterCollection"), extensions: ["collection", "json", "zip"] },
        ],
      });
      if (typeof pickedPath !== "string") return;
      await loadPreview(pickedPath);
    } catch (error) {
      onError(error, t("pack.errorPreview"));
    }
  };

  const runInstall = async () => {
    if (!packPath) return;
    setBusy("install");
    setProgress({ done: 0, total: 0, label: t("pack.preparing") });
    try {
      const report = await api.packInstall(packPath);
      setInstallReport(report);
      if (report.installed > 0) onRefresh();
      await loadPreview(packPath);
    } catch (error) {
      onError(error, t("pack.errorInstall"));
    } finally {
      setBusy(null);
      setProgress(null);
    }
  };

  const runQueue = async () => {
    if (!packPath) return;
    setBusy("queue");
    try {
      const report = await api.packQueueDownloads(packPath, premium);
      setQueue(report);
    } catch (error) {
      onError(error, t("pack.errorQueue"));
    } finally {
      setBusy(null);
    }
  };

  const openNextPage = async () => {
    if (!packPath) return;
    try {
      const pages = queue?.manual ?? (await api.packManualPages(packPath));
      if (!queue) setQueue({ queued: 0, skipped: 0, manual: pages, warnings: [] });
      // 一次只开一个：开十个标签页浏览器会拦，玩家也分不清哪个点过。
      const next = pages[0];
      if (next) await api.openUrl(next.url);
    } catch (error) {
      onError(error, t("pack.errorQueue"));
    }
  };

  const runApply = async () => {
    if (!packPath) return;
    setBusy("apply");
    try {
      const report = await api.packApply(packPath);
      setApplied(report);
      onRefresh();
    } catch (error) {
      onError(error, t("pack.errorApply"));
    } finally {
      setBusy(null);
    }
  };

  const missingItems = useMemo(
    () =>
      preview?.items.filter(
        (item) => item.status === "missing" || item.status === "version_mismatch",
      ) ?? [],
    [preview],
  );
  const installedItems = useMemo(
    () => preview?.items.filter((item) => item.status === "installed") ?? [],
    [preview],
  );
  const visibleMissing = showAll ? missingItems : missingItems.slice(0, 8);
  const backfillPickedCount = backfill
    ? backfill.proposals.filter((item) => picked[item.entryId]).length
    : 0;

  return (
    <Modal
      open={open}
      title={t("pack.title")}
      eyebrow="// MODPACK"
      onClose={onClose}
      width={760}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            {t("common.close")}
          </button>
          {tab === "export" ? (
            <button
              type="button"
              className="btn btn-primary"
              onClick={runExport}
              disabled={busy !== null || !name.trim()}
            >
              {busy === "export" ? <Spinner /> : <FileDown size={14} />} {t("pack.exportNow")}
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-primary"
              onClick={runApply}
              disabled={busy !== null || !preview || missingItems.length > 0}
              title={
                missingItems.length > 0 ? t("pack.applyBlocked") : t("pack.applyHint")
              }
            >
              {busy === "apply" ? <Spinner /> : <Check size={14} />} {t("pack.apply")}
            </button>
          )}
        </>
      }
    >
      <div className="pack-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "export"}
          className={`pack-tab ${tab === "export" ? "is-active" : ""}`}
          onClick={() => setTab("export")}
        >
          <FileDown size={13} /> {t("pack.tabExport")}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "import"}
          className={`pack-tab ${tab === "import" ? "is-active" : ""}`}
          onClick={() => setTab("import")}
        >
          <FileUp size={13} /> {t("pack.tabImport")}
        </button>
      </div>

      {progress ? (
        <div className="pack-progress" aria-live="polite">
          <div className="pack-progress-head">
            <span>{progress.label || t("pack.preparing")}</span>
            <code>
              {progress.total > 0 ? `${progress.done}/${progress.total}` : "…"}
            </code>
          </div>
          <div className="pack-progress-bar">
            <span
              style={{
                width:
                  progress.total > 0
                    ? `${Math.min(100, (progress.done / progress.total) * 100)}%`
                    : "18%",
              }}
            />
          </div>
        </div>
      ) : null}

      {tab === "export" ? (
        <div className="pack-panel">
          <p className="pack-lead">{t("pack.exportLead")}</p>

          <div className="pack-field-row">
            <label className="pack-field">
              <span>{t("pack.nameLabel")}</span>
              <input
                className="input"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder={t("pack.namePlaceholder")}
                maxLength={80}
              />
            </label>
            <label className="pack-field">
              <span>{t("pack.authorLabel")}</span>
              <input
                className="input"
                value={author}
                onChange={(event) => setAuthor(event.target.value)}
                placeholder={t("pack.authorPlaceholder")}
                maxLength={60}
              />
            </label>
          </div>

          <div className="pack-kind-grid">
            <button
              type="button"
              className={`pack-kind ${kind === "list" ? "is-active" : ""}`}
              onClick={() => setKind("list")}
              aria-pressed={kind === "list"}
            >
              <span className="pack-kind-icon">
                <Boxes size={17} />
              </span>
              <strong>{t("pack.kindListTitle")}</strong>
              <em>{t("pack.kindListDetail")}</em>
              <small>{t("pack.kindListSize")}</small>
            </button>
            <button
              type="button"
              className={`pack-kind ${kind === "full" ? "is-active" : ""}`}
              onClick={() => setKind("full")}
              aria-pressed={kind === "full"}
            >
              <span className="pack-kind-icon">
                <Package size={17} />
              </span>
              <strong>{t("pack.kindFullTitle")}</strong>
              <em>{t("pack.kindFullDetail")}</em>
              <small>{t("pack.kindFullSize")}</small>
            </button>
          </div>

          {kind === "list" ? (
            <label className="pack-check">
              <input
                type="checkbox"
                checked={includeUnlisted}
                onChange={(event) => setIncludeUnlisted(event.target.checked)}
              />
              <span>
                {t("pack.includeLocal")}
                <em>{t("pack.includeLocalHint")}</em>
              </span>
            </label>
          ) : (
            <p className="pack-hint">{t("pack.fullIncludesLocal")}</p>
          )}

          <div className="pack-block">
            <div className="pack-block-head">
              <Sparkles size={13} />
              <strong>{t("pack.backfillTitle")}</strong>
            </div>
            <p className="pack-hint">{t("pack.backfillHint")}</p>
            <div className="pack-actions">
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => runBackfill(false)}
                disabled={busy !== null}
              >
                {busy === "backfill" ? <Spinner size={12} /> : <Sparkles size={12} />}
                {t("pack.backfillLocal")}
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => runBackfill(true)}
                disabled={busy !== null}
                title={t("pack.backfillRemoteHint")}
              >
                {busy === "remote" ? <Spinner size={12} /> : <Globe size={12} />}
                {t("pack.backfillRemote")}
              </button>
            </div>

            {backfilled !== null ? (
              <p className="pack-ok">
                <Check size={12} /> {t("pack.backfillDone", { count: backfilled })}
              </p>
            ) : null}

            {backfill ? (
              <div className="pack-backfill">
                <div className="pack-backfill-meta">
                  <span>
                    {t("pack.backfillScanned", {
                      scanned: backfill.scanned,
                      matched: backfill.proposals.length,
                    })}
                  </span>
                  {backfill.remoteMessage ? <em>{backfill.remoteMessage}</em> : null}
                  {backfill.vortexStatus !== "ok" ? <em>{backfill.vortexMessage}</em> : null}
                </div>
                <div className="pack-backfill-list">
                  {backfill.proposals.map((item) => (
                    <label key={item.entryId} className="pack-backfill-row">
                      <input
                        type="checkbox"
                        checked={Boolean(picked[item.entryId])}
                        onChange={(event) =>
                          setPicked((prev) => ({ ...prev, [item.entryId]: event.target.checked }))
                        }
                      />
                      <span className="pack-backfill-name">{item.entryName}</span>
                      <span className="pack-backfill-arrow">→</span>
                      <span className="pack-backfill-target">
                        {item.matchedName}
                        <code>#{item.modId}</code>
                      </span>
                      <Badge tone={item.confidence === "exact" ? "green" : "yellow"}>
                        {item.source}·{item.confidence}
                      </Badge>
                    </label>
                  ))}
                  {backfill.proposals.length === 0 ? (
                    <p className="pack-hint">{t("pack.backfillNone")}</p>
                  ) : null}
                </div>
                {backfill.unmatched.length > 0 ? (
                  <p className="pack-hint">
                    {t("pack.backfillUnmatched", { count: backfill.unmatched.length })}：
                    {backfill.unmatched.slice(0, 6).join("、")}
                    {backfill.unmatched.length > 6 ? " …" : ""}
                  </p>
                ) : null}
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={applyBackfill}
                  disabled={busy !== null || backfillPickedCount === 0}
                >
                  {busy === "applyBackfill" ? <Spinner size={12} /> : <Check size={12} />}
                  {t("pack.backfillApply", { count: backfillPickedCount })}
                </button>
              </div>
            ) : null}
          </div>

          {exported ? (
            <div className="pack-result">
              <div className="pack-result-head">
                <Check size={15} />
                <strong>{t("pack.exportedTitle")}</strong>
                <Badge tone="green">{formatBytes(exported.sizeBytes)}</Badge>
              </div>
              <code className="pack-path">{exported.path}</code>
              <p className="pack-hint">
                {t("pack.exportedDetail", {
                  mods: exported.mods,
                  enabled: exported.enabled,
                  configs: exported.configs,
                  unresolved: exported.unresolved,
                })}
              </p>
              {exported.warnings.length > 0 ? (
                <ul className="pack-warnings">
                  {exported.warnings.slice(0, 6).map((warning) => (
                    <li key={warning}>
                      <TriangleAlert size={11} /> {warning}
                    </li>
                  ))}
                </ul>
              ) : null}
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => void api.openInExplorer(exported.path)}
              >
                <FolderOpen size={12} /> {t("pack.reveal")}
              </button>
            </div>
          ) : null}
        </div>
      ) : (
        <div className="pack-panel">
          <p className="pack-lead">{t("pack.importLead")}</p>

          <div className="pack-actions">
            <button type="button" className="btn btn-primary btn-sm" onClick={pickFile}>
              <FileUp size={13} /> {t("pack.pickFile")}
            </button>
            {preview ? (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => void loadPreview(preview.path)}
                disabled={busy !== null}
              >
                {busy === "preview" ? <Spinner size={12} /> : <ArrowUpRight size={12} />}
                {t("pack.recheck")}
              </button>
            ) : null}
          </div>

          {busy === "preview" && !preview ? (
            <div className="pack-loading">
              <Spinner /> {t("pack.previewing")}
            </div>
          ) : null}

          {preview ? (
            <>
              <div className="pack-summary">
                <div className="pack-summary-head">
                  <div>
                    <strong>{preview.name || t("pack.unnamed")}</strong>
                    <em>
                      {preview.author || t("pack.unknownAuthor")} · {preview.mode === "full"
                        ? t("pack.kindFullTitle")
                        : t("pack.kindListTitle")}
                    </em>
                  </div>
                  <Badge tone="cyan">{formatBytes(preview.totalSize)}</Badge>
                </div>
                <div className="pack-stats">
                  <span>
                    <strong>{preview.total}</strong>
                    {t("pack.statTotal")}
                  </span>
                  <span className="is-green">
                    <strong>{preview.installed}</strong>
                    {t("pack.statInstalled")}
                  </span>
                  <span className="is-red">
                    <strong>{preview.missing}</strong>
                    {t("pack.statMissing")}
                  </span>
                  <span className="is-yellow">
                    <strong>{preview.versionMismatch}</strong>
                    {t("pack.statMismatch")}
                  </span>
                  <span>
                    <strong>{preview.localOnly}</strong>
                    {t("pack.statLocalOnly")}
                  </span>
                  <span>
                    <strong>{preview.configs}</strong>
                    {t("pack.statConfigs")}
                  </span>
                </div>
              </div>

              <div className="pack-actions">
                {preview.mode === "full" && missingItems.some((item) => item.hasFiles) ? (
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    onClick={runInstall}
                    disabled={busy !== null}
                  >
                    {busy === "install" ? <Spinner size={12} /> : <Package size={12} />}
                    {t("pack.installBodies")}
                  </button>
                ) : null}
                {preview.missing > 0 ? (
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={runQueue}
                    disabled={busy !== null}
                  >
                    {busy === "queue" ? <Spinner size={12} /> : <Download size={12} />}
                    {premium ? t("pack.downloadAll") : t("pack.collectPages")}
                  </button>
                ) : null}
                {!premium && preview.missing > 0 ? (
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={openNextPage}
                    disabled={busy !== null}
                  >
                    <ExternalLink size={12} /> {t("pack.openNext")}
                  </button>
                ) : null}
              </div>

              {!premium && preview.missing > 0 ? (
                <p className="pack-hint">{t("pack.freeHint")}</p>
              ) : null}

              {installReport ? (
                installReport.failed > 0 || installReport.warnings.length > 0 ? (
                  <ul className="pack-warnings">
                    {installReport.warnings.slice(0, 5).map((warning) => (
                      <li key={warning}>
                        <TriangleAlert size={11} /> {warning}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="pack-ok">
                    <Check size={12} /> {t("pack.installedCount", { count: installReport.installed })}
                  </p>
                )
              ) : null}

              {queue && queue.queued > 0 ? (
                <p className="pack-ok">
                  <Check size={12} /> {t("pack.queuedDetail", { count: queue.queued })}
                </p>
              ) : null}
              {queue?.manual.length ? (
                <p className="pack-hint">
                  {t("pack.manualHint", { count: queue.manual.length })}
                </p>
              ) : null}

              <div className="pack-list-head">
                <strong>{t("pack.missingTitle")}</strong>
                <span>{missingItems.length}</span>
              </div>
              {missingItems.length === 0 ? (
                <p className="pack-ok">
                  <Check size={12} /> {t("pack.allReady")}
                </p>
              ) : (
                <div className="pack-list">
                  {visibleMissing.map((item) => (
                    <div key={item.key} className="pack-row">
                      <Badge tone={STATUS_TONE[item.status] ?? "muted"}>
                        {statusLabel(item.status)}
                      </Badge>
                      <span className="pack-row-name">{item.name}</span>
                      <code className="pack-row-meta">
                        {item.version ? `v${item.version}` : "—"}
                        {item.matchedVersion ? ` → v${item.matchedVersion}` : ""}
                      </code>
                      <span className="pack-row-size">{formatBytes(item.sizeBytes)}</span>
                      {item.pageUrl ? (
                        <button
                          type="button"
                          className="icon-btn"
                          title={t("pack.openPage")}
                          onClick={() => void api.openUrl(item.pageUrl!)}
                        >
                          <ExternalLink size={12} />
                        </button>
                      ) : null}
                    </div>
                  ))}
                  {missingItems.length > visibleMissing.length ? (
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => setShowAll(true)}
                    >
                      {t("pack.showAll", { count: missingItems.length })}
                    </button>
                  ) : null}
                </div>
              )}

              {installedItems.length > 0 ? (
                <p className="pack-hint">
                  {t("pack.installedHint", { count: installedItems.length })}
                </p>
              ) : null}

              {preview.warnings.length > 0 ? (
                <ul className="pack-warnings">
                  {preview.warnings.slice(0, 6).map((warning) => (
                    <li key={warning}>
                      <TriangleAlert size={11} /> {warning}
                    </li>
                  ))}
                </ul>
              ) : null}

              {applied ? (
                <div className="pack-result">
                  <div className="pack-result-head">
                    <Check size={15} />
                    <strong>{t("pack.appliedTitle")}</strong>
                  </div>
                  <p className="pack-hint">
                    {t("pack.appliedDetail", {
                      deployed: applied.deployed,
                      undeployed: applied.undeployed,
                      configs: applied.configsWritten,
                      order: applied.orderApplied,
                    })}
                  </p>
                  {applied.configsFailed > 0 ? (
                    <p className="pack-hint is-warn">
                      {t("pack.configsFailed", { count: applied.configsFailed })}
                    </p>
                  ) : null}
                  {applied.warnings.length > 0 ? (
                    <ul className="pack-warnings">
                      {applied.warnings.slice(0, 5).map((warning) => (
                        <li key={warning}>
                          <TriangleAlert size={11} /> {warning}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ) : null}
            </>
          ) : busy !== "preview" ? (
            <EmptyState
              icon={<FileUp size={22} />}
              title={t("pack.emptyTitle")}
              detail={t("pack.emptyDetail")}
            />
          ) : null}
        </div>
      )}
    </Modal>
  );
}

function defaultName(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return t("pack.defaultName", {
    date: `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`,
  });
}

