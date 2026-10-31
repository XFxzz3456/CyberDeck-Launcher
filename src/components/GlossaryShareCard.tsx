import { useEffect, useState } from "react";
import { CloudDownload, FileDown, FileUp, RefreshCw } from "lucide-react";
import { glossaryApi, type GlossaryStatus } from "../lib/apiGlossary";
import { t } from "../i18n";
import { SwitchRow } from "./ui";
import "./GlossaryShareCard.css";

/**
 * 设置页「汉化词表」卡片（看板【7】）。
 *
 * 只共享名称译文：词表按 `mod_id + 原文哈希` 存放，Mod 更新后原文一变就失配，
 * 不会把旧译文套到新版本上。本地译文（含手动改过的）永远优先，云端只能补空缺。
 */
export function GlossaryShareCard({
  onError,
}: {
  onError: (error: unknown, title?: string) => void;
}) {
  const [status, setStatus] = useState<GlossaryStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [remoteUrl, setRemoteUrl] = useState("");

  const refresh = async () => {
    try {
      const next = await glossaryApi.status();
      setStatus(next);
      setRemoteUrl(next.remoteUrl);
    } catch (error) {
      onError(error, t("glossary.errorStatus"));
    }
  };

  useEffect(() => {
    void refresh();
    // 只在挂载时取一次；后续变更都由本卡片自己的操作触发刷新。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const run = async (key: string, task: () => Promise<string>) => {
    setBusy(key);
    setNote("");
    try {
      setNote(await task());
      await refresh();
    } catch (error) {
      onError(error, t("glossary.errorAction"));
    } finally {
      setBusy(null);
    }
  };

  const toggleShare = async (enabled: boolean) => {
    setBusy("toggle");
    try {
      await glossaryApi.setConfig(enabled, remoteUrl);
      setStatus((prev) => (prev ? { ...prev, enabled } : prev));
      setNote(enabled ? t("glossary.shareOn") : t("glossary.shareOff"));
    } catch (error) {
      onError(error, t("glossary.errorAction"));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="panel glossary-panel">
      <header className="panel-head">
        <div>
          <div className="panel-eyebrow">// GLOSSARY / SHARED</div>
          <h2>{t("glossary.title")}</h2>
        </div>
        <div className="glossary-counts">
          <span>{t("glossary.countTotal", { n: status?.entries ?? 0 })}</span>
          <span className="glossary-count-split">
            {t("glossary.countSplit", { local: status?.local ?? 0, cloud: status?.cloud ?? 0 })}
          </span>
        </div>
      </header>

      <p className="glossary-intro">{t("glossary.intro")}</p>

      <SwitchRow
        title={t("glossary.shareTitle")}
        description={t("glossary.shareDesc")}
        checked={status?.enabled ?? false}
        disabled={busy !== null}
        onChange={(next) => void toggleShare(next)}
      />

      <div className="settings-field glossary-field">
        <span>{t("glossary.remoteLabel")}</span>
        <div className="settings-field-row">
          <input
            value={remoteUrl}
            onChange={(event) => setRemoteUrl(event.target.value)}
            onBlur={() => {
              if (remoteUrl.trim() !== (status?.remoteUrl ?? "")) {
                void glossaryApi
                  .setConfig(status?.enabled ?? false, remoteUrl)
                  .then(refresh)
                  .catch((error) => onError(error, t("glossary.errorAction")));
              }
            }}
            placeholder="https://example.com/cyberdeck-glossary.json"
            spellCheck={false}
          />
          <button
            className="btn btn-ghost btn-sm"
            disabled={busy !== null || !status?.enabled}
            onClick={() =>
              void run("sync", async () => {
                const merged = await glossaryApi.syncRemote();
                return t("glossary.syncDone", {
                  added: merged.added,
                  conflicts: merged.conflicts,
                });
              })
            }
          >
            {busy === "sync" ? <RefreshCw size={13} className="spin" /> : <CloudDownload size={13} />}
            {t("glossary.syncBtn")}
          </button>
        </div>
        <small>{t("glossary.remoteHint")}</small>
      </div>

      <div className="glossary-actions">
        <button
          className="btn btn-ghost btn-sm"
          disabled={busy !== null}
          onClick={() =>
            void run("export", async () => {
              const path = await glossaryApi.exportPack();
              return t("glossary.exportDone", { path });
            })
          }
        >
          <FileDown size={13} />
          {t("glossary.exportBtn")}
        </button>
        <button
          className="btn btn-ghost btn-sm"
          disabled={busy !== null}
          onClick={() =>
            void run("import", async () => {
              const picked = await pickJson();
              if (!picked) return t("glossary.cancelled");
              const merged = await glossaryApi.importPack(picked);
              return t("glossary.importDone", {
                added: merged.added,
                conflicts: merged.conflicts,
              });
            })
          }
        >
          <FileUp size={13} />
          {t("glossary.importBtn")}
        </button>
      </div>

      {note ? <p className="glossary-note">{note}</p> : null}
      <p className="glossary-foot">{t("glossary.foot")}</p>
    </section>
  );
}

/** 只挑 .json：词表包与配置文件同名后缀，用户能自己分清。 */
async function pickJson(): Promise<string | null> {
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({
      multiple: false,
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    return typeof picked === "string" ? picked : null;
  } catch {
    return null;
  }
}
