import { useCallback, useEffect, useRef, useState } from "react";
import { Pin, PinOff, Plus, Terminal, Trash2, X } from "lucide-react";
import { api } from "../lib/api";
import type { ExternalToolEntry } from "../types";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Spinner } from "./ui";
import { t } from "../i18n";

type Props = {
  onError: (error: unknown, fallback: string) => void;
};

/**
 * 外部工具链管理器（deepseek 任务·模块三）。
 * 列表/增删改/启动全部走后端 external_tool_* 命令；固定到侧栏 = entry.pinned。
 */
export function ExternalToolsCard({ onError }: Props) {
  const [tools, setTools] = useState<ExternalToolEntry[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [draftPath, setDraftPath] = useState("");
  const [draftIcon, setDraftIcon] = useState("");
  const [note, setNote] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const list = await api.externalToolsList();
      setTools(list);
    } catch (error) {
      onError(error, t("tools.loadFailed"));
      setTools([]);
    }
  }, [onError, t]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const flashTimerRef = useRef<number | null>(null);
  useEffect(() => () => {
    if (flashTimerRef.current !== null) window.clearTimeout(flashTimerRef.current);
  }, []);
  const flash = (message: string) => {
    setNote(message);
    if (flashTimerRef.current !== null) window.clearTimeout(flashTimerRef.current);
    flashTimerRef.current = window.setTimeout(() => {
      flashTimerRef.current = null;
      setNote((current) => (current === message ? null : current));
    }, 2600);
  };

  /** 列表变更后广播，让 App 侧栏的固定工具区同步刷新。 */
  const notifyToolsChanged = () => {
    window.dispatchEvent(new CustomEvent("cdl.tools-changed"));
  };

  const pickExe = async () => {
    try {
      const picked = await openDialog({
        directory: false,
        multiple: false,
        title: t("tools.pickExeTitle"),
        filters: [{ name: t("settings.executableFilter"), extensions: ["exe"] }],
      });
      if (typeof picked !== "string" || !picked) return;
      setDraftPath(picked);
      // 名字留空时用文件名兜底（后端也会兜底，这里提前回显体验更好）。
      if (!draftName.trim()) {
        const base = picked.split(/[\\/]/).pop() ?? "";
        setDraftName(base.replace(/\.exe$/i, ""));
      }
    } catch (error) {
      onError(error, t("tools.pickExeFailed"));
    }
  };

  const submitAdd = async () => {
    if (!draftPath.trim()) return;
    setBusy(true);
    try {
      const list = await api.externalToolAdd(draftName.trim() || draftPath, draftPath.trim(), draftIcon.trim() || undefined);
      setTools(list);
      notifyToolsChanged();
      setAdding(false);
      setDraftName("");
      setDraftPath("");
      setDraftIcon("");
      flash(t("tools.added"));
    } catch (error) {
      onError(error, t("tools.addFailed"));
    } finally {
      setBusy(false);
    }
  };

  const togglePin = async (entry: ExternalToolEntry) => {
    try {
      const list = await api.externalToolUpdate(entry.id, { pinned: !entry.pinned });
      setTools(list);
      notifyToolsChanged();
    } catch (error) {
      onError(error, t("tools.updateFailed"));
    }
  };

  const remove = async (entry: ExternalToolEntry) => {
    try {
      const list = await api.externalToolRemove(entry.id);
      setTools(list);
      notifyToolsChanged();
      flash(t("tools.removed", { name: entry.name }));
    } catch (error) {
      onError(error, t("tools.removeFailed"));
    }
  };

  const launch = async (entry: ExternalToolEntry) => {
    try {
      await api.externalToolLaunch(entry.id);
      flash(t("tools.launched", { name: entry.name }));
    } catch (error) {
      onError(error, t("tools.launchFailed"));
    }
  };

  return (
    <section className="panel settings-card" data-testid="external-tools-card">
      <div className="panel-head">
        <div>
          <div className="panel-eyebrow">// EXTERNAL TOOLS</div>
          <h2>{t("tools.cardTitle")}</h2>
        </div>
        <button
          className="btn btn-ghost btn-sm"
          onClick={() => setAdding((current) => !current)}
          aria-expanded={adding}
        >
          {adding ? <X size={13} /> : <Plus size={13} />} {adding ? t("common.cancel") : t("tools.addBtn")}
        </button>
      </div>
      <p className="panel-note">{t("tools.cardDesc")}</p>

      {adding ? (
        <div className="tool-add-form">
          <div className="settings-field">
            <span>{t("tools.nameLabel")}</span>
            <input
              value={draftName}
              onChange={(event) => setDraftName(event.target.value)}
              placeholder={t("tools.namePlaceholder")}
              maxLength={48}
              spellCheck={false}
            />
          </div>
          <div className="settings-field">
            <span>{t("tools.pathLabel")}</span>
            <div className="settings-field-row">
              <code className="dl-dir-value" title={draftPath || undefined}>
                {draftPath || t("tools.pathPlaceholder")}
              </code>
              <button className="btn btn-ghost btn-sm" onClick={() => void pickExe()}>
                {t("tools.pickBtn")}
              </button>
            </div>
          </div>
          <div className="settings-field">
            <span>{t("tools.iconLabel")}</span>
            <input
              value={draftIcon}
              onChange={(event) => setDraftIcon(event.target.value)}
              placeholder={t("tools.iconPlaceholder")}
              maxLength={4}
            />
          </div>
          <div className="tool-add-actions">
            <button
              className="btn btn-primary btn-sm"
              disabled={busy || !draftPath.trim()}
              onClick={() => void submitAdd()}
            >
              {t("tools.submitAdd")}
            </button>
          </div>
        </div>
      ) : null}

      {tools === null ? (
        <Spinner />
      ) : tools.length === 0 ? (
        <p className="panel-note">{t("tools.empty")}</p>
      ) : (
        <ul className="tool-list">
          {tools.map((entry) => (
            <li key={entry.id} className="tool-row" data-testid="external-tool-row">
              <span className="tool-icon" aria-hidden="true">
                {entry.icon?.trim() ? entry.icon : entry.name.trim().charAt(0).toUpperCase() || "?"}
              </span>
              <span className="tool-copy">
                <strong>{entry.name}</strong>
                <code title={entry.path}>{entry.path}</code>
              </span>
              <span className="tool-actions">
                <button className="btn btn-primary btn-sm" onClick={() => void launch(entry)}>
                  <Terminal size={13} /> {t("tools.launchBtn")}
                </button>
                <button
                  className={`btn btn-sm ${entry.pinned ? "btn-primary" : "btn-ghost"}`}
                  onClick={() => void togglePin(entry)}
                  title={entry.pinned ? t("tools.unpinTip") : t("tools.pinTip")}
                  aria-pressed={entry.pinned}
                >
                  {entry.pinned ? <PinOff size={13} /> : <Pin size={13} />}
                </button>
                <button className="btn btn-ghost btn-sm danger-text" onClick={() => void remove(entry)}>
                  <Trash2 size={13} />
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      {note ? <small className="path-note">{note}</small> : null}
    </section>
  );
}
