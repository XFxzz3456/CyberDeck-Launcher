import { t } from "../i18n";
import "./SafetyCards.css";

/**
 * 兼容性角标（看板【13】B）。stale = 确定不适配；warn = 兼容性未知（不误报）。
 */
export function CompatBadge({ level }: { level: "stale" | "warn" | null }) {
  if (!level) return null;
  return (
    <span
      className={`compat-badge compat-badge-${level}`}
      title={level === "stale" ? t("compat.staleTip") : t("compat.warnTip")}
    >
      {level === "stale" ? t("compat.staleLabel") : t("compat.warnLabel")}
    </span>
  );
}
