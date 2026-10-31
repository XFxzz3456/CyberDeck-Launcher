import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  LoaderCircle,
  RotateCcw,
  Trash2,
  X,
} from "lucide-react";
import { t } from "../i18n";
import type { ActivityItem, TaskItem } from "../lib/tasks";

const STATUS_LABEL: Record<TaskItem["status"], string> = {
  queued: t("taskCenter.statusQueued"),
  running: t("taskCenter.statusRunning"),
  success: t("taskCenter.statusSuccess"),
  error: t("taskCenter.statusError"),
};

function clockTime(at: number): string {
  return new Date(at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

export function TaskCenter({
  tasks,
  activities = [],
  onClearFinished,
  onClearActivities,
  onDismiss,
  onRetry,
}: {
  tasks: TaskItem[];
  activities?: ActivityItem[];
  onClearFinished: () => void;
  onClearActivities?: () => void;
  onDismiss: (id: number) => void;
  onRetry?: (paths: string[]) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const active = tasks.filter((task) => task.status === "running" || task.status === "queued");
  const failed = tasks.filter((task) => task.status === "error").length;
  const done = tasks.filter((task) => task.status === "success").length;
  // 任务队列空但活动流有内容时，面板降级为纯「最近活动」视图，保持常驻入口。
  const activityOnly = tasks.length === 0 && activities.length > 0;

  useEffect(() => {
    if (activityOnly) {
      setCollapsed(false);
      return;
    }
    if (active.length > 0) {
      setCollapsed(false);
      return;
    }
    if (failed > 0) return;
    const timer = window.setTimeout(() => setCollapsed(true), 4200);
    return () => window.clearTimeout(timer);
  }, [active.length, failed, activityOnly]);

  const visible = useMemo(() => tasks.slice(-7).reverse(), [tasks]);
  const feed = useMemo(() => activities.slice(-10).reverse(), [activities]);
  if (tasks.length === 0 && activities.length === 0) return null;

  return (
    <section
      className={`task-center ${collapsed ? "is-collapsed" : ""}`}
      aria-label={activityOnly ? t("taskCenter.recentActivityAria") : t("taskCenter.titleAria")}
      aria-live="polite"
    >
      <header className="task-center-head">
        <div className="task-center-title">
          <span className={`task-pulse ${active.length > 0 ? "is-live" : ""}`} />
          <div>
            <strong>{activityOnly ? "RECENT ACTIVITY" : "TASK QUEUE"}</strong>
            <span>
              {activityOnly
                ? t("taskCenter.recentFeedCount", { count: feed.length })
                : active.length > 0
                  ? t("taskCenter.activeCount", { count: active.length })
                  : failed > 0
                    ? t("taskCenter.failedDone", { failed, done })
                    : t("taskCenter.doneCount", { count: done })}
            </span>
          </div>
        </div>
        <div className="task-center-actions">
          {activityOnly && onClearActivities ? (
            <button
              className="mini-btn"
              onClick={onClearActivities}
              title={t("taskCenter.clearActivities")}
              aria-label={t("taskCenter.clearActivities")}
            >
              <Trash2 size={12} />
            </button>
          ) : null}
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
              ? `${active.length} RUNNING`
              : done > 0
                ? `${done} DONE`
                : feed.length > 0
                  ? `${feed.length} LOGGED`
                  : "IDLE"}
          </span>
          {failed > 0 ? <b>{failed} FAILED</b> : null}
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
                      <div className={`task-progress ${task.status === "running" ? "is-live" : ""}`}>
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
              <footer className="task-center-foot">
                <span>{t("taskCenter.failedRetained")}</span>
                <button className="link-btn" onClick={onClearFinished} disabled={done + failed === 0}>
                  {t("taskCenter.clear")}
                </button>
              </footer>
            </>
          ) : null}

          {feed.length > 0 ? (
            <div className={`activity-feed ${tasks.length > 0 ? "has-tasks" : ""}`}>
              {tasks.length > 0 ? <div className="activity-label">// RECENT ACTIVITY</div> : null}
              {feed.map((item) => (
                <div key={item.id} className="activity-row">
                  <span className="activity-time">{clockTime(item.at)}</span>
                  <span className="activity-copy">
                    <strong title={item.title}>{item.title}</strong>
                    {item.detail ? <span title={item.detail}>{item.detail}</span> : null}
                  </span>
                </div>
              ))}
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
