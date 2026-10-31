import { useState } from "react";
import { FileDown, FileUp } from "lucide-react";
import { configPackApi, type ConfigImportReport } from "../lib/apiConfigPack";
import { t } from "../i18n";
import "./SafetyCards.css";

/**
 * 设置页「配置迁移」卡片（看板【12】）。
 *
 * 导出走数据目录而不是"另存为"对话框：只申请了 dialog:allow-open 权限，
 * 固定目录 + 路径回显对用户更少一步。密钥永远不在导出范围内。
 */
export function ConfigPackCard({ onError }: { onError: (error: unknown, title?: string) => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [exportedPath, setExportedPath] = useState("");
  const [report, setReport] = useState<ConfigImportReport | null>(null);

  const exportPack = async () => {
    setBusy("export");
    setReport(null);
    try {
      const path = await configPackApi.exportPack();
      setExportedPath(path);
    } catch (error) {
      onError(error, t("configPack.errorExport"));
    } finally {
      setBusy(null);
    }
  };

  const importPack = async () => {
    setBusy("import");
    setReport(null);
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const picked = await open({
        multiple: false,
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (typeof picked !== "string") return;
      setReport(await configPackApi.importPack(picked));
    } catch (error) {
      onError(error, t("configPack.errorImport"));
    } finally {
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

      <p className="safety-foot">{t("configPack.foot")}</p>
    </section>
  );
}
