import { useState } from "react";
import { FileDown, FileUp, ShieldAlert } from "lucide-react";
import { configPackApi, type ConfigImportReport } from "../lib/apiConfigPack";
import { t } from "../i18n";
import "./SafetyCards.css";

/** 敏感项的本地化标签。未知 key 原样显示，至少不会显示成空白。 */
function sensitiveLabel(key: string): string {
  const known: Record<string, () => string> = {
    aiBaseUrl: () => t("configPack.keyAiBaseUrl"),
    wolvenkitCliPath: () => t("configPack.keyWolvenkitCliPath"),
    archiveToolPath: () => t("configPack.keyArchiveToolPath"),
    launchArgs: () => t("configPack.keyLaunchArgs"),
  };
  return known[key]?.() ?? key;
}

/**
 * 设置页「配置迁移」卡片（看板【12】）。
 *
 * 导出走数据目录而不是"另存为"对话框：只申请了 dialog:allow-open 权限，
 * 固定目录 + 路径回显对用户更少一步。密钥永远不在导出范围内。
 *
 * 导入分两段：先不带 `applySensitive` 导一次，敏感项（AI 地址 / 外部工具路径 /
 * 启动参数）只回显不写库；用户看清「从什么改成什么」并点确认后才真正生效。
 * 2026-11-10 自检 P0-3：原实现点一下导入就把 AI 地址换成包作者写的值，
 * 下一次 AI 汉化就会把 API Key 发到对方服务器。
 */
export function ConfigPackCard({ onError }: { onError: (error: unknown, title?: string) => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [exportedPath, setExportedPath] = useState("");
  const [report, setReport] = useState<ConfigImportReport | null>(null);
  const [pending, setPending] = useState<{ path: string; report: ConfigImportReport } | null>(null);
  const [kept, setKept] = useState(false);

  const exportPack = async () => {
    setBusy("export");
    setReport(null);
    setPending(null);
    setKept(false);
    try {
      const path = await configPackApi.exportPack();
      setExportedPath(path);
    } catch (error) {
      onError(error, t("configPack.errorExport"));
    } finally {
      setBusy(null);
    }
  };

  const runImport = async (path: string, applySensitive: boolean) => {
    setBusy(applySensitive ? "apply" : "import");
    setReport(null);
    setPending(null);
    setKept(false);
    try {
      const next = await configPackApi.importPack(path, applySensitive);
      setReport(next);
      if (next.sensitive.length > 0) {
        setPending({ path, report: next });
      }
    } catch (error) {
      onError(error, t("configPack.errorImport"));
    } finally {
      setBusy(null);
    }
  };

  const importPack = async () => {
    setBusy("import");
    setReport(null);
    setPending(null);
    setKept(false);
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const picked = await open({
        multiple: false,
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (typeof picked !== "string") {
        setBusy(null);
        return;
      }
      await runImport(picked, false);
    } catch (error) {
      onError(error, t("configPack.errorImport"));
      setBusy(null);
    }
  };

  return (
    <section className="panel safety-card">
      <header className="panel-head">
        <div>
          <div className="panel-eyebrow">// CONFIG / PORTABLE</div>
          <h2>{t("configPack.title")}</h2>
        </div>
      </header>
      <p className="safety-intro">{t("configPack.intro")}</p>

      <div className="safety-actions">
        <button className="btn btn-ghost btn-sm" disabled={busy !== null} onClick={() => void exportPack()}>
          <FileDown size={13} />
          {t("configPack.exportBtn")}
        </button>
        <button className="btn btn-ghost btn-sm" disabled={busy !== null} onClick={() => void importPack()}>
          <FileUp size={13} />
          {t("configPack.importBtn")}
        </button>
      </div>

      {exportedPath ? (
        <p className="safety-note">
          {t("configPack.exportDone")}
          <code>{exportedPath}</code>
        </p>
      ) : null}

      {report ? (
        <p className="safety-note">
          {t("configPack.importDone", {
            applied: report.applied.length,
            ignored: report.ignored.length,
            profiles: report.profiles,
          })}
          {report.needsGameReverify ? <em>{t("configPack.reverify")}</em> : null}
        </p>
      ) : null}

      {pending ? (
        <div className="safety-sensitive">
          <p className="safety-sensitive-title">
            <ShieldAlert size={13} />
            {t("configPack.sensitiveTitle", { n: pending.report.sensitive.length })}
          </p>
          <p className="safety-sensitive-hint">{t("configPack.sensitiveHint")}</p>
          <ul className="safety-sensitive-list">
            {pending.report.sensitive.map((change) => (
              <li key={change.key}>
                <strong>{sensitiveLabel(change.key)}</strong>
                <span className="from">{change.from.trim() || t("configPack.sensitiveEmpty")}</span>
                <span className="arrow">→</span>
                <span className="to">{change.to.trim() || t("configPack.sensitiveEmpty")}</span>
              </li>
            ))}
          </ul>
          <div className="safety-actions">
            <button
              className="btn btn-sm btn-danger"
              disabled={busy !== null}
              onClick={() => void runImport(pending.path, true)}
            >
              {t("configPack.sensitiveApply")}
            </button>
            <button
              className="btn btn-sm btn-ghost"
              disabled={busy !== null}
              onClick={() => {
                setPending(null);
                setKept(true);
              }}
            >
              {t("configPack.sensitiveKeep")}
            </button>
          </div>
        </div>
      ) : null}

      {kept ? <p className="safety-note">{t("configPack.sensitiveKept")}</p> : null}

      <p className="safety-foot">{t("configPack.foot")}</p>
    </section>
  );
}
