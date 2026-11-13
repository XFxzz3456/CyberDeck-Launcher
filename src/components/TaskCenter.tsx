import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  LoaderCircle,
  RotateCcw,
  Square,
  Trash2,
  X,
} from "lucide-react";
import { t } from "../i18n";
import type { TaskItem } from "../lib/tasks";

const STATUS_LABEL: Record<TaskItem["status"], string> = {
  queued: t("taskCenter.statusQueued"),
  running: t("taskCenter.statusRunning"),
  success: t("taskCenter.statusSuccess"),
  error: t("taskCenter.statusError"),
};


export function TaskCenter({
  tasks,
  onClearFinished,
  onDismiss,
  onRetry,
  onCancel,
}: {
  tasks: TaskItem[];
  onClearFinished: () => void;
  onDismiss: (id: number) => void;
  onRetry?: (paths: string[]) => void;
  /** 停止「可协作取消」的批量任务：后端单次调用不可中断，只保证后续批次不再开始。 */
  onCancel?: (id: number) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const active = tasks.filter((task) => task.status === "running" || task.status === "queued");
  const failed = tasks.filter((task) => task.status === "error").length;
  const done = tasks.filter((task) => task.status === "success").length;
  useEffect(() => {
    if (active.length > 0) {
      setCollapsed(false);
      return;
    }
    if (failed > 0) return;
    const timer = window.setTimeout(() => setCollapsed(true), 4200);
    return () => window.clearTimeout(timer);
  }, [active.length, failed]);

  const [showAll, setShowAll] = useState(false);
  const visible = useMemo(
    () => (showAll ? tasks : tasks.slice(-7)).slice().reverse(),
    [tasks, showAll],
  );
  // 活动流只保留一处（顶栏铃铛的通知中心）。这里曾经也渲染一份，
  // 同一批记录在两个面板里各显示一次，用户会以为「活动」和「通知」是两套东西。
  if (tasks.length === 0) return null;

  return (
    <section
      className={`task-center ${collapsed ? "is-collapsed" : ""}`}
      aria-label={t("taskCenter.titleAria")}
      aria-live="polite"
    >
      <header className="task-center-head">
        <div className="task-center-title">
          <span className={`task-pulse ${active.length > 0 ? "is-live" : ""}`} />
          <div>
            <strong>{t("taskCenter.titleQueue")}</strong>
            <span>
              {active.length > 0
                ? t("taskCenter.activeCount", { count: active.length })
                : failed > 0
                  ? t("taskCenter.failedDone", { failed, done })
                  : t("taskCenter.doneCount", { count: done })}
            </span>
          </div>
        </div>
        <div className="task-center-actions">
          {tasks.length > 0 ? (
            <button
              className="mini-btn"
              onClick={onClearFinished}
              title={t("taskCenter.clearTasks")}
              aria-label={t("taskCenter.clearTasks")}
              disabled={active.length > 0 && tasks.length <= active.length}
            >
              <Trash2 size={12} />
            </button>
          ) : null}
          <button
            className="mini-btn"
            onClick={() => setCollapsed((value) => !value)}
            title={collapsed ? t("taskCenter.expand") : t("taskCenter.collapse")}
            aria-label={collapsed ? t("taskCenter.expand") : t("taskCenter.collapse")}
          >
            {collapsed ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
          </button>
        </div>
      </header>

      {collapsed ? (
        <div className="task-center-collapsed">
          <span>
            {active.length > 0
              ? t("taskCenter.shortRunning", { count: active.length })
              : done > 0
                ? t("taskCenter.shortDone", { count: done })
                : t("taskCenter.shortIdle")}
          </span>
          {failed > 0 ? <b>{t("taskCenter.shortFailed", { count: failed })}</b> : null}
        </div>
      ) : (
        <>
          {tasks.length > 0 ? (
            <>
              <div className="task-list">
                {visible.map((task) => (
                  <div key={task.id} className={`task-row task-${task.status}`}>
                    <span className="task-icon">
                      {task.status === "success" ? (
                        <CheckCircle2 size={14} />
                      ) : task.status === "error" ? (
                        <AlertTriangle size={14} />
                      ) : (
                        <LoaderCircle size={14} className="spin" />
                      )}
                    </span>
                    <div className="task-copy">
                      <div className="task-line">
                        <strong title={task.title}>{task.title}</strong>
                        <span className="task-status">{STATUS_LABEL[task.status]}</span>
                      </div>
                      {task.error ? (
                        <p className="task-error" title={task.error}>
                          {task.error}
                        </p>
                      ) : task.detail ? (
                        <p>{task.detail}</p>
                      ) : null}
                      <div
                        className={`task-progress ${task.status === "running" ? "is-live" : ""}`}
                        role="progressbar"
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={Math.round(task.progress)}
                        aria-valuetext={t("taskCenter.progressAria", { value: Math.round(task.progress) })}
                      >
                        <i style={{ width: `${Math.max(4, task.progress)}%` }} />
                      </div>
                    </div>
                    <div className="task-row-actions">
                      {task.status === "error" && task.retryPaths && onRetry ? (
                        <button
                          className="mini-btn"
                          onClick={() => onRetry(task.retryPaths!)}
                          title={t("taskCenter.retry")}
                          aria-label={t("taskCenter.retryAria", { title: task.title })}
                        >
                          <RotateCcw size={12} />
                        </button>
                      ) : null}
                      {onCancel && (task.status === "running" || task.status === "queued") ? (
                        <button
                          className="mini-btn"
                          onClick={() => onCancel(task.id)}
                          title={t("taskCenter.stop")}
                          aria-label={t("taskCenter.stopAria", { title: task.title })}
                        >
                          <Square size={11} />
                        </button>
                      ) : null}
                      {task.status !== "running" && task.status !== "queued" ? (
                        <button
                          className="mini-btn"
                          onClick={() => onDismiss(task.id)}
                          title={t("taskCenter.remove")}
                          aria-label={t("taskCenter.removeAria", { title: task.title })}
                        >
                          <X size={12} />
                        </button>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
              {tasks.length > 7 ? (
                <div className="task-center-foot">
                  <button className="link-btn" onClick={() => setShowAll((value) => !value)}>
                    {showAll ? t("taskCenter.collapseAll") : t("taskCenter.expandAll")}
                  </button>
                </div>
              ) : null}
              <footer className="task-center-foot">
                <span>{t("taskCenter.failedRetained")}</span>
                <button className="link-btn" onClick={onClearFinished} disabled={done + failed === 0}>
                  {t("taskCenter.clear")}
                </button>
              </footer>
            </>
          ) : null}

        </>
      )}
    </section>
  );
}
