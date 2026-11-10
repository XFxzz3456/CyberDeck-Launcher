/**
 * 当前 UI 缩放系数。
 *
 * `body` 上有 `zoom: var(--ui-scale)`（设置页 90 / 100 / 110%，自定义允许 80–150）。
 * 挂在 body 里的浮层用 `position: fixed`，它的 `left/top` 是在 **zoom 之后**的坐标系
 * 里解释的；而 `getBoundingClientRect()` 与鼠标事件给的 `clientX/clientY` 都是视觉
 * 坐标（已经缩放过了）。把视觉坐标直接写进 `style.left` 等于把缩放算两遍：
 * 125% 下浮层右飘近一半屏宽，90% 下左飘几十像素。
 *
 * 所以规则只有一条：**凡是把鼠标/元素坐标写进浮层 `left/top` 的地方，先除以它。**
 * （播放集下拉、卡片右键菜单都是这个坑，别再各写一份。）
 */
export function currentUiZoom(): number {
  if (typeof window === "undefined" || typeof document === "undefined") return 1;
  const raw = Number.parseFloat(getComputedStyle(document.body).zoom || "1");
  return Number.isFinite(raw) && raw > 0 ? raw : 1;
}
