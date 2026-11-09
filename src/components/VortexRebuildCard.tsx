import { useCallback, useEffect, useState } from "react";
import { Database, RefreshCw, Undo2 } from "lucide-react";
import { api } from "../lib/api";
import type { VortexRebuildPreview, VortexRebuildReport } from "../types";
import { t } from "../i18n";
import { Badge, Spinner } from "./ui";
import "./VortexTakeoverCard.css";

type Tone = "muted" | "yellow" | "cyan" | "red" | "green";
type Confirmation = { kind: "apply" } | { kind: "restore"; name: string };

/**
 * 设置页「以 Vortex 为准重建模组库」卡片（P4）。
 *
 * 这是会改用户库的操作，交互上分三道：只读预览 → 显式确认 → 执行；
 * 执行后始终给出整库备份路径与一键还原入口。排版复用 VortexTakeoverCard
 * 的行式卡片语言，红色只留给真错误，注意事项一律黄色/中性。
 */
export function VortexRebuildCard({
  onError,
}: {
  onError: (error: unknown, title?: string) => void;
}) {
  const [plan, setPlan] = useState<VortexRebuildPreview | null>(null);
  const [report, setReport] = useState<VortexRebuildReport | null>(null);
  const [backups, setBackups] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<Confirmation | null>(null);
  const [note, setNote] = useState("");
  const [tone, setTone] = useState<Tone>("muted");

  const loadBackups = useCallback(async () => {
    try {
      setBackups(await api.vortexRebuildBackups());
    } catch (error) {
      onError(error, t("vortexRebuild.error"));
    }
  }, [onError]);

  const preview = useCallback(async () => {
    setBusy(true);
    try {
      setPlan(await api.vortexRebuildPreview());
    } catch (error) {
      onError(error, t("vortexRebuild.error"));
    } finally {
      setBusy(false);
    }
  }, [onError]);

  useEffect(() => {
    void preview();
    void loadBackups();
  }, [preview, loadBackups]);

  const apply = useCallback(async () => {
    setConfirm(null);
    setBusy(true);
    try {
      const result = await api.vortexRebuildApply();
      setReport(result);
      if (result.ok) {
        setTone("green");
        setNote(
          t("vortexRebuild.done", {
            added: result.added,
            archived: result.archived,
            mapping: result.mapping,
          }),
        );
      } else {
        setTone("red");
        setNote(t("vortexRebuild.failed", { reason: result.reason }));
      }
      await Promise.all([preview(), loadBackups()]);
    } catch (error) {
      setTone("red");
      setNote(t("vortexRebuild.applyError"));
      onError(error, t("vortexRebuild.applyError"));
    } finally {
      setBusy(false);
    }
  }, [onError, preview, loadBackups]);

  const restore = useCallback(
    async (name: string) => {
      setConfirm(null);
      setBusy(true);
      try {
        const result = await api.vortexRebuildRestore(name);
        setReport(result);
        if (result.ok) {
          setTone("green");
          setNote(t("vortexRebuild.restoreDone", { count: result.added }));
        } else {
          setTone("red");
          setNote(t("vortexRebuild.failed", { reason: result.reason }));
        }
        await Promise.all([preview(), loadBackups()]);
      } catch (error) {
        setTone("red");
        setNote(t("vortexRebuild.restoreError"));
        onError(error, t("vortexRebuild.restoreError"));
      } finally {
        setBusy(false);
      }
    },
    [onError, preview, loadBackups],
  );

  const ready = plan?.available === true;
  const shown = plan?.items.slice(0, 12) ?? [];
  const hidden = Math.max(0, (plan?.items.length ?? 0) - shown.length);

  return (
    <section className="panel vortex-takeover-card">
      <header className="panel-head">
        <div>
          <div className="panel-eyebrow">{t("vortexRebuild.eyebrow")}</div>
          <h2>{t("vortexRebuild.title")}</h2>
        </div>
        <div className="settings-field-row">
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => void preview()}
            disabled={busy || confirm !== null}
          >
            {busy ? <Spinner size={13} /> : <RefreshCw size={13} />}
            {busy ? t("vortexRebuild.previewing") : t("vortexRebuild.preview")}
          </button>
        </div>
      </header>

      <p className="vortex-takeover-subtitle">{t("vortexRebuild.subtitle")}</p>

      {plan ? (
        <div className="vortex-block">
          <div className="vortex-block-head">
            <span className="setting-item-label">{t("vortexRebuild.metadataTitle")}</span>
            <Badge tone={ready ? "green" : "red"}>
              {ready
                ? t("vortexRebuild.badgeReady")
                : t("vortexRebuild.badgeBlocked")}
            </Badge>
          </div>

          {!ready ? (
            <p className="vortex-p3-note">
              {t("vortexRebuild.unavailable", { reason: plan.reason })}
            </p>
          ) : null}

          <dl className="vortex-field-grid">
            <div>
              <dt>{t("vortexRebuild.dataDir")}</dt>
              <dd className="vortex-mono">{plan.dataDir}</dd>
            </div>
            <div>
              <dt>{t("vortexRebuild.vortexRoot")}</dt>
              <dd className="vortex-mono">{plan.vortexRoot}</dd>
            </div>
            <div>
              <dt>{t("vortexRebuild.dirs")}</dt>
              <dd>{plan.vortexDirs}</dd>
            </div>
            <div>
              <dt>{t("vortexRebuild.current")}</dt>
              <dd>{plan.currentMods}</dd>
            </div>
            <div>
              <dt>{t("vortexRebuild.archived")}</dt>
              <dd>{plan.toArchive}</dd>
            </div>
            <div>
              <dt>{t("vortexRebuild.coverage")}</dt>
              <dd>{plan.mappingCoverage}</dd>
            </div>
            <div>
              <dt>{t("vortexRebuild.enabled")}</dt>
              <dd>
                {plan.enabledCount} / {plan.disabledCount}
              </dd>
            </div>
            <div>
              <dt>{t("vortexRebuild.metadataTitle")}</dt>
              <dd>
                {t("vortexRebuild.metadata", {
                  desc: plan.withDescription,
                  pic: plan.withPicture,
                  nexus: plan.withNexus,
                  full: plan.metadataComplete,
                })}
              </dd>
            </div>
          </dl>

          <details className="vortex-details">
            <summary>
              <span>{t("vortexRebuild.sourcesTitle", { count: plan.dataSources.length })}</span>
            </summary>
            <div className="vortex-subblock">
              <ul className="vortex-list">
                {plan.dataSources.map((source) => (
                  <li key={source} className="vortex-mono">
                    {source}
                  </li>
                ))}
              </ul>
            </div>
          </details>

          {plan.warnings.length > 0 ? (
            <details className="vortex-details" open>
              <summary>
                <span>{t("vortexRebuild.warningsTitle", { count: plan.warnings.length })}</span>
              </summary>
              <div className="vortex-subblock">
                <ul className="vortex-list is-warn">
                  {plan.warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              </div>
            </details>
          ) : null}

          {plan.uncoveredArchives.length > 0 ? (
            <details className="vortex-details">
              <summary>
                <span>
                  {t("vortexRebuild.uncoveredTitle", {
                    count: plan.uncoveredArchives.length,
                  })}
                </span>
              </summary>
              <div className="vortex-subblock">
                <p>{t("vortexRebuild.uncoveredNote")}</p>
                <ul className="vortex-list">
                  {plan.uncoveredArchives.slice(0, 30).map((name) => (
                    <li key={name} className="vortex-mono">
                      {name}
                    </li>
                  ))}
                </ul>
              </div>
            </details>
          ) : null}

          <details className="vortex-details">
            <summary>
              <span>{t("vortexRebuild.itemsTitle", { count: plan.items.length })}</span>
            </summary>
            <div className="vortex-subblock">
              <ul className="vortex-list">
                {shown.map((item) => (
                  <li key={item.dirName}>
                    {t("vortexRebuild.itemLine", {
                      name: item.name,
                      files: item.fileCount,
                      version: item.version ?? "—",
                      category: item.category,
                    })}
                  </li>
                ))}
                {hidden > 0 ? (
                  <li>{t("vortexRebuild.itemMore", { count: hidden })}</li>
                ) : null}
              </ul>
            </div>
          </details>

          <div className="vortex-p3-actions">
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => setConfirm({ kind: "apply" })}
              disabled={!ready || busy || confirm !== null}
            >
              <Database size={13} />
              {busy ? t("vortexRebuild.applying") : t("vortexRebuild.apply")}
            </button>
          </div>

          {confirm?.kind === "apply" ? (
            <div className="vortex-takeover-confirm">
              <strong>{t("vortexRebuild.confirmTitle")}</strong>
              <span>
                {t("vortexRebuild.confirmBody", {
                  current: plan.currentMods,
                  add: plan.toAdd,
                  dir: plan.dataDir,
                })}
              </span>
              <div className="settings-field-row">
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => setConfirm(null)}
                >
                  {t("vortexRebuild.confirmCancel")}
                </button>
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={() => void apply()}
                >
                  {t("vortexRebuild.confirmOk")}
                </button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {note ? (
        <div className="vortex-block">
          <div className="vortex-block-head">
            <Badge tone={tone}>{note}</Badge>
          </div>
          {report?.ok ? (
            <dl className="vortex-field-grid">
              <div>
                <dt>{t("vortexRebuild.backup")}</dt>
                <dd className="vortex-mono">{report.backupPath}</dd>
              </div>
              <div>
                <dt>{t("vortexRebuild.report")}</dt>
                <dd className="vortex-mono">{report.reportPath}</dd>
              </div>
            </dl>
          ) : null}
        </div>
      ) : null}

      <div className="vortex-block">
        <div className="vortex-block-head">
          <span className="setting-item-label">{t("vortexRebuild.restoreSection")}</span>
          <Badge tone="muted">{backups.length}</Badge>
        </div>
        {backups.length === 0 ? (
          <p className="vortex-p3-note">{t("vortexRebuild.backupsNone")}</p>
        ) : (
          <div className="vortex-subblock">
            <ul className="vortex-list">
              {backups.slice(0, 6).map((name) => (
                <li key={name}>
                  <span className="vortex-mono">{name}</span>{" "}
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => setConfirm({ kind: "restore", name })}
                    disabled={busy || confirm !== null}
                  >
                    <Undo2 size={12} />
                    {busy ? t("vortexRebuild.restoring") : t("vortexRebuild.restore")}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        {confirm?.kind === "restore" ? (
          <div className="vortex-takeover-confirm">
            <strong>{t("vortexRebuild.restoreConfirm")}</strong>
            <span>{t("vortexRebuild.restoreBody", { name: confirm.name })}</span>
            <div className="settings-field-row">
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => setConfirm(null)}
              >
                {t("vortexRebuild.confirmCancel")}
              </button>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={() => void restore(confirm.name)}
              >
                {t("vortexRebuild.restore")}
              </button>
            </div>
          </div>
        ) : null}
      </div>

      <p className="vortex-takeover-note">{t("vortexRebuild.readOnlyNote")}</p>
    </section>
  );
}
