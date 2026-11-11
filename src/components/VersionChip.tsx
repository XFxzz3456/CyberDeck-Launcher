import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";
import type { ModEntry } from "../types";
import { formatBytes } from "../lib/format";
import { currentUiZoom } from "../lib/uiScale";
import { t } from "../i18n";

/**
 * 同一 mod 的版本切换胶囊。
 *
 * ## 为什么浮层要挂 body
 *
 * `.mod-card` 是固定高度 + `overflow: hidden`（封面裁切要靠它），列表行的
 * `.mod-row` 也限制了高度。下拉如果留在卡片内部，会被裁成一条缝；而
 * `position: fixed` 在这里同样不可靠——祖先有 `transform`（framer 的 hover
 * 抬升）/ `filter` / `backdrop-filter` 时，包含块会被改成那个祖先。
 * 所以走 portal，并把坐标在**视觉坐标系**里夹取，最后一次除以 body 的 zoom
 * 换回浮层自己的坐标系（与 ProfileMenu / ModContextMenu 同一套做法）。
 *
 * ## 交互
 *
 * 只有一个版本时组件直接返回 null——调用方不用自己判断，卡片上也不会多出
 * 一个点了没反应的按钮。切换中途 `busy` 置灰，防止连点触发两次部署。
 */
const MENU_MIN_WIDTH = 210;
const MENU_MAX_HEIGHT = 280;
const MENU_GAP = 6;
const VIEWPORT_MARGIN = 10;

interface MenuPos {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
}

export function VersionChip({
  current,
  versions,
  busy,
  onSwitch,
  placement = "cover",
}: {
  /** 当前代表这一张卡的条目（正在启用的那个，或版本最高的）。 */
  current: ModEntry;
  /** 该 mod 的全部版本，新→旧。 */
  versions: ModEntry[];
  busy: boolean;
  onSwitch: (version: ModEntry) => void;
  /** cover = 卡片封面底栏（向上弹）；row = 列表行（对齐右侧）。 */
  placement?: "cover" | "row";
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<MenuPos | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // 点外面 / Esc 收起。菜单是 portal，不能用「祖先包含」判断，两个 ref 都查。
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target)) return;
      if (triggerRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  // 先渲染再量高度，才能决定往上还是往下弹。
  //
  // 注意：这里**不能**把「测量结果」当作浮层的渲染条件——菜单要先挂上 DOM 才能
  // 量到高度，用 `open && pos` 当条件就成了死锁（实测：aria-expanded 变 true，
  // 但菜单永远不出现）。所以首帧先渲染在视口外，layout effect 量完再摆到位，
  // 因为是在绘制前跑，用户看不到这一帧。
  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const trigger = triggerRef.current;
    const menu = menuRef.current;
    if (!trigger || !menu) return;
    const rect = trigger.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    const zoom = currentUiZoom();
    const viewW = window.innerWidth;
    const viewH = window.innerHeight;
    const width = Math.min(
      Math.max(Math.round(rect.width), MENU_MIN_WIDTH),
      viewW - VIEWPORT_MARGIN * 2,
    );
    const left = Math.min(
      Math.max(VIEWPORT_MARGIN, Math.round(rect.left)),
      Math.max(VIEWPORT_MARGIN, viewW - width - VIEWPORT_MARGIN),
    );
    // 默认向上（卡片底栏贴底，往下必然会出界），放不下再翻到下面。
    let top = Math.round(rect.top - menuRect.height - MENU_GAP);
    if (top < VIEWPORT_MARGIN) top = Math.round(rect.bottom + MENU_GAP);
    const maxHeight = Math.max(
      120,
      Math.min(MENU_MAX_HEIGHT, viewH - top - VIEWPORT_MARGIN),
    );
    setPos({
      top: top / zoom,
      left: left / zoom,
      width: width / zoom,
      maxHeight: maxHeight / zoom,
    });
  }, [open, versions.length]);

  if (versions.length <= 1) return null;

  const label = current.version ? `v${current.version}` : t("modCard.noVersion");

  return (
    <div
      className={`version-chip placement-${placement} ${open ? "is-open" : ""}`}
      // 卡片本身是按钮（打开详情）：这里所有交互都不许冒泡，否则点版本会顺带开抽屉。
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.stopPropagation()}
    >
      <button
        ref={triggerRef}
        type="button"
        className="version-chip-btn"
        disabled={busy}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={t("version.switchTitle", { count: versions.length })}
        onClick={(event) => {
          event.stopPropagation();
          setOpen((value) => !value);
        }}
      >
        <span className="version-chip-label">{label}</span>
        <span className="version-chip-count">{versions.length}</span>
        <ChevronDown size={11} />
      </button>
      {open
        ? createPortal(
            <div
              ref={menuRef}
              className="version-menu"
              role="listbox"
              aria-label={t("version.menuAria")}
              style={{
                // 首帧先放到视口外，量完位置再摆过去（见上方 useLayoutEffect 的说明）。
                top: pos?.top ?? -9999,
                left: pos?.left ?? 0,
                width: pos?.width ?? MENU_MIN_WIDTH,
                maxHeight: pos?.maxHeight ?? MENU_MAX_HEIGHT,
              }}
              onClick={(event) => event.stopPropagation()}
              onPointerDown={(event) => event.stopPropagation()}
            >
              <div className="version-menu-head">{t("version.menuTitle")}</div>
              {versions.map((version) => {
                const active = version.id === current.id;
                return (
                  <button
                    key={version.id}
                    type="button"
                    role="option"
                    aria-selected={active}
                    className={`version-item ${active ? "is-current" : ""}`}
                    disabled={busy}
                    onClick={(event) => {
                      event.stopPropagation();
                      setOpen(false);
                      if (!active) onSwitch(version);
                    }}
                  >
                    <span className="version-item-version">
                      {version.version ? `v${version.version}` : t("modCard.noVersion")}
                    </span>
                    <span className="version-item-meta">
                      {active
                        ? t("version.activeTag")
                        : version.enabled
                          ? t("version.alsoEnabledTag", { size: formatBytes(version.sizeBytes) })
                          : formatBytes(version.sizeBytes)}
                    </span>
                    {active ? <Check size={12} className="version-item-check" /> : null}
                  </button>
                );
              })}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
