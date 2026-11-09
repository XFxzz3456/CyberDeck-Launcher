import { useEffect, useMemo, useState } from "react";
import {
  CheckCircle2,
  CircleAlert,
  Clock,
  Link2,
  MinusCircle,
  RefreshCw,
  ShieldAlert,
  X,
} from "lucide-react";
import type {
  AdoptCandidate,
  AdoptProgress,
  AdoptReport,
  AdoptScanReport,
} from "../types";
import { formatBytes } from "../lib/format";
import { t } from "../i18n";
import { Modal, Spinner } from "./ui";

/** 单个候选在执行期的展示状态。 */
type RowState = "pending" | "running" | "done" | "failed" | "skipped" | "cancelled";

/**
 * 收编预览面板：汇总条 + 候选复选列表 + 执行进度 + 失败重试。
 * 已被托管的候选默认不勾选；跨卷时顶部出现复制警告带。
 */
export function AdoptPreviewDialog({
  open,
  scan,
  loading,
  executing,
  progress,
  report,
  onClose,
  onRefresh,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  scan: AdoptScanReport | null;
  loading: boolean;
  executing: boolean;
  progress: AdoptProgress | null;
  report: AdoptReport | null;
  onClose: () => void;
  onRefresh: () => void;
  onConfirm: (selected: AdoptCandidate[]) => void;
  onCancel: () => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // 每次拿到新扫描结果就重置勾选：已被托管的默认不勾。
  useEffect(() => {
    if (!scan) {
      setSelected(new Set());
      return;
    }
    setSelected(
      new Set(scan.candidates.filter((item) => !item.alreadyManaged).map((item) => item.id)),
    );
  }, [scan]);

  const outcomeMap = useMemo(() => {
    const map = new Map<string, AdoptReport["outcomes"][number]>();
    for (const outcome of report?.outcomes ?? []) map.set(outcome.id, outcome);
    return map;
  }, [report]);

  const candidates = scan?.candidates ?? [];
  const totalFiles = candidates.reduce((sum, item) => sum + item.files.length, 0);
  const selectable = candidates.filter((item) => !item.alreadyManaged);
  const selectedCandidates = candidates.filter((item) => selected.has(item.id));

  const failedCandidates = useMemo(() => {
    if (!report || report.failed === 0) return [];
    return candidates.filter((item) => {
      const outcome = outcomeMap.get(item.id);
      return outcome && !outcome.adopted && outcome.error?.code !== "ADOPT_ALREADY_MANAGED"
        && !item.alreadyManaged;
    });
  }, [candidates, outcomeMap, report]);

  const rowState = (candidate: AdoptCandidate, index: number): RowState => {
    if (report) {
      const outcome = outcomeMap.get(candidate.id);
      if (!outcome) return "pending";
      if (outcome.adopted) return "done";
      if (outcome.error?.code === "ADOPT_ALREADY_MANAGED") return "skipped";
      return "failed";
    }
    if (executing && progress) {
      if (index < progress.current) return "done";
      if (index === progress.current) {
        if (progress.phase === "failed") return "failed";
        if (progress.phase === "cancelled") return "cancelled";
        return "running";
      }
    }
    return "pending";
  };

  const toggle = (id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const stateView = (state: RowState) => {
    switch (state) {
      case "running":
        return <span className="adopt-state running"><Spinner size={13} /> {t("adoptPreview.stateRunning")}</span>;
      case "done":
        return <span className="adopt-state done"><CheckCircle2 size={14} /> {t("adoptPreview.stateDone")}</span>;
      case "failed":
        return <span className="adopt-state failed"><CircleAlert size={14} /> {t("adoptPreview.stateFailed")}</span>;
      case "skipped":
        return <span className="adopt-state skipped"><MinusCircle size={14} /> {t("adoptPreview.stateSkipped")}</span>;
      case "cancelled":
        return <span className="adopt-state cancelled"><X size={14} /> {t("adoptPreview.stateCancelled")}</span>;
      default:
        return <span className="adopt-state pending"><Clock size={14} /> {t("adoptPreview.statePending")}</span>;
    }
  };

  return (
    <Modal
      open={open}
      title={t("adoptPreview.title")}
      eyebrow={t("adoptPreview.eyebrow")}
      width={680}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onRefresh} disabled={executing || loading}>
            {loading ? <Spinner size={13} /> : <RefreshCw size={13} />} {t("adoptPreview.rescan")}
          </button>
          {executing ? (
            <button className="btn btn-ghost danger-text" onClick={onCancel}>
              <X size={13} /> {t("adoptPreview.cancelAdopt")}
            </button>
          ) : null}
          <span className="adopt-footer-spacer" />
          <button className="btn btn-ghost" onClick={onClose} disabled={executing}>
            {t("common.close")}
          </button>
          <button
            className="btn btn-primary"
            disabled={executing || selectedCandidates.length === 0}
            onClick={() => onConfirm(selectedCandidates)}
          >
            {executing ? <Spinner size={13} /> : <Link2 size={13} />}
            {t("adoptPreview.confirmSelected", { count: selectedCandidates.length })}
          </button>
        </>
      }
    >
      {loading ? (
        <div className="adopt-empty">
          <Spinner size={20} />
          <p>{t("adoptPreview.scanning")}</p>
        </div>
      ) : !scan || candidates.length === 0 ? (
        <div className="adopt-empty">
          <CheckCircle2 size={22} />
          <p>{t("adoptPreview.empty")}</p>
        </div>
      ) : (
        <>
          <div className="adopt-summary">
            <div>
              <span>{t("adoptPreview.summaryMods")}</span>
              <strong>{candidates.length}</strong>
            </div>
            <div>
              <span>{t("adoptPreview.summaryFiles")}</span>
              <strong>{totalFiles}</strong>
            </div>
            <div>
              <span>{t("adoptPreview.summarySize")}</span>
              <strong>{formatBytes(scan.totalBytes)}</strong>
            </div>
            <div>
              <span>{t("adoptPreview.summarySelectable")}</span>
              <strong>{selectable.length}</strong>
            </div>
          </div>

          {scan.crossVolume ? (
            <div className="adopt-crosswarn">
              <ShieldAlert size={15} />
              <span>
                {t("adoptPreview.crossWarnLead")} <b>{t("adoptPreview.crossWarnCopyMode")}</b>{" "}
                {t("adoptPreview.crossWarnRest", { size: formatBytes(scan.copyBytes) })}
              </span>
            </div>
          ) : null}

          {report ? (
            <div className={`adopt-result adopt-result-${report.failed > 0 ? "warn" : "ok"}`}>
              {report.cancelled
                ? t("adoptPreview.summaryCancelled")
                : t("adoptPreview.summaryDone", {
                    adopted: report.adopted,
                    failed: report.failed,
                    skipped: report.skipped,
                  })}
              {failedCandidates.length > 0 ? (
                <button
                  className="btn btn-ghost btn-sm"
                  disabled={executing}
                  onClick={() => onConfirm(failedCandidates)}
                >
                  <RefreshCw size={12} /> {t("adoptPreview.retryFailed", { count: failedCandidates.length })}
                </button>
              ) : null}
            </div>
          ) : null}

          <div className="adopt-list">
            {candidates.map((candidate, index) => {
              const state = rowState(candidate, index);
              const outcome = outcomeMap.get(candidate.id);
              return (
                <label
                  key={candidate.id}
                  className={`adopt-row is-${state} ${candidate.alreadyManaged ? "is-managed" : ""}`}
                >
                  <input
                    type="checkbox"
                    checked={selected.has(candidate.id)}
                    disabled={executing || candidate.alreadyManaged}
                    onChange={() => toggle(candidate.id)}
                  />
                  <span className="adopt-row-copy">
                    <strong>{candidate.name}</strong>
                    <code title={candidate.files.map((file) => file.rel).join("\n")}>
                      {t("adoptPreview.fileCount", { count: candidate.files.length })} · {formatBytes(candidate.sizeBytes)}
                    </code>
                  </span>
                  <span className="adopt-row-badges">
                    <span className={`adopt-badge adopt-badge-${candidate.linkType}`}>
                      {candidate.linkType === "hardLink" ? t("adoptPreview.linkHard") : t("adoptPreview.linkCopy")}
                    </span>
                    {candidate.alreadyManaged ? (
                      <span className="adopt-badge adopt-badge-managed">{t("adoptPreview.stateSkipped")}</span>
                    ) : null}
                  </span>
                  <span className="adopt-row-state">
                    {stateView(state)}
                    {state === "failed" && outcome?.error ? (
                      // 2026-11-09：错误码放 tooltip、界面只看得到 ADOPT_STAGING_FAILED，
                      // 159 条失败排成一模一样的一列，等于静默失败。改成直接显示原因，
                      // 错误码降级为 title（悬停仍可复制）。
                      <em title={outcome.error.code}>
                        {outcome.error.message || outcome.error.code}
                      </em>
                    ) : null}
                  </span>
                </label>
              );
            })}
          </div>

          <p className="adopt-note">
            {t("adoptPreview.note")}
          </p>
        </>
      )}
    </Modal>
  );
}
