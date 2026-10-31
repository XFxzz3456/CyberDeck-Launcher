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
 * 模型 ID。**模型 ID 与定位描述是数据不是界面文案**：它们随厂商发版按周
 * 变化，塞进 i18n 词表会变成每次上新都要改词表的维护负担，故直接写字面量；
 * 分区标题、提示语这类真正的界面文案仍然走 `t()`。
 */
export interface AiPresetModel {
  /** 显示名称（厂商给的商业名，如 `Llama 4 Maverick`）。 */
  label: string;
  /** 填进「模型名称」输入框的 ID，必须逐字等于厂商文档里的写法。 */
  id: string;
  /** 一句话定位：旗舰 / 轻量 / 上下文长度 / 特殊能力，显示在下拉选项后缀与提示行。 */
  note: string;
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
 * 关于下面这块的 i18n 区块豁免：模型目录是从厂商文档抄来的**上游快照数据**，
 * 模型 ID、商业名、定位描述（旗舰/轻量/1M 上下文）三者是一起变的，按周增删；
 * 把它们拆进词表只会变成「每次上新都要同步两个文件」。真正的界面文案——分区
 * 标题、选完之后的提示语——依旧全部走 `t()`（见 aiPreset.group.* / aiSettings.*）。
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
      { label: "GPT-6 Astra", id: "gpt-6-astra", note: "旗舰推理" },
      { label: "GPT-6 Sol", id: "gpt-6-sol", note: "付费主力" },
      { label: "GPT-6.1 Terra", id: "gpt-6.1-terra", note: "高性价比" },
      { label: "GPT-6 Luna", id: "gpt-6-luna", note: "免费 / 轻量" },
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
      { label: "Claude Opus 5.5", id: "claude-opus-5-5", note: "旗舰" },
      { label: "Claude Sonnet 5.5", id: "claude-sonnet-5-5", note: "快速均衡" },
      { label: "Claude Haiku 5.5", id: "claude-haiku-5-5", note: "轻量低价" },
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
      { label: "Gemini 4 Argon", id: "gemini-4-argon", note: "旗舰" },
      { label: "Gemini 3.8 Flash", id: "gemini-3.8-flash", note: "快速" },
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
        note: "128K 上下文，多模态",
      },
      {
        label: "Llama 4 Scout",
        id: "Llama-4-Scout-17B-16E-Instruct-FP8",
        note: "128K 上下文，轻量多模态",
      },
      { label: "Llama 3.3 70B", id: "Llama-3.3-70B-Instruct", note: "128K 上下文，稳定文本" },
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
      { label: "Grok 4.7", id: "grok-4.7", note: "旗舰，Agentic 工具调用，500K 上下文" },
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
      { label: "DeepSeek Flash", id: "deepseek-flash", note: "高性价比首选" },
      { label: "DeepSeek V4 Pro", id: "deepseek-v4-pro", note: "旗舰" },
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
      { label: "Kimi K3.1 Pro", id: "kimi-k3.1-pro", note: "最新旗舰，1M 上下文" },
      { label: "Kimi K3.1 Pro 高速版", id: "kimi-k3.1-pro-highspeed", note: "高速" },
      { label: "Kimi K2.7 Code", id: "kimi-k2.7-code", note: "专用编程模型，256K 上下文" },
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
      { label: "GLM-5.3", id: "glm-5.3", note: "最新旗舰，1M 上下文，复杂软件工程" },
      { label: "GLM-5.3 Flash", id: "glm-5.3-flash", note: "轻量高速，1M 上下文" },
      { label: "GLM-4.7", id: "glm-4.7", note: "稳定版" },
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
      { label: "豆包 Seed Evolving", id: "doubao-seed-evolving", note: "Coding & Agent 专用，持续迭代" },
      { label: "豆包 Seed 2.1 Pro", id: "doubao-seed-2.1-pro", note: "Seed 2.1 主力，256K 上下文" },
      { label: "豆包 Seed 2.1 Turbo", id: "doubao-seed-2.1-turbo", note: "Seed 2.1 轻量版" },
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
      { label: "Qwen3.8 Max", id: "qwen3.8-max", note: "旗舰，支持图片输入" },
      { label: "Qwen3.8 Flash", id: "qwen3.8-flash", note: "快速多模态，百万级上下文" },
      { label: "Qwen3.7 Plus", id: "qwen3.7-plus", note: "均衡版" },
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
      { label: "MiniMax M3.1 Flash", id: "MiniMax-M3.1-Flash", note: "原生多模态，1M 上下文" },
      { label: "MiniMax M3", id: "MiniMax-M3", note: "多模态，1M 上下文" },
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
      { label: "MiMo V2.6 Pro", id: "mimo-v2.6-pro", note: "1M 上下文，原生全模态旗舰" },
      { label: "MiMo V2.6 Flash", id: "mimo-v2.6-flash", note: "高性价比全模态" },
      { label: "MiMo V2.5 Pro", id: "mimo-v2.5-pro", note: "1M 上下文旗舰" },
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
      { label: "Qwen3.6", id: "qwen3.6:latest", note: "示例名，以 `ollama list` 为准" },
      { label: "Gemma 4 31B", id: "gemma4:31b", note: "示例名，以 `ollama list` 为准" },
      { label: "GPT-OSS 20B", id: "gpt-oss:20b", note: "示例名，以 `ollama list` 为准" },
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
      { label: "Qwen3.6", id: "qwen3.6:latest", note: "示例名，以 LM Studio 已加载模型为准" },
      { label: "Llama 4", id: "llama-4:latest", note: "示例名，以 LM Studio 已加载模型为准" },
      { label: "Gemma 4 31B", id: "gemma4:31b", note: "示例名，以 LM Studio 已加载模型为准" },
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
