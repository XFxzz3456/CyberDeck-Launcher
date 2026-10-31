import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import {
  Blocks,
  Copy,
  ExternalLink,
  FolderOpen,
  Languages,
  RefreshCw,
  ShieldOff,
  Tag,
  Wand2,
} from "lucide-react";
import type { ModEntry } from "../types";
import { t } from "../i18n";

export interface ModContextMenuState {
  mod: ModEntry;
  x: number;
  y: number;
}

/**
 * 卡片右键菜单。
 *
 * 只用 fixed 定位 + 挂到 body 上，所以不会被网格的 overflow 裁掉；
 * 打开时先按视口做一次内翻修正，再允许用户用 Esc / 点空白关掉。
 */
export function ModContextMenu({
  state,
  onClose,
  onToggle,
  onRepair,
  onOpenFolder,
  onOpenNexus,
  onCopyId,
  onChangeCategory,
  onAiTranslate,
  onAiPatch,
}: {
  state: ModContextMenuState;
  onClose: () => void;
  onToggle: (mod: ModEntry) => void;
  onRepair: (mod: ModEntry) => void;
  onOpenFolder: (mod: ModEntry) => void;
  onOpenNexus: (mod: ModEntry) => void;
  onCopyId: (mod: ModEntry) => void;
  /** 手动改分类：自动推断分错了，就让玩家自己指定，写入后锁定不再被重算覆盖。 */
  onChangeCategory: (mod: ModEntry) => void;
  /** AI 汉化（T5）：生成独立中文覆盖层，不改原 Mod 文件。 */
  onAiTranslate: (mod: ModEntry) => void;
  /** AI 补丁（T6）：针对脚本冲突生成独立 .reds 补丁。 */
  onAiPatch: (mod: ModEntry) => void;
}) {
  const { mod, x, y } = state;
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  // 边缘检测：接近右/下边界时向内翻，留 10px 安全边距。
  useLayoutEffect(() => {
    const node = menuRef.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    const margin = 10;
    let left = x;
    let top = y;
    if (left + rect.width + margin > window.innerWidth) {
      left = Math.max(margin, window.innerWidth - rect.width - margin);
    }
    if (top + rect.height + margin > window.innerHeight) {
      top = Math.max(margin, window.innerHeight - rect.height - margin);
    }
    setPos({ left, top });
  }, [x, y]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    // 捕获阶段：卡片自身的 onClick 不会先把菜单关掉再触发动作。
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [onClose]);

  const nexusId = mod.nexus?.modId ? String(mod.nexus.modId) : null;

  return (
    <div
      ref={menuRef}
      className="mod-context-menu"
      style={{ left: pos.left, top: pos.top }}
      role="menu"
      aria-label={t("modContext.menuAria", { name: mod.name })}
    >
      <div className="mod-context-head">
        <span className="mod-context-name">{mod.name}</span>
        <span className="mod-context-id">{mod.id.slice(0, 14)}</span>
      </div>

      <MenuItem
        icon={<Blocks size={13} />}
        label={mod.enabled ? t("modContext.undeploy") : t("modContext.deploy")}
        hint={mod.enabled ? t("modContext.hintUnlink") : t("modContext.hintLink")}
        onSelect={() => {
          onToggle(mod);
          onClose();
        }}
      />
      <MenuItem
        icon={<RefreshCw size={13} />}
        label={t("modContext.repair")}
        hint={t("modContext.repairHint")}
        onSelect={() => {
          onRepair(mod);
          onClose();
        }}
      />

      <MenuItem
        icon={<Tag size={13} />}
        label={t("modContext.changeCategory")}
        hint={mod.categoryLocked ? t("modContext.categoryLocked") : undefined}
        onSelect={() => {
          onChangeCategory(mod);
          onClose();
        }}
      />

      <div className="mod-context-sep" />

      <MenuItem
        icon={<Languages size={13} />}
        label={t("aiTools.menuTranslate")}
        hint={t("aiTools.menuTranslateHint")}
        onSelect={() => {
          onAiTranslate(mod);
          onClose();
        }}
      />
      <MenuItem
        icon={<Wand2 size={13} />}
        label={t("aiTools.menuPatch")}
        hint={t("aiTools.menuPatchHint")}
        onSelect={() => {
          onAiPatch(mod);
          onClose();
        }}
      />

      <div className="mod-context-sep" />

      <MenuItem
        icon={<FolderOpen size={13} />}
        label={t("modContext.openFolder")}
        onSelect={() => {
          onOpenFolder(mod);
          onClose();
        }}
      />
      <MenuItem
        icon={<ExternalLink size={13} />}
        label={t("modContext.openNexus")}
        disabled={!nexusId}
        hint={nexusId ? t("modContext.nexusHint", { id: nexusId }) : t("modContext.localNoSource")}
        onSelect={() => {
          onOpenNexus(mod);
          onClose();
        }}
      />
      <MenuItem
        icon={<Copy size={13} />}
        label={t("modContext.copyId")}
        hint={mod.id}
        onSelect={() => {
          onCopyId(mod);
          onClose();
        }}
      />

      {mod.enabled ? (
        <>
          <div className="mod-context-sep" />
          <MenuItem
            icon={<ShieldOff size={13} />}
            label={t("modContext.disableOnly")}
            onSelect={() => {
              onToggle(mod);
              onClose();
            }}
          />
        </>
      ) : null}
    </div>
  );
}

function MenuItem({
  icon,
  label,
  hint,
  disabled,
  onSelect,
}: {
  icon: ReactNode;
  label: string;
  hint?: string;
  disabled?: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      className="mod-context-item"
      disabled={disabled}
      onClick={onSelect}
    >
      <span className="mod-context-icon">{icon}</span>
      <span className="mod-context-label">{label}</span>
      {hint ? <span className="mod-context-hint">{hint}</span> : null}
    </button>
  );
}
