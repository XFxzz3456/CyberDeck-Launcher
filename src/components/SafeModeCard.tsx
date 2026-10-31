import { useEffect, useState } from "react";
import { ShieldAlert, ShieldCheck } from "lucide-react";
import { safetyApi, type CompatReport, type SafeModeState } from "../lib/apiSafety";
import { t } from "../i18n";
import { gameVersionLabel, versionAtLeast } from "../lib/gameVersion";
import { Badge, Modal, Spinner } from "./ui";
import "./SafetyCards.css";

/**
 * 设置页「安全模式」卡片（看板【13】A）。
 *
 * 两个操作都必须二次确认，且文案要说清「只断链接、不删文件」——这是这个功能
 * 唯一会被误解的地方。恢复失败时快照会保留，用户可以再试一次。
 */
export function SafeModeCard({
  onError,
  gameVersion,
}: {
  onError: (error: unknown, title?: string) => void;
  /** 当前绑定 exe 的文件版本（四段号）。读不到时传 null，界面走中性文案。 */
  gameVersion?: string | null;
}) {
  // 只有 ≥2.5 才谈得上「待适配 2.5」。老版本玩家（2.21 及以下）看到这句
  // 只会以为自己装了一堆过期模组，而实际上他们只是还没升级游戏。
  const atLeast25 = versionAtLeast(gameVersion, "2.5");
  const legacy = atLeast25 === false;
  const versionLabel = gameVersionLabel(gameVersion)?.label ?? null;
  const [state, setState] = useState<SafeModeState | null>(null);
  const [confirm, setConfirm] = useState<null | "enter" | "exit">(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [scan, setScan] = useState<CompatReport | null>(null);
  const [scanning, setScanning] = useState(false);

  const refresh = async () => {
    try {
      setState(await safetyApi.state());
    } catch (error) {
      onError(error, t("safemode.errorState"));
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const run = async (mode: "enter" | "exit") => {
    setBusy(true);
    setNote("");
    try {
      const result = mode === "enter" ? await safetyApi.enter() : await safetyApi.exit();
      setNote(
        mode === "enter"
          ? t("safemode.enterDone", {
              mods: result.disabledMods,
              files: result.undeployedFiles,
              failed: result.failedMods,
            })
          : t("safemode.exitDone", { mods: result.disabledMods, failed: result.failedMods }),
      );
      if (result.errors.length > 0) {
        onError(new Error(result.errors.join("\n")), t("safemode.partialTitle"));
      }
      await refresh();
    } catch (error) {
      onError(error, t("safemode.errorAction"));
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  };

  const runScan = async () => {
    setScanning(true);
    try {
      setScan(await safetyApi.scanCompat());
    } catch (error) {
      onError(error, t("compat.errorScan"));
    } finally {
      setScanning(false);
    }
  };

  const active = state?.active ?? false;

  return (
    <section className="panel safety-card">
      <header className="panel-head">
        <div>
          <div className="panel-eyebrow">
            {atLeast25 ? "// SAFE MODE / 2.5" : "// SAFE MODE"}
          </div>
          <h2>{t("safemode.title")}</h2>
        </div>
        <Badge tone={active ? "yellow" : "muted"}>
          {active ? t("safemode.badgeActive") : t("safemode.badgeIdle")}
        </Badge>
      </header>

      <p className="safety-intro">
        {legacy
          ? t("safemode.introLegacy", { version: versionLabel ?? t("safemode.versionUnknown") })
          : t("safemode.intro")}
      </p>

      <div className="safety-actions">
        <button
          className="btn btn-ghost btn-sm"
          disabled={busy || active}
          onClick={() => setConfirm("enter")}
        >
          <ShieldAlert size={13} />
          {t("safemode.enterBtn")}
        </button>
        <button
          className="btn btn-ghost btn-sm"
          disabled={busy || !active}
          onClick={() => setConfirm("exit")}
        >
          <ShieldCheck size={13} />
          {t("safemode.exitBtn")}
        </button>
        <button className="btn btn-ghost btn-sm" disabled={scanning} onClick={() => void runScan()}>
          {scanning ? <Spinner size={13} /> : null}
          {t("compat.scanBtn")}
        </button>
      </div>

      {active && state?.snapshotAt ? (
        <p className="safety-note">{t("safemode.activeNote", { at: state.snapshotAt })}</p>
      ) : null}
      {note ? <p className="safety-note">{note}</p> : null}

      {scan ? (
        <div className="compat-result">
          <p className="safety-note">
            {t("compat.summary", {
              scanned: scan.scanned,
              stale: scan.stale.length,
              warn: scan.warn.length,
              // 后端给的是 exe 四段号，展示层换成玩家说的 2.5 / 2.21。
              target: gameVersionLabel(scan.targetVersion)?.label ?? scan.targetVersion,
            })}
          </p>
          {scan.stale.length > 0 ? (
            <ul className="compat-list">
              {scan.stale.slice(0, 8).map((issue) => (
                <li key={issue.modId} className="is-stale">
                  <strong>{issue.name}</strong>
                  <span>{issue.reason}</span>
                </li>
              ))}
            </ul>
          ) : null}
          {scan.warn.length > 0 ? (
            <details className="compat-warn-block">
              <summary>{t("compat.warnToggle", { n: scan.warn.length })}</summary>
              <ul className="compat-list">
                {scan.warn.slice(0, 8).map((issue) => (
                  <li key={issue.modId} className="is-warn">
                    <strong>{issue.name}</strong>
                    <span>{issue.reason}</span>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </div>
      ) : null}

      <p className="safety-foot">{t("safemode.foot")}</p>

      <Modal
        open={confirm !== null}
        title={confirm === "enter" ? t("safemode.confirmEnterTitle") : t("safemode.confirmExitTitle")}
        eyebrow="SAFE MODE"
        onClose={() => setConfirm(null)}
        footer={
          <>
            <button className="btn btn-ghost btn-sm" onClick={() => setConfirm(null)} disabled={busy}>
              {t("common.cancel")}
            </button>
            <button
              className="btn btn-primary btn-sm"
              disabled={busy}
              onClick={() => (confirm ? void run(confirm) : undefined)}
            >
              {busy ? <Spinner size={13} /> : null}
              {confirm === "enter" ? t("safemode.enterBtn") : t("safemode.exitBtn")}
            </button>
          </>
        }
      >
        <p className="safety-confirm-text">
          {confirm === "enter" ? t("safemode.confirmEnterBody") : t("safemode.confirmExitBody")}
        </p>
      </Modal>
    </section>
  );
}
