import { useEffect, useState } from "react";
import { BrainCircuit, CheckCircle2, KeyRound, ListRestart, LockKeyhole, Plus, Trash2, Zap } from "lucide-react";
import type { AiProfileList, AiStatus, AiTestResult, Settings } from "../types";
import {
  AI_PRESET_GROUPS,
  AI_PROTOCOL_LABEL_KEY,
  deprecatedModelWarningKey,
  findAiPreset,
  findPresetModel,
  matchAiPreset,
  presetsByGroup,
} from "../lib/aiPresets";
import { api } from "../lib/api";
import { t } from "../i18n";
import { Badge, Spinner } from "./ui";

/**
 * 设置页「AI 助手配置」卡片（任务二）。
 *
 * 兼容任何标准 OpenAI /v1/chat/completions 服务商：接口地址、API 密钥、
 * 模型名三个字段 + 一键填入预设。密钥经 DPAPI 加密保存，永远不会进入
 * launcher-state.json 或日志。
 */
export function AiSettingsCard({
  settings,
  onSettings,
  onError,
}: {
  settings: Settings;
  onSettings: (settings: Settings) => void;
  onError: (error: unknown, title?: string) => void;
}) {
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [baseUrl, setBaseUrl] = useState(settings.aiBaseUrl);
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(settings.aiModel);
  const [protocol, setProtocol] = useState<"openai" | "anthropic">(settings.aiProtocol);
  const [presetId, setPresetId] = useState("");
  const [models, setModels] = useState<string[] | null>(null);
  const [loadingModels, setLoadingModels] = useState(false);
  /** 多套配置：列表 + 正在编辑哪一套（空串 = 新建）。 */
  const [profiles, setProfiles] = useState<AiProfileList | null>(null);
  const [editingId, setEditingId] = useState("");
  const [profileName, setProfileName] = useState("");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<AiTestResult | null>(null);

  const activeProfile =
    profiles?.profiles.find((item) => item.active) ?? profiles?.profiles[0] ?? null;

  /** 把表单切到某一套配置（空 id = 拿当前激活值新建一套）。 */
  const loadIntoForm = (id: string) => {
    const target = profiles?.profiles.find((item) => item.profile.id === id);
    setEditingId(target?.profile.id ?? "");
    setProfileName(target?.profile.name ?? "");
    setBaseUrl(target?.profile.baseUrl ?? activeProfile?.profile.baseUrl ?? settings.aiBaseUrl);
    setModel(target?.profile.model ?? activeProfile?.profile.model ?? settings.aiModel);
    setProtocol(
      ((target?.profile.protocol ?? activeProfile?.profile.protocol ?? settings.aiProtocol) === "anthropic"
        ? "anthropic"
        : "openai") as "openai" | "anthropic",
    );
    setApiKey("");
    setTestResult(null);
  };


  useEffect(() => {
    setBaseUrl(settings.aiBaseUrl);
    setModel(settings.aiModel);
    setProtocol(settings.aiProtocol);
  }, [settings.aiBaseUrl, settings.aiModel, settings.aiProtocol]);

  // 首次进页面：把配置列表拉出来，表单落在当前激活的那套上。
  useEffect(() => {
    let cancelled = false;
    void api
      .aiProfiles()
      .then((next) => {
        if (cancelled) return;
        setProfiles(next);
        const current = next.profiles.find((item) => item.active) ?? next.profiles[0];
        if (current) {
          setEditingId(current.profile.id);
          setProfileName(current.profile.name);
        }
      })
      .catch((error) => onError(error, t("aiSettings.errorLoadConfig")));
    return () => {
      cancelled = true;
    };
  }, [onError]);

  useEffect(() => {
    let cancelled = false;
    void api
      .aiStatus()
      .then((next) => {
        if (!cancelled) setStatus(next);
      })
      .catch((error) => onError(error, t("aiSettings.errorLoadConfig")));
    return () => {
      cancelled = true;
    };
  }, [onError]);

  /** 一键填入预设：覆盖地址与模型名；带协议的预设同时切换协议，密钥留给用户自己粘贴。 */
  const applyPreset = (id: string) => {
    setPresetId(id);
    const preset = findAiPreset(id);
    if (!preset) return;
    setBaseUrl(preset.baseUrl);
    setModel(preset.model);
    if (preset.protocol) setProtocol(preset.protocol);
  };

  const editingProfile = profiles?.profiles.find((item) => item.profile.id === editingId) ?? null;
  const dirty = editingProfile
    ? baseUrl.trim() !== editingProfile.profile.baseUrl ||
      model.trim() !== editingProfile.profile.model ||
      protocol !== editingProfile.profile.protocol ||
      profileName.trim() !== editingProfile.profile.name
    : true;

  const deprecationKey = deprecatedModelWarningKey(model);

  /** 联网拉取 /v1/models：模型名永不过时的正解，失败时给出可操作错误。 */
  const fetchModels = async () => {
    setLoadingModels(true);
    try {
      const list = await api.aiListModels(baseUrl.trim(), protocol);
      setModels(list);
    } catch (error) {
      setModels(null);
      onError(error, t("aiSettings.errorListModels"));
    } finally {
      setLoadingModels(false);
    }
  };

  /**
   * 保存到当前这套配置档案。
   *
   * 关键点：key 是**这套配置独享**的（后端按 id 存到各自的 DPAPI 文件），
   * 所以切换配置不会串 key；激活态变化时同步写回 settings，诊断/翻译立即生效。
   */
  const save = async () => {
    if (!baseUrl.trim() || !model.trim()) return;
    setBusy(true);
    try {
      const previousActive = activeProfile?.profile.id ?? "";
      const next = await api.aiProfileSave(
        {
          id: editingId,
          name: profileName.trim(),
          vendor: presetId || activeProfile?.profile.vendor || "",
          baseUrl: baseUrl.trim(),
          model: model.trim(),
          protocol,
        },
        apiKey.trim() || null,
      );
      setProfiles(next);
      const current = next.profiles.find((item) => item.active) ?? next.profiles[0];
      if (current) {
        setEditingId(current.profile.id);
        setProfileName(current.profile.name);
        // 激活态可能没变，但要保证 App 手里的 settings 与后端一致。
        onSettings({
          ...settings,
          aiBaseUrl: current.profile.baseUrl,
          aiModel: current.profile.model,
          aiProtocol: current.profile.protocol === "anthropic" ? "anthropic" : "openai",
        });
        if (previousActive !== current.profile.id) setStatus(await api.aiStatus());
      }
      setApiKey("");
      setTestResult(null);
    } catch (error) {
      onError(error, t("aiSettings.errorSaveConfig"));
    } finally {
      setBusy(false);
    }
  };

  /** 切换当前使用的配置（后端会把值同步写回 settings 三个老字段）。 */
  const useProfile = async (id: string) => {
    setBusy(true);
    try {
      const next = await api.aiProfileActivate(id);
      setProfiles(next);
      const current = next.profiles.find((item) => item.profile.id === id);
      if (current) {
        loadIntoForm(id);
        onSettings({
          ...settings,
          aiBaseUrl: current.profile.baseUrl,
          aiModel: current.profile.model,
          aiProtocol: current.profile.protocol === "anthropic" ? "anthropic" : "openai",
        });
        setStatus(await api.aiStatus());
      }
    } catch (error) {
      onError(error, t("aiSettings.errorSaveConfig"));
    } finally {
      setBusy(false);
    }
  };

  const deleteProfile = async (id: string) => {
    setBusy(true);
    try {
      const next = await api.aiProfileDelete(id);
      setProfiles(next);
      const current = next.profiles.find((item) => item.active) ?? next.profiles[0];
      if (current) loadIntoForm(current.profile.id);
      setStatus(await api.aiStatus());
    } catch (error) {
      onError(error, t("aiSettings.errorSaveConfig"));
    } finally {
      setBusy(false);
    }
  };

  /** 测试连接：用表单里现在这套值直接打 /models，不落盘、不改激活态。 */
  const runTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      setTestResult(
        await api.aiProfileTest(
          {
            id: editingId,
            name: profileName.trim(),
            vendor: presetId || activeProfile?.profile.vendor || "",
            baseUrl: baseUrl.trim(),
            model: model.trim(),
            protocol,
          },
          apiKey.trim() || null,
        ),
      );
    } catch (error) {
      onError(error, t("aiSettings.errorTest"));
    } finally {
      setTesting(false);
    }
  };

  const preset = presetId ? findAiPreset(presetId) : null;
  /** 已保存的地址 + 模型名能对上某个预设时，下拉框要显示它，而不是一直挂在「手动配置…」。 */
  const matched = matchAiPreset(baseUrl, model);
  /** 当前生效的预设：刚点选的那个优先，否则用反查结果。密钥提示随它走。 */
  const active = preset ?? matched;
  /** 当前模型名落在该厂商的哪个预设模型上——只在手改过之后为 null。 */
  const selectedModel = active ? findPresetModel(active.id, model) : null;

  return (
    <section className="panel settings-card">
      <div className="panel-head">
        <div>
          {/* 副标题跟「当前选择」的协议走，不写死：选了 Anthropic 还挂
              OPENAI COMPATIBLE，用户会怀疑设置没生效（2026-10-30 反馈）。 */}
          <div className="panel-eyebrow">
            {protocol === "anthropic"
              ? "// AI ASSISTANT / ANTHROPIC NATIVE"
              : "// AI ASSISTANT / OPENAI COMPATIBLE"}
          </div>
          <h2>{t("aiSettings.title")}</h2>
        </div>
        <div className="ai-head-badges">
          <Badge tone={status?.configured ? "cyan" : "muted"}>
            {t(
              protocol === "anthropic"
                ? "aiPreset.protocolLabelAnthropic"
                : AI_PROTOCOL_LABEL_KEY,
            )}
          </Badge>
          {status?.configured ? (
            <Badge tone="green">{t("aiSettings.storageDpapi")}</Badge>
          ) : (
            <Badge tone="muted">{t("aiSettings.storageEmpty")}</Badge>
          )}
        </div>
      </div>

      {/* 配置档案：本地 / 云端 / 中转站各存一套，点「使用」即刻切换。 */}
      <div className="ai-profile-strip">
        {profiles?.profiles.map((item) => (
          <div
            key={item.profile.id}
            className={`ai-profile-card${item.active ? " is-active" : ""}`}
          >
            <div className="ai-profile-head">
              <strong>{item.profile.name}</strong>
              {item.active ? (
                <Badge tone="green">{t("aiSettings.profileActive")}</Badge>
              ) : null}
              {item.hasKey ? null : (
                <Badge tone="muted">{t("aiSettings.profileNoKey")}</Badge>
              )}
            </div>
            <code>{item.profile.model}</code>
            <div className="ai-profile-actions">
              <button className="link-btn" onClick={() => loadIntoForm(item.profile.id)}>
                {t("aiSettings.profileEdit")}
              </button>
              {item.active ? null : (
                <button
                  className="link-btn"
                  onClick={() => void useProfile(item.profile.id)}
                  disabled={busy}
                >
                  {t("aiSettings.profileUse")}
                </button>
              )}
              {(profiles?.profiles.length ?? 0) > 1 ? (
                <button
                  className="link-btn danger-text"
                  onClick={() => void deleteProfile(item.profile.id)}
                  disabled={busy}
                >
                  {t("aiSettings.profileDelete")}
                </button>
              ) : null}
            </div>
          </div>
        ))}
        <button className="ai-profile-add" onClick={() => loadIntoForm("")} disabled={busy}>
          <Plus size={13} /> {t("aiSettings.profileNew")}
        </button>
      </div>

      <div className="settings-field">
        <span>{t("aiSettings.profileNameLabel")}</span>
        <div className="settings-field-row">
          <input
            value={profileName}
            onChange={(event) => setProfileName(event.target.value)}
            placeholder={t("aiSettings.profileNamePlaceholder")}
            spellCheck={false}
          />
        </div>
        <small>{t("aiSettings.profileNameHint")}</small>
      </div>

      <div className="settings-field">
        <span>{t("aiSettings.providerPreset")}</span>
        <div className="settings-field-row">
          <select
            value={presetId || matched?.id || ""}
            onChange={(event) => applyPreset(event.target.value)}
            aria-label={t("aiSettings.presetSelectAria")}
          >
            <option value="">{t("aiSettings.manualConfig")}</option>
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
        </div>
        {active ? (
          <small>
            {t(active.keyHintKey)}
            {active.keyUrl ? (
              <>
                {" · "}
                <button
                  className="link-btn"
                  onClick={() =>
                    void api.openUrl(active.keyUrl!).catch((error) => onError(error, t("aiSettings.errorOpenPage")))
                  }
                >
                  {t("aiSettings.getKey")}
                </button>
              </>
            ) : null}
          </small>
        ) : (
          <small>
            {t("aiSettings.presetHint")}
          </small>
        )}
      </div>

      {active && active.models.length > 0 ? (
        <div className="settings-field">
          <span>{t("aiSettings.modelPresetLabel")}</span>
          <div className="settings-field-row">
            <select
              value={selectedModel?.id ?? ""}
              onChange={(event) => {
                if (!event.target.value) return;
                setPresetId(active.id);
                // 只填模型名，不动接口地址：地址是「用户自己填过的」就不该被预设改掉。
                setModel(event.target.value);
              }}
              aria-label={t("aiSettings.modelPresetAria")}
            >
              <option value="">
                {t("aiSettings.modelPresetOptions", { count: active.models.length })}
              </option>
              {active.models.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label} · {item.id}
                </option>
              ))}
            </select>
          </div>
          <small>{selectedModel ? selectedModel.note : t("aiSettings.modelPresetHint")}</small>
          {baseUrl.trim() && baseUrl.trim() !== active.baseUrl ? (
            <small>{t("aiSettings.baseUrlSuggestion", { url: active.baseUrl })}</small>
          ) : null}
        </div>
      ) : null}

      <div className="settings-field">
        <span>{t("aiSettings.protocolLabel")}</span>
        <div className="settings-field-row">
          <select
            value={protocol}
            onChange={(event) => setProtocol(event.target.value === "anthropic" ? "anthropic" : "openai")}
            aria-label={t("aiSettings.protocolLabel")}
          >
            <option value="openai">{t("aiSettings.protocolOpenAi")}</option>
            <option value="anthropic">{t("aiSettings.protocolAnthropic")}</option>
          </select>
        </div>
        <small>{t("aiSettings.protocolProxyNote")}</small>
      </div>

      <div className="settings-field">
        <span>{t("aiSettings.baseUrlLabel")}</span>
        <div className="settings-field-row">
          <input
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            placeholder={protocol === "anthropic" ? "https://api.anthropic.com/v1" : "https://api.openai.com/v1"}
            spellCheck={false}
          />
        </div>
        <small>
          {protocol === "anthropic"
            ? t("aiSettings.baseUrlHintAnthropic")
            : t("aiSettings.baseUrlHint")}
        </small>
      </div>

      <div className="settings-field">
        <span>{t("aiSettings.apiKeyLabel")}</span>
        <div className="settings-field-row">
          <input
            type="password"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder={status?.configured ? t("aiSettings.keyPlaceholderKeep") : "sk-..."}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <small>
          <LockKeyhole size={11} /> {t("aiSettings.keyStorageHint")}
        </small>
      </div>

      <div className="settings-field">
        <span>{t("aiSettings.modelLabel")}</span>
        <div className="settings-field-row">
          <input
            value={model}
            onChange={(event) => setModel(event.target.value)}
            placeholder="gpt-5.4-nano"
            spellCheck={false}
          />
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => void fetchModels()}
            disabled={loadingModels || !baseUrl.trim()}
            title={t("aiSettings.fetchModelsHint")}
          >
            {loadingModels ? <Spinner size={13} /> : <ListRestart size={13} />}
            {t("aiSettings.fetchModels")}
          </button>
        </div>
        {models && models.length > 0 ? (
          <div className="settings-field-row">
            <select
              value={models.includes(model.trim()) ? model.trim() : ""}
              onChange={(event) => {
                if (event.target.value) setModel(event.target.value);
              }}
              aria-label={t("aiSettings.modelSelectAria")}
            >
              <option value="">
                {t("aiSettings.modelOptions", { count: models.length })}
              </option>
              {models.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        {models && models.length === 0 ? (
          <small>{t("aiSettings.emptyModelList")}</small>
        ) : null}
        {deprecationKey ? <small className="danger-text">{t(deprecationKey)}</small> : null}
        {active?.local ? (
          <small>{t("aiSettings.localModelFreeHint")}</small>
        ) : (
          <small>{t("aiSettings.modelStaleHint")}</small>
        )}
      </div>

      <div className="inline-actions">
        <button
          className="btn btn-primary btn-sm"
          onClick={() => void save()}
          disabled={
            busy || !baseUrl.trim() || !model.trim() || (!dirty && !apiKey.trim())
          }
        >
          {busy ? <Spinner size={13} /> : <KeyRound size={13} />}
          {editingId ? t("aiSettings.saveConfig") : t("aiSettings.profileCreate")}
        </button>
        <button
          className="btn btn-ghost btn-sm"
          onClick={() => void runTest()}
          disabled={testing || !baseUrl.trim()}
          title={t("aiSettings.profileTestHint")}
        >
          {testing ? <Spinner size={13} /> : <Zap size={13} />}
          {t("aiSettings.profileTest")}
        </button>
        {editingProfile?.hasKey ? (
          <button
            className="btn btn-ghost btn-sm danger-text"
            onClick={() => {
              void api
                .aiProfileClearKey(editingProfile.profile.id)
                .then((next) => {
                  setProfiles(next);
                  setStatus(null);
                  void api.aiStatus().then(setStatus);
                })
                .catch((error) => onError(error, t("aiSettings.errorClearKey")));
            }}
          >
            <Trash2 size={13} />
            {t("aiSettings.removeKey")}
          </button>
        ) : null}
      </div>
      {testResult ? (
        <p className={testResult.ok ? "ai-test-note is-ok" : "ai-test-note is-bad"}>
          {testResult.ok ? <CheckCircle2 size={12} /> : null}
          {testResult.ok
            ? t("aiSettings.profileTestDone", {
                ms: testResult.latencyMs,
                count: testResult.modelCount,
              })
            : t("aiSettings.profileTestFailed", {
                ms: testResult.latencyMs,
                message: testResult.message,
              })}
        </p>
      ) : null}
      <p className="panel-note">
        <BrainCircuit size={12} /> {t("aiSettings.footNote")}
      </p>
    </section>
  );
}
