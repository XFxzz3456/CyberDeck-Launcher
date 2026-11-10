import { useCallback, useEffect, useState } from "react";
import { FolderOpen, ImageOff, Images, Trash2 } from "lucide-react";
import { api } from "../lib/api";
import type { CoverCacheStats } from "../types";
import { t } from "../i18n";
import { Badge, Spinner, Toggle } from "./ui";
import "./CoverCacheCard.css";

/** 字节 → 人类可读。缓存总量一般几百 KB 到几十 MB，两位小数足够。 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * 设置页「封面缓存」卡片。
 *
 * 为什么要单独一块：模组封面图原先直接吃 Nexus 的远程地址，每渲染一次发一次请求。
 * CDN 慢、被墙、图挂了，界面上就是一片空白，而用户完全看不出原因（也不会知道
 * 清一下/补一下就能好）。这里把「现在有多少、占多大、还差几张」摊开，并给两个
 * 动作：补全缺失 / 一键清理。
 */
export function CoverCacheCard({
  autoCache,
  onToggleAuto,
  onError,
  onFilled,
}: {
  autoCache: boolean;
  onToggleAuto: (enabled: boolean) => void;
  onError: (error: unknown, title?: string) => void;
  /** 补全成功后通知外层刷新快照（模组条目的 coverCachePath 变了）。 */
  onFilled: () => void;
}) {
  const [stats, setStats] = useState<CoverCacheStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [filling, setFilling] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [note, setNote] = useState("");

  const load = useCallback(async () => {
    try {
      setStats(await api.coverCacheStats());
    } catch (error) {
      onError(error, t("coverCache.error"));
    } finally {
      setLoading(false);
    }
  }, [onError]);

  useEffect(() => {
    void load();
  }, [load]);

  const fill = useCallback(async () => {
    setFilling(true);
    setNote("");
    try {
      const report = await api.coverCacheFill();
      setStats(report.stats);
      if (report.downloaded > 0) {
        onFilled();
        setNote(t("coverCache.fillDone", { count: report.downloaded }));
      } else if (report.failed > 0) {
        setNote(t("coverCache.fillFailed", { count: report.failed }));
      } else {
        setNote(t("coverCache.fillNothing"));
      }
    } catch (error) {
      onError(error, t("coverCache.fillError"));
    } finally {
      setFilling(false);
    }
  }, [onError, onFilled]);

  const clear = useCallback(async () => {
    setClearing(true);
    setNote("");
    try {
      setStats(await api.coverCacheClear());
      onFilled();
      setNote(t("coverCache.clearDone"));
    } catch (error) {
      onError(error, t("coverCache.clearError"));
    } finally {
      setClearing(false);
    }
  }, [onError, onFilled]);

  const busy = filling || clearing;

  return (
    <section className="panel cover-cache-panel">
      <header className="panel-head">
        <div>
          <div className="panel-eyebrow">// IMAGE CACHE / COVER ART</div>
          <h2>{t("coverCache.title")}</h2>
        </div>
        <div className="cover-cache-head-actions">
          <button className="btn btn-ghost btn-sm" onClick={() => void fill()} disabled={busy || loading}>
            {filling ? <Spinner size={13} /> : <Images size={13} />}
            {t("coverCache.fill")}
          </button>
          <button
            className="btn btn-ghost btn-sm danger-text"
            onClick={() => void clear()}
            disabled={busy || loading || (stats?.count ?? 0) === 0}
          >
            {clearing ? <Spinner size={13} /> : <Trash2 size={13} />}
            {t("coverCache.clear")}
          </button>
        </div>
      </header>

      <p className="panel-copy">{t("coverCache.intro")}</p>

      <div className="cover-cache-figures">
        <div className="cover-cache-figure">
          <span className="cover-cache-label">{t("coverCache.cachedLabel")}</span>
          <strong>{loading ? "—" : (stats?.cached ?? 0)}</strong>
        </div>
        <div className="cover-cache-figure">
          <span className="cover-cache-label">{t("coverCache.filesLabel")}</span>
          <strong>{loading ? "—" : (stats?.count ?? 0)}</strong>
        </div>
        <div className="cover-cache-figure">
          <span className="cover-cache-label">{t("coverCache.sizeLabel")}</span>
          <strong>{loading ? "—" : formatBytes(stats?.bytes ?? 0)}</strong>
        </div>
        <div className="cover-cache-figure">
          <span className="cover-cache-label">{t("coverCache.pendingLabel")}</span>
          <strong>
            {loading ? "—" : (stats?.pending ?? 0)}
            {(stats?.pending ?? 0) > 0 ? <Badge tone="yellow">{t("coverCache.pendingBadge")}</Badge> : null}
          </strong>
        </div>
      </div>

      {stats?.dir ? (
        <div className="cover-cache-path">
          <code title={stats.dir}>{stats.dir}</code>
          <button
            className="mini-btn"
            title={t("coverCache.openDir")}
            aria-label={t("coverCache.openDir")}
            onClick={() => void api.openInExplorer(stats.dir).catch((error) => onError(error))}
          >
            <FolderOpen size={13} />
          </button>
        </div>
      ) : null}

      <div className="cover-cache-auto">
        <div>
          <strong>{t("coverCache.autoTitle")}</strong>
          <small>{t("coverCache.autoHint")}</small>
        </div>
        <Toggle checked={autoCache} onChange={onToggleAuto} label={t("coverCache.autoTitle")} />
      </div>

      {note ? <small className="cover-cache-note">{note}</small> : null}
      {(stats?.pending ?? 0) === 0 && (stats?.count ?? 0) === 0 && !loading ? (
        <small className="cover-cache-note cover-cache-note-muted">
          <ImageOff size={12} /> {t("coverCache.emptyHint")}
        </small>
      ) : null}
    </section>
  );
}
