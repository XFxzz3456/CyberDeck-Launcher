import { Download, ExternalLink, LoaderCircle, X } from "lucide-react";
import type { NxmLink } from "../types";
import { t } from "../i18n";

/** 一条 NXM 链接在前端的处理状态。 */
export type NxmItemStatus = "pending" | "downloading" | "done" | "error";

export interface NxmItem {
  link: NxmLink;
  status: NxmItemStatus;
  received?: number;
  total?: number | null;
  /** 完成时是文件名，失败时是错误摘要。 */
  message?: string;
}

const STATUS_TEXT: Record<NxmItemStatus, string> = {
  pending: t("nxmIntake.statusPending"),
  downloading: t("nxmIntake.statusDownloading"),
  done: t("nxmIntake.statusDone"),
  error: t("nxmIntake.statusError"),
};

function percent(received: number, total: number | null | undefined): string {
  if (!total || total <= 0) return "";
  return `${Math.min(100, Math.round((received / total) * 100))}%`;
}

/**
 * NXM 接收条。
 *
 * 定位：右下角常驻卡片，不抢焦点、不挡主内容。用户从 N 网点「Mod manager download」
 * 之后，视线会回到启动器，这个条就是"这次点击确实被接住了"的证据——
 * 所以它必须出现得比任何 toast 都明确，并且带着可执行的下一步。
 */
export function NxmIntake({
  items,
  onInstall,
  onOpenPage,
  onDismiss,
  onDismissAll,
}: {
  items: NxmItem[];
  onInstall: (item: NxmItem) => void;
  onOpenPage: (item: NxmItem) => void;
  onDismiss: (uri: string) => void;
  onDismissAll: () => void;
}) {
  if (items.length === 0) return null;
  return (
    <section className="nxm-intake" aria-label={t("nxmIntake.ariaLabel")}>
      <header className="nxm-intake-head">
        <span className="nxm-intake-kicker">{t("nxmIntake.kicker")}</span>
        <strong>{t("nxmIntake.headTitle", { count: items.length })}</strong>
        <button type="button" className="btn btn-ghost btn-xs" onClick={onDismissAll}>
          {t("nxmIntake.dismissAll")}
        </button>
      </header>
      <ul className="nxm-intake-list">
        {items.map((item) => {
          const { link } = item;
          const progress = percent(item.received ?? 0, item.total);
          return (
            <li key={link.uri} className={`nxm-intake-row is-${item.status}`}>
              <div className="nxm-intake-main">
                <span className="nxm-intake-id">
                  {t("nxmIntake.modId", { id: link.modId })}
                  {link.fileId ? t("nxmIntake.fileId", { id: link.fileId }) : ""}
                </span>
                <span className="nxm-intake-status">
                  {item.status === "downloading" ? <LoaderCircle size={12} className="spin" /> : null}
                  {STATUS_TEXT[item.status]}
                  {item.status === "downloading" && progress ? ` ${progress}` : ""}
                  {item.message ? ` · ${item.message}` : ""}
                </span>
              </div>
              {item.status === "downloading" ? (
                <div className="nxm-intake-bar" aria-hidden="true">
                  <span
                    style={{
                      width: item.total ? `${Math.min(100, ((item.received ?? 0) / item.total) * 100)}%` : "35%",
                    }}
                  />
                </div>
              ) : null}
              <div className="nxm-intake-actions">
                {item.status === "pending" || item.status === "error" ? (
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => onInstall(item)}
                    disabled={!link.fileId}
                    title={link.fileId ? t("nxmIntake.installTitle") : t("nxmIntake.installNoFileTitle")}
                  >
                    <Download size={13} /> {item.status === "error" ? t("common.retry") : t("nxmIntake.downloadImport")}
                  </button>
                ) : null}
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => onOpenPage(item)}>
                  <ExternalLink size={13} /> {t("nxmIntake.openPage")}
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => onDismiss(link.uri)}
                  aria-label={t("nxmIntake.dismissAria")}
                >
                  <X size={13} />
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
