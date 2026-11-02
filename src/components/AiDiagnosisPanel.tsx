import { useEffect, useState } from "react";
import {
  AlertTriangle,
  BrainCircuit,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Eye,
  KeyRound,
  ListRestart,
  LockKeyhole,
  RefreshCw,
  Send,
  ShieldCheck,
  Sparkles,
  Trash2,
} from "lucide-react";
import type { AiDiagnosis, AiStatus, DiagnosticsReport, Settings } from "../types";
import {
  AI_PRESET_GROUPS,
  AI_PROTOCOL_LABEL_KEY,
  deprecatedModelWarningKey,
  findAiPreset,
  matchAiPreset,
  presetsByGroup,
} from "../lib/aiPresets";
import { api, normalizeError } from "../lib/api";
import { relativeTime } from "../lib/format";
import { t } from "../i18n";
import { Badge, Spinner } from "./ui";

const CONFIDENCE_LABEL: Record<string, string> = {
  high: t("aiDiagnosis.confidenceHigh"),
  medium: t("aiDiagnosis.confidenceMedium"),
  low: t("aiDiagnosis.confidenceLow"),
};

export function AiDiagnosisPanel({
  report,
  settings,
  onSettings,
  onError,
  onOpenAiSettings,
}: {
  report: DiagnosticsReport;
  settings: Settings;
  onSettings: (settings: Settings) => void;
  onError: (error: unknown, title?: string) => void;
  /** 「前往 AI 配置」：跳到设置页的 AI 分区（由 App 提供导航能力）。 */
  onOpenAiSettings?: () => void;
}) {
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [consent, setConsent] = useState(false);
  const [includeLogs, setIncludeLogs] = useState(false);
  const [result, setResult] = useState<AiDiagnosis | null>(null);
  const [showContext, setShowContext] = useState(false);
  /**
   * 空响应（AI_EMPTY）与格式错（AI_BAD_JSON）不弹红框了：这类失败用户改不动代码，
   * 只能去改配置。就地给一段"改什么"的引导 + 一个直达按钮，比一条会消失的 toast 有用。
   */
  const [guide, setGuide] = useState<{ code: string; message: string } | null>(null);
  const [editing, setEditing] = useState(false);
  const [keyInput, setKeyInput] = useState("");
  const [baseUrl, setBaseUrl] = useState(settings.aiBaseUrl);
  const [model, setModel] = useState(settings.aiModel);
  const [presetId, setPresetId] = useState("");
  const [models, setModels] = useState<string[] | null>(null);
  const [loadingModels, setLoadingModels] = useState(false);

  /** 联网拉取 /v1/models：模型名永不过时的正解。按当前协议走对应的鉴权头。 */
  const fetchModels = async () => {
    setLoadingModels(true);
    try {
      const list = await api.aiListModels(baseUrl.trim(), settings.aiProtocol);
      setModels(list);
    } catch (error) {
      setModels(null);
      onError(error, t("aiDiagnosis.errorListModels"));
    } finally {
      setLoadingModels(false);
    }
  };

  const deprecationKey = deprecatedModelWarningKey(model);

  /**
   * 「获取 Key」只在能确定是哪家服务商时才出现——没选预设就不知道该把用户送去
   * 哪个控制台，硬编码某一家会把「通用协议」又变回「单一服务商」。
   */
  const keyUrl =
    (presetId ? findAiPreset(presetId) : matchAiPreset(baseUrl, model))?.keyUrl ?? null;

  /** 一键填入预设：覆盖地址与模型名；带协议的预设同时把协议写进设置，避免「Claude 地址 + OpenAI 请求」的错配。 */
  const applyPreset = (id: string) => {
    setPresetId(id);
    const preset = findAiPreset(id);
    if (!preset) return;
    setBaseUrl(preset.baseUrl);
    setModel(preset.model);
    if (preset.protocol && preset.protocol !== settings.aiProtocol) {
      onSettings({ ...settings, aiProtocol: preset.protocol });
    }
  };

  const load = async () => {
    setLoading(true);
    try {
      setStatus(await api.aiStatus());
    } catch (error) {
      onError(error, t("aiDiagnosis.errorLoadConfig"));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    setBaseUrl(settings.aiBaseUrl);
    setModel(settings.aiModel);
  }, [settings.aiBaseUrl, settings.aiModel]);

  const save = async () => {
    if (!baseUrl.trim() || !model.trim()) return;
    try {
      onSettings({ ...settings, aiBaseUrl: baseUrl.trim(), aiModel: model.trim() });
      if (keyInput.trim()) {
        const next = await api.setAiKey(keyInput.trim());
        setStatus(next);
        setKeyInput("");
      } else {
        setStatus((current) =>
          current ? { ...current, baseUrl: baseUrl.trim(), model: model.trim() } : current,
        );
      }
      setEditing(false);
    } catch (error) {
      onError(error, t("aiDiagnosis.errorSaveConfig"));
    }
  };

  const run = async () => {
    if (!consent) return;
    setBusy(true);
    setGuide(null);
    try {
      setResult(await api.aiDiagnose(includeLogs, true));
      setShowContext(false);
    } catch (error) {
      // 引导式失败：AI_EMPTY / AI_BAD_JSON 都是"模型这次没好好回"，
      // 提示里给出可执行的下一步，并挂一个「前往 AI 配置」按钮。
      const parsed = normalizeError(error);
      if (parsed.code === "AI_EMPTY" || parsed.code === "AI_BAD_JSON") {
        setGuide({ code: parsed.code, message: parsed.message });
      } else {
        onError(error, t("aiDiagnosis.errorDiagnose"));
      }
    } finally {
      setBusy(false);
    }
  };

  const clearKey = async () => {
    try {
      setStatus(await api.clearAiKey());
      setResult(null);
      setEditing(false);
    } catch (error) {
      onError(error, t("aiDiagnosis.errorClearKey"));
    }
  };

  if (loading && !status) {
    return (
      <section className="panel ai-panel">
        <div className="ai-loading">
          <Spinner size={18} /> {t("aiDiagnosis.loadingConfig")}
        </div>
      </section>
    );
  }

  return (
    <section className="panel ai-panel">
      <div className="panel-head">
        <div>
          <div className="panel-eyebrow">// AGENT DIAGNOSTICS / OPTIONAL</div>
          <h2>
            <BrainCircuit size={17} /> {t("aiDiagnosis.title")}
          </h2>
        </div>
        <div className="ai-head-badges">
          <Badge tone={status?.configured ? "cyan" : "muted"}>
            {status?.configured
              ? t(status.protocol === "anthropic"
                  ? "aiPreset.protocolLabelAnthropic"
                  : AI_PROTOCOL_LABEL_KEY)
              : t("aiDiagnosis.unconfigured")}
          </Badge>
          {status?.configured ? (
            <Badge tone="green">{t("aiSettings.storageDpapi")}</Badge>
          ) : null}
        </div>
      </div>

      {!status?.configured || editing ? (
        <div className="ai-config">
          <div className="ai-privacy-note">
            <LockKeyhole size={15} />
            <div>
              <strong>{t("aiDiagnosis.privacyTitle")}</strong>
              <p>
                {t("aiDiagnosis.privacyDetail")}
              </p>
            </div>
          </div>
          <label className="ai-field">
            <span>{t("aiDiagnosis.providerPreset")}</span>
            <select
              value={presetId || matchAiPreset(baseUrl, model)?.id || ""}
              onChange={(event) => applyPreset(event.target.value)}
            >
              <option value="">{t("aiDiagnosis.manualConfig")}</option>
              {AI_PRESET_GROUPS.map((group) => {
                const items = presetsByGroup(group.id);
                if (items.length === 0) return null;
                return (
                  <optgroup key={group.id} label={t(group.labelKey)}>
                    {items.map((item) => (
                      <option key={item.id} value={item.id}>
                        {t(item.labelKey)}
                      </option>
                    ))}
                  </optgroup>
                );
              })}
            </select>
          </label>
          <label className="ai-field">
            <span>API KEY</span>
            <input
              type="password"
              value={keyInput}
              onChange={(event) => setKeyInput(event.target.value)}
              placeholder={status?.configured ? t("aiDiagnosis.keyPlaceholderKeep") : "sk-..."}
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <div className="ai-field-row">
            <label className="ai-field">
              <span>{t("aiDiagnosis.baseUrlLabel")}</span>
              <input
                value={baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
                placeholder="https://api.openai.com/v1"
                spellCheck={false}
              />
            </label>
            <label className="ai-field">
              <span>{t("aiDiagnosis.modelLabel")}</span>
              <input
                value={model}
                onChange={(event) => setModel(event.target.value)}
                placeholder="gpt-5.4-nano"
                spellCheck={false}
              />
            </label>
          </div>
          <div className="ai-field-row">
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => void fetchModels()}
              disabled={loadingModels || !baseUrl.trim()}
              title={t("aiDiagnosis.fetchModelsHint")}
            >
              {loadingModels ? <Spinner size={13} /> : <ListRestart size={13} />}
              {t("aiDiagnosis.fetchModels")}
            </button>
            {models && models.length > 0 ? (
              <select
                className="ai-model-select"
                value={models.includes(model.trim()) ? model.trim() : ""}
                onChange={(event) => {
                  if (event.target.value) setModel(event.target.value);
                }}
                aria-label={t("aiDiagnosis.modelSelectAria")}
              >
                <option value="">
                  {t("aiDiagnosis.modelOptions", { count: models.length })}
                </option>
                {models.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </select>
            ) : null}
          </div>
          {deprecationKey ? <small className="danger-text">{t(deprecationKey)}</small> : null}
          <div className="ai-actions">
            <button
              className="btn btn-primary btn-sm"
              onClick={() => void save()}
              disabled={
                !baseUrl.trim() ||
                !model.trim() ||
                (!status?.configured && keyInput.trim().length < 8)
              }
            >
              <KeyRound size={13} /> {t("aiDiagnosis.saveConfig")}
            </button>
            {status?.configured ? (
              <button className="btn btn-ghost btn-sm" onClick={() => setEditing(false)}>
                {t("common.cancel")}
              </button>
            ) : keyUrl ? (
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => {
                  void api.openUrl(keyUrl).catch((error) => onError(error, t("aiDiagnosis.errorOpenPage")));
                }}
              >
                {t("aiDiagnosis.getKey")}
              </button>
            ) : null}
          </div>
          <p className="panel-note">
            {t("aiDiagnosis.configNote")}
          </p>
        </div>
      ) : (
        <>
          <div className="ai-run-row">
            <div className="ai-run-copy">
              <div className="ai-consent">
                <label>
                  <input
                    type="checkbox"
                    checked={consent}
                    onChange={(event) => setConsent(event.target.checked)}
                  />
                  <span>{t("aiDiagnosis.consent")}</span>
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={includeLogs}
                    onChange={(event) => setIncludeLogs(event.target.checked)}
                  />
                  <span>{t("aiDiagnosis.includeLogs")}</span>
                </label>
              </div>
              <div className="ai-send-note">
                <ShieldCheck size={12} /> {t("aiDiagnosis.sendNote", { model: status?.model ?? "" })}
                <button className="link-btn" onClick={() => setEditing(true)}>
                  {t("aiDiagnosis.editConfig")}
                </button>
                <button className="link-btn danger-text" onClick={() => void clearKey()}>
                  {t("aiDiagnosis.removeKey")}
                </button>
              </div>
            </div>
            <button className="btn btn-primary" onClick={() => void run()} disabled={busy || !consent}>
              {busy ? <Spinner size={14} /> : <Sparkles size={14} />}
              {busy ? t("aiDiagnosis.analyzing") : result ? t("aiDiagnosis.reanalyze") : t("aiDiagnosis.startAnalysis")}
            </button>
          </div>

          {guide ? (
            <div className="ai-guide" role="alert">
              <div className="ai-guide-head">
                <AlertTriangle size={15} />
                <strong>{t("aiDiagnosis.guideTitle")}</strong>
              </div>
              <p className="ai-guide-body">{guide.message}</p>
              <div className="ai-guide-actions">
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={() => {
                    // 两个出口都给：能跳设置就跳，跳不了（未接线）就地把面板切成编辑态。
                    if (onOpenAiSettings) onOpenAiSettings();
                    else setEditing(true);
                  }}
                >
                  <KeyRound size={12} /> {t("aiDiagnosis.guideAction")}
                </button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => void run()} disabled={busy || !consent}>
                  <RefreshCw size={12} /> {t("aiDiagnosis.guideRetry")}
                </button>
              </div>
            </div>
          ) : !result ? (
            <div className="ai-empty">
              <Send size={15} />
              <span>{t("aiDiagnosis.emptyHint")}</span>
            </div>
          ) : (
            <div className="ai-result">
              <div className="ai-result-head">
                <div>
                  <div className="panel-eyebrow">// AI VERDICT</div>
                  <h3>{result.summary}</h3>
                </div>
                <Badge tone={result.confidence === "high" ? "green" : result.confidence === "low" ? "red" : "yellow"}>
                  {CONFIDENCE_LABEL[result.confidence] ?? result.confidence}
                </Badge>
              </div>

              <div className="ai-cause">
                <span>{t("aiDiagnosis.likelyCause")}</span>
                <p>{result.likelyCause || t("aiDiagnosis.noCause")}</p>
              </div>

              {result.evidence.length > 0 ? (
                <div className="ai-block">
                  <span className="ai-block-label">{t("aiDiagnosis.evidence")}</span>
                  <ul>
                    {result.evidence.map((item, index) => (
                      <li key={`${item}-${index}`}>
                        <CheckCircle2 size={12} /> {item}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {result.fixSteps.length > 0 ? (
                <div className="ai-block">
                  <span className="ai-block-label">{t("aiDiagnosis.fixSteps")}</span>
                  <ol>
                    {result.fixSteps.map((item, index) => (
                      <li key={`${item}-${index}`}>{item}</li>
                    ))}
                  </ol>
                </div>
              ) : null}

              {result.needsMoreInfo.length > 0 ? (
                <div className="ai-block ai-needs">
                  <span className="ai-block-label">
                    <AlertTriangle size={12} /> {t("aiDiagnosis.needsMoreInfo")}
                  </span>
                  <ul>
                    {result.needsMoreInfo.map((item, index) => (
                      <li key={`${item}-${index}`}>{item}</li>
                    ))}
                  </ul>
                </div>
              ) : null}

              <div className="ai-result-foot">
                <span>
                  {t("aiDiagnosis.resultMeta", {
                    model: result.model,
                    time: relativeTime(result.generatedAt),
                    sent: result.sentChars.toLocaleString(),
                    redactions: result.redactions,
                  })}
                </span>
                <button className="link-btn" onClick={() => setShowContext((value) => !value)}>
                  <Eye size={12} /> {showContext ? t("aiDiagnosis.hidePayload") : t("aiDiagnosis.showPayload")}
                  {showContext ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                </button>
              </div>
              {showContext ? <pre className="ai-context">{result.contextPreview}</pre> : null}
            </div>
          )}
        </>
      )}

      <div className="ai-foot">
        <RefreshCw size={11} />
        <span>{t("aiDiagnosis.footNote", { time: relativeTime(report.generatedAt) })}</span>
        {status?.configured ? (
          <button className="link-btn danger-text" onClick={() => void clearKey()}>
            <Trash2 size={11} /> {t("aiDiagnosis.clear")}
          </button>
        ) : null}
      </div>
    </section>
  );
}
