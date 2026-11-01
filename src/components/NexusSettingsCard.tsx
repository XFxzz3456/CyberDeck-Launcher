import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Crown, ExternalLink, KeyRound, Link2, RefreshCw, Trash2 } from "lucide-react";
import type { NexusStatus, NxmStatus, Settings } from "../types";
import { api } from "../lib/api";
import { notifyNexusStatusChanged, onNexusStatusChanged } from "../lib/nexusBus";
import { t } from "../i18n";
import { Badge, Spinner, SwitchRow } from "./ui";

/** 事件来源标记：自己广播的事件要跳过，避免重复拉状态。 */
const SOURCE = "settings";

export function NexusSettingsCard({
  settings,
  onSettings,
  onError,
}: {
  settings: Settings;
  onSettings: (settings: Settings) => void;
  onError: (error: unknown, title?: string) => void;
  /** 补到封面后让上层重新拉快照，卡片才会真正换图。 */
}) {
  const [status, setStatus] = useState<NexusStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  // nxm:// 协议归属：真机读注册表，浏览器预览走 mock。
  const [nxm, setNxm] = useState<NxmStatus | null>(null);
  const [nxmBusy, setNxmBusy] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      setStatus(await api.nexusStatus());
    } catch (error) {
      onError(error, t("nexusSettings.statusError"));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    void api
      .nxmStatus()
      .then(setNxm)
      .catch(() => setNxm(null));
    // 另一处（Nexus 页）连接/断开了账号，这里跟着重拉，否则卡片会一直停在旧状态。
    return onNexusStatusChanged(SOURCE, () => {
      void load();
    });
  }, []);

  const connect = async () => {
    if (!key.trim()) return;
    setBusy(true);
    try {
      setStatus(await api.setNexusKey(key.trim()));
      setKey("");
      notifyNexusStatusChanged(SOURCE);
    } catch (error) {
      onError(error, t("nexusSettings.connectFailed"));
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    setBusy(true);
    try {
      setStatus(await api.clearNexusKey());
      notifyNexusStatusChanged(SOURCE);
    } catch (error) {
      onError(error, t("nexusSettings.keyRemoveFailed"));
    } finally {
      setBusy(false);
    }
  };

  // 批量回查封面入口已挪到模组库工具栏（2026-11-01），状态与处理函数一并移除。

  const takeoverNxm = async () => {
    setNxmBusy(true);
    try {
      setNxm(await api.nxmTakeover());
    } catch (error) {
      onError(error, t("nexusSettings.nxmTakeoverFailed"));
    } finally {
      setNxmBusy(false);
    }
  };

  const releaseNxm = async () => {
    setNxmBusy(true);
    try {
      setNxm(await api.nxmRelease());
    } catch (error) {
      onError(error, t("nexusSettings.nxmReleaseFailed"));
    } finally {
      setNxmBusy(false);
    }
  };

  return (
    <section className="panel settings-card integration-card">
      <div className="panel-head">
        <div>
          <div className="panel-eyebrow">{t("nexusSettings.eyebrow")}</div>
          <h2>{t("nexusSettings.title")}</h2>
        </div>
        {loading ? (
          <Spinner size={16} />
        ) : status?.connected ? (
          <Badge tone="green">{t("nexusSettings.connected")}</Badge>
        ) : (
          <Badge tone="muted">{t("nexusSettings.notConnected")}</Badge>
        )}
      </div>

      {status?.connected ? (
        <div className="integration-account">
          <div className="integration-avatar">{status.user?.name?.slice(0, 1).toUpperCase() ?? "N"}</div>
          <div className="integration-copy">
            <strong>{status.user?.name ?? t("nexusSettings.userFallback")}</strong>
            <span>
              {status.user?.isPremium ? (
                <>
                  <Crown size={11} /> {t("nexusSettings.premiumLine")}
                </>
              ) : (
                t("nexusSettings.freeLine")
              )}
            </span>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={() => void load()}>
            <RefreshCw size={12} /> {t("common.refresh")}
          </button>
          <button className="btn btn-ghost btn-sm danger-text" onClick={() => void disconnect()} disabled={busy}>
            <Trash2 size={12} /> {t("nexusSettings.disconnect")}
          </button>
        </div>
      ) : (
        <div className="integration-connect">
          <label className="settings-field">
            <span>{t("nexusSettings.apiKeyLabel")}</span>
            <input
              type="password"
              value={key}
              onChange={(event) => setKey(event.target.value)}
              placeholder={t("nexusSettings.keyPlaceholder")}
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <button className="btn btn-primary btn-sm" onClick={() => void connect()} disabled={busy || !key.trim()}>
            {busy ? <Spinner size={13} /> : <KeyRound size={13} />} {t("nexusSettings.connect")}
          </button>
          <button
            className="btn btn-ghost btn-sm"
            onClick={() =>
              void api
                .openUrl("https://www.nexusmods.com/users/myaccount?tab=api")
                .catch((error) => onError(error, t("nexusSettings.openPageFailed")))
            }
          >
            <ExternalLink size={12} /> {t("nexusSettings.getKey")}
          </button>
        </div>
      )}

      {status?.error ? (
        <div className="inline-warning compact">
          <AlertTriangle size={13} /> {status.error}
        </div>
      ) : status?.connected ? (
        <div className="inline-ok">
          <CheckCircle2 size={13} /> {t("nexusSettings.keySavedNote")}
        </div>
      ) : null}

      {/* 补全封面入口已挪到「模组库 → 工具栏 → 补全 ▾」（用户反馈设置页太深找不到）。
          这里保留账号连接状态区，不再放重复按钮。 */}
      <div className="switch-stack integration-switch">
        <SwitchRow
          title={t("nexusSettings.hideAdult")}
          description={t("nexusSettings.hideAdultDesc")}
          checked={settings.nexusHideAdult}
          onChange={(checked) => onSettings({ ...settings, nexusHideAdult: checked })}
        />
      </div>
      <p className="panel-note">
        {t("nexusSettings.apiNote")}
      </p>

      {/* ── NXM 协议接管（计划【3】） ─────────────────────────── */}
      <div className="nxm-block">
        <div className="nxm-block-head">
          <span className="nxm-block-kicker">{t("nexusSettings.nxmKicker")}</span>
          <strong>{t("nexusSettings.nxmTitle")}</strong>
        </div>
        <p className="panel-note">
          {nxm
            ? nxm.owner === "us"
              ? t("nexusSettings.nxmOwnedUs")
              : nxm.owner === "other"
                ? t("nexusSettings.nxmOwnedOther")
                : t("nexusSettings.nxmUnregistered")
            : t("nexusSettings.nxmReading")}
        </p>
        {nxm?.handler ? (
          <code className="nxm-handler" title={t("nexusSettings.nxmHandlerTitle")}>
            {nxm.handler}
          </code>
        ) : null}
        {nxm?.backup ? (
          <p className="panel-note nxm-backup-note">
            {t("nexusSettings.backupNotePrefix")}{nxm.backupAt ?? t("nexusSettings.backupTimeUnknown")}{t("nexusSettings.backupNoteSuffix")}<code>{nxm.backup}</code>
          </p>
        ) : null}
        <div className="inline-actions">
          {nxm?.owner === "us" ? (
            <button className="btn btn-ghost btn-sm" onClick={() => void releaseNxm()} disabled={nxmBusy}>
              {nxmBusy ? <Spinner size={13} /> : <Link2 size={13} />} {t("nexusSettings.nxmRelease")}
            </button>
          ) : (
            <button className="btn btn-primary btn-sm" onClick={() => void takeoverNxm()} disabled={nxmBusy}>
              {nxmBusy ? <Spinner size={13} /> : <Link2 size={13} />} {t("nexusSettings.nxmTakeover")}
            </button>
          )}
          <button
            className="btn btn-ghost btn-sm"
            onClick={() =>
              void api
                .openUrl("https://www.nexusmods.com/cyberpunk2077")
                .catch((error) => onError(error, t("nexusSettings.openPageFailed")))
            }
          >
            <ExternalLink size={12} /> {t("nexusSettings.openNexus")}
          </button>
        </div>
        <div className="switch-stack integration-switch">
          <SwitchRow
            title={t("nexusSettings.nxmAutoDownload")}
            description={t("nexusSettings.nxmAutoDownloadDesc")}
            checked={settings.nxmAutoDownload}
            onChange={(checked) => onSettings({ ...settings, nxmAutoDownload: checked })}
          />
        </div>
      </div>
    </section>
  );
}
