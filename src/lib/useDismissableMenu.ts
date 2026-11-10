import { useEffect, useRef, type RefObject } from "react";

/**
 * 下拉菜单的「点外面 / 按 Esc 关掉」。
 *
 * 同一个模式在本项目里被复制了 5 份（导入 / 补全 / AI / 分类 / 溢出菜单），
 * 每份 20 行，改一处忘一处 —— 2026-11-10 自检把它列进 P2 的重复逻辑。
 *
 * 两个细节是有意为之：
 * - 用 `pointerdown` 而不是 `click`：鼠标按下即收起，符合桌面软件手感；
 *   用 click 时菜单项自己的点击会先被「点外面」判定抢走一次。
 * - `close` 走 ref：调用点普遍传内联箭头函数，每次渲染都换引用；放进依赖数组
 *   会让监听器每帧重建，容易漏事件。
 */
export function useDismissableMenu(
  open: boolean,
  ref: RefObject<HTMLElement | null>,
  close: () => void,
): void {
  const closeRef = useRef(close);
  useEffect(() => {
    closeRef.current = close;
  }, [close]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        closeRef.current();
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeRef.current();
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open, ref]);
}
