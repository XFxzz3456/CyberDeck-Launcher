import { useCallback, useEffect, useState } from "react";
import { Activity, RefreshCw } from "lucide-react";
import { api } from "../lib/api";
import type { AdoptStagingHealth, VortexTakeoverPreflight } from "../types";
import { t } from "../i18n";
import { Spinner } from "./ui";
import "./VortexTakeoverCard.css";

/**
 * 设置页「Vortex 接管体检」卡片（方案 P0）。
 *
 * 这一层只有取证：读 Vortex 状态库、算指纹、列出启用状态漂移，同时体检暂存区。
 * 刻意不提供任何「同步 / 清理」按钮——写入与删除都要等 P1 单独授权，且必须在
 * Vortex 已退出、profile 校验通过、写前备份之后才允许（见
 * docs/ARCH-VORTEX-TAKEOVER-2026-11-09.md）。
 */
export function VortexTakeoverCard({
  onError,
}: {
  onError: (error: unknown, title?: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [preflight, setPreflight] = useState<VortexTakeoverPreflight | null>(null);
  const [health, setHealth] = useState<AdoptStagingHealth | null>(null);

  const run = useCallback(async () => {
    setBusy(true);
    try {
      const [nextPreflight, nextHealth] = await Promise.all([
        api.vortexTakeoverPreflight(),
        api.adoptStagingHealth(),
      ]);
      setPreflight(nextPreflight);
      setHealth(nextHealth);
    } catch (error) {
      onError(error, t("vortexTakeover.error"));
    } finally {
      setBusy(false);
    }
  }, [onError]);

  useEffect(() => {
    void run();
  }, [run]);

  const label = (enabled: boolean) =>
    enabled ? t("vortexTakeover.enabledOn") : t("vortexTakeover.enabledOff");
  const drift = preflight?.drift ?? [];
  const warnings = [...(preflight?.warnings ?? []), ...(health?.warnings ?? [])];
  const orphanMb = ((health?.orphanBytes ?? 0) / 1024 / 1024).toFixed(1);

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
