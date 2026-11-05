import type { AppStateData, ModEntry, Settings, Snapshot } from "../types";

/**
 * 状态入口的「脏数据」规范化。
 *
 * 为什么要这一层：磁盘上的 `launcher-state.json` 可能被手改、被旧版本写过、
 * 或被第三方工具动过。字段类型一旦不对（例如 `translatedName: 12345`），
 * 界面里任何 `(x ?? "").trim()` 都会抛异常，而抛点常常在**卡片之外**
 * （排序、筛选、统计），错误边界接不住 → 整个 root 被 React 卸载 → 白屏。
 *
 * 2026-10-26 门禁实测复现：注入一条 `translatedName: 12345` 的模组后
 * `#root` 子节点数为 0。所以规范化必须发生在**状态进入层**，
 * 而不是指望每个组件各自写防御代码。
 *
 * 原则：只降级、不丢弃（除了连 id 都没有、无法定位的条目），
 * 让用户还能看见并在界面里删掉那条坏数据。
 */

const text = (value: unknown, fallback = ""): string =>
  typeof value === "string" ? value : value == null ? fallback : String(value);

const optionalText = (value: unknown): string | null =>
  value == null || value === "" ? null : text(value);

const bool = (value: unknown, fallback: boolean): boolean =>
  typeof value === "boolean" ? value : fallback;

const num = (value: unknown, fallback = 0): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

const list = <T>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);

function normalizeMod(raw: unknown): ModEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const mod = raw as Record<string, unknown>;
  const id = text(mod.id);
  // 没有 id 的条目无法启用/卸载/定位，留着只会制造幽灵卡片。
  if (!id) return null;
  const nexusRaw = mod.nexus && typeof mod.nexus === "object" ? (mod.nexus as Record<string, unknown>) : null;
  return {
    ...(mod as unknown as ModEntry),
    id,
    name: text(mod.name, id),
    // 老状态文件没有这个字段；后端把 name 清洗成展示名后，原名会存这里。
    rawName: optionalText(mod.rawName),
    version: optionalText(mod.version),
    author: optionalText(mod.author),
    category: text(mod.category),
    // 老状态文件没有这个字段：缺省按「未锁定」处理，否则重算会把它当手动分类跳过。
    categoryLocked: mod.categoryLocked === true,
    description: text(mod.description),
    sourceZip: optionalText(mod.sourceZip),
    nexus: nexusRaw
      ? {
          modId: num(nexusRaw.modId),
          fileId: typeof nexusRaw.fileId === "number" ? nexusRaw.fileId : null,
          url: text(nexusRaw.url),
          version: optionalText(nexusRaw.version),
          pictureUrl: optionalText(nexusRaw.pictureUrl),
        }
      : null,
    stagingPath: text(mod.stagingPath),
    coverPath: optionalText(mod.coverPath),
    enabled: bool(mod.enabled, false),
    installedAt: text(mod.installedAt),
    updatedAt: optionalText(mod.updatedAt),
    sizeBytes: num(mod.sizeBytes),
    fileCount: num(mod.fileCount),
    modFolder: optionalText(mod.modFolder),
    metadataSource: text(mod.metadataSource, "filename"),
    plannedFiles: list<string>(mod.plannedFiles).map((item) => text(item)),
    warnings: list<string>(mod.warnings).map((item) => text(item)),
    deployedFiles: list(mod.deployedFiles),
    translatedName: optionalText(mod.translatedName),
    translatedAt: optionalText(mod.translatedAt),
    translatedBy: optionalText(mod.translatedBy),
    managed: bool(mod.managed, true),
    modpackId: optionalText(mod.modpackId),
    nexusCoverUrl: optionalText(mod.nexusCoverUrl),
  };
}

const SETTING_TEXT_KEYS = [
  "closeBehavior",
  "launchMethod",
  "platformPref",
  "archiveToolPath",
  "wolvenkitCliPath",
  "aiBaseUrl",
  "aiModel",
  "launchArgs",
  "backgroundImage",
  "deployMode",
  "launchGpuPref",
  "launchPriority",
  "launchPreCommand",
] as const;

const SETTING_BOOL_KEYS = [
  "closeAsk",
  "writeModlist",
  "autoBackup",
  "confirmUninstall",
  "nexusHideAdult",
  "nxmAutoDownload",
] as const;

/**
 * 旧模型名的静默迁移表。
 *
 * DeepSeek 把一度出现在预设里的预览名 `deepseek-v4.1-flash-1017` 收敛成了
 * `deepseek-flash`。老用户状态文件里存的还是旧名，而旧名请求会直接被服务商
 * 判「模型不存在」——不迁移的话，「AI 用不了」会变成一桩无头悬案。这里在
 * 归一化时直接改写，不弹提示、不动地址（地址一直是对的）。
 */
const AI_MODEL_ALIASES: Record<string, string> = {
  "deepseek-v4.1-flash-1017": "deepseek-flash",
};

/** 设置只做类型兜底，不做业务校验（范围钳制是后端 set_settings 的职责）。 */
export function normalizeSettings(raw: unknown, fallback: Settings): Settings {
  if (!raw || typeof raw !== "object") return fallback;
  const settings = raw as Record<string, unknown>;
  // 用「先攒补丁再合并」而不是直接 next[key] = ...：
  // launchMethod / platformPref 是字符串字面量联合，直接按联合 key 赋值会被收窄成 never。
  const textPatch: Partial<Record<(typeof SETTING_TEXT_KEYS)[number], string>> = {};
  for (const key of SETTING_TEXT_KEYS) {
    if (key in settings) textPatch[key] = text(settings[key], fallback[key]);
  }
  // 静默迁移旧模型名（只在这一处做，避免各调用点各写一份别名表）。
  if (textPatch.aiModel && AI_MODEL_ALIASES[textPatch.aiModel]) {
    textPatch.aiModel = AI_MODEL_ALIASES[textPatch.aiModel];
  }
  const boolPatch: Partial<Record<(typeof SETTING_BOOL_KEYS)[number], boolean>> = {};
  for (const key of SETTING_BOOL_KEYS) {
    if (key in settings) boolPatch[key] = bool(settings[key], fallback[key]);
  }
  return {
    ...fallback,
    ...textPatch,
    ...boolPatch,
    wolvenkitTimeoutSecs: num(settings.wolvenkitTimeoutSecs, fallback.wolvenkitTimeoutSecs),
    backgroundOpacity: num(settings.backgroundOpacity, fallback.backgroundOpacity),
    backgroundBlur: num(settings.backgroundBlur, fallback.backgroundBlur),
    backgroundPosX: num(settings.backgroundPosX, fallback.backgroundPosX),
    backgroundPosY: num(settings.backgroundPosY, fallback.backgroundPosY),
    backgroundDim: num(settings.backgroundDim, fallback.backgroundDim),
    // 缩放倍率（3A-3）：1.0–3.0，非有限数 / 越界都钳回合法区间。
    backgroundZoom: Math.min(
      3,
      Math.max(1, Number.isFinite(Number(settings.backgroundZoom)) ? Number(settings.backgroundZoom) : 1),
    ),
    // 协议是字面量联合，非法值一律回退 openai，不进文本兜底通道。
    aiProtocol: settings.aiProtocol === "anthropic" ? "anthropic" : "openai",
    // 填充模式同理：只认三个合法值，其余（含旧状态里缺字段）回退 cover。
    backgroundFit:
      settings.backgroundFit === "contain" || settings.backgroundFit === "stretch"
        ? settings.backgroundFit
        : "cover",
  } as Settings;
}

function normalizeState(raw: unknown, fallbackSettings: Settings): AppStateData {
  const state = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const mods = list<unknown>(state.mods)
    .map(normalizeMod)
    .filter((item): item is ModEntry => item !== null);
  return {
    ...(state as unknown as AppStateData),
    schemaVersion: num(state.schemaVersion, 1),
    gameDir: optionalText(state.gameDir),
    stagingDir: text(state.stagingDir),
    mods,
    loadOrder: list<string>(state.loadOrder).map((item) => text(item)),
    // 老状态文件没有这个字段；缺省成空数组，由后端 normalize_order 补齐未登记的 mod。
    redmodOrder: list<string>(state.redmodOrder).map((item) => text(item)),
    modpacks: list(state.modpacks),
    profiles: list(state.profiles),
    activeProfileId: optionalText(state.activeProfileId),
    settings: normalizeSettings(state.settings, fallbackSettings),
    lastGameVersion: optionalText(state.lastGameVersion),
    lastLaunch: optionalText(state.lastLaunch),
    backup: state.backup && typeof state.backup === "object" ? (state.backup as AppStateData["backup"]) : null,
    lastUpdateCheck: optionalText(state.lastUpdateCheck),
  };
}

/** 与后端 Settings 的 serde 默认值保持一致；只用类型兜底，不参与业务判断。 */
export const FALLBACK_SETTINGS: Settings = {
  writeModlist: false,
  autoBackup: true,
  confirmUninstall: true,
  closeBehavior: "tray",
  closeAsk: true,
  launchMethod: "auto",
  platformPref: "auto",
  archiveToolPath: "",
  wolvenkitCliPath: "",
  wolvenkitTimeoutSecs: 60,
  aiBaseUrl: "https://api.openai.com/v1",
  aiModel: "gpt-5.4-nano",
  aiProtocol: "openai",
  nexusHideAdult: true,
  launchArgs: "",
  nxmAutoDownload: true,
  backgroundImage: "",
  backgroundOpacity: 45,
  backgroundBlur: 0,
  backgroundFit: "cover",
  backgroundPosX: 50,
  backgroundPosY: 50,
  backgroundDim: 50,
  backgroundZoom: 1,
  deployMode: "hardlink",
  launchGpuPref: "auto",
  launchPriority: "normal",
  launchPreCommand: "",
  autoSnapshot: true,
  snapshotLimit: 10,
  saveEditorPath: "",
};

export function normalizeSnapshot(raw: Snapshot | null | undefined): Snapshot {
  if (!raw || typeof raw !== "object") {
    return {
      state: normalizeState(null, FALLBACK_SETTINGS),
      game: null,
      loadOrder: { archives: [], redmods: [], modlistPath: null, modlistExists: false, managedModlist: false },
      conflicts: [],
      demoMode: false,
      stateRecoveredFrom: null,
    };
  }
  return {
    ...raw,
    state: normalizeState(raw.state, FALLBACK_SETTINGS),
    game: raw.game && typeof raw.game === "object" ? raw.game : null,
    loadOrder:
      raw.loadOrder && typeof raw.loadOrder === "object"
        ? {
            ...raw.loadOrder,
            archives: list(raw.loadOrder.archives),
            redmods: list(raw.loadOrder.redmods),
            modlistPath: typeof raw.loadOrder.modlistPath === "string" ? raw.loadOrder.modlistPath : null,
            modlistExists: bool(raw.loadOrder.modlistExists, false),
            managedModlist: bool(raw.loadOrder.managedModlist, false),
          }
        : { archives: [], redmods: [], modlistPath: null, modlistExists: false, managedModlist: false },
    conflicts: list(raw.conflicts),
    demoMode: bool(raw.demoMode, false),
  };
}
