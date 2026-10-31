import { useEffect, useMemo, useState } from "react";
import { motion, useIsPresent } from "framer-motion";
import {
  AlertTriangle,
  Archive,
  Box,
  ChevronRight,
  Copy,
  Download,
  ExternalLink,
  FileText,
  FolderOpen,
  Link,
  Languages,
  Link2,
  PackageSearch,
  Pencil,
  Power,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import type { ConflictInfo, ModEntry, UpdateBackup } from "../types";
import type { EffectiveDependency } from "../lib/dependencies";
import { CATEGORIES, LAYOUT_LABEL_KEY } from "../types";
import { formatBytes, formatDate, relativeTime } from "../lib/format";
import { CoverArt } from "./CoverArt";
import { Badge, Modal, Spinner, Toggle } from "./ui";
import { ModSettingsPanel } from "./ModSettingsPanel";
import { useMotionSprings, makeBackdropVariants, makeDrawerVariants } from "../lib/motion";
import { useMotionEnabled } from "../lib/preferences";
import { categoryLabel, t } from "../i18n";

export function ModDetailDrawer({
  mod,
  conflicts,
  missingDeps = [],
  updateInfo,
  backupInfo,
  onApplyUpdate,
  onRollbackUpdate,
  applyingUpdate = false,
  busy,
  onClose,
  onToggle,
  onUninstall,
  onUpdateCategory,
  onReveal,
  onOpenNexus,
  onGetPrerequisite,
  onIgnoreDependency,
  onRestoreDependency,
  translationChildren = [],
  onUnbindTranslation,
  onSaveMetadata,
  onAttachNexus,
  onToast,
  onError,
  onOpenPath,
}: {
  mod: ModEntry;
  conflicts: ConflictInfo[];
  /** 结构化前置列表：含已满足项（satisfied=true），缺失项才有「去获取」。 */
  missingDeps?: EffectiveDependency[];
  /** 忽略 / 恢复某条前置警告（本地持久化，不动状态文件）。 */
  onIgnoreDependency?: (frameworkId: string) => void;
  onRestoreDependency?: (frameworkId: string) => void;
  /** 已挂在这个 Mod 下的语言附属包（汉化子包）。 */
  translationChildren?: ModEntry[];
  /** 解绑某个汉化子包（解绑后它回到主网格作为独立 Mod）。 */
  onUnbindTranslation?: (childId: string) => void;
  /** #1 更新检查命中时传入，抽屉里给出「查看新版本」入口。 */
  updateInfo?: { currentVersion: string | null; latestVersion: string; pageUrl: string } | null;
  /** 这个模组可回滚的备份（有值才显示「回滚」按钮）。 */
  backupInfo?: UpdateBackup | null;
  onApplyUpdate?: () => void;
  onRollbackUpdate?: () => void;
  applyingUpdate?: boolean;
  busy: boolean;
  onClose: () => void;
  onToggle: (enabled: boolean) => void;
  onUninstall: () => void;
  onUpdateCategory: (category: string) => void;
  onReveal: () => void;
  onOpenNexus: (url: string) => void;
  onGetPrerequisite: (name: string) => void;
  /** 手动编辑名称/作者/版本/分类（收编来的模组没有官方元数据时的兜底）。 */
  onSaveMetadata?: (fields: {
    name: string;
    author: string;
    version: string;
    category: string;
  }) => Promise<void>;
  /** 粘贴 Nexus 链接自动填充（B 方案）。 */
  onAttachNexus?: (url: string) => Promise<void>;
  /** 专属配置保存后的提示。 */
  onToast?: (tone: "ok" | "error" | "info" | "warn", title: string, message?: string) => void;
  onError?: (error: unknown, title?: string) => void;
  /** 打开配置文件所在目录（专属配置面板里的文件夹按钮）。 */
  onOpenPath?: (path: string) => void;
}) {
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  // 动效：抽屉整体从右侧滑入，遮罩淡入（毛玻璃随 opacity 一起浮现）。
  // 关闭「界面动效」时变体退化为时长 0 的瞬移，不做位移。
  const motionEnabled = useMotionEnabled();
  const springs = useMotionSprings();
  const drawerVariants = useMemo(
    () => makeDrawerVariants(springs.overlay, motionEnabled),
    [springs, motionEnabled],
  );
  const backdropVariants = useMemo(() => makeBackdropVariants(motionEnabled), [motionEnabled]);
  // 退场期间这份 DOM 还在（AnimatePresence 保留它播完动画），但用户已经关掉了。
  // 不关掉指针事件的话，那 190ms 里整屏都是"透明挡板"，点哪都没反应。
  const isPresent = useIsPresent();

  const [editing, setEditing] = useState(false);
  const [link, setLink] = useState("");
  const attachFromLink = async () => {
    if (!onAttachNexus || !link.trim()) return;
    setSaving(true);
    try {
      await onAttachNexus(link.trim());
      setEditing(false);
      setLink("");
    } finally {
      setSaving(false);
    }
  };
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    name: mod.name,
    author: mod.author ?? "",
    version: mod.version ?? "",
    category: mod.category,
  });
  const openEditor = () => {
    setForm({
      name: mod.name,
      author: mod.author ?? "",
      version: mod.version ?? "",
      category: mod.category,
    });
    setEditing(true);
  };
  const submitEditor = async () => {
    if (!onSaveMetadata || !form.name.trim()) return;
    setSaving(true);
    try {
      await onSaveMetadata(form);
      setEditing(false);
    } finally {
      setSaving(false);
    }
  };

  const modConflicts = conflicts.filter(
    (conflict) => conflict.modId === mod.id || conflict.otherModId === mod.id,
  );
  const linkCounts = mod.deployedFiles.reduce<Record<string, number>>((acc, file) => {
    acc[file.linkType] = (acc[file.linkType] ?? 0) + 1;
    return acc;
  }, {});

  // 双语标题：主标题优先中文译名，原文名作为副行；没有译名时维持原样。
  const translatedName = (mod.translatedName ?? "").trim();
  const hasTranslatedName = translatedName.length > 0;
  const displayName = hasTranslatedName ? translatedName : mod.name;

  return (
    <div className="drawer-portal" style={isPresent ? undefined : { pointerEvents: "none" }}>
      <motion.button
        className="drawer-backdrop"
        aria-label={t("modDetail.backdropClose")}
        onClick={onClose}
        variants={backdropVariants}
        initial="hidden"
        animate="visible"
        exit="exit"
      />
      <motion.aside
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-label={t("modDetail.drawerAria", { name: mod.name })}
        variants={drawerVariants}
        initial="hidden"
        animate="visible"
        exit="exit"
      >
        <header className={`drawer-hero cover-${mod.category}`}>
          <div className="drawer-hero-cover">
            <CoverArt id={mod.id} name={mod.name} category={mod.category} coverPath={mod.coverPath} />
          </div>
          <div className="drawer-hero-art" />
          <div className="drawer-hero-top">
            <div className="drawer-hero-badges">
              <Badge tone={mod.enabled ? "yellow" : "muted"}>
                {mod.enabled ? t("modDetail.deployed") : t("modDetail.staged")}
              </Badge>
              {mod.nexus ? <Badge tone="cyan">{t("modDetail.nexusBadge")}</Badge> : null}
            </div>
            {onSaveMetadata ? (
              <button
                className="icon-btn on-dark"
                onClick={openEditor}
                aria-label={t("modDetail.editAria")}
                title={t("modDetail.editButtonTitle")}
              >
                <Pencil size={15} />
              </button>
            ) : null}
            <button className="icon-btn on-dark" onClick={onClose} aria-label={t("common.close")}>
              <X size={17} />
            </button>
          </div>
          <div className="drawer-hero-copy">
            <div className="eyebrow">{categoryLabel(mod.category)} / {t(LAYOUT_LABEL_KEY[mod.layout])}</div>
            <h2>{displayName}</h2>
            {/* 译名做标题时，原文名压成一行小字放在 byline 之上；单行省略，避免收窄窗口时把 byline 顶出海报区。 */}
            {hasTranslatedName ? (
              <div className="drawer-name-original" title={mod.name}>
                {mod.name}
              </div>
            ) : null}
            <div className="drawer-byline">
              {mod.author || t("modDetail.authorUnknown")} {mod.version ? <span>· v{mod.version}</span> : null}
              <span>· {formatDate(mod.installedAt)}</span>
            </div>
          </div>
        </header>

        <div className="drawer-body">
          <div className="drawer-toggle-row">
            <div>
              <strong>
                {mod.enabled ? t("modDetail.deployedTitle") : t("modDetail.stagedTitle")}
              </strong>
              <span>
                {mod.enabled ? t("modDetail.deployedHint") : t("modDetail.stagedHint")}
              </span>
            </div>
            {busy ? (
              <Spinner size={20} />
            ) : (
              <Toggle
                checked={mod.enabled}
                onChange={onToggle}
                label={t("modDetail.toggleLabel")}
              />
            )}
          </div>

          {modConflicts.length > 0 ? (
            <div className="drawer-conflict">
              <AlertTriangle size={16} />
              <div>
                <strong>{t("modDetail.conflictCount", { count: modConflicts.length })}</strong>
                <p>
                  {modConflicts[0].otherModName
                    ? t("modDetail.conflictWith", { name: modConflicts[0].otherModName })
                    : t("modDetail.conflictUnmanaged")}
                  {t("modDetail.conflictEffect")}
                </p>
              </div>
            </div>
          ) : null}

          {missingDeps.length > 0 ? (
            <div className="drawer-prereq">
              <PackageSearch size={17} />
              <div>
                <strong>
                  {t("modDetail.prereqHead", {
                    missing: missingDeps.filter((item) => !item.satisfied).length,
                    total: missingDeps.length,
                  })}
                </strong>
                <p>{t("modDetail.prereqDetail")}</p>
                <div className="drawer-prereq-list">
                  {missingDeps.map((requirement) => (
                    <div
                      key={requirement.id}
                      className={`drawer-prereq-row ${requirement.satisfied ? "is-ok" : "is-missing"} ${
                        requirement.ignored ? "is-ignored" : ""
                      }`}
                    >
                      <span>
                        <b>{requirement.name}</b>
                        <em>{requirement.detail}</em>
                      </span>
                      {requirement.ignored ? (
                        <button
                          className="btn btn-ghost btn-sm"
                          onClick={() => onRestoreDependency?.(requirement.id)}
                        >
                          {t("modDetail.prereqRestore")}
                        </button>
                      ) : requirement.satisfied ? (
                        <span className="prereq-state-ok">
                          {requirement.versionMismatch
                            ? t("modDetail.prereqVersionLow", {
                                installed: requirement.installedVersion ?? "?",
                                required: requirement.requiredVersion ?? "?",
                              })
                            : t("modDetail.installed")}
                        </span>
                      ) : (
                        <span className="prereq-actions">
                          <button
                            className="btn btn-ghost btn-sm"
                            onClick={() => onGetPrerequisite(requirement.name)}
                          >
                            <ExternalLink size={11} /> {t("modDetail.getIt")}
                          </button>
                          {onIgnoreDependency ? (
                            <button
                              className="btn btn-ghost btn-sm prereq-ignore"
                              title={t("modDetail.prereqIgnoreHint")}
                              onClick={() => onIgnoreDependency(requirement.id)}
                            >
                              {t("modDetail.prereqIgnore")}
                            </button>
                          ) : null}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ) : null}

          {translationChildren.length > 0 ? (
            <div className="drawer-translations">
              <div className="drawer-translations-head">
                <Languages size={16} />
                <div>
                  <strong>
                    {t("modDetail.translationHead", { count: translationChildren.length })}
                  </strong>
                  <p>{t("modDetail.translationDetail")}</p>
                </div>
              </div>
              <div className="drawer-translation-list">
                {translationChildren.map((child) => (
                  <div key={child.id} className="drawer-translation-row">
                    <span>
                      <b>{child.name}</b>
                      <em>{child.enabled ? t("modDetail.translationOn") : t("modDetail.translationOff")}</em>
                    </span>
                    {onUnbindTranslation ? (
                      <button
                        className="btn btn-ghost btn-sm"
                        onClick={() => onUnbindTranslation(child.id)}
                      >
                        {t("modDetail.translationUnbind")}
                      </button>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {updateInfo ? (
            <div className="drawer-update">
              <div>
                <strong>
                  {t("modDetail.updateTitle", { version: updateInfo.latestVersion })}
                </strong>
                <span>
                  {t("modDetail.updateDetail", {
                    current: updateInfo.currentVersion ?? "?",
                    latest: updateInfo.latestVersion,
                  })}
                </span>
              </div>
              <div className="drawer-update-actions">
                <button
                  className="btn btn-sm btn-primary"
                  onClick={onApplyUpdate}
                  disabled={applyingUpdate || !onApplyUpdate}
                >
                  {applyingUpdate ? <Spinner size={12} /> : <Download size={12} />}
                  {t("modDetail.updateNow", { version: updateInfo.latestVersion })}
                </button>
                <button
                  className="btn btn-sm btn-ghost"
                  onClick={() => onOpenNexus(updateInfo.pageUrl)}
                >
                  <ExternalLink size={12} /> {t("modDetail.downloadPage")}
                </button>
              </div>
            </div>
          ) : null}

          {backupInfo && !updateInfo ? (
            <div className="drawer-update">
              <div>
                <strong>{t("modDetail.rollbackTitle")}</strong>
                <span>
                  {t("modDetail.rollbackDetail", { version: backupInfo.fromVersion ?? "?" })}
                </span>
              </div>
              <div className="drawer-update-actions">
                <button
                  className="btn btn-sm btn-ghost"
                  onClick={onRollbackUpdate}
                  disabled={applyingUpdate || !onRollbackUpdate}
                >
                  {applyingUpdate ? <Spinner size={12} /> : <Undo2 size={12} />}
                  {t("modDetail.rollback", { version: backupInfo.fromVersion ?? "?" })}
                </button>
              </div>
            </div>
          ) : null}

          {mod.description ? <p className="drawer-desc">{mod.description}</p> : null}

          {mod.warnings.length > 0 ? (
            <div className="drawer-warnings">
              {mod.warnings.map((warning) => (
                <div key={warning} className="drawer-warning">
                  <AlertTriangle size={13} /> {warning}
                </div>
              ))}
            </div>
          ) : null}

          <div className="drawer-stats">
            <div>
              <span>{t("modDetail.statFiles")}</span>
              <strong>{mod.fileCount}</strong>
            </div>
            <div>
              <span>{t("modDetail.statSize")}</span>
              <strong>{formatBytes(mod.sizeBytes)}</strong>
            </div>
            <div>
              <span>{t("modDetail.statLinks")}</span>
              <strong>{mod.deployedFiles.length}</strong>
            </div>
            <div>
              <span>{t("modDetail.statUpdated")}</span>
              <strong>{relativeTime(mod.updatedAt ?? mod.installedAt)}</strong>
            </div>
          </div>

          <div className="drawer-section">
            <div className="drawer-section-head">
              <h3>{t("modDetail.category")}</h3>
            </div>
            <select
              className="select"
              value={mod.category}
              onChange={(event) => onUpdateCategory(event.target.value)}
            >
              {CATEGORIES.filter((category) => category !== "全部" && category !== "已启用").map((category) => ( // i18n-ignore
                <option key={category} value={category}>
                  {categoryLabel(category)}
                </option>
              ))}
            </select>
          </div>

          {/* 专属配置：放在分类之后、部署清单之前——玩家决定「留着还是删掉」时
              顺手就能调参，而不是先跳到另一个全局页面再找回来。 */}
          {onToast && onError ? (
            <ModSettingsPanel mod={mod} onToast={onToast} onError={onError} onOpenPath={onOpenPath} />
          ) : null}

          <div className="drawer-section">
            <div className="drawer-section-head">
              <h3>{t("modDetail.deployList")}</h3>
              <span>
                {mod.deployedFiles.length} {t("modDetail.filesLabel")}
              </span>
            </div>
            {mod.deployedFiles.length === 0 ? (
              <div className="drawer-empty">
                <Box size={18} /> {t("modDetail.deployEmpty")}
              </div>
            ) : (
              <div className="deployed-list">
                {mod.deployedFiles.map((file) => (
                  <div key={file.relativePath} className="deployed-row">
                    <span className={`link-badge link-${file.linkType}`}>
                      {file.linkType === "hardLink" ? (
                        <Link2 size={10} />
                      ) : file.linkType === "symlink" ? (
                        <Link size={10} />
                      ) : (
                        <Copy size={10} />
                      )}
                      {file.linkType === "hardLink"
                        ? t("modDetail.linkHard")
                        : file.linkType === "symlink"
                          ? t("modDetail.linkSym")
                          : t("modDetail.linkCopy")}
                    </span>
                    <div>
                      <code>{file.relativePath}</code>
                      <span className="deployed-target">{file.target}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="drawer-section">
            <div className="drawer-section-head">
              <h3>{t("modDetail.sourceSection")}</h3>
            </div>
            <div className="source-box">
              <Archive size={14} />
              <code>{mod.sourceZip ?? t("modDetail.sourceLocal")}</code>
            </div>
            {/* 展示名会被清洗成人类可读的样子，原名留给要对照磁盘文件排错的人。 */}
            {mod.rawName && mod.rawName !== mod.name ? (
              <div className="source-box source-raw-name">
                <FileText size={14} />
                <span>{t("modDetail.rawName")}</span>
                <code>{mod.rawName}</code>
              </div>
            ) : null}
            {mod.nexus ? (
              <button className="source-nexus" onClick={() => onOpenNexus(mod.nexus!.url)}>
                <ExternalLink size={13} />
                <span>
                  Nexus Mod #{mod.nexus.modId}
                  {mod.nexus.version ? ` · v${mod.nexus.version}` : ""}
                </span>
                <ChevronRight size={13} />
              </button>
            ) : null}
            {(linkCounts.hardLink || linkCounts.symlink || linkCounts.copy) ? (
              <div className="link-summary">
                {linkCounts.hardLink ? (
                  <span>{t("modDetail.hardLinkCount", { count: linkCounts.hardLink })}</span>
                ) : null}
                {linkCounts.symlink ? (
                  <span>{t("modDetail.symLinkCount", { count: linkCounts.symlink })}</span>
                ) : null}
                {linkCounts.copy ? (
                  <span>{t("modDetail.copyLinkCount", { count: linkCounts.copy })}</span>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>

        <footer className="drawer-footer">
          <button className="btn btn-ghost" onClick={onReveal}>
            <FolderOpen size={14} /> {t("modDetail.staging")}
          </button>
          <button className="btn btn-ghost" onClick={() => onToggle(!mod.enabled)} disabled={busy}>
            <Power size={14} /> {mod.enabled ? t("modDetail.disable") : t("modDetail.enable")}
          </button>
          <button className="btn btn-ghost danger-text" onClick={onUninstall} disabled={busy}>
            <Trash2 size={14} /> {t("modDetail.uninstall")}
          </button>
          <span className="drawer-footer-hint">
            <ExternalLink size={11} /> {t("modDetail.uninstallHint")}
          </span>
        </footer>
      </motion.aside>

      <Modal
        open={editing}
        title={t("modDetail.editDialogTitle")}
        eyebrow={t("modDetail.editEyebrow")}
        onClose={() => setEditing(false)}
        footer={
          <>
            <button className="btn btn-ghost" onClick={() => setEditing(false)} disabled={saving}>
              {t("common.cancel")}
            </button>
            <button
              className="btn btn-primary"
              onClick={() => void submitEditor()}
              disabled={saving || !form.name.trim()}
            >
              {saving ? <Spinner size={14} /> : null} {t("common.save")}
            </button>
          </>
        }
      >
        <div className="settings-field">
          <span>{t("modDetail.fieldNexusLink")}</span>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              value={link}
              onChange={(event) => setLink(event.target.value)}
              placeholder={t("modDetail.nexusPlaceholder")}
            />
            <button
              className="btn btn-ghost"
              onClick={() => void attachFromLink()}
              disabled={!link.trim() || saving}
            >
              {t("modDetail.autoFill")}
            </button>
          </div>
        </div>
        <div className="settings-field">
          <span>{t("modDetail.fieldName")}</span>
          <input
            value={form.name}
            onChange={(event) => setForm({ ...form, name: event.target.value })}
            placeholder={t("modDetail.namePlaceholder")}
          />
        </div>
        <div className="settings-field">
          <span>{t("modDetail.fieldAuthor")}</span>
          <input
            value={form.author}
            onChange={(event) => setForm({ ...form, author: event.target.value })}
            placeholder={t("modDetail.authorPlaceholder")}
          />
        </div>
        <div className="settings-field">
          <span>{t("modDetail.fieldVersion")}</span>
          <input
            value={form.version}
            onChange={(event) => setForm({ ...form, version: event.target.value })}
            placeholder={t("modDetail.versionPlaceholder")}
          />
        </div>
        <div className="settings-field">
          <span>{t("modDetail.category")}</span>
          <select
            value={form.category}
            onChange={(event) => setForm({ ...form, category: event.target.value })}
          >
            {CATEGORIES.filter((item) => item !== "全部").map((item) => ( // i18n-ignore
              <option key={item} value={item}>
                {categoryLabel(item)}
              </option>
            ))}
          </select>
        </div>
        <p className="inline-note compact">
          {t("modDetail.manualNote")}
        </p>
      </Modal>
    </div>
  );
}
