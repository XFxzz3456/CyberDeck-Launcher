import type {
  BackfillProposal,
  BackfillReport,
  PackApplyReport,
  PackExportInput,
  PackExportReport,
  PackInstallReport,
  PackManualItem,
  PackPreview,
  PackPreviewItem,
  PackQueueReport,
} from "./pack";
import type {
  AdoptCandidate,
  AdoptReport,
  AdoptScanReport,
  AdoptStagingHealth,
  LibraryNormalizeReport,
  VortexTakeoverPreflight,
  VortexCoverageReport,
  VortexMappingReport,
  VortexPrelaunchReport,
  VortexReconcileReport,
  VortexSyncReport,
  VortexSyncStatus,
  VortexRebuildPreview,
  VortexRebuildReport,
  AiDiagnosis,
  AiStatus,
  AiFixProposal,
  AiFixReport,
  BackgroundImage,
  AiLocPlan,
  AiLocReport,
  EnvSnapshot,
  SaveScanReport,
  AppStateData,
  ConflictInfo,
  DeployReport,
  DiagnosticIssue,
  DependencyReport,
  DiagnosticsReport,
  FrameworkStatus,
  GameInfo,
  InstallOutcome,
  InstallLayout,
  LoadOrderSuggestion,
  LoadOrderView,
  LogFileInfo,
  LogTail,
  ModEntry,
  ModConfigSource,
  ModConfigView,
  ModSettingsView,
  ModlistExport,
  NexusDownloadResult,
  NexusModDetail,
  NexusModSummary,
  NexusSection,
  NexusStatus,
  NexusCoverRefresh,
  NexusEnrichReport,
  NexusUpdateReport,
  UpdateApplyItem,
  UpdateApplyReport,
  UpdateBackup,
  RestoreResult,
  TranslateReport,
  Settings,
  Snapshot,
  AiActionReport,
  NexusTestResult,
  AiProfile,
  AiProfileList,
  AiTestResult,
  AiFixAction,
  EnvDiagnosis,
  EnvIssue,
  HealReport,
  ProfileList,
  SwitchProfileReport,
  BackupInfo,
  LaunchCheck,
  LaunchResult,
  NxmLink,
  NxmStatus,
  DeepScanRef,
  DeepScanReport, StagingMoveReport, ToolProbe,
  DownloadTask, DownloadQueueSettings, ProfileImportReport, BatchEnableReport,
  ExternalToolEntry, DriveSuggestion, CoverCacheReport, CoverCacheStats } from "../types";
import type { CollectionDeployReport } from "./collection";
import type { ApiSurface } from "./api";
import type { CollectionPlan } from "./collection";

const STORAGE_KEY = "cyberdeck-launcher-demo-state-v1";
const DEMO_GAME = "D:\\Games\\Cyberpunk 2077";
const DEMO_DATA = "C:\\Users\\Administrator\\AppData\\Roaming\\com.arol.cyberdeck";

const DEMO_INI_SECTIONS: ModSettingsView["sections"] = [
  {
    name: "General",
    entries: [
      { section: "General", key: "enabled", value: "true", kind: "bool" },
      { section: "General", key: "language", value: "zh-CN", kind: "string" },
    ],
  },
  {
    name: "HUD",
    entries: [
      { section: "HUD", key: "show_minimap", value: "true", kind: "bool" },
      { section: "HUD", key: "scale", value: "1.0", kind: "number" },
      { section: "HUD", key: "accent", value: "#fcee0a", kind: "string" },
    ],
  },
  {
    name: "Audio",
    entries: [
      { section: "Audio", key: "radio_volume", value: "0.8", kind: "number" },
      { section: "Audio", key: "mute_in_combat", value: "false", kind: "bool" },
    ],
  },
];

let demoIniSections: ModSettingsView["sections"] = DEMO_INI_SECTIONS.map((section) => ({
  ...section,
  entries: section.entries.map((entry) => ({ ...entry })),
}));

/**
 * 详情抽屉里的「专属配置」演示数据。
 *
 * 刻意只给两个模组配来源：一个走 Mod Settings 的 user.ini（redscript/CET 共用），
 * 一个走 Mod 自己的 config.json，其余模组返回空数组——正好覆盖「有配置 / 无配置」
 * 两种界面状态，也顺带证明「没配置的模组不会凭空长出表单」。
 */
const DEMO_MOD_CONFIG_SOURCES: Record<string, ModConfigSource[]> = {
  "mod-handling": [
    {
      id: "mod_settings",
      label: "Mod Settings",
      path: `${DEMO_GAME}\\bin\\x64\\plugins\\cyber_engine_tweaks\\mods\\ModSettings\\user.ini`,
      format: "ini",
      editable: true,
      fields: [
        {
          section: "BetterVehicleHandling",
          key: "reduce_drift",
          value: "true",
          kind: "bool",
          label: "reduce drift",
        },
        {
          section: "BetterVehicleHandling",
          key: "grip",
          value: "1.25",
          kind: "number",
          label: "grip",
        },
        {
          section: "BetterVehicleHandling",
          key: "brake_bias",
          value: "0.5",
          kind: "number",
          label: "brake bias",
        },
      ],
      raw: null,
      note: "改完直接写回 user.ini，只动你改过的那一行，写前会留一份 .bak。",
    },
  ],
  "mod-radio": [
    {
      id: "mod_json",
      label: "Mod 配置",
      path: `${DEMO_GAME}\\bin\\x64\\plugins\\cyber_engine_tweaks\\mods\\RadioExtender\\config.json`,
      format: "json",
      editable: true,
      fields: [
        { section: "", key: "audio.volume", value: "0.8", kind: "number", label: "volume" },
        { section: "", key: "audio.crossfade", value: "true", kind: "bool", label: "crossfade" },
        { section: "", key: "channels", value: "12", kind: "number", label: "channels" },
      ],
      raw: null,
      note: "改完只写回你动过的那一项，其它键保持原样。写入前会备份为 .bak。",
    },
  ],
};

/** 深拷贝，避免调用方改到模块级演示数据。 */
function cloneModConfig(sources: ModConfigSource[]): ModConfigSource[] {
  return sources.map((source) => ({
    ...source,
    fields: source.fields.map((field) => ({ ...field })),
  }));
}

const DEFAULT_SETTINGS: Settings = {
  writeModlist: false,
  autoBackup: true,
  autoCacheCovers: true,
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

/** 演示用的 nxm 处理器归属：初始假设 Vortex 已经占了协议，用来演示接管/交还。 */
let mockNxm: NxmStatus = {
  ours: false,
  registered: true,
  owner: "other",
  handler: 'C:////Program Files\\Vortex\\vortex.exe "%1"',
  backup: null,
  backupAt: null,
};

interface DemoDb {
  state: AppStateData;
  gameDir: string | null;
}

const sleep = (ms = 180) => new Promise((resolve) => setTimeout(resolve, ms));

function iso(offsetDays = 0): string {
  const date = new Date();
  date.setDate(date.getDate() - offsetDays);
  return date.toISOString();
}

function archivePath(name: string): string {
  return `archive/pc/mod/${name}.archive`;
}


/** 演示版按名称推断分类（与 Rust 侧的思路一致：只看名字，不看描述）。 */
function inferCategoryByName(name: string): string | null {
  const RULES: Array<[RegExp, string]> = [
    [/red4ext|archivexl|tweakxl|codeware|redscript|framework/i, "框架"],
    [/weapon|gun|blade|katana|rifle|pistol/i, "武器"],
    [/clothing|outfit|armor|jacket|coat|dress|shoes|heels/i, "服装"],
    [/vehicle|bike|motorcycle/i, "车辆"],
    [/hair|face|skin|tattoo|visual|reshade|weather/i, "视觉"],
    [/audio|sound|radio|music/i, "音频"],
    [/quest|romance|npc|story|mission/i, "任务"],
    [/hud|minimap|interface|gameplay|balance/i, "玩法"],
    [/tool|manager|menu|trainer|console/i, "工具"],
  ];
  return RULES.find(([pattern]) => pattern.test(name))?.[1] ?? null;
}

function baseMod(
  id: string,
  name: string,
  category: string,
  layout: InstallLayout,
  enabled: boolean,
  options: Partial<ModEntry> = {},
): ModEntry {
  return {
    id,
    name,
    rawName: null,
    version: "1.0.0",
    author: "CyberDeck",
    category,
    categoryLocked: false,
    description: "",
    sourceZip: null,
    nexus: null,
    stagingPath: `${DEMO_DATA}\\staging\\${id}\\payload`,
    coverPath: null,
    coverCachePath: null,
    enabled,
    installedAt: iso(8),
    updatedAt: iso(1),
    sizeBytes: 12_400_000,
    fileCount: 4,
    layout,
    modFolder: null,
    metadataSource: "infoJson",
    plannedFiles: [],
    warnings: [],
    deployedFiles: [],
    hasArchive: layout === "archive",
    hasRedmod: layout === "redmod",
    hasCet: layout === "cet",
    translatedName: null,
    translatedAt: null,
    translatedBy: null,
    managed: true,
    origin: "cyberdeck",
    modpackId: null,
    nexusCoverUrl: null,
    isTranslation: false,
    parentModId: null,
    aiLoc: null,
    aiFix: [],
    ...options,
  };
}

function deployed(
  modId: string,
  relativePath: string,
  index = 0,
): ModEntry["deployedFiles"][number] {
  return {
    source: `${DEMO_DATA}\\staging\\${modId}\\payload\\file-${index}`,
    target: `${DEMO_GAME}\\${relativePath.replaceAll("/", "\\")}`,
    linkType: "hardLink",
    relativePath,
  };
}

function createInitial(): DemoDb {
  const mods: ModEntry[] = [
    baseMod("mod-red4ext", "RED4ext", "框架", "redmod", true, {
      version: "1.27.0",
      author: "WopsS",
      description:
        "现代 Cyberpunk 脚本扩展的运行时底座。为 ArchiveXL、TweakXL、Codeware 等框架提供加载能力。",
      sizeBytes: 8_912_000,
      fileCount: 24,
      installedAt: iso(42),
      modFolder: "RED4ext",
      hasRedmod: true,
      hasArchive: false,
    }),
    baseMod("mod-cet", "Cyber Engine Tweaks", "框架", "cet", true, {
      version: "1.36.1",
      author: "Yamashi",
      description:
        "CET 控制台与 Lua 模组运行时。几乎所有带设置菜单的功能模组都需要它。",
      sizeBytes: 24_620_000,
      fileCount: 61,
      installedAt: iso(42),
      modFolder: "Cyber Engine Tweaks",
      hasCet: true,
      hasArchive: false,
    }),
    baseMod("mod-archivexl", "ArchiveXL", "框架", "redmod", true, {
      version: "1.23.4",
      author: "psiberx",
      description: "扩展 archive 加载与流式资源能力，服装与武器模组的基础依赖。",
      sizeBytes: 5_102_000,
      fileCount: 12,
      installedAt: iso(41),
      modFolder: "ArchiveXL",
    }),
    baseMod("mod-tweakxl", "TweakXL", "框架", "redmod", true, {
      version: "1.12.2",
      author: "psiberx",
      description: "TweakDB 修改框架。让模组可以安全地追加和覆盖游戏数值。",
      sizeBytes: 4_211_000,
      fileCount: 9,
      installedAt: iso(41),
      modFolder: "TweakXL",
    }),
    baseMod("mod-relit", "CyberDeck ReLIT", "视觉", "archive", true, {
      version: "2.4.0",
      author: "Skyline",
      description:
        "重做夜间光照、湿地面反射与霓虹溢出。为夜之城保留更深的黑位和更干净的灯牌高光。",
      sizeBytes: 186_500_000,
      fileCount: 3,
      installedAt: iso(12),
      hasArchive: true,
      deployedFiles: [
        deployed("mod-relit", archivePath("zzz_relit_core")),
        deployed("mod-relit", archivePath("zzz_relit_lut")),
        deployed("mod-relit", "archive/pc/mod/zzz_relit.xl", 2),
      ],
    }),
    baseMod("mod-neonrain", "Neon Rain ReShade", "视觉", "archive", true, {
      version: "1.8.1",
      author: "V",
      description:
        "轻量 ReShade 预设：冷青阴影、暖黄高光、轻微色差。建议与 ReLIT 二选一。",
      sizeBytes: 62_200_000,
      fileCount: 2,
      installedAt: iso(7),
      hasArchive: true,
      deployedFiles: [
        deployed("mod-neonrain", archivePath("zzz_relit_core")),
        deployed("mod-neonrain", "archive/pc/mod/zzz_neonrain.xl", 1),
      ],
      warnings: ["与 CyberDeck ReLIT 写入了同一个 archive，二者只能启用一个。"],
    }),
    baseMod("mod-streetstyle", "Street Style Vol. 3", "服装", "archive", true, {
      version: "3.0.2",
      author: "Kala",
      description:
        "42 套街头服装，包含 ArchiveXL 变体与动态材质。全部通过游戏内衣柜解锁。",
      sizeBytes: 1_240_000_000,
      fileCount: 3,
      installedAt: iso(5),
      hasArchive: true,
      deployedFiles: [
        deployed("mod-streetstyle", archivePath("streetstyle_vol3")),
        deployed("mod-streetstyle", "archive/pc/mod/streetstyle_vol3.xl", 1),
      ],
    }),
    baseMod("mod-chromearms", "Cyberarms — Chrome Collection", "武器", "redmod", true, {
      version: "1.3.0",
      author: "Rogue",
      description: "为螳螂刀与单分子线增加 18 种镀铬变体，附带独立检视动画。",
      sizeBytes: 74_000_000,
      fileCount: 18,
      installedAt: iso(10),
      modFolder: "ChromeArms",
      hasRedmod: true,
      deployedFiles: [
        deployed("mod-chromearms", "mods/ChromeArms/info.json"),
        deployed("mod-chromearms", "mods/ChromeArms/archives/chromearms.archive", 1),
      ],
    }),
    baseMod("mod-caliburn", "Rayfield Caliburn — Blackout", "车辆", "archive", true, {
      version: "1.1.0",
      author: "Merc",
      description: "哑光黑车漆、去标与定制轮毂。替换原版 Caliburn 外观。",
      sizeBytes: 38_600_000,
      fileCount: 1,
      installedAt: iso(9),
      hasArchive: true,
      deployedFiles: [deployed("mod-caliburn", archivePath("caliburn_blackout"))],
    }),
    baseMod("mod-fixers", "Immersive Fixers", "任务", "cet", true, {
      version: "1.6.5",
      author: "Dez",
      description:
        "让中间人委托更有存在感：短信延迟、地区限定与更自然的报酬曲线。需要 CET。",
      sizeBytes: 3_900_000,
      fileCount: 14,
      installedAt: iso(4),
      modFolder: "ImmersiveFixers",
      hasCet: true,
      deployedFiles: [
        deployed("mod-fixers", "bin/x64/plugins/cyber_engine_tweaks/mods/ImmersiveFixers/init.lua"),
      ],
    }),
    baseMod("mod-handling", "Better Vehicle Handling", "玩法", "redmod", false, {
      version: "0.9.4",
      author: "Dex",
      description: "重新调校所有车辆的抓地力、悬挂和刹车，保留原版手感但减少漂移。",
      sizeBytes: 1_200_000,
      fileCount: 6,
      installedAt: iso(3),
      modFolder: "BetterVehicleHandling",
      hasRedmod: true,
    }),
    baseMod("mod-radio", "Radio Extender", "音频", "cet", true, {
      version: "2.2.0",
      author: "Ula",
      description: "向游戏内电台添加自定义曲目与新频道，支持热切换。",
      sizeBytes: 8_800_000,
      fileCount: 22,
      installedAt: iso(2),
      modFolder: "RadioExtender",
      hasCet: true,
      deployedFiles: [
        deployed("mod-radio", "bin/x64/plugins/cyber_engine_tweaks/mods/RadioExtender/init.lua"),
      ],
    }),
    baseMod("mod-photomode", "Photo Mode Unlocker", "工具", "redscript", false, {
      version: "1.4.0",
      author: "Nova",
      description: "解锁拍照模式的相机距离、时间与 NPC 姿势限制。",
      sizeBytes: 780_000,
      fileCount: 2,
      installedAt: iso(6),
      modFolder: "PhotoModeUnlocker",
      hasRedmod: false,
      hasArchive: false,
      deployedFiles: [],
    }),
    baseMod("mod-dogtown", "Dogtown Vibes", "视觉", "archive", false, {
      version: "1.0.3",
      author: "Barghest",
      description: "为狗镇增加沙尘、警示灯与更密集的空中交通。",
      sizeBytes: 91_000_000,
      fileCount: 2,
      installedAt: iso(1),
      hasArchive: true,
    }),
    baseMod("mod-hardcore", "Hardcore 2077", "玩法", "redmod", false, {
      version: "0.7.1",
      author: "Blackwall",
      description: "重做伤害、护甲与治疗物品，让战斗回到高风险节奏。",
      sizeBytes: 6_100_000,
      fileCount: 11,
      installedAt: iso(1),
      modFolder: "Hardcore2077",
      hasRedmod: true,
    }),
    baseMod("mod-cyberdeck", "Arasaka Cyberdeck", "武器", "archive", false, {
      version: "1.2.0",
      author: "Hanako",
      description: "新增三款高层级网络接入仓与快速破解组合。",
      sizeBytes: 22_000_000,
      fileCount: 1,
      installedAt: iso(1),
      hasArchive: true,
    }),
  ];

  const loadOrder = [
    archivePath("zzz_relit_core"),
    archivePath("zzz_relit_lut"),
    archivePath("streetstyle_vol3"),
    archivePath("caliburn_blackout"),
    archivePath("zzz_relit_core"),
  ];

  const state: AppStateData = {
    schemaVersion: 1,
    gameDir: DEMO_GAME,
    stagingDir: `${DEMO_DATA}\\staging`,
    mods,
    loadOrder: [...new Set(loadOrder)],
    loadOrderPins: [],
    // 演示库里先给「按文件夹名」的默认顺序，调整之后才出现自定义顺序。
    redmodOrder: [],
    modpacks: [],
    profiles: [
      {
        id: "profile-default",
        name: "Default",
        enabledModIds: mods.filter((mod) => mod.enabled).map((mod) => mod.id),
        loadOrder: [...new Set(loadOrder)],
        createdAt: iso(30),
        updatedAt: iso(2),
        builtin: true,
      },
      {
        id: "profile-vanilla",
        name: "纯净模式",
        enabledModIds: mods.filter((mod) => mod.category === "框架").map((mod) => mod.id),
        loadOrder: [],
        createdAt: iso(12),
        updatedAt: iso(5),
        builtin: false,
      },
    ],
    activeProfileId: "profile-default",
    settings: { ...DEFAULT_SETTINGS },
    lastGameVersion: "2.31",
    lastLaunch: iso(1),
    backup: {
      id: "snapshot-20261015-214012",
      createdAt: iso(6),
      root: `${DEMO_DATA}\\backups\\snapshot-20261015-214012`,
      gameDir: DEMO_GAME,
      files: ["archive/pc/mod/modlist.txt", "r6/config/settings/UserSettings.json"],
    },
    lastUpdateCheck: iso(3),
  };
  return { state, gameDir: DEMO_GAME };
}

function loadDb(): DemoDb {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as DemoDb;
      if (parsed?.state?.mods) {
        parsed.state.settings = { ...DEFAULT_SETTINGS, ...parsed.state.settings };
        for (const mod of parsed.state.mods) {
          if (!mod.nexus) mod.nexus = null;
          // 手改过的演示状态可能把部署清单写成字符串：字符串可迭代，
          // 遍历后拿到的是单个字符，后面读 file.target 才炸，且炸点不在卡片里。
          // 结构不对就当没有部署记录，比让整个预览白屏合理。
          if (!Array.isArray(mod.deployedFiles)) mod.deployedFiles = [];
        }
        // 旧版本存下来的状态没有播放集字段，这里补一个默认集，
        // 否则设置页与顶栏会拿到 undefined 直接白屏。
        if (!Array.isArray(parsed.state.profiles) || parsed.state.profiles.length === 0) {
          parsed.state.loadOrderPins = parsed.state.loadOrderPins ?? [];
          const enabledIds = parsed.state.mods.filter((mod) => mod.enabled).map((mod) => mod.id);
          parsed.state.profiles = [
            {
              id: "profile-default",
              name: "Default",
              enabledModIds: enabledIds,
              loadOrder: [...parsed.state.loadOrder],
              createdAt: iso(30),
              updatedAt: iso(0),
              builtin: true,
            },
          ];
        }
        if (!parsed.state.activeProfileId) parsed.state.activeProfileId = parsed.state.profiles[0].id;
        return parsed;
      }
    }
  } catch {
    // Corrupt demo storage should never block the preview.
  }
  const fresh = createInitial();
  saveDb(fresh);
  return fresh;
}

/** 演示用的两套配置：任何入口调用前都先补一次，避免"某个页面先存了别的东西"导致列表丢失。 */
function ensureMockProfiles(db: DemoDb): void {
  if (db.state.settings.aiProfiles && db.state.settings.aiProfiles.length > 0) {
    if (!db.state.settings.activeAiProfileId) {
      db.state.settings.activeAiProfileId = db.state.settings.aiProfiles[0].id;
    }
    return;
  }
  db.state.settings.aiProfiles = [
    {
      id: "default",
      name: "默认配置",
      vendor: "openai",
      baseUrl: db.state.settings.aiBaseUrl,
      model: db.state.settings.aiModel,
      protocol: db.state.settings.aiProtocol,
    },
    {
      id: "p-local",
      name: "本地 Ollama",
      vendor: "ollama",
      baseUrl: "http://127.0.0.1:11434/v1",
      model: "qwen3:8b",
      protocol: "openai",
    },
  ];
  db.state.settings.activeAiProfileId = "default";
}

/** 把演示状态拼成配置列表（hasKey/active 两个只读标记在这里算）。 */
function mockProfileList(db: DemoDb, activeId: string): AiProfileList {
  const list = db.state.settings.aiProfiles ?? [];
  const defaultHasKey = db.state.settings.aiKeyStored !== false;
  return {
    profiles: list.map((item) => ({
      profile: item,
      hasKey: item.id === "default" ? defaultHasKey : true,
      active: item.id === activeId,
    })),
    activeId,
  };
}

function saveDb(db: DemoDb): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
  } catch {
    // Ignore quota errors in the browser preview.
  }
}

function getGame(db: DemoDb): GameInfo | null {
  if (!db.gameDir) return null;
  // 演示版本固定 2.31：和「上次确认版本」不一致时就当作游戏更新过，用来演示熔断横幅。
  const version = "2.31";
  const last = db.state.lastGameVersion ?? null;
  return {
    root: db.gameDir,
    exePath: `${db.gameDir}\\bin\\x64\\Cyberpunk2077.exe`,
    version,
    source: "steam",
    valid: true,
    archiveDir: `${db.gameDir}\\archive\\pc\\mod`,
    modsDir: `${db.gameDir}\\mods`,
    language: "zh-cn",
    gameUpdated: Boolean(last) && last !== version,
    lastGameVersion: last,
  };
}

function conflictsOf(state: AppStateData): ConflictInfo[] {
  const claims = new Map<string, ModEntry[]>();
  for (const mod of state.mods.filter((entry) => entry.enabled)) {
    for (const file of mod.deployedFiles) {
      const key = file.relativePath.toLowerCase();
      claims.set(key, [...(claims.get(key) ?? []), mod]);
    }
  }
  const conflicts: ConflictInfo[] = [];
  for (const [target, mods] of claims) {
    if (mods.length < 2) continue;
    const first = mods[0];
    for (const other of mods.filter((entry) => entry.id !== first.id)) {
      conflicts.push({
        target,
        modId: first.id,
        modName: first.name,
        otherModId: other.id,
        otherModName: other.name,
        kind: "managed",
        pending: false,
      });
    }
  }
  return conflicts;
}

function buildLoadOrder(state: AppStateData): LoadOrderView {
  const archives: Array<{ mod: ModEntry; path: string }> = [];
  for (const mod of state.mods.filter((entry) => entry.enabled)) {
    for (const file of mod.deployedFiles) {
      if (file.relativePath.toLowerCase().endsWith(".archive")) {
        archives.push({ mod, path: file.relativePath });
      }
    }
  }
  const lower = new Map(archives.map((item) => [item.path.toLowerCase(), item]));
  const ordered: typeof archives = [];
  const seen = new Set<string>();
  for (const path of state.loadOrder) {
    const found = lower.get(path.toLowerCase());
    if (found && !seen.has(found.path.toLowerCase())) {
      ordered.push(found);
      seen.add(found.path.toLowerCase());
    }
  }
  for (const item of [...archives].sort((a, b) => a.path.localeCompare(b.path))) {
    if (!seen.has(item.path.toLowerCase())) ordered.push(item);
  }

  // REDmod 顺序：redmodOrder 里登记过的按登记顺序在前，其余按文件夹名补后。
  const redmodById = new Map(
    state.mods.filter((entry) => entry.enabled && entry.layout === "redmod").map((mod) => [mod.id, mod]),
  );
  const redmodSeq: ModEntry[] = [];
  for (const id of state.redmodOrder ?? []) {
    const found = redmodById.get(id);
    if (found) {
      redmodSeq.push(found);
      redmodById.delete(id);
    }
  }
  const redmodRest = [...redmodById.values()].sort((a, b) =>
    (a.modFolder ?? a.name).localeCompare(b.modFolder ?? b.name),
  );
  const redmods = [...redmodSeq, ...redmodRest].map((mod, index) => ({
    id: `redmod:${mod.id}`,
    modId: mod.id,
    modName: mod.name,
    filename: mod.modFolder ?? mod.name,
    category: mod.category,
    deployed: true,
    order: index,
  }));

  return {
    archives: ordered.map((item, index) => ({
      id: item.path,
      modId: item.mod.id,
      modName: item.mod.name,
      filename: item.path.split("/").pop() ?? item.path,
      category: item.mod.category,
      deployed: true,
      order: index,
    })),
    redmods,
    modlistPath: state.gameDir ? `${state.gameDir}\\archive\\pc\\mod\\modlist.txt` : null,
    warnings: [],
    modlistExists: state.settings.writeModlist,
    managedModlist: state.settings.writeModlist,
  };
}

function snapshot(db: DemoDb): Snapshot {
  return {
    state: structuredClone(db.state),
    game: getGame(db),
    loadOrder: buildLoadOrder(db.state),
    conflicts: conflictsOf(db.state),
    demoMode: true,
    // 浏览器预览里造不出"状态文件损坏"，用 ?recovered=<path> 把它显式打开，
    // 供 check-state-recovery.mjs 断言那条红条真的会出现在界面顶部。
    stateRecoveredFrom: new URLSearchParams(window.location.search).get("recovered"),
  };
}

function refreshLoadOrder(db: DemoDb): void {
  const view = buildLoadOrder(db.state);
  db.state.loadOrder = view.archives.map((item) => item.id);
}

function updateDeployment(mod: ModEntry, enabled: boolean): void {
  mod.enabled = enabled;
  if (!enabled) {
    mod.deployedFiles = [];
    return;
  }
  if (mod.deployedFiles.length > 0) return;
  const folder = mod.modFolder ?? mod.name.replace(/[^a-zA-Z0-9 _-]/g, "").trim() ?? "mod";
  if (mod.layout === "archive") {
    mod.deployedFiles = [
      deployed(mod.id, archivePath(mod.name.toLowerCase().replace(/[^a-z0-9]+/g, "_"))),
      deployed(mod.id, `archive/pc/mod/${mod.id}.xl`, 1),
    ];
  } else if (mod.layout === "redmod") {
    mod.deployedFiles = [
      deployed(mod.id, `mods/${folder}/info.json`),
      deployed(mod.id, `mods/${folder}/archives/${folder}.archive`, 1),
    ];
  } else if (mod.layout === "cet") {
    mod.deployedFiles = [
      deployed(mod.id, `bin/x64/plugins/cyber_engine_tweaks/mods/${folder}/init.lua`),
    ];
  } else if (mod.layout === "redscript") {
    mod.deployedFiles = [deployed(mod.id, `r6/scripts/${folder}/main.reds`)];
  } else {
    mod.deployedFiles = [deployed(mod.id, `archive/pc/mod/${folder}.archive`)];
  }
}

function frameworkList(): FrameworkStatus[] {
  const root = DEMO_GAME;
  const simulateMissing =
    typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).get("frameworks") === "missing";
  const list: FrameworkStatus[] = [
    {
      id: "red4ext",
      name: "RED4ext",
      installed: true,
      required: false,
      path: `${root}\\red4ext\\RED4ext.dll`,
      version: "1.27.0",
      note: "多数现代框架的运行基础",
    },
    {
      id: "cet",
      name: "Cyber Engine Tweaks",
      installed: true,
      required: false,
      path: `${root}\\bin\\x64\\plugins\\cyber_engine_tweaks\\cyber_engine_tweaks.dll`,
      version: "1.36.1",
      note: "CET 控制台 / Lua 模组运行时",
    },
    {
      id: "redscript",
      name: "redscript",
      installed: true,
      required: false,
      path: `${root}\\r6\\scripts`,
      version: null,
      note: "编译 r6/scripts 下的 .reds 脚本",
    },
    {
      id: "archivexl",
      name: "ArchiveXL",
      installed: true,
      required: false,
      path: `${root}\\red4ext\\plugins\\ArchiveXL\\ArchiveXL.dll`,
      version: "1.23.4",
      note: "扩展 archive 加载能力（需 RED4ext）",
    },
    {
      id: "tweakxl",
      name: "TweakXL",
      installed: true,
      required: false,
      path: `${root}\\red4ext\\plugins\\TweakXL\\TweakXL.dll`,
      version: "1.12.2",
      note: "TweakDB 修改支持（需 RED4ext）",
    },
    {
      id: "codeware",
      name: "Codeware",
      installed: false,
      required: false,
      path: `${root}\\red4ext\\plugins\\Codeware\\Codeware.dll`,
      version: null,
      note: "许多功能模组依赖的脚本库",
    },
    {
      id: "modsettings",
      name: "Mod Settings",
      installed: true,
      required: false,
      path: `${root}\\red4ext\\plugins\\mod_settings\\ModSettings.dll`,
      version: "1.4.1",
      note: "模组统一设置菜单（RED4ext 版或 CET 版）",
    },
  ];
  return simulateMissing
    ? list.map((framework) => ({ ...framework, installed: false, version: null }))
    : list;
}

function diagnosticsOf(db: DemoDb): DiagnosticsReport {
  const conflicts = conflictsOf(db.state);
  const enabled = db.state.mods.filter((mod) => mod.enabled).length;
  const frameworks = frameworkList();
  const issues: DiagnosticIssue[] = [];
  if (conflicts.length > 0) {
    issues.push({
      id: "file-conflicts",
      severity: "error",
      title: `发现 ${conflicts.length} 个文件级冲突`,
      detail:
        "CyberDeck ReLIT 与 Neon Rain ReShade 声明了同一个目标文件。游戏只让先加载的版本生效，禁用其中一个。",
      action: "loadorder",
    });
  }
  issues.push({
    id: "unmanaged-archives",
    severity: "info",
    title: "2 个 archive 不是本启动器部署的",
    detail:
      "archive/pc/mod 里有两个手动放入的 archive。游戏会正常加载它们，但启动器无法安全卸载。",
    action: null,
  });
  if (!db.state.backup) {
    issues.push({
      id: "no-backup",
      severity: "warning",
      title: "有部署，但没有配置备份",
      detail: "建议运行一次「创建备份」，这样恢复原始状态时能还原 r6/config 和 modlist.txt。",
      action: "backup",
    });
  }
  const hasError = issues.some((issue) => issue.severity === "error");
  // 之前只看 hasError：明明有 warning，结论还说「环境状态良好」，跟横幅文案对不上。
  const warningCount = issues.filter((issue) => issue.severity === "warning").length;
  return {
    generatedAt: new Date().toISOString(),
    game: getGame(db),
    frameworks,
    issues,
    summary: hasError
      ? "发现需要处理的问题。先修红色的，再启动游戏。"
      : warningCount > 0
        ? `可以启动，但有 ${warningCount} 个警告值得看一眼。`
        : "环境状态良好，可以启动游戏。",
    summaryLevel: hasError ? "error" : warningCount > 0 ? "warning" : "ok",
    deployedMods: db.state.mods.filter((mod) => mod.deployedFiles.length > 0).length,
    enabledMods: enabled,
    totalMods: db.state.mods.length,
    conflictCount: conflicts.length,
    dependencies: dependenciesOf(db.state.mods, frameworks),
    logPaths: [
      `${DEMO_GAME}\\r6\\logs`,
      `${DEMO_GAME}\\red4ext\\logs`,
      `${DEMO_GAME}\\bin\\x64\\plugins\\cyber_engine_tweaks\\cyber_engine_tweaks.log`,
    ],
    backup: db.state.backup,
  };
}

/**
 * 演示模式的依赖报告：结构与 Rust 端 `deps.rs::DependencyReport` 保持一致，
 * 这样诊断页/卡片/详情页在演示模式下也能跑到同一条分支。
 */
function dependenciesOf(
  mods: ModEntry[],
  frameworks: FrameworkStatus[],
): DependencyReport {
  const installed = new Map(frameworks.map((item) => [item.id, item]));
  const modsReport = mods
    .map((mod) => {
      const files = mod.plannedFiles.map((path) => path.replace(/\\/g, "/").toLowerCase());
      const wanted = new Map<string, string>();
      if (files.some((path) => /\.xlp?$/.test(path))) wanted.set("archivexl", "包含 .xl 归档声明文件");
      if (files.some((path) => path.endsWith(".reds"))) wanted.set("redscript", "包含 .reds 脚本");
      if (files.some((path) => path.endsWith(".tweak"))) wanted.set("tweakxl", "包含 .tweak 数据补丁");
      if (mod.layout === "cet") wanted.set("cet", "CET 布局的 Lua 模组");
      const requirements = [...wanted.entries()].map(([id, detail]) => {
        const status = installed.get(id);
        const satisfied = status?.installed ?? false;
        return {
          id,
          name: status?.name ?? id,
          source: "fileRule",
          detail,
          satisfied,
          satisfiedBy: satisfied ? "game" : null,
          requiredVersion: null,
          installedVersion: status?.version ?? null,
          versionOk: true,
        };
      });
      const missing = requirements.filter((item) => !item.satisfied).map((item) => item.name);
      const status = missing.length > 0 ? "missing" : "healthy";
      return {
        modId: mod.id,
        modName: mod.name,
        enabled: mod.enabled,
        status: status as "missing" | "healthy",
        requirements,
        missing,
      };
    })
    .filter((item) => item.requirements.length > 0);
  return {
    checkedAt: new Date().toISOString(),
    mods: modsReport,
    missingEnabled: modsReport.filter((item) => item.enabled && item.status === "missing").length,
    mismatchEnabled: 0,
    checkedMods: modsReport.length,
  };
}

function demoNexusMods(): NexusModSummary[] {
  return [
    {
      modId: 7712,
      name: "CyberDeck ReLIT",
      summary: "重做夜间光照、湿地面反射与霓虹溢出。",
      author: "Skyline",
      version: "2.4.0",
      category: "Visuals",
      pictureUrl: null,
      modPageUrl: "https://www.nexusmods.com/cyberpunk2077/mods/7712",
      downloads: 184_221,
      endorsements: 8_412,
      adult: false,
      updatedTime: iso(3),
      createdTime: iso(300),
    },
    {
      modId: 6401,
      name: "Street Style Vol. 3",
      summary: "42 套街头服装，通过游戏内衣柜解锁。",
      author: "Kala",
      version: "3.0.2",
      category: "Clothing",
      pictureUrl: null,
      modPageUrl: "https://www.nexusmods.com/cyberpunk2077/mods/6401",
      downloads: 96_480,
      endorsements: 4_022,
      adult: false,
      updatedTime: iso(9),
      createdTime: iso(210),
    },
    {
      modId: 5520,
      name: "Better Vehicle Handling",
      summary: "重新调校所有车辆的抓地力、悬挂和刹车。",
      author: "Dex",
      version: "0.9.4",
      category: "Gameplay",
      pictureUrl: null,
      modPageUrl: "https://www.nexusmods.com/cyberpunk2077/mods/5520",
      downloads: 64_112,
      endorsements: 2_880,
      adult: false,
      updatedTime: iso(15),
      createdTime: iso(400),
    },
  ];
}

function reportFor(mod: ModEntry, warnings: string[] = []): DeployReport {
  return {
    modEntry: structuredClone(mod),
    deployed: mod.deployedFiles.length,
    hardLinks: mod.deployedFiles.length,
    symlinks: 0,
    copies: 0,
    warnings,
  };
}

/**
 * 演示库里认识的 Mod 名 → 中文，模仿 AI 返回结果。
 *
 * 框架名（RED4ext / Cyber Engine Tweaks / ArchiveXL …）故意不收录：
 * 真实后端有框架黑名单，演示模式保持同样语义，别让人以为框架也会被翻。
 */
const MOCK_TRANSLATIONS: Record<string, string> = {
  "CyberDeck ReLIT": "夜之城重燃",
  "Neon Rain ReShade": "霓虹雨画质",
  "Street Style Vol. 3": "街头风潮 第三辑",
  "Cyberarms — Chrome Collection": "赛博义肢·镀铬收藏",
  "Rayfield Caliburn — Blackout": "雷菲尔德·卡利本·暗夜版",
  "Better Vehicle Handling": "更顺手的车辆操控",
  "Dogtown Vibes": "狗镇氛围",
  "Hardcore 2077": "硬核 2077",
  "Immersive Fixers": "沉浸式中间人",
  "AraSaka Cyberdeck": "荒坂网络仓",
};

// ── 下载中心 mock 队列（r13）─────────────────────────────────────
// 浏览器预览 / UI 回归没有 Rust 后端，这里用内存队列 + 定时器把交互跑通。
const mockTools = {
  entries: [
    {
      id: "tool-demo-wolvenkit",
      name: "WolvenKit",
      path: "D:\\Tools\\WolvenKit\\WolvenKit.CLI.exe",
      icon: null,
      pinned: true,
      createdAt: "2026-10-01T10:00:00.000Z",
    },
    {
      id: "tool-demo-rar",
      name: "RAR 解压",
      path: "D:\\Tools\\WinRAR\\WinRAR.exe",
      icon: null,
      pinned: false,
      createdAt: "2026-10-02T10:00:00.000Z",
    },
  ] as ExternalToolEntry[],
};

const mockQueue = {
  tasks: [] as DownloadTask[],
  settings: { concurrency: 2, autoImport: true, dir: null, proxy: null, speedLimitMbps: 0 } as DownloadQueueSettings,
  timers: new Map<string, number>(),
  run(id: string) {
    const task = this.tasks.find((item) => item.id === id);
    if (!task || this.timers.has(id)) return;
    task.status = "downloading";
    this.timers.set(
      id,
      window.setInterval(() => {
        task.received += 2_400_000;
        if (task.total && task.received >= task.total) {
          task.received = task.total;
          task.status = "completed";
          task.finishedAt = Math.floor(Date.now() / 1000);
          this.stop(id);
        }
      }, 300),
    );
  },
  stop(id: string) {
    const timer = this.timers.get(id);
    if (timer !== undefined) {
      window.clearInterval(timer);
      this.timers.delete(id);
    }
  },
};

// 调试 / UI 回归入口：浏览器预览模式下允许控制台或测试脚本直接驱动 mock 队列。
// 只在非 Tauri 环境有意义；打包产物走 Rust 后端，这个引用不会被触发。
// 注意必须挂「函数」而不是队列对象——页面里动态 import 会拿到另一个模块实例。
if (typeof window !== "undefined") {
  (window as unknown as { __mockQueue?: typeof mockQueue }).__mockQueue = mockQueue;
  (window as unknown as { __mockQueueAdd?: typeof mockApi.downloadQueueAdd }).__mockQueueAdd =
    (...args: Parameters<typeof mockApi.downloadQueueAdd>) => mockApi.downloadQueueAdd(...args);
}

export const mockApi = {

  /** 演示模式标记（真实侧为 !isTauri）。 */
  isDemo: true,

  async bootstrap(): Promise<Snapshot> {
    await sleep(260);
    return snapshot(loadDb());
  },

  async refreshGame(): Promise<Snapshot> {
    await sleep(180);
    return snapshot(loadDb());
  },

  async detectGamePath(): Promise<GameInfo | null> {
    await sleep(400);
    return getGame({ ...createInitial(), gameDir: DEMO_GAME });
  },

  async setGameDir(path: string): Promise<Snapshot> {
    await sleep(220);
    const db = loadDb();
    db.gameDir = path;
    db.state.gameDir = path;
    saveDb(db);
    return snapshot(db);
  },

  async clearGameDir(): Promise<Snapshot> {
    await sleep(150);
    const db = loadDb();
    db.gameDir = null;
    db.state.gameDir = null;
    saveDb(db);
    return snapshot(db);
  },

  /** 演示模式没有真实 exe，直接把已确认版本对齐到演示版本。 */
  async clearUpdateLock(): Promise<Snapshot> {
    await sleep(160);
    const db = loadDb();
    db.state.lastGameVersion = "2.31";
    saveDb(db);
    return snapshot(db);
  },

  /** 演示模式：按部署清单编一组体检结果，稳定复现三种健康度。 */
  // ── 播放集（演示模式：纯内存状态机，行为与后端一致）────────────

  async listProfiles(): Promise<ProfileList> {
    const db = loadDb();
    return { profiles: db.state.profiles, activeProfileId: db.state.activeProfileId };
  },

  async switchProfile(profileId: string): Promise<SwitchProfileReport> {
    await sleep(320);
    const db = loadDb();
    const profile = db.state.profiles.find((item) => item.id === profileId);
    if (!profile) throw new Error("播放集不存在");

    // 先按当前激活集合撤销部署，再按目标集合重新部署。
    let undeployed = 0;
    let deployed = 0;
    for (const mod of db.state.mods) {
      if (mod.enabled) {
        updateDeployment(mod, false);
        undeployed += 1;
      }
    }
    db.state.activeProfileId = profile.id;
    db.state.loadOrder = [...profile.loadOrder];
    for (const mod of db.state.mods) {
      const wanted = profile.enabledModIds.includes(mod.id);
      updateDeployment(mod, wanted);
      if (wanted) deployed += 1;
    }
    saveDb(db);
    return {
      profile,
      undeployed,
      deployed,
      warnings: profile.loadOrder.length === 0 ? ["这套播放集还没有加载顺序，已按默认排序。"] : [],
    };
  },

  async saveProfileState(profileId: string): Promise<ProfileList> {
    await sleep(120);
    const db = loadDb();
    const profile = db.state.profiles.find((item) => item.id === profileId);
    if (!profile) throw new Error("播放集不存在");
    profile.enabledModIds = db.state.mods.filter((mod) => mod.enabled).map((mod) => mod.id);
    profile.loadOrder = [...db.state.loadOrder];
    profile.updatedAt = iso(0);
    saveDb(db);
    return { profiles: db.state.profiles, activeProfileId: db.state.activeProfileId };
  },

  async createProfile(name: string, copyCurrent: boolean): Promise<ProfileList> {
    await sleep(150);
    const db = loadDb();
    db.state.profiles.push({
      id: `profile-${Date.now().toString(36)}`,
      name: name.trim() || "未命名播放集",
      enabledModIds: copyCurrent ? db.state.mods.filter((mod) => mod.enabled).map((mod) => mod.id) : [],
      loadOrder: copyCurrent ? [...db.state.loadOrder] : [],
      createdAt: iso(0),
      updatedAt: iso(0),
      builtin: false,
    });
    saveDb(db);
    return { profiles: db.state.profiles, activeProfileId: db.state.activeProfileId };
  },

  async renameProfile(profileId: string, name: string): Promise<ProfileList> {
    await sleep(120);
    const db = loadDb();
    const profile = db.state.profiles.find((item) => item.id === profileId);
    if (!profile) throw new Error("播放集不存在");
    if (profile.builtin) throw new Error("内置播放集不能改名");
    profile.name = name.trim() || profile.name;
    profile.updatedAt = iso(0);
    saveDb(db);
    return { profiles: db.state.profiles, activeProfileId: db.state.activeProfileId };
  },

  async deleteProfile(profileId: string): Promise<ProfileList> {
    await sleep(120);
    const db = loadDb();
    const profile = db.state.profiles.find((item) => item.id === profileId);
    if (!profile) throw new Error("播放集不存在");
    if (profile.builtin) throw new Error("内置播放集不能删除");
    if (db.state.activeProfileId === profileId) throw new Error("正在使用的播放集不能删除");
    db.state.profiles = db.state.profiles.filter((item) => item.id !== profileId);
    saveDb(db);
    return { profiles: db.state.profiles, activeProfileId: db.state.activeProfileId };
  },

  async duplicateProfile(profileId: string, name: string): Promise<ProfileList> {
    await sleep(150);
    const db = loadDb();
    const source = db.state.profiles.find((item) => item.id === profileId);
    if (!source) throw new Error("播放集不存在");
    db.state.profiles.push({
      ...source,
      id: `profile-${Date.now().toString(36)}`,
      name: name.trim() || `${source.name} 副本`,
      enabledModIds: [...source.enabledModIds],
      loadOrder: [...source.loadOrder],
      createdAt: iso(0),
      updatedAt: iso(0),
      builtin: false,
    });
    saveDb(db);
    return { profiles: db.state.profiles, activeProfileId: db.state.activeProfileId };
  },

  async exportProfileModlist(profileId: string): Promise<string> {
    await sleep(200);
    const db = loadDb();
    const source = db.state.profiles.find((item) => item.id === profileId);
    if (!source) throw new Error("播放集不存在");
    return `C:////demo////exports////播放集-${source.name}.json`;
  },

  async importProfileModlist(path: string, name?: string): Promise<ProfileImportReport> {
    await sleep(260);
    if (!path.trim().endsWith(".json")) throw new Error("不是有效的播放集导出文件");
    const db = loadDb();
    const all = db.state.mods.map((mod) => mod.id);
    // 演示：对上半数模组，其余算没对上，让 UI 有东西可展示。
    const matched = all.slice(0, Math.max(1, Math.ceil(all.length / 2)));
    const unmatched = all.slice(matched.length).map((id) => `${id} (demo)`);
    const profileName = (name?.trim() || "导入的播放集") + " " + iso(0).slice(0, 10);
    db.state.profiles.push({
      id: `profile-${Date.now().toString(36)}`,
      name: profileName,
      enabledModIds: matched,
      loadOrder: [],
      createdAt: iso(0),
      updatedAt: iso(0),
      builtin: false,
    });
    saveDb(db);
    return {
      profileName,
      matched: matched.length,
      unmatched,
      list: { profiles: db.state.profiles, activeProfileId: db.state.activeProfileId },
    };
  },

  async setModsEnabled(ids: string[], enabled: boolean): Promise<BatchEnableReport> {
    await sleep(300);
    const db = loadDb();
    const warnings: string[] = [];
    const failed: string[] = [];
    let changed = 0;
    for (const id of ids) {
      const mod = db.state.mods.find((item) => item.id === id);
      if (!mod) {
        failed.push(id);
        warnings.push(`${id}：模组不存在`);
        continue;
      }
      mod.enabled = enabled;
      changed += 1;
    }
    saveDb(db);
    return { changed, failed, warnings };
  },
  // ── 既有模组收编（演示模式：内存状态机，行为与后端一致）──────

  /** 演示库永远有两个「Vortex 部署」的候选：一个可收编、一个已被托管。 */
  async adoptScan(): Promise<AdoptScanReport> {
    await sleep(420);
    const hair: AdoptCandidate = {
      id: "adopt-00000000000000a1",
      name: "vortex_hair_collection",
      archiveRel: "archive/pc/mod/vortex_hair_collection.archive",
      files: [
        { rel: "archive/pc/mod/vortex_hair_collection.archive", sizeBytes: 48_000_000, modifiedTime: null },
        { rel: "archive/pc/mod/vortex_hair_collection.xl", sizeBytes: 1_240, modifiedTime: null },
      ],
      sizeBytes: 48_001_240,
      linkType: "hardLink",
      alreadyManaged: false,
    };
    const texture: AdoptCandidate = {
      id: "adopt-00000000000000b2",
      name: "old_texture_pack",
      archiveRel: "archive/pc/mod/old_texture_pack.archive",
      files: [
        { rel: "archive/pc/mod/old_texture_pack.archive", sizeBytes: 126_400_000, modifiedTime: null },
      ],
      sizeBytes: 126_400_000,
      linkType: "copy",
      alreadyManaged: true,
    };
    const candidates = [texture, hair];
    return {
      candidates,
      totalBytes: candidates.reduce((sum, item) => sum + item.sizeBytes, 0),
      copyBytes: candidates
        .filter((item) => item.linkType === "copy")
        .reduce((sum, item) => sum + item.sizeBytes, 0),
      crossVolume: false,
      archiveDir: `${DEMO_GAME}\\archive\\pc\\mod`,
    };
  },

  /** 演示模式逐个「收编」：已托管跳过，其余登记成 origin=adopted 的启用模组。 */
  async adoptExecute(selected: AdoptCandidate[]): Promise<AdoptReport> {
    const report = await this.adoptScan();
    const known = new Map(report.candidates.map((item) => [item.id, item]));
    const db = loadDb();
    const outcomes: AdoptReport["outcomes"] = [];
    const mods: ModEntry[] = [];
    let adopted = 0;
    let failed = 0;
    let skipped = 0;

    for (const wanted of selected) {
      const candidate = known.get(wanted.id);
      await sleep(240);
      if (!candidate) {
        failed += 1;
        outcomes.push({
          id: wanted.id,
          name: wanted.name,
          adopted: false,
          error: { code: "ADOPT_STAGING_FAILED", message: "演示库里没有这个候选。" },
        });
        continue;
      }
      if (candidate.alreadyManaged) {
        skipped += 1;
        outcomes.push({
          id: candidate.id,
          name: candidate.name,
          adopted: false,
          error: { code: "ADOPT_ALREADY_MANAGED", message: "这个模组已经被启动器托管，无需收编。" },
        });
        continue;
      }
      const mod = baseMod(
        candidate.id,
        candidate.name,
        "其他",
        "archive",
        true,
        {
          description: "由外部工具（如 Vortex）部署、经「收编」纳入启动器管理。",
          installedAt: new Date().toISOString(),
          sizeBytes: candidate.sizeBytes,
          fileCount: candidate.files.length,
          metadataSource: "adopted",
          plannedFiles: candidate.files.map((file) => file.rel),
          hasArchive: true,
          origin: "adopted",
          stagingPath: `${DEMO_DATA}\\staging\\${candidate.id}`,
          deployedFiles: candidate.files.map((file) => ({
            source: `${DEMO_DATA}\\staging\\${candidate.id}\\${file.rel.split("/").pop()}`,
            target: `${DEMO_GAME}\\${file.rel.replaceAll("/", "\\")}`,
            linkType: candidate.linkType,
            relativePath: file.rel,
          })),
        },
      );
      if (!db.state.mods.some((item) => item.id === mod.id)) db.state.mods.push(mod);
      mods.push(structuredClone(mod));
      adopted += 1;
      outcomes.push({ id: candidate.id, name: candidate.name, adopted: true, error: null });
    }
    if (adopted > 0) {
      refreshLoadOrder(db);
      saveDb(db);
    }
    return { adopted, failed, skipped, cancelled: false, outcomes, mods };
  },

  /** 演示模式没有执行循环，取消只是返回 false。 */
  async adoptCancel(): Promise<boolean> {
    await sleep(80);
    return false;
  },

  /** 演示模式不读取真实 Vortex 状态库。 */
  async vortexTakeoverPreflight(): Promise<VortexTakeoverPreflight> {
    await sleep(120);
    return {
      available: false,
      dbLocked: false,
      reason: "演示模式不读取真实 Vortex 状态库",
      stateDir: "",
      activeProfileId: "",
      profileGameId: "",
      profileOk: false,
      vortexModCount: 0,
      vortexEnabledCount: 0,
      vortexDisabledCount: 0,
      archiveOrder: [],
      redmodOrder: [],
      archiveOrderSame: true,
      mappedModCount: 0,
      unmappedModCount: 0,
      drift: [],
      fingerprint: "",
      warnings: [],
    };
  },

  async adoptStagingHealth(): Promise<AdoptStagingHealth> {
    await sleep(80);
    return {
      stagingDir: "",
      dirsTotal: 0,
      registeredTotal: 0,
      orphanDirs: [],
      missingDirs: [],
      orphanBytes: 0,
      warnings: [],
    };
  },

  async vortexTakeoverSetEnabled(enabled: boolean): Promise<boolean> {
    await sleep(80);
    return enabled;
  },

  async vortexSyncStatus(): Promise<VortexSyncStatus> {
    await sleep(80);
    return {
      takeoverEnabled: false,
      pendingCount: 0,
      backups: [],
      lastSync: { ok: false, written: 0, backup: "", reason: "演示模式未同步", warnings: [] },
    };
  },

  async vortexSyncRetry(): Promise<VortexSyncReport> {
    await sleep(80);
    return { ok: true, written: 0, backup: "", reason: "", warnings: ["演示模式无待同步变更"] };
  },

  async vortexSyncRestore(_name: string): Promise<number> {
    await sleep(80);
    return 0;
  },

  async vortexCoverage(): Promise<VortexCoverageReport> {
    await sleep(80);
    return {
      root: "D:////Vortex Mods////cyberpunk2077",
      total: 0,
      mapped: 0,
      unmapped: [],
      truncated: false,
    };
  },

  async vortexMappingRebuild(): Promise<VortexMappingReport> {
    await sleep(80);
    return { total: 0, mapped: 0, unmapped: 0, persisted: 0, cleared: 0, warnings: [] };
  },

  async vortexSyncFull(): Promise<VortexSyncReport> {
    await sleep(80);
    return { ok: true, written: 0, backup: "", reason: "", warnings: ["演示模式未同步"] };
  },

  async vortexReconcile(_strategy: string): Promise<VortexReconcileReport> {
    await sleep(80);
    return { strategy: "report", checked: 0, drift: [], applied: 0, warnings: [] };
  },

  async vortexPrelaunchCheck(): Promise<VortexPrelaunchReport> {
    await sleep(80);
    return {
      ready: false,
      takeoverEnabled: false,
      dbLocked: false,
      pendingCount: 0,
      driftCount: 0,
      warnings: ["演示模式不读取真实 Vortex 状态库"],
    };
  },

  async vortexRebuildPreview(): Promise<VortexRebuildPreview> {
    await sleep(80);
    return {
      available: false,
      reason: "演示模式不读取本机 Vortex 存储根",
      dataDir: "",
      vortexRoot: "",
      vortexDirs: 0,
      currentMods: 0,
      alreadyArchived: 0,
      toAdd: 0,
      toArchive: 0,
      enabledCount: 0,
      disabledCount: 0,
      withDescription: 0,
      withPicture: 0,
      withNexus: 0,
      metadataComplete: 0,
      mappingCoverage: "0/0",
      uncoveredArchives: [],
      dataSources: [],
      items: [],
      warnings: [],
    };
  },

  async vortexRebuildApply(): Promise<VortexRebuildReport> {
    await sleep(80);
    return {
      ok: false,
      reason: "演示模式不重建模组库",
      backupName: "",
      backupPath: "",
      reportPath: "",
      added: 0,
      archived: 0,
      mapping: 0,
      warnings: [],
    };
  },

  async vortexRebuildBackups(): Promise<string[]> {
    await sleep(40);
    return [];
  },

  async vortexRebuildRestore(_name: string): Promise<VortexRebuildReport> {
    await sleep(80);
    return {
      ok: false,
      reason: "演示模式不还原",
      backupName: "",
      backupPath: "",
      reportPath: "",
      added: 0,
      archived: 0,
      mapping: 0,
      warnings: [],
    };
  },

  /** 演示数据是手工构造的，不存在历史遗留的碎片条目。 */
  async adoptNormalize(): Promise<LibraryNormalizeReport> {
    await sleep(60);
    return { merged: 0, mergedNames: [], removed: [], empty: [] };
  },

  async diagnoseEnvironment(): Promise<EnvDiagnosis> {
    await sleep(90);
    const db = loadDb();
    const active = db.state.mods.filter((mod) => mod.enabled && mod.deployedFiles.length > 0);
    const checkedFiles = active.reduce((sum, mod) => sum + mod.deployedFiles.length, 0);
    const issues: EnvIssue[] = [];
    if (active.length > 0) {
      // 演示"轻微差异"这条路径：只有时间戳变化 → 灰色「提示」，不吓人。
      // （真丢文件的红色分支由 Rust 单测覆盖，演示里不必天天喊狼来了。）
      const victim = active[0];
      issues.push({
        modId: victim.id,
        modName: victim.name,
        relativePath: victim.deployedFiles[0]?.relativePath ?? "archive/pc/mod/preview.archive",
        kind: "time",
        detail: "文件的修改时间变了，可能被杀毒软件或外部工具碰过；不影响游戏加载。",
      });
    }
    const level = issues.some((issue) => issue.kind === "missing")
      ? "critical"
      : issues.some((issue) => issue.kind === "size")
        ? "warning"
        : issues.length > 0
          ? "info"
          : "healthy";
    return {
      level,
      checkedMods: active.length,
      checkedFiles,
      issues,
      summary:
        level === "critical"
          ? `${active.length} 个模组共 ${checkedFiles} 个文件，有 1 个文件丢失，建议立刻修复。`
          : level === "info"
            ? `${active.length} 个模组共 ${checkedFiles} 个文件，其中 ${issues.length} 个文件状态有变化，核心文件都在，游戏通常可正常运行。`
            : `${active.length} 个模组、${checkedFiles} 个文件全部正常。`,
    };
  },

  /** 演示模式：假装把缺失文件补回来了。 */
  async healEnvironment(): Promise<HealReport> {
    await sleep(320);
    return {
      repaired: 1,
      stillBroken: [],
      level: "healthy",
      message: "修复完成，重建了 1 个文件链接。",
    };
  },
  /** 演示模式没有真实文件系统，这里只做「已收到请求」的占位。 */
  async openInExplorer(path: string): Promise<void> {
    await sleep(120);
    console.info("[demo] open_in_explorer", path);
  },

  /** 演示模式：把该 Mod 的部署清单重置成初始状态，模拟一次重新部署。 */
  async repairMod(id: string): Promise<DeployReport> {
    await sleep(520);
    const db = loadDb();
    const mod = db.state.mods.find((item) => item.id === id);
    if (!mod) throw new Error("找不到这个模组。");
    mod.deployedFiles = [];
    updateDeployment(mod, true);
    saveDb(db);
    return {
      modEntry: mod,
      deployed: mod.deployedFiles.length,
      hardLinks: mod.deployedFiles.length,
      symlinks: 0,
      copies: 0,
      warnings: [],
    };
  },

  async installMods(paths: string[]): Promise<InstallOutcome[]> {
    await sleep(650);
    const db = loadDb();
    const outcomes: InstallOutcome[] = paths.map((path, index) => {
      const filename = path.split(/[\\/]/).pop() ?? `mod-${index}.zip`;
      const clean = filename.replace(/\.zip$/i, "").replace(/[_-]+/g, " ").trim();
      const mod = baseMod(
        `mod-import-${Date.now()}-${index}`,
        clean || "Imported Mod",
        "其他",
        "archive",
        false,
        {
          version: "1.0.0",
          author: "本地导入",
          description: `从 ${filename} 导入。部署前确认文件结构与游戏版本匹配。`,
          sourceZip: path,
          installedAt: new Date().toISOString(),
          deployedFiles: [],
          metadataSource: "filename",
          plannedFiles: [],
          hasArchive: true,
          sizeBytes: 32_000_000 + index * 4_000_000,
          fileCount: 2,
          warnings: [],
        },
      );
      const outcome: InstallOutcome = {
        path,
        success: true,
        modEntry: structuredClone(mod),
        error: null,
        errorCode: null,
      };
      // 必须真的入库：导入的模组要出现在模组库里、也要能被改分类
      // （ImportDialog 的「保存分类」按 modEntry.id 回写）。
      // 之前这里漏了 push，导入完刷新就消失，改分类还会报「找不到这个模组」。
      db.state.mods.push(mod);
      return outcome;
    });
    saveDb(db);
    return outcomes;
  },

  async gameProcessRunning(): Promise<boolean> {
    return false;
  },

  async stopGameProcess(): Promise<boolean> {
    await sleep(200);
    return false;
  },

  async setTranslationParent(id: string, parentId: string | null): Promise<Snapshot> {
    await sleep(120);
    const db = loadDb();
    const target = db.state.mods.find((mod) => mod.id === id);
    if (!target) throw new Error("找不到这个模组。");
    if (parentId !== null) {
      const parent = db.state.mods.find((mod) => mod.id === parentId);
      if (!parent) throw new Error("找不到要绑定的原版模组。");
      if (parentId === id) throw new Error("不能把模组绑定到自己身上。");
    }
    target.parentModId = parentId;
    if (parentId !== null) target.isTranslation = true;
    saveDb(db);
    return snapshot(db);
  },

  async setModEnabled(id: string, enabled: boolean): Promise<DeployReport> {
    await sleep(420);
    const db = loadDb();
    const mod = db.state.mods.find((entry) => entry.id === id);
    if (!mod) throw new Error("找不到这个模组。");
    updateDeployment(mod, enabled);
    refreshLoadOrder(db);
    saveDb(db);
    return reportFor(mod);
  },

  async switchModVersion(id: string): Promise<DeployReport> {
    await sleep(420);
    const db = loadDb();
    const target = db.state.mods.find((entry) => entry.id === id);
    if (!target) throw new Error("找不到这个模组。");
    const identity = (mod: (typeof db.state.mods)[number]) =>
      mod.nexus && mod.nexus.modId > 0
        ? `nexus:${mod.nexus.modId}`
        : `name:${mod.name.trim().toLowerCase()}`;
    const key = identity(target);
    for (const mod of db.state.mods) {
      if (mod.id !== id && !mod.parentModId && !mod.isTranslation && identity(mod) === key) {
        if (mod.enabled) updateDeployment(mod, false);
      }
    }
    if (!target.enabled) updateDeployment(target, true);
    refreshLoadOrder(db);
    saveDb(db);
    return reportFor(target);
  },

  async uninstallMod(id: string): Promise<void> {
    await sleep(380);
    const db = loadDb();
    db.state.mods = db.state.mods.filter((entry) => entry.id !== id);
    refreshLoadOrder(db);
    saveDb(db);
  },

  async updateMod(id: string, category?: string, name?: string): Promise<ModEntry> {
    await sleep(160);
    const db = loadDb();
    const mod = db.state.mods.find((entry) => entry.id === id);
    if (!mod) throw new Error("找不到这个模组。");
    if (category) mod.category = category;
    if (name) mod.name = name;
    saveDb(db);
    return structuredClone(mod);
  },

  async getLoadOrder(): Promise<LoadOrderView> {
    await sleep(120);
    return buildLoadOrder(loadDb().state);
  },

  /**
   * 演示模式的「一键整理」。
   *
   * 刻意只做「框架前置 + 其余保持现状」：浏览器预览里没有真实冲突数据和模型，
   * 装出「AI 排好了」的假象只会让人在真机上失望。
   */
  async suggestLoadOrder(ai = false): Promise<LoadOrderSuggestion> {
    await sleep(ai ? 900 : 220);
    const db = loadDb();
    const view = buildLoadOrder(db.state);
    const frameworks = new Set(
      db.state.mods.filter((mod) => mod.category === "框架").map((mod) => mod.id),
    );
    const ordered = [...view.archives].sort((left, right) => {
      const rank = (modId: string) => (frameworks.has(modId) ? 0 : 1);
      if (rank(left.modId) !== rank(right.modId)) return rank(left.modId) - rank(right.modId);
      return left.order - right.order;
    });
    const moves = ordered
      .map((item, index) => ({ id: item.id, from: item.order, to: index }))
      .filter((move) => move.from !== move.to);
    return {
      mode: ai ? "ai" : "rules",
      order: ordered.map((item) => item.id),
      moves,
      reasons: frameworks.size
        ? [
            {
              kind: "framework",
              note: `${frameworks.size} 个框架/核心 MOD 置于最前`,
              subjects: [],
            },
          ]
        : [],
      skipped: [],
      aiUsed: false,
      aiNote: ai ? "演示模式没有真实模型，以上为规则整理结果" : null,
      pendingConflicts: 0,
    };
  },

  async setLoadOrderPins(pins: string[]): Promise<LoadOrderView> {
    await sleep(140);
    const db = loadDb();
    db.state.loadOrderPins = pins;
    saveDb(db);
    return buildLoadOrder(db.state);
  },

  async saveLoadOrder(order: string[]): Promise<LoadOrderView> {
    await sleep(300);
    const db = loadDb();
    db.state.loadOrder = order;
    saveDb(db);
    return buildLoadOrder(db.state);
  },

  async saveRedmodOrder(order: string[]): Promise<LoadOrderView> {
    // 真实后端这里要跑 redMod 部署，浏览器预览里只模拟那点耗时。
    await sleep(700);
    const db = loadDb();
    db.state.redmodOrder = order;
    saveDb(db);
    return buildLoadOrder(db.state);
  },

  async exportModlist(): Promise<ModlistExport> {    await sleep(320);
    const db = loadDb();
    db.state.settings.writeModlist = true;
    saveDb(db);
    return {
      path: `${DEMO_GAME}\\archive\\pc\\mod\\modlist.txt`,
      backupPath: null,
    };
  },

  async removeModlist(): Promise<boolean> {
    await sleep(180);
    const db = loadDb();
    db.state.settings.writeModlist = false;
    saveDb(db);
    return true;
  },

  async setWriteModlist(enabled: boolean): Promise<LoadOrderView> {
    await sleep(260);
    const db = loadDb();
    db.state.settings.writeModlist = enabled;
    saveDb(db);
    return buildLoadOrder(db.state);
  },

  async setSettings(settings: Settings): Promise<Settings> {
    await sleep(180);
    const db = loadDb();
    db.state.settings = settings;
    saveDb(db);
    return settings;
  },

  async readBackgroundImage(path: string): Promise<BackgroundImage> {
    await sleep(120);
    // 浏览器演示模式没有真实文件：回一张内置的 SVG 渐变当「已选图」，路径仅作记录。
    if (!path.trim()) throw new Error("BACKGROUND_EMPTY");
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360">' +
      '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">' +
      '<stop offset="0" stop-color="#0e1420"/><stop offset="0.55" stop-color="#20304a"/>' +
      '<stop offset="1" stop-color="#fcee0a"/></linearGradient></defs>' +
      `<rect width="640" height="360" fill="url(#g)"/><text x="24" y="46" fill="#fcee0a" font-family="monospace" font-size="20">MOCK BACKGROUND</text></svg>`;
    return {
      dataUrl: `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`,
      size: svg.length,
      sourceSize: svg.length,
      compressed: false,
    };
  },

  async changeStagingDir(newDir: string): Promise<StagingMoveReport> {
    await sleep(420);
    const db = loadDb();
    const from = db.state.stagingDir;
    db.state.stagingDir = newDir;
    saveDb(db);
    return { from, to: newDir, moved: db.state.mods.length, failed: [] };
  },

  async detectTool(tool: "archive" | "wolvenkit"): Promise<ToolProbe> {
    await sleep(260);
    const path =
      tool === "archive"
        ? "C:\\Program Files\\7-Zip\\7z.exe"
        : "C:\\Users\\you\\.dotnet\\tools\\WolvenKit.Cli.exe";
    return { tool, found: true, path, message: "演示模式：示例路径" };
  },

  async getDiagnostics(): Promise<DiagnosticsReport> {
    await sleep(520);
    return diagnosticsOf(loadDb());
  },

  async createBackup(): Promise<BackupInfo> {
    await sleep(500);
    const db = loadDb();
    const backup = {
      id: `snapshot-${Date.now()}`,
      createdAt: new Date().toISOString(),
      root: `${DEMO_DATA}\\backups\\snapshot-${Date.now()}`,
      gameDir: db.gameDir ?? DEMO_GAME,
      files: ["archive/pc/mod/modlist.txt", "r6/config/settings/UserSettings.json"],
    };
    db.state.backup = backup;
    saveDb(db);
    return backup;
  },

  async restoreOriginal(): Promise<RestoreResult> {
    await sleep(700);
    const db = loadDb();
    let undeployed = 0;
    for (const mod of db.state.mods) {
      if (mod.deployedFiles.length > 0) {
        undeployed += 1;
        mod.enabled = false;
        mod.deployedFiles = [];
      }
    }
    db.state.loadOrder = [];
    saveDb(db);
    return {
      undeployed,
      restoredFiles: db.state.backup?.files.length ?? 0,
      warnings: [],
    };
  },

  async inspectLaunch(): Promise<LaunchCheck> {
    await sleep(120);
    return {
      platform: "steam",
      platformLabel: "Steam",
      exePresent: true,
      prelauncherPresent: true,
      drmClient: "steam.exe",
      drmClientRunning: true,
      steamAvailable: true,
      canDirect: true,
      reasons: [],
      notes: ["Steam 已在运行，DRM 前提满足。", "检测到 REDprelauncher.exe：直启会绕过它。"],
    };
  },

  // 演示里的 nxm 状态：先假装被 Vortex 占着，接管后就能看到「备份 + 交还」这条链路。
  async nxmStatus(): Promise<NxmStatus> {
    await sleep(60);
    return { ...mockNxm };
  },

  async nxmTakeover(): Promise<NxmStatus> {
    await sleep(160);
    mockNxm = {
      ours: true,
      registered: true,
      owner: "us",
      handler: '"D:////Games////CyberDeck Launcher////CyberDeck Launcher.exe" "%1"',
      backup: mockNxm.handler ?? null,
      backupAt: new Date().toISOString(),
    };
    return { ...mockNxm };
  },

  async nxmRelease(): Promise<NxmStatus> {
    await sleep(140);
    const restored = mockNxm.backup;
    mockNxm = {
      ours: false,
      registered: Boolean(restored),
      owner: restored ? "other" : "none",
      handler: restored,
      backup: null,
      backupAt: null,
    };
    return { ...mockNxm };
  },

  async nxmPending(): Promise<NxmLink[]> {
    await sleep(40);
    // 浏览器预览里没有真实的协议拉起，用 ?nxm=1 造一条示例链接，
    // 让接收条可被验收脚本（check-nxm）看到，而不影响其它页面的截图。
    if (typeof location !== "undefined") {
      const flag = new URLSearchParams(location.search).get("nxm");
      if (flag === "1") {
        return [
          {
            uri: "nxm://cyberpunk2077/mods/107/files/1234?key=demo",
            domain: "cyberpunk2077",
            modId: 107,
            fileId: 1234,
            key: "demo",
            expires: null,
            userId: null,
          },
        ];
      }
    }
    return [];
  },

  async nxmDismiss(_uri?: string | null): Promise<void> {
    await sleep(20);
  },

  /** 演示模式按真实规则做最小解析（mod/file id），不通过时抛错以贴近后端行为。 */
  async nxmIntake(uri: string): Promise<NxmLink> {
    await sleep(30);
    const match = /^nxm:\/\/([^/]+)\/mods\/(\d+)(?:\/files\/(\d+))?/i.exec(uri.trim());
    if (!match) {
      throw new Error("无法识别的 nxm 链接");
    }
    return {
      uri: uri.trim(),
      domain: match[1],
      modId: Number(match[2]),
      fileId: match[3] ? Number(match[3]) : null,
      key: null,
      expires: null,
      userId: null,
    };
  },

  /** 演示模式（浏览器预览）没有本地文件系统；.nxm 拖拽只支持 Tauri 环境。 */
  async nxmIntakeFile(_path: string): Promise<NxmLink[]> {
    throw new Error("演示模式不支持读取本地 .nxm 文件");
  },

  async launchGame(): Promise<LaunchResult> {
    await sleep(420);
    return {
      method: "direct",
      detail: "已直接启动 Cyberpunk2077.exe，跳过 REDprelauncher（浏览器预览，不会真的启动游戏）",
      platform: "steam",
      fallbackFrom: null,
      notes: ["Steam 已在运行，DRM 前提满足。"],
    };
  },

  async openPath(): Promise<void> {
    await sleep(80);
  },

  async openLogsFolder(): Promise<void> {
    await sleep(80);
  },

  /** 演示模式没有 shell 插件，外链只打日志。 */
  async openUrl(url: string): Promise<void> {
    await sleep(80);
    console.info("[demo] open_url", url);
  },

  /** 演示模式没有多窗口能力，只打日志。 */
  async openNexusBrowser(): Promise<void> {
    await sleep(60);
    console.info("[demo] open_nexus_browser");
  },

  async revealMod(): Promise<void> {
    await sleep(80);
  },

  async appDataDir(): Promise<string> {
    return DEMO_DATA;
  },

  async nexusStatus(): Promise<NexusStatus> {
    await sleep(260);
    if (
      typeof window !== "undefined" &&
      (window.location.search.includes("nexus=off") ||
        localStorage.getItem("cyberdeck-demo-no-nexus") === "1")
    ) {
      return { configured: false, connected: false, user: null, error: null };
    }
    return {
      configured: true,
      connected: true,
      user: {
        name: "V",
        profileUrl: "https://www.nexusmods.com/users/1",
        isPremium: false,
        isSupporter: true,
      },
      error: null,
    };
  },

  async setNexusKey(_key?: string): Promise<NexusStatus> {
    await sleep(420);
    // 连接成功后清掉「演示断开」标记，否则 nexusStatus 还会按未连接返回，
    // 跨页同步的验收就永远看不到「连上」。
    if (typeof window !== "undefined") localStorage.removeItem("cyberdeck-demo-no-nexus");
    return this.nexusStatus();
  },

  async clearNexusKey(): Promise<NexusStatus> {
    await sleep(180);
    // 记住断开状态：另一个页面的 nexusStatus 也要跟着变，这才是真实的行为。
    if (typeof window !== "undefined") localStorage.setItem("cyberdeck-demo-no-nexus", "1");
    return { configured: false, connected: false, user: null, error: null };
  },

  async nexusBrowse(section: NexusSection): Promise<NexusModSummary[]> {
    await sleep(520);
    const base = demoNexusMods();
    return section === "latest_added" ? [...base].reverse() : base;
  },

  async nexusDetail(modId: number): Promise<NexusModDetail> {
    await sleep(380);
    const summary = demoNexusMods().find((item) => item.modId === modId) ?? demoNexusMods()[0];
    return {
      summary,
      description:
        "这是浏览器预览里的 Nexus 演示条目。真实应用中这里显示作者提供的 BBCode 描述，文件列表来自 Nexus API。",
      files: [
        {
          fileId: modId * 10 + 1,
          name: "MAIN FILE",
          fileName: `${summary.name.replace(/\s+/g, "_")}-${summary.version}.zip`,
          version: summary.version,
          category: "MAIN",
          sizeKb: 48_000,
          uploadedTime: summary.updatedTime,
          primary: true,
        },
        {
          fileId: modId * 10 + 2,
          name: "OPTIONAL PATCH",
          fileName: `${summary.name.replace(/\s+/g, "_")}-patch.zip`,
          version: summary.version,
          category: "OPTIONAL",
          sizeKb: 2_400,
          uploadedTime: summary.updatedTime,
          primary: false,
        },
      ],
    };
  },

  async nexusDownload(modId: number, fileId: number, _fileName?: string): Promise<NexusDownloadResult> {
    await sleep(900);
    const db = loadDb();
    const summary = demoNexusMods().find((item) => item.modId === modId) ?? demoNexusMods()[0];
    const mod = baseMod(
      `mod-nexus-${Date.now()}`,
      summary.name,
      "其他",
      "archive",
      false,
      {
        version: summary.version,
        author: summary.author,
        description: summary.summary,
        sourceZip: `${DEMO_DATA}\\downloads\\nexus-demo.zip`,
        nexus: {
          modId,
          fileId,
          url: summary.modPageUrl ?? "https://www.nexusmods.com/cyberpunk2077",
          version: summary.version,
          pictureUrl: summary.pictureUrl ?? null,
        },
        nexusCoverUrl: summary.pictureUrl ?? null,
        installedAt: new Date().toISOString(),
        sizeBytes: 48_000_000,
        fileCount: 2,
        hasArchive: true,
      },
    );
    db.state.mods.push(mod);
    saveDb(db);
    return {
      outcome: {
        path: `${DEMO_DATA}\\downloads\\nexus-demo.zip`,
        success: true,
        modEntry: structuredClone(mod),
        error: null,
        errorCode: null,
      },
      fileName: "nexus-demo.zip",
      path: `${DEMO_DATA}\\downloads\\nexus-demo.zip`,
      reused: false,
    };
  },

  async pruneNexusDownloads(): Promise<number> {
    await sleep(180);
    return 0;
  },

  // ── 下载中心队列（mock：内存模拟，进度走定时器）──────────────
  // 浏览器预览 / UI 回归没有 Rust 后端，这里用假数据把整条交互跑通。

  async downloadQueueList(): Promise<DownloadTask[]> {
    return mockQueue.tasks.map((task) => ({ ...task }));
  },

  async downloadQueueAdd(
    modId: number,
    fileId: number,
    name?: string,
    _key?: string,
    _expires?: string,
    _autoImport?: boolean,
  ): Promise<DownloadTask> {
    const task: DownloadTask = {
      id: `dl-mock-${Date.now()}-${fileId}`,
      modId,
      fileId,
      name: name ?? `Nexus Mod ${modId}`,
      fileName: `nexus-${modId}-${fileId}.zip`,
      status: "queued",
      received: 0,
      total: 42_000_000,
      error: null,
      nxmKey: _key ?? null,
      nxmExpires: _expires ?? null,
      autoImport: _autoImport ?? true,
      createdAt: Math.floor(Date.now() / 1000),
      finishedAt: null,
      retryAt: null,
      retries: 0,
    };
    mockQueue.tasks.push(task);
    mockQueue.run(task.id);
    return { ...task };
  },

  async downloadQueuePause(id: string): Promise<DownloadTask | null> {
    const task = mockQueue.tasks.find((item) => item.id === id) ?? null;
    if (task && (task.status === "queued" || task.status === "downloading")) {
      task.status = "paused";
      mockQueue.stop(task.id);
    }
    return task ? { ...task } : null;
  },

  async downloadQueueResume(id: string): Promise<DownloadTask | null> {
    const task = mockQueue.tasks.find((item) => item.id === id) ?? null;
    if (task && (task.status === "paused" || task.status === "failed")) {
      task.status = "queued";
      task.error = null;
      mockQueue.run(task.id);
    }
    return task ? { ...task } : null;
  },

  async downloadQueueCancel(id: string): Promise<DownloadTask | null> {
    const task = mockQueue.tasks.find((item) => item.id === id) ?? null;
    if (task && task.status !== "completed") {
      task.status = "cancelled";
      task.finishedAt = Math.floor(Date.now() / 1000);
      mockQueue.stop(task.id);
    }
    return task ? { ...task } : null;
  },

  async downloadQueueRemove(id: string): Promise<boolean> {
    const before = mockQueue.tasks.length;
    mockQueue.stop(id);
    mockQueue.tasks = mockQueue.tasks.filter((task) => task.id !== id);
    return mockQueue.tasks.length !== before;
  },

  async downloadQueueClearFinished(): Promise<number> {
    const before = mockQueue.tasks.length;
    mockQueue.tasks = mockQueue.tasks.filter(
      (task) => task.status === "queued" || task.status === "downloading" || task.status === "paused",
    );
    return before - mockQueue.tasks.length;
  },

  async downloadQueueGetSettings(): Promise<DownloadQueueSettings> {
    return { ...mockQueue.settings };
  },

  async downloadQueueSetSettings(
    concurrency: number,
    autoImport: boolean,
    dir?: string | null,
    proxy?: string | null,
    speedLimitMbps?: number,
  ): Promise<DownloadQueueSettings> {
    mockQueue.settings = {
      concurrency: Math.min(3, Math.max(1, concurrency)),
      autoImport,
      dir: dir?.trim() ? dir.trim() : null,
      proxy: proxy?.trim() ? proxy.trim() : null,
      speedLimitMbps:
        speedLimitMbps && speedLimitMbps > 0 ? Math.min(100, Math.max(1, Math.round(speedLimitMbps))) : 0,
    };
    return { ...mockQueue.settings };
  },

  /** 演示模式返回固定的演示磁盘清单，不真正执行 PowerShell 探测。 */
  async suggestStagingDir(): Promise<DriveSuggestion[]> {
    return [
      { drive: "D:", freeBytes: 195_768_562_688, totalBytes: 512_110_190_592 },
      { drive: "C:", freeBytes: 48_426_877_338, totalBytes: 255_055_095_296 },
      { drive: "E:", freeBytes: 549_755_813_888, totalBytes: 1_000_203_215_872 },
    ];
  },

  async externalToolsList(): Promise<ExternalToolEntry[]> {
    return mockTools.entries.map((t) => ({ ...t }));
  },

  async externalToolAdd(name: string, path: string, icon?: string): Promise<ExternalToolEntry[]> {
    const entry: ExternalToolEntry = {
      id: `tool-${Date.now().toString(36)}`,
      name: name.trim() || "未命名工具",
      path: path.trim(),
      icon: icon?.trim() ? icon.trim() : null,
      pinned: false,
      createdAt: new Date().toISOString(),
    };
    mockTools.entries.push(entry);
    return mockTools.entries.map((t) => ({ ...t }));
  },

  async externalToolUpdate(
    id: string,
    patch: { name?: string; icon?: string; pinned?: boolean },
  ): Promise<ExternalToolEntry[]> {
    const target = mockTools.entries.find((t) => t.id === id);
    if (target) {
      if (patch.name !== undefined) target.name = patch.name.trim() || target.name;
      if (patch.icon !== undefined) target.icon = patch.icon?.trim() ? patch.icon.trim() : null;
      if (patch.pinned !== undefined) target.pinned = patch.pinned;
    }
    return mockTools.entries.map((t) => ({ ...t }));
  },

  async externalToolRemove(id: string): Promise<ExternalToolEntry[]> {
    mockTools.entries = mockTools.entries.filter((t) => t.id !== id);
    return mockTools.entries.map((t) => ({ ...t }));
  },

  async externalToolLaunch(id: string): Promise<void> {
    // 演示模式不真正拉起进程，仅校验存在性以贴近真实行为。
    if (!mockTools.entries.some((t) => t.id === id)) {
      throw new Error("工具不存在或已被移除");
    }
  },

  /**
   * 演示模式的 AI 汉化计划。
   *
   * 演示库没有真实本地化 JSON，这里给一份形状完整的假计划，
   * 用来验证弹窗的「作者意愿 / 不可处理 / 未打包」几条分支。
   */
  async aiLocPlan(modId: string): Promise<AiLocPlan> {
    await sleep(320);
    const db = loadDb();
    const mod = db.state.mods.find((item) => item.id === modId);
    if (!mod) throw new Error("找不到这个模组。");
    return {
      modId,
      modName: mod.name,
      sourceLang: "en-us",
      targetLang: "zh-cn",
      policy: "allowed",
      policyEvidence: [],
      entries: [
        {
          sourceFile: "localization/en-us.json",
          secondaryKey: "Demo-Item-Name",
          sourceText: "Prototype Cyberdeck",
          glossaryHit: null,
        },
        {
          sourceFile: "localization/en-us.json",
          secondaryKey: "Demo-Item-Desc",
          sourceText: "A hand-built deck with an unreasonably large buffer.",
          glossaryHit: "手工改装的义体接口，缓冲区大得不讲道理。",
        },
      ],
      blocked: [
        { sourceFile: "localization/en-us.json", reason: "ALREADY_CHINESE", sample: "赛博朋克" },
      ],
      glossaryHits: 1,
      packingReady: true,
      hasOverlay: mod.aiLoc !== null,
      warnings: [],
    };
  },

  async aiLocApply(
    modId: string,
    consent: boolean,
    _policyAck: boolean,
  ): Promise<AiLocReport> {
    await sleep(900);
    if (!consent) {
      throw { code: "AI_LOC_CONSENT_REQUIRED", message: "需要先确认译文由 AI 生成。" };
    }
    const db = loadDb();
    const mod = db.state.mods.find((item) => item.id === modId);
    if (!mod) throw new Error("找不到这个模组。");
    mod.aiLoc = {
      stagingDir: `staging/ai-loc/${modId}`,
      translated: 2,
      model: "demo-model",
      createdAt: new Date().toISOString(),
    };
    saveDb(db);
    return {
      modId,
      planned: 2,
      translated: 2,
      skipped: 1,
      written: [`staging/ai-loc/${modId}/localization/zh-cn/${modId}-ai-loc.json`],
      deployed: [`archive/pc/mod/${modId}-ai-loc.archive`],
      rolledBack: false,
      model: "demo-model",
      warnings: ["演示模式不会真的写游戏目录。"],
      errors: [],
    };
  },

  async aiLocRevert(modId: string): Promise<AiLocReport> {
    await sleep(420);
    const db = loadDb();
    const mod = db.state.mods.find((item) => item.id === modId);
    if (!mod) throw new Error("找不到这个模组。");
    mod.aiLoc = null;
    saveDb(db);
    return {
      modId,
      planned: 0,
      translated: 0,
      skipped: 0,
      written: [],
      deployed: [`archive/pc/mod/${modId}-ai-loc.archive`],
      rolledBack: true,
      model: "demo-model",
      warnings: [],
      errors: [],
    };
  },

  async aiFixPropose(modId: string, intent: string): Promise<AiFixProposal> {
    await sleep(700);
    const db = loadDb();
    const mod = db.state.mods.find((item) => item.id === modId);
    if (!mod) throw new Error("找不到这个模组。");
    return {
      modId,
      modName: mod.name,
      intent,
      contextChars: 2400,
      contextFiles: ["r6/scripts/demo.reds"],
      code:
        `module CyberDeck.AiFix.${modId.replace(/[^A-Za-z0-9]/g, "")}\n\n` +
        `@wrapMethod(DemoHelper)\n` +
        `public static func GetLabel() -> String {\n` +
        `  let original: String = wrappedMethod();\n` +
        `  return original;\n` +
        `}\n`,
      structureOk: true,
      structureIssues: [],
      compiler: null,
      warnings: ["演示模式不会真的外发脚本。"],
    };
  },

  async aiFixApply(
    modId: string,
    code: string,
    intent: string,
    acknowledged: boolean,
  ): Promise<AiFixReport> {
    await sleep(520);
    if (!acknowledged) {
      throw { code: "AI_FIX_CONSENT_REQUIRED", message: "需要先确认风险。" };
    }
    const db = loadDb();
    const mod = db.state.mods.find((item) => item.id === modId);
    if (!mod) throw new Error("找不到这个模组。");
    const target = `r6/scripts/cyberdeck-ai-fix/${modId}-AIFix.reds`;
    mod.aiFix.push({
      file: { relativePath: target, target },
      intent,
      model: "demo-model",
      createdAt: new Date().toISOString(),
    });
    saveDb(db);
    return {
      modId,
      target,
      bytes: code.length,
      compiled: false,
      model: "demo-model",
      warnings: ["演示模式不会真的写游戏目录。"],
    };
  },

  async aiFixRevert(modId: string, target: string): Promise<AiFixReport> {
    await sleep(320);
    const db = loadDb();
    const mod = db.state.mods.find((item) => item.id === modId);
    if (!mod) throw new Error("找不到这个模组。");
    mod.aiFix = mod.aiFix.filter((item) => item.file.relativePath !== target);
    saveDb(db);
    return {
      modId,
      target,
      bytes: 0,
      compiled: false,
      model: "demo-model",
      warnings: [],
    };
  },

  /** 演示模式没有真实封面回源，返回空统计（message 文案与真实后端同构）。 */
  async refreshNexusCovers(): Promise<NexusCoverRefresh> {
    await sleep(200);
    return { updated: 0, failed: 0, skipped: 0, message: "演示模式：没有需要回源的封面。" };
  },

  // 演示模式的封面缓存：不落盘，只按当前库算一遍统计，保证设置页能打开。
  async coverCacheStats(): Promise<CoverCacheStats> {
    await sleep(120);
    const data = loadDb();
    const pending = data.state.mods.filter((mod) => mod.nexusCoverUrl && !mod.coverPath).length;
    return {
      count: 0,
      bytes: 0,
      dir: `${DEMO_DATA}\\covers`,
      pending,
      cached: data.state.mods.length - pending,
    };
  },

  async coverCacheFill(ids?: string[]): Promise<CoverCacheReport> {
    await sleep(260);
    const data = loadDb();
    const pending = data.state.mods.filter((mod) => mod.nexusCoverUrl && !mod.coverPath).length;
    return {
      downloaded: 0,
      failed: 0,
      skipped: ids ? ids.length : pending,
      bytes: 0,
      stats: {
        count: 0,
        bytes: 0,
        dir: `${DEMO_DATA}\\covers`,
        pending,
        cached: data.state.mods.length - pending,
      },
    };
  },

  async coverCacheClear(): Promise<CoverCacheStats> {
    await sleep(180);
    const data = loadDb();
    const pending = data.state.mods.filter((mod) => mod.nexusCoverUrl && !mod.coverPath).length;
    return {
      count: 0,
      bytes: 0,
      dir: `${DEMO_DATA}\\covers`,
      pending,
      cached: data.state.mods.length - pending,
    };
  },

  /** 演示模式没有 Nexus 元数据可查，返回零变更统计。 */
  async enrichNexusMetadata(): Promise<NexusEnrichReport> {
    await sleep(300);
    return {
      scanned: 0,
      matched: 0,
      updated: 0,
      failed: 0,
      unmatched: 0,
      message: "演示模式：没有可补全的模组。",
    };
  },

  async vortexImportMetadata(): Promise<string> {
    await sleep(200);
    return "演示模式：无法读取 Vortex 数据。";
  },

  async attachModFromNexus(id: string, url: string): Promise<void> {
    await sleep(150);
    const db = loadDb();
    const target = db.state.mods.find((item) => item.id === id);
    if (!target) return;
    // 演示模式也要真的落库：只打一行 console.info 会让 App 的「已保存」toast
    // 变成假成功（刷新后数据回退）。这里按真实命令的语义写上 nexus 引用。
    target.nexus = {
      modId: Number(/mods\/(\d+)/.exec(url)?.[1] ?? 0),
      fileId: target.nexus?.fileId ?? null,
      url,
      version: target.nexus?.version ?? target.version,
      pictureUrl: target.nexus?.pictureUrl ?? null,
      latestVersion: target.nexus?.latestVersion ?? null,
      lastCheck: target.nexus?.lastCheck ?? null,
    };
    saveDb(db);
  },

  async updateModMetadata(
    id: string,
    fields: { name: string; author: string; version: string; category: string },
  ): Promise<void> {
    await sleep(120);
    const db = loadDb();
    const target = db.state.mods.find((item) => item.id === id);
    if (target) {
      target.name = fields.name;
      target.author = fields.author || null;
      target.version = fields.version || null;
      if (fields.category) target.category = fields.category as typeof target.category;
      saveDb(db);
    }
  },

  /** 演示版智能归类：演示库里没有真正的「其他」堆积，按名称做一轮同样的推断。 */
  async reclassifyUnclassified(): Promise<number> {
    await sleep(200);
    const RULES: Array<[RegExp, string]> = [
      [/weapon|gun|blade|katana|rifle/i, "武器"],
      [/clothing|outfit|armor|jacket|coat/i, "服装"],
      [/vehicle|car\b|bike/i, "车辆"],
      [/hair|face|skin|tattoo|visual/i, "视觉"],
      [/audio|sound|radio|music/i, "音频"],
      [/quest|romance|npc|story/i, "任务"],
      [/hud|minimap|interface|gameplay/i, "玩法"],
      [/tool|manager|menu/i, "工具"],
    ];
    const db = loadDb();
    let changed = 0;
    for (const mod of db.state.mods) {
      if (mod.category !== "其他" && mod.category !== "工具") continue;
      if (mod.categoryLocked) continue;
      const hit = RULES.find(([pattern]) => pattern.test(mod.name))?.[1];
      if (hit && hit !== mod.category) {
        mod.category = hit as typeof mod.category;
        changed += 1;
      }
    }
    if (changed > 0) saveDb(db);
    return changed;
  },

  /** 演示版重算全部：同样是按名称推断，但会跳过手动锁定过的条目。 */
  async reclassifyAll(): Promise<number> {
    await sleep(240);
    const db = loadDb();
    let changed = 0;
    for (const mod of db.state.mods) {
      if (mod.categoryLocked) continue;
      const next = inferCategoryByName(mod.name);
      if (next && next !== mod.category) {
        mod.category = next as typeof mod.category;
        changed += 1;
      }
    }
    if (changed > 0) saveDb(db);
    return changed;
  },

  /** 演示版手动改分类：写入即锁定，后续重算不再覆盖。 */
  async setModCategory(id: string, category: string): Promise<string> {
    await sleep(120);
    const db = loadDb();
    const mod = db.state.mods.find((item) => item.id === id);
    if (!mod) throw new Error("找不到这个模组。");
    mod.category = category as typeof mod.category;
    mod.categoryLocked = true;
    saveDb(db);
    return category;
  },

  /** P6 演示：批量指定分类。 */
  async setModsCategory(ids: string[], category: string): Promise<number> {
    await sleep(180);
    const db = loadDb();
    let changed = 0;
    for (const id of ids) {
      const mod = db.state.mods.find((item) => item.id === id);
      if (!mod) continue;
      mod.category = category as typeof mod.category;
      mod.categoryLocked = true;
      changed += 1;
    }
    if (changed > 0) saveDb(db);
    return changed;
  },

  /** #1 演示版更新检查：ReLIT 假装有 2.5.0 新版本，用于验收徽标与跳转。 */
  async nexusCheckUpdates(): Promise<NexusUpdateReport> {
    await sleep(900);
    return {
      checked: 3,
      skipped: 9,
      failed: 0,
      updates: [
        {
          entryId: "mod-relit",
          modId: 7712,
          name: "CyberDeck ReLIT",
          currentVersion: "2.4.0",
          latestVersion: "2.5.0",
          pageUrl: "https://www.nexusmods.com/cyberpunk2077/mods/7712",
        },
      ],
      message: "检查了 3 个模组，1 个有新版本。",
      generatedAt: new Date().toISOString(),
    };
  },

  /** P5-5B 演示：更新单个模组（不动真实文件，只回一份报告）。 */
  async nexusApplyUpdate(entryId: string): Promise<UpdateApplyItem> {
    await sleep(1400);
    return {
      entryId,
      name: "CyberDeck ReLIT",
      ok: true,
      fromVersion: "2.4.0",
      toVersion: "2.5.0",
      backupId: `${DEMO_DATA}\\update-backups\\${entryId}\\old.zip`,
      error: null,
      warning: null,
    };
  },

  /** P5-5B 演示：批量更新。 */
  async nexusApplyUpdates(entryIds: string[]): Promise<UpdateApplyReport> {
    await sleep(1800);
    const items = entryIds.map((entryId) => ({
      entryId,
      name: "CyberDeck ReLIT",
      ok: true,
      fromVersion: "2.4.0",
      toVersion: "2.5.0",
      backupId: `${DEMO_DATA}\\update-backups\\${entryId}\\old.zip`,
      error: null,
      warning: null,
    }));
    return {
      applied: items.length,
      failed: 0,
      items,
      message: `${items.length} 个模组已更新，旧版本都留了备份。`,
    };
  },

  /** P5-5B 演示：回滚。 */
  async nexusRollbackUpdate(entryId: string): Promise<UpdateApplyItem> {
    await sleep(1200);
    return {
      entryId,
      name: "CyberDeck ReLIT",
      ok: true,
      fromVersion: "2.5.0",
      toVersion: "2.4.0",
      backupId: `${DEMO_DATA}\\update-backups\\${entryId}\\old.zip`,
      error: null,
      warning: null,
    };
  },

  /** P5-5B 演示：备份清单。 */
  async nexusListUpdateBackups(): Promise<UpdateBackup[]> {
    await sleep(200);
    return [
      {
        entryId: "mod-relit",
        name: "CyberDeck ReLIT",
        modId: 7712,
        fromVersion: "2.4.0",
        toVersion: "2.5.0",
        createdAt: new Date(Date.now() - 3600_000).toISOString(),
        enabled: true,
        archive: `${DEMO_DATA}\\update-backups\\mod-relit\\old.zip`,
      },
    ];
  },

  // ── Nexus Collections 集合安装（演示）─────────────────────────

  /**
   * 演示版集合清单解析。
   *
   * 造一份假的安装计划，让浏览器预览也能验收向导的三种条目状态
   * （已装 / 版本不一致 / 缺失）与部署按钮的启用条件。
   * 演示态不读文件——路径只是用来回显的。
   */
  async parseCollectionManifest(path: string): Promise<CollectionPlan> {
    await sleep(560);
    const db = loadDb();
    const find = (id: string) => db.state.mods.find((item) => item.id === id);

    // 演示清单：必需项全部就绪，可选项里留一个版本不符和一个完全缺失，
    // 这样三种状态和「按预设顺序部署」的启用条件都能在浏览器里看到。
    const spec: Array<{
      modId: number;
      fileId: number | null;
      name: string;
      version: string | null;
      optional: boolean;
      localId: string | null;
      wantVersion: string | null;
    }> = [
      {
        modId: 7712,
        fileId: 501,
        name: "CyberDeck ReLIT",
        version: "2.4.0",
        optional: false,
        localId: "mod-relit",
        wantVersion: "2.4.0",
      },
      {
        modId: 7720,
        fileId: 502,
        name: "Street Style Vol. 3",
        version: "3.0.2",
        optional: false,
        localId: "mod-streetstyle",
        wantVersion: "3.0.2",
      },
      {
        modId: 7731,
        fileId: 503,
        name: "Cyberarms — Chrome Collection",
        version: "1.3.0",
        optional: false,
        localId: "mod-chromearms",
        wantVersion: "1.3.0",
      },
      {
        modId: 7718,
        fileId: 504,
        name: "Neon Rain ReShade",
        version: "1.9.0",
        optional: true,
        localId: "mod-neonrain",
        wantVersion: "1.9.0",
      },
      {
        modId: 7745,
        fileId: 505,
        name: "Dogtown Vibes",
        version: "1.0.3",
        optional: true,
        localId: null,
        wantVersion: "1.0.3",
      },
    ];

    const items: CollectionPlan["items"] = spec.map((entry, index) => {
      const local = entry.localId ? find(entry.localId) : undefined;
      const localVersion = local?.version ?? null;
      let status: CollectionPlan["items"][number]["status"];
      if (!local) status = "missing";
      else if (entry.wantVersion && localVersion && localVersion !== entry.wantVersion) {
        status = "version_mismatch";
      } else status = "installed";
      return {
        modId: entry.modId,
        fileId: entry.fileId,
        name: entry.name,
        version: entry.version,
        optional: entry.optional,
        status,
        localId: local?.id ?? null,
        localVersion,
        pageUrl: `https://www.nexusmods.com/cyberpunk2077/mods/${entry.modId}`,
        order: index,
      };
    });

    const installed = items.filter((item) => item.status === "installed").length;
    const missing = items.filter((item) => item.status === "missing" && !item.optional).length;
    const optionalMissing = items.filter(
      (item) => item.status === "missing" && item.optional,
    ).length;

    return {
      info: {
        name: "CyberDeck Essentials",
        author: "Nexus 社区",
        description: "夜之城的画质、服装与武器三件套。",
        domainName: "cyberpunk2077",
        gameVersions: ["2.13", "2.2"],
      },
      items,
      installed,
      missing,
      optionalMissing,
      readyToDeploy: missing === 0,
      deployOrder: items.map((item) => item.modId),
      message: `演示模式：解析了 ${path.split(/[\\/]/).pop() ?? "清单"}，未读取真实文件。`,
    };
  },

  /** 演示版按预设顺序部署：只回报「什么都没改」，不动演示库。 */
  async applyCollectionOrder(ids: string[]): Promise<CollectionDeployReport> {
    await sleep(520);
    // 演示态不真的部署：报告成功 0、失败 0，只把警告说清楚。
    // order 回显收到的顺序，方便验收「前端排的序有没有传对」。
    return {
      deployed: 0,
      failed: 0,
      warnings: ["演示模式：没有真正重写 modlist.txt，也没有部署任何文件。"],
      order: [...ids],
    };
  },

  // ── 整合包（演示数据）────────────────────────────────────────
  // 浏览器预览里没有真文件系统，这里给足三种状态（已装 / 版本不符 / 缺失 /
  // 无编号），让导出与导入两条链路都能点得下去。

  async packExport(input: PackExportInput): Promise<PackExportReport> {
    await sleep(620);
    const db = loadDb();
    const mods = db.state.mods.length;
    return {
      path: `C:////演示////${input.name || "整合包"}.${input.kind === "full" ? "cdpack" : "cdlist"}`,
      sizeBytes: input.kind === "full" ? 3_512_000_000 : 48_120,
      mods,
      enabled: db.state.mods.filter((item) => item.enabled).length,
      configs: input.kind === "full" ? 96 : 96,
      unresolved: 3,
      warnings: ["演示模式：没有真的写文件。"],
    };
  },

  async packPreview(path: string): Promise<PackPreview> {
    await sleep(480);
    const db = loadDb();
    const items: PackPreviewItem[] = db.state.mods.slice(0, 10).map((item, index) => ({
      key: item.nexus ? `nxm:${item.nexus.modId}` : `local:${item.name.toLowerCase()}`,
      name: item.name,
      version: item.version ?? null,
      modId: item.nexus?.modId ?? null,
      fileId: item.nexus?.fileId ?? null,
      enabled: item.enabled,
      status: index === 3 ? "version_mismatch" : item.nexus ? "installed" : "local_only",
      matchedEntryId: item.id,
      matchedVersion: item.version ?? null,
      sizeBytes: item.sizeBytes,
      hasFiles: path.toLowerCase().endsWith(".cdpack"),
      pageUrl: item.nexus ? `https://www.nexusmods.com/cyberpunk2077/mods/${item.nexus.modId}` : null,
    }));
    // 再补两条「对方机器上还没装」的，演示下载与引导队列。
    items.push({
      key: "nxm:99001",
      name: "演示 · 缺失的模组 A",
      version: "2.1.0",
      modId: 99001,
      fileId: 550001,
      enabled: true,
      status: "missing",
      matchedEntryId: null,
      matchedVersion: null,
      sizeBytes: 42_000_000,
      hasFiles: path.toLowerCase().endsWith(".cdpack"),
      pageUrl: "https://www.nexusmods.com/cyberpunk2077/mods/99001?tab=files&file_id=550001",
    });
    items.push({
      key: "nxm:99002",
      name: "演示 · 缺失的模组 B",
      version: "1.0.4",
      modId: 99002,
      fileId: null,
      enabled: false,
      status: "missing",
      matchedEntryId: null,
      matchedVersion: null,
      sizeBytes: 8_400_000,
      hasFiles: false,
      pageUrl: "https://www.nexusmods.com/cyberpunk2077/mods/99002",
    });

    const installed = items.filter((item) => item.status === "installed").length;
    const mismatch = items.filter((item) => item.status === "version_mismatch").length;
    const localOnly = items.filter((item) => item.status === "local_only").length;
    return {
      path,
      name: "演示整合包",
      author: "CyberDeck",
      mode: path.toLowerCase().endsWith(".cdpack") ? "full" : "list",
      createdAt: new Date().toISOString(),
      appVersion: "1.7.1",
      gameVersion: "2.2",
      total: items.length,
      installed,
      missing: items.length - installed - mismatch - localOnly,
      versionMismatch: mismatch,
      localOnly,
      enabled: items.filter((item) => item.enabled).length,
      configs: 96,
      totalSize: items.reduce((sum, item) => sum + item.sizeBytes, 0),
      items,
      warnings: [],
    };
  },

  async packInstall(path: string, keys?: string[]): Promise<PackInstallReport> {
    await sleep(520);
    void path;
    return {
      installed: keys?.length ?? 0,
      failed: 0,
      warnings: ["演示模式：没有真的解包安装。"],
    };
  },

  async packQueueDownloads(path: string, premium: boolean): Promise<PackQueueReport> {
    await sleep(420);
    void path;
    const manual: PackManualItem[] = premium
      ? []
      : [
          {
            modId: 99001,
            fileId: 550001,
            name: "演示 · 缺失的模组 A",
            url: "https://www.nexusmods.com/cyberpunk2077/mods/99001?tab=files&file_id=550001",
          },
          {
            modId: 99002,
            fileId: null,
            name: "演示 · 缺失的模组 B",
            url: "https://www.nexusmods.com/cyberpunk2077/mods/99002",
          },
        ];
    return {
      queued: premium ? 2 : 0,
      skipped: 0,
      manual,
      warnings: premium ? ["演示模式：没有真的入队。"] : [],
    };
  },

  async packManualPages(): Promise<PackManualItem[]> {
    await sleep(320);
    return [
      {
        modId: 99001,
        fileId: 550001,
        name: "演示 · 缺失的模组 A",
        url: "https://www.nexusmods.com/cyberpunk2077/mods/99001?tab=files&file_id=550001",
      },
      {
        modId: 99002,
        fileId: null,
        name: "演示 · 缺失的模组 B",
        url: "https://www.nexusmods.com/cyberpunk2077/mods/99002",
      },
    ];
  },

  async packApply(path: string): Promise<PackApplyReport> {
    await sleep(640);
    void path;
    return {
      deployed: 0,
      undeployed: 0,
      missing: 0,
      configsWritten: 0,
      configsFailed: 0,
      orderApplied: 0,
      warnings: ["演示模式：没有真的改启用状态与加载顺序。"],
    };
  },

  async nexusBackfillPropose(useRemote: boolean): Promise<BackfillReport> {
    await sleep(useRemote ? 900 : 420);
    const db = loadDb();
    const targets = db.state.mods.filter((item) => !item.nexus).slice(0, 3);
    return {
      scanned: targets.length + 2,
      proposals: targets.map((item, index) => ({
        entryId: item.id,
        entryName: item.name,
        modId: 8000 + index,
        fileId: 5000 + index,
        matchedName: item.name,
        matchedVersion: item.version ?? null,
        source: "vortex",
        confidence: "exact",
      })),
      unmatched: targets.length > 2 ? [] : ["演示 · 匹配不到的条目"],
      vortexStatus: "ok",
      vortexMessage: "演示模式：读到 0 条 Vortex 记录。",
      remoteMessage: useRemote ? "演示模式：没有真的联网检索。" : null,
    };
  },

  async nexusBackfillApply(proposals: BackfillProposal[]): Promise<number> {
    await sleep(360);
    return proposals.length;
  },

  /**
   * 演示模式的「AI 翻译名称」。
   *
   * 不联网，但真的会写状态：给演示库里认识的那几个 Mod 补上中文名，
   * 这样双语展示和「中/英都能搜」在浏览器里就能直接验收。
   */
  async translateModNames(
    consent: boolean,
    onlyIds?: string[],
    limit?: number,
  ): Promise<TranslateReport> {
    await sleep(700);
    if (!consent) {
      throw { code: "AI_CONSENT_REQUIRED", message: "需要先勾选同意才能调用 AI 翻译。" };
    }

    const db = loadDb();
    const wanted = onlyIds ? new Set(onlyIds) : null;
    const max = limit && limit > 0 ? limit : Number.POSITIVE_INFINITY;
    let requested = 0;
    let translated = 0;
    const failed = 0;
    let skipped = 0;

    for (const mod of db.state.mods) {
      if (wanted && !wanted.has(mod.id)) continue;
      requested += 1;
      const dictName = MOCK_TRANSLATIONS[mod.name];
      if (mod.translatedName || mod.name.trim().length === 0 || !dictName) {
        skipped += 1;
        continue;
      }
      if (translated >= max) {
        skipped += 1;
        continue;
      }
      mod.translatedName = dictName;
      mod.translatedAt = new Date().toISOString();
      mod.translatedBy = "gpt-5.4-nano";
      translated += 1;
    }

    if (translated > 0) saveDb(db);
    return { requested, translated, failed, skipped, model: "gpt-5.4-nano", errors: [] };
  },

  async aiStatus(): Promise<AiStatus> {
    await sleep(120);
    return {
      configured: true,
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-5.4-nano",
      protocol: "openai",
    };
  },

  async aiListModels(baseUrl: string): Promise<string[]> {
    await sleep(200);
    if (!baseUrl.trim()) throw new Error("先填写接口地址");
    return ["gpt-5.4-nano", "gpt-5.4-mini", "mock-local-model"];
  },

  async setAiKey(_key?: string): Promise<AiStatus> {
    await sleep(320);
    return this.aiStatus();
  },

  async clearAiKey(): Promise<AiStatus> {
    await sleep(120);
    return { configured: false, baseUrl: "https://api.openai.com/v1", model: "gpt-5.4-nano", protocol: "openai" };
  },

  /** 演示模式：返回假想的暂存区 archive 路径，让「深度扫描」按钮可以演示。 */
  async resolveDeepScanPaths(refs: DeepScanRef[]): Promise<(string | null)[]> {
    await sleep(100);
    return refs.map((_, index) => (index % 2 === 0 ? `D:\\DemoStaging\\mods\\m${index}\\mod.archive` : null));
  },

  /** 演示模式：返回一份两个 archive 都改了同一批资源的假报告。 */
  async scanArchiveDeep(archivePaths: string[]): Promise<DeepScanReport> {
    await sleep(900);
    return {
      results: archivePaths.map((archive) => ({
        archive,
        error: null,
        resources: [
          "base/characters/judy.mesh",
          "base/characters/judy_cyberware.xbm",
          "base/gameplay/gui/icons/judy.inkatlas",
        ],
        truncated: false,
        totalResources: 3,
      })),
    };
  },

  /** 演示：一套默认 + 一套本地，切换/保存都只改内存。 */
  /** 演示：填了 key 就算通过，空 key 一律 401——两种排版都能看到。 */
  async nexusTestConnection(key: string | null): Promise<NexusTestResult> {
    await sleep(520);
    if (!key || key.trim().length < 8) {
      return {
        ok: false,
        statusCode: 401,
        latencyMs: 260,
        message:
          "Nexus API Key 已失效（HTTP 401）。请重新在「设置 → 工具组件 → Nexus Mods」填写 Personal API Key。",
        user: null,
      };
    }
    return {
      ok: true,
      statusCode: 200,
      latencyMs: 210,
      message: "连接成功，已登录为 demo_user。",
      user: "demo_user",
    };
  },

  /** 演示模式没有真实窗口：调用即忽略（预览里不会真退出）。 */
  async closeWindowAction(_action: "hide" | "exit", _remember: boolean): Promise<void> {
    await sleep(60);
  },

  async aiProfiles(): Promise<AiProfileList> {
    await sleep(120);
    const db = loadDb();
    ensureMockProfiles(db);
    saveDb(db);
    return mockProfileList(db, db.state.settings.activeAiProfileId ?? "default");
  },

  async aiProfileSave(profile: AiProfile, key: string | null): Promise<AiProfileList> {
    await sleep(260);
    const db = loadDb();
    ensureMockProfiles(db);
    const list = db.state.settings.aiProfiles ?? [];
    const id = profile.id || `p-${list.length + 1}`;
    const next: AiProfile = { ...profile, id };
    const index = list.findIndex((item) => item.id === id);
    if (index >= 0) list[index] = next;
    else list.push(next);
    db.state.settings.aiProfiles = list;
    if (key) db.state.settings.aiKeyStored = true;
    saveDb(db);
    return mockProfileList(db, db.state.settings.activeAiProfileId ?? "default");
  },

  async aiProfileDelete(id: string): Promise<AiProfileList> {
    await sleep(200);
    const db = loadDb();
    ensureMockProfiles(db);
    db.state.settings.aiProfiles = (db.state.settings.aiProfiles ?? []).filter(
      (item) => item.id !== id,
    );
    if (db.state.settings.activeAiProfileId === id) {
      db.state.settings.activeAiProfileId = db.state.settings.aiProfiles[0]?.id ?? "default";
    }
    saveDb(db);
    return mockProfileList(db, db.state.settings.activeAiProfileId ?? "default");
  },

  async aiProfileActivate(id: string): Promise<AiProfileList> {
    await sleep(180);
    const db = loadDb();
    ensureMockProfiles(db);
    db.state.settings.activeAiProfileId = id;
    const target = (db.state.settings.aiProfiles ?? []).find((item) => item.id === id);
    if (target) {
      db.state.settings.aiBaseUrl = target.baseUrl;
      db.state.settings.aiModel = target.model;
      db.state.settings.aiProtocol = target.protocol === "anthropic" ? "anthropic" : "openai";
    }
    saveDb(db);
    return mockProfileList(db, id);
  },

  async aiProfileClearKey(id: string): Promise<AiProfileList> {
    await sleep(150);
    const db = loadDb();
    ensureMockProfiles(db);
    if (id === "default") db.state.settings.aiKeyStored = false;
    saveDb(db);
    return mockProfileList(db, db.state.settings.activeAiProfileId ?? "default");
  },

  async aiProfileTest(profile: AiProfile, _key: string | null): Promise<AiTestResult> {
    await sleep(700);
    // 演示：本地地址一律失败，云端一律成功——两种状态的排版都能被看到。
    const local = /127\.0\.0\.1|localhost/.test(profile.baseUrl);
    return {
      ok: !local,
      statusCode: local ? null : 200,
      latencyMs: local ? 1200 : 320,
      message: local
        ? "连接 AI 服务失败：本地服务未启动。"
        : "连接成功，服务返回 14 个可用模型。",
      modelCount: local ? 0 : 14,
    };
  },

  async aiDiagnose(
    includeLogs: boolean,
    _consent?: boolean,
    focus: "conflicts" | "logs" | null = null,
  ): Promise<AiDiagnosis> {
    await sleep(1200);
    const db = loadDb();
    return {
      summary:
        focus === "conflicts"
          ? "这组冲突只需要二选一：保留 CyberDeck ReLIT，禁用 Neon Rain ReShade。"
          : focus === "logs"
            ? "日志里最关键的是一条 ArchiveXL 资源注册失败，不是游戏本体崩溃。"
            : "最可能是两个视觉模组写入了同一个 archive，导致后加载的版本覆盖前一个。",
      likelyCause:
        "CyberDeck ReLIT 与 Neon Rain ReShade 都声明了 archive/pc/mod/zzz_relit_core.archive。游戏只会加载其中一个版本。",
      evidence: [
        "两个已启用模组声明了相同的目标文件 zzz_relit_core.archive",
        "诊断报告中有 1 个文件级冲突",
        includeLogs ? "日志尾部没有出现框架加载失败" : "本次未发送日志",
      ],
      fixSteps: [
        "在「加载顺序」里查看冲突条目，二选一保留。",
        "禁用另一个视觉模组，重新启动游戏确认画面。",
        "如果仍然异常，再检查 RED4ext 与 ArchiveXL 的版本是否匹配游戏版本。",
      ],
      // 演示一条可执行动作：指向真实存在且已启用的模组，点下去会走 mock 执行。
      actions: (() => {
        const victim = db.state.mods.find((item) => item.enabled && item.deployedFiles.length > 0);
        if (!victim) return [];
        return [
          {
            id: "act-demo-1",
            kind: "disableMod",
            target: victim.id,
            targetName: victim.name,
            label: `停用 ${victim.name}`,
            reason: "它和后加载的版本抢同一个 archive，先停掉再确认画面。",
            position: null,
          },
          {
            id: "act-demo-2",
            kind: "moveLoadOrder",
            target: victim.id,
            targetName: victim.name,
            label: `把 ${victim.name} 排到最后`,
            reason: "如果你更想保留它，就把它的加载顺序压到最后试试。",
            position: "last",
          },
        ];
      })(),
      confidence: "high",
      needsMoreInfo: [],
      model: "gpt-5.4-nano",
      generatedAt: new Date().toISOString(),
      sentChars: 4_820,
      redactions: 7,
      contextPreview: JSON.stringify(
        {
          summary: diagnosticsOf(db).summary,
          mods: db.state.mods.filter((item) => item.enabled).map((item) => item.name),
        },
        null,
        2,
      ),
    };
  },

  /** 演示模式：不写磁盘，只回一条"执行成功"。 */
  async aiApplyAction(action: AiFixAction): Promise<AiActionReport> {
    await sleep(420);
    const db = loadDb();
    const target = db.state.mods.find((item) => item.id === action.target);
    if (action.kind === "proposePatch") {
      return {
        kind: action.kind,
        target: action.target,
        message: "已转入 AI 补丁流程。",
        snapshotId: null,
        needsIntent: true,
      };
    }
    if (action.kind === "disableMod") {
      db.state.mods = db.state.mods.map((item) =>
        item.id === action.target ? { ...item, enabled: false, deployedFiles: [] } : item,
      );
      saveDb(db);
    }
    return {
      kind: action.kind,
      target: action.target,
      message:
        action.kind === "disableMod"
          ? `已停用 ${target?.name ?? action.targetName}。`
          : `已把 ${target?.name ?? action.targetName} 排到最后。`,
      snapshotId: "snap-demo-ai",
      needsIntent: false,
    };
  },

  async getModSettings(): Promise<ModSettingsView> {
    await sleep(180);
    return {
      path: `${DEMO_GAME}\\bin\\x64\\plugins\\cyber_engine_tweaks\\mods\\ModSettings\\user.ini`,
      exists: true,
      frameworkInstalled: true,
      sections: demoIniSections.map((section) => ({
        ...section,
        entries: section.entries.map((entry) => ({ ...entry })),
      })),
      warnings: [],
      backupPath: `${DEMO_GAME}\\bin\\x64\\plugins\\cyber_engine_tweaks\\mods\\ModSettings\\user.ini.bak`,
    };
  },

  async saveModSetting(section: string, key: string, value: string): Promise<ModSettingsView> {
    await sleep(220);
    demoIniSections = demoIniSections.map((item) => ({
      ...item,
      entries: item.entries.map((entry) =>
        entry.section === section && entry.key === key ? { ...entry, value } : entry,
      ),
    }));
    return this.getModSettings();
  },

  async restoreModSettings(): Promise<ModSettingsView> {
    await sleep(240);
    demoIniSections = DEMO_INI_SECTIONS.map((section) => ({
      ...section,
      entries: section.entries.map((entry) => ({ ...entry })),
    }));
    return this.getModSettings();
  },

  async getModConfig(modId: string): Promise<ModConfigView> {
    await sleep(160);
    const sources = DEMO_MOD_CONFIG_SOURCES[modId] ?? [];
    return { modId, sources: cloneModConfig(sources), warnings: [] };
  },

  async saveConfigField(
    modId: string,
    sourceId: string,
    section: string,
    key: string,
    value: string,
  ): Promise<ModConfigView> {
    await sleep(200);
    const sources = DEMO_MOD_CONFIG_SOURCES[modId] ?? [];
    const source = sources.find((item) => item.id === sourceId);
    if (!source) throw new Error("这个模组没有可写的配置来源。");
    if (!source.editable) throw new Error("这个配置来源是只读的。");
    const target = source.fields.find((field) => field.section === section && field.key === key);
    if (!target) throw new Error(`配置里没有 ${key} 这一项。`);
    DEMO_MOD_CONFIG_SOURCES[modId] = sources.map((item) =>
      item.id !== sourceId
        ? item
        : {
            ...item,
            fields: item.fields.map((field) =>
              field.section === section && field.key === key ? { ...field, value } : field,
            ),
          },
    );
    return this.getModConfig(modId);
  },

  async listLogs(): Promise<LogFileInfo[]> {
    await sleep(160);
    return [
      {
        path: `${DEMO_GAME}\\r6\\logs\\redscript.log`,
        name: "redscript.log",
        category: "redscript",
        sizeBytes: 18_240,
        modifiedAt: new Date().toISOString(),
      },
      {
        path: `${DEMO_GAME}\\bin\\x64\\plugins\\cyber_engine_tweaks\\cyber_engine_tweaks.log`,
        name: "cyber_engine_tweaks.log",
        category: "CET",
        sizeBytes: 92_640,
        modifiedAt: new Date(Date.now() - 60_000).toISOString(),
      },
      {
        path: `${DEMO_GAME}\\red4ext\\logs\\red4ext.log`,
        name: "red4ext.log",
        category: "RED4ext",
        sizeBytes: 7_120,
        modifiedAt: new Date(Date.now() - 120_000).toISOString(),
      },
    ];
  },

  async readLogTail(path: string, limit = 100): Promise<LogTail> {
    await sleep(200);
    const isCet = path.toLowerCase().includes("cyber_engine_tweaks");
    const all = isCet
      ? [
          "[INFO] Cyber Engine Tweaks 1.36.1 initializing",
          "[INFO] Lua VM started",
          "[INFO] loaded mod: CyberDeck ReLIT",
          "[WARN] mod 'OldHUD' uses deprecated API",
          "[INFO] overlay ready",
        ]
      : [
          "[INFO] redscript 0.5.27",
          "[INFO] compiling 12 scripts",
          "[WARN] deprecated call in r6/scripts/HUD.reds:42",
          "[ERROR] failed to compile r6/scripts/Broken.reds",
          "  expected ';' at line 18",
          "[INFO] 11 scripts compiled, 1 failed",
        ];
    const lines = all.slice(Math.max(0, all.length - limit)).map((text, index) => ({
      number: index + 1,
      text,
      level: text.includes("[ERROR]")
        ? ("error" as const)
        : text.includes("[WARN]")
          ? ("warn" as const)
          : ("info" as const),
    }));
    return {
      path,
      name: path.split(/[\\/]/).pop() ?? "log",
      lines,
      truncated: all.length > limit,
      fileSizeBytes: 18_240,
      tailLimit: limit,
    };
  },

  // ── 存档管理（浏览器演示）：快照存 localStorage；存档列表用内置演示数据 ──
  async createEnvSnapshot(label?: string): Promise<EnvSnapshot> {
    await sleep(160);
    const snapshots = mockSnapshots();
    const db = loadDb();
    const enabled = db.state.mods.filter((m) => m.enabled);
    const snapshot: EnvSnapshot = {
      id: `snap-${Date.now()}`,
      createdAt: new Date().toISOString(),
      trigger: "manual",
      label: label ?? null,
      modCount: db.state.mods.length,
      enabledCount: enabled.length,
      frameworks: [
        { id: "cet", name: "Cyber Engine Tweaks", version: "1.33.0", installed: true },
        { id: "redscript", name: "redscript", version: "0.5.17", installed: true },
        { id: "archivexl", name: "ArchiveXL", version: "1.14.3", installed: true },
      ],
      mods: enabled.map((m) => ({
        id: m.id,
        name: m.name,
        version: m.version ?? null,
        enabled: m.enabled,
      })),
    };
    snapshots.unshift(snapshot);
    writeSnapshots(snapshots);
    return snapshot;
  },

  async listEnvSnapshots(): Promise<EnvSnapshot[]> {
    await sleep(120);
    return mockSnapshots();
  },

  async applyEnvSnapshot(id: string): Promise<EnvSnapshot> {
    await sleep(400);
    const snapshots = mockSnapshots();
    const target = snapshots.find((s) => s.id === id);
    if (!target) throw new Error("SNAPSHOT_NOT_FOUND");
    // 模拟「应用前自动备份」：先把当前环境存成 preApplySnapshot。
    await mockApi.createEnvSnapshot("Pre-apply auto backup");
    const db = loadDb();
    const wanted = new Set(target.mods.filter((m) => m.enabled).map((m) => m.id));
    db.state.mods = db.state.mods.map((m) => ({ ...m, enabled: wanted.has(m.id) }));
    saveDb(db);
    return target;
  },

  async deleteEnvSnapshot(id: string): Promise<void> {
    await sleep(80);
    writeSnapshots(mockSnapshots().filter((s) => s.id !== id));
  },

  async scanSaveGames(): Promise<SaveScanReport> {
    await sleep(420);
    const now = Date.now() / 1000;
    const db = loadDb();
    const disabled = db.state.mods.filter((m) => !m.enabled).slice(0, 2);
    return {
      scannedAt: new Date().toISOString(),
      root: "%USERPROFILE%\\Saved Games\\CD Projekt Red\\Cyberpunk 2077",
      riskyCount: disabled.length > 0 ? 1 : 0,
      notes: [],
      saves: [
        {
          name: "AutoSave-24",
          path: "…/AutoSave-24",
          lastPlayed: now - 3600 * 5,
          sizeBytes: 6_144_000,
          screenshot: null,
          risks:
            disabled.length > 0
              ? [
                  {
                    kind: "timelineDiff",
                    severity: "warning",
                    modIds: disabled.map((m) => m.id),
                    message: `Enabled at last play, now disabled: ${disabled.map((m) => m.name).join(", ")}`,
                  },
                ]
              : [],
        },
        {
          name: "QuickSave-118",
          path: "…/QuickSave-118",
          lastPlayed: now - 3600 * 30,
          sizeBytes: 6_008_832,
          screenshot: null,
          risks: [],
        },
        {
          name: "ManualSave-9",
          path: "…/ManualSave-9",
          lastPlayed: now - 3600 * 24 * 6,
          sizeBytes: 5_971_968,
          screenshot: null,
          risks: [],
        },
      ],
    };
  },

  async openSaveEditor(): Promise<void> {
    await sleep(80);
  },

  resetDemo(): void {
    localStorage.removeItem(STORAGE_KEY);
    demoIniSections = DEMO_INI_SECTIONS.map((section) => ({
      ...section,
      entries: section.entries.map((entry) => ({ ...entry })),
    }));
  },
};

// ── E3 编译期漂移防护 ────────────────────────────────────────────
// mockApi 必须逐字实现真实 API（api.ts 的 `api`）的方法签名。
// 以后 Rust/TS 侧新增命令而 mock 漏改时，这里会让 tsc 直接报错，
// 而不是等浏览器预览点到了才白屏。
const _mockApiDriftCheck: ApiSurface = mockApi;
void _mockApiDriftCheck;

// ── 演示用快照存储（浏览器 localStorage）────────────────────────────
const SNAPSHOT_KEY = "cyberdeck-demo-snapshots-v1";

function mockSnapshots(): EnvSnapshot[] {
  try {
    return JSON.parse(localStorage.getItem(SNAPSHOT_KEY) ?? "[]") as EnvSnapshot[];
  } catch {
    return [];
  }
}

function writeSnapshots(snapshots: EnvSnapshot[]) {
  // 演示模式同样执行「上限 10」策略，保持与真实行为一致。
  localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(snapshots.slice(0, 10)));
}
