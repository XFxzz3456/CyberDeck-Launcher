/**
 * 键盘打开右键菜单。
 *
 * 鼠标右键能用，键盘也必须能用：Windows 的系统约定是菜单键（`ContextMenu`）
 * 与 `Shift+F10`。菜单本体（`ModContextMenu`）已经做好了焦点进入、↑↓/Home/End
 * 导航和 Esc 关闭，缺的只是「怎么触发」这一步。
 *
 * 键盘没有鼠标坐标，所以锚点取触发元素左上角内缩一点——菜单出现在卡片旁，
 * 而不是视口原点（0,0）。`getBoundingClientRect()` 给的是视觉坐标，和
 * `MouseEvent.clientX/clientY` 同一套坐标系（见 `uiScale.ts` 的说明），
 * 下游再按 zoom 折算一次即可，不会算两遍。
 */
import type { MouseEvent as ReactMouseEvent } from "react";

/** 是否是「打开右键菜单」的快捷键。 */
export function isContextMenuKey(event: {
  key: string;
  shiftKey: boolean;
}): boolean {
  return event.key === "ContextMenu" || (event.shiftKey && event.key === "F10");
}

/**
 * 给 `onContextMenu` 造一个只含必要字段的事件替身。
 *
 * 为什么不改下游签名：`onContextMenu` 由 `LibraryView` 定义、经虚拟列表转发到
 * 卡片/行，改签名要同时动三处；而下游真正用到的只有 `clientX` / `clientY` /
 * `preventDefault()`，替身足够且不会误用其它字段。
 */
export function keyboardContextMenuEvent(element: HTMLElement): ReactMouseEvent {
  const rect = element.getBoundingClientRect();
  return {
    clientX: rect.left + 16,
    clientY: rect.top + 16,
    currentTarget: element,
    target: element,
    preventDefault: () => {},
    stopPropagation: () => {},
  } as unknown as ReactMouseEvent;
}
