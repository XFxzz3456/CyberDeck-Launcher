import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ClipboardList,
  FileArchive,
  FolderOpen,
  Save,
  Tag,
  Upload,
  X,
} from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { CATEGORIES, LAYOUT_LABEL_KEY, type InstallOutcome, type ModEntry } from "../types";
import { isTauri } from "../lib/api";
import { compactPath } from "../lib/format";
import { categoryLabel, t } from "../i18n";
import { Modal, Spinner } from "./ui";

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/** #2 集合报告：导入完成后对照现有库，给出「同名重复 / 目标重叠」两类提示。
 *  不做一键全量安装——报告只负责让用户在启用前心里有数。 */
function buildCollectionReport(
  imported: ModEntry[],
  libraryMods: ModEntry[],
): { dupes: string[]; conflicts: string[] } | null {
  if (imported.length === 0) return null;
  const importedIds = new Set(imported.map((mod) => mod.id));
  const others = libraryMods.filter((mod) => !importedIds.has(mod.id));
  if (others.length === 0) return null;

  const dupes: string[] = [];
  for (const mod of imported) {
    const match = others.find(
      (item) => item.name.trim().toLowerCase() === mod.name.trim().toLowerCase(),
    );
    if (match) {
      const versionNote =
        match.version && mod.version && match.version !== mod.version
          ? t("importDialog.dupeVersion", { library: match.version, incoming: mod.version })
          : t("importDialog.dupeSameName");
      dupes.push(`${mod.name} ${versionNote}`);
    }
  }

  // 目标重叠：把现有模组已部署的 relativePath 和计划文件都算占用，
  // 新导入模组的 plannedFiles 命中即提示——启用后才会真正冲突。
  const claims = new Map<string, string>();
  for (const mod of others) {
    for (const file of mod.deployedFiles) {
      if (!claims.has(file.relativePath.toLowerCase())) {
        claims.set(file.relativePath.toLowerCase(), mod.name);
      }
    }
    for (const file of mod.plannedFiles) {
      if (!claims.has(file.toLowerCase())) {
        claims.set(file.toLowerCase(), mod.name);
      }
    }
  }
  const conflicts: string[] = [];
  for (const mod of imported) {
    const hit = mod.plannedFiles
      .map((file) => claims.get(file.toLowerCase()))
      .find((owner) => Boolean(owner));
    if (hit) conflicts.push(t("importDialog.conflictLine", { mod: mod.name, owner: hit }));
  }
  if (dupes.length === 0 && conflicts.length === 0) return null;
  return { dupes, conflicts };
}

export function ImportDialog({
  open,
  busy,
  savingCategories,
  outcomes,
  libraryMods = [],
  onClose,
  onImport,
  onSaveCategories,
}: {
  open: boolean;
  busy: boolean;
  savingCategories: boolean;
  outcomes: InstallOutcome[] | null;
  /** #2 现有库内容，用于导入后的集合报告对照。 */
  libraryMods?: ModEntry[];
  onClose: () => void;
  onImport: (paths: string[]) => Promise<void>;
  onSaveCategories: (updates: Array<{ id: string; category: string }>) => Promise<void>;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [categories, setCategories] = useState<Record<string, string>>({});
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) {
      setSelected([]);
      setCategories({});
    }
  }, [open]);

  useEffect(() => {
    if (!outcomes) return;
    const next: Record<string, string> = {};
    for (const outcome of outcomes) {
      if (outcome.success && outcome.modEntry) {
        next[outcome.modEntry.id] = outcome.modEntry.category;
      }
    }
    setCategories(next);
  }, [outcomes]);

  const saveCategories = async () => {
    if (!outcomes) return;
    const updates = outcomes
      .filter((outcome) => outcome.success && outcome.modEntry)
      .map((outcome) => ({
        id: outcome.modEntry!.id,
        category: categories[outcome.modEntry!.id] ?? outcome.modEntry!.category,
        original: outcome.modEntry!.category,
      }))
      .filter((item) => item.category !== item.original)
      .map(({ id, category }) => ({ id, category }));
    try {
      if (updates.length > 0) {
        await onSaveCategories(updates);
      }
      onClose();
    } catch {
      // App has already surfaced the structured error; keep the dialog open so
      // the user can retry without re-importing the archives.
    }
  };

  const pick = async () => {
    if (!isTauri) {
      fileInput.current?.click();
      return;
    }
    const picked = await openDialog({
      multiple: true,
      directory: false,
      filters: [{ name: t("importDialog.filterName"), extensions: ["zip", "7z", "rar"] }],
    });
    if (!picked) return;
    setSelected(Array.isArray(picked) ? picked : [picked]);
  };

  const handleBrowserFiles = (files: FileList | null) => {
    if (!files) return;
    setSelected(
      Array.from(files)
        .filter((file) => /\.(zip|7z|rar)$/i.test(file.name))
        .map((file) => file.name),
    );
  };

  const successCount = outcomes?.filter((item) => item.success).length ?? 0;
  const failureCount = outcomes ? outcomes.length - successCount : 0;

  const collectionReport = useMemo(() => {
    if (!outcomes) return null;
    const imported = outcomes
      .filter((item) => item.success && item.modEntry)
      .map((item) => item.modEntry!);
    return buildCollectionReport(imported, libraryMods);
    // libraryMods 变化不重算：报告描述的是「导入那一刻」与库的对照。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outcomes]);

  return (
    <Modal
      open={open}
      title={t("importDialog.title")}
      eyebrow={t("importDialog.eyebrow")}
      onClose={onClose}
      width={620}
      footer={
        outcomes ? (
          <>
            <button className="btn btn-ghost" onClick={onClose} disabled={savingCategories}>
              {t("importDialog.skip")}
            </button>
            <button
              className="btn btn-primary"
              onClick={() => void saveCategories()}
              disabled={savingCategories}
            >
              {savingCategories ? <Spinner /> : <Save size={14} />}
              {savingCategories ? t("importDialog.saving") : t("importDialog.saveCategories")}
            </button>
          </>
        ) : (
          <>
            <button className="btn btn-ghost" onClick={onClose} disabled={busy}>
              {t("common.cancel")}
            </button>
            <button
              className="btn btn-primary"
              onClick={() => void onImport(selected)}
              disabled={busy || selected.length === 0}
            >
              {busy ? <Spinner /> : <Upload size={15} />}
              {busy ? t("importDialog.extracting") : t("importDialog.importCount", { count: selected.length || "" })}
            </button>
          </>
        )
      }
    >
      {!outcomes ? (
        <>
          <button className="drop-zone" onClick={() => void pick()} disabled={busy}>
            <div className="drop-icon">
              <FileArchive size={28} />
            </div>
            <strong>{t("importDialog.dropTitle")}</strong>
            <span>{t("importDialog.dropHint")}</span>
            <small>{t("importDialog.dropNote")}</small>
          </button>

          <input
            ref={fileInput}
            type="file"
            accept=".zip,.7z,.rar"
            multiple
            hidden
            onChange={(event) => handleBrowserFiles(event.target.files)}
          />

          {selected.length > 0 ? (
            <div className="selected-files">
              <div className="selected-head">
                <span>{t("importDialog.selectedHead")}</span>
                <button className="mini-btn" onClick={() => setSelected([])} aria-label={t("importDialog.clearSelected")}>
                  <X size={13} />
                </button>
              </div>
              {selected.map((path) => (
                <div key={path} className="selected-row">
                  <FileArchive size={13} />
                  <span title={path}>{compactPath(path, 54)}</span>
                </div>
              ))}
            </div>
          ) : null}

          <div className="import-notes">
            <div>
              <span className="note-num">01</span>
              <p><strong>{t("importDialog.step1Title")}</strong>{t("importDialog.step1Detail")}</p>
            </div>
            <div>
              <span className="note-num">02</span>
              <p><strong>{t("importDialog.step2Title")}</strong>{t("importDialog.step2Detail")}</p>
            </div>
            <div>
              <span className="note-num">03</span>
              <p><strong>{t("importDialog.step3Title")}</strong>{t("importDialog.step3Detail")}</p>
            </div>
          </div>
        </>
      ) : (
        <div className="import-results">
          <div className={`import-result-summary ${failureCount > 0 ? "has-failure" : ""}`}>
            {failureCount > 0 ? <AlertTriangle size={20} /> : <CheckCircle2 size={20} />}
            <div>
              <strong>
                {t("importDialog.summaryOk", { count: successCount })}{failureCount ? t("importDialog.summaryFailed", { count: failureCount }) : ""}
              </strong>
              <span>{t("importDialog.summaryHint")}</span>
            </div>
          </div>
          <div className="result-list import-review-list">
            {outcomes.map((outcome) => {
              const mod = outcome.modEntry;
              if (!outcome.success || !mod) {
                return (
                  <div key={outcome.path} className="result-row failed">
                    <AlertTriangle size={15} />
                    <div>
                      <strong>{fileName(outcome.path)}</strong>
                      <span>{outcome.error}</span>
                    </div>
                  </div>
                );
              }
              const fromInfo =
                mod.metadataSource === "infoJson" ||
                (!mod.metadataSource && Boolean(mod.version || mod.author));
              return (
                <div key={outcome.path} className={`import-review-row ${fromInfo ? "has-meta" : "no-meta"}`}>
                  <div className="import-review-main">
                    <div className="import-review-title">
                      <strong>{mod.name}</strong>
                      {mod.version ? <span className="import-version">v{mod.version}</span> : null}
                      <span className={`import-source ${fromInfo ? "info" : "filename"}`}>
                        {fromInfo ? t("importDialog.sourceInfo") : t("importDialog.sourceFilename")}
                      </span>
                    </div>
                    <div className="import-review-meta">
                      {t(LAYOUT_LABEL_KEY[mod.layout])} · {t("importDialog.fileCount", { count: mod.fileCount })}
                      {mod.author ? ` · ${mod.author}` : ""}
                    </div>
                    {!fromInfo ? (
                      <p className="import-review-warning">
                        {t("importDialog.noInfoWarning")}
                      </p>
                    ) : null}
                  </div>
                  <label className="import-category">
                    <span><Tag size={11} /> {t("importDialog.categoryLabel")}</span>
                    <select
                      value={categories[mod.id] ?? mod.category}
                      onChange={(event) =>
                        setCategories((current) => ({ ...current, [mod.id]: event.target.value }))
                      }
                      aria-label={t("importDialog.categoryAria", { name: mod.name })}
                    >
                      {CATEGORIES.filter((item) => item !== "全部" && item !== "已启用").map((item) => ( // i18n-ignore
                        // value 必须是原始数据值（会写进 state），显示文案走 categoryLabel。
                        <option key={item} value={item}>{categoryLabel(item)}</option>
                      ))}
                    </select>
                  </label>
                </div>
              );
            })}
          </div>
          {collectionReport ? (
            <div className="collection-report">
              <div className="collection-report-head">
                <ClipboardList size={14} />
                <span>{t("importDialog.collectionReportHead")}</span>
              </div>
              {collectionReport.dupes.length > 0 ? (
                <div className="collection-report-group">
                  <strong>{t("importDialog.dupeCount", { count: collectionReport.dupes.length })}</strong>
                  {collectionReport.dupes.slice(0, 4).map((line) => (
                    <p key={line}>{line}</p>
                  ))}
                </div>
              ) : null}
              {collectionReport.conflicts.length > 0 ? (
                <div className="collection-report-group">
                  <strong>{t("importDialog.conflictCount", { count: collectionReport.conflicts.length })}</strong>
                  {collectionReport.conflicts.slice(0, 4).map((line) => (
                    <p key={line}>{line}</p>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
          <div className="import-tip">
            <FolderOpen size={14} />
            <span>
              {t("importDialog.tipNote")}
            </span>
          </div>
        </div>
      )}
    </Modal>
  );
}
