/**
 * 窗口拖动（自定义标题栏专用，2026-10-30 第二轮修复）。
 *
 * 为什么不靠 `data-tauri-drag-region`：
 * Tauri 自带的拖拽脚本只认「mousedown 命中的那个元素**本身**带属性」，
 * 命中的是文本节点所在的 span 就完全不触发——标题栏是文字叠文字的结构，
 * 于是整条几乎无处可拖。上一轮给 span 加 `pointer-events: none` 只是绕开一部分，
 * 任何新加的、带自己样式的子元素都会把拖动重新挡回去。
 *
 * 这里改成 React 的冒泡事件：mousedown 落在容器内任意位置都会走到本函数，
 * 只要目标不是可交互控件（按钮/输入框/链接…），就主动调用窗口的 startDragging()。
 * 命中判定从「元素自带属性」变成「祖先容器接管」，不会再被新增子元素破坏。
 */
import type {
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isTauri } from "./api";

/** 这些控件自己要用鼠标，不能被当成拖动把手。 */
const INTERACTIVE = [
  "button",
  "a",
  "input",
  "textarea",
  "select",
  "option",
  "label",
  '[role="button"]',
  '[contenteditable="true"]',
  "[data-no-drag]",
].join(",");

/**
 * 挂到窗口顶部容器（TitleBar / TopBar）的 onMouseDown 上。
 *
 * @param allowDoubleClick 是否把双击当「最大化/还原」。只在标题栏开：
 *   搜索栏里双击通常是选词，跟着最大化会很怪。
 */
export function beginWindowDrag(
  event: ReactMouseEvent<HTMLElement>,
  allowDoubleClick = false,
) {
  // 非 Tauri 环境（浏览器预览 / Playwright）没有窗口可拖。
  if (!isTauri) return;
  // 只响应左键：右键拖动是系统的窗口菜单，中键留给自动滚动。
  if (event.button !== 0) return;
  // 触摸/手写笔已经在 pointerdown 处理，随后生成的兼容鼠标事件不能重复拖动。
  // TypeScript 的 DOM 声明尚未包含 Chromium 的 InputDeviceCapabilities 属性。
  const native = event.nativeEvent as MouseEvent & {
    sourceCapabilities?: { firesTouchEvents: boolean };
  };
  if (native.sourceCapabilities?.firesTouchEvents) return;

  const target = event.target as HTMLElement | null;
  if (target?.closest(INTERACTIVE)) return;

  const current = getCurrentWindow();

  // 双击必须在这里判掉：startDragging() 会让 WebView 进入系统拖动循环，
  // 之后的 dblclick 事件我们收不到，标题栏双击最大化就彻底失效。
  if (allowDoubleClick && event.detail >= 2) {
    void current.toggleMaximize();
    return;
  }

  // startDragging 必须在用户手势的同步调用栈里发起，套 setTimeout 会被拒。
  // 失败时留一行控制台日志：拖动这种事没有可见报错，只能靠它排查
  // （典型原因：capabilities 里少了 core:window:allow-start-dragging）。
  void current.startDragging().catch((err) => {
    console.warn("[drag] startDragging failed:", err);
  });
}

/**
 * 触屏/手写笔的按下不会可靠地产出兼容 mousedown，单独走 Pointer Events。
 * 鼠标仍交给上面的 onMouseDown，避免 pointerdown + mousedown 连续调用两次。
 */
export function beginWindowPointerDrag(event: ReactPointerEvent<HTMLElement>) {
  if (event.pointerType === "mouse") return;
  const target = event.target as HTMLElement | null;
  if (target?.closest(INTERACTIVE)) return;
  // 阻止浏览器为该触摸序列再发 mousedown，控件未处理时不阻止默认行为。
  event.preventDefault();
  beginWindowDrag(event, false);
}
