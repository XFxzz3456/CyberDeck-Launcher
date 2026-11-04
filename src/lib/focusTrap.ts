import { useEffect, type RefObject } from "react";

/**
 * 弹层焦点陷阱（P3 #14）。
 *
 * 弹窗打开时键盘焦点必须留在窗内：否则 Tab 几下就跑到背后的主界面上，
 * 读屏器用户会以为弹窗已经关了，鼠标用户则看不到焦点在哪。
 *
 * 三件事：
 * 1. 打开时把焦点送进来（已有 autoFocus 元素就不抢）；
 * 2. Tab / Shift+Tab 在首尾之间循环，不逃出容器；
 * 3. 关闭时把焦点还给打开前那个元素，不要掉到 body 上。
 *
 * 只在可聚焦元素列表非空时循环；容器本身要能接住焦点（`tabIndex={-1}`），
 * 否则空列表时会「无处可去」。
 */

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    // offsetParent 为 null 说明被 display:none 或祖先隐藏掉了，跳过它，
    // 否则 Tab 会「卡」在一个看不见的按钮上。
    (item) => item.offsetParent !== null || item === document.activeElement,
  );
}

export function useFocusTrap<T extends HTMLElement>(ref: RefObject<T | null>, active: boolean) {
  useEffect(() => {
    if (!active) return;
    const root = ref.current;
    if (!root) return;

    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    if (!root.contains(document.activeElement)) {
      const first = focusables(root)[0] ?? root;
      first.focus();
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const items = focusables(root);
      if (items.length === 0) {
        event.preventDefault();
        root.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const activeEl = document.activeElement;
      if (event.shiftKey && (activeEl === first || activeEl === root)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && activeEl === last) {
        event.preventDefault();
        first.focus();
      }
    };

    root.addEventListener("keydown", onKeyDown);
    return () => {
      root.removeEventListener("keydown", onKeyDown);
      // 归还焦点。用 isConnected 判断：原来的触发按钮可能已经被卸载了
      // （例如点了列表项就把它删掉了），这时 focus() 会静默失败、焦点落回 body。
      if (previous?.isConnected) previous.focus();
    };
  }, [ref, active]);
}
