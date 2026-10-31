import { useCallback, useEffect, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  AlertTriangle,
  CheckCircle2,
  CircleAlert,
  ExternalLink,
  FolderOpen,
  ListChecks,
  PackageOpen,
  Rocket,
  ShieldAlert,
} from "lucide-react";
import { t } from "../i18n";
import { api, isTauri, normalizeError } from "../lib/api";
import {
  COLLECTION_STATUS_LABEL,
  collectionDeployIds,
  collectionVersionMismatchCount,
  type CollectionItem,
  type CollectionPlan,
} from "../lib/collection";
import { Badge, EmptyState, Modal, Spinner, SwitchRow } from "./ui";

/** 自动重新核对清单与本地库的间隔（毫秒）。 */
const REFRESH_INTERVAL = 3000;

/** 三种状态的图标与颜色各不相同，用内联色省掉一套新 class。 */
function statusIcon(item: CollectionItem) {
  if (item.status === "installed") {
    return <CheckCircle2 size={14} style={{ color: "var(--green)" }} />;
  }
  if (item.status === "version_mismatch") {
    return <AlertTriangle size={14} style={{ color: "var(--warn)" }} />;
  }
  return <CircleAlert size={14} style={{ color: "var(--danger)" }} />;
}

function statusTone(item: CollectionItem): "green" | "yellow" | "red" {
  if (item.status === "installed") return "green";
  if (item.status === "version_mismatch") return "yellow";
  return "red";
}

/**
 * Nexus Collections 集合安装向导。
 *
 * 流程是「读清单 → 看缺什么 → 去 N 网页面下载 → 把 ZIP 拖回窗口导入 → 部署」。
 * 故意不做自动下载：Nexus 只给高级会员签发直链，普通账号走 API 直链会被拒，
 * 启动器也不该绕过这层限制。
 */
export function CollectionWizard({
  open,
  manifestPath,
  onClose,
  onRefresh,
  onImportMods,
  onPickFile,
  onManifestPicked,
}: {
  open: boolean;
  /** 当前集合清单路径；null 表示还没选文件。 */
  manifestPath: string | null;
  onClose: () => void;
  /** 部署后重新拉一次模组库快照。 */
  onRefresh: () => void;
  /** 打开既有的模组导入对话框（把下载好的 ZIP 拖进窗口后走它）。 */
  onImportMods: () => void;
  /** 重新挑一个集合清单文件。 */
  onPickFile: () => void;
  /** 浏览器预览模式选到文件后的回调（只有文件名，没有完整路径）。 */
  onManifestPicked: (path: string) => void;
}) {
  const [plan, setPlan] = useState<CollectionPlan | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [deploying, setDeploying] = useState(false);
  /** 「监听下载目录」开关：开启后每 3 秒重新核对清单与本地库。 */
  const [watch, setWatch] = useState(false);
  const [downloadDir, setDownloadDir] = useState<string | null>(null);
  // 轮询时避免上一次请求还没回来就发下一次。
  const busyRef = useRef(false);
  const browserInput = useRef<HTMLInputElement>(null);

  const parse = useCallback(async () => {
    if (!manifestPath || busyRef.current) return;
    busyRef.current = true;
    try {
      const next = await api.parseCollectionManifest(manifestPath);
      setPlan(next);
      setError(null);
    } catch (err) {
      setError(normalizeError(err).message);
    } finally {
      busyRef.current = false;
    }
  }, [manifestPath]);

  // 打开面板或换了清单文件就重新解析一次。
  useEffect(() => {
    if (!open || !manifestPath) return;
    setLoading(true);
    setResult(null);
    void parse().finally(() => setLoading(false));
  }, [open, manifestPath, parse]);

  // 监听下载目录：每 3 秒重新核对一次清单。用户在别处导入完模组后，
  // 面板里的「缺失 / 版本不一致」会自己变绿，不用手动重开。
  useEffect(() => {
    if (!open || !watch || !manifestPath) return;
    const timer = window.setInterval(() => void parse(), REFRESH_INTERVAL);
    return () => window.clearInterval(timer);
  }, [open, watch, manifestPath, parse]);

  const handleDeploy = async () => {
    if (!plan?.readyToDeploy || deploying) return;
    const ids = collectionDeployIds(plan);
    if (ids.length === 0) {
      setError(t("collection.noDeployable"));
      return;
    }
    setDeploying(true);
    setResult(null);
    setError(null);
    try {
      const report = await api.applyCollectionOrder(ids);
      onRefresh();
      // 整批结果：成功几个、失败几个。失败是常态（单个 Mod 冲突不该让其余白做），
      // 所以分开说，别只报一个笼统的「成功」。
      const parts = [t("collection.deploySummary", { count: report.deployed })];
      if (report.failed > 0) parts.push(t("collection.deployFailed", { count: report.failed }));
      if (report.warnings.length > 0) parts.push(report.warnings.join(" "));
      setResult(parts.join(" "));
    } catch (err) {
      setError(normalizeError(err).message);
    } finally {
      setDeploying(false);
    }
  };

  const missingRequired = plan?.missing ?? 0;
  const deployIds = plan ? collectionDeployIds(plan) : [];
  // 「已装但版本对不上」这一类不落在后端任何一个总数里，从 items 自己数一遍。
  const versionMismatch = plan ? collectionVersionMismatchCount(plan) : 0;

  /**
   * 让用户挑一个下载目录。
   *
   * 演示模式（浏览器）里没有 dialog 插件，直接跳过——面板文案已经说明了
   * 手动导入的流程，不影响主路径。
   */
  const handlePickDir = async () => {
    if (!isTauri) return;
    try {
      const picked = await openDialog({ directory: true, multiple: false });
      if (typeof picked === "string") setDownloadDir(picked);
    } catch {
      // 用户取消或没有 dialog 插件：保留原目录。
    }
  };

  return (
    <Modal
      open={open}
      title={t("collection.title")}
      eyebrow="// NEXUS COLLECTIONS"
      onClose={onClose}
      width={720}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose} disabled={deploying}>
            {t("common.close")}
          </button>
          <button
            className="btn btn-primary"
            onClick={() => void handleDeploy()}
            disabled={!plan?.readyToDeploy || deploying || deployIds.length === 0}
            title={
              plan?.readyToDeploy
                ? t("collection.deployTitleReady", { count: deployIds.length })
                : t("collection.deployTitleBlocked")
            }
          >
            {deploying ? <Spinner size={14} /> : <Rocket size={14} />}
            {deploying ? t("collection.deploying") : t("collection.deploy")}
          </button>
        </>
      }
    >
      {!manifestPath ? (
        <EmptyState
          icon={<ListChecks size={26} />}
          code={"// COLLECTION MANIFEST\n[ ?? ] NO FILE\n[ -- ] AWAITING INPUT"}
          kicker="NO MANIFEST"
          title={t("collection.emptyTitle")}
          detail={t("collection.emptyDetail")}
          action={
            <>
              <button
                className="btn btn-primary"
                onClick={() => {
                  if (isTauri) onPickFile();
                  else browserInput.current?.click();
                }}
              >
                {t("collection.pickManifest")}
              </button>
              {/* 浏览器预览模式没有 Tauri 对话框，用隐藏 input 兜底。
                  放在 Modal 内部：面板关闭时这个节点不存在，
                  不会和导入对话框的 file input 撞选择器。 */}
              {!isTauri ? (
                <input
                  ref={browserInput}
                  type="file"
                  accept=".collection,.json"
                  hidden
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = "";
                    if (!file) return;
                    onManifestPicked(file.name);
                  }}
                />
              ) : null}
            </>
          }
        />
      ) : null}

      {loading && !plan ? (
        <p className="muted-line">
          <Spinner size={13} /> {t("collection.parsing")}
        </p>
      ) : null}

      {error ? (
        <div className="inline-warning">
          <AlertTriangle size={14} />
          <div>
            <strong>{t("collection.parseFailed")}</strong>
            <p>{error}</p>
          </div>
        </div>
      ) : null}

      {plan ? (
        <>
          <div className="panel">
            <div className="panel-head">
              <div>
                <div className="panel-eyebrow">// COLLECTION</div>
                <h2>{plan.info.name}</h2>
              </div>
              <div className="panel-meta">
                {plan.info.author} · {plan.info.domainName}
              </div>
            </div>
            <p className="panel-copy">{plan.info.description}</p>
            <p className="panel-note">
              {t("collection.gameVersions")}
              {plan.info.gameVersions.length ? plan.info.gameVersions.join(" / ") : t("collection.undeclared")}
            </p>
          </div>

          <div className="storage-summary">
            <div>
              <span>{t("collection.installed")}</span>
              <strong>{plan.installed}</strong>
            </div>
            <div>
              <span>{t("collection.versionMismatch")}</span>
              <strong>{versionMismatch}</strong>
            </div>
            <div>
              <span>{t("collection.missing")}</span>
              <strong>{plan.missing}</strong>
            </div>
            <div>
              <span>{t("collection.optionalMissing")}</span>
              <strong>{plan.optionalMissing}</strong>
            </div>
          </div>

          <div className="inline-warning">
            <ShieldAlert size={14} />
            <div>
              <strong>{t("collection.complianceTitle")}</strong>
              <p>{t("collection.complianceBody")}</p>
            </div>
          </div>

          <div className="import-review-list">
            {plan.items.map((item) => (
              <div key={`${item.modId}-${item.name}`} className="import-review-row">
                <div className="import-review-main">
                  <div className="import-review-title">
                    {statusIcon(item)}
                    <strong>{item.name}</strong>
                    {item.version ? <span className="import-version">v{item.version}</span> : null}
                    <Badge tone={statusTone(item)}>{t(COLLECTION_STATUS_LABEL[item.status])}</Badge>
                    {item.optional ? <Badge tone="muted">{t("collection.optional")}</Badge> : null}
                  </div>
                  <div className="import-review-meta">
                    {item.status === "version_mismatch"
                      ? t("collection.localVsRequired", {
                          local: item.localVersion ?? t("common.unknown"),
                          required: item.version ?? t("common.unknown"),
                        })
                      : item.status === "installed"
                        ? t("collection.localInstalledMatch")
                        : t("collection.localMissing")}
                  </div>
                </div>
                {item.status === "missing" ? (
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => void api.openUrl(item.pageUrl)}
                    title={item.pageUrl}
                  >
                    <ExternalLink size={13} /> {t("collection.openNexus")}
                  </button>
                ) : null}
              </div>
            ))}
          </div>

          <SwitchRow
            title={t("collection.watchTitle")}
            description={t("collection.watchDesc")}
            checked={watch}
            onChange={setWatch}
          />

          {watch ? (
            <>
              <div className="inline-actions">
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => void handlePickDir()}
                  title={t("collection.pickDirTitle")}
                >
                  <FolderOpen size={13} /> {t("collection.pickDir")}
                </button>
                {downloadDir ? (
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => void api.openPath(downloadDir)}
                    title={downloadDir}
                  >
                    <FolderOpen size={13} /> {t("collection.openDir")}
                  </button>
                ) : null}
                <button className="btn btn-ghost btn-sm" onClick={onImportMods}>
                  <PackageOpen size={13} /> {t("collection.importMods")}
                </button>
              </div>
              <p className="panel-note">
                {t("collection.manualScanNote")}
                {downloadDir ? t("collection.currentDir", { path: downloadDir }) : ""}
              </p>
            </>
          ) : null}

          {result ? (
            <div className="inline-ok">
              <CheckCircle2 size={13} /> {result}
            </div>
          ) : null}

          {!plan.readyToDeploy ? (
            <p className="panel-note">
              {t("collection.missingRequiredNote", { count: missingRequired })}
            </p>
          ) : null}
        </>
      ) : null}
    </Modal>
  );
}
