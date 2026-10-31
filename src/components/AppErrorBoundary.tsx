import { Component, type ErrorInfo, type ReactNode } from "react";
import { t } from "../i18n";

/**
 * 最外层兜底：任何未捕获的渲染错误都不该让用户面对一块黑屏。
 *
 * 卡片级的 `ModCardErrorBoundary` 只保护「单张卡片渲染」。
 * 2026-10-26 门禁实测发现另一类白屏：错误发生在卡片**之外**（排序/筛选/统计），
 * React 会把整个 root 卸载，用户看到的是纯黑窗口、没有任何按钮可用。
 * 这一层负责把那种情况变成「能看懂 + 能重试」的界面。
 */
export class AppErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // 留痕到控制台，真机排查时配合 startup.log 一起看（开发者日志，不进词表）。
    console.error("[CDL] 界面渲染失败", error, info.componentStack); // i18n-ignore
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="root-fault" role="alert">
        <div className="root-fault-card">
          <span className="root-fault-code">{t("errorBoundary.appCode")}</span>
          <h1>{t("errorBoundary.appTitle")}</h1>
          <p>{t("errorBoundary.appDetail")}</p>
          <pre className="root-fault-detail">{error.message || String(error)}</pre>
          <div className="root-fault-actions">
            <button className="btn btn-primary" onClick={() => window.location.reload()}>
              {t("errorBoundary.reload")}
            </button>
            <button
              className="btn"
              onClick={() => {
                void navigator.clipboard?.writeText(`${error.message}\n${error.stack ?? ""}`);
              }}
            >
              {t("errorBoundary.copyError")}
            </button>
          </div>
        </div>
      </div>
    );
  }
}
