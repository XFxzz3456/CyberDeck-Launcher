import { useEffect, useState } from "react";
import { Copy, Minus, Square, X } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isTauri } from "../lib/api";
import { t } from "../i18n";
import { useAppVersion } from "../lib/appVersion";

// window.js 已被 webview.js 静态依赖打进主包，动态导入不会分出 chunk，
// 反而触发构建警告（E1 收尾），改为静态导入。
async function windowAction(action: "minimize" | "maximize" | "close") {
  if (!isTauri) return;
  const current = getCurrentWindow();
  if (action === "minimize") await current.minimize();
  if (action === "maximize") await current.toggleMaximize();
  if (action === "close") await current.close();
}

export function TitleBar({ demoMode }: { demoMode: boolean }) {
  // 版本号动态读取：这里曾硬编码「CDL 0.7.0」，升版后顶栏还挂着旧号（r22 修）。
  const appVersion = useAppVersion();
  /**
   * 最大化状态必须来自窗口本身，不能靠本地开关：
   * 用户双击标题栏、拖到屏幕顶部触发 Aero Snap、或从任务栏还原，
   * 都不会经过我们的按钮。所以挂 `onResized` 监听（最大化/还原必然改尺寸），
   * 再兜一次手动查询——启动时就已经是最大化的情形事件不会补发。
   */
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!isTauri) return;
    const current = getCurrentWindow();
    let disposed = false;
    let timer = 0;

    const sync = () => {
      // 防抖：拖动改变窗口大小时 onResized 会连发几十次，每次都要跨进程
      // 问一次窗口状态，不节流会明显卡顿。
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        void current
          .isMaximized()
          .then((value) => {
            if (!disposed) setMaximized(value);
          })
          .catch(() => {
            /* 取不到状态就维持当前图标，不为一个图标打断用户 */
          });
      }, 120);
    };

    sync();
    const unlistenPromise = current.onResized(() => sync());
    return () => {
      disposed = true;
      window.clearTimeout(timer);
      void unlistenPromise.then((unlisten) => unlisten()).catch(() => undefined);
    };
  }, []);

  /**
   * 拖动/双击最大化全部交给 Tauri 注入的 drag.js（r41 重构）。
   *
   * 之前这里是 React onMouseDown + onPointerDown 主动调 startDragging()，同时容器上
   * 还留着 data-tauri-drag-region——两条通路在同一次 mousedown 里各调一次
   * `plugin:window|start_dragging`，第二次落进第一次已开启的系统模态拖动循环，
   * 窗口位移叠加成一块跟着鼠标跑的花白残影。
   *
   * 现在只留属性。Tauri 2.12.5 的 drag.js 支持 `data-tauri-drag-region="deep"`：
   * 子树内任意位置（含文字 span）都能拖，BUTTON/INPUT/SELECT/TEXTAREA/A 等可交互
   * 标签自动阻断，双击由它内部发 internal_toggle_maximize。
   */
  return (
    <header className="titlebar" data-tauri-drag-region="deep">
      <div className="titlebar-brand">
        <span className="brand-slash">///</span>
        <span className="brand-name">{t("titleBar.brandName")}</span>
        <span className="brand-divider">//</span>
        <span className="brand-sub">{t("titleBar.brandSub")}</span>
      </div>
      <div className="titlebar-center">
        <span className="titlebar-game">{t("titleBar.game")}</span>
        <span className="titlebar-build">{t("titleBar.build", { version: appVersion })}</span>
        {demoMode ? <span className="titlebar-demo">{t("titleBar.demo")}</span> : null}
      </div>
      {/* "false" = 该子树禁拖：按钮之间没有缝隙也绝不会被当成标题栏把手。 */}
      <div className="titlebar-controls" data-tauri-drag-region="false">
        <button
          className="window-btn"
          aria-label={t("titleBar.minimize")}
          onClick={() => void windowAction("minimize")}
        >
          <Minus size={14} />
        </button>
        <button
          className="window-btn"
          aria-label={maximized ? t("titleBar.restore") : t("titleBar.maximize")}
          title={maximized ? t("titleBar.restore") : t("titleBar.maximize")}
          onClick={() => void windowAction("maximize")}
        >
          {/* Windows 原生：最大化后按钮换成「向下还原」的双层方框。 */}
          {maximized ? <Copy size={11} /> : <Square size={11} />}
        </button>
        <button
          className="window-btn window-close"
          aria-label={t("titleBar.close")}
          onClick={() => void windowAction("close")}
        >
          <X size={14} />
        </button>
      </div>
    </header>
  );
}
