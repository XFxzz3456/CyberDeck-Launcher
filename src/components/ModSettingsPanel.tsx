import { useEffect, useMemo, useState } from "react";
import {
  ChevronDown,
  FileCog,
  FolderOpen,
  Save,
  SlidersHorizontal,
} from "lucide-react";
import type { ModConfigField, ModConfigView, ModEntry } from "../types";
import { api } from "../lib/api";
import { compactPath } from "../lib/format";
import { t } from "../i18n";
import { Spinner, Toggle } from "./ui";

/** 草稿键：同一个 key 在不同来源/分区里可能重名，必须三段一起当身份。 */
function draftKey(sourceId: string, field: ModConfigField): string {
  return `${sourceId}\u0000${field.section}\u0000${field.key}`;
}

/** JSON 来源没有 section，按 key 的第一段分组（`audio.volume` → audio）。 */
function groupOf(field: ModConfigField): string {
  if (field.section) return field.section;
  const head = field.key.split(".")[0];
  return field.key.includes(".") ? head : "";
}

function isOn(value: string): boolean {
  return value.trim().toLowerCase() === "true";
}

/**
 * 详情抽屉里的「专属配置」。
 *
 * 只展示**这个模组自己拥有**的配置：后端按框架把 user.ini 的对应 section、
 * Mod 目录下的 json、AudioXL 的 ini 解析出来，找不到就是空——不给玩家造选项。
 *
 * 写入永远是 patch：保存时只把动过的字段逐条发回后端，后端只改那一行/那一个键，
 * 因此多个模组共用一份 user.ini 时不会互相冲掉设置。
 */
export function ModSettingsPanel({
  mod,
  onToast,
  onError,
  onOpenPath,
}: {
  mod: ModEntry;
  onToast: (tone: "ok" | "error" | "info" | "warn", title: string, message?: string) => void;
  onError: (error: unknown, title?: string) => void;
  onOpenPath?: (path: string) => void;
}) {
  const [data, setData] = useState<ModConfigView | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [open, setOpen] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setData(null);
    api
      .getModConfig(mod.id)
      .then((next) => {
        if (cancelled) return;
        const initial: Record<string, string> = {};
        for (const source of next.sources) {
          for (const field of source.fields) initial[draftKey(source.id, field)] = field.value;
        }
        setData(next);
        setDrafts(initial);
        setSaved(initial);
      })
      .catch((error) => {
        if (!cancelled) onError(error, t("modSettings.loadFailed"));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // 抽屉换模组就重读：mod.id 是这个面板的全部身份。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mod.id]);

  const editableSources = useMemo(
    () => (data?.sources ?? []).filter((source) => source.editable),
    [data],
  );

  const dirty = useMemo(() => {
    const keys = Object.keys(drafts).filter((key) => drafts[key] !== saved[key]);
    return keys;
  }, [drafts, saved]);

  /** 顶部摘要：几个来源、多少项。空配置时前端不渲染这一行。 */
  const totalFields = useMemo(
    () => (data?.sources ?? []).reduce((sum, source) => sum + source.fields.length, 0),
    [data],
  );

  const save = async () => {
    if (!data || dirty.length === 0) return;
    setSaving(true);
    let next: ModConfigView | null = null;
    try {
      // 逐条 patch：后端只认「哪个来源的哪个 key」，不做整文件替换。
      for (const source of data.sources) {
        for (const field of source.fields) {
          const key = draftKey(source.id, field);
          if (drafts[key] === saved[key]) continue;
          next = await api.saveConfigField(
            mod.id,
            source.id,
            field.section,
            field.key,
            drafts[key],
          );
        }
      }
      if (next) {
        const initial: Record<string, string> = {};
        for (const source of next.sources) {
          for (const field of source.fields) initial[draftKey(source.id, field)] = field.value;
        }
        setData(next);
        setDrafts(initial);
        setSaved(initial);
      }
      onToast("ok", t("modSettings.savedTitle"), t("modSettings.savedMessage"));
    } catch (error) {
      onError(error, t("modSettings.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  const hasSources = (data?.sources.length ?? 0) > 0;
  const hasWarnings = (data?.warnings.length ?? 0) > 0;

  return (
    <div className="drawer-section mod-config">
      <div className="drawer-section-head">
        <h3>
          <SlidersHorizontal size={13} /> {t("modSettings.title")}
        </h3>
        <div className="mod-config-head-right">
          {hasSources ? (
            <span>{t("modSettings.fieldCount", { count: totalFields })}</span>
          ) : null}
          <button
            className="icon-btn mod-config-fold"
            aria-expanded={open}
            aria-label={open ? t("modSettings.collapse") : t("modSettings.expand")}
            onClick={() => setOpen((value) => !value)}
          >
            <ChevronDown size={14} className={open ? "is-open" : ""} />
          </button>
        </div>
      </div>

      {open ? (
        <>
          {loading ? (
            <div className="mod-config-state">
              <Spinner size={16} /> {t("modSettings.loading")}
            </div>
          ) : null}

          {/* 解析失败 / 读不出来：平静说明，不弹警告。 */}
          {!loading && hasWarnings ? (
            <div className="mod-config-state">
              <FileCog size={15} />
              <div>
                <strong>{t("modSettings.noFileTitle")}</strong>
                <p>{data?.warnings[0]}</p>
              </div>
            </div>
          ) : null}

          {/* 没有可调参数：这是正常状态，不是错误。 */}
          {!loading && !hasWarnings && !hasSources ? (
            <div className="mod-config-state">
              <FileCog size={15} />
              <div>
                <strong>{t("modSettings.emptyTitle")}</strong>
                <p>{t("modSettings.emptyDetail")}</p>
              </div>
            </div>
          ) : null}

          {!loading && hasSources
            ? data!.sources.map((source) => {
                const groups = new Map<string, ModConfigField[]>();
                for (const field of source.fields) {
                  const name = groupOf(field);
                  const list = groups.get(name) ?? [];
                  list.push(field);
                  groups.set(name, list);
                }
                return (
                  <div className="mod-config-source" key={source.id}>
                    <div className="mod-config-source-head">
                      <span className="mod-config-source-name">{source.label}</span>
                      <span className={`mod-config-tag ${source.editable ? "" : "is-readonly"}`}>
                        {source.format.toUpperCase()}
                        {source.editable ? "" : ` · ${t("modSettings.readOnly")}`}
                      </span>
                      {onOpenPath ? (
                        <button
                          className="mini-btn"
                          title={t("modSettings.reveal")}
                          onClick={() => onOpenPath(source.path)}
                        >
                          <FolderOpen size={12} />
                        </button>
                      ) : null}
                    </div>
                    <code className="mod-config-path" title={source.path}>
                      {compactPath(source.path, 56)}
                    </code>

                    {[...groups.entries()].map(([name, fields]) => (
                      <div className="mod-config-group" key={`${source.id}-${name}`}>
                        {name ? <div className="mod-config-group-name">{name}</div> : null}
                        {fields.map((field) => {
                          const key = draftKey(source.id, field);
                          const value = drafts[key] ?? field.value;
                          const changed = value !== saved[key];
                          return (
                            <div
                              className={`setting-row ${changed ? "is-dirty" : ""} ${
                                source.editable ? "" : "is-readonly"
                              }`}
                              key={key}
                            >
                              <div className="setting-label">
                                <strong>{field.label}</strong>
                                <span>{field.key.replace(/^.*\./, "")}</span>
                              </div>
                              <div className="setting-control">
                                {field.kind === "bool" ? (
                                  <Toggle
                                    checked={isOn(value)}
                                    onChange={(next) =>
                                      setDrafts((current) => ({
                                        ...current,
                                        [key]: next ? "true" : "false",
                                      }))
                                    }
                                    label={field.label}
                                    disabled={!source.editable}
                                  />
                                ) : (
                                  <input
                                    className={`setting-input ${
                                      field.kind === "number" ? "setting-number" : ""
                                    }`}
                                    type={field.kind === "number" ? "number" : "text"}
                                    step={field.kind === "number" ? "any" : undefined}
                                    value={value}
                                    readOnly={!source.editable}
                                    onChange={(event) =>
                                      setDrafts((current) => ({
                                        ...current,
                                        [key]: event.target.value,
                                      }))
                                    }
                                    aria-label={field.label}
                                    spellCheck={false}
                                  />
                                )}
                                {changed ? <span className="setting-dirty">UNSAVED</span> : null}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    ))}

                    {source.note ? <p className="mod-config-note">{source.note}</p> : null}
                  </div>
                );
              })
            : null}

          {hasSources && editableSources.length > 0 ? (
            <div className="mod-config-actions">
              <span className="mod-config-dirty">
                {dirty.length > 0 ? t("modSettings.dirty", { count: dirty.length }) : t("modSettings.synced")}
              </span>
              <button
                className="btn btn-primary btn-sm"
                onClick={() => void save()}
                disabled={saving || dirty.length === 0}
              >
                {saving ? <Spinner size={13} /> : <Save size={13} />} {t("modSettings.saveChanges")}
              </button>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
