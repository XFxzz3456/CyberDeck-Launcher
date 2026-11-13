import { AlertTriangle, Check, Link2, MoreHorizontal, PackageSearch } from "lucide-react";
import type { ConflictInfo, ModEntry } from "../types";
import { formatBytes } from "../lib/format";
import { CoverArt } from "./CoverArt";
import { VersionChip } from "./VersionChip";
import { Toggle } from "./ui";
import { categoryLabel, t } from "../i18n";
import { isContextMenuKey, keyboardContextMenuEvent } from "../lib/contextMenuKey";

type RowState = "deployed" | "staged" | "conflict";

const STATE_LABEL: Record<RowState, string> = {
  deployed: t("modCard.stateDeployed"),
  staged: t("modCard.stateStaged"),
  conflict: t("modCard.stateConflict"),
};

/**
 * 模组库「列表视图」的一行。
 *
 * 为什么单独一个组件而不是给 ModCard 加 variant：卡片是固定高度 + 封面主导，
 * 列表行是单行信息密度主导（名称 / 作者 / 版本 / 分类 / 体积 / 状态 / 开关），
 * 两者 DOM 结构几乎没有交集，套在一起只会让两边都变形。
 *
 * 高度恒等于 CSS 里 `.mod-row` 的 56px（虚拟滚动按固定行高估算，不能随内容变）。
 */
export function ModRow({
  mod,
  modConflicts,
  missingDeps = [],
  translationCount = 0,
  hasUpdate = false,
  updateVersion,
  versions,
  onSwitchVersion,
  onDeleteVersion,
  grouped = false,
  busy,
  onToggle,
  onOpen,
  onContextMenu,
  selectable = false,
  selected = false,
  onSelectedChange,
}: {
  mod: ModEntry;
  /** 只属于这一条模组的冲突（上层按 id 分好组；行组件自己不再全表扫描）。 */
  modConflicts: ConflictInfo[];
  missingDeps?: string[];
  translationCount?: number;
  hasUpdate?: boolean;
  updateVersion?: string;
  /** 同一个 mod 的全部版本（新→旧）。长度 > 1 时版本列换成切换胶囊。 */
  versions?: ModEntry[];
  onSwitchVersion?: (mod: ModEntry) => void;
  /** 删除某个版本（Vortex 托管条目不给）。 */
  onDeleteVersion?: (mod: ModEntry) => void;
  /** 分组模式下分类已经写在组头上，行里再列一遍是重复信息。 */
  grouped?: boolean;
  busy: boolean;
  onToggle: (enabled: boolean) => void;
  onOpen: () => void;
  onContextMenu?: (event: React.MouseEvent) => void;
  selectable?: boolean;
  selected?: boolean;
  onSelectedChange?: (checked: boolean) => void;
}) {
  const hasConflict = modConflicts.length > 0;
  const state: RowState = hasConflict ? "conflict" : mod.enabled ? "deployed" : "staged";
  const stateLabel = STATE_LABEL[state];

  const translatedName = (mod.translatedName ?? "").trim();
  const hasTranslatedName = translatedName.length > 0;
  const displayName = hasTranslatedName ? translatedName : mod.name;
  const missingTitle =
    missingDeps.length > 0 ? t("modCard.missingTitle", { deps: missingDeps.join("、") }) : undefined;

  return (
    <div
      className={`mod-row state-${state} ${mod.enabled ? "is-enabled" : "is-disabled"} ${busy ? "is-busy" : ""}`}
      data-state={state}
      data-selected={selectable && selected ? "true" : undefined}
      role="button"
      tabIndex={0}
      onClick={(event) => {
        if (selectable && onSelectedChange) {
          event.preventDefault();
          onSelectedChange(!selected);
          return;
        }
        onOpen();
      }}
      onContextMenu={onContextMenu}
      onKeyDown={(event) => {
        // 菜单键 / Shift+F10：键盘用户也要能开右键菜单，否则这里的功能只能鼠标用。
        if (onContextMenu && isContextMenuKey(event)) {
          event.preventDefault();
          event.stopPropagation();
          onContextMenu(keyboardContextMenuEvent(event.currentTarget));
          return;
        }
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen();
        }
      }}
      aria-label={t("modCard.cardAria", { name: mod.name, state: stateLabel })}
    >
      {selectable ? (
        <label className="row-check" onClick={(event) => event.stopPropagation()}>
          <input
            type="checkbox"
            checked={selected}
            onChange={(event) => onSelectedChange?.(event.target.checked)}
            aria-label={t("modCard.selectAria")}
          />
          <Check size={10} strokeWidth={3} />
        </label>
      ) : null}

      <div className="row-thumb">
        {/* 三级回落同卡片视图：包内封面 → 本地缓存 → 远程地址兜底。 */}
        {!mod.coverPath && !mod.coverCachePath && mod.nexusCoverUrl ? (
          <img
            src={mod.nexusCoverUrl}
            alt=""
            loading="lazy"
            referrerPolicy="no-referrer"
            onError={(event) => {
              event.currentTarget.style.display = "none";
            }}
          />
        ) : null}
        <CoverArt
          id={mod.id}
          name={mod.name}
          category={mod.category}
          coverPath={mod.coverPath ?? mod.coverCachePath}
          className="cover-thumb"
        />
      </div>

      <div className="row-main">
        <div className="row-title">
          <span className="row-name" title={hasTranslatedName ? `${displayName} · ${mod.name}` : mod.name}>
            {displayName}
          </span>
          {hasTranslatedName ? (
            <span className="row-name-original" title={mod.name}>
              {mod.name}
            </span>
          ) : null}
          {/* 收编（接管）标记：与卡片视图保持一致，列表视图也要能看出
              这个 Mod 的物理文件还在外部工具 / 游戏目录里。 */}
          {mod.origin === "adopted" ? (
            <span className="row-chip row-chip-adopt" title={t("modCard.adoptedTagTitle")}>
              {t("modCard.adoptedTag")}
            </span>
          ) : null}
          {mod.origin === "modpack" ? (
            <span className="row-chip cover-pack" title={t("modCard.packTitle")}>
              {t("modCard.packBadge")}
            </span>
          ) : null}
          {mod.nexus ? <span className="row-chip">{t("modCard.nexusBadge")}</span> : null}
          {hasUpdate ? (
            <span
              className="row-chip row-chip-upd"
              title={
                updateVersion
                  ? t("modCard.updateTitleVersion", { version: updateVersion })
                  : t("modCard.updateTitle")
              }
            >
              {t("modCard.updBadge")}
            </span>
          ) : null}
          {translationCount > 0 ? (
            <span
              className="row-chip row-chip-lang"
              title={t("modCard.translationTitle", { count: translationCount })}
            >
              {t("modCard.translationBadge")}
              {translationCount > 1 ? translationCount : ""}
            </span>
          ) : null}
          {missingDeps.length > 0 ? (
            <span className="row-chip row-chip-missing" title={missingTitle}>
              <PackageSearch size={10} /> {t("modCard.missingBadge")}
            </span>
          ) : null}
          {hasConflict ? (
            <span
              className="row-chip row-chip-conflict"
              title={t("modCard.conflictCount", { count: modConflicts.length })}
            >
              <AlertTriangle size={10} /> {modConflicts.length}
            </span>
          ) : null}
        </div>
        <div className="row-meta">
          <span>{mod.author || t("modCard.unknownAuthor")}</span>
          <span className="meta-dot" />
          <span>{mod.fileCount} {t("modCard.filesLabel")}</span>
          {mod.deployedFiles.length > 0 ? (
            <>
              <span className="meta-dot" />
              <span className="meta-link">
                <Link2 size={10} /> {mod.deployedFiles.length}
              </span>
            </>
          ) : null}
        </div>
      </div>

      {/* 版本 / 分类 / 大小各自成列：挤在第二行的一串文字里根本没法纵向扫视，
          对齐之后眼睛只要沿一条竖线走就能比较大小和版本。 */}
      <span className="row-col row-col-version" title={mod.version ? `v${mod.version}` : undefined}>
        {versions && versions.length > 1 ? (
          <VersionChip
            current={mod}
            versions={versions}
            busy={busy}
            placement="row"
            onSwitch={(next) => onSwitchVersion?.(next)}
            onDelete={onDeleteVersion ? (next) => onDeleteVersion(next) : undefined}
          />
        ) : mod.version ? (
          `v${mod.version}`
        ) : (
          "-"
        )}
      </span>
      {grouped ? null : (
        <span className="row-col row-col-category" title={categoryLabel(mod.category)}>
          {categoryLabel(mod.category)}
        </span>
      )}
      <span className="row-col row-col-size">{formatBytes(mod.sizeBytes)}</span>

      <span className={`row-state state-${state}`}>
        <i />
        {stateLabel}
      </span>

      {busy ? (
        <span className="row-busy">
          <span className="loader-bar" />
        </span>
      ) : null}

      <Toggle
        checked={mod.enabled}
        onChange={onToggle}
        disabled={busy}
        label={t("modCard.toggleAria", {
          action: mod.enabled ? t("modCard.disable") : t("modCard.enable"),
          name: mod.name,
        })}
      />

      <button
        type="button"
        className="row-action-btn"
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
  );
}
