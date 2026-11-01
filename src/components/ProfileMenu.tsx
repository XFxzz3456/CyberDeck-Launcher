import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, Layers } from "lucide-react";
import type { ProfileList } from "../types";
import { Spinner } from "./ui";
import { t } from "../i18n";

/** 菜单最小宽度：名字短的时候也要有可读的点击区，同时保证不会窄成一条。 */
const MENU_MIN_WIDTH = 216;
/** 菜单与窗口边缘的最小留白：贴着边线会被裁掉圆角、看着像溢出。 */
const VIEWPORT_MARGIN = 10;
/** 菜单最大高度，超过就内部滚动（配置集很多时仍然整块可见）。 */
const MENU_MAX_HEIGHT = 320;
/** 菜单与触发器的垂直间距。 */
const MENU_GAP = 6;

/**
 * 当前 UI 缩放系数。
 *
 * `body` 上有 `zoom: var(--ui-scale)`（设置页 90 / 100 / 110% 三档）。浮层挂在 body
 * 里，它的 `position: fixed` 坐标是在 **zoom 之后**的坐标系里解释的；而
 * `getBoundingClientRect()` 给的却是屏幕视觉坐标（已经缩放过了）。直接把视觉坐标
 * 写进 `style.left` 等于把缩放算两遍：110% 下浮层右飘 80px、90% 下左飘 66px，
 * 这正是「播放集下拉歪了」的真因（改锚点只修好了 100% 那一档）。
 */
function currentZoom(): number {
  const raw = Number.parseFloat(getComputedStyle(document.body).zoom || "1");
  return Number.isFinite(raw) && raw > 0 ? raw : 1;
}

type MenuPos = { top: number; left: number; width: number; maxHeight: number };

/**
 * 顶栏播放集切换器。
 *
 * 为什么不用原生 `<select>`：Windows 下它的展开列表由 WebView2 之外的操作系统
 * 弹层绘制，主题色、字号、圆角全部无从控制，暗色主题里会突然冒出一块浅灰系统菜单；
 * 也无法保证「不超出窗口边界」（系统按屏幕算，不按窗口算）。这里改成自绘浮层，
 * 位置用 `position: fixed` + 视口夹取算出来，窗口再窄也不会被裁掉。
 */
export function ProfileMenu({
  profiles,
  switching,
  onSwitch,
}: {
  profiles: ProfileList | null;
  switching: boolean;
  onSwitch: (profileId: string) => void;
}) {
  const items = profiles?.profiles ?? [];
  const activeId = profiles?.activeProfileId ?? null;
  const current = items.find((item) => item.id === activeId) ?? null;

  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<MenuPos | null>(null);
  const [cursor, setCursor] = useState(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  // 定位锚点用**外层胶囊**（.profile-picker），不是内层按钮。
  // 内层 .profile-trigger 从图标右侧才开始（图标 14px + 7px 间距），
  // 拿它当锚点会让菜单整体右飘 11px——用户看到的「下拉歪了」就是这个。
  const pickerRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const disabled = switching || items.length === 0;

  /** 以触发按钮为锚点算浮层位置：左侧超界就往右夹，右侧超界就往左推。 */
  const place = () => {
    const anchor = pickerRef.current ?? triggerRef.current;
    if (!anchor) return;
    // 视觉坐标（已含 zoom），下面的夹取也全部在视觉坐标里做，
    // 最后一次性除以 zoom 换回浮层自己的坐标系。
    const rect = anchor.getBoundingClientRect();
    const zoom = currentZoom();
    const viewW = window.innerWidth;
    const viewH = window.innerHeight;
    const width = Math.min(Math.max(Math.round(rect.width), MENU_MIN_WIDTH), viewW - VIEWPORT_MARGIN * 2);
    const left = Math.min(
      Math.max(VIEWPORT_MARGIN, Math.round(rect.left)),
      Math.max(VIEWPORT_MARGIN, viewW - width - VIEWPORT_MARGIN),
    );
    const top = Math.round(rect.bottom + MENU_GAP);
    const maxHeight = Math.max(120, Math.min(MENU_MAX_HEIGHT, viewH - top - VIEWPORT_MARGIN));
    setPos({
      top: top / zoom,
      left: left / zoom,
      width: width / zoom,
      maxHeight: maxHeight / zoom,
    });
  };

  useLayoutEffect(() => {
    if (open) place();
  }, [open]);

  // 打开时把焦点交给菜单本体：方向键 / 回车 / Esc 都在这一个节点上处理。
  useEffect(() => {
    if (open) menuRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      setOpen(false);
    };
    // 窗口尺寸变了浮层位置就失效：直接收起，比跟着重排更不容易出现错位残影。
    const onViewportChange = () => setOpen(false);
    // Esc 兜底：菜单没拿到焦点时（例如焦点还在别处被程序抢走）也要能关。
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", onViewportChange);
    window.addEventListener("blur", onViewportChange);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onViewportChange);
      window.removeEventListener("blur", onViewportChange);
    };
  }, [open]);

  const openMenu = () => {
    if (disabled) return;
    const index = items.findIndex((item) => item.id === activeId);
    setCursor(index >= 0 ? index : 0);
    setOpen(true);
  };

  const closeMenu = (refocus = false) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  };

  const pick = (profileId: string) => {
    closeMenu(true);
    if (profileId !== activeId) onSwitch(profileId);
  };

  const onMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      setCursor((value) => Math.min(items.length - 1, Math.max(0, value + delta)));
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      setCursor(event.key === "Home" ? 0 : items.length - 1);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      const item = items[cursor];
      if (item) pick(item.id);
      return;
    }
    if (event.key === "Escape" || event.key === "Tab") {
      event.preventDefault();
      closeMenu(true);
    }
  };

  const label = current?.name ?? (items.length === 0 ? t("topBar.profileEmpty") : t("topBar.profileFallback"));

  return (
    <div
      className="profile-picker"
      data-switching={switching ? "true" : "false"}
      data-tauri-drag-region="false"
      ref={pickerRef}
    >
      <button
        ref={triggerRef}
        type="button"
        className="profile-trigger"
        onClick={() => (open ? closeMenu() : openMenu())}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            openMenu();
          }
        }}
        disabled={disabled}
        title={t("topBar.profilePickerTitle")}
        aria-label={t("topBar.profilePickerAria")}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <Layers size={14} className="profile-icon" />
        <span className="profile-name">{label}</span>
        {switching ? <Spinner size={12} /> : <ChevronDown size={12} className="profile-caret" />}
      </button>
      {/* 必须挂到 body：`.profile-picker` 带 clip-path（切角），而 clip-path 会
          把 fixed 子元素一起裁到那块小角标里；`.topbar` 的 backdrop-filter 也会
          把 fixed 的包含块改成自己。走 portal 才能让坐标真正相对视口。 */}
      {open && pos
        ? createPortal(
            <div
              ref={menuRef}
              className="profile-menu"
              role="listbox"
              aria-label={t("topBar.profilePickerAria")}
              tabIndex={-1}
              onKeyDown={onMenuKeyDown}
              aria-activedescendant={items[cursor] ? `profile-opt-${items[cursor].id}` : undefined}
              style={{ top: pos.top, left: pos.left, width: pos.width, maxHeight: pos.maxHeight }}
            >
              {items.map((item, index) => (
                <div
                  key={item.id}
                  id={`profile-opt-${item.id}`}
                  role="option"
                  aria-selected={item.id === activeId}
                  className="profile-menu-item"
                  data-active={index === cursor ? "true" : "false"}
                  onMouseEnter={() => setCursor(index)}
                  onClick={() => pick(item.id)}
                >
                  <span className="profile-menu-name" title={item.name}>
                    {item.name}
                  </span>
                  {item.id === activeId ? <Check size={13} className="profile-menu-check" /> : null}
                </div>
              ))}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
