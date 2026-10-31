/**
 * 存档管理（任务 deepseek_865759，2026-10-30）。
 *
 * 三段式卡片流：① 环境快照（回滚前自动备份）② 本地存档与诊断 ③ 外部修复工具。
 * 设计红线：
 * - 绝不读写 .dat 二进制；存档信息只来自后端只读扫描。
 * - 「应用此环境」必须经确认弹窗，且后端会在应用前自动存一份 PreApplySnapshot。
 */
import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  ExternalLink,
  FolderOpen,
  HardDriveDownload,
  History,
  Plus,
  RotateCcw,
  Save,
  ScanLine,
  ShieldCheck,
  Trash2,
  Wrench,
} from "lucide-react";
import type { EnvSnapshot, SaveGameEntry, SaveScanReport } from "../types";
import { api, normalizeError } from "../lib/api";
import { t, type MessageKey } from "../i18n";
import { Spinner } from "./ui";
import { formatBytes } from "../lib/format";

/**
 * 上一次存档扫描结果。刻意放在模块作用域而不是 App 全局状态：
 * 它只服务这一个页面，且必须「整个应用生命周期内有效」——从存档管理切到
 * 模组库再切回来，几秒内文件不会变，重扫只是白等几秒。
 */
let saveScanCache: { report: SaveScanReport; at: number } | null = null;

/** 「上次扫描：刚刚 / 5 分钟前」。 */
function lastScanLabel(at: number): string {
  const minutes = Math.floor((Date.now() - at) / 60000);
  if (minutes < 1) return t("saves.scannedJustNow");
  if (minutes < 60) return t("saves.scannedMinutesAgo", { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("saves.scannedHoursAgo", { count: hours });
  return t("saves.scannedDaysAgo", { count: Math.floor(hours / 24) });
}


function timeLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("zh-CN", { hour12: false });
}

function playedLabel(epochSeconds: number): string {
  if (!epochSeconds) return "—";
  return new Date(epochSeconds * 1000).toLocaleString("zh-CN", { hour12: false });
}

const TRIGGER_KEYS: Record<EnvSnapshot["trigger"], MessageKey> = {
  manual: "saves.triggerManual",
  preDeploy: "saves.triggerPreDeploy",
  preApplySnapshot: "saves.triggerPreApply",
};

export function SavesView({
  saveEditorPath,
  onOpenSettings,
  onError,
}: {
  /** 设置里配的外部存档编辑器路径（空 = 未配置）。 */
  saveEditorPath: string;
  /** 跳到「设置 → 工具组件」配置编辑器。 */
  onOpenSettings: () => void;
  onError: (error: unknown, fallback: string) => void;
}) {
  const [snapshots, setSnapshots] = useState<EnvSnapshot[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [applying, setApplying] = useState(false);
  const [confirmApply, setConfirmApply] = useState<EnvSnapshot | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // 缓存命中就直接拿它当初始值：进页面瞬间就能看到上次的列表。
  const [scan, setScan] = useState<SaveScanReport | null>(saveScanCache?.report ?? null);
  const [scannedAt, setScannedAt] = useState<number | null>(saveScanCache?.at ?? null);
  const [scanning, setScanning] = useState(false);
  // 静默扫描失败只留按钮旁的黄色感叹号，不打断用户。
  const [scanError, setScanError] = useState<string | null>(null);
  const [openingEditor, setOpeningEditor] = useState(false);

  const flash = (message: string) => {
    setNotice(message);
    window.setTimeout(() => {
      setNotice((current) => (current === message ? null : current));
    }, 3200);
  };

  const loadSnapshots = useCallback(async () => {
    try {
      const list = await api.listEnvSnapshots();
      setSnapshots(list);
    } catch (error) {
      onError(error, t("saves.loadFailed"));
      setSnapshots([]);
    }
  }, [onError]);

  useEffect(() => {
    void loadSnapshots();
  }, [loadSnapshots]);

  const createSnapshot = async () => {
    setCreating(true);
    try {
      await api.createEnvSnapshot();
      await loadSnapshots();
      flash(t("saves.snapshotCreated"));
    } catch (error) {
      onError(error, t("saves.createFailed"));
    } finally {
      setCreating(false);
    }
  };

  const applySnapshot = async (snapshot: EnvSnapshot) => {
    setApplying(true);
    try {
      await api.applyEnvSnapshot(snapshot.id);
      await loadSnapshots();
      flash(t("saves.appliedOk"));
    } catch (error) {
      onError(error, t("saves.applyFailed"));
    } finally {
      setApplying(false);
      setConfirmApply(null);
    }
  };

  const deleteSnapshot = async (snapshot: EnvSnapshot) => {
    try {
      await api.deleteEnvSnapshot(snapshot.id);
      if (selected === snapshot.id) setSelected(null);
      await loadSnapshots();
    } catch (error) {
      onError(error, t("saves.deleteFailed"));
    }
  };

  /**
   * 扫描存档。
   *
   * `mode` 决定失败时的表现：manual = 用户点了按钮，弹红框；auto = 进页面时
   * 的后台静默刷新，失败只在按钮旁挂个感叹号——玩家可能正看着上一次的列表，
   * 一个红框弹出来会把「上次扫描」的上下文全冲掉。
   */
  const runScan = useCallback(
    async (mode: "auto" | "manual" = "manual") => {
      setScanning(true);
      setScanError(null);
      try {
        const report = await api.scanSaveGames();
        const at = Date.now();
        saveScanCache = { report, at };
        setScan(report);
        setScannedAt(at);
      } catch (error) {
        setScanError(normalizeError(error).message);
        if (mode === "manual") onError(error, t("saves.scanFailed"));
      } finally {
        setScanning(false);
      }
    },
    [onError],
  );

  // 只有「从来没扫过」才自动扫一次。有缓存就不动：来回切页面重扫等于每次白等几秒。
  useEffect(() => {
    if (saveScanCache) return;
    void runScan("auto");
  }, [runScan]);

  const openEditor = async () => {
    setOpeningEditor(true);
    try {
      await api.openSaveEditor();
      flash(t("saves.editorLaunched"));
    } catch (error) {
      onError(error, t("saves.editorFailed"));
    } finally {
      setOpeningEditor(false);
    }
  };

  return (
    <div className="page saves-page">
      <header className="page-head">
        <div>
          <div className="eyebrow">// SAVE MANAGER / READ-ONLY</div>
          <h1>
            {t("saves.title")}
            <span className="h1-accent">.</span>
          </h1>
          <p className="page-sub">{t("saves.pageSub")}</p>
        </div>
      </header>

      {notice ? <div className="saves-notice">{notice}</div> : null}

      {/* ── ① 环境快照 ───────────────────────────────────────────── */}
      <section className="panel saves-panel">
        <div className="panel-head">
          <div>
            <div className="panel-eyebrow">// ENVIRONMENT SNAPSHOTS</div>
            <h2>{t("saves.snapshotsTitle")}</h2>
          </div>
          <button className="btn btn-primary" onClick={() => void createSnapshot()} disabled={creating}>
            {creating ? <Spinner size={14} /> : <Plus size={14} />}
            {t("saves.createSnapshot")}
          </button>
        </div>
        <p className="saves-panel-hint">{t("saves.snapshotsHint")}</p>

        {snapshots === null ? (
          <div className="saves-empty">
            <Spinner size={16} /> {t("saves.loading")}
          </div>
        ) : snapshots.length === 0 ? (
          <div className="saves-empty">
            <History size={20} />
            <p>{t("saves.noSnapshots")}</p>
          </div>
        ) : (
          <>
            <div className="snapshot-grid">
              {snapshots.map((snapshot) => (
                <SnapshotCard
                  key={snapshot.id}
                  snapshot={snapshot}
                  selected={selected === snapshot.id}
                  onSelect={() => setSelected(snapshot.id)}
                  onDelete={() => void deleteSnapshot(snapshot)}
                />
              ))}
            </div>
            <div className="snapshot-apply-bar">
              <span className="snapshot-apply-hint">
                {selected ? t("saves.applyHintSelected") : t("saves.applyHintEmpty")}
              </span>
              <button
                className="btn btn-primary"
                disabled={!selected || applying}
                onClick={() => {
                  const target = snapshots.find((s) => s.id === selected);
                  if (target) setConfirmApply(target);
                }}
              >
                {applying ? <Spinner size={14} /> : <RotateCcw size={14} />}
                {t("saves.applySnapshot")}
              </button>
            </div>
          </>
        )}
      </section>

      {/* ── ② 本地存档与诊断 ─────────────────────────────────────── */}
      <section className="panel saves-panel">
        <div className="panel-head">
          <div>
            <div className="panel-eyebrow">// LOCAL SAVES / DIAGNOSIS</div>
            <h2>{t("saves.savesTitle")}</h2>
          </div>
          <div className="saves-scan-actions">
            {scannedAt ? (
              <span className="saves-scanned-at">
                {t("saves.lastScan", { time: lastScanLabel(scannedAt) })}
              </span>
            ) : null}
            {scanError ? (
              <span className="saves-scan-warn" title={scanError} role="status">
                <AlertTriangle size={13} />
              </span>
            ) : null}
            <button
              className="btn btn-primary"
              onClick={() => void runScan("manual")}
              disabled={scanning}
            >
              {scanning ? <Spinner size={14} /> : <ScanLine size={14} />}
              {t("saves.scanSaves")}
            </button>
          </div>
        </div>
        <p className="saves-panel-hint">{t("saves.savesHint")}</p>

        {scan === null && scanning ? (
          // 第一次进来还没数据：给骨架屏，不要一片空白让人以为页面挂了。
          <div className="save-grid saves-skeleton" aria-busy="true">
            {Array.from({ length: 8 }, (_, index) => (
              <div className="save-card is-skeleton" key={index} aria-hidden="true">
                <span className="skeleton-line title" />
                <span className="skeleton-line meta" />
                <span className="skeleton-line text" />
              </div>
            ))}
          </div>
        ) : scan === null ? (
          <div className="saves-empty">
            <HardDriveDownload size={20} />
            <p>{t("saves.scanEmpty")}</p>
          </div>
        ) : scan.saves.length === 0 ? (
          <div className="saves-empty">
            <p>{t("saves.noSaves")}</p>
          </div>
        ) : (
          <div className="save-grid">
            {scan.saves.map((save) => (
              <SaveCard key={save.path} save={save} />
            ))}
          </div>
        )}
        {scan?.root ? (
          <p className="saves-root">
            <FolderOpen size={12} /> {scan.root}
          </p>
        ) : null}
      </section>

      {/* ── ③ 外部修复工具 ───────────────────────────────────────── */}
      <section className="panel saves-panel">
        <div className="panel-head">
          <div>
            <div className="panel-eyebrow">// EXTERNAL REPAIR TOOLS</div>
            <h2>{t("saves.toolsTitle")}</h2>
          </div>
        </div>
        <div className="save-tool-card">
          <div className="save-tool-icon">
            <Wrench size={20} />
          </div>
          <div className="save-tool-copy">
            <strong>{t("saves.editorName")}</strong>
            <p>{t("saves.editorHint")}</p>
            <code>{saveEditorPath.trim() ? saveEditorPath : t("saves.editorUnset")}</code>
          </div>
          <div className="save-tool-actions">
            {saveEditorPath.trim() ? (
              <button className="btn btn-primary" onClick={() => void openEditor()} disabled={openingEditor}>
                {openingEditor ? <Spinner size={14} /> : <ExternalLink size={14} />}
                {t("saves.launchEditor")}
              </button>
            ) : null}
            <button className="btn btn-ghost" onClick={onOpenSettings}>
              {t("saves.configureEditor")}
            </button>
          </div>
        </div>
        <p className="save-tool-warning">
          <AlertTriangle size={13} /> {t("saves.editorWarning")}
        </p>
      </section>

      {/* ── 应用快照确认（强制：先警告再执行，后端自动备份旧环境）────── */}
      {confirmApply ? (
        <div className="modal-backdrop" role="dialog" aria-modal="true">
          <div className="modal saves-confirm">
            <div className="modal-head">
              <AlertTriangle size={18} className="saves-confirm-icon" />
              <h3>{t("saves.confirmTitle")}</h3>
            </div>
            <p className="modal-body">{t("saves.confirmBody")}</p>
            <p className="saves-confirm-note">{t("saves.confirmBackup")}</p>
            <div className="modal-actions">
              <button className="btn btn-ghost" onClick={() => setConfirmApply(null)} disabled={applying}>
                {t("common.cancel")}
              </button>
              <button
                className="btn btn-primary"
                onClick={() => void applySnapshot(confirmApply)}
                disabled={applying}
              >
                {applying ? <Spinner size={14} /> : <RotateCcw size={14} />}
                {t("saves.confirmApply")}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function SnapshotCard({
  snapshot,
  selected,
  onSelect,
  onDelete,
}: {
  snapshot: EnvSnapshot;
  selected: boolean;
  onSelect: () => void;
  onDelete: () => void;
}) {
  return (
    <div
      className={`snapshot-card ${selected ? "is-selected" : ""}`}
      onClick={onSelect}
      role="button"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect();
        }
      }}
    >
      <div className="snapshot-card-top">
        <ShieldCheck size={15} className="snapshot-shield" />
        <span className="snapshot-time">{timeLabel(snapshot.createdAt)}</span>
        <button
          className="snapshot-delete"
          title={t("saves.deleteSnapshot")}
          onClick={(event) => {
            event.stopPropagation();
            onDelete();
          }}
        >
          <Trash2 size={12} />
        </button>
      </div>
      <div className="snapshot-meta">
        <span className="snapshot-trigger">{t(TRIGGER_KEYS[snapshot.trigger])}</span>
        <span>
          {t("saves.snapshotMods", { enabled: snapshot.enabledCount, total: snapshot.modCount })}
        </span>
      </div>
      {snapshot.frameworks.length > 0 ? (
        <div className="snapshot-frameworks">
          {snapshot.frameworks.slice(0, 3).map((fw) => (
            <span key={fw.id} className="snapshot-fw">
              {fw.name}
              {fw.version ? ` ${fw.version}` : ""}
            </span>
          ))}
        </div>
      ) : null}
      {snapshot.label ? <p className="snapshot-label">{snapshot.label}</p> : null}
    </div>
  );
}

function SaveCard({ save }: { save: SaveGameEntry }) {
  const risky = save.risks.some((r) => r.severity !== "info");
  return (
    <div className={`save-card ${risky ? "is-risky" : ""}`}>
      <div className="save-card-top">
        {risky ? (
          <AlertTriangle size={15} className="save-risk-icon" />
        ) : (
          <CheckCircle2 size={15} className="save-ok-icon" />
        )}
        <strong className="save-name">{save.name}</strong>
        <Save size={13} className="save-icon" />
      </div>
      <div className="save-meta">
        <span>
          <Clock size={11} /> {playedLabel(save.lastPlayed)}
        </span>
        <span>{formatBytes(save.sizeBytes)}</span>
      </div>
      {save.risks.map((risk, index) => (
        <p key={index} className={`save-risk risk-${risk.severity}`}>
          {risk.message}
        </p>
      ))}
    </div>
  );
}
