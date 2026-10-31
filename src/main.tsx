import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource/inter/latin-400.css";
import "@fontsource/inter/latin-500.css";
import "@fontsource/inter/latin-600.css";
import "@fontsource/inter/latin-700.css";
import "@fontsource/jetbrains-mono/latin-400.css";
import "@fontsource/jetbrains-mono/latin-500.css";
import "@fontsource/rajdhani/latin-500.css";
import "@fontsource/rajdhani/latin-600.css";
import "@fontsource/rajdhani/latin-700.css";
import App from "./App";
import { AppErrorBoundary } from "./components/AppErrorBoundary";
import "./styles/index.css";

/**
 * 全局异步错误兜底。
 *
 * AppErrorBoundary 只接 render 阶段的同步错误；事件回调与 useEffect 里
 * 漏 catch 的 Promise rejection 会静默消失，用户只看到"点了没反应"。
 * 这里拦下来落一条 console 轨迹（本地应用不上报），开发态额外弹一次。
 * 只兜底、不阻断：业务代码自己的 catch 优先级更高。
 */
function installGlobalErrorHooks() {
  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason instanceof Error ? event.reason.stack ?? event.reason.message : String(event.reason);
    console.error("[unhandledrejection]", reason);
  });
  window.addEventListener("error", (event) => {
    // 资源加载失败（img/script）也走 error 事件，统一落痕即可。
    console.error("[window.onerror]", event.message, event.filename ? `${event.filename}:${event.lineno}` : "");
  });
}
installGlobalErrorHooks();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </React.StrictMode>,
);
