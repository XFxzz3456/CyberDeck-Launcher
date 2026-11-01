import { motion } from "framer-motion";
import { AlertTriangle, Check, Link2, MoreHorizontal, PackageSearch } from "lucide-react";
import type { ConflictInfo, ModEntry } from "../types";
import { formatBytes } from "../lib/format";
import { modCardHover, modCardTap, useMotionSprings } from "../lib/motion";
import { useMotionEnabled } from "../lib/preferences";
import { CoverArt } from "./CoverArt";
import { Toggle } from "./ui";
import { categoryLabel, t } from "../i18n";

type CardState = "deployed" | "staged" | "conflict";

const STATE_LABEL: Record<CardState, string> = {
  deployed: t("modCard.stateDeployed"),
  staged: t("modCard.stateStaged"),
  conflict: t("modCard.stateConflict"),
};

export function ModCard({
  mod,
  conflicts,
  missingDeps = [],
  translationCount = 0,
  aiLocated = false,
  hasUpdate = false,
  updateVersion,
  busy,
  onToggle,
  onOpen,
  onContextMenu,
  selectable = false,
  selected = false,
  onSelectedChange,
}: {
  mod: ModEntry;
  conflicts: ConflictInfo[];
  missingDeps?: string[];
  /** 已绑定的汉化子包数量：>0 时封面上打「中」徽标。 */
  translationCount?: number;
  /** 已生成 AI 汉化覆盖层：徽标显示「中·AI」，区别于人工汉化包。 */
  aiLocated?: boolean;
  /** #1 更新检查命中：封面上打 UPD 徽标。 */
  hasUpdate?: boolean;
  updateVersion?: string;
  busy: boolean;
  onToggle: (enabled: boolean) => void;
  onOpen: () => void;
  onContextMenu?: (event: React.MouseEvent) => void;
  /** 批量选择（看板【mod 列表及切换功能】）：多选模式下封面左上角出复选框。 */
  selectable?: boolean;
  selected?: boolean;
  onSelectedChange?: (checked: boolean) => void;
}) {
  const modConflicts = conflicts.filter(
    (conflict) => conflict.modId === mod.id || conflict.otherModId === mod.id,
  );
  const hasConflict = modConflicts.length > 0;
  const state: CardState = hasConflict ? "conflict" : mod.enabled ? "deployed" : "staged";
  const stateLabel = STATE_LABEL[state];
  const missingTitle =
    missingDeps.length > 0
      ? t("modCard.missingTitle", { deps: missingDeps.join("、") })
      : undefined;

  // 双语标题：有中文译名时标题用译名、原名降级为副行；没有译名就保持原名单行。
  const translatedName = (mod.translatedName ?? "").trim();
  const hasTranslatedName = translatedName.length > 0;
  const displayName = hasTranslatedName ? translatedName : mod.name;

  // 动效开：抬升/收缩交给 framer（transform 由它独占）；关：CSS :hover 接管。
  const motionEnabled = useMotionEnabled();
  const springs = useMotionSprings();

  return (
    <motion.article
      className={`mod-card state-${state} ${mod.enabled ? "is-enabled" : "is-disabled"} ${busy ? "is-busy" : ""}`}
      data-state={state}
      whileHover={motionEnabled ? modCardHover : undefined}
      whileTap={motionEnabled ? modCardTap : undefined}
      transition={springs.hover}
      onClick={(event) => {
        // 多选模式下点卡片 = 切换选中（打开详情交给双击/回车），避免误触。
        if (selectable && onSelectedChange) {
          event.preventDefault();
          onSelectedChange(!selected);
          return;
        }
        onOpen();
      }}
      onContextMenu={onContextMenu}
      data-selected={selectable && selected ? "true" : undefined}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen();
        }
      }}
      tabIndex={0}
      role="button"
      aria-label={t("modCard.cardAria", { name: mod.name, state: stateLabel })}
    >
      <div className="mod-cover">
        {selectable ? (
          <label
            className="card-check"
            onClick={(event) => event.stopPropagation()}
            title={t("modCard.selectAria")}
          >
            <input
              type="checkbox"
              checked={selected}
              onChange={(event) => onSelectedChange?.(event.target.checked)}
              aria-label={t("modCard.selectAria")}
            />
            <Check size={12} strokeWidth={3} />
          </label>
        ) : null}
        {mod.nexusCoverUrl ? (
          // 有官方封面就用官方封面：真实截图比拼出来的几何图形有信息量。
          // 加载失败（离线、图床挂了）交给 onError 回退到程序封面。
          <img
            className="mod-cover-photo"
            src={mod.nexusCoverUrl}
            alt={mod.name}
            loading="lazy"
            referrerPolicy="no-referrer"
            onError={(event) => {
              event.currentTarget.style.display = "none";
            }}
          />
        ) : null}
        <CoverArt id={mod.id} name={mod.name} category={mod.category} coverPath={mod.coverPath} />
        <div className="cover-topline">
          <span className={`card-state-badge state-${state}`}>
            <i />
            {stateLabel}
          </span>
          <div className="cover-badges">
            {mod.origin === "modpack" ? (
              <span className="cover-source cover-pack" title={t("modCard.packTitle")}>
                {t("modCard.packBadge")}
              </span>
            ) : null}
            {mod.nexus ? <span className="cover-source">{t("modCard.nexusBadge")}</span> : null}
            {hasUpdate ? (
              <span
                className="cover-upd"
                title={
                  updateVersion
                    ? t("modCard.updateTitleVersion", { version: updateVersion })
                    : t("modCard.updateTitle")
                }
              >
                {t("modCard.updBadge")}
              </span>
            ) : null}
            {aiLocated ? (
              <span
                className="cover-lang cover-lang-ai"
                title={t("modCard.aiLocTitle")}
              >
                {t("modCard.aiLocBadge")}
              </span>
            ) : translationCount > 0 ? (
              <span
                className="cover-lang"
                title={t("modCard.translationTitle", { count: translationCount })}
              >
                {t("modCard.translationBadge")}
                {translationCount > 1 ? translationCount : ""}
              </span>
            ) : null}
            {missingDeps.length > 0 ? (
              <span className="cover-missing" title={missingTitle}>
                <PackageSearch size={11} /> {t("modCard.missingBadge")}
              </span>
            ) : null}
            {hasConflict ? (
              <span
                className="cover-conflict"
                title={t("modCard.conflictCount", { count: modConflicts.length })}
              >
                <AlertTriangle size={11} /> {modConflicts.length}
              </span>
            ) : null}
          </div>
        </div>
        <div className="cover-bottomline">
          <span className="cover-version">v{mod.version ?? "—"}</span>
          <span className="cover-category">{categoryLabel(mod.category)}</span>
        </div>
        {busy ? (
          <div className="card-busy">
            <span className="loader-bar" />
            <span>{mod.enabled ? t("modCard.busyUndeploy") : t("modCard.busyDeploy")}</span>
          </div>
        ) : null}
      </div>

      <div className="mod-body">
        <div className="mod-title-row">
          {/* 收编（接管）标记：物理文件还在外部工具（Vortex）/游戏目录里，
              用户在禁用/卸载前应该心里有数（2026-11-01 通知重构任务·三）。 */}
          {(mod.origin === "adopted") && (
            <span className="adopted-tag" title={t("modCard.adoptedTagTitle")}>
              {t("modCard.adoptedTag")}
            </span>
          )}
          <h3 title={hasTranslatedName ? `${displayName} · ${mod.name}` : mod.name}>{displayName}</h3>
        </div>
        {/* 原名副行：单行省略 + 紧凑行高，卡片是固定高度（`.mod-card` 310px、overflow: hidden），
            多出来的这一行不许把 .mod-meta 挤到 hover 才出现的 .mod-footer 底下。 */}
        {hasTranslatedName ? (
          <div className="mod-name-original" title={mod.name}>
            {mod.name}
          </div>
        ) : null}
        <div className="mod-byline">
          <span>{mod.author || t("modCard.unknownAuthor")}</span>
          <span className="meta-dot" />
          <span>{mod.version ? `v${mod.version}` : t("modCard.noVersion")}</span>
        </div>
        {/* 双语卡片多了一行标题，描述收到一行以保住固定高度的余量（调用方补好样式后可回退）。 */}
        <p className="mod-desc" style={hasTranslatedName ? { WebkitLineClamp: 1 } : undefined}>
          {mod.description || t("modCard.noDescription")}
        </p>
        <div className="mod-meta">
          <span>{mod.fileCount} {t("modCard.filesLabel")}</span>
          <span className="meta-dot" />
          <span>{formatBytes(mod.sizeBytes)}</span>
          {mod.deployedFiles.length > 0 ? (
            <>
              <span className="meta-dot" />
              <span className="meta-link">
                <Link2 size={10} /> {mod.deployedFiles.length}
              </span>
            </>
          ) : null}
        </div>
        {missingDeps.length > 0 ? (
          <div className="card-missing-line" title={missingTitle}>
            <PackageSearch size={11} /> {t("modCard.missingInline", { deps: missingDeps.join(" / ") })}
          </div>
        ) : null}
      </div>

      <div className="mod-footer">
        <span className={`status-label state-${state}`}>{stateLabel}</span>
        <div className="card-actions">
          <span className="card-toggle-copy">
            {mod.enabled ? t("modCard.enabled") : t("modCard.staged")}
          </span>
          <Toggle
            checked={mod.enabled}
            onChange={onToggle}
            disabled={busy}
            label={t("modCard.toggleAria", {
              action: mod.enabled ? t("modCard.disable") : t("modCard.enable"),
              name: mod.name,
            })}
          />
          <span className="card-action-sep" />
          <button
            className="card-action-btn"
            onClick={(event) => {
              event.stopPropagation();
              onOpen();
            }}
            aria-label={t("modCard.detail")}
            title={t("modCard.viewDetail")}
          >
            <MoreHorizontal size={14} />
          </button>
        </div>
      </div>
    </motion.article>
  );
}
