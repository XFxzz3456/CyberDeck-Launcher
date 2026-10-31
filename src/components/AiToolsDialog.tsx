import { useEffect, useState } from "react";
import { api, normalizeError } from "../lib/api";
import type { AiFixProposal, AiLocPlan, AiLocReport, ModEntry } from "../types";
import { Modal } from "./ui";
import { t } from "../i18n";

/**
 * AI 汉化 / AI 补丁的统一入口弹窗。
 *
 * 两条流程共享同一套「先看计划、再勾确认、最后才执行」的结构：
 * - 汉化：`ai_loc_plan` 只读扫描 → 勾选「译文由 AI 生成」→ `ai_loc_apply`；
 * - 补丁：先写需求 → `ai_fix_propose` 拿提案并做结构校验 → 勾风险确认 → `ai_fix_apply`。
 *
 * 后端会把所有拒绝理由写成错误码回来，这里只负责原样展示，不吞错。
 */
export function AiToolsDialog({
  open,
  mod,
  mode,
  onClose,
  onDone,
}: {
  open: boolean;
  mod: ModEntry | null;
  mode: "loc" | "fix";
  onClose: () => void;
  onDone: () => void;
}) {
  const [plan, setPlan] = useState<AiLocPlan | null>(null);
  const [proposal, setProposal] = useState<AiFixProposal | null>(null);
  const [report, setReport] = useState<AiLocReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [intent, setIntent] = useState("");
  const [ackAi, setAckAi] = useState(false);
  const [ackPolicy, setAckPolicy] = useState(false);
  const [ackFix, setAckFix] = useState(false);

  useEffect(() => {
    if (!open || !mod) return;
    setPlan(null);
    setProposal(null);
    setReport(null);
    setError(null);
    setIntent("");
    setAckAi(false);
    setAckPolicy(false);
    setAckFix(false);
    if (mode !== "loc") return;
    let alive = true;
    setLoading(true);
    void api
      .aiLocPlan(mod.id)
      .then((value) => {
        if (alive) setPlan(value);
      })
      .catch((err) => {
        if (alive) setError(normalizeError(err).message);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [open, mod, mode]);

  const closeAll = () => {
    onClose();
  };

  const runApply = async () => {
    if (!mod) return;
    setBusy(true);
    setError(null);
    try {
      const value = await api.aiLocApply(mod.id, ackAi, ackPolicy);
      setReport(value);
      onDone();
    } catch (err) {
      setError(normalizeError(err).message);
    } finally {
      setBusy(false);
    }
  };

  const runRevert = async () => {
    if (!mod) return;
    setBusy(true);
    setError(null);
    try {
      await api.aiLocRevert(mod.id);
      setReport(null);
      setPlan(null);
      onDone();
      onClose();
    } catch (err) {
      setError(normalizeError(err).message);
    } finally {
      setBusy(false);
    }
  };

  const runPropose = async () => {
    if (!mod) return;
    setBusy(true);
    setError(null);
    setProposal(null);
    try {
      const value = await api.aiFixPropose(mod.id, intent);
      setProposal(value);
    } catch (err) {
      setError(normalizeError(err).message);
    } finally {
      setBusy(false);
    }
  };

  const runApplyFix = async () => {
    if (!mod || !proposal) return;
    setBusy(true);
    setError(null);
    try {
      await api.aiFixApply(mod.id, proposal.code, proposal.intent, ackFix);
      onDone();
      onClose();
    } catch (err) {
      setError(normalizeError(err).message);
    } finally {
      setBusy(false);
    }
  };

  const canSubmitLoc =
    !!plan &&
    !busy &&
    ackAi &&
    plan.policy !== "denied" &&
    plan.entries.length > 0 &&
    !plan.hasOverlay &&
    (plan.policy !== "uncertain" || ackPolicy);

  const canApplyFix = !!proposal && proposal.structureOk && ackFix && !busy;

  return (
    <Modal
      open={open}
      title={mode === "loc" ? t("aiTools.titleLoc") : t("aiTools.titleFix")}
      eyebrow={mode === "loc" ? "// AI LOCALIZE" : "// AI PATCH"}
      width={640}
      onClose={closeAll}
      footer={
        <div className="ai-tools-footer">
          <button type="button" className="btn subtle" onClick={closeAll} disabled={busy}>
            {t("aiTools.cancel")}
          </button>
          {mode === "loc" && plan?.hasOverlay ? (
            <button
              type="button"
              className="btn subtle"
              disabled={busy}
              onClick={() => void runRevert()}
            >
              {t("aiTools.revert")}
            </button>
          ) : null}
          {mode === "loc" && !report ? (
            <button
              type="button"
              className="btn primary"
              disabled={!canSubmitLoc}
              onClick={() => void runApply()}
            >
              {busy ? t("aiTools.generating") : t("aiTools.submitLoc")}
            </button>
          ) : null}
          {mode === "fix" && !proposal ? (
            <button
              type="button"
              className="btn primary"
              disabled={busy || intent.trim().length === 0}
              onClick={() => void runPropose()}
            >
              {busy ? t("aiTools.generating") : t("aiTools.submitFix")}
            </button>
          ) : null}
          {mode === "fix" && proposal ? (
            <button
              type="button"
              className="btn primary"
              disabled={!canApplyFix}
              onClick={() => void runApplyFix()}
            >
              {t("aiTools.submitFix")}
            </button>
          ) : null}
        </div>
      }
    >
      <div className="ai-tools">
        <p className="ai-tools-hint">
          {mode === "loc" ? t("aiTools.subtitleLoc") : t("aiTools.subtitleFix")}
        </p>
        {mod ? (
          <div className="ai-tools-target">
            <span>{t("aiTools.targetMod")}</span>
            <strong>{mod.name}</strong>
            {mode === "loc" && plan ? (
              <span className="ai-tools-lang">
                {t("aiTools.languagePair")} · {plan.sourceLang} → {plan.targetLang}
              </span>
            ) : null}
          </div>
        ) : null}

        {loading ? <p className="ai-tools-muted">{t("aiTools.loading")}</p> : null}
        {error ? <p className="ai-tools-error">{error}</p> : null}

        {mode === "loc" && plan ? (
          <>
            <div className="ai-tools-stats">
              <span>{t("aiTools.statEntries", { count: plan.entries.length })}</span>
              <span>{t("aiTools.statGlossary", { count: plan.glossaryHits })}</span>
              <span>{t("aiTools.statBlocked", { count: plan.blocked.length })}</span>
            </div>
            <p
              className={
                plan.policy === "denied"
                  ? "ai-tools-error"
                  : plan.policy === "uncertain"
                    ? "ai-tools-warn"
                    : "ai-tools-ok"
              }
            >
              {plan.policy === "denied"
                ? t("aiTools.policyDenied")
                : plan.policy === "uncertain"
                  ? t("aiTools.policyUncertain")
                  : t("aiTools.policyAllowed")}
            </p>
            {!plan.packingReady ? (
              <p className="ai-tools-warn">{t("aiTools.packingMissing")}</p>
            ) : null}
            {plan.hasOverlay ? <p className="ai-tools-warn">{t("aiTools.overlayExists")}</p> : null}
            {plan.entries.length === 0 ? (
              <p className="ai-tools-muted">{t("aiTools.emptyEntries")}</p>
            ) : (
              <ul className="ai-tools-list">
                {plan.entries.slice(0, 5).map((entry) => (
                  <li key={`${entry.sourceFile}:${entry.secondaryKey}`}>
                    <span className="ai-tools-key">{entry.secondaryKey}</span>
                    <span className="ai-tools-text">{entry.sourceText}</span>
                  </li>
                ))}
                {plan.entries.length > 5 ? (
                  <li className="ai-tools-muted">
                    {t("aiTools.entriesMore", { count: plan.entries.length - 5 })}
                  </li>
                ) : null}
              </ul>
            )}
            {plan.blocked.length > 0 ? (
              <details className="ai-tools-details">
                <summary>{t("aiTools.blockedTitle")}</summary>
                <ul className="ai-tools-list">
                  {plan.blocked.slice(0, 8).map((item, index) => (
                    <li key={`${item.sourceFile}-${index}`}>
                      <span className="ai-tools-key">{item.reason}</span>
                      <span className="ai-tools-text">{item.sample}</span>
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
            <label className="ai-tools-check">
              <input
                type="checkbox"
                checked={ackAi}
                onChange={(event) => setAckAi(event.target.checked)}
                disabled={plan.policy === "denied"}
              />
              <span>{t("aiTools.ackAi")}</span>
            </label>
            {plan.policy === "uncertain" ? (
              <label className="ai-tools-check">
                <input
                  type="checkbox"
                  checked={ackPolicy}
                  onChange={(event) => setAckPolicy(event.target.checked)}
                />
                <span>{t("aiTools.ackPolicy")}</span>
              </label>
            ) : null}
            {report ? (
              <div className="ai-tools-ok">
                {t("aiTools.done", {
                  written: report.written.length,
                  deployed: report.deployed.length,
                })}
                {report.warnings.map((item) => (
                  <p key={item} className="ai-tools-muted">
                    {item}
                  </p>
                ))}
              </div>
            ) : null}
          </>
        ) : null}

        {mode === "fix" ? (
          <>
            <label className="ai-tools-field">
              <span>{t("aiTools.intentLabel")}</span>
              <textarea
                value={intent}
                onChange={(event) => setIntent(event.target.value)}
                placeholder={t("aiTools.intentPlaceholder")}
                rows={3}
              />
            </label>
            {proposal ? (
              <>
                <p className="ai-tools-warn">
                  {t("aiTools.contextNotice", { chars: proposal.contextChars })}
                </p>
                <p className={proposal.structureOk ? "ai-tools-ok" : "ai-tools-error"}>
                  {proposal.structureOk ? t("aiTools.structureOk") : t("aiTools.structureBad")}
                </p>
                {proposal.structureIssues.length > 0 ? (
                  <ul className="ai-tools-list">
                    {proposal.structureIssues.map((item) => (
                      <li key={item} className="ai-tools-text">
                        {item}
                      </li>
                    ))}
                  </ul>
                ) : null}
                {proposal.compiler ? null : (
                  <p className="ai-tools-warn">{t("aiTools.compilerMissing")}</p>
                )}
                <details className="ai-tools-details" open>
                  <summary>{t("aiTools.codePreview")}</summary>
                  <pre className="ai-tools-code">{proposal.code}</pre>
                </details>
                <label className="ai-tools-check">
                  <input
                    type="checkbox"
                    checked={ackFix}
                    onChange={(event) => setAckFix(event.target.checked)}
                  />
                  <span>{t("aiTools.ackFix")}</span>
                </label>
              </>
            ) : null}
          </>
        ) : null}
      </div>
    </Modal>
  );
}
