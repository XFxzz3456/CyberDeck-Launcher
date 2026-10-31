import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  BrainCircuit,
  Check,
  Copy,
  FileText,
  Filter,
  FolderOpen,
  RefreshCw,
  ShieldAlert,
  Sparkles,
  Terminal,
  Undo2,
} from "lucide-react";
import type { AiDiagnosis, LogFileInfo, LogLine, LogTail } from "../types";
import { api } from "../lib/api";
import { compactPath, formatBytes, relativeTime } from "../lib/format";
import { t } from "../i18n";
import { Badge, Modal, Spinner } from "./ui";

const TAIL_OPTIONS = [100, 300, 500];
const CONTEXT_LINES = 5;
const ERROR_HINT = /\b(error|failed|failure|exception|fatal|panic|crash|错误|失败)\b/i; // i18n-ignore

type LevelFilter = "all" | "error" | "warn";

interface ErrorBlock {
  start: number;
  end: number;
  lines: LogLine[];
}

function extractErrorBlocks(lines: LogLine[], context = CONTEXT_LINES): ErrorBlock[] {
  const ranges: Array<[number, number]> = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.level !== "error" && !ERROR_HINT.test(line.text)) continue;
    const start = Math.max(0, index - context);
    const end = Math.min(lines.length - 1, index + context);
    const previous = ranges[ranges.length - 1];
    if (previous && start <= previous[1] + 1) {
      previous[1] = Math.max(previous[1], end);
    } else {
      ranges.push([start, end]);
    }
  }
  return ranges.map(([start, end]) => ({
    start: lines[start]?.number ?? start + 1,
    end: lines[end]?.number ?? end + 1,
    lines: lines.slice(start, end + 1),
  }));
}

export function LogViewerDialog({
  open,
  onClose,
  onError,
  onOpenLogs,
}: {
  open: boolean;
  onClose: () => void;
  onError: (error: unknown, title?: string) => void;
  onOpenLogs: () => void;
}) {
  const [files, setFiles] = useState<LogFileInfo[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [tail, setTail] = useState<LogTail | null>(null);
  const [limit, setLimit] = useState(100);
  const [filter, setFilter] = useState<LevelFilter>("all");
  const [extractMode, setExtractMode] = useState(false);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [loadingTail, setLoadingTail] = useState(false);
  const [copied, setCopied] = useState(false);
  const [aiConsent, setAiConsent] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiResult, setAiResult] = useState<AiDiagnosis | null>(null);
  const terminalRef = useRef<HTMLDivElement>(null);

  const loadFiles = async () => {
    setLoadingFiles(true);
    try {
      const next = await api.listLogs();
      setFiles(next);
      setSelected((current) => {
        if (current && next.some((file) => file.path === current)) return current;
        return next[0]?.path ?? null;
      });
    } catch (error) {
      onError(error, t("logViewer.errorListLogs"));
    } finally {
      setLoadingFiles(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    void loadFiles();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open || !selected) {
      setTail(null);
      return;
    }
    let cancelled = false;
    setLoadingTail(true);
    void api
      .readLogTail(selected, limit)
      .then((next) => {
        if (!cancelled) setTail(next);
      })
      .catch((error) => {
        if (!cancelled) {
          setTail(null);
          onError(error, t("logViewer.errorReadLog"));
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingTail(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, selected, limit]);

  useEffect(() => {
    setExtractMode(false);
    setAiResult(null);
    setAiConsent(false);
    setCopied(false);
  }, [selected, limit]);

  useEffect(() => {
    if (tail && terminalRef.current && !extractMode) {
      terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
    }
  }, [tail, extractMode]);

  const errorCount = tail?.lines.filter((line) => line.level === "error").length ?? 0;
  const warnCount = tail?.lines.filter((line) => line.level === "warn").length ?? 0;
  const visibleLines = useMemo(() => {
    if (!tail) return [];
    if (filter === "error") return tail.lines.filter((line) => line.level === "error");
    if (filter === "warn") return tail.lines.filter((line) => line.level === "warn");
    return tail.lines;
  }, [filter, tail]);
  const blocks = useMemo(() => (tail ? extractErrorBlocks(tail.lines) : []), [tail]);
  const extractedText = useMemo(
    () =>
      blocks
        .map(
          (block) =>
            `--- L${block.start}–L${block.end} ---\n${block.lines
              .map((line) => `${String(line.number).padStart(4, " ")} | ${line.text}`)
              .join("\n")}`,
        )
        .join("\n\n"),
    [blocks],
  );

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(extractedText);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch (error) {
      onError(error, t("logViewer.errorCopy"));
    }
  };

  const askAi = async () => {
    if (!aiConsent) return;
    setAiBusy(true);
    try {
      setAiResult(await api.aiDiagnose(true, true, "logs"));
    } catch (error) {
      onError(error, t("logViewer.errorAi"));
    } finally {
      setAiBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      title={t("logViewer.title")}
      eyebrow="// LOGS / STRUCTURED / READ ONLY"
      onClose={onClose}
      width={1060}
    >
      <div className="log-viewer">
        <aside className="log-viewer-files">
          <div className="log-viewer-head">
            <span>
              <FileText size={14} /> {t("logViewer.availableLogs")}
            </span>
            <button className="mini-btn" onClick={() => void loadFiles()} title={t("logViewer.rescan")}>
              {loadingFiles ? <Spinner size={12} /> : <RefreshCw size={12} />}
            </button>
          </div>
          {files.length === 0 && !loadingFiles ? (
            <div className="log-viewer-empty">
              {t("logViewer.emptyFiles")}
            </div>
          ) : (
            files.map((file) => (
              <button
                key={file.path}
                className={`log-file-row ${selected === file.path ? "active" : ""}`}
                onClick={() => setSelected(file.path)}
              >
                <span className={`log-file-dot log-cat-${file.category.toLowerCase()}`} />
                <span className="log-file-copy">
                  <strong>{file.name}</strong>
                  <em>
                    {file.category} · {formatBytes(file.sizeBytes)}
                    {file.modifiedAt ? ` · ${relativeTime(file.modifiedAt)}` : ""}
                  </em>
                </span>
                <Badge tone={file.category === "redscript" ? "yellow" : "muted"}>
                  {file.category}
                </Badge>
              </button>
            ))
          )}
          <button className="btn btn-ghost btn-sm full log-folder-btn" onClick={onOpenLogs}>
            <FolderOpen size={13} /> {t("logViewer.logsFolder")}
          </button>
        </aside>

        <section className="log-viewer-main">
          <div className="log-viewer-toolbar">
            <div className="log-viewer-title">
              <Terminal size={15} />
              <strong>{tail?.name ?? t("logViewer.selectLog")}</strong>
              {tail ? <span>{formatBytes(tail.fileSizeBytes)}</span> : null}
            </div>
            <div className="log-tail-options">
              {TAIL_OPTIONS.map((option) => (
                <button
                  key={option}
                  className={`mini-btn ${limit === option ? "active" : ""}`}
                  onClick={() => setLimit(option)}
                  disabled={loadingTail}
                >
                  {t("logViewer.tailLines", { count: option })}
                </button>
              ))}
            </div>
          </div>
          {tail ? <code className="log-viewer-path" title={tail.path}>{compactPath(tail.path, 90)}</code> : null}
          <div className="log-viewer-filters">
            <span className="log-filter-label"><Filter size={11} /> LEVEL</span>
            <button
              className={`mini-btn ${filter === "all" ? "active" : ""}`}
              onClick={() => setFilter("all")}
            >
              {t("logViewer.filterAll", { count: tail?.lines.length ?? 0 })}
            </button>
            <button
              className={`mini-btn ${filter === "error" ? "active" : ""}`}
              onClick={() => setFilter("error")}
              disabled={errorCount === 0}
            >
              <ShieldAlert size={11} /> {t("logViewer.filterError", { count: errorCount })}
            </button>
            <button
              className={`mini-btn ${filter === "warn" ? "active" : ""}`}
              onClick={() => setFilter("warn")}
              disabled={warnCount === 0}
            >
              <AlertTriangle size={11} /> {t("logViewer.filterWarn", { count: warnCount })}
            </button>
            <span className="log-filter-spacer" />
            <button
              className={`btn btn-ghost btn-sm ${extractMode ? "is-active" : ""}`}
              onClick={() => {
                setExtractMode((value) => !value);
                setFilter("all");
              }}
              disabled={!tail || blocks.length === 0}
              title={t("logViewer.extractHint")}
            >
              <BrainCircuit size={12} /> {extractMode ? t("logViewer.fullLog") : t("logViewer.extractErrors", { count: blocks.length })}
            </button>
          </div>
          {tail?.truncated ? (
            <div className="log-truncated">
              <AlertTriangle size={13} /> {t("logViewer.truncated", { count: tail.tailLimit })}
            </div>
          ) : null}
          <div className="log-terminal" ref={terminalRef} role="log" aria-label={t("logViewer.logContentAria")}>
            {loadingTail ? (
              <div className="log-loading">
                <Spinner size={16} /> {t("logViewer.loadingTail")}
              </div>
            ) : !tail ? (
              <div className="log-loading">{t("logViewer.pickFile")}</div>
            ) : extractMode ? (
              blocks.length === 0 ? (
                <div className="log-loading">{t("logViewer.noErrorsFound")}</div>
              ) : (
                blocks.map((block) => (
                  <div className="log-extract-block" key={`${block.start}-${block.end}`}>
                    <div className="log-extract-head">
                      L{block.start}–L{block.end}
                      <span>{block.lines.filter((line) => line.level === "error").length} ERROR</span>
                    </div>
                    {block.lines.map((line) => (
                      <div className={`log-line log-line-${line.level}`} key={`${line.number}-${line.text.slice(0, 24)}`}>
                        <span className="log-line-number">{String(line.number).padStart(3, "0")}</span>
                        <span className="log-line-text">{line.text || " "}</span>
                      </div>
                    ))}
                  </div>
                ))
              )
            ) : visibleLines.length > 0 ? (
              visibleLines.map((line) => (
                <div className={`log-line log-line-${line.level}`} key={`${line.number}-${line.text.slice(0, 24)}`}>
                  <span className="log-line-number">{String(line.number).padStart(3, "0")}</span>
                  <span className="log-line-text">{line.text || " "}</span>
                </div>
              ))
            ) : (
              <div className="log-loading">
                {t("logViewer.noLinesForFilter")}
              </div>
            )}
          </div>

          {extractMode ? (
            <div className="log-extract-bar">
              <div className="log-extract-copy">
                <strong>{t("logViewer.extractBlocks", { count: blocks.length })}</strong>
                <span>{t("logViewer.extractNote", { count: CONTEXT_LINES })}</span>
              </div>
              <div className="log-extract-actions">
                <button className="btn btn-ghost btn-sm" onClick={() => void copy()}>
                  {copied ? <Check size={12} /> : <Copy size={12} />}
                  {copied ? t("common.copied") : t("logViewer.copySnippet")}
                </button>
                <button className="btn btn-ghost btn-sm" onClick={() => setExtractMode(false)}>
                  <Undo2 size={12} /> {t("logViewer.backToFull")}
                </button>
              </div>
              <div className="log-ai-row">
                <label>
                  <input
                    type="checkbox"
                    checked={aiConsent}
                    onChange={(event) => setAiConsent(event.target.checked)}
                  />
                  <span>{t("logViewer.aiConsent")}</span>
                </label>
                <button
                  className="btn btn-primary btn-sm"
                  onClick={() => void askAi()}
                  disabled={!aiConsent || aiBusy}
                >
                  {aiBusy ? <Spinner size={12} /> : <Sparkles size={12} />}
                  {aiBusy ? t("logViewer.analyzing") : t("logViewer.sendToAi")}
                </button>
              </div>
              {aiResult ? (
                <div className="log-ai-result">
                  <strong>{aiResult.summary}</strong>
                  <p>{aiResult.likelyCause}</p>
                  {aiResult.fixSteps.length > 0 ? (
                    <ol>
                      {aiResult.fixSteps.slice(0, 3).map((step) => (
                        <li key={step}>{step}</li>
                      ))}
                    </ol>
                  ) : null}
                  <span>
                    {aiResult.model} · {aiResult.confidence.toUpperCase()} · {t("logViewer.sentChars", { count: aiResult.sentChars })}
                  </span>
                </div>
              ) : null}
            </div>
          ) : (
            <div className="log-viewer-note">
              {t("logViewer.note", { count: CONTEXT_LINES })}
            </div>
          )}
        </section>
      </div>
    </Modal>
  );
}
