/**
 * 关闭 WebView2 自带的右键菜单。
 *
 * ## 为什么需要
 *
 * Tauri 的 WebView2 只要没人拦 `contextmenu`，就会弹出浏览器那套菜单
 * （返回 / 刷新 / 另存为 / 打印 / 更多工具）。它是系统级弹窗，会盖住我们自己的
 * 菜单，也让启动器看着像个网页。
 *
 * ## 为什么放在 document 的捕获阶段
 *
 * 1. 必须覆盖「没有被 React 接管的空白区域」——那里没有任何 onContextMenu；
 * 2. 又不能让自定义菜单失效：React 的 `onContextMenu` 在冒泡阶段执行，
 *    这里只 `preventDefault()` 掉默认行为、**不** `stopPropagation()`，
 *    两者不冲突。
 * 3. 用捕获阶段是为了比业务代码更早生效：万一某个组件忘了 preventDefault，
 *    也不会漏出系统菜单。
 *
 * ## 为什么放行输入类元素
 *
 * 文本框里的复制 / 粘贴 / 全选是原生菜单唯一真正有用武之地，全禁掉会挨骂。
 */
const INPUT_SELECTOR =
  'input, textarea, [contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"]';

export function installNativeMenuGuard(): () => void {
  const onContextMenu = (event: MouseEvent) => {
    const target = event.target as HTMLElement | null;
    if (target?.closest(INPUT_SELECTOR)) {
      return;
    }
    event.preventDefault();
  };
  document.addEventListener("contextmenu", onContextMenu, true);
  return () => document.removeEventListener("contextmenu", onContextMenu, true);
}

/**
 * 同理处理 F5 / Ctrl+R：WebView2 会重新加载整个前端。
 *
 * 在开发模式这是有用的，但在装着 Mod 的游戏目录上重载会把正在跑的导入 / 部署
 * 状态冲掉（后端还在跑，前端却以为没开始）。这里统一拦掉，刷新走重启。
 */
export function installReloadGuard(): () => void {
  const onKeyDown = (event: KeyboardEvent) => {
    const isReload =
      event.key === "F5" ||
      ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "r");
    if (!isReload) return;
    // 输入框里的 Ctrl+R 没有语义，但别抢用户可能想按的东西。
    const target = event.target as HTMLElement | null;
    if (target?.closest(INPUT_SELECTOR)) return;
    event.preventDefault();
  };
  window.addEventListener("keydown", onKeyDown, true);
  return () => window.removeEventListener("keydown", onKeyDown, true);
}
