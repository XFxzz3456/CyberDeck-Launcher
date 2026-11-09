import { useCallback, useEffect, useState } from "react";
import { Activity, RefreshCw, RotateCcw, Undo2 } from "lucide-react";
import { api } from "../lib/api";
import type {
  AdoptStagingHealth,
  VortexTakeoverPreflight,
  VortexSyncStatus,
} from "../types";
import { t } from "../i18n";
import { Badge, Spinner } from "./ui";
import "./VortexTakeoverCard.css";

/**
 * 设置页「Vortex 接管」卡片。
 *
 * 排版跟随其它设置卡：panel-head 放主动作、setting-item 行式放开关、
 * 字段用 kv 网格、只读取证收进 details 折叠区。状态一律走 Badge，
 * 避免一大片裸文本平铺（2026-11-09 用户反馈）。
 *
 * 颜色语义：红色只留给真错误；未接管时的顺序差异、历史遗留需重新收编
 * 都降级为中性/黄色提示，不再一律报红。
 */
export function VortexTakeoverCard({
  onError,
}: {
  onError: (error: unknown, title?: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [preflight, setPreflight] = useState<VortexTakeoverPreflight | null>(null);
  const [health, setHealth] = useState<AdoptStagingHealth | null>(null);
  const [status, setStatus] = useState<VortexSyncStatus | null>(null);
  const [action, setAction] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [confirmName, setConfirmName] = useState<string | null>(null);
  const [p3Busy, setP3Busy] = useState(false);
  const [p3Note, setP3Note] = useState("");
  const [p3Tone, setP3Tone] = useState<"muted" | "yellow" | "cyan" | "red" | "green">(
    "muted",
  );

  const run = useCallback(async () => {
    setBusy(true);
    try {
      const [nextPreflight, nextHealth, nextStatus] = await Promise.all([
        api.vortexTakeoverPreflight(),
        api.adoptStagingHealth(),
        api.vortexSyncStatus(),
      ]);
      setPreflight(nextPreflight);
      setHealth(nextHealth);
      setStatus(nextStatus);
    } catch (error) {
      onError(error, t("vortexTakeover.error"));
    } finally {
      setBusy(false);
    }
  }, [onError]);

  useEffect(() => {
    void run();
  }, [run]);

  const toggle = async () => {
    if (!status) return;
    setAction("toggle");
    setNote("");
    try {
      await api.vortexTakeoverSetEnabled(!status.takeoverEnabled);
      await run();
    } catch (error) {
      onError(error, t("vortexTakeover.toggleError"));
    } finally {
      setAction(null);
    }
  };

  const retry = async () => {
    setAction("retry");
    setNote("");
    try {
      const report = await api.vortexSyncRetry();
      // 之前无条件显示「重试完成」，接管没开 / 队列空时也报成功，属假成功。
      setNote(
        report.ok
          ? report.written > 0
            ? t("vortexTakeover.retryDone")
            : t("vortexTakeover.pendingNone")
          : report.reason || t("vortexTakeover.syncError"),
      );
      await run();
    } catch (error) {
      onError(error, t("vortexTakeover.syncError"));
    } finally {
      setAction(null);
    }
  };

  const restore = async (name: string) => {
    setAction("restore");
    setNote("");
    setConfirmName(null);
    try {
      const count = await api.vortexSyncRestore(name);
      setNote(t("vortexTakeover.restored", { count }));
      await run();
    } catch (error) {
      onError(error, t("vortexTakeover.syncError"));
    } finally {
      setAction(null);
    }
  };

  type P3Result = {
    text: string;
    tone: "muted" | "yellow" | "cyan" | "red" | "green";
  };

  const runP3 = async (task: () => Promise<P3Result>) => {
    setP3Busy(true);
    setP3Note("");
    try {
      const result = await task();
      setP3Note(result.text);
      setP3Tone(result.tone);
      await run();
    } catch (error) {
      onError(error, t("vortexTakeover.p3Error"));
    } finally {
      setP3Busy(false);
    }
  };

  const remap = () =>
    runP3(async () => {
      const r = await api.vortexMappingRebuild();
      return {
        text: t("vortexTakeover.mapDone", {
          mapped: r.mapped,
          total: r.total,
          persisted: r.persisted,
        }),
        tone: r.unmapped > 0 ? "yellow" : "green",
      };
    });

  const fullSync = () =>
    runP3(async () => {
      const r = await api.vortexSyncFull();
      return r.ok
        ? { text: t("vortexTakeover.fullDone", { count: r.written }), tone: "green" as const }
        : {
            text: t("vortexTakeover.fullSkipped", { reason: r.reason }),
            tone: "yellow" as const,
          };
    });

  const doReconcile = () =>
    runP3(async () => {
      const r = await api.vortexReconcile("report");
      const text = t("vortexTakeover.reconcileDone", {
        checked: r.checked,
        drift: r.drift.length,
      });
      return {
        text: r.applied > 0 ? `${text} · ${t("vortexTakeover.applied", { count: r.applied })}` : text,
        tone: r.drift.length > 0 ? "yellow" : "green",
      };
    });

  const precheck = () =>
    runP3(async () => {
      const r = await api.vortexPrelaunchCheck();
      return {
        text: r.ready
          ? t("vortexTakeover.precheckReady")
          : t("vortexTakeover.precheckBlocked", {
              reason: r.warnings.join("；"),
            }),
        tone: r.ready ? "green" : "yellow",
      };
    });

  const label = (enabled: boolean) =>
    enabled ? t("vortexTakeover.enabledOn") : t("vortexTakeover.enabledOff");
  const drift = preflight?.drift ?? [];
  const warnings = [...(preflight?.warnings ?? []), ...(health?.warnings ?? [])];
  const orphanMb = ((health?.orphanBytes ?? 0) / 1024 / 1024).toFixed(1);
  const takeoverOn = status?.takeoverEnabled ?? false;
  const hasLastSync =
    !!status &&
    (status.lastSync.ok || status.lastSync.written > 0 || !!status.lastSync.reason);
  const syncTone = !hasLastSync ? "muted" : status?.lastSync.ok ? "green" : "red";
  const orderTone = !takeoverOn
    ? "muted"
    : preflight?.archiveOrderSame
      ? "green"
      : "red";
  const orderText = !takeoverOn
    ? t("vortexTakeover.stateIndependent")
    : preflight?.archiveOrderSame
      ? t("vortexTakeover.orderSame")
      : t("vortexTakeover.orderDiff");

  return (
    <section className="panel vortex-takeover-card">
      <header className="panel-head">
        <div>
          <div className="panel-eyebrow">{t("vortexTakeover.eyebrow")}</div>
          <h2>{t("vortexTakeover.title")}</h2>
        </div>
        <div className="settings-field-row">
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => void run()}
            disabled={busy || action !== null}
          >
            {busy ? <Spinner size={13} /> : <RefreshCw size={13} />}
            {busy ? t("vortexTakeover.running") : t("vortexTakeover.run")}
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => void retry()}
            disabled={action !== null}
          >
            <RotateCcw size={13} />
            {t("vortexTakeover.retry")}
          </button>
        </div>
      </header>

      <p className="vortex-takeover-subtitle">{t("vortexTakeover.subtitle")}</p>

      {/* 区块 1：接管开关（与外观页「点击关闭按钮时」同款行式二选一） */}
      <div className="vortex-block">
        <div className="vortex-block-head">
          <span className="setting-item-label">{t("vortexTakeover.toggleLabel")}</span>
          <Badge tone={takeoverOn ? "green" : "muted"}>
            {takeoverOn ? t("vortexTakeover.badgeOn") : t("vortexTakeover.badgeOff")}
          </Badge>
        </div>
        <div className="settings-field-row">
          <button
            type="button"
            className={`btn btn-sm ${takeoverOn ? "btn-primary" : "btn-ghost"}`}
            aria-pressed={takeoverOn}
            disabled={action !== null || takeoverOn || !status}
            onClick={() => void toggle()}
          >
            {t("vortexTakeover.toggleEnable")}
          </button>
          <button
            type="button"
            className={`btn btn-sm ${takeoverOn ? "btn-ghost" : "btn-primary"}`}
            aria-pressed={!takeoverOn}
            disabled={action !== null || !takeoverOn || !status}
            onClick={() => void toggle()}
          >
            {t("vortexTakeover.toggleDisable")}
          </button>
        </div>
        <small className="setting-item-note">
          {takeoverOn ? t("vortexTakeover.toggleOn") : t("vortexTakeover.toggleOff")}
          {" · "}
          {t("vortexTakeover.scopeNote")}
        </small>
      </div>

      {/* 区块 2：同步状态（字段网格 + Badge） */}
      <div className="vortex-block">
        <div className="vortex-block-head">
          <span className="setting-item-label">{t("vortexTakeover.syncTitle")}</span>
          <Badge tone={syncTone}>
            {!hasLastSync
              ? t("vortexTakeover.lastNone")
              : status?.lastSync.ok
                ? t("vortexTakeover.badgeOk")
                : t("vortexTakeover.badgeFailed")}
          </Badge>
        </div>
        <dl className="vortex-field-grid">
          <div>
            <dt>{t("vortexTakeover.labelPending")}</dt>
            <dd>
              {status && status.pendingCount > 0
                ? t("vortexTakeover.pending", { count: status.pendingCount })
                : t("vortexTakeover.pendingNone")}
            </dd>
          </div>
          <div>
            <dt>{t("vortexTakeover.labelBackups")}</dt>
            <dd>{t("vortexTakeover.backups", { count: status?.backups.length ?? 0 })}</dd>
          </div>
          <div>
            <dt>{t("vortexTakeover.labelLast")}</dt>
            <dd className={status?.lastSync.ok ? "is-ok" : "is-warn"}>
              {!hasLastSync
                ? t("vortexTakeover.lastNone")
                : status?.lastSync.ok
                  ? t("vortexTakeover.lastOk", { count: status.lastSync.written })
                  : t("vortexTakeover.lastBad", { reason: status?.lastSync.reason ?? "" })}
            </dd>
          </div>
        </dl>
        <div className="settings-field-row">
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => setConfirmName(status?.backups[0] ?? null)}
            disabled={!status?.backups.length || action !== null}
          >
            <Undo2 size={13} />
            {t("vortexTakeover.restore")}
          </button>
        </div>
        {confirmName ? (
          <div className="vortex-takeover-confirm">
            <span>{t("vortexTakeover.restoreConfirm", { name: confirmName })}</span>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => void restore(confirmName)}
              disabled={action !== null}
            >
              {t("vortexTakeover.restoreYes")}
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => setConfirmName(null)}
            >
              {t("vortexTakeover.restoreCancel")}
            </button>
          </div>
        ) : null}
        {note ? <p className="vortex-inline-note">{note}</p> : null}
      </div>

      {/* 区块 3：只读取证（折叠，避免一大片平铺） */}
      <details className="vortex-details">
        <summary>
          <span>{t("vortexTakeover.detailsSummary")}</span>
          <Badge tone={orderTone}>{orderText}</Badge>
        </summary>

        {preflight && !preflight.available ? (
          <div className="vortex-takeover-blocked">
            <Activity size={14} />
            <span>{t("vortexTakeover.unavailable")}</span>
            <code>{preflight.reason}</code>
            {preflight.dbLocked ? (
              <small>{t("vortexTakeover.locked")}</small>
            ) : null}
          </div>
        ) : null}

        {preflight?.available ? (
          <dl className="vortex-field-grid">
            <div>
              <dt>{t("vortexTakeover.labelProfile")}</dt>
              <dd>
                {t("vortexTakeover.profile", {
                  id: preflight.activeProfileId || "—",
                  game: preflight.profileGameId || "—",
                })}
              </dd>
            </div>
            {!preflight.profileOk ? (
              <div>
                <dt>{t("vortexTakeover.labelStatus")}</dt>
                <dd className="is-warn">{t("vortexTakeover.profileBad")}</dd>
              </div>
            ) : null}
            <div>
              <dt>{t("vortexTakeover.labelMods")}</dt>
              <dd>
                {t("vortexTakeover.counts", {
                  total: preflight.vortexModCount,
                  enabled: preflight.vortexEnabledCount,
                  disabled: preflight.vortexDisabledCount,
                })}
              </dd>
            </div>
            <div>
              <dt>{t("vortexTakeover.labelOrder")}</dt>
              <dd>
                {t("vortexTakeover.order", {
                  archive: preflight.archiveOrder.length,
                  redmod: preflight.redmodOrder.length,
                })}
              </dd>
            </div>
            <div>
              <dt>{t("vortexTakeover.labelMapping")}</dt>
              <dd>
                {t("vortexTakeover.mapping", {
                  mapped: preflight.mappedModCount,
                  unmapped: preflight.unmappedModCount,
                })}
              </dd>
            </div>
            <div>
              <dt>{t("vortexTakeover.labelFingerprint")}</dt>
              <dd className="vortex-mono">{preflight.fingerprint}</dd>
            </div>
          </dl>
        ) : null}

        {preflight?.available ? (
          <div className="vortex-subblock">
            <div className="vortex-block-head">
              <span className="setting-item-label">
                {t("vortexTakeover.driftTitle", { count: drift.length })}
              </span>
              <Badge tone={drift.length ? "yellow" : "green"}>
                {drift.length
                  ? t("vortexTakeover.badgeWarn")
                  : t("vortexTakeover.badgeOk")}
              </Badge>
            </div>
            {drift.length === 0 ? (
              <small className="setting-item-note">{t("vortexTakeover.driftNone")}</small>
            ) : (
              <ul className="vortex-list">
                {drift.slice(0, 6).map((item) => (
                  <li key={item.modId}>
                    {item.vortexEnabled === null
                      ? t("vortexTakeover.driftMissing", { name: item.name })
                      : t("vortexTakeover.driftMismatch", {
                          name: item.name,
                          local: label(item.cyberdeckEnabled),
                          remote: label(item.vortexEnabled),
                        })}
                  </li>
                ))}
                {drift.length > 6 ? (
                  <li>{t("vortexTakeover.driftMore", { count: drift.length - 6 })}</li>
                ) : null}
              </ul>
            )}
          </div>
        ) : null}

        {health ? (
          <div className="vortex-subblock">
            <div className="vortex-block-head">
              <span className="setting-item-label">{t("vortexTakeover.stagingTitle")}</span>
              <Badge
                tone={
                  health.orphanDirs.length || health.missingDirs.length ? "yellow" : "green"
                }
              >
                {health.orphanDirs.length || health.missingDirs.length
                  ? t("vortexTakeover.badgeWarn")
                  : t("vortexTakeover.stagingClean")}
              </Badge>
            </div>
            <small className="setting-item-note">
              {t("vortexTakeover.stagingSummary", {
                total: health.dirsTotal,
                registered: health.registeredTotal,
              })}
            </small>
            {health.orphanDirs.length > 0 ? (
              <p className="is-warn">
                {t("vortexTakeover.stagingOrphans", {
                  count: health.orphanDirs.length,
                  bytes: `${orphanMb} MB`,
                })}
              </p>
            ) : null}
            {health.missingDirs.length > 0 ? (
              <p className="is-warn">
                {t("vortexTakeover.stateNeedRebuild", { count: health.missingDirs.length })}
              </p>
            ) : null}
          </div>
        ) : null}

        {warnings.length > 0 ? (
          <div className="vortex-subblock">
            <div className="vortex-block-head">
              <span className="setting-item-label">{t("vortexTakeover.warnings")}</span>
            </div>
            <ul className="vortex-list">
              {warnings.map((warning, index) => (
                <li key={`${index}-${warning}`}>{warning}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </details>

      {/* 区块 4：P3 批量与对账 */}
      <div className="vortex-block">
        <div className="vortex-block-head">
          <span className="setting-item-label">{t("vortexTakeover.p3Title")}</span>
          {p3Note ? (
            <Badge tone={p3Tone}>
              {p3Tone === "green"
                ? t("vortexTakeover.badgeOk")
                : p3Tone === "red"
                  ? t("vortexTakeover.badgeFailed")
                  : t("vortexTakeover.badgeWarn")}
            </Badge>
          ) : null}
        </div>
        <div className="vortex-p3-actions">
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => void remap()}
            disabled={p3Busy || action !== null}
          >
            {t("vortexTakeover.btnRemap")}
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => void fullSync()}
            disabled={p3Busy || action !== null}
          >
            {t("vortexTakeover.btnFullSync")}
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => void doReconcile()}
            disabled={p3Busy || action !== null}
          >
            {t("vortexTakeover.btnReconcile")}
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => void precheck()}
            disabled={p3Busy || action !== null}
          >
            {t("vortexTakeover.btnPrecheck")}
          </button>
        </div>
        {p3Note ? <p className="vortex-p3-note">{p3Note}</p> : null}
      </div>

      <p className="vortex-takeover-note">{t("vortexTakeover.readOnlyNote")}</p>
    </section>
  );
}
