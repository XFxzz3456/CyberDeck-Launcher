import { useCallback, useEffect, useState } from "react";
import { Activity, RefreshCw, RotateCcw, ShieldCheck } from "lucide-react";
import { api } from "../lib/api";
import type {
  AdoptStagingHealth,
  VortexTakeoverPreflight,
  VortexSyncStatus,
} from "../types";
import { t } from "../i18n";
import { Spinner } from "./ui";
import "./VortexTakeoverCard.css";

/**
 * 设置页「Vortex 接管」卡片（方案 P0 取证 + P1/P2 双写）。
 *
 * 取证永远只读；写入只由「接管开关」放行，且开关本身要先过前置校验
 * （Vortex 已退出、profile 正确）。所有双写失败都落在待同步队列与
 * 「同步状态」里，不静默；还原需二次确认。见
 * docs/ARCH-VORTEX-TAKEOVER-2026-11-09.md。
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
      await api.vortexSyncRetry();
      setNote(t("vortexTakeover.retryDone"));
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

  const label = (enabled: boolean) =>
    enabled ? t("vortexTakeover.enabledOn") : t("vortexTakeover.enabledOff");
  const drift = preflight?.drift ?? [];
  const warnings = [...(preflight?.warnings ?? []), ...(health?.warnings ?? [])];
  const orphanMb = ((health?.orphanBytes ?? 0) / 1024 / 1024).toFixed(1);
  const hasLastSync =
    !!status &&
    (status.lastSync.ok || status.lastSync.written > 0 || !!status.lastSync.reason);

  return (
    <section className="panel vortex-takeover-card">
      <header className="panel-head">
        <div>
          <div className="panel-eyebrow">{t("vortexTakeover.eyebrow")}</div>
          <h2>{t("vortexTakeover.title")}</h2>
        </div>
        <button
          className="btn btn-ghost btn-sm"
          onClick={() => void run()}
          disabled={busy}
        >
          {busy ? <Spinner size={13} /> : <RefreshCw size={13} />}
          {busy ? t("vortexTakeover.running") : t("vortexTakeover.run")}
        </button>
      </header>

      <p className="vortex-takeover-subtitle">{t("vortexTakeover.subtitle")}</p>

      {status ? (
        <div className="vortex-takeover-control">
          <label className="vortex-takeover-switch">
            <ShieldCheck size={14} />
            <input
              type="checkbox"
              checked={status.takeoverEnabled}
              onChange={() => void toggle()}
              disabled={action !== null}
            />
            <span>{t("vortexTakeover.toggleLabel")}</span>
          </label>
          <span className={status.takeoverEnabled ? "is-ok" : "is-muted"}>
            {status.takeoverEnabled
              ? t("vortexTakeover.toggleOn")
              : t("vortexTakeover.toggleOff")}
          </span>
          <p>{t("vortexTakeover.scopeNote")}</p>
        </div>
      ) : null}

      {status ? (
        <div className="vortex-takeover-section">
          <h3>{t("vortexTakeover.syncTitle")}</h3>
          <p>
            {status.pendingCount > 0
              ? t("vortexTakeover.pending", { count: status.pendingCount })
              : t("vortexTakeover.pendingNone")}
          </p>
          <p>{t("vortexTakeover.backups", { count: status.backups.length })}</p>
          {hasLastSync ? (
            <p className={status?.lastSync.ok ? "is-ok" : "is-bad"}>
              {status?.lastSync.ok
                ? t("vortexTakeover.lastOk", { count: status.lastSync.written })
                : t("vortexTakeover.lastBad", { reason: status?.lastSync.reason ?? "" })}
            </p>
          ) : (
            <p>{t("vortexTakeover.lastNone")}</p>
          )}
          <div className="vortex-takeover-actions">
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => void retry()}
              disabled={action !== null}
            >
              <RotateCcw size={13} />
              {t("vortexTakeover.retry")}
            </button>
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => setConfirmName(status.backups[0] ?? null)}
              disabled={status.backups.length === 0 || action !== null}
            >
              {t("vortexTakeover.restore")}
            </button>
          </div>
          {confirmName ? (
            <div className="vortex-takeover-confirm">
              <span>{t("vortexTakeover.restoreConfirm", { name: confirmName })}</span>
              <button
                className="btn btn-sm"
                onClick={() => void restore(confirmName)}
                disabled={action !== null}
              >
                {t("vortexTakeover.restoreYes")}
              </button>
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => setConfirmName(null)}
              >
                {t("vortexTakeover.restoreCancel")}
              </button>
            </div>
          ) : null}
          {note ? <p className="is-ok">{note}</p> : null}
        </div>
      ) : null}

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
        <dl className="vortex-takeover-facts">
          <div>
            <dt>{t("vortexTakeover.profile", {
              id: preflight.activeProfileId || "—",
              game: preflight.profileGameId || "—",
            })}</dt>
            {!preflight.profileOk ? (
              <dd className="is-bad">{t("vortexTakeover.profileBad")}</dd>
            ) : null}
          </div>
          <div>
            <dt>{t("vortexTakeover.counts", {
              total: preflight.vortexModCount,
              enabled: preflight.vortexEnabledCount,
              disabled: preflight.vortexDisabledCount,
            })}</dt>
          </div>
          <div>
            <dt>{t("vortexTakeover.order", {
              archive: preflight.archiveOrder.length,
              redmod: preflight.redmodOrder.length,
            })}</dt>
            <dd className={preflight.archiveOrderSame ? "is-ok" : "is-bad"}>
              {preflight.archiveOrderSame
                ? t("vortexTakeover.orderSame")
                : t("vortexTakeover.orderDiff")}
            </dd>
          </div>
          <div>
            <dt>{t("vortexTakeover.mapping", {
              mapped: preflight.mappedModCount,
              unmapped: preflight.unmappedModCount,
            })}</dt>
          </div>
          <div>
            <dt>{t("vortexTakeover.fingerprint", { hash: preflight.fingerprint })}</dt>
          </div>
        </dl>
      ) : null}

      {preflight?.available ? (
        <div className="vortex-takeover-section">
          <h3>{t("vortexTakeover.driftTitle", { count: drift.length })}</h3>
          {drift.length === 0 ? (
            <p>{t("vortexTakeover.driftNone")}</p>
          ) : (
            <ul>
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
        <div className="vortex-takeover-section">
          <h3>{t("vortexTakeover.stagingTitle")}</h3>
          <p>{t("vortexTakeover.stagingSummary", {
            total: health.dirsTotal,
            registered: health.registeredTotal,
          })}</p>
          {health.orphanDirs.length > 0 ? (
            <p className="is-bad">{t("vortexTakeover.stagingOrphans", {
              count: health.orphanDirs.length,
              bytes: `${orphanMb} MB`,
            })}</p>
          ) : null}
          {health.missingDirs.length > 0 ? (
            <p className="is-bad">{t("vortexTakeover.stagingMissing", {
              count: health.missingDirs.length,
            })}</p>
          ) : null}
          {health.orphanDirs.length === 0 && health.missingDirs.length === 0 ? (
            <p className="is-ok">{t("vortexTakeover.stagingClean")}</p>
          ) : null}
        </div>
      ) : null}

      {warnings.length > 0 ? (
        <div className="vortex-takeover-section">
          <h3>{t("vortexTakeover.warnings")}</h3>
          <ul>
            {warnings.map((warning, index) => (
              <li key={`${index}-${warning}`}>{warning}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <p className="vortex-takeover-note">{t("vortexTakeover.readOnlyNote")}</p>
    </section>
  );
}
