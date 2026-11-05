import type { MessageKey } from "./i18n";

export type LinkType = "hardLink" | "symlink" | "copy";

/** 外观风格与明暗模式的类型定义见 lib/theme.ts，这里转出去方便统一引用。 */
export type { ColorMode, StyleTheme } from "./lib/theme";

export type InstallLayout =
  | "gameRoot"
  | "archive"
  | "redmod"
  | "cet"
  | "redscript"
  | "asi"
  | "red4ext";

export interface DeployedFile {
  source: string;
  target: string;
  linkType: LinkType;
  relativePath: string;
}

/** 整合包登记。子 Mod 仍是普通 ModEntry，靠 modpackId 反向归属：
 *  整合包里的每个 Mod 之后要能单独启用、停用、部署，独立成表会分裂两套生命周期。 */
export interface ModpackEntry {
  id: string;
  name: string;
  sourceZip: string;
  importedAt: string;
  childModIds: string[];
  /** 包内 modlist.txt 解析出的推荐顺序，导入时已映射成子 Mod id。 */
  recommendedOrder: string[];
  status: "importing" | "ready" | "partial" | "failed";
  error: string | null;
  totalFiles: number;
  extractedBytes: number;
}

/** 扫描产出、尚未入库的候选。用户勾选后才走既有安装流程迁进 staging。 */
export interface ScannedModCandidate {
  id: string;
  name: string;
  source: "gameDir" | "vortex";
  path: string;
  layout: InstallLayout;
  sizeBytes: number;
  fileCount: number;
  modFolder: string | null;
  /** 库里已有同名/同路径条目，前端默认不勾选。 */
  alreadyManaged: boolean;
}

export interface ScanReport {
  candidates: ScannedModCandidate[];
  vortexStagingDir: string | null;
  gameScanDirs: string[];
  warnings: string[];
}

export interface TranslateReport {
  requested: number;
  translated: number;
  failed: number;
  /** 已经是中文或已有译名而跳过的数量。 */
  skipped: number;
  model: string;
  errors: string[];
}

export interface NexusRef {
  modId: number;
  fileId: number | null;
  url: string;
  version: string | null;
  /** Nexus 官方封面图；只有从 N 网下载的 Mod 才有，本地导入为 null。 */
  pictureUrl?: string | null;
  /** 上次检查时 Nexus 上的版本号；从未检查过为 null。 */
  latestVersion?: string | null;
  /** 上次检查时间（ISO 8601）；从未检查过为 null。 */
  lastCheck?: string | null;
}

export interface ModEntry {
  id: string;
  /** 展示名。来自文件名时后端已做过清洗（`!!!!_mime.archive` → `Mime`）。 */
  name: string;
  /** 清洗前的原始文件名/文件夹名，只在后端清洗过 name 时有值。 */
  rawName: string | null;
  version: string | null;
  author: string | null;
  category: string;
  /** 用户手动指定过分类：自动重算（智能归类 / 重算全部）会跳过这条。 */
  categoryLocked: boolean;
  description: string;
  sourceZip: string | null;
  nexus: NexusRef | null;
  stagingPath: string;
  coverPath: string | null;
  enabled: boolean;
  installedAt: string;
  updatedAt: string | null;
  sizeBytes: number;
  fileCount: number;
  layout: InstallLayout;
  modFolder: string | null;
  metadataSource: "infoJson" | "filename" | string;
  plannedFiles: string[];
  warnings: string[];
  deployedFiles: DeployedFile[];
  hasArchive: boolean;
  hasRedmod: boolean;
  hasCet: boolean;
  /** 中文译名。null 时前端回退显示 name——绝不把译文写进 name，
   *  因为名字是冲突检测、modlist 写入和路径匹配的依据。 */
  translatedName: string | null;
  translatedAt: string | null;
  translatedBy: string | null;
  /** false = 从游戏目录 / Vortex 扫描到的散装 Mod：可见但禁止部署与卸载。 */
  managed: boolean;
  origin: ModOrigin;
  /** 所属整合包 id；单独导入为 null。 */
  modpackId: string | null;
  /** Nexus 官方封面（https）。为 null 时前端回退到程序生成的封面。 */
  nexusCoverUrl: string | null;
  /** 疑似/已确认的附属汉化包（导入时按名字关键词初判，可手动改）。 */
  isTranslation: boolean;
  /** 绑定的原版模组 id。非 null 时不在主网格单独占位，挂到父级卡片上。 */
  parentModId: string | null;
  /** 已生成的 AI 汉化覆盖层。null = 从未生成。 */
  aiLoc: AiLocState | null;
  /** 已部署的 AI 补丁（每个是独立 .reds 文件，可单独撤销）。 */
  aiFix: AiFixState[];
}

/** AI 汉化覆盖层的登记信息（前端只读这几项做展示与撤销）。 */
export interface AiLocState {
  stagingDir: string;
  translated: number;
  model: string;
  createdAt: string;
}

/** 已部署的 AI 补丁。 */
export interface AiFixState {
  file: { relativePath: string; target: string };
  intent: string;
  model: string;
  createdAt: string;
}

/** AI 汉化：一条待翻译条目。 */
export interface AiLocEntry {
  sourceFile: string;
  secondaryKey: string;
  sourceText: string;
  glossaryHit: string | null;
}

/** AI 汉化：无法自动处理的内容。 */
export interface AiLocBlocked {
  sourceFile: string;
  reason: string;
  sample: string;
}

/** AI 汉化计划（只读扫描结果）。 */
export interface AiLocPlan {
  modId: string;
  modName: string;
  sourceLang: string;
  targetLang: string;
  policy: "allowed" | "denied" | "uncertain";
  policyEvidence: string[];
  entries: AiLocEntry[];
  blocked: AiLocBlocked[];
  glossaryHits: number;
  packingReady: boolean;
  hasOverlay: boolean;
  warnings: string[];
}

/** AI 汉化执行报告。 */
export interface AiLocReport {
  modId: string;
  planned: number;
  translated: number;
  skipped: number;
  written: string[];
  deployed: string[];
  rolledBack: boolean;
  model: string;
  warnings: string[];
  errors: string[];
}

/** AI 补丁提案。 */
export interface AiFixProposal {
  modId: string;
  modName: string;
  intent: string;
  contextChars: number;
  contextFiles: string[];
  code: string;
  structureOk: boolean;
  structureIssues: string[];
  compiler: string | null;
  warnings: string[];
}

/** AI 补丁执行报告。 */
export interface AiFixReport {
  modId: string;
  target: string;
  bytes: number;
  compiled: boolean;
  model: string;
  warnings: string[];
}

/** Mod 的来源。决定它能否被安全卸载。"adopted" = 由「收编」登记的外部部署。 */
export type ModOrigin = "cyberdeck" | "gameDir" | "vortex" | "modpack" | "adopted";

export interface StagingMoveReport {
  from: string;
  to: string;
  moved: number;
  failed: string[];
}

/** 「自动查找」的探测结果。 */
export interface ToolProbe {
  tool: string;
  found: boolean;
  path: string | null;
  message: string;
}

export interface Settings {
  writeModlist: boolean;
  autoBackup: boolean;
  confirmUninstall: boolean;
  /** 点击关闭按钮时的行为：tray = 最小化到托盘，exit = 直接退出。 */
  closeBehavior: "tray" | "exit";
  /** 点 × / Alt+F4 时是否先弹确认（可在弹窗里勾"以后不再询问"）。 */
  closeAsk: boolean;
  launchMethod: "auto" | "steam" | "direct";
  /** 游戏来源平台偏好：只影响自动嗅探顺序与界面提示。 */
  platformPref: "auto" | "steam" | "gog" | "epic" | "manual";
  archiveToolPath: string;
  /** WolvenKit.Cli.exe 路径（可选）。空 = 资源级深度扫描不可用。 */
  wolvenkitCliPath: string;
  /** WolvenKit 单个 archive 的解包超时（秒），后端钳制 10–600。 */
  wolvenkitTimeoutSecs: number;
  aiBaseUrl: string;
  aiModel: string;
  /** AI 接口协议：openai = OpenAI 兼容（默认），anthropic = Anthropic 原生。 */
  aiProtocol: "openai" | "anthropic";
  /** 多套配置的镜像（演示模式用；真实数据一律走 aiProfiles 命令）。 */
  aiProfiles?: AiProfile[];
  activeAiProfileId?: string;
  /** 演示模式下"是否存过 key"。 */
  aiKeyStored?: boolean;
  nexusHideAdult: boolean;
  /** 自定义启动参数（#6）：空格分隔，支持双引号分词，后端白名单校验后逐参传递。 */
  launchArgs: string;
  /** 收到 nxm:// 链接后是否直接下载导入（需要 Nexus Premium）。 */
  nxmAutoDownload: boolean;
  /** 自定义背景图绝对路径。空 = 不启用背景层。 */
  backgroundImage: string;
  /** 背景图不透明度 0–100。 */
  backgroundOpacity: number;
  /** 背景图模糊半径 0–40 px。 */
  backgroundBlur: number;
  /**
   * 背景图填充模式：
   * - `cover`   铺满（默认）：等比放大到盖住窗口，多出来的部分按焦点裁掉；
   * - `contain` 完整显示：等比缩到整张图可见，不满的一侧留白（遮罩仍然生效）；
   * - `stretch` 拉伸：强行铺满窗口，比例不对会变形。
   */
  backgroundFit: "cover" | "contain" | "stretch";
  /** 背景图焦点横坐标 0–100（默认 50）。`stretch` 下无意义但保留值。 */
  backgroundPosX: number;
  /** 背景图焦点纵坐标 0–100（默认 50）。 */
  backgroundPosY: number;
  /**
   * 背景暗化遮罩浓度 0–100（默认 50）。
   *
   * 和 `backgroundOpacity` 是**两个不同维度**：不透明度控制「图片整体多淡」（淡到
   * 一定程度图片就没用了），遮罩控制「图片之上压多黑的一层」（图片照样鲜艳，但中间
   * 隔一层黑，正文才有对比度）。只有后者能同时满足「图好看」和「字能读」。
   */
  backgroundDim: number;
  /** 背景图缩放倍率 1.0–3.0（默认 1.0，3A-3 裁切模态）。>1 时配合焦点做拖拽裁切。 */
  backgroundZoom: number;
  /** 部署方式（deepseek 任务·模块一）：hardlink / symlink / copy。 */
  deployMode: "hardlink" | "symlink" | "copy";
  /** 启动显卡偏好：auto / dedicated / integrated。 */
  launchGpuPref: "auto" | "dedicated" | "integrated";
  /** 游戏进程优先级：normal / high / low。 */
  launchPriority: "normal" | "high" | "low";
  /** 启动前置命令：启动游戏前执行一次的命令行。空 = 不执行。 */
  launchPreCommand: string;
  /** 存档管理（865759）：部署前自动记录环境快照。 */
  autoSnapshot: boolean;
  /** 快照保留上限，超出删最旧（默认 10）。 */
  snapshotLimit: number;
  /** 外部存档编辑器（CyberCAT 等）.exe 绝对路径。空 = 未配置。 */
  saveEditorPath: string;
}

/** 外部工具（deepseek 任务·模块三）。 */
export interface ExternalToolEntry {
  id: string;
  name: string;
  path: string;
  icon: string | null;
  pinned: boolean;
  createdAt: string;
}

/** 磁盘建议（deepseek 任务·模块一）：暂存区候选。 */
export interface DriveSuggestion {
  drive: string;
  freeBytes: number;
  totalBytes: number;
}

export type ModSettingKind = "bool" | "number" | "string";

/** 深度扫描路径解析引用：modId 为 null 表示游戏目录里的未受管文件。 */
export interface DeepScanRef {
  modId: string | null;
  target: string;
}

/** 单个 archive 的资源级扫描结果。error 存在时 resources 为空。 */
export interface ArchiveDeepScan {
  archive: string;
  error: { code: string; message: string } | null;
  resources: string[] | null;
  truncated: boolean;
  totalResources: number;
}

export interface DeepScanReport {
  results: ArchiveDeepScan[];
}

export interface ModSettingEntry {
  section: string;
  key: string;
  value: string;
  kind: ModSettingKind;
}

/**
 * 某个 Mod 的一条可调配置。
 *
 * `section` 只有 ini 来源才有意义；JSON 来源没有分区概念，路径全写在 `key` 里
 * （`hud.scale`），`section` 是空串。
 */
export interface ModConfigField {
  section: string;
  key: string;
  value: string;
  kind: ModSettingKind;
  /** 给人看的标签，后端已经把 `show_minimap` 变成 `show minimap`。 */
  label: string;
}

/** 一个配置文件就是一个来源：Mod Settings 的 user.ini、Mod 自己的 json、AudioXL 的 ini… */
export interface ModConfigSource {
  id: string;
  label: string;
  path: string;
  format: "ini" | "json" | "toml" | string;
  /** 只读来源（Native Interactions / CET 全局配置）不渲染保存按钮。 */
  editable: boolean;
  fields: ModConfigField[];
  raw: string | null;
  note: string | null;
}

export interface ModConfigView {
  modId: string;
  sources: ModConfigSource[];
  warnings: string[];
}

export interface ModSettingSection {
  name: string;
  entries: ModSettingEntry[];
}

export interface ModSettingsView {
  path: string;
  exists: boolean;
  frameworkInstalled: boolean;
  sections: ModSettingSection[];
  warnings: string[];
  backupPath: string | null;
}

export interface LogFileInfo {
  path: string;
  name: string;
  category: string;
  sizeBytes: number;
  modifiedAt: string | null;
}

export interface LogLine {
  number: number;
  text: string;
  level: "error" | "warn" | "info" | "muted";
}

export interface LogTail {
  path: string;
  name: string;
  lines: LogLine[];
  truncated: boolean;
  fileSizeBytes: number;
  tailLimit: number;
}

export interface BackupInfo {
  id: string;
  createdAt: string;
  root: string;
  gameDir: string;
  files: string[];
}

export interface AppStateData {
  schemaVersion: number;
  gameDir: string | null;
  stagingDir: string;
  mods: ModEntry[];
  loadOrder: string[];
  /**
   * REDmod 的加载顺序（存 mod id，先加载的先赢）。
   *
   * 与 `loadOrder` 分开：后者元素是 archive 相对路径，混在一起会被归一化当成脏数据剔除。
   */
  redmodOrder: string[];
  /** 已导入的整合包登记表。子 Mod 仍在 mods 里。 */
  modpacks: ModpackEntry[];
  /** 播放集：每套「启用哪些模组 + 加载顺序」的存档。 */
  profiles: ProfileEntry[];
  /** 当前正在使用的播放集 id。 */
  activeProfileId: string | null;
  settings: Settings;
  lastGameVersion: string | null;
  lastLaunch: string | null;
  backup: BackupInfo | null;
  /** 最近一次检查 Mod 更新的时间（ISO 8601）；从未查过为 null。 */
  lastUpdateCheck: string | null;
}

export interface GameInfo {
  root: string;
  exePath: string;
  version: string | null;
  source: string;
  valid: boolean;
  archiveDir: string | null;
  modsDir: string | null;
  language: string | null;
  gameUpdated: boolean;
  lastGameVersion: string | null;
}

export interface ConflictInfo {
  target: string;
  modId: string;
  modName: string;
  otherModId: string | null;
  otherModName: string | null;
  kind: "managed" | "unmanaged";
  pending: boolean;
}

export interface LoadOrderItem {
  id: string;
  modId: string;
  modName: string;
  filename: string;
  category: string;
  deployed: boolean;
  order: number;
}

export interface LoadOrderView {
  archives: LoadOrderItem[];
  redmods: LoadOrderItem[];
  modlistPath: string | null;
  modlistExists: boolean;
  managedModlist: boolean;
}

export interface DeployReport {
  modEntry: ModEntry;
  deployed: number;
  hardLinks: number;
  symlinks: number;
  copies: number;
  warnings: string[];
  /** true = 暂存文件在外部被删了，记录已被自动清理；卡片要从列表移除。 */
  purged?: boolean;
}

export interface InstallOutcome {
  path: string;
  success: boolean;
  modEntry: ModEntry | null;
  error: string | null;
  errorCode: string | null;
}

export interface FrameworkStatus {
  id: string;
  name: string;
  installed: boolean;
  required: boolean;
  path: string | null;
  version: string | null;
  note: string;
}

export interface DiagnosticIssue {
  id: string;
  severity: "error" | "warning" | "info" | "ok";
  title: string;
  detail: string;
  action: string | null;
}

/** 一条前置依赖要求（Rust 端 deps.rs 产出）。 */
export interface DependencyRequirement {
  /** 框架 id，与 FrameworkStatus.id 对齐；未知框架是规范化后的名字。 */
  id: string;
  name: string;
  /** fileRule | metadata | layout */
  source: string;
  /** 人话依据，例如「包含 .xl 归档声明文件」。 */
  detail: string;
  satisfied: boolean;
  /** game = 游戏目录已装；bundled:<模组名> = 库内某模组自带。 */
  satisfiedBy: string | null;
  requiredVersion: string | null;
  installedVersion: string | null;
  versionOk: boolean;
}

export interface ModDependencyStatus {
  modId: string;
  modName: string;
  enabled: boolean;
  /** healthy | missing | versionMismatch */
  status: "healthy" | "missing" | "versionMismatch";
  requirements: DependencyRequirement[];
  /** 缺失框架的显示名。 */
  missing: string[];
}

export interface DependencyReport {
  checkedAt: string;
  mods: ModDependencyStatus[];
  /** 已启用且缺前置的模组数。 */
  missingEnabled: number;
  /** 已启用且框架版本不满足的模组数。 */
  mismatchEnabled: number;
  checkedMods: number;
}

export interface DiagnosticsReport {
  generatedAt: string;
  game: GameInfo | null;
  frameworks: FrameworkStatus[];
  issues: DiagnosticIssue[];
  summary: string;
  summaryLevel: "error" | "warning" | "info" | "ok";
  deployedMods: number;
  enabledMods: number;
  totalMods: number;
  conflictCount: number;
  logPaths: string[];
  backup: BackupInfo | null;
  /** 前置依赖健康检查结果。旧后端可能没有该字段，前端需容错。 */
  dependencies?: DependencyReport;
}

export interface LaunchResult {
  /** direct / steam / official / already-running */
  method: string;
  detail: string;
  /** steam / gog / epic / manual */
  platform: string;
  /** 直启失败自动回退时为 "direct"，否则 null。 */
  fallbackFrom: string | null;
  notes: string[];
}

/** 启动能力探测结果（只读，不启动任何进程）。 */
export interface LaunchCheck {
  platform: "steam" | "gog" | "epic" | "manual";
  platformLabel: string;
  exePresent: boolean;
  prelauncherPresent: boolean;
  drmClient: string | null;
  drmClientRunning: boolean;
  steamAvailable: boolean;
  canDirect: boolean;
  reasons: string[];
  notes: string[];
}

export interface RestoreResult {
  undeployed: number;
  restoredFiles: number;
  warnings: string[];
}

/** 一条 nxm:// 链接的结构化形态。 */
export interface NxmLink {
  uri: string;
  domain: string;
  modId: number;
  fileId: number | null;
  key: string | null;
  expires: string | null;
  userId: string | null;
}

/** nxm:// 协议处理器归属：us = 本启动器接管中，other = 被别的程序占着。 */
export interface NxmStatus {
  /** 当前处理器是否指向本启动器。 */
  ours: boolean;
  /** 协议本身是否已注册（有键、有命令），不管归属是谁。 */
  registered: boolean;
  owner: "us" | "other" | "none" | string;
  handler: string | null;
  backup: string | null;
  backupAt: string | null;
}

export interface Snapshot {
  state: AppStateData;
  game: GameInfo | null;
  loadOrder: LoadOrderView;
  conflicts: ConflictInfo[];
  demoMode: boolean;
  /** 状态文件读不出来时，原文件被改名保留的路径（用于提示“模组不是被删了”）。 */
  stateRecoveredFrom?: string | null;
}

export interface ModlistExport {
  path: string | null;
  backupPath: string | null;
}

export const CATEGORIES = [
  // 以下取值是持久化数据（写进 launcher-state.json 的 mods[].category，也用于筛选比较），
  // 属 B 类：一个字都不能改。显示映射见 i18n 的 categoryLabel()。
  "全部", // i18n-ignore
  "已启用", // i18n-ignore
  "框架", // i18n-ignore
  "玩法", // i18n-ignore
  "武器", // i18n-ignore
  "服装", // i18n-ignore
  "车辆", // i18n-ignore
  "视觉", // i18n-ignore
  "音频", // i18n-ignore
  "任务", // i18n-ignore
  "工具", // i18n-ignore
  "其他", // i18n-ignore
] as const;

export type Category = (typeof CATEGORIES)[number];

/** 布局的显示名：值只存 key，渲染层用 t(LAYOUT_LABEL_KEY[layout])。 */
export const LAYOUT_LABEL_KEY: Record<InstallLayout, MessageKey> = {
  gameRoot: "layout.gameRoot",
  archive: "layout.archive",
  redmod: "layout.redmod",
  cet: "layout.cet",
  redscript: "layout.redscript",
  asi: "layout.asi",
  red4ext: "layout.red4ext",
};

export interface NexusUser {
  name: string;
  profileUrl: string | null;
  isPremium: boolean;
  isSupporter: boolean;
}

export interface NexusStatus {
  configured: boolean;
  connected: boolean;
  user: NexusUser | null;
  error: string | null;
}

/** 批量回查 Nexus 官方封面的统计结果。
 *  message 由后端组装成中文总结，界面直接展示，前端不再拼文案。 */
export interface NexusCoverRefresh {
  updated: number;
  failed: number;
  skipped: number;
  message: string;
}

/** 「补全 Nexus 信息」的结果统计。 */
export interface NexusEnrichReport {
  scanned: number;
  matched: number;
  updated: number;
  failed: number;
  unmatched: number;
  message: string;
}

export interface NexusModSummary {
  modId: number;
  name: string;
  summary: string;
  author: string;
  version: string;
  category: string;
  pictureUrl: string | null;
  modPageUrl: string | null;
  downloads: number;
  endorsements: number;
  adult: boolean;
  updatedTime: string | null;
  createdTime: string | null;
}

export interface NexusFile {
  fileId: number;
  name: string;
  fileName: string;
  version: string;
  category: string;
  sizeKb: number;
  uploadedTime: string | null;
  primary: boolean;
}

export interface NexusModDetail {
  summary: NexusModSummary;
  description: string;
  files: NexusFile[];
}

export interface NexusDownloadResult {
  outcome: InstallOutcome;
  fileName: string;
  path: string;
  reused: boolean;
}

/** 一个有新版本的模组（#1 更新检查）。只发现 + 引导跳转，不自动安装。 */
export interface NexusUpdateItem {
  entryId: string;
  modId: number;
  name: string;
  currentVersion: string | null;
  latestVersion: string;
  pageUrl: string;
}

export interface NexusUpdateReport {
  checked: number;
  skipped: number;
  failed: number;
  updates: NexusUpdateItem[];
  /** 有 Nexus 来源但本轮配额用完没查的条数（既非「无更新」也非失败）。 */
  stale?: number;
  message: string;
  generatedAt: string;
}

/** 单个模组的更新结果（P5-5B）。 */
export interface UpdateApplyItem {
  entryId: string;
  name: string;
  ok: boolean;
  fromVersion: string | null;
  toVersion: string | null;
  /** 备份 zip 路径；回滚靠它定位。失败时为 null。 */
  backupId: string | null;
  error: string | null;
  /** 更新成功但后续动作（重新部署）出问题时的提示。 */
  warning: string | null;
}

export interface UpdateApplyReport {
  applied: number;
  failed: number;
  items: UpdateApplyItem[];
  message: string;
}

/** 一份旧版本备份（data/update-backups 下的清单）。 */
export interface UpdateBackup {
  entryId: string;
  name: string;
  modId: number;
  fromVersion: string | null;
  toVersion: string | null;
  createdAt: string;
  enabled: boolean;
  archive: string;
}

export interface NexusDownloadProgress {
  modId: number;
  fileId: number;
  received: number;
  total: number | null;
}

/** 下载中心任务状态（r13，与 Rust download_queue::DownloadStatus 对应）。 */
export type DownloadTaskStatus =
  | "queued"
  | "downloading"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

export interface DownloadTask {
  id: string;
  modId: number;
  fileId: number;
  name: string;
  fileName: string;
  status: DownloadTaskStatus;
  received: number;
  total: number | null;
  error: string | null;
  nxmKey: string | null;
  nxmExpires: string | null;
  autoImport: boolean;
  createdAt: number;
  finishedAt: number | null;
  retryAt: number | null;
  retries: number;
}

export interface DownloadQueueSettings {
  concurrency: number;
  autoImport: boolean;
  dir: string | null;
  proxy: string | null;
  /** 单任务限速 MiB/s；0 = 不限（deepseek 任务·模块二）。 */
  speedLimitMbps: number;
}

export interface AiStatus {
  configured: boolean;
  baseUrl: string;
  model: string;
  /** 当前生效的接口协议："openai" | "anthropic"。 */
  protocol: string;
}

export interface AiDiagnosis {
  summary: string;
  likelyCause: string;
  evidence: string[];
  fixSteps: string[];
  /** 可执行的修复动作（已过白名单校验，可能为空）。 */
  actions: AiFixAction[];
  confidence: "high" | "medium" | "low";
  needsMoreInfo: string[];
  model: string;
  generatedAt: string;
  sentChars: number;
  redactions: number;
  contextPreview: string;
}

export type NexusSection = "trending" | "latest_added" | "latest_updated";

/**
 * AI 诊断给出的一条**可执行**修复动作。
 *
 * 安全边界：AI 只能从白名单 kind 里选、只能指向快照里出现过的模组 id；
 * 真正的文件操作全部由 Rust 侧执行，前端只是把动作回传 + 展示确认弹窗。
 */
export interface AiFixAction {
  id: string;
  /** disableMod | enableMod | moveLoadOrder | proposePatch */
  kind: string;
  target: string;
  targetName: string;
  label: string;
  reason: string;
  /** moveLoadOrder 专用：first | last */
  position?: string | null;
}

/** 执行一条 AI 动作的结果。 */
export interface AiActionReport {
  kind: string;
  target: string;
  message: string;
  /** 执行前自动创建的环境快照 id（可据此回滚）。 */
  snapshotId?: string | null;
  /** proposePatch：前端据此提示用户去走 AI 补丁流程。 */
  needsIntent: boolean;
}

/** 「测试 Nexus 连接」结果：失败也返回结构化数据。 */
export interface NexusTestResult {
  ok: boolean;
  statusCode?: number | null;
  latencyMs: number;
  message: string;
  user?: string | null;
}

/** 一套 AI 配置（非机密字段；密钥各自走 DPAPI，不进 state 文件）。 */
export interface AiProfile {
  id: string;
  name: string;
  vendor: string;
  baseUrl: string;
  /** openai | anthropic */
  protocol: string;
  model: string;
}

/** 列表里的一项：多两个只读标记。 */
export interface AiProfileView {
  profile: AiProfile;
  /** 这套配置是否已存了可用密钥。 */
  hasKey: boolean;
  /** 是否是当前激活的那一套。 */
  active: boolean;
}

export interface AiProfileList {
  profiles: AiProfileView[];
  activeId: string;
}

/** 「测试连接」结果：失败也返回结构化数据，不做成异常。 */
export interface AiTestResult {
  ok: boolean;
  statusCode?: number | null;
  latencyMs: number;
  message: string;
  modelCount: number;
}

/** 体检发现的一条文件级问题。 */
export interface EnvIssue {
  modId: string;
  modName: string;
  relativePath: string;
  /**
   * missing | size | time | source_missing
   *
   * - missing / source_missing：真丢了，红
   * - size：大小超出 1KB 容差，黄
   * - time：只有时间戳变化，进灰「提示」档
   */
  kind: string;
  detail: string;
}

/** 一次环境体检的结果。 */
export interface EnvDiagnosis {
  /**
   * healthy | info | warning | critical
   *
   * info 是"有文件状态变化但没有丢失/大小异常"时的灰「提示」档：杀毒软件扫描、
   * 外部工具接管都会改写元数据，游戏照常能跑，不该打黄灯吓人。
   */
  level: string;
  checkedMods: number;
  checkedFiles: number;
  issues: EnvIssue[];
  summary: string;
}

/** 一键自愈的结果。stillBroken 里的条目只能靠重新导入修好。 */
export interface HealReport {
  repaired: number;
  stillBroken: EnvIssue[];
  level: string;
  message: string;
}
/** 播放集：一套「启用哪些 Mod + 加载顺序」的存档。 */
export interface ProfileEntry {
  id: string;
  name: string;
  /** 这套播放集里启用的模组 id，顺序即部署顺序。 */
  enabledModIds: string[];
  /** archive 文件名序列，与 AppStateData.loadOrder 同构。 */
  loadOrder: string[];
  createdAt: string;
  updatedAt: string;
  /** 内置 Default：不可删除、不可改名。 */
  builtin: boolean;
}

/** 播放集列表 + 当前激活项。 */
export interface ProfileList {
  profiles: ProfileEntry[];
  activeProfileId: string | null;
}

/** 切换播放集的结果。 */
export interface SwitchProfileReport {
  profile: ProfileEntry;
  undeployed: number;
  deployed: number;
  warnings: string[];
}

/** 导入播放集（modlist）的结果：matched 对上的条数，unmatched 是没对上的原始 id/名。 */
export interface ProfileImportReport {
  profileName: string;
  matched: number;
  unmatched: string[];
  list: ProfileList;
}

/** 批量启用/禁用的结果：单个失败不中断整批，落在 failed/warnings。 */
export interface BatchEnableReport {
  changed: number;
  failed: string[];
  warnings: string[];
}

/** 收编（Adopt）：一个未受管文件。rel 相对游戏根（archive/pc/mod/…）。 */
export interface AdoptFileRef {
  rel: string;
  sizeBytes: number;
  modifiedTime: number | null;
}

/** 收编候选：1 个 .archive = 1 个候选，同词干 .xl/.xlp 跟随。 */
export interface AdoptCandidate {
  /** "adopt-<fnv1a64 hex>"，重复扫描稳定。 */
  id: string;
  name: string;
  /** 主文件（.archive 或独立 .xl）的相对路径。 */
  archiveRel: string;
  files: AdoptFileRef[];
  sizeBytes: number;
  /** 预判的暂存方式，执行期以实际结果为准。 */
  linkType: LinkType;
  /** 任一文件已被库内条目占有时为 true，默认不勾选。 */
  alreadyManaged: boolean;
}

/** adopt_scan 的返回。copyBytes 是跨卷收编需要真实复制的字节数。 */
export interface AdoptScanReport {
  candidates: AdoptCandidate[];
  totalBytes: number;
  copyBytes: number;
  crossVolume: boolean;
  archiveDir: string;
}

/** 收编执行进度（事件 adopt-progress 的载荷）。 */
export interface AdoptProgress {
  phase: "staging" | "verify" | "register" | "done" | "failed" | "cancelled";
  current: number;
  total: number;
  name: string;
  detail: string;
}

/** 单个候选收编失败的错误载荷（ADOPT_ 前缀错误码）。 */
export interface AdoptError {
  code: string;
  message: string;
}

/** 单个候选的收编结果。adopted=false 且无 error 表示被跳过。 */
export interface AdoptOutcome {
  id: string;
  name: string;
  adopted: boolean;
  error: AdoptError | null;
}

/** adopt_execute 的返回。mods 是本次成功登记的 ModEntry。 */
export interface AdoptReport {
  adopted: number;
  failed: number;
  skipped: number;
  cancelled: boolean;
  outcomes: AdoptOutcome[];
  mods: ModEntry[];
}
// ---------------------------------------------------------------------------
// 存档管理（任务 deepseek_865759，2026-10-30）：环境快照 + 只读存档扫描。
// 与后端 snapshots.rs / saves.rs 一一对应。
// ---------------------------------------------------------------------------

export interface EnvSnapshotMod {
  id: string;
  name: string;
  version: string | null;
  enabled: boolean;
}

export interface EnvSnapshotFramework {
  id: string;
  name: string;
  version: string | null;
  installed: boolean;
}

export interface EnvSnapshot {
  id: string;
  createdAt: string;
  /** manual = 手动；preDeploy = 部署前自动；preApplySnapshot = 回滚前的自动备份。 */
  trigger: "manual" | "preDeploy" | "preApplySnapshot";
  label: string | null;
  modCount: number;
  enabledCount: number;
  frameworks: EnvSnapshotFramework[];
  mods: EnvSnapshotMod[];
}

export type SaveRiskKind = "timelineDiff" | "dependencyGap" | "frameworkGap";
export type SaveRiskSeverity = "info" | "warning" | "critical";

export interface SaveRisk {
  kind: SaveRiskKind;
  severity: SaveRiskSeverity;
  modIds: string[];
  message: string;
}

export interface SaveGameEntry {
  name: string;
  path: string;
  lastPlayed: number;
  sizeBytes: number;
  screenshot: string | null;
  risks: SaveRisk[];
}

export interface SaveScanReport {
  scannedAt: string;
  root: string | null;
  saves: SaveGameEntry[];
  riskyCount: number;
  notes: string[];
}

/** 背景图压缩结果：后端把原图缩到最长边 1920 并转成 JPEG，前端只拿 data URL。 */
export interface BackgroundImage {
  /** `data:image/jpeg;base64,...`。走 data URL 是为了不必放宽 CSP 的资产白名单。 */
  dataUrl: string;
  /** 压缩后的字节数。 */
  size: number;
  /** 原图字节数。 */
  sourceSize: number;
  /** 原图被缩过或转码过。 */
  compressed: boolean;
}
