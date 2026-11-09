import { useCallback, useEffect, useRef, useState } from "react";
import { FolderOpen, FolderSearch, Gauge, Pause, Play, Plus, RefreshCw, Trash2, Upload, X } from "lucide-react";
import type { DownloadTask, DownloadTaskStatus } from "../types";
import { api, normalizeError } from "../lib/api";
import { t, type MessageKey } from "../i18n";
import { formatBytes } from "../lib/format";
import { Badge } from "./ui";

/** 状态 → 词条键。 */
const STATUS_KEY: Record<DownloadTaskStatus, MessageKey> = {
  queued: "downloads.statusQueued",
  downloading: "downloads.statusDownloading",
  paused: "downloads.statusPaused",
  completed: "downloads.statusCompleted",
  failed: "downloads.statusFailed",
  cancelled: "downloads.statusCancelled",
} as const;

/**
 * 鉴权类失败的判别正则。
 * 匹配的是 Rust 后端回传的错误文案（协议字段，不走前端词表），
 * 因此这里的中文不是界面文案，不参与 i18n。 // i18n-ignore
 */
const AUTH_ERROR_RE = /401|API Key 已失效|Key 无效/; // i18n-ignore

function percent(task: DownloadTask): number | null {
  if (!task.total || task.total <= 0) return null;
  return Math.min(100, Math.round((task.received / task.total) * 100));
}

/** 速度折线采样窗口：约 72 秒（60 点 × 1.2s 轮询）。 */
const SPEED_WINDOW = 60;
const SPARK_W = 240;
const SPARK_H = 44;

/** 速度折线图（deepseek 任务·模块二）：纯 SVG polyline，无依赖无动画帧。 */
function SpeedSparkline({ history }: { history: number[] }) {
  if (history.length < 2) {
    return (
      <div className="dl-spark dl-spark-empty" aria-hidden="true">
        <span>{t("downloads.sparkWaiting")}</span>
      </div>
    );
  }
  const max = Math.max(...history, 1);
  const step = SPARK_W / (SPEED_WINDOW - 1);
  // 有数据以来不足一个窗口时，从左侧留白开始画，避免折线被拉伸变形。
  const offset = (SPEED_WINDOW - history.length) * step;
  const points = history
    .map((value, index) => {
      const x = offset + index * step;
      const y = SPARK_H - 2 - (value / max) * (SPARK_H - 6);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg
      className="dl-spark"
      viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={t("downloads.sparkAria")}
    >
      <polyline className="dl-spark-area" points={`0,${SPARK_H} ${points} ${SPARK_W},${SPARK_H}`} />
      <polyline className="dl-spark-line" points={points} />
    </svg>
  );
}

/**
 * 下载中心（r20 重排：任务列表页，不是设置页）。
 *
 * 这里只做一件事：把队列讲清楚——全局操作、每个任务跑到哪了、能对它做什么。
 * 目录 / 并发 / 自动导入 / 代理等表单在「设置 → 工具组件 → 下载设置」。
 *
 * 数据源：1.2s 轮询队列列表。不用事件推送做首因（浏览器预览 / UI 回归没有
 * Rust 后端），`download-progress` 事件的 toast 触发仍在 App 层，这里不碰。
 */
export function DownloadsView({
  onNavigateDiscover,
  onOpenNexusSettings,
  dataDir,
}: {
  onNavigateDiscover?: () => void;
  /** Nexus 鉴权失败时的一键出口：跳到「设置 → 工具插件 → Nexus Mods」。 */
  onOpenNexusSettings?: () => void;
  /** 数据目录根路径（打开"默认下载目录"时拼 downloads 子目录用）。 */
  dataDir?: string | null;
}) {
  const [tasks, setTasks] = useState<DownloadTask[]>([]);
  const [dir, setDir] = useState<string | null>(null);
  const [dirLoaded, setDirLoaded] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  // 速度估算：相邻两次轮询的字节差 / 时间差。
  const prevRef = useRef<Map<string, { received: number; at: number }>>(new Map());
  const [speeds, setSpeeds] = useState<Map<string, number>>(new Map());
  // 速度折线的历史采样：每次轮询记一个总速率点（deepseek 任务·模块二）。
  const [speedHistory, setSpeedHistory] = useState<number[]>([]);
  const [dropHot, setDropHot] = useState(false);
  const [busy, setBusy] = useState(false);
  /** 轮询自身的失败原因（后端没起来 / 命令报错）。只显示不弹 toast，
   *  恢复后自动消失——1.2 秒一次的错误弹窗会把界面刷满。 */
  const [pollError, setPollError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [list, queueSettings] = await Promise.all([
        api.downloadQueueList(),
        dirLoaded ? Promise.resolve(dir) : api.downloadQueueGetSettings().then((s) => s.dir),
      ]);
      setTasks(list);
      if (!dirLoaded) {
        setDir(queueSettings);
        setDirLoaded(true);
      }
      // 速度估算
      const now = Date.now();
      const next = new Map<string, number>();
      for (const task of list) {
        if (task.status !== "downloading") continue;
        const prev = prevRef.current.get(task.id);
        if (prev && now > prev.at) {
          const speed = Math.max(0, Math.round(((task.received - prev.received) * 1000) / (now - prev.at)));
          next.set(task.id, speed);
        }
      }
      prevRef.current = new Map(list.map((task) => [task.id, { received: task.received, at: now }]));
      setSpeeds(next);
      // 总速率采样进折线历史。
      const total = [...next.values()].reduce((sum, value) => sum + value, 0);
      setSpeedHistory((current) => [...current.slice(-(SPEED_WINDOW - 1)), total]);
      setPollError(null);
      return true;
    } catch (error) {
      // 不往外抛：轮询调用点都在定时器/void 里，抛出去只会变成未处理拒绝，
      // 错误文案还可能退化成 "[object Object]"。就地记下来显示。
      setPollError(normalizeError(error).message);
      return false;
    }
  }, [dir, dirLoaded]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 1200);
    return () => window.clearInterval(timer);
  }, [refresh]);

  // 提示条定时器：后一条覆盖前一条，组件卸载时清掉（切页面后不该再往已卸载的
  // 组件上 setNote）。
  const noteTimer = useRef<number | null>(null);
  const flash = useCallback((message: string) => {
    setNote(message);
    if (noteTimer.current !== null) window.clearTimeout(noteTimer.current);
    noteTimer.current = window.setTimeout(() => {
      noteTimer.current = null;
      setNote((current) => (current === message ? null : current));
    }, 2600);
  }, []);

  useEffect(
    () => () => {
      if (noteTimer.current !== null) window.clearTimeout(noteTimer.current);
      noteTimer.current = null;
    },
    [],
  );

  const act = useCallback(
    async (action: () => Promise<unknown>, doneMessage = "") => {
      try {
        await action();
        await refresh();
        if (doneMessage) flash(doneMessage);
      } catch (error) {
        flash(normalizeError(error).message);
      }
    },
    [refresh, flash],
  );

  /** 全局批量操作：逐个调用单任务命令（不新增 Tauri 命令，前端循环即可）。 */
  const actAll = useCallback(
    async (targets: DownloadTask[], action: (id: string) => Promise<unknown>, doneMessage: string) => {
      if (targets.length === 0 || busy) return;
      setBusy(true);
      let failed = 0;
      for (const task of targets) {
        try {
          await action(task.id);
        } catch {
          failed += 1;
        }
      }
      setBusy(false);
      await refresh();
      flash(failed > 0 ? t("downloads.batchPartial", { failed }) : doneMessage);
    },
    [busy, refresh, flash],
  );

  const openFolder = useCallback(() => {
    // 与 Rust 侧 resolve 一致：settings.dir ?? <数据目录>/downloads
    const target = dir ?? (dataDir ? `${dataDir}/downloads` : null);
    if (!target) {
      flash(t("downloads.dirUnknown"));
      return;
    }
    void act(() => api.openPath(target));
  }, [dir, dataDir, act, flash]);

  /** 浏览器预览通道：HTML5 drop 读 .nxm 文本投递。Tauri 环境走 App 层的
   *  原生 onDragDropEvent（HTML5 拖拽在 WebView 里被禁用），这里不会被触发。 */
  const handleHtmlDrop = useCallback(
    async (files: FileList | null, rawText?: string) => {
      let links = 0;
      // ① 拖进来的是「链接文本」：从浏览器地址栏 / 网页里拖一条 nxm:// 过来时，
      //    dataTransfer 里没有文件，只有 uri-list 或 plain text。97d09a 模块二要的
      //    就是这条路，之前只认 .nxm 文件，所以拖链接会毫无反应。
      const textBlob = (rawText ?? "").trim();
      if (textBlob) {
        for (const line of textBlob.split(/\r?\n/).map((item) => item.trim())) {
          if (!line.startsWith("nxm://")) continue;
          try {
            await api.nxmIntake(line);
            links += 1;
          } catch (error) {
            flash(normalizeError(error).message);
          }
        }
      }
      // ② 拖进来的是 .nxm 文件：读文件内容，每行一条链接。
      for (const file of Array.from(files ?? [])) {
        if (!file.name.toLowerCase().endsWith(".nxm")) continue;
        try {
          const text = await file.text();
          for (const line of text.split(/\r?\n/).map((item) => item.trim())) {
            if (!line.startsWith("nxm://")) continue;
            await api.nxmIntake(line);
            links += 1;
          }
        } catch (error) {
          flash(normalizeError(error).message);
        }
      }
      if (links > 0) flash(t("downloads.droppedOk", { count: links }));
      else flash(t("downloads.droppedNone"));
    },
    [flash],
  );

  const running = tasks.filter((task) => task.status === "queued" || task.status === "downloading");
  const stopped = tasks.filter((task) => task.status === "paused" || task.status === "failed");
  const finishedCount = tasks.filter(
    (task) => task.status === "completed" || task.status === "failed" || task.status === "cancelled",
  ).length;

  return (
    <section className="view view-downloads" aria-label={t("downloads.title")}>
      <header className="view-head">
        <div>
          <div className="panel-eyebrow">// DOWNLOAD CENTER</div>
          <h1>{t("downloads.title")}</h1>
          <p className="view-intro">{t("downloads.intro")}</p>
        </div>
        {running.length > 0 ? (
          <Badge tone="yellow">{t("downloads.activeBadge", { count: running.length })}</Badge>
        ) : null}
      </header>

      {/* 全局操作条：对整个队列做的事放最上面，一眼能找到。 */}
      <div className="downloads-actions" role="toolbar" aria-label={t("downloads.actionsAria")}>
        <button
          className="btn btn-sm"
          disabled={stopped.length === 0 || busy}
          onClick={() => void actAll(stopped, (id) => api.downloadQueueResume(id), t("downloads.resumedAll"))}
        >
          <Play size={13} /> {t("downloads.resumeAll")}
        </button>
        <button
          className="btn btn-sm"
          disabled={running.length === 0 || busy}
          onClick={() => void actAll(running, (id) => api.downloadQueuePause(id), t("downloads.pausedAll"))}
        >
          <Pause size={13} /> {t("downloads.pauseAll")}
        </button>
        <button
          className="btn btn-ghost btn-sm"
          disabled={finishedCount === 0 || busy}
          onClick={() => void act(() => api.downloadQueueClearFinished(), t("downloads.clearedFinished"))}
        >
          <Trash2 size={13} /> {t("downloads.clearFinished")}
        </button>
        <button className="btn btn-ghost btn-sm" onClick={openFolder}>
          <FolderSearch size={13} /> {t("downloads.openFolder")}
        </button>
        {note ? <span className="downloads-note">{note}</span> : null}
      </div>

      {pollError ? (
        <p className="downloads-poll-error" role="alert">
          {t("downloads.pollFailed", { reason: pollError })}
        </p>
      ) : null}

      {/* 速度折线 + 拖拽接收区（deepseek 任务·模块二）。真实文件拖落在
          Tauri 里由 App 层的 onDragDropEvent 统一接管（.nxm 进收件箱、
          压缩包进导入队列），这里的接收区是可视化提示 + 浏览器预览通道。 */}
      <div className="dl-insights">
        <div className="panel dl-spark-card">
          <div className="panel-head">
            <div>
              <div className="panel-eyebrow">// THROUGHPUT</div>
              <h2>
                <Gauge size={15} /> {t("downloads.sparkTitle")}
              </h2>
            </div>
            <span className="dl-spark-now">
              {formatBytes(speedHistory[speedHistory.length - 1] ?? 0)}/s
            </span>
          </div>
          <SpeedSparkline history={speedHistory} />
        </div>
        <div
          className={`panel dl-dropzone ${dropHot ? "is-hot" : ""}`}
          onDragOver={(event) => {
            event.preventDefault();
            setDropHot(true);
          }}
          onDragLeave={() => setDropHot(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDropHot(false);
            // uri-list 优先：浏览器拖链接时只有它带完整 URL，plain text 可能被截断。
            const text =
              event.dataTransfer.getData("text/uri-list") ||
              event.dataTransfer.getData("text/plain");
            void handleHtmlDrop(event.dataTransfer.files, text);
          }}
        >
          <Upload size={20} aria-hidden="true" />
          <strong>{t("downloads.dropTitle")}</strong>
          <span>{t("downloads.dropDetail")}</span>
        </div>
      </div>

      <div className="downloads-list panel">
        {tasks.length === 0 ? (
          <div className="downloads-empty">
            <FolderOpen size={22} aria-hidden="true" />
            <p>{t("downloads.empty")}</p>
            {onNavigateDiscover ? (
              <button className="btn btn-sm" onClick={onNavigateDiscover}>
                <Plus size={13} /> {t("downloads.goDiscover")}
              </button>
            ) : null}
          </div>
        ) : (
          <ul className="downloads-rows">
            {tasks.map((task) => {
              const pct = percent(task);
              const speed = speeds.get(task.id);
              return (
                <li key={task.id} className={`download-row is-${task.status}`}>
                  <div className="download-row-main">
                    <span className="download-name" title={task.fileName}>
                      {task.name}
                    </span>
                    <span className={`download-status is-${task.status}`}>
                      {task.status === "downloading" ? <RefreshCw size={11} className="spin" /> : null}
                      {t(STATUS_KEY[task.status])}
                      {task.retries > 0 && task.status === "queued"
                        ? ` · ${t("downloads.retrySuffix", { count: task.retries })}`
                        : ""}
                    </span>
                    <span className="download-size">
                      {task.received > 0
                        ? `${formatBytes(task.received)}${task.total ? ` / ${formatBytes(task.total)}` : ""}`
                        : ""}
                      {speed ? ` · ${formatBytes(speed)}/s` : ""}
                    </span>
                  </div>
                  <div className="dl-bar" aria-hidden="true">
                    <span style={{ width: pct !== null ? `${pct}%` : task.status === "downloading" ? "30%" : "0%" }} />
                  </div>
                  {task.error ? (
                    <div className="download-error">
                      <span>{task.error}</span>
                      {/* 401 / Key 失效属于"要去改配置"，重试解决不了：给直达入口。 */}
                      {onOpenNexusSettings && AUTH_ERROR_RE.test(task.error) ? (
                        <button className="link-btn" onClick={onOpenNexusSettings}>
                          {t("downloads.openNexusSettings")}
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                  <div className="download-actions">
                    {task.status === "downloading" || task.status === "queued" ? (
                      <button
                        className="btn btn-ghost btn-sm"
                        onClick={() => void act(() => api.downloadQueuePause(task.id))}
                      >
                        <Pause size={13} /> {t("downloads.pause")}
                      </button>
                    ) : null}
                    {task.status === "paused" || task.status === "failed" ? (
                      <button
                        className="btn btn-ghost btn-sm"
                        onClick={() => void act(() => api.downloadQueueResume(task.id))}
                      >
                        <Play size={13} /> {t("downloads.resume")}
                      </button>
                    ) : null}
                    {task.status === "queued" ||
                    task.status === "downloading" ||
                    task.status === "paused" ? (
                      <button
                        className="btn btn-ghost btn-sm"
                        onClick={() => void act(() => api.downloadQueueCancel(task.id))}
                      >
                        <X size={13} /> {t("downloads.cancel")}
                      </button>
                    ) : (
                      <button
                        className="btn btn-ghost btn-sm"
                        onClick={() => void act(() => api.downloadQueueRemove(task.id))}
                      >
                        <Trash2 size={13} /> {t("downloads.remove")}
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
