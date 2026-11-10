import type { MessageKey } from "../i18n";

/**
 * AI 服务商预设（任务二：兼容所有标准 OpenAI 接口）。
 *
 * 一键填入只负责「少打字」：base_url / model 都可以直接手改，密钥永远
 * 由用户自己粘贴（DPAPI 加密存储，不进状态文件、不进日志）。
 *
 * 模型名会过时：预置值只是「开箱即用」的兜底，首选路径是设置卡片里的
 * 「联网获取模型列表」（标准 GET /v1/models，一联网就是实时清单）。
 * Ollama / LM Studio 的模型名以本机已下载的为准。
 *
 * 2026-10-29：预设扩成「厂商 → 模型」两级。厂商按 国外 / 国内 / 本地部署
 * 三大分区展示；厂商条目带一组常用模型（显示名称 + 模型 ID），选中即填
 * 模型 ID。
 *
 * 2026-11-10（自检 P2·i18n）：**定位描述从字面量改回词条**。上一版把它当成
 * 「上游快照数据」整块豁免了 i18n，但它是直接渲染到提示行给用户读的话，
 * 豁免等于允许中文硬编码文案长期存在（换语言就是死文案）。现在只有模型
 * `label`（厂商商业名）与 `id`（模型 ID）保留字面量——这两个才是逐字照抄
 * 上游、按周变动的数据；定位描述走 `aiPreset.note.*`。
 */
export interface AiPresetModel {
  /** 显示名称（厂商给的商业名，如 `Llama 4 Maverick`）。 */
  label: string;
  /** 填进「模型名称」输入框的 ID，必须逐字等于厂商文档里的写法。 */
  id: string;
  /**
   * 一句话定位的**词条 key**：旗舰 / 轻量 / 上下文长度 / 特殊能力，
   * 显示在提示行（`AiSettingsCard` 里 `t(noteKey)`）。
   *
   * 定位描述是给用户读的话，必须走词表；模型 `label`（商业名）与 `id`
   * 才是上游快照数据、保持字面量。
   */
  noteKey: MessageKey;
}

/** 预设分区：国外厂商 / 国内厂商 / 本地部署。顺序即界面展示顺序。 */
export type AiPresetGroup = "intl" | "domestic" | "local";

export interface AiPreset {
  id: string;
  /** 显示文案一律只存 key，渲染层用 t() 取。 */
  labelKey: MessageKey;
  baseUrl: string;
  /** 默认模型：选中该厂商时自动填入的模型 ID，取值必须出现在 models 里。 */
  model: string;
  keyUrl: string | null;
  keyHintKey: MessageKey;
  /** 本地服务（Ollama / LM Studio）不需要密钥。 */
  local: boolean;
  /** 该预设对应的接口协议；缺省 = openai（Anthropic 原生协议的预设必须显式给）。 */
  protocol?: "openai" | "anthropic";
  /** 所属分区。 */
  group: AiPresetGroup;
  /** 该厂商的常用模型清单；第一项通常就是 model，顺序按「旗舰 → 轻量」。 */
  models: AiPresetModel[];
}

/**
 * 分区顺序与标题。渲染层按这张表切 `<optgroup>`，
 * 新增分区只改这里 + 词表，不用动组件。
 */
export const AI_PRESET_GROUPS: { id: AiPresetGroup; labelKey: MessageKey }[] = [
  { id: "intl", labelKey: "aiPreset.group.intl" },
  { id: "domestic", labelKey: "aiPreset.group.domestic" },
  { id: "local", labelKey: "aiPreset.group.local" },
];

/** 已确认弃用 / 下线的模型名：填了这些请求会直接报错，UI 要提醒。 */
export const DEPRECATED_MODELS: { pattern: RegExp; messageKey: MessageKey }[] = [
  {
    pattern: /^(deepseek-chat|deepseek-reasoner)$/,
    messageKey: "aiPreset.deprecated.deepseek",
  },
  {
    pattern: /^moonshot-v1-/,
    messageKey: "aiPreset.deprecated.moonshotV1",
  },
  {
    // 只认 kimi-k2 本体与 k2-preview 这类旧名；kimi-k2.7-code 是在售模型，
    // 早先的 /^kimi-k2/ 前缀写法会把它误判成下线模型。
    pattern: /^kimi-(latest|thinking-preview|k2|k2-preview)$/,
    messageKey: "aiPreset.deprecated.kimiK2",
  },
  {
    pattern: /^gpt-4o/,
    messageKey: "aiPreset.deprecated.gpt4o",
  },
];

export function deprecatedModelWarningKey(model: string): MessageKey | null {
  const trimmed = model.trim();
  if (!trimmed) return null;
  return DEPRECATED_MODELS.find((item) => item.pattern.test(trimmed))?.messageKey ?? null;
}

/**
 * 预设清单。第一项是协议参考实现（OpenAI），其余是「用同一套协议」的兼容服务商——
 * 顺序有含义：它同时也是「没有预设命中时」给用户的默认说法。
 *
 * 关于 baseUrl：全部是各家**OpenAI 兼容端点**，不填 chat/completions 全路径；
 * 后端会自己补 `/chat/completions`，也会容忍多写或少写 `/v1`。
 *
 * 关于下面这块的 i18n 区块豁免：**只剩模型商业名（`label`）与模型 ID**。
 * 这两样是逐字照抄厂商文档、随发版按周增删的上游数据，拆进词表只会变成
 * 「每次上新同步两个文件」；定位描述已改为 `aiPreset.note.*` 词条，
 * 分区标题、提示语一律走 `t()`（见 aiPreset.group.* / aiSettings.*）。
 */
// i18n-ignore-start
export const AI_PRESETS: AiPreset[] = [
  {
    id: "openai",
    labelKey: "aiPreset.openai.label",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-6-sol",
    keyUrl: "https://platform.openai.com/api-keys",
    keyHintKey: "aiPreset.openai.keyHint",
    local: false,
    group: "intl",
    models: [
      { label: "GPT-6 Astra", id: "gpt-6-astra", noteKey: "aiPreset.note.flagshipReasoning" },
      { label: "GPT-6 Sol", id: "gpt-6-sol", noteKey: "aiPreset.note.paidMain" },
      { label: "GPT-6.1 Terra", id: "gpt-6.1-terra", noteKey: "aiPreset.note.value" },
      { label: "GPT-6 Luna", id: "gpt-6-luna", noteKey: "aiPreset.note.freeLight" },
    ],
  },
  {
    id: "anthropic",
    labelKey: "aiPreset.anthropic.label",
    baseUrl: "https://api.anthropic.com/v1",
    model: "claude-sonnet-5-5",
    keyUrl: "https://console.anthropic.com/settings/keys",
    keyHintKey: "aiPreset.anthropic.keyHint",
    local: false,
    protocol: "anthropic",
    group: "intl",
    models: [
      { label: "Claude Opus 5.5", id: "claude-opus-5-5", noteKey: "aiPreset.note.flagship" },
      { label: "Claude Sonnet 5.5", id: "claude-sonnet-5-5", noteKey: "aiPreset.note.fastBalanced" },
      { label: "Claude Haiku 5.5", id: "claude-haiku-5-5", noteKey: "aiPreset.note.lightCheap" },
    ],
  },
  {
    id: "google",
    labelKey: "aiPreset.google.label",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    model: "gemini-4-argon",
    keyUrl: "https://aistudio.google.com/app/apikey",
    keyHintKey: "aiPreset.google.keyHint",
    local: false,
    group: "intl",
    models: [
      { label: "Gemini 4 Argon", id: "gemini-4-argon", noteKey: "aiPreset.note.flagship" },
      { label: "Gemini 3.8 Flash", id: "gemini-3.8-flash", noteKey: "aiPreset.note.fast" },
    ],
  },
  {
    id: "meta",
    labelKey: "aiPreset.meta.label",
    baseUrl: "https://api.together.xyz/v1",
    model: "Llama-4-Maverick-17B-128E-Instruct-FP8",
    keyUrl: "https://api.together.ai/settings/api-keys",
    keyHintKey: "aiPreset.meta.keyHint",
    local: false,
    group: "intl",
    models: [
      {
        label: "Llama 4 Maverick",
        id: "Llama-4-Maverick-17B-128E-Instruct-FP8",
        noteKey: "aiPreset.note.ctx128kMultimodal",
      },
      {
        label: "Llama 4 Scout",
        id: "Llama-4-Scout-17B-16E-Instruct-FP8",
        noteKey: "aiPreset.note.ctx128kLightMultimodal",
      },
      { label: "Llama 3.3 70B", id: "Llama-3.3-70B-Instruct", noteKey: "aiPreset.note.ctx128kStableText" },
    ],
  },
  {
    id: "xai",
    labelKey: "aiPreset.xai.label",
    baseUrl: "https://api.x.ai/v1",
    model: "grok-4.7",
    keyUrl: "https://console.x.ai/",
    keyHintKey: "aiPreset.xai.keyHint",
    local: false,
    group: "intl",
    models: [
      { label: "Grok 4.7", id: "grok-4.7", noteKey: "aiPreset.note.flagshipAgent500k" },
    ],
  },
  {
    id: "deepseek",
    labelKey: "aiPreset.deepseek.label",
    baseUrl: "https://api.deepseek.com/v1",
    model: "deepseek-flash",
    keyUrl: "https://platform.deepseek.com/api_keys",
    keyHintKey: "aiPreset.deepseek.keyHint",
    local: false,
    group: "domestic",
    models: [
      { label: "DeepSeek Flash", id: "deepseek-flash", noteKey: "aiPreset.note.valuePrimary" },
      { label: "DeepSeek V4 Pro", id: "deepseek-v4-pro", noteKey: "aiPreset.note.flagship" },
    ],
  },
  {
    id: "moonshot",
    labelKey: "aiPreset.moonshot.label",
    baseUrl: "https://api.moonshot.cn/v1",
    model: "kimi-k3.1-pro",
    keyUrl: "https://platform.moonshot.cn/console/api-keys",
    keyHintKey: "aiPreset.moonshot.keyHint",
    local: false,
    group: "domestic",
    models: [
      { label: "Kimi K3.1 Pro", id: "kimi-k3.1-pro", noteKey: "aiPreset.note.flagship1m" },
      { label: "Kimi K3.1 Pro 高速版", id: "kimi-k3.1-pro-highspeed", noteKey: "aiPreset.note.highSpeed" },
      { label: "Kimi K2.7 Code", id: "kimi-k2.7-code", noteKey: "aiPreset.note.coding256k" },
    ],
  },
  {
    id: "glm",
    labelKey: "aiPreset.glm.label",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    model: "glm-5.3",
    keyUrl: "https://open.bigmodel.cn/usercenter/apikeys",
    keyHintKey: "aiPreset.glm.keyHint",
    local: false,
    group: "domestic",
    models: [
      { label: "GLM-5.3", id: "glm-5.3", noteKey: "aiPreset.note.flagship1mCode" },
      { label: "GLM-5.3 Flash", id: "glm-5.3-flash", noteKey: "aiPreset.note.lightFast1m" },
      { label: "GLM-4.7", id: "glm-4.7", noteKey: "aiPreset.note.stable" },
    ],
  },
  {
    id: "doubao",
    labelKey: "aiPreset.doubao.label",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    model: "doubao-seed-2.1-pro",
    keyUrl: "https://console.volcengine.com/ark",
    keyHintKey: "aiPreset.doubao.keyHint",
    local: false,
    group: "domestic",
    models: [
      { label: "豆包 Seed Evolving", id: "doubao-seed-evolving", noteKey: "aiPreset.note.codingAgent" },
      { label: "豆包 Seed 2.1 Pro", id: "doubao-seed-2.1-pro", noteKey: "aiPreset.note.seed21Main256k" },
      { label: "豆包 Seed 2.1 Turbo", id: "doubao-seed-2.1-turbo", noteKey: "aiPreset.note.seed21Light" },
    ],
  },
  {
    id: "qwen",
    labelKey: "aiPreset.qwen.label",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "qwen3.8-max",
    keyUrl: "https://bailian.console.aliyun.com/",
    keyHintKey: "aiPreset.qwen.keyHint",
    local: false,
    group: "domestic",
    models: [
      { label: "Qwen3.8 Max", id: "qwen3.8-max", noteKey: "aiPreset.note.flagshipVision" },
      { label: "Qwen3.8 Flash", id: "qwen3.8-flash", noteKey: "aiPreset.note.fastMultimodal1m" },
      { label: "Qwen3.7 Plus", id: "qwen3.7-plus", noteKey: "aiPreset.note.balanced" },
    ],
  },
  {
    id: "minimax",
    labelKey: "aiPreset.minimax.label",
    baseUrl: "https://api.minimax.cn/v1",
    model: "MiniMax-M3.1-Flash",
    keyUrl: "https://platform.minimaxi.com/user-center/basic-information/interface-key",
    keyHintKey: "aiPreset.minimax.keyHint",
    local: false,
    group: "domestic",
    models: [
      { label: "MiniMax M3.1 Flash", id: "MiniMax-M3.1-Flash", noteKey: "aiPreset.note.nativeMultimodal1m" },
      { label: "MiniMax M3", id: "MiniMax-M3", noteKey: "aiPreset.note.multimodal1m" },
    ],
  },
  {
    id: "mimo",
    labelKey: "aiPreset.mimo.label",
    baseUrl: "https://api.xiaomimimo.com/v1",
    model: "mimo-v2.6-pro",
    keyUrl: null,
    keyHintKey: "aiPreset.mimo.keyHint",
    local: false,
    group: "domestic",
    models: [
      { label: "MiMo V2.6 Pro", id: "mimo-v2.6-pro", noteKey: "aiPreset.note.ctx1mOmniFlagship" },
      { label: "MiMo V2.6 Flash", id: "mimo-v2.6-flash", noteKey: "aiPreset.note.valueOmni" },
      { label: "MiMo V2.5 Pro", id: "mimo-v2.5-pro", noteKey: "aiPreset.note.ctx1mFlagship" },
    ],
  },
  {
    id: "ollama",
    labelKey: "aiPreset.ollama.label",
    baseUrl: "http://localhost:11434/v1",
    model: "qwen3.6:latest",
    keyUrl: null,
    keyHintKey: "aiPreset.ollama.keyHint",
    local: true,
    group: "local",
    models: [
      { label: "Qwen3.6", id: "qwen3.6:latest", noteKey: "aiPreset.note.ollamaSample" },
      { label: "Gemma 4 31B", id: "gemma4:31b", noteKey: "aiPreset.note.ollamaSample" },
      { label: "GPT-OSS 20B", id: "gpt-oss:20b", noteKey: "aiPreset.note.ollamaSample" },
    ],
  },
  {
    id: "lmstudio",
    labelKey: "aiPreset.lmStudio.label",
    baseUrl: "http://localhost:1234/v1",
    model: "qwen3.6:latest",
    keyUrl: null,
    keyHintKey: "aiPreset.lmStudio.keyHint",
    local: true,
    group: "local",
    models: [
      { label: "Qwen3.6", id: "qwen3.6:latest", noteKey: "aiPreset.note.lmStudioSample" },
      { label: "Llama 4", id: "llama-4:latest", noteKey: "aiPreset.note.lmStudioSample" },
      { label: "Gemma 4 31B", id: "gemma4:31b", noteKey: "aiPreset.note.lmStudioSample" },
    ],
  },
];
// i18n-ignore-end

export function findAiPreset(id: string): AiPreset | null {
  return AI_PRESETS.find((preset) => preset.id === id) ?? null;
}

/** 按分区取预设，供 `<optgroup>` 渲染。没有条目的分区会被跳过，不留空标题。 */
export function presetsByGroup(group: AiPresetGroup): AiPreset[] {
  return AI_PRESETS.filter((preset) => preset.group === group);
}

/** 该厂商下是否真有这个模型 ID（选完预设后判断下拉框该停在哪一项）。 */
export function findPresetModel(presetId: string, modelId: string): AiPresetModel | null {
  const preset = findAiPreset(presetId);
  if (!preset) return null;
  return preset.models.find((item) => item.id === modelId.trim()) ?? null;
}

/** 协议标签：界面里所有「接入的是什么」的措辞都来自这里，避免各处写法漂移。 */
export const AI_PROTOCOL_LABEL_KEY: MessageKey = "aiPreset.protocolLabel";

/**
 * 把地址归一化到可比对的形式：去尾斜杠、去 `/chat/completions` 后缀、去版本段。
 *
 * 版本段要去掉——`https://api.deepseek.com` 与 `.../v1` 是同一个服务的两种写法，
 * 用户从旧版状态文件里继承下来的地址往往没有 `/v1`。Gemini 的兼容端点
 * 结尾是 `/v1beta/openai`，不是纯版本段，故额外剥一层 `/openai`。
 */
function comparableBaseUrl(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\/+$/, "")
    .replace(/\/chat\/completions$/, "")
    .replace(/\/openai$/, "")
    .replace(/\/v\d+(beta)?$/, "");
}

/**
 * 用「已保存的地址 + 模型名」反查预设。
 *
 * 预设下拉框的状态是本地 state，默认永远停在「手动配置…」——于是保存完 DeepSeek
 * 预设后，下拉框显示的和输入框里显示的互相矛盾。这个函数让下拉框反映真实配置。
 *
 * 判定以**接口地址**为准，模型名只作辅助：一个厂商现在挂着一整排模型（还常被
 * 用户手改成厂商刚发的新名字），要求模型名精确命中预设会让老配置一升级就退回
 * 「手动配置…」。地址对上就认这家厂商，模型名对不上只是「模型预设」下拉框不
 * 预选任何一项——用户输入框里的值一个字都不会被改，反查本身不回写任何状态。
 */
export function matchAiPreset(baseUrl: string, model: string): AiPreset | null {
  const url = comparableBaseUrl(baseUrl);
  const name = model.trim();
  if (!url || !name) return null;
  return AI_PRESETS.find((preset) => comparableBaseUrl(preset.baseUrl) === url) ?? null;
}
