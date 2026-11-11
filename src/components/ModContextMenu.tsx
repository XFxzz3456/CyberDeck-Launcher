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
  Trash2,
  Wand2,
} from "lucide-react";
import type { ModEntry } from "../types";
import { t } from "../i18n";
import { currentUiZoom } from "../lib/uiScale";

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
  onUninstall,
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
  /** 删除模组（删暂存副本 + 撤链接 + 从库里移除）。走统一的危险确认流程。 */
  onUninstall: (mod: ModEntry) => void;
}) {
  const { mod, x, y } = state;
  const menuRef = useRef<HTMLDivElement>(null);
  // x/y 是鼠标的视觉坐标（body 上还有 zoom），写进 style 前必须先除一次缩放。
  const [pos, setPos] = useState(() => {
    const zoom = currentUiZoom();
    return { left: x / zoom, top: y / zoom };
  });

  // 边缘检测：接近右/下边界时向内翻，留 10px 安全边距。
  // 夹取全程在视觉坐标里做（鼠标坐标、rect、innerWidth 同属一套坐标系），
  // 最后一次性除以 body 的 zoom 换回浮层自己的坐标系——否则 125% 下菜单会
  // 落在鼠标右下方几十到上百像素处，看起来就是「菜单和右键位置不在一起」。
  useLayoutEffect(() => {
    const node = menuRef.current;
    if (!node) return;
    const zoom = currentUiZoom();
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
    setPos({ left: left / zoom, top: top / zoom });
  }, [x, y]);

  // 键盘入口（Shift+F10 / 菜单键）打开时焦点必须进得来：以前菜单只响应鼠标，
  // 键盘用户按出来之后焦点还留在卡片上，Tab 会跑到页面别处（2026-11-10 自检 P2）。
  // 顺带支持 ↑↓ / Home / End 在菜单内移动，Esc 关掉后把焦点还给原来的卡片。
  useEffect(() => {
    const node = menuRef.current;
    if (!node) return;
    const previous =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const items = () =>
      Array.from(node.querySelectorAll<HTMLElement>(".mod-context-item:not([disabled])"));
    items()[0]?.focus();
    const onArrow = (event: KeyboardEvent) => {
      const list = items();
      if (list.length === 0) return;
      const index = list.indexOf(document.activeElement as HTMLElement);
      let next = index;
      if (event.key === "ArrowDown") next = index < 0 ? 0 : (index + 1) % list.length;
      else if (event.key === "ArrowUp") next = index <= 0 ? list.length - 1 : index - 1;
      else if (event.key === "Home") next = 0;
      else if (event.key === "End") next = list.length - 1;
      else return;
      event.preventDefault();
      list[next]?.focus();
    };
    node.addEventListener("keydown", onArrow);
    return () => {
      node.removeEventListener("keydown", onArrow);
      if (previous?.isConnected) previous.focus();
    };
  }, []);

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

      {/* 删除：库里的右键菜单以前只有「取消部署」，想彻底删掉必须先进详情面板。
          玩家在列表里整理重复/废弃条目时第一反应就是右键，缺这一项等于逼人多点两下。
          Vortex 托管的条目不在这里删：它的物理文件在 Vortex 仓库里，删了会造成
          两边状态不一致，所以置灰并说明去 Vortex 处理。 */}
      <div className="mod-context-sep" />
      <MenuItem
        icon={<Trash2 size={13} />}
        label={t("modContext.deleteMod")}
        hint={
          mod.origin === "vortex" ? t("modContext.deleteBlocked") : t("modContext.deleteHint")
        }
        disabled={mod.origin === "vortex"}
        danger
        onSelect={() => {
          onUninstall(mod);
          onClose();
        }}
      />
    </div>
  );
}

function MenuItem({
  icon,
  label,
  hint,
  disabled,
  danger = false,
  onSelect,
}: {
  icon: ReactNode;
  label: string;
  hint?: string;
  disabled?: boolean;
  danger?: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      className={`mod-context-item ${danger ? "is-danger" : ""}`}
      disabled={disabled}
      onClick={onSelect}
    >
      <span className="mod-context-icon">{icon}</span>
      <span className="mod-context-label">{label}</span>
      {hint ? <span className="mod-context-hint">{hint}</span> : null}
    </button>
  );
}
