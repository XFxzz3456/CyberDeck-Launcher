import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  Ban,
  BrainCircuit,
  FileWarning,
  ListOrdered,
  LockKeyhole,
  Microscope,
  ShieldAlert,
  Sparkles,
} from "lucide-react";
import type {
  AiDiagnosis,
  AiStatus,
  ConflictInfo,
  DeepScanRef,
  Snapshot,
} from "../types";
import { api } from "../lib/api";
import { t } from "../i18n";
import { Badge, Modal, Spinner } from "./ui";

interface Group {
  target: string;
  pending: boolean;
  conflicts: ConflictInfo[];
}

/** 一组冲突的深度扫描状态（key = target|pending）。 */
interface DeepScanState {
  busy: boolean;
  scanned: boolean;
  overlap: string[];
  truncated: boolean;
  totalOverlap: number;
  errors: string[];
}

const DEEPSCAN_DISPLAY_LIMIT = 8;

function groupConflicts(conflicts: ConflictInfo[]): Group[] {
  const groups = new Map<string, Group>();
  for (const conflict of conflicts) {
    const key = `${conflict.target.toLowerCase()}|${conflict.pending ? "pending" : "live"}`;
    const group = groups.get(key) ?? {
      target: conflict.target,
      pending: conflict.pending,
      conflicts: [],
    };
    const duplicate = group.conflicts.some(
      (item) => item.modId === conflict.modId && item.otherModId === conflict.otherModId,
    );
    if (!duplicate) group.conflicts.push(conflict);
    groups.set(key, group);
  }
  return [...groups.values()].sort(
    (a, b) => Number(a.pending) - Number(b.pending) || a.target.localeCompare(b.target),
  );
}

export function ConflictCenter({
  open,
  conflicts,
  snapshot,
  busyId,
  onClose,
  onDisable,
  onOpenMod,
  onOpenLoadOrder,
  onOpenDiagnostics,
  onError,
}: {
  open: boolean;
  conflicts: ConflictInfo[];
  snapshot: Snapshot;
  busyId: string | null;
  onClose: () => void;
  onDisable: (modId: string) => void;
  onOpenMod: (modId: string) => void;
  onOpenLoadOrder: () => void;
  onOpenDiagnostics: () => void;
  onError: (error: unknown, title?: string) => void;
}) {
  const groups = useMemo(() => groupConflicts(conflicts), [conflicts]);
  const targets = new Set(conflicts.map((conflict) => conflict.target.toLowerCase())).size;
  const pending = conflicts.filter((conflict) => conflict.pending).length;
  const live = conflicts.length - pending;

  const [deepScans, setDeepScans] = useState<Record<string, DeepScanState>>({});

  /**
   * 资源级深度扫描：同名 .archive 内部到底改了同一批资源没有。
   * 路径解析在 Rust（safe_join），前端只拿结果画状态。
   */
  const runDeepScan = async (group: Group) => {
    const key = `${group.target.toLowerCase()}|${group.pending ? "pending" : "live"}`;
    const refs: DeepScanRef[] = [];
    for (const conflict of group.conflicts) {
      refs.push({ modId: conflict.modId, target: group.target });
      if (conflict.otherModId) {
        refs.push({ modId: conflict.otherModId, target: group.target });
      } else {
        // 未受管文件（游戏目录里手动放的），modId 传 null 让后端解析。
        refs.push({ modId: null, target: group.target });
      }
    }
    setDeepScans((current) => ({
      ...current,
      [key]: {
        busy: true,
        scanned: false,
        overlap: [],
        truncated: false,
        totalOverlap: 0,
        errors: [],
      },
    }));
    try {
      const paths = await api.resolveDeepScanPaths(refs);
      const errors: string[] = [];
      const existing: string[] = [];
      paths.forEach((path, index) => {
        if (path) existing.push(path);
        else
          errors.push(
            t("conflict.archiveNotFound", { modId: refs[index].modId ?? t("conflict.unmanagedDir") }),
          );
      });
      if (existing.length === 0) {
        setDeepScans((current) => ({
          ...current,
          [key]: { busy: false, scanned: true, overlap: [], truncated: false, totalOverlap: 0, errors },
        }));
        return;
      }
      const report = await api.scanArchiveDeep(existing);
      const okLists: string[][] = [];
      for (const result of report.results) {
        if (result.error && result.error.code) {
          errors.push(`${result.error.message}`);
        } else if (result.resources) {
          okLists.push(result.resources);
        }
      }
      // 交集：以第一个成功清单为基准，逐个过滤。
      let overlap: string[] = [];
      if (okLists.length >= 2) {
        overlap = okLists[0].filter((item) => okLists.every((list) => list.includes(item)));
      }
      const truncated = report.results.some((result) => result.truncated);
      const totalOverlap = overlap.length;
      overlap = overlap.slice(0, DEEPSCAN_DISPLAY_LIMIT);
      setDeepScans((current) => ({
        ...current,
        [key]: { busy: false, scanned: true, overlap, truncated, totalOverlap, errors },
      }));
    } catch (error) {
      // WOLVENKIT_NOT_CONFIGURED 等整体性错误直接走全局错误提示。
      onError(error, t("conflict.deepScanFailed"));
      setDeepScans((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      });
    }
  };

  return (
    <Modal
      open={open}
      title={targets > 0 ? t("conflict.titleCount", { count: targets }) : t("conflict.title")}
      eyebrow="// CONFLICT MATRIX / ONE OWNER PER TARGET"
      onClose={onClose}
      width={760}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onOpenDiagnostics}>
            <FileWarning size={14} /> {t("sidebar.diagnostics")}
          </button>
          <button className="btn btn-ghost" onClick={onOpenLoadOrder} disabled={live === 0}>
            <ListOrdered size={14} /> {t("sidebar.loadOrder")}
          </button>
          <button className="btn btn-primary" onClick={onClose}>
            {t("common.close")}
          </button>
        </>
      }
    >
      <div className="conflict-center-summary">
        <div>
          <span>{t("conflict.targets")}</span>
          <strong>{targets}</strong>
        </div>
        <div className={live > 0 ? "danger" : ""}>
          <span>{t("conflict.liveConflicts")}</span>
          <strong>{live}</strong>
        </div>
        <div className={pending > 0 ? "warn" : ""}>
          <span>{t("conflict.pendingConflicts")}</span>
          <strong>{pending}</strong>
        </div>
      </div>

      <div className="conflict-center-note">
        <ShieldAlert size={15} />
        <p>
          {t("conflict.noteA")}
          <strong>{t("conflict.noteStrong")}</strong>
          {t("conflict.noteB")}
        </p>
      </div>

      {groups.length === 0 ? (
        <div className="conflict-center-empty">
          <ShieldAlert size={22} />
          <strong>{t("conflict.empty")}</strong>
          <span>{t("conflict.emptyDetail")}</span>
        </div>
      ) : (
        <div className="conflict-center-list">
          {groups.map((group) => (
            <div
              key={`${group.target}-${group.pending}`}
              className={`conflict-group ${group.pending ? "pending" : "live"}`}
            >
              <div className="conflict-group-head">
                <code>{group.target}</code>
                <Badge tone={group.pending ? "yellow" : "red"}>
                  {group.pending ? t("conflict.badgePending") : t("conflict.badgeLive")}
                </Badge>
                {group.target.toLowerCase().endsWith(".archive") ? (
                  (() => {
                    const key = `${group.target.toLowerCase()}|${group.pending ? "pending" : "live"}`;
                    const scan = deepScans[key];
                    return (
                      <button
                        className="btn btn-ghost btn-sm conflict-deepscan-btn"
                        onClick={() => void runDeepScan(group)}
                        disabled={scan?.busy ?? false}
                        title={t("conflict.deepScanTitle")}
                      >
                        {scan?.busy ? <Spinner size={12} /> : <Microscope size={12} />}
                        {scan?.busy ? t("conflict.scanning") : t("conflict.deepScan")}
                      </button>
                    );
                  })()
                ) : null}
              </div>
              {(() => {
                const key = `${group.target.toLowerCase()}|${group.pending ? "pending" : "live"}`;
                const scan = deepScans[key];
                if (!scan?.scanned) return null;
                return (
                  <div className="conflict-deepscan-result">
                    {scan.overlap.length > 0 ? (
                      <>
                        <p className="conflict-deepscan-hit">
                          <AlertTriangle size={13} />
                          {t("conflict.overlapBody", {
                            count: scan.totalOverlap,
                            truncated: scan.truncated ? t("conflict.truncatedNote") : "",
                          })}
                        </p>
                        <ul>
                          {scan.overlap.map((resource) => (
                            <li key={resource}>
                              <code>{resource}</code>
                            </li>
                          ))}
                        </ul>
                        {scan.totalOverlap > scan.overlap.length ? (
                          <small>
                            {t("conflict.moreResources", {
                              count: scan.totalOverlap - scan.overlap.length,
                            })}
                          </small>
                        ) : null}
                      </>
                    ) : (
                      <p className="conflict-deepscan-clean">
                        <Sparkles size={13} />
                        {t("conflict.clean")}
                      </p>
                    )}
                    {scan.errors.length > 0 ? (
                      <div className="conflict-deepscan-errors">
                        {scan.errors.map((message, index) => (
                          <p key={index}>{message}</p>
                        ))}
                      </div>
                    ) : null}
                  </div>
                );
              })()}
              {group.pending ? (
                <p className="conflict-group-explain">{t("conflict.pendingExplain")}</p>
              ) : null}
              {group.conflicts.map((conflict) => {
                const candidate = snapshot.state.mods.find((mod) => mod.id === conflict.modId);
                const other = conflict.otherModId
                  ? snapshot.state.mods.find((mod) => mod.id === conflict.otherModId)
                  : null;
                return (
                  <div
                    key={`${conflict.modId}-${conflict.otherModId ?? "unmanaged"}`}
                    className="conflict-pair"
                  >
                    <div className="conflict-chain">
                      {group.pending ? (
                        <>
                          {other ? (
                            <button
                              className="conflict-chain-node owner"
                              onClick={() => onOpenMod(other.id)}
                            >
                              <span className="chain-role">TARGET OWNER</span>
                              <strong>{other.name}</strong>
                              <em>{t("conflict.ownerDeployed")}</em>
                            </button>
                          ) : (
                            <div className="conflict-chain-node owner static">
                              <span className="chain-role">TARGET OWNER</span>
                              <strong>{t("conflict.unmanagedFile")}</strong>
                              <em>{t("conflict.manualNoOverwrite")}</em>
                            </div>
                          )}
                          <div className="conflict-chain-link is-block">
                            <span>BLOCKS</span>
                            <ArrowRight size={14} />
                          </div>
                          <button
                            className="conflict-chain-node blocked"
                            onClick={() => onOpenMod(conflict.modId)}
                          >
                            <span className="chain-role">HELD BACK</span>
                            <strong>{conflict.modName || candidate?.name || t("conflict.unknownMod")}</strong>
                            <em>{t("conflict.pendingBlockedNote")}</em>
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            className="conflict-chain-node owner"
                            onClick={() => onOpenMod(conflict.modId)}
                          >
                            <span className="chain-role">CLAIM A</span>
                            <strong>{conflict.modName || candidate?.name || t("conflict.unknownMod")}</strong>
                            <em>{candidate?.enabled ? t("conflict.claimDeployed") : t("conflict.staged")}</em>
                          </button>
                          <div className="conflict-chain-link is-versus">
                            <span>CONFLICT</span>
                            <ArrowRight size={14} />
                          </div>
                          {other ? (
                            <button
                              className="conflict-chain-node blocked"
                              onClick={() => onOpenMod(other.id)}
                            >
                              <span className="chain-role">CLAIM B</span>
                              <strong>{other.name}</strong>
                              <em>{other.enabled ? t("conflict.claimDeployed") : t("conflict.staged")}</em>
                            </button>
                          ) : (
                            <div className="conflict-chain-node blocked static">
                              <span className="chain-role">CLAIM B</span>
                              <strong>{t("conflict.unmanagedFile")}</strong>
                              <em>{t("conflict.manualUnmanaged")}</em>
                            </div>
                          )}
                        </>
                      )}
                    </div>
                    <p className="conflict-chain-note">
                      {group.pending ? t("conflict.pendingNote") : t("conflict.liveNote")}
                    </p>
                    <div className="conflict-pair-actions">
                      {!group.pending && candidate?.enabled ? (
                        <button
                          className="btn btn-ghost btn-sm danger-text"
                          onClick={() => onDisable(candidate.id)}
                          disabled={busyId === candidate.id}
                          title={t("conflict.disableTitle")}
                        >
                          {busyId === candidate.id ? <Spinner size={12} /> : <Ban size={12} />}
                          {t("conflict.disableMod", { name: candidate.name })}
                        </button>
                      ) : null}
                      {!group.pending && other?.enabled ? (
                        <button
                          className="btn btn-ghost btn-sm danger-text"
                          onClick={() => onDisable(other.id)}
                          disabled={busyId === other.id}
                          title={t("conflict.disableTitle")}
                        >
                          {busyId === other.id ? <Spinner size={12} /> : <Ban size={12} />}
                          {t("conflict.disableMod", { name: other.name })}
                        </button>
                      ) : null}
                      {group.pending && candidate ? (
                        <button
                          className="btn btn-ghost btn-sm"
                          onClick={() => onOpenMod(candidate.id)}
                        >
                          {t("conflict.viewCandidate")}
                        </button>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}

      <ConflictAiAdvice open={open} onOpenDiagnostics={onOpenDiagnostics} onError={onError} />
    </Modal>
  );
}

function ConflictAiAdvice({
  open,
  onOpenDiagnostics,
  onError,
}: {
  open: boolean;
  onOpenDiagnostics: () => void;
  onError: (error: unknown, title?: string) => void;
}) {
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<AiDiagnosis | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      try {
        const next = await api.aiStatus();
        if (!cancelled) setStatus(next);
      } catch (error) {
        if (!cancelled) onError(error, t("conflict.aiStatusFailed"));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, onError]);

  useEffect(() => {
    if (!open) {
      setConsent(false);
      setResult(null);
    }
  }, [open]);

  const analyze = async () => {
    if (!consent) return;
    setBusy(true);
    try {
      setResult(await api.aiDiagnose(false, true, "conflicts"));
    } catch (error) {
      onError(error, t("conflict.aiAnalyzeFailed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="conflict-ai">
      <div className="conflict-ai-head">
        <div>
          <div className="panel-eyebrow">// OPTIONAL / AI</div>
          <h3><BrainCircuit size={15} /> {t("conflict.aiTitle")}</h3>
        </div>
        <Badge tone={status?.configured ? "cyan" : "muted"}>
          {status?.configured ? status.model : t("conflict.aiNotConfigured")}
        </Badge>
      </div>

      {status && !status.configured ? (
        <div className="conflict-ai-empty">
          <LockKeyhole size={14} />
          <span>{t("conflict.aiNeedKey")}</span>
          <button className="link-btn" onClick={onOpenDiagnostics}>
            {t("conflict.aiGoConfigure")} <ArrowRight size={11} />
          </button>
        </div>
      ) : (
        <>
          <p className="conflict-ai-copy">{t("conflict.aiCopy")}</p>
          <div className="conflict-ai-run">
            <label>
              <input
                type="checkbox"
                checked={consent}
                onChange={(event) => setConsent(event.target.checked)}
              />
              <span>{t("conflict.aiConsent")}</span>
            </label>
            <button
              className="btn btn-primary btn-sm"
              onClick={() => void analyze()}
              disabled={!consent || busy || !status?.configured}
            >
              {busy ? <Spinner size={12} /> : <Sparkles size={12} />}
              {busy
                ? t("conflict.aiAnalyzing")
                : result
                  ? t("conflict.aiReanalyze")
                  : t("conflict.aiAnalyze")}
            </button>
          </div>
          {result ? (
            <div className="conflict-ai-result">
              <div className="conflict-ai-verdict">
                <Badge tone={result.confidence === "low" ? "red" : "green"}>
                  {result.confidence === "high"
                    ? t("conflict.confidenceHigh")
                    : result.confidence === "low"
                      ? t("conflict.confidenceLow")
                      : t("conflict.confidenceMid")}
                </Badge>
                <strong>{result.summary}</strong>
              </div>
              <p>{result.likelyCause}</p>
              {result.fixSteps.length > 0 ? (
                <ol>
                  {result.fixSteps.slice(0, 3).map((step) => (
                    <li key={step}>{step}</li>
                  ))}
                </ol>
              ) : null}
              <span className="conflict-ai-foot">
                {t("conflict.aiFoot", {
                  model: result.model,
                  chars: result.sentChars.toLocaleString(),
                  redactions: result.redactions,
                })}
              </span>
            </div>
          ) : (
            <div className="conflict-ai-idle">
              <AlertTriangle size={13} />
              <span>{t("conflict.aiHint")}</span>
            </div>
          )}
        </>
      )}
    </section>
  );
}
