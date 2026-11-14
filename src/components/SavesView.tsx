/**
 * 存档管理（任务 deepseek_865759，2026-10-30）。
 *
 * 三段式卡片流：① 环境快照（回滚前自动备份）② 本地存档与诊断 ③ 外部修复工具。
 * 设计红线：
 * - 绝不读写 .dat 二进制；存档信息只来自后端只读扫描。
 * - 「应用此环境」必须经确认弹窗，且后端会在应用前自动存一份 PreApplySnapshot。
 */
import { useCallback, useEffect, useRef, useState } from "react";
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
import type { EnvSnapshot, SaveGameEntry, SaveRisk, SaveScanReport, Settings } from "../types";
import { api, normalizeError } from "../lib/api";
import { t, type MessageKey } from "../i18n";
import { ConfirmDialog, Spinner, SwitchRow } from "./ui";
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

/** 风险清单默认只露这几条：一个前置缺失会让几十个模组同时报警，全铺开会淹掉整页。 */
const RISK_PREVIEW = 3;

const TRIGGER_KEYS: Record<EnvSnapshot["trigger"], MessageKey> = {
  manual: "saves.triggerManual",
  preDeploy: "saves.triggerPreDeploy",
  preApplySnapshot: "saves.triggerPreApply",
};

export function SavesView({
  settings,
  onSettings,
  onError,
}: {
  /** 全局设置：自动快照、快照上限、外部编辑器路径原本在前端设置页，2026-11-13 搬到本页。 */
  settings: Settings;
  onSettings: (next: Settings) => void;
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

  // 提示条定时器：新的盖掉旧的，卸载时一并清掉。不清理的话用户切走页面后
  // 定时器仍会在已卸载的组件上 setState（React 19 不报错，但状态更新会被丢弃、
  // 定时器本身也留在事件循环里）。
  const noticeTimer = useRef<number | null>(null);
  const flash = (message: string) => {
    setNotice(message);
    if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => {
      noticeTimer.current = null;
      setNotice((current) => (current === message ? null : current));
    }, 3200);
  };

  useEffect(
    () => () => {
      if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current);
      noticeTimer.current = null;
    },
    [],
  );

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

        {/* 环境级风险只提示一次：以前逐条塞进每个存档，一个前置缺失就刷满整页。 */}
        {scan && scan.globalRisks.length > 0 ? (
          <div className="saves-global-risk" role="status">
            <div className="saves-global-risk-head">
              <AlertTriangle size={14} />
              <strong>{t("saves.globalRiskTitle")}</strong>
              <span>{t("saves.globalRiskHint")}</span>
            </div>
            <RiskList risks={scan.globalRisks} scope="global" />
          </div>
        ) : null}

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

      {/* ── ③ 存档偏好 ─────────────────────────────────────────────
          这三项原本在「设置 → 工具组件」的一张卡里，和存档页是两个入口、状态还可能
          不同步。2026-11-13 按「一个动作一个入口」搬到本页：配置就在使用它的地方。 */}
      <section className="panel saves-panel">
        <div className="panel-head">
          <div>
            <div className="panel-eyebrow">// PREFERENCES</div>
            <h2>{t("saves.prefsTitle")}</h2>
          </div>
        </div>
        <div className="sidebar-pref">
          <SwitchRow
            title={t("saves.settingsAutoSnapshot")}
            description={t("saves.settingsAutoSnapshotDesc")}
            checked={settings.autoSnapshot}
            onChange={(value) => onSettings({ ...settings, autoSnapshot: value })}
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
            onChange={(event) => onSettings({ ...settings, snapshotLimit: Number(event.target.value) })}
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
          <input
            className="input save-editor-input"
            value={settings.saveEditorPath}
            placeholder={t("saves.editorNotConfigured")}
            onChange={(event) => onSettings({ ...settings, saveEditorPath: event.target.value })}
            spellCheck={false}
            aria-label={t("saves.settingsEditorPath")}
          />
        </div>
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
            <code>{settings.saveEditorPath.trim() ? settings.saveEditorPath : t("saves.editorUnset")}</code>
          </div>
          <div className="save-tool-actions">
            {settings.saveEditorPath.trim() ? (
              <button className="btn btn-primary" onClick={() => void openEditor()} disabled={openingEditor}>
                {openingEditor ? <Spinner size={14} /> : <ExternalLink size={14} />}
                {t("saves.launchEditor")}
              </button>
            ) : null}
          </div>
        </div>
        <p className="save-tool-warning">
          <AlertTriangle size={13} /> {t("saves.editorWarning")}
        </p>
      </section>

      {/* ── 应用快照确认（强制：先警告再执行，后端自动备份旧环境）──────
          用共享 ConfirmDialog 而不是自绘遮罩：Esc 分层关闭、焦点陷阱、
          遮罩点击关闭这三件事都由 Modal 统一处理，不用在每个页面重写一遍。 */}
      <ConfirmDialog
        open={confirmApply !== null}
        title={t("saves.confirmTitle")}
        detail={
          <>
            <p>{t("saves.confirmBody")}</p>
            <p className="saves-confirm-note">{t("saves.confirmBackup")}</p>
          </>
        }
        confirmLabel={t("saves.confirmApply")}
        busy={applying}
        onConfirm={() => {
          if (confirmApply) void applySnapshot(confirmApply);
        }}
        // 执行中不允许关：请求已经发出去了，关掉弹窗并不会中止它，
        // 只会让用户以为没生效然后重复点。
        onClose={() => {
          if (!applying) setConfirmApply(null);
        }}
      />
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
    <div className={`snapshot-card ${selected ? "is-selected" : ""}`}>
      {/* 卡片主体做成真按钮：键盘 Tab 得到、Enter / 空格能选。
          删除按钮必须是它的**兄弟**而不是子节点——交互元素嵌套会让读屏器
          在同一个位置上读到两个按钮，Tab 顺序也会变得不可预测。 */}
      <button type="button" className="snapshot-select" aria-pressed={selected} onClick={onSelect}>
        <div className="snapshot-card-top">
          <ShieldCheck size={15} className="snapshot-shield" />
          <span className="snapshot-time">{timeLabel(snapshot.createdAt)}</span>
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
      </button>
      <button
        className="snapshot-delete"
        title={t("saves.deleteSnapshot")}
        aria-label={t("saves.deleteSnapshot")}
        onClick={onDelete}
      >
        <Trash2 size={12} />
      </button>
    </div>
  );
}

/**
 * 风险清单：默认只显示 RISK_PREVIEW 条，其余折进一个可展开的按钮。
 * 每张卡片自己记展开状态——用户想细看某个存档时不应该把其它卡片一起撑开。
 */
function RiskList({ risks, scope }: { risks: SaveRisk[]; scope: "card" | "global" }) {
  const [expanded, setExpanded] = useState(false);
  if (risks.length === 0) return null;
  const shown = expanded ? risks : risks.slice(0, RISK_PREVIEW);
  const hidden = risks.length - shown.length;
  return (
    <div className="save-risk-list" data-risk-scope={scope}>
      {shown.map((risk, index) => (
        <p key={`${risk.kind}-${index}`} className={`save-risk risk-${risk.severity}`}>
          {risk.message}
        </p>
      ))}
      {risks.length > RISK_PREVIEW ? (
        <button
          type="button"
          className="save-risk-toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? t("saves.riskCollapse") : t("saves.riskMore", { count: hidden })}
        </button>
      ) : null}
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
      <RiskList risks={save.risks} scope="card" />
    </div>
  );
}
