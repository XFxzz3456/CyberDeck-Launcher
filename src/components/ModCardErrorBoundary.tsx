import { Component, type ErrorInfo, type ReactNode } from "react";
import { t } from "../i18n";

/**
 * 单张 Mod 卡片的渲染兜底。
 *
 * 卡片会读一堆可能缺失的字段（封面、翻译名、冲突列表、依赖状态），
 * 一条脏数据不该让整个模组库白屏。这里做最小颗粒度的隔离：
 * 出错的那一张显示暗红色告警块，其余卡片照常渲染，控制台留下 mod_id 方便排查。
 */
export class ModCardErrorBoundary extends Component<
  { modId: string; modName?: string; children: ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // 控制台留痕：哪个 mod 坏了、坏在哪一帧组件栈里。
    console.error(
      `[CDL] Mod 卡片渲染失败 mod_id=${this.props.modId} name=${this.props.modName ?? "?"}`, // i18n-ignore
      error,
      info.componentStack,
    );
  }

  render() {
    if (this.state.error) {
      return (
        <div className="mod-card mod-card-error" role="alert">
          <div className="mod-card-error-body">
            <span className="mod-card-error-code">{t("errorBoundary.cardCode")}</span>
            <span className="mod-card-error-name">{this.props.modName ?? this.props.modId}</span>
            <span className="mod-card-error-id">{this.props.modId}</span>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
