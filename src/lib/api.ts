import { invoke } from "@tauri-apps/api/core";
import type {
  AdoptCandidate,
  AdoptReport,
  AdoptScanReport,
  AdoptStagingHealth,
  LibraryNormalizeReport,
  VortexTakeoverPreflight,
  VortexMappingReport,
  VortexPrelaunchReport,
  VortexReconcileReport,
  VortexSyncReport,
  VortexSyncStatus,
  VortexRebuildPreview,
  VortexRebuildReport,
  EnvSnapshot,
  SaveScanReport,
  AiDiagnosis,
  AiStatus,
  AiFixProposal,
  AiFixReport,
  AiLocPlan,
  BackgroundImage,
  AiLocReport,
  BackupInfo,
  ConflictInfo,
  DeployReport,
  DiagnosticsReport,
  DeepScanRef,
  DeepScanReport,
  AiActionReport,
  NexusTestResult,
  AiProfile,
  AiProfileList,
  AiTestResult,
  AiFixAction,
  EnvDiagnosis,
  GameInfo,
  HealReport,
  InstallOutcome,
  LaunchCheck,
  LaunchResult,
  NxmLink,
  NxmStatus,
  LoadOrderView,
  LogFileInfo,
  LogTail,
  ModEntry,
  ModConfigView,
  ModSettingsView,
  ModlistExport,
  NexusCoverRefresh,
  NexusEnrichReport,
  NexusUpdateReport,
  UpdateApplyItem,
  UpdateApplyReport,
  UpdateBackup,
  TranslateReport,
  NexusDownloadResult,
  NexusModDetail,
  NexusModSummary,
  NexusSection,
  NexusStatus,
  RestoreResult,
  Settings,
  Snapshot,
  ProfileList,
  ProfileImportReport,
  ExternalToolEntry,
  DriveSuggestion,
  BatchEnableReport,
  SwitchProfileReport, StagingMoveReport, ToolProbe,
  DownloadTask, DownloadQueueSettings } from "../types";
import type { CollectionDeployReport, CollectionPlan } from "./collection";
import { t } from "../i18n";
import { mockApi } from "./mock";
import { normalizeSnapshot } from "./normalize";

export const isTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export class ApiError extends Error {
  code: string;
  conflicts: ConflictInfo[];
  details: unknown;

  constructor(message: string, code = "UNKNOWN", conflicts: ConflictInfo[] = [], details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.conflicts = conflicts;
    this.details = details;
  }
}

export function normalizeError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (typeof error === "object" && error !== null) {
    const record = error as Record<string, unknown>;
    if (typeof record.message === "string") {
      return new ApiError(
        record.message,
        typeof record.code === "string" ? record.code : "COMMAND_FAILED",
        Array.isArray(record.conflicts) ? (record.conflicts as ConflictInfo[]) : [],
        record.details,
      );
    }
  }
  if (error instanceof Error) return new ApiError(error.message);
  return new ApiError(String(error));
}

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  return invoke<T>(command, args);
}

/**
 * 所有「返回整个快照」的命令都必须走这里。
 *
 * 快照是 UI 的唯一数据来源，只要有一个入口漏掉归一化，脏数据就会直达渲染层——
 * 而 `launcher-state.json` 是用户可手改、旧版本迁移过、写入还可能被打断的文件，
 * 一个 `gameDir: 123` 就能让 `bound.trim()` 白屏（见 lib/normalize.ts）。
 * 旧代码只有 `bootstrap` 调了 normalizeSnapshot，另外 5 个命令全部直通 invoke。
 */
async function snapshotCall(
  command: string,
  args?: Record<string, unknown>,
): Promise<Snapshot> {
  return normalizeSnapshot(await call<Snapshot>(command, args));
}

export const api = {
  isDemo: !isTauri,

  async bootstrap(): Promise<Snapshot> {
    // 快照是唯一的状态入口：脏数据必须在这里降级成型，
    // 否则任何一处 (x ?? "").trim() 都可能把整个界面炸成白屏（见 lib/normalize.ts）。
    const raw = isTauri ? await call<Snapshot>("bootstrap") : await mockApi.bootstrap();
    return normalizeSnapshot(raw);
  },

  async refreshGame(): Promise<Snapshot> {
    if (!isTauri) return normalizeSnapshot(await mockApi.refreshGame());
    return snapshotCall("refresh_game");
  },

  async detectGamePath(): Promise<GameInfo | null> {
    if (!isTauri) return mockApi.detectGamePath();
    return call<GameInfo | null>("detect_game_path");
  },

  async setGameDir(path: string): Promise<Snapshot> {
    if (!isTauri) return normalizeSnapshot(await mockApi.setGameDir(path));
    return snapshotCall("set_game_dir", { path });
  },

  async clearGameDir(): Promise<Snapshot> {
    if (!isTauri) return normalizeSnapshot(await mockApi.clearGameDir());
    return snapshotCall("clear_game_dir");
  },

  /** 解除游戏更新熔断：把当前 exe 版本记为已确认版本。 */
  async clearUpdateLock(): Promise<Snapshot> {
    if (!isTauri) return normalizeSnapshot(await mockApi.clearUpdateLock());
    return snapshotCall("clear_update_lock");
  },

  /** 在资源管理器里定位文件或文件夹（后端会校验路径归属）。 */
  async openInExplorer(path: string): Promise<void> {
    if (!isTauri) return mockApi.openInExplorer(path);
    return call<void>("open_in_explorer", { path });
  },

  // ── 播放集 ────────────────────────────────────────────────

  async listProfiles(): Promise<ProfileList> {
    if (!isTauri) return mockApi.listProfiles();
    return call<ProfileList>("list_profiles");
  },

  /** 切换播放集：会撤销当前部署再按目标集合重新部署，耗时较长。 */
  async switchProfile(profileId: string): Promise<SwitchProfileReport> {
    if (!isTauri) return mockApi.switchProfile(profileId);
    return call<SwitchProfileReport>("switch_profile", { profileId });
  },

  async saveProfileState(profileId: string): Promise<ProfileList> {
    if (!isTauri) return mockApi.saveProfileState(profileId);
    return call<ProfileList>("save_profile_state", { profileId });
  },

  async createProfile(name: string, copyCurrent: boolean): Promise<ProfileList> {
    if (!isTauri) return mockApi.createProfile(name, copyCurrent);
    return call<ProfileList>("create_profile", { name, copyCurrent });
  },

  async renameProfile(profileId: string, name: string): Promise<ProfileList> {
    if (!isTauri) return mockApi.renameProfile(profileId, name);
    return call<ProfileList>("rename_profile", { profileId, name });
  },

  async deleteProfile(profileId: string): Promise<ProfileList> {
    if (!isTauri) return mockApi.deleteProfile(profileId);
    return call<ProfileList>("delete_profile", { profileId });
  },

  async duplicateProfile(profileId: string, name: string): Promise<ProfileList> {
    if (!isTauri) return mockApi.duplicateProfile(profileId, name);
    return call<ProfileList>("duplicate_profile", { profileId, name });
  },

  /** 导出播放集（modlist）为 JSON，返回落盘路径。 */
  async exportProfileModlist(profileId: string): Promise<string> {
    if (!isTauri) return mockApi.exportProfileModlist(profileId);
    return call<string>("export_profile_modlist", { profileId });
  },

  /** 从导出文件导入播放集：id 优先、名字兜底对回当前库。 */
  async importProfileModlist(path: string, name?: string): Promise<ProfileImportReport> {
    if (!isTauri) return mockApi.importProfileModlist(path, name);
    return call<ProfileImportReport>("import_profile_modlist", { path, name: name ?? null });
  },

  /** 批量启用/禁用：单个失败不中断整批。 */
  async setModsEnabled(ids: string[], enabled: boolean): Promise<BatchEnableReport> {
    if (!isTauri) return mockApi.setModsEnabled(ids, enabled);
    return call<BatchEnableReport>("set_mods_enabled", { ids, enabled });
  },
  // ── 既有模组收编（Adopt）──────────────────────────────────

  /** 扫描 archive/pc/mod 下的未受管 archive / 独立 .xl，产出收编候选。只读。 */
  async adoptScan(): Promise<AdoptScanReport> {
    if (!isTauri) return mockApi.adoptScan();
    return call<AdoptScanReport>("adopt_scan");
  },

  /**
   * 执行一批收编。进度通过 adopt-progress 事件推送；
   * 后端对游戏目录只读、对暂存区只新增，验证通过前不动任何原始文件。
   */
  async adoptExecute(candidates: AdoptCandidate[]): Promise<AdoptReport> {
    if (!isTauri) return mockApi.adoptExecute(candidates);
    return call<AdoptReport>("adopt_execute", { candidates });
  },

  /** 请求取消当前收编批次：当前模组回滚暂存，已登记的保留。 */
  async adoptCancel(): Promise<boolean> {
    if (!isTauri) return mockApi.adoptCancel();
    return call<boolean>("adopt_cancel");
  },

  /** Vortex 接管体检（P0 只读）：读状态库、算指纹、列出漂移，绝不写盘。 */
  async vortexTakeoverPreflight(): Promise<VortexTakeoverPreflight> {
    if (!isTauri) return mockApi.vortexTakeoverPreflight();
    return call<VortexTakeoverPreflight>("vortex_takeover_preflight");
  },

  /** 暂存区体检（只读）：只列孤儿目录与缺失目录，绝不删除。 */
  async adoptStagingHealth(): Promise<AdoptStagingHealth> {
    if (!isTauri) return mockApi.adoptStagingHealth();
    return call<AdoptStagingHealth>("adopt_staging_health");
  },

  /** 开关 Vortex 接管。开启时会做一次前置校验（Vortex 必须已退出、profile 正确）。 */
  async vortexTakeoverSetEnabled(enabled: boolean): Promise<boolean> {
    if (!isTauri) return mockApi.vortexTakeoverSetEnabled(enabled);
    return call<boolean>("vortex_takeover_set_enabled", { enabled });
  },

  /** 最近一次双写结果、待同步队列与备份清单。 */
  async vortexSyncStatus(): Promise<VortexSyncStatus> {
    if (!isTauri) return mockApi.vortexSyncStatus();
    return call<VortexSyncStatus>("vortex_sync_status");
  },

  /** 重试所有待同步变更。 */
  async vortexSyncRetry(): Promise<VortexSyncReport> {
    if (!isTauri) return mockApi.vortexSyncRetry();
    return call<VortexSyncReport>("vortex_sync_retry");
  },

  /** 用写前快照还原 Vortex 状态库（Vortex 必须已退出）。 */
  async vortexSyncRestore(name: string): Promise<number> {
    if (!isTauri) return mockApi.vortexSyncRestore(name);
    return call<number>("vortex_sync_restore", { name });
  },

  /** P3：全库重新配准 Vortex 目录身份并持久化到 state。 */
  async vortexMappingRebuild(): Promise<VortexMappingReport> {
    if (!isTauri) return mockApi.vortexMappingRebuild();
    return call<VortexMappingReport>("vortex_mapping_rebuild");
  },

  /** P3：把全库启用状态与两套加载顺序一次性镜像到 Vortex。 */
  async vortexSyncFull(): Promise<VortexSyncReport> {
    if (!isTauri) return mockApi.vortexSyncFull();
    return call<VortexSyncReport>("vortex_sync_full");
  },

  /** P3：漂移对账（report 只读）。 */
  async vortexReconcile(strategy: string): Promise<VortexReconcileReport> {
    if (!isTauri) return mockApi.vortexReconcile(strategy);
    return call<VortexReconcileReport>("vortex_reconcile", { strategy });
  },

  /** P3：把控制权交还 Vortex 前的一致性预检（只读）。 */
  async vortexPrelaunchCheck(): Promise<VortexPrelaunchReport> {
    if (!isTauri) return mockApi.vortexPrelaunchCheck();
    return call<VortexPrelaunchReport>("vortex_prelaunch_check");
  },

  /** P4：只读生成「以 Vortex 为准重建库」计划。 */
  async vortexRebuildPreview(): Promise<VortexRebuildPreview> {
    if (!isTauri) return mockApi.vortexRebuildPreview();
    return call<VortexRebuildPreview>("vortex_rebuild_preview");
  },

  /** P4：执行重建（调用方必须先展示计划并拿到用户确认）。 */
  async vortexRebuildApply(): Promise<VortexRebuildReport> {
    if (!isTauri) return mockApi.vortexRebuildApply();
    return call<VortexRebuildReport>("vortex_rebuild_apply");
  },

  /** P4：可还原的整库备份列表。 */
  async vortexRebuildBackups(): Promise<string[]> {
    if (!isTauri) return mockApi.vortexRebuildBackups();
    return call<string[]>("vortex_rebuild_backups");
  },

  /** P4：一键还原到某次重建之前。 */
  async vortexRebuildRestore(name: string): Promise<VortexRebuildReport> {
    if (!isTauri) return mockApi.vortexRebuildRestore(name);
    return call<VortexRebuildReport>("vortex_rebuild_restore", { name });
  },


  /**
   * 库整理：把历史收编产生的「伴生 .xl 独立成条」并回主体，并清掉主体不存在的
   * 失效条目。纯记录操作，游戏目录与暂存文件都不动；启动时会自动执行一次。
   */
  async adoptNormalize(): Promise<LibraryNormalizeReport> {
    if (!isTauri) return { merged: 0, mergedNames: [], removed: [], empty: [] };
    return call<LibraryNormalizeReport>("adopt_normalize");
  },

  /** 环境体检：确认已部署文件还在、没被替换。 */
  async diagnoseEnvironment(): Promise<EnvDiagnosis> {
    if (!isTauri) return mockApi.diagnoseEnvironment();
    return call<EnvDiagnosis>("diagnose_environment");
  },

  /** 一键自愈：能重建的链接直接重建，修不了的原样报告。 */
  async healEnvironment(): Promise<HealReport> {
    if (!isTauri) return mockApi.healEnvironment();
    return call<HealReport>("heal_environment");
  },
  /** 强制修复：撤掉旧链接后按当前清单重新部署。 */
  async repairMod(id: string): Promise<DeployReport> {
    if (!isTauri) return mockApi.repairMod(id);
    return call<DeployReport>("repair_mod", { id });
  },

  async installMods(paths: string[]): Promise<InstallOutcome[]> {
    if (!isTauri) return mockApi.installMods(paths);
    return call<InstallOutcome[]>("install_mods", { paths });
  },

  /** 游戏主进程是否在运行（顶栏按钮状态用）。 */
  async gameProcessRunning(): Promise<boolean> {
    if (!isTauri) return mockApi.gameProcessRunning();
    return call<boolean>("game_process_running");
  },

  /** 结束游戏主进程；返回 true 表示走了强制结束。 */
  async stopGameProcess(): Promise<boolean> {
    if (!isTauri) return mockApi.stopGameProcess();
    return call<boolean>("stop_game_process");
  },

  /** 绑定 / 解绑附属汉化包（parentId 为 null 表示解绑）。 */
  async setTranslationParent(id: string, parentId: string | null): Promise<Snapshot> {
    if (!isTauri) return mockApi.setTranslationParent(id, parentId);
    return call<Snapshot>("set_translation_parent", { id, parentId });
  },

  async setModEnabled(id: string, enabled: boolean): Promise<DeployReport> {
    if (!isTauri) return mockApi.setModEnabled(id, enabled);
    return call<DeployReport>("set_mod_enabled", { id, enabled });
  },

  async uninstallMod(id: string): Promise<void> {
    if (!isTauri) return mockApi.uninstallMod(id);
    return call<void>("uninstall_mod", { id });
  },

  async updateMod(id: string, category?: string, name?: string): Promise<ModEntry> {
    if (!isTauri) return mockApi.updateMod(id, category, name);
    return call<ModEntry>("update_mod", { id, category, name });
  },

  async getLoadOrder(): Promise<LoadOrderView> {
    if (!isTauri) return mockApi.getLoadOrder();
    return call<LoadOrderView>("get_load_order");
  },

  async saveLoadOrder(order: string[]): Promise<LoadOrderView> {
    if (!isTauri) return mockApi.saveLoadOrder(order);
    return call<LoadOrderView>("save_load_order", { order });
  },
  /**
   * 保存 REDmod 加载顺序。后端会顺手重跑一次 redMod 部署，
   * 所以比 archive 的 saveLoadOrder 慢（redMod 要加载 6.5 MB 元数据）。
   */
  async saveRedmodOrder(order: string[]): Promise<LoadOrderView> {
    if (!isTauri) return mockApi.saveRedmodOrder(order);
    return call<LoadOrderView>("save_redmod_order", { order });
  },

  async exportModlist(force = false): Promise<ModlistExport> {    if (!isTauri) return mockApi.exportModlist();
    return call<ModlistExport>("export_modlist", { force });
  },

  async removeModlist(): Promise<boolean> {
    if (!isTauri) return mockApi.removeModlist();
    return call<boolean>("remove_modlist");
  },

  async setWriteModlist(enabled: boolean): Promise<LoadOrderView> {
    if (!isTauri) return mockApi.setWriteModlist(enabled);
    return call<LoadOrderView>("set_write_modlist", { enabled });
  },

  async setSettings(settings: Settings): Promise<Settings> {
    if (!isTauri) return mockApi.setSettings(settings);
    return call<Settings>("set_settings", { settings });
  },

  // ── 存档管理（任务 865759）：快照只存 JSON；存档扫描只读 metadata，不碰 .dat ──
  async createEnvSnapshot(label?: string): Promise<EnvSnapshot> {
    if (!isTauri) return mockApi.createEnvSnapshot(label);
    return call<EnvSnapshot>("create_env_snapshot", { label: label ?? null });
  },

  async listEnvSnapshots(): Promise<EnvSnapshot[]> {
    if (!isTauri) return mockApi.listEnvSnapshots();
    return call<EnvSnapshot[]>("list_env_snapshots");
  },

  async applyEnvSnapshot(id: string): Promise<EnvSnapshot> {
    if (!isTauri) return mockApi.applyEnvSnapshot(id);
    return call<EnvSnapshot>("apply_env_snapshot", { id });
  },

  async deleteEnvSnapshot(id: string): Promise<void> {
    if (!isTauri) return mockApi.deleteEnvSnapshot(id);
    return call<void>("delete_env_snapshot", { id });
  },

  async scanSaveGames(): Promise<SaveScanReport> {
    if (!isTauri) return mockApi.scanSaveGames();
    return call<SaveScanReport>("scan_save_games");
  },

  async openSaveEditor(): Promise<void> {
    if (!isTauri) return mockApi.openSaveEditor();
    return call<void>("open_save_editor");
  },

  /** 读背景图 → data URL（后端校验类型/体积，CSP 不用放宽 asset 协议）。 */
  async readBackgroundImage(path: string): Promise<BackgroundImage> {
    if (!isTauri) return mockApi.readBackgroundImage(path);
    return call<BackgroundImage>("read_background_image", { path });
  },

  async changeStagingDir(newDir: string): Promise<StagingMoveReport> {
    if (!isTauri) return mockApi.changeStagingDir(newDir);
    return call<StagingMoveReport>("change_staging_dir", { newDir });
  },

  async detectTool(tool: "archive" | "wolvenkit"): Promise<ToolProbe> {
    if (!isTauri) return mockApi.detectTool(tool);
    return call<ToolProbe>("detect_tool", { tool });
  },

  async nexusStatus(): Promise<NexusStatus> {
    if (!isTauri) return mockApi.nexusStatus();
    return call<NexusStatus>("nexus_status");
  },

  async setNexusKey(key: string): Promise<NexusStatus> {
    if (!isTauri) return mockApi.setNexusKey(key);
    return call<NexusStatus>("nexus_set_key", { key });
  },

  async clearNexusKey(): Promise<NexusStatus> {
    if (!isTauri) return mockApi.clearNexusKey();
    return call<NexusStatus>("nexus_clear_key");
  },

  async nexusBrowse(section: NexusSection): Promise<NexusModSummary[]> {
    if (!isTauri) return mockApi.nexusBrowse(section);
    return call<NexusModSummary[]>("nexus_browse", { section });
  },

  async nexusDetail(modId: number): Promise<NexusModDetail> {
    if (!isTauri) return mockApi.nexusDetail(modId);
    return call<NexusModDetail>("nexus_detail", { modId });
  },

  async nexusDownload(
    modId: number,
    fileId: number,
    fileName?: string,
  ): Promise<NexusDownloadResult> {
    if (!isTauri) return mockApi.nexusDownload(modId, fileId, fileName);
    return call<NexusDownloadResult>("nexus_download", { modId, fileId, fileName });
  },

  async pruneNexusDownloads(days = 7): Promise<number> {
    if (!isTauri) return mockApi.pruneNexusDownloads();
    return call<number>("nexus_prune_downloads", { days });
  },

  // 批量给库里已有的 Nexus 模组回查官方封面。后端自己挑出缺封面的条目，
  // 前端只需要拿回统计数字和已经拼好的中文总结。
  async refreshNexusCovers(): Promise<NexusCoverRefresh> {
    if (!isTauri) {
      // 演示模式没有真实库可回查，直接给零变更结果，避免假装补过封面。
      return {
        updated: 0,
        failed: 0,
        skipped: 0,
        message: t("mock.noModsToRescan"),
      };
    }
    return call<NexusCoverRefresh>("nexus_refresh_covers");
  },

  /** 批量补全收编进来的模组的 Nexus 元数据（名称/作者/版本/分类/封面）。 */
  async enrichNexusMetadata(): Promise<NexusEnrichReport> {
    if (!isTauri) {
      return {
        scanned: 0,
        matched: 0,
        updated: 0,
        failed: 0,
        unmatched: 0,
        message: t("mock.noModsToEnrich"),
      };
    }
    return call<NexusEnrichReport>("nexus_enrich_metadata");
  },

  /** 从 Vortex 的本地数据库导入模组元数据（需先关闭 Vortex）。 */
  async vortexImportMetadata(): Promise<string> {
    if (!isTauri) return t("mock.vortexUnavailable");
    return call<string>("vortex_import_metadata");
  },

  /** 用粘贴的 Nexus 模组链接补全单个模组信息。 */
  async attachModFromNexus(id: string, url: string): Promise<void> {
    // 演示模式必须真的写进 mock 库：以前这里 `return` 直接成功，界面 toast
    // 「已保存」，刷新后数据回退——典型的假成功，试用者会以为功能坏了。
    if (!isTauri) return mockApi.attachModFromNexus(id, url);
    return call<void>("attach_mod_from_nexus", { id, url });
  },

  /** 手动编辑模组信息；保存后标记为 manual，自动补全不再覆盖。 */
  async updateModMetadata(
    id: string,
    fields: { name: string; author: string; version: string; category: string },
  ): Promise<void> {
    if (!isTauri) return mockApi.updateModMetadata(id, fields);
    return call<void>("update_mod_metadata", { id, ...fields });
  },

  /** #1 批量检查 Nexus 模组更新。只发现 + 引导跳转，后端绝不自动安装。 */
  async nexusCheckUpdates(): Promise<NexusUpdateReport> {
    if (!isTauri) return mockApi.nexusCheckUpdates();
    return call<NexusUpdateReport>("nexus_check_updates");
  },

  /** P5-5B：更新单个模组（下载新版 → 备份旧版 → 替换 → 保持启用状态）。 */
  async nexusApplyUpdate(entryId: string): Promise<UpdateApplyItem> {
    if (!isTauri) return mockApi.nexusApplyUpdate(entryId);
    return call<UpdateApplyItem>("nexus_apply_update", { entryId });
  },

  /** P5-5B：批量更新，单个失败不连坐。 */
  async nexusApplyUpdates(entryIds: string[]): Promise<UpdateApplyReport> {
    if (!isTauri) return mockApi.nexusApplyUpdates(entryIds);
    return call<UpdateApplyReport>("nexus_apply_updates", { entryIds });
  },

  /** P5-5B：回滚到更新前的版本（用最近一次备份）。 */
  async nexusRollbackUpdate(entryId: string): Promise<UpdateApplyItem> {
    if (!isTauri) return mockApi.nexusRollbackUpdate(entryId);
    return call<UpdateApplyItem>("nexus_rollback_update", { entryId });
  },

  /** P5-5B：列出可回滚的备份。 */
  async nexusListUpdateBackups(): Promise<UpdateBackup[]> {
    if (!isTauri) return mockApi.nexusListUpdateBackups();
    return call<UpdateBackup[]>("nexus_list_update_backups");
  },

  /** 智能归类：把兜底的「其他 / 工具」按内容与名称重新推断。返回改动条数。 */
  async reclassifyUnclassified(): Promise<number> {
    if (!isTauri) return mockApi.reclassifyUnclassified();
    return call<number>("reclassify_unclassified");
  },

  /** 重算全部分类（跳过手动锁定过的条目）。返回改动条数。 */
  async reclassifyAll(): Promise<number> {
    if (!isTauri) return mockApi.reclassifyAll();
    return call<number>("reclassify_all");
  },

  /** 手动指定分类。写入后该条目锁定，自动重算不再覆盖。 */
  async setModCategory(id: string, category: string): Promise<string> {
    if (!isTauri) return mockApi.setModCategory(id, category);
    return call<string>("set_mod_category", { id, category });
  },

  /** P6：批量指定分类（写入即锁定，Automatic 分类不再覆盖）。返回改动条数。 */
  async setModsCategory(ids: string[], category: string): Promise<number> {
    if (!isTauri) return mockApi.setModsCategory(ids, category);
    return call<number>("set_mods_category", { ids, category });
  },

  // ── Nexus Collections 集合安装 ────────────────────────────────

  /**
   * 解析集合清单（.collection / .json）。
   *
   * 后端只读地比对清单与本地模组库，产出安装计划：哪些已装、哪些版本对不上、
   * 哪些还缺。它不下载、不安装任何东西——Nexus 不允许非会员走 API 直链，
   * 所以缺的部分只能开网页让用户自己下载。
   */
  async parseCollectionManifest(path: string): Promise<CollectionPlan> {
    if (!isTauri) return mockApi.parseCollectionManifest(path);
    return call<CollectionPlan>("parse_collection_manifest", { path });
  },

  /**
   * 按集合预设顺序部署。
   *
   * ids 是本地 ModEntry.id，顺序即集合 modRules 的拓扑序。后端照这个顺序
   * 重写 modlist.txt 并部署到游戏目录。
   *
   * 返回的是整批的集合级结果（成功几个 / 失败几个 / 警告），
   * 不是单模组的 DeployReport——集合一次要动几十个 Mod，单模组字段没有意义。
   */
  async applyCollectionOrder(ids: string[]): Promise<CollectionDeployReport> {
    if (!isTauri) return mockApi.applyCollectionOrder(ids);
    return call<CollectionDeployReport>("apply_collection_order", { ids });
  },

  /**
   * 批量把 Mod 名称翻成中文。
   *
   * @param consent 必须显式传 true —— 翻译会把 Mod 名称发给 AI 服务，
   *                与诊断走同一条「用户同意」门，后端也会再校验一次。
   * @param onlyIds 只翻这些 Mod；传空数组表示什么都不翻（不会退化成全库）。
   * @param limit   最多翻多少个，用于「先试 20 个」这种渐进操作。
   */
  async translateModNames(
    consent: boolean,
    onlyIds?: string[],
    limit?: number,
  ): Promise<TranslateReport> {
    if (!isTauri) return mockApi.translateModNames(consent, onlyIds, limit);
    return call<TranslateReport>("mods_translate", {
      consent,
      onlyIds: onlyIds ?? null,
      limit: limit ?? null,
    });
  },

  /** AI 汉化（T5）：只读计划，不联网、不落盘。 */
  async aiLocPlan(modId: string): Promise<AiLocPlan> {
    if (!isTauri) return mockApi.aiLocPlan(modId);
    return call<AiLocPlan>("ai_loc_plan", { modId });
  },

  /** AI 汉化（T5）：翻译 + 生成覆盖层 + 打包 + 部署。必须显式同意。 */
  async aiLocApply(
    modId: string,
    consent: boolean,
    policyAck: boolean,
  ): Promise<AiLocReport> {
    if (!isTauri) return mockApi.aiLocApply(modId, consent, policyAck);
    return call<AiLocReport>("ai_loc_apply", { modId, consent, policyAck });
  },

  /** AI 汉化（T5）：撤销覆盖层。 */
  async aiLocRevert(modId: string): Promise<AiLocReport> {
    if (!isTauri) return mockApi.aiLocRevert(modId);
    return call<AiLocReport>("ai_loc_revert", { modId });
  },

  /** AI 补丁（T6）：生成提案（会外发脚本片段）。 */
  async aiFixPropose(modId: string, intent: string): Promise<AiFixProposal> {
    if (!isTauri) return mockApi.aiFixPropose(modId, intent);
    return call<AiFixProposal>("ai_fix_propose", { modId, intent });
  },

  /** AI 补丁（T6）：确认后写入独立 .reds。 */
  async aiFixApply(
    modId: string,
    code: string,
    intent: string,
    acknowledged: boolean,
  ): Promise<AiFixReport> {
    if (!isTauri) return mockApi.aiFixApply(modId, code, intent, acknowledged);
    return call<AiFixReport>("ai_fix_apply", { modId, code, intent, acknowledged });
  },

  /** AI 补丁（T6）：撤销单个补丁。 */
  async aiFixRevert(modId: string, target: string): Promise<AiFixReport> {
    if (!isTauri) return mockApi.aiFixRevert(modId, target);
    return call<AiFixReport>("ai_fix_revert", { modId, target });
  },

  async aiStatus(): Promise<AiStatus> {
    if (!isTauri) return mockApi.aiStatus();
    return call<AiStatus>("ai_status");
  },

  /** 联网拉取服务商的模型 ID 列表（GET /v1/models，模型名永不过时的正解）。 */
  async aiListModels(baseUrl: string, protocol?: "openai" | "anthropic"): Promise<string[]> {
    if (!isTauri) return mockApi.aiListModels(baseUrl);
    return call<string[]>("ai_list_models", { baseUrl, protocol: protocol ?? null });
  },

  async setAiKey(key: string): Promise<AiStatus> {
    if (!isTauri) return mockApi.setAiKey(key);
    return call<AiStatus>("ai_set_key", { key });
  },

  async clearAiKey(): Promise<AiStatus> {
    if (!isTauri) return mockApi.clearAiKey();
    return call<AiStatus>("ai_clear_key");
  },

  async aiDiagnose(
    includeLogs: boolean,
    consent: boolean,
    focus: "conflicts" | "logs" | null = null,
  ): Promise<AiDiagnosis> {
    if (!isTauri) return mockApi.aiDiagnose(includeLogs, consent, focus);
    return call<AiDiagnosis>("ai_diagnose", { includeLogs, consent, focus });
  },

  /**
   * 关闭弹窗选完之后调用：`action` = hide（收进托盘）| exit（彻底退出）。
   * `remember` 为真时后端会记住这次选择，下次不再询问。
   */
  async closeWindowAction(action: "hide" | "exit", remember: boolean): Promise<void> {
    if (!isTauri) return;
    await call<void>("close_window_action", { action, remember });
  },

  /**
   * 测试 Nexus 连接：传了 key 就用它（保存前先验），否则用已存的。
   * 失败不抛错，返回结构化结果，设置页据此显示状态码与原因。
   */
  async nexusTestConnection(key: string | null): Promise<NexusTestResult> {
    if (!isTauri) return mockApi.nexusTestConnection(key);
    return call<NexusTestResult>("nexus_test_connection", { key });
  },

  /** 多套 AI 配置：列表（首次调用会把老状态迁移成一条「默认配置」）。 */
  async aiProfiles(): Promise<AiProfileList> {
    if (!isTauri) return mockApi.aiProfiles();
    return call<AiProfileList>("ai_profiles");
  },

  /** 新增/修改一套配置；`key` 为 null 表示不动已存的密钥。 */
  async aiProfileSave(profile: AiProfile, key: string | null): Promise<AiProfileList> {
    if (!isTauri) return mockApi.aiProfileSave(profile, key);
    return call<AiProfileList>("ai_profile_save", { profile, key });
  },

  async aiProfileDelete(id: string): Promise<AiProfileList> {
    if (!isTauri) return mockApi.aiProfileDelete(id);
    return call<AiProfileList>("ai_profile_delete", { id });
  },

  async aiProfileActivate(id: string): Promise<AiProfileList> {
    if (!isTauri) return mockApi.aiProfileActivate(id);
    return call<AiProfileList>("ai_profile_activate", { id });
  },

  async aiProfileClearKey(id: string): Promise<AiProfileList> {
    if (!isTauri) return mockApi.aiProfileClearKey(id);
    return call<AiProfileList>("ai_profile_clear_key", { id });
  },

  /** 测试连接：不落盘、不改激活态。 */
  async aiProfileTest(profile: AiProfile, key: string | null): Promise<AiTestResult> {
    if (!isTauri) return mockApi.aiProfileTest(profile, key);
    return call<AiTestResult>("ai_profile_test", { profile, key });
  },

  /**
   * 执行一条 AI 动作。后端会再校验一次白名单、并在动磁盘前建环境快照。
   * 调用前必须已经让用户二次确认过。
   */
  async aiApplyAction(action: AiFixAction): Promise<AiActionReport> {
    if (!isTauri) return mockApi.aiApplyAction(action);
    return call<AiActionReport>("ai_apply_action", { action });
  },

  /** 把冲突引用解析成真实存在的 archive 路径（Rust 里 safe_join，前端不做路径运算）。 */
  async resolveDeepScanPaths(refs: DeepScanRef[]): Promise<(string | null)[]> {
    if (!isTauri) return mockApi.resolveDeepScanPaths(refs);
    return call<(string | null)[]>("resolve_deep_scan_paths", { refs });
  },

  /** WolvenKit CLI 资源级深度扫描（异步、限时；未配置 CLI 时报 WOLVENKIT_NOT_CONFIGURED）。 */
  async scanArchiveDeep(archivePaths: string[]): Promise<DeepScanReport> {
    if (!isTauri) return mockApi.scanArchiveDeep(archivePaths);
    return call<DeepScanReport>("scan_archive_deep", { archivePaths });
  },

  async openUrl(url: string): Promise<void> {
    if (!isTauri) {
      window.open(url, "_blank", "noopener,noreferrer");
      return;
    }
    return call<void>("open_url", { url });
  },

  async getModSettings(): Promise<ModSettingsView> {
    if (!isTauri) return mockApi.getModSettings();
    return call<ModSettingsView>("get_mod_settings");
  },

  async saveModSetting(section: string, key: string, value: string): Promise<ModSettingsView> {
    if (!isTauri) return mockApi.saveModSetting(section, key, value);
    return call<ModSettingsView>("save_mod_setting", { section, key, value });
  },

  async restoreModSettings(): Promise<ModSettingsView> {
    if (!isTauri) return mockApi.restoreModSettings();
    return call<ModSettingsView>("restore_mod_settings");
  },

  /** 详情抽屉：读某个 Mod 自己的配置来源（空 sources = 这个 Mod 没有可调参数）。 */
  async getModConfig(modId: string): Promise<ModConfigView> {
    if (!isTauri) return mockApi.getModConfig(modId);
    return call<ModConfigView>("get_mod_config", { modId });
  },

  /**
   * 改某个来源里的一项。只传 sourceId——真实路径由后端重新解析，
   * 因此前端拿不到、也写不了任意路径。
   */
  async saveConfigField(
    modId: string,
    sourceId: string,
    section: string,
    key: string,
    value: string,
  ): Promise<ModConfigView> {
    if (!isTauri) return mockApi.saveConfigField(modId, sourceId, section, key, value);
    return call<ModConfigView>("save_config_field", { modId, sourceId, section, key, value });
  },

  async listLogs(): Promise<LogFileInfo[]> {
    if (!isTauri) return mockApi.listLogs();
    return call<LogFileInfo[]>("list_logs");
  },

  async readLogTail(path: string, limit = 100): Promise<LogTail> {
    if (!isTauri) return mockApi.readLogTail(path, limit);
    return call<LogTail>("read_log_tail", { path, limit });
  },

  async getDiagnostics(): Promise<DiagnosticsReport> {
    if (!isTauri) return mockApi.getDiagnostics();
    return call<DiagnosticsReport>("get_diagnostics");
  },

  async createBackup(): Promise<BackupInfo> {
    if (!isTauri) return mockApi.createBackup();
    return call<BackupInfo>("create_backup");
  },

  async restoreOriginal(): Promise<RestoreResult> {
    if (!isTauri) return mockApi.restoreOriginal();
    return call<RestoreResult>("restore_original");
  },

  async inspectLaunch(): Promise<LaunchCheck> {
    if (!isTauri) return mockApi.inspectLaunch();
    return call<LaunchCheck>("inspect_launch");
  },

  /** nxm:// 协议归属（只读）：设置页用它决定显示「接管」还是「交还」。 */
  async nxmStatus(): Promise<NxmStatus> {
    if (!isTauri) return mockApi.nxmStatus();
    return call<NxmStatus>("nxm_status");
  },

  async nxmTakeover(): Promise<NxmStatus> {
    if (!isTauri) return mockApi.nxmTakeover();
    return call<NxmStatus>("nxm_takeover");
  },

  async nxmRelease(): Promise<NxmStatus> {
    if (!isTauri) return mockApi.nxmRelease();
    return call<NxmStatus>("nxm_release");
  },

  /** 启动时补拉一次已经收到的链接（协议直接拉起本进程时事件会早于监听器）。 */
  async nxmPending(): Promise<NxmLink[]> {
    if (!isTauri) return mockApi.nxmPending();
    return call<NxmLink[]>("nxm_pending");
  },

  /** 处理完就从后端收件箱里删掉，避免下次启动又弹一遍。uri 为空 = 全部清空。 */
  async nxmDismiss(uri?: string | null): Promise<void> {
    if (!isTauri) return mockApi.nxmDismiss(uri);
    return call<void>("nxm_dismiss", { uri: uri ?? null });
  },

  /** 手动投递一条 nxm:// 链接（deepseek 任务·模块二）：拖入 .nxm 文件后走这里。 */
  async nxmIntake(uri: string): Promise<NxmLink> {
    if (!isTauri) return mockApi.nxmIntake(uri);
    return call<NxmLink>("nxm_intake", { uri });
  },

  /** 从本地 .nxm 文件批量投递（deepseek 任务·模块二）。仅 Tauri 环境可读盘。 */
  async nxmIntakeFile(path: string): Promise<NxmLink[]> {
    if (!isTauri) return mockApi.nxmIntakeFile(path);
    return call<NxmLink[]>("nxm_intake_file", { path });
  },

  async launchGame(): Promise<LaunchResult> {
    if (!isTauri) return mockApi.launchGame();
    return call<LaunchResult>("launch_game");
  },

  async openPath(path: string): Promise<void> {
    if (!isTauri) return mockApi.openPath();
    return call<void>("open_path", { path });
  },

  async openLogsFolder(): Promise<void> {
    if (!isTauri) return mockApi.openLogsFolder();
    return call<void>("open_logs_folder");
  },

  async revealMod(id: string): Promise<void> {
    if (!isTauri) return mockApi.revealMod();
    return call<void>("reveal_mod", { id });
  },

  async appDataDir(): Promise<string> {
    if (!isTauri) return mockApi.appDataDir();
    return call<string>("app_data_dir");
  },

  // ── 下载中心队列（r13）────────────────────────────────────

  async downloadQueueList(): Promise<DownloadTask[]> {
    if (!isTauri) return mockApi.downloadQueueList();
    return call<DownloadTask[]>("download_queue_list");
  },

  async downloadQueueAdd(
    modId: number,
    fileId: number,
    name?: string,
    key?: string,
    expires?: string,
    autoImport?: boolean,
  ): Promise<DownloadTask> {
    if (!isTauri) return mockApi.downloadQueueAdd(modId, fileId, name, key, expires, autoImport);
    return call<DownloadTask>("download_queue_add", { modId, fileId, name, key, expires, autoImport });
  },

  async downloadQueuePause(id: string): Promise<DownloadTask | null> {
    if (!isTauri) return mockApi.downloadQueuePause(id);
    return call<DownloadTask | null>("download_queue_pause", { id });
  },

  async downloadQueueResume(id: string): Promise<DownloadTask | null> {
    if (!isTauri) return mockApi.downloadQueueResume(id);
    return call<DownloadTask | null>("download_queue_resume", { id });
  },

  async downloadQueueCancel(id: string): Promise<DownloadTask | null> {
    if (!isTauri) return mockApi.downloadQueueCancel(id);
    return call<DownloadTask | null>("download_queue_cancel", { id });
  },

  async downloadQueueRemove(id: string): Promise<boolean> {
    if (!isTauri) return mockApi.downloadQueueRemove(id);
    return call<boolean>("download_queue_remove", { id });
  },

  async downloadQueueClearFinished(): Promise<number> {
    if (!isTauri) return mockApi.downloadQueueClearFinished();
    return call<number>("download_queue_clear_finished");
  },

  async downloadQueueGetSettings(): Promise<DownloadQueueSettings> {
    if (!isTauri) return mockApi.downloadQueueGetSettings();
    return call<DownloadQueueSettings>("download_queue_settings_get");
  },

  async downloadQueueSetSettings(
    concurrency: number,
    autoImport: boolean,
    dir?: string | null,
    proxy?: string | null,
    speedLimitMbps?: number,
  ): Promise<DownloadQueueSettings> {
    if (!isTauri)
      return mockApi.downloadQueueSetSettings(concurrency, autoImport, dir, proxy, speedLimitMbps);
    return call<DownloadQueueSettings>("download_queue_settings_set", {
      concurrency,
      autoImport,
      dir,
      proxy,
      speedLimitMbps: speedLimitMbps ?? null,
    });
  },

  /** 暂存区建议（deepseek 任务·模块一）：固定磁盘按剩余空间降序。 */
  async suggestStagingDir(): Promise<DriveSuggestion[]> {
    if (!isTauri) return mockApi.suggestStagingDir();
    return call<DriveSuggestion[]>("suggest_staging_dir");
  },

  // ── 外部工具（deepseek 任务·模块三）──────────────────────────
  async externalToolsList(): Promise<ExternalToolEntry[]> {
    if (!isTauri) return mockApi.externalToolsList();
    return call<ExternalToolEntry[]>("external_tools_list");
  },
  async externalToolAdd(name: string, path: string, icon?: string): Promise<ExternalToolEntry[]> {
    if (!isTauri) return mockApi.externalToolAdd(name, path, icon);
    return call<ExternalToolEntry[]>("external_tool_add", { name, path, icon: icon ?? null });
  },
  async externalToolUpdate(
    id: string,
    patch: { name?: string; icon?: string; pinned?: boolean },
  ): Promise<ExternalToolEntry[]> {
    if (!isTauri) return mockApi.externalToolUpdate(id, patch);
    return call<ExternalToolEntry[]>("external_tool_update", {
      id,
      name: patch.name ?? null,
      icon: patch.icon ?? null,
      pinned: patch.pinned ?? null,
    });
  },
  async externalToolRemove(id: string): Promise<ExternalToolEntry[]> {
    if (!isTauri) return mockApi.externalToolRemove(id);
    return call<ExternalToolEntry[]>("external_tool_remove", { id });
  },
  async externalToolLaunch(id: string): Promise<void> {
    if (!isTauri) return mockApi.externalToolLaunch(id);
    return call<void>("external_tool_launch", { id });
  },
};

export { mockApi };

/** 真实 API 的类型面。mock.ts 用它做编译期漂移防护（E3）：
 *  新增命令只加在这里、mock 漏实现时，tsc 会直接报错。 */
export type ApiSurface = typeof api;
