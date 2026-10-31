import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Compass,
  Crown,
  Download,
  ExternalLink,
  FileArchive,
  KeyRound,
  RefreshCw,
  Search,
  ShieldCheck,
  User,
  X,
} from "lucide-react";
import type {
  NexusDownloadProgress,
  NexusFile,
  NexusModDetail,
  NexusModSummary,
  NexusSection,
  NexusStatus,
} from "../types";
import { api, isTauri, normalizeError } from "../lib/api";
import { formatBytes, relativeTime } from "../lib/format";
import { notifyNexusStatusChanged, onNexusStatusChanged } from "../lib/nexusBus";
import { t } from "../i18n";
import { Badge, Modal, Spinner } from "./ui";

/** 事件来源标记：自己广播的事件要跳过，避免重复拉状态。 */
const SOURCE = "nexus";

const SECTIONS: Array<{ id: NexusSection; label: string; detail: string }> = [
  { id: "trending", label: t("nexus.sectionTrending"), detail: t("nexus.sectionTrendingDetail") },
  { id: "latest_added", label: t("nexus.sectionLatest"), detail: t("nexus.sectionLatestDetail") },
  { id: "latest_updated", label: t("nexus.sectionUpdated"), detail: t("nexus.sectionUpdatedDetail") },
];

function stripBbcode(text: string): string {
  return text
    .replace(/\[\/?(?:b|i|u|s|size|color|font|center|left|right|quote|code|spoiler|list|\*|img|url)[^\]]*\]/gi, "")
    .replace(/\r/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function modInitials(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9\u4e00-\u9fff ]/g, "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

function NexusCard({ mod, onOpen }: { mod: NexusModSummary; onOpen: () => void }) {
  const [broken, setBroken] = useState(false);
  return (
    <article className="nexus-card" onClick={onOpen} tabIndex={0} role="button">
      <div className="nexus-cover">
        {mod.pictureUrl && !broken ? (
          <img src={mod.pictureUrl} alt="" loading="lazy" onError={() => setBroken(true)} />
        ) : (
          <div className="nexus-cover-fallback">{modInitials(mod.name)}</div>
        )}
        <div className="nexus-cover-top">
          <span>{mod.category || t("nexus.categoryFallback")}</span>
          {mod.adult ? <span className="nexus-adult">18+</span> : null}
        </div>
        <div className="nexus-cover-bottom">
          <span>v{mod.version || "—"}</span>
          <span>{t("nexus.endorsements", { count: mod.endorsements.toLocaleString() })}</span>
        </div>
      </div>
      <div className="nexus-card-body">
        <h3>{mod.name}</h3>
        <div className="nexus-byline">
          {mod.author || t("nexus.authorUnknown")} <span>·</span> {t("nexus.downloads", { count: mod.downloads.toLocaleString() })}
        </div>
        <p>{mod.summary || t("nexus.summaryFallback")}</p>
        <div className="nexus-card-foot">
          <span>{mod.updatedTime ? t("nexus.updatedAt", { time: relativeTime(mod.updatedTime) }) : t("nexus.updatedUnknown")}</span>
          <span className="nexus-open">{t("nexus.viewFiles")} <ExternalLink size={11} /></span>
        </div>
      </div>
    </article>
  );
}

export function NexusView({
  onImported,
  onError,
  onToast,
  onNavigateSettings,
}: {
  onImported: () => Promise<void>;
  onError: (error: unknown, title?: string) => void;
  onToast: (tone: "ok" | "error" | "info" | "warn", title: string, message?: string) => void;
  onNavigateSettings: () => void;
}) {
  const [status, setStatus] = useState<NexusStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [section, setSection] = useState<NexusSection>("trending");
  const [mods, setMods] = useState<NexusModSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [keyInput, setKeyInput] = useState("");
  const [savingKey, setSavingKey] = useState(false);
  const [selected, setSelected] = useState<NexusModSummary | null>(null);
  const [detail, setDetail] = useState<NexusModDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [downloadFileId, setDownloadFileId] = useState<number | null>(null);
  const [progress, setProgress] = useState<NexusDownloadProgress | null>(null);

  const loadStatus = async () => {
    setStatusLoading(true);
    try {
      setStatus(await api.nexusStatus());
    } catch (error) {
      onError(error, t("nexus.statusError"));
    } finally {
      setStatusLoading(false);
    }
  };

  useEffect(() => {
    void loadStatus();
    // 设置页里连接/断开了账号，本页跟着重拉：顶部的账户卡片之前会一直停在旧状态。
    return onNexusStatusChanged(SOURCE, () => {
      void loadStatus();
    });
  }, []);

  useEffect(() => {
    if (!isTauri) return;
    let unlisten: (() => void) | undefined;
    void (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        unlisten = await listen<NexusDownloadProgress>("nexus-download-progress", (event) => {
          setProgress(event.payload);
        });
      } catch {
        // Browser preview or an environment without the event API.
      }
    })();
    return () => unlisten?.();
  }, []);

  const loadMods = async (nextSection: NexusSection) => {
    if (!status?.connected) return;
    setLoading(true);
    setListError(null);
    try {
      const list = await api.nexusBrowse(nextSection);
      setMods(list);
    } catch (error) {
      const parsed = normalizeError(error);
      setMods([]);
      setListError(parsed.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (status?.connected) void loadMods(section);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status?.connected, section]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return mods;
    return mods.filter((item) =>
      `${item.name} ${item.summary} ${item.author} ${item.category}`.toLowerCase().includes(needle),
    );
  }, [mods, query]);

  const openDetail = async (mod: NexusModSummary) => {
    setSelected(mod);
    setDetail(null);
    setDetailLoading(true);
    try {
      setDetail(await api.nexusDetail(mod.modId));
    } catch (error) {
      onError(error, t("nexus.detailError"));
    } finally {
      setDetailLoading(false);
    }
  };

  const closeDetail = () => {
    if (downloadFileId !== null) return;
    setSelected(null);
    setDetail(null);
    setProgress(null);
  };

  const connect = async () => {
    if (!keyInput.trim()) return;
    setSavingKey(true);
    try {
      const next = await api.setNexusKey(keyInput.trim());
      setStatus(next);
      setKeyInput("");
      notifyNexusStatusChanged(SOURCE);
      if (next.connected) {
        onToast("ok", t("nexus.connectedToast"), t("nexus.welcome", { name: next.user?.name ?? "V" }));
      }
    } catch (error) {
      onError(error, t("nexus.connectFailed"));
    } finally {
      setSavingKey(false);
    }
  };

  const disconnect = async () => {
    try {
      setStatus(await api.clearNexusKey());
      setMods([]);
      notifyNexusStatusChanged(SOURCE);
      onToast("info", t("nexus.keyRemoved"));
    } catch (error) {
      onError(error, t("nexus.keyRemoveFailed"));
    }
  };

  const download = async (file: NexusFile) => {
    if (!selected) return;
    setDownloadFileId(file.fileId);
    setProgress(null);
    try {
      const result = await api.nexusDownload(selected.modId, file.fileId, file.fileName);
      await onImported();
      onToast(
        "ok",
        t("nexus.importedToast", { name: result.outcome.modEntry?.name ?? selected.name }),
        result.reused ? t("nexus.reusedHint") : t("nexus.downloadedHint"),
      );
      setDownloadFileId(null);
      setSelected(null);
      setDetail(null);
    } catch (error) {
      onError(error, t("nexus.downloadFailed"));
      setDownloadFileId(null);
    }
  };

  const openPage = (url: string | null | undefined) => {
    if (!url) return;
    void api.openUrl(url).catch((error) => onError(error, t("nexus.openUrlFailed")));
  };

  if (statusLoading && !status) {
    return (
      <div className="page nexus-page">
        <div className="diagnostics-loading">
          <Compass size={34} />
          <h2>{t("nexus.connecting")}</h2>
          <p>{t("nexus.connectingDetail")}</p>
          <Spinner size={22} />
        </div>
      </div>
    );
  }

  return (
    <div className="page nexus-page">
      <header className="page-head">
        <div>
          <div className="eyebrow">{t("nexus.eyebrow")}</div>
          <h1>
            {t("nexus.title")}<span className="h1-accent">.</span>
          </h1>
          <p className="page-sub">
            {t("nexus.subtitle")}
          </p>
        </div>
        <div className="head-actions">
          {status?.connected ? (
            <div className="nexus-account">
              <span className="nexus-account-icon">
                <User size={13} />
              </span>
              <div>
                <strong>{status.user?.name ?? t("nexus.userFallback")}</strong>
                <span>
                  {status.user?.isPremium ? (
                    <>
                      <Crown size={10} /> {t("nexus.premium")}
                    </>
                  ) : (
                    t("nexus.freeAccount")
                  )}
                </span>
              </div>
              <button className="mini-btn" onClick={() => void disconnect()} title={t("nexus.removeKeyTitle")}>
                <X size={12} />
              </button>
            </div>
          ) : null}
          <button className="btn btn-ghost" onClick={onNavigateSettings}>
            <KeyRound size={14} /> {t("nexus.accountSettings")}
          </button>
        </div>
      </header>

      {!status?.connected ? (
        <section className="panel nexus-setup">
          <div className="nexus-setup-hero">
            <div className="nexus-setup-mark">
              <Compass size={30} />
            </div>
            <div>
              <div className="panel-eyebrow">{t("nexus.connectEyebrow")}</div>
              <h2>{t("nexus.connectTitle")}</h2>
              <p>
                {t("nexus.connectDetail")}
              </p>
            </div>
          </div>
          <div className="nexus-key-row">
            <label>
              <span>{t("nexus.apiKeyLabel")}</span>
              <input
                type="password"
                value={keyInput}
                onChange={(event) => setKeyInput(event.target.value)}
                placeholder={t("nexus.keyPlaceholder")}
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <button className="btn btn-primary" onClick={() => void connect()} disabled={savingKey || !keyInput.trim()}>
              {savingKey ? <Spinner /> : <KeyRound size={14} />} {t("nexus.connect")}
            </button>
            <button
              className="btn btn-ghost"
              onClick={() => openPage("https://www.nexusmods.com/users/myaccount?tab=api")}
            >
              <ExternalLink size={13} /> {t("nexus.getKey")}
            </button>
          </div>
          {status?.error ? (
            <div className="inline-warning compact">
              <AlertTriangle size={13} /> {status.error}
            </div>
          ) : null}
          <p className="panel-note">
            {t("nexus.noPasswordNote")}
          </p>
        </section>
      ) : (
        <>
          <div className="nexus-toolbar">
            <div className="nexus-tabs">
              {SECTIONS.map((item) => (
                <button
                  key={item.id}
                  className={`nexus-tab ${section === item.id ? "active" : ""}`}
                  onClick={() => setSection(item.id)}
                >
                  <strong>{item.label}</strong>
                  <span>{item.detail}</span>
                </button>
              ))}
            </div>
            <div className="nexus-search">
              <Search size={14} />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t("nexus.filterPlaceholder")}
              />
              {query ? (
                <button className="search-clear" onClick={() => setQuery("")} aria-label={t("nexus.clearFilter")}>
                  <X size={12} />
                </button>
              ) : null}
            </div>
            <button className="btn btn-ghost btn-sm" onClick={() => void loadMods(section)} disabled={loading}>
              {loading ? <Spinner size={13} /> : <RefreshCw size={13} />} {t("common.refresh")}
            </button>
            {/* Nexus 的官方 API v1 没有搜索/分页端点，深挖内容只能去网页搜。
                这里把当前过滤词拼成 Nexus 的搜索页链接交给系统浏览器。 */}
            <button
              className="btn btn-ghost btn-sm"
              onClick={() =>
                openPage(
                  `https://www.nexusmods.com/cyberpunk2077/search/?gsearch=${encodeURIComponent(
                    query.trim(),
                  )}`,
                )
              }
              disabled={!query.trim()}
              title={t("nexus.webSearchTitle")}
            >
              <ExternalLink size={13} /> {t("nexus.webSearch")}
            </button>
            <button
              className="btn btn-ghost btn-sm"
              onClick={() =>
                openPage(
                  `https://www.nexusmods.com/cyberpunk2077/search/?gsearch=${encodeURIComponent(query)}`,
                )
              }
            >
              <ExternalLink size={12} /> {t("nexus.siteSearch")}
            </button>
          </div>

          {!status.user?.isPremium ? (
            <div className="nexus-free-note">
              <ShieldCheck size={14} />
              <span>
                {t("nexus.freeNote")}
              </span>
            </div>
          ) : null}

          {listError ? (
            <div className="inline-warning">
              <AlertTriangle size={14} /> <span>{listError}</span>
            </div>
          ) : null}

          {loading && mods.length === 0 ? (
            <div className="nexus-loading">
              <Spinner size={22} />
              <span>{t("nexus.listLoading")}</span>
            </div>
          ) : filtered.length === 0 ? (
            <div className="nexus-empty">
              <Compass size={26} />
              <strong>{t("nexus.emptyTitle")}</strong>
              <span>{t("nexus.emptyHint")}</span>
            </div>
          ) : (
            <div className="nexus-grid">
              {filtered.map((mod) => (
                <NexusCard key={mod.modId} mod={mod} onOpen={() => void openDetail(mod)} />
              ))}
            </div>
          )}
        </>
      )}

      <Modal
        open={Boolean(selected)}
        title={selected?.name ?? t("nexus.modFallbackTitle")}
        eyebrow={t("nexus.pickerEyebrow")}
        width={760}
        onClose={closeDetail}
        footer={
          <>
            <button className="btn btn-ghost" onClick={() => openPage(selected?.modPageUrl)}>
              <ExternalLink size={13} /> {t("nexus.modPage")}
            </button>
            <button className="btn btn-ghost" onClick={closeDetail} disabled={downloadFileId !== null}>
              {t("common.close")}
            </button>
          </>
        }
      >
        {detailLoading ? (
          <div className="nexus-detail-loading">
            <Spinner size={20} /> {t("nexus.filesLoading")}
          </div>
        ) : detail ? (
          <div className="nexus-detail">
            <div className="nexus-detail-top">
              <div className="nexus-detail-cover">
                {detail.summary.pictureUrl ? (
                  <img src={detail.summary.pictureUrl} alt="" />
                ) : (
                  <div className="nexus-cover-fallback">{modInitials(detail.summary.name)}</div>
                )}
              </div>
              <div className="nexus-detail-meta">
                <div className="nexus-detail-badges">
                  <Badge tone="cyan">{detail.summary.category || t("nexus.categoryFallback")}</Badge>
                  {detail.summary.adult ? <Badge tone="red">18+</Badge> : null}
                  <Badge tone="yellow">v{detail.summary.version || "—"}</Badge>
                </div>
                <p>{detail.summary.summary || t("nexus.summaryFallback")}</p>
                <div className="nexus-detail-stats">
                  <span>{detail.summary.author || t("nexus.authorUnknown")}</span>
                  <span>·</span>
                  <span>{t("nexus.downloads", { count: detail.summary.downloads.toLocaleString() })}</span>
                  <span>·</span>
                  <span>{t("nexus.endorsementsDetail", { count: detail.summary.endorsements.toLocaleString() })}</span>
                </div>
              </div>
            </div>

            <div className="nexus-detail-desc">{stripBbcode(detail.description) || t("nexus.noDescription")}</div>

            <div className="nexus-file-head">
              <div>
                <div className="panel-eyebrow">{t("nexus.filesEyebrow")}</div>
                <h3>{t("nexus.chooseFileTitle")}</h3>
              </div>
              <span>{t("nexus.filesCount", { count: detail.files.length })}</span>
            </div>
            <div className="nexus-file-list">
              {detail.files.length === 0 ? (
                <div className="muted-line">{t("nexus.noFiles")}</div>
              ) : (
                detail.files.map((file) => (
                  <div key={file.fileId} className="nexus-file-row">
                    <FileArchive size={16} />
                    <div className="nexus-file-copy">
                      <strong>{file.name || file.fileName}</strong>
                      <span>
                        {file.fileName} · v{file.version || "—"} · {formatBytes(file.sizeKb * 1024)}
                        {file.uploadedTime ? ` · ${relativeTime(file.uploadedTime)}` : ""}
                      </span>
                    </div>
                    <button
                      className="btn btn-primary btn-sm"
                      disabled={!status?.user?.isPremium || downloadFileId !== null}
                      title={
                        status?.user?.isPremium
                          ? t("nexus.downloadTitle")
                          : t("nexus.downloadPremiumOnly")
                      }
                      onClick={() => void download(file)}
                    >
                      {downloadFileId === file.fileId ? <Spinner size={13} /> : <Download size={13} />}
                      {status?.user?.isPremium ? t("nexus.downloadImport") : t("nexus.needsPremium")}
                    </button>
                  </div>
                ))
              )}
            </div>
            {downloadFileId !== null ? (
              <div className="nexus-progress">
                <div className="nexus-progress-head">
                  <span>{t("nexus.downloading")}</span>
                  <span>
                    {progress
                      ? `${formatBytes(progress.received)}${progress.total ? ` / ${formatBytes(progress.total)}` : ""}`
                      : t("nexus.waitingServer")}
                  </span>
                </div>
                <div className="nexus-progress-bar">
                  <i
                    style={{
                      width: progress?.total
                        ? `${Math.min(100, (progress.received / progress.total) * 100)}%`
                        : "38%",
                    }}
                  />
                </div>
              </div>
            ) : null}
            {!status?.user?.isPremium ? (
              <div className="nexus-free-note compact">
                <ShieldCheck size={13} />
                <span>
                  {t("nexus.freeCompactNote")}
                </span>
              </div>
            ) : null}
          </div>
        ) : (
          <div className="muted-line">{t("nexus.detailUnavailable")}</div>
        )}
      </Modal>
    </div>
  );
}
