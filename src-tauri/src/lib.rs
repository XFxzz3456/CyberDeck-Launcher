mod adopt;
mod vortex_source;
mod vortex_mirror;
mod vortex_sync;
mod vortex_rebuild;
mod ai;
mod aiact;
mod aiprofile;
mod aifix;
mod ailoc;
mod ailabel;
mod ailoc_full;
mod backfill;
mod multipart;
mod backup;
mod pack;
mod category;
mod collection;
mod compat;
mod config_pack;
mod config_resolver;
mod covers;
mod deps;
mod diagnostics;
mod download_queue;
mod game;
mod gamever;
mod glossary;
mod installer;
mod loadorder;
mod loadsort;
mod logs;
mod environment;
mod profiles;
mod redmod;
mod safemode;
mod modname;
mod modsettings;
mod nexus;
mod nexus_browser;
mod nxm;
mod saves;
mod schema;
mod snapshots;
mod selfcheck;
mod secret;
mod store;
mod translation;
mod vortex;
mod updates;
mod vercmp;
mod wolvenkit;

use config_resolver::{GlobalConfigGroups, ModConfigView};
use schema::{
    AiProfileList,
    AdoptCandidate, AdoptReport, AdoptScanReport, AdoptStagingHealth,
    LibraryNormalizeReport, VortexCoverageReport, VortexTakeoverPreflight, VortexMappingReport,
    VortexPrelaunchReport, VortexReconcileReport, VortexSyncReport,
    VortexRebuildPreview, VortexRebuildReport,
    VortexSyncStatus,
    AiDiagnosis, AiStatus, AppResult, AppStateData, BackupInfo, CommandError, DeployReport,
    DiagnosticsReport, EnvDiagnosis, GameInfo, HealReport, InstallOutcome,
    ProfileList, SwitchProfileReport,
    LaunchResult, LoadOrderSuggestion, LoadOrderView,
    LogFileInfo, LogTail, ModEntry, ModSettingsView, NexusCoverRefresh,
    NexusUpdateReport,
    NexusDownloadResult, NexusModDetail, NexusModSummary, NexusStatus, PhysicalSyncReport,
    RestoreResult, Settings,
    Snapshot, TranslateReport,
};
use updates::{UpdateApplyItem, UpdateApplyReport};
use collection::{CollectionDeployReport, CollectionPlan};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;
use store::Store;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, Mutex,
};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, State, Theme, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ModlistExport {
    path: Option<String>,
    backup_path: Option<String>,
}

fn current_game(state: &AppStateData) -> AppResult<GameInfo> {
    let Some(root) = state.game_dir.as_deref() else {
        return Err(CommandError::new(
            "GAME_NOT_CONFIGURED",
            "还没有定位游戏目录。请先到「设置」选择 Cyberpunk 2077 根目录。",
        ));
    };
    if !Path::new(root).is_dir() {
        return Err(CommandError::new(
            "GAME_DIR_MISSING",
            format!("游戏目录不存在或已移动：{root}"),
        ));
    }
    game::validate_game_dir(Path::new(root))
}

fn build_snapshot(store: &Store) -> AppResult<Snapshot> {
    let mut data = store.data.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone();
    let game = match data.game_dir.as_deref() {
        Some(root) if game::detected_exe(Path::new(root)).is_file() => Some(game::inspect_game(
            Path::new(root),
            "manual",
            data.last_game_version.as_deref(),
        )),
        _ => {
            let auto = game::detect_game(None, data.last_game_version.as_deref());
            if let Some(info) = &auto {
                data.game_dir = Some(info.root.clone());
                store.save(&data)?;
            }
            auto
        }
    };
    let game_root = game.as_ref().map(|info| PathBuf::from(&info.root));
    let load_order = loadorder::build_view(&data, game_root.as_deref());
    let conflicts = installer::collect_conflicts(&data.mods);
    Ok(Snapshot {
        state: data,
        game,
        load_order,
        conflicts,
        demo_mode: false,
        state_recovered_from: store.recovered_from().map(str::to_string),
    })
}

/// 物理状态自同步：把数据库拉回和磁盘一致的状态。
///
/// 启动和手动刷新各跑一次。失败只记日志、不阻断启动——这一步是「顺手把脏数据
/// 擦干净」，不能反过来变成新的启动故障点。
fn run_physical_sync(store: &Store) -> AppResult<PhysicalSyncReport> {
    let game_root = store.snapshot_data().game_dir.map(PathBuf::from);
    let report = installer::sync_physical_state(store, game_root.as_deref())?;
    if report.touched() || !report.warnings.is_empty() {
        log_startup(
            &store.data_dir,
            &format!(
                "stage=sync removed={} repaired={} deferred={} warnings={}",
                report.removed.len(),
                report.repaired.len(),
                report.deferred.len(),
                report.warnings.len()
            ),
        );
    }
    Ok(report)
}

#[tauri::command]
fn sync_physical_state(store: State<'_, Store>) -> AppResult<PhysicalSyncReport> {
    run_physical_sync(&store)
}

#[tauri::command]
fn bootstrap(store: State<'_, Store>) -> AppResult<Snapshot> {
    // 先把库拉回和磁盘一致：玩家很可能在上次退出后用 Vortex 删过文件。
    if let Err(err) = run_physical_sync(&store) {
        eprintln!("physical sync failed: {err:?}");
    }
    // 库整理：2026-11-06 之前的收编把 ArchiveXL 的伴生元数据（X.archive.xl）
    // 记成了独立条目，库里的模组数因此虚高（实机 119 条里 37 条是这种碎片）。
    // 合并是纯 state 操作、幂等、不碰游戏目录，放启动时跑一次最省事——
    // 用户不需要知道曾经有过这个 bug，只该看到数字是对的。
    match adopt::normalize_library(store.inner()) {
        Ok(report) if report.merged > 0 => {
            log_startup(
                &store.data_dir,
                &format!("stage=adopt-normalize merged={}", report.merged),
            );
        }
        Ok(_) => {}
        Err(err) => eprintln!("adopt normalize failed: {err:?}"),
    }
    // 前端挂载后第一个调用的命令：这行日志等于"UI 真的起来了"的心跳，
    // 一旦界面白屏/连不上 devUrl，日志里就不会出现 stage=frontend。
    let snapshot = build_snapshot(&store)?;
    log_startup(
        &store.data_dir,
        &format!("stage=frontend mods={}", snapshot.state.mods.len()),
    );
    Ok(snapshot)
}

#[tauri::command]
fn refresh_game(store: State<'_, Store>) -> AppResult<Snapshot> {
    if let Err(err) = run_physical_sync(&store) {
        eprintln!("physical sync failed: {err:?}");
    }
    build_snapshot(&store)
}

#[tauri::command]
fn detect_game_path(store: State<'_, Store>) -> AppResult<Option<GameInfo>> {
    let data = store.snapshot_data();
    Ok(game::detect_game_with_platform(
        None,
        data.last_game_version.as_deref(),
        &data.settings.platform_pref,
    ))
}

#[tauri::command]
fn set_game_dir(store: State<'_, Store>, path: String) -> AppResult<Snapshot> {
    let info = game::validate_game_dir(Path::new(&path))?;
    let mut data = store.data.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if data.mods.iter().any(|entry| !entry.deployed_files.is_empty()) {
        return Err(CommandError::new(
            "GAME_DIR_LOCKED",
            "还有模组部署在旧目录里。请先在「模组库」里全部禁用，或点「恢复原始状态」，再切换游戏目录。",
        ));
    }
    let changed = data
        .game_dir
        .as_deref()
        .map(|old| !old.eq_ignore_ascii_case(&info.root))
        .unwrap_or(true);
    data.game_dir = Some(info.root.clone());
    if changed {
        data.last_game_version = None;
    }
    store.save(&data)?;
    drop(data);
    build_snapshot(&store)
}

#[tauri::command]
fn clear_game_dir(store: State<'_, Store>) -> AppResult<Snapshot> {
    let mut data = store.data.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if data.mods.iter().any(|entry| !entry.deployed_files.is_empty()) {
        return Err(CommandError::new(
            "GAME_DIR_LOCKED",
            "还有模组部署中，不能直接清除游戏目录。",
        ));
    }
    data.game_dir = None;
    data.last_game_version = None;
    store.save(&data)?;
    drop(data);
    build_snapshot(&store)
}

/// 导入一批压缩包（解压 + 落暂存区 + 登记）。
///
/// `async` + `spawn_blocking`：解压/哈希是分钟级磁盘操作，同步命令会把窗口事件
/// 循环一起卡住（2026-11-10 自检 P1-3）。批量启用 `set_mods_enabled` 早就这么做了，
/// 单条链路补齐同一口径。
#[tauri::command]
async fn install_mods(app: tauri::AppHandle, paths: Vec<String>) -> AppResult<Vec<InstallOutcome>> {
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let store = handle.state::<Store>();
        let busy = handle.state::<BusyTasks>();
        let _guard = busy.begin("安装模组");
        install_mods_blocking(store.inner(), &paths)
    })
    .await
    .map_err(|err| CommandError::new("INSTALL_TASK", format!("安装线程异常：{err}")))?
}

fn install_mods_blocking(store: &Store, paths: &[String]) -> AppResult<Vec<InstallOutcome>> {
    let mut outcomes = Vec::new();
    let mut installed: Vec<ModEntry> = Vec::new();
    for path in paths {
        match installer::install_zip(store, path) {
            Ok(entry) => {
                outcomes.push(InstallOutcome {
                    path: path.clone(),
                    success: true,
                    mod_entry: Some(entry.clone()),
                    error: None,
                    error_code: None,
                });
                installed.push(entry);
            }
            Err(err) => outcomes.push(InstallOutcome {
                path: path.clone(),
                success: false,
                mod_entry: None,
                error: Some(err.message),
                error_code: Some(err.code),
            }),
        }
    }
    if !installed.is_empty() {
        let mut data = store.data.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        data.mods.extend(installed);
        store.save(&data)?;
    }
    Ok(outcomes)
}

// ── Nexus Collections（collection.json 清单）─────────────────────────
// 整合包生态走的是 Nexus Collections 规范：一个 JSON 清单描述要用哪些 Mod
// 以及它们之间的加载顺序，Mod 本体仍然走各自的下载/导入流程。

/// 解析一份 Nexus Collection 清单，并和本地模组库比对。
///
// ── 整合包导出 / 导入（2026-11-11）────────────────────────────────
//
// 与 Nexus Collections 的关系：`.collection` 我们能读（上面的向导），但导不出
// 「N 网官网一键添加」的包——那要经 Vortex 上传到 Nexus 审核发布，客户端做不了。
// 所以自有格式 `.cdlist` / `.cdpack`，同时保留对方的 `.collection` 能装。

/// 联网检索时的限速提示文案：宁可在 UI 上说清楚慢，也不要静默等半天。
#[tauri::command]
async fn nexus_backfill_propose(
    app: tauri::AppHandle,
    use_remote: bool,
) -> AppResult<backfill::BackfillReport> {
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let store = handle.state::<Store>();
        let busy = handle.state::<BusyTasks>();
        let _guard = busy.begin("回填 Nexus 编号");
        backfill::propose(store.inner(), use_remote)
    })
    .await
    .map_err(|err| CommandError::new("BACKFILL_TASK", format!("回填线程异常：{err}")))?
}

#[tauri::command]
async fn nexus_backfill_apply(
    app: tauri::AppHandle,
    proposals: Vec<backfill::BackfillProposal>,
) -> AppResult<usize> {
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let store = handle.state::<Store>();
        backfill::apply(store.inner(), &proposals)
    })
    .await
    .map_err(|err| CommandError::new("BACKFILL_TASK", format!("回填线程异常：{err}")))?
}

/// 导出一份整合包。`kind` 传 `list` / `full`。
///
/// 完整包是重活（实测库 3.5 GB），放 blocking 线程 + 进度事件，前端据此画进度条。
#[tauri::command]
async fn pack_export(
    app: tauri::AppHandle,
    kind: pack::PackKind,
    name: String,
    author: Option<String>,
    include_unlisted: Option<bool>,
    out_path: Option<String>,
) -> AppResult<pack::PackExportReport> {
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let store = handle.state::<Store>();
        let busy = handle.state::<BusyTasks>();
        let _guard = busy.begin("导出整合包");
        let author = author.unwrap_or_default();
        let include_unlisted = include_unlisted.unwrap_or(kind == pack::PackKind::Full);
        let app_version = env!("CARGO_PKG_VERSION");
        let manifest = pack::build_manifest(
            store.inner(),
            kind,
            &name,
            &author,
            app_version,
            include_unlisted,
        )?;
        let out = out_path.map(PathBuf::from);
        let mut emit = |done: usize, total: usize, label: &str| {
            let _ = handle.emit(
                "pack-export-progress",
                serde_json::json!({
                    "done": done,
                    "total": total,
                    "label": label,
                    "kind": match kind { pack::PackKind::List => "list", pack::PackKind::Full => "full" },
                }),
            );
        };
        let report = match kind {
            pack::PackKind::List => pack::export_list(store.inner(), manifest, out.as_deref()),
            pack::PackKind::Full => {
                pack::export_full(store.inner(), manifest, out.as_deref(), &mut emit)
            }
        }?;
        Ok(report)
    })
    .await
    .map_err(|err| CommandError::new("PACK_TASK", format!("导出线程异常：{err}")))?
}

#[tauri::command]
fn pack_preview(store: State<'_, Store>, path: String) -> AppResult<pack::PackPreview> {
    pack::preview(store.inner(), Path::new(&path))
}

/// 安装完整包里的本体。`keys` 为空表示「缺什么装什么」。
#[tauri::command]
async fn pack_install(
    app: tauri::AppHandle,
    path: String,
    keys: Option<Vec<String>>,
) -> AppResult<pack::PackInstallReport> {
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let store = handle.state::<Store>();
        let busy = handle.state::<BusyTasks>();
        let _guard = busy.begin("安装整合包");
        let mut emit = |done: usize, total: usize, label: &str| {
            let _ = handle.emit(
                "pack-install-progress",
                serde_json::json!({ "done": done, "total": total, "label": label }),
            );
        };
        pack::install_missing(
            store.inner(),
            Path::new(&path),
            keys.as_deref(),
            &mut emit,
        )
    })
    .await
    .map_err(|err| CommandError::new("PACK_TASK", format!("安装线程异常：{err}")))?
}

/// 把缺失项压进下载队列。`premium` 为 false 时只返回需要手动打开的页面列表。
#[tauri::command]
fn pack_queue_downloads(
    store: State<'_, Store>,
    path: String,
    premium: bool,
) -> AppResult<pack::PackQueueReport> {
    pack::queue_downloads(store.inner(), Path::new(&path), premium)
}

/// 免费号的引导队列：只拿「该打开哪些页面」。
#[tauri::command]
fn pack_manual_pages(store: State<'_, Store>, path: String) -> AppResult<Vec<pack::PackManualItem>> {
    pack::manual_pages(store.inner(), Path::new(&path))
}

/// 应用清单：启停 + 加载顺序 + 配置值。全部就位后再统一调用，避免半截状态。
#[tauri::command]
async fn pack_apply(
    app: tauri::AppHandle,
    path: String,
) -> AppResult<pack::PackApplyReport> {
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let store = handle.state::<Store>();
        let busy = handle.state::<BusyTasks>();
        let _guard = busy.begin("应用整合包");
        pack::apply(store.inner(), Path::new(&path))
    })
    .await
    .map_err(|err| CommandError::new("PACK_TASK", format!("应用线程异常：{err}")))?
}

/// `path` 指向 `collection.json`。清单里写错游戏（domainName 不是
/// cyberpunk2077）时直接报 `WRONG_GAME`，不给出半可用的计划。
#[tauri::command]
fn parse_collection_manifest(
    store: State<'_, Store>,
    path: String,
) -> AppResult<CollectionPlan> {
    let manifest = collection::read_manifest(&path)?;
    collection::validate_domain(&manifest)?;
    Ok(collection::plan_collection(store.inner(), &manifest))
}

/// 按清单给出的顺序重写 modlist.txt 并完成部署。
///
/// `ids` 是本地 ModEntry 的 id（不是 Nexus 的 modId），顺序即加载顺序。
///
/// 返回**整批**的集合级结果（`CollectionDeployReport`）：成功几个、失败几个、
/// 汇总警告、以及最终落盘的 Mod 顺序。前端不依赖单个 Mod 的字段。
///
/// 复用既有流程，不另写一套部署逻辑：
/// - 部署走 `installer::deploy_mod`（冲突检查、备份、落链接都在里面）；
/// - 写 modlist.txt 走 `loadorder::write_modlist`（它负责保持 ASCII 排序
///   兜底、以及拒绝覆盖不是本启动器写的 modlist.txt）。
///
/// 锁的使用：`store.snapshot_data()` 取短快照后释放锁，文件 IO 全在锁外做。
#[tauri::command]
async fn apply_collection_order(
    app: tauri::AppHandle,
    busy: State<'_, BusyTasks>,
    ids: Vec<String>,
) -> AppResult<CollectionDeployReport> {
    let _guard = busy.begin("部署集合");
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let store = handle.state::<Store>();
        apply_collection_order_inner(store.inner(), &ids)
    })
    .await
    .map_err(|err| CommandError::new("COLLECTION_TASK", format!("整合包部署线程异常：{err}")))?
}

/// `apply_collection_order` 的实际实现（跑在阻塞线程池里）。
fn apply_collection_order_inner(
    store: &Store,
    ids: &[String],
) -> AppResult<CollectionDeployReport> {
    if ids.is_empty() {
        return Err(CommandError::new(
            "COLLECTION_ORDER_EMPTY",
            "没有要部署的模组。",
        ));
    }

    // 取短快照后立刻放锁：后面的部署和写文件都是重 IO，不能占着锁。
    let data = store.snapshot_data();
    let game = current_game(&data)?;
    let game_root = PathBuf::from(&game.root);

    // 先确认 id 都对得上，别部署到一半才发现有个不存在的。
    let mut targets: Vec<String> = Vec::with_capacity(ids.len());
    for id in ids {
        if !data.mods.iter().any(|entry| entry.id == *id) {
            return Err(CommandError::new(
                "MOD_NOT_FOUND",
                format!("找不到这个模组：{id}"),
            ));
        }
        targets.push(id.clone());
    }

    // 动 modlist.txt 之前先确认它是我们写的。write_modlist 自己也会拦，
    // 但那已经太晚了——模组都部署完了才报错，等于做了一半。
    // 用户要接管的话走「备份并接管」（export_modlist）那条路。
    let modlist_path = game_root.join("archive").join("pc").join("mod").join("modlist.txt");
    if modlist_path.is_file() {
        let managed = std::fs::read_to_string(&modlist_path)
            .map(|raw| loadorder::is_managed_modlist(&raw))
            .unwrap_or(false);
        if !managed {
            return Err(CommandError::new(
                "MODLIST_UNMANAGED",
                "archive/pc/mod/modlist.txt 已存在，而且不是本启动器写的。为避免破坏你的加载顺序，已停止写入；请在设置里选择「备份并接管」。",
            ));
        }
    }

    // 逐个部署。deploy_mod 自己管锁、冲突检查和回滚，这里不重复造轮子；
    // 也不能在持有 store 锁时调它（std Mutex 不可重入）。
    //
    // 单个 Mod 部署失败（比如文件冲突）不中断整批：集合有几十个 Mod，
    // 一个有冲突不该让其余的全白做。失败记进 failed + warnings。
    let mut report = CollectionDeployReport::default();
    let mut deployed_ids: Vec<String> = Vec::with_capacity(targets.len());
    for id in &targets {
        match installer::deploy_mod(store, id, &game) {
            Ok(single) => {
                report.deployed += 1;
                report.warnings.extend(single.warnings);
                deployed_ids.push(id.clone());
            }
            Err(err) => {
                report.failed += 1;
                let name = data
                    .mods
                    .iter()
                    .find(|entry| &entry.id == id)
                    .map(|entry| entry.name.clone())
                    .unwrap_or_else(|| id.clone());
                report.warnings.push(format!("{name} 部署失败：{}", err.message));
            }
        }
    }

    // 按传入顺序重写 modlist.txt。
    //
    // load_order 存的是 archive 的相对路径，不是 Mod id。所以要把
    // 「Mod 顺序」翻译成「这些 Mod 部署出来的 archive 相对路径顺序」，
    // 再交给 write_modlist 落盘——它会把清单里没提到的 archive 按 ASCII
    // 追加到后面，并在目标文件不是本启动器写的时拒绝覆盖。
    let data = store.snapshot_data();
    let mut ordered_paths: Vec<String> = Vec::new();
    for id in &deployed_ids {
        let Some(entry) = data.mods.iter().find(|item| item.id == *id) else {
            continue;
        };
        for file in &entry.deployed_files {
            if file.relative_path.to_ascii_lowercase().ends_with(".archive") {
                ordered_paths.push(file.relative_path.clone());
            }
        }
    }
    report.order = deployed_ids;

    // 落盘前过一遍 normalized_order —— 清单没提到的、已经部署的 archive
    // 会按 ASCII 排到后面，和 save_load_order 的做法保持一致。
    //
    // 文件 IO 一律在锁外：先在锁内改一份快照，锁外写文件 + 存状态，
    // 最后回填内存里的状态（短锁，无 IO）。
    let snapshot = {
        let mut state = store.data.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        state.load_order = ordered_paths;
        state.load_order = loadorder::normalized_order(&state);
        // 这次明确按清单顺序落了盘，之后单个模组的部署也得沿用这个顺序，
        // 否则下次 deploy 又会被 ASCII 排序盖掉。
        state.settings.write_modlist = true;
        state.clone()
    };
    loadorder::write_modlist(&snapshot, &game_root)?;
    store.save(&snapshot)?;

    {
        let mut state = store.data.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        state.load_order = snapshot.load_order.clone();
        state.settings.write_modlist = true;
    }

    // 整批部署完成后补一次 REDmod 同步（批量循环里只打了脏标记）。
    redmod::flush_into(store, snapshot.game_dir.as_deref(), &mut report.warnings);

    Ok(report)
}

/// 用户点「我已更新前置，解除锁定」后调用。
///
/// 只做一件事：把当前 exe 版本记成「已确认版本」，熔断随即解除。
/// 不去动任何已部署的文件——是否重新部署由用户自己决定。
#[tauri::command]
fn clear_update_lock(store: State<'_, Store>) -> AppResult<Snapshot> {
    {
        let mut data = store.data.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let Some(root) = data.game_dir.clone() else {
            return Err(CommandError::new(
                "GAME_NOT_CONFIGURED",
                "还没有定位游戏目录，无需解除锁定。",
            ));
        };
        let exe = game::detected_exe(Path::new(&root));
        data.last_game_version = game::file_version(&exe);
        store.save(&data)?;
    }
    build_snapshot(&store)
}

// ── 既有模组收编（Adopt）─────────────────────────────────────────────
// 扫描同样是真实磁盘 IO：遍历 Vortex 目录树 + 数千次 metadata + 开 LevelDB。
// 2026-11-09 之前它是同步命令跑在主线程，库一大就把窗口冻成「未响应」
// （复盘见 docs/INCIDENT-2026-11-09-adopt-freeze.md）。与 adopt_execute 一样
// 丢进阻塞线程池；执行期的进度仍通过 adopt-progress 事件推送。

#[tauri::command]
async fn adopt_scan(app: tauri::AppHandle) -> AppResult<AdoptScanReport> {
    tauri::async_runtime::spawn_blocking(move || {
        let store = app.state::<Store>();
        adopt::scan(store.inner())
    })
    .await
    .map_err(|err| CommandError::new("ADOPT_SCAN_TASK", format!("收编扫描线程异常：{err}")))?
}

#[tauri::command]
async fn adopt_execute(
    app: tauri::AppHandle,
    busy: State<'_, BusyTasks>,
    candidates: Vec<AdoptCandidate>,
) -> AppResult<AdoptReport> {
    let _guard = busy.begin("收编模组");
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let store = handle.state::<Store>();
        adopt::execute(store.inner(), &candidates, &mut |progress| {
            let _ = handle.emit("adopt-progress", progress);
        })
    })
    .await
    .map_err(|err| CommandError::new("ADOPT_TASK", format!("收编执行线程异常：{err}")))?
}


// ── Vortex 接管双写辅助（P1/P2）───────────────────────────────────────
// 所有会改启用状态 / 加载顺序的命令都必须：
//   ① 本地事务之前先过守卫（Vortex 开着 / profile 错 → 直接拒绝，零改动）；
//   ② 本地成功后做双写，失败只记可见告警 + pending 队列，不抛给本地事务。

fn vortex_guard(store: &Store) -> AppResult<Option<PathBuf>> {
    let Some(dir) = vortex_sync::state_dir() else {
        if store.snapshot_data().settings.vortex_takeover {
            return Err(CommandError::new(
                "VORTEX_NOT_FOUND",
                "接管已开启，但找不到 Vortex 状态库（%APPDATA%\\Vortex\\state.v2）。",
            ));
        }
        return Ok(None);
    };
    vortex_sync::guard(store, &dir)?;
    Ok(Some(dir))
}

fn vortex_apply(store: &Store, dir: Option<PathBuf>, changes: vortex_sync::SyncChanges) -> Vec<String> {
    let Some(dir) = dir else {
        return Vec::new();
    };
    if changes.is_empty() {
        return Vec::new();
    }
    let report = vortex_sync::mirror(store, &dir, &changes);
    let mut out = report.warnings.clone();
    if !report.ok {
        out.push(format!(
            "Vortex 未同步：{}（可在设置 → 工具 → Vortex 接管体检里重试或还原）",
            report.reason
        ));
    }
    out
}

fn enabled_changes(store: &Store, ids: &[String], enabled: bool) -> vortex_sync::SyncChanges {
    let data = store.snapshot_data();
    let root = data.game_dir.as_ref().map(PathBuf::from).unwrap_or_default();
    let mapping = vortex_mirror::build_mapping(&data, &root);
    vortex_sync::changes_for_enabled(&mapping, ids, enabled)
}

fn redmod_changes(store: &Store, order: &[String]) -> vortex_sync::SyncChanges {
    let data = store.snapshot_data();
    let root = data.game_dir.as_ref().map(PathBuf::from).unwrap_or_default();
    let mapping = vortex_mirror::build_mapping(&data, &root);
    vortex_sync::changes_for_redmod_order(&mapping, order)
}

/// 开启接管时先做一次与开关无关的前置校验：Vortex 必须已退出、profile 必须正确。
#[tauri::command]
fn vortex_takeover_set_enabled(store: State<'_, Store>, enabled: bool) -> AppResult<bool> {
    if enabled {
        let dir = vortex_sync::state_dir().ok_or_else(|| {
            CommandError::new(
                "VORTEX_NOT_FOUND",
                "找不到 Vortex 状态库（%APPDATA%\\Vortex\\state.v2），无法开启接管。",
            )
        })?;
        vortex_sync::precheck(&dir)?;
    }
    let mut data = store.data.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    data.settings.vortex_takeover = enabled;
    store.save(&data)?;
    Ok(enabled)
}

#[tauri::command]
fn vortex_sync_status(store: State<'_, Store>) -> VortexSyncStatus {
    VortexSyncStatus {
        takeover_enabled: store.snapshot_data().settings.vortex_takeover,
        pending_count: vortex_sync::pending_count(store.inner()),
        backups: vortex_sync::list_backups(store.inner()),
        last_sync: vortex_sync::load_last(store.inner()),
    }
}


/// P3：只读统计接管覆盖率（配准能覆盖多少条、漏的是谁）。
///
/// 只读：不改状态、不写 LevelDB。放在 `spawn_blocking` 里是因为它要遍历
/// Vortex 存储根（200+ 目录 / 4000+ 文件）。
#[tauri::command]
async fn vortex_coverage(app: tauri::AppHandle) -> VortexCoverageReport {
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let store = handle.state::<Store>();
        vortex_mirror::coverage(store.inner())
    })
    .await
    .unwrap_or_else(|err| {
        eprintln!("[vortex] 覆盖率统计线程异常：{err}");
        VortexCoverageReport::default()
    })
}

/// P3：全库重新配准 Vortex 目录身份并持久化到 state。
#[tauri::command]
async fn vortex_mapping_rebuild(app: tauri::AppHandle) -> AppResult<VortexMappingReport> {
    tauri::async_runtime::spawn_blocking(move || {
        let store = app.state::<Store>();
        vortex_mirror::rebuild_mapping(store.inner())
    })
    .await
    .map_err(|err| CommandError::new("VORTEX_MAPPING_TASK", format!("配准线程异常：{err}")))?
}

/// P3：把全库启用状态与两套加载顺序一次性镜像到 Vortex。
#[tauri::command]
async fn vortex_sync_full(app: tauri::AppHandle) -> AppResult<VortexSyncReport> {
    tauri::async_runtime::spawn_blocking(move || {
        let store = app.state::<Store>();
        let dir = vortex_sync::state_dir().ok_or_else(|| {
            CommandError::new("VORTEX_NOT_FOUND", "找不到 Vortex 状态库，无法全量同步。")
        })?;
        Ok(vortex_sync::mirror(
            store.inner(),
            &dir,
            &vortex_sync::full_changes(store.inner()),
        ))
    })
    .await
    .map_err(|err| CommandError::new("VORTEX_SYNC_TASK", format!("全量同步线程异常：{err}")))?
}

/// P3：漂移对账。strategy = report | cyberdeck | vortex，默认 report 零写入。
#[tauri::command]
async fn vortex_reconcile(
    app: tauri::AppHandle,
    strategy: String,
) -> AppResult<VortexReconcileReport> {
    tauri::async_runtime::spawn_blocking(move || {
        let store = app.state::<Store>();
        let dir = vortex_sync::state_dir().ok_or_else(|| {
            CommandError::new("VORTEX_NOT_FOUND", "找不到 Vortex 状态库，无法对账。")
        })?;
        Ok(vortex_sync::reconcile(store.inner(), &dir, &strategy))
    })
    .await
    .map_err(|err| CommandError::new("VORTEX_SYNC_TASK", format!("对账线程异常：{err}")))?
}

/// P4：以 Vortex 安装目录为权威，只读生成重建计划（不写任何文件）。
#[tauri::command]
async fn vortex_rebuild_preview(app: tauri::AppHandle) -> AppResult<VortexRebuildPreview> {
    tauri::async_runtime::spawn_blocking(move || {
        let store = app.state::<Store>();
        vortex_rebuild::preview(store.inner())
    })
    .await
    .map_err(|err| CommandError::new("VORTEX_REBUILD_TASK", format!("预览线程异常：{err}")))?
}

/// P4：执行重建。调用方必须已展示计划并拿到用户确认；内部会先整库备份。
#[tauri::command]
async fn vortex_rebuild_apply(app: tauri::AppHandle) -> AppResult<VortexRebuildReport> {
    tauri::async_runtime::spawn_blocking(move || {
        let store = app.state::<Store>();
        vortex_rebuild::apply(store.inner())
    })
    .await
    .map_err(|err| CommandError::new("VORTEX_REBUILD_TASK", format!("重建线程异常：{err}")))?
}

/// P4：列出可一键还原的重建备份（只读）。
#[tauri::command]
async fn vortex_rebuild_backups(app: tauri::AppHandle) -> AppResult<Vec<String>> {
    tauri::async_runtime::spawn_blocking(move || {
        let store = app.state::<Store>();
        Ok(vortex_rebuild::list_backups(store.inner()))
    })
    .await
    .map_err(|err| CommandError::new("VORTEX_REBUILD_TASK", format!("备份列表线程异常：{err}")))?
}

/// P4：还原到某次重建之前。只覆盖当前实例的 launcher-state.json，不删任何文件。
#[tauri::command]
async fn vortex_rebuild_restore(
    app: tauri::AppHandle,
    name: String,
) -> AppResult<VortexRebuildReport> {
    tauri::async_runtime::spawn_blocking(move || {
        let store = app.state::<Store>();
        vortex_rebuild::restore(store.inner(), &name)
    })
    .await
    .map_err(|err| CommandError::new("VORTEX_REBUILD_TASK", format!("还原线程异常：{err}")))?
}

/// P3：把控制权交还 Vortex 前的一致性预检（只读）。
#[tauri::command]
async fn vortex_prelaunch_check(
    app: tauri::AppHandle,
) -> AppResult<VortexPrelaunchReport> {
    tauri::async_runtime::spawn_blocking(move || {
        let store = app.state::<Store>();
        let dir = vortex_sync::state_dir().ok_or_else(|| {
            CommandError::new("VORTEX_NOT_FOUND", "找不到 Vortex 状态库，无法预检。")
        })?;
        Ok(vortex_sync::prelaunch_check(store.inner(), &dir))
    })
    .await
    .map_err(|err| CommandError::new("VORTEX_SYNC_TASK", format!("预检线程异常：{err}")))?
}

#[tauri::command]
async fn vortex_sync_retry(app: tauri::AppHandle) -> AppResult<VortexSyncReport> {
    tauri::async_runtime::spawn_blocking(move || {
        let store = app.state::<Store>();
        let dir = vortex_sync::state_dir().ok_or_else(|| {
            CommandError::new("VORTEX_NOT_FOUND", "找不到 Vortex 状态库，无法重试同步。")
        })?;
        Ok(vortex_sync::retry_pending(store.inner(), &dir))
    })
    .await
    .map_err(|err| CommandError::new("VORTEX_SYNC_TASK", format!("重试线程异常：{err}")))?
}

#[tauri::command]
async fn vortex_sync_restore(app: tauri::AppHandle, name: String) -> AppResult<usize> {
    tauri::async_runtime::spawn_blocking(move || {
        let store = app.state::<Store>();
        let dir = vortex_sync::state_dir().ok_or_else(|| {
            CommandError::new("VORTEX_NOT_FOUND", "找不到 Vortex 状态库，无法还原。")
        })?;
        vortex_sync::restore(store.inner(), &dir, &name)
    })
    .await
    .map_err(|err| CommandError::new("VORTEX_SYNC_TASK", format!("还原线程异常：{err}")))?
}

#[tauri::command]
fn adopt_cancel() -> bool {
    adopt::request_cancel()
}

/// Vortex 接管体检（P0，纯只读）：读状态库、算指纹、列出漂移。
/// 不写 LevelDB、不删文件、不改游戏目录；Vortex 运行中回一份带原因的报告。
#[tauri::command]
async fn vortex_takeover_preflight(
    app: tauri::AppHandle,
) -> AppResult<VortexTakeoverPreflight> {
    tauri::async_runtime::spawn_blocking(move || {
        let store = app.state::<Store>();
        vortex_mirror::preflight(store.inner())
    })
    .await
    .map_err(|err| {
        CommandError::new("VORTEX_PREFLIGHT_TASK", format!("体检线程异常：{err}"))
    })?
}

/// 暂存区体检（纯只读）：只列孤儿目录与缺失目录，绝不删除、绝不移动。
#[tauri::command]
async fn adopt_staging_health(app: tauri::AppHandle) -> AppResult<AdoptStagingHealth> {
    tauri::async_runtime::spawn_blocking(move || {
        let store = app.state::<Store>();
        vortex_mirror::staging_health(store.inner())
    })
    .await
    .map_err(|err| {
        CommandError::new("STAGING_HEALTH_TASK", format!("体检线程异常：{err}"))
    })?
}

/// 库整理：把历史收编留下的「伴生 .xl 独立成条」并回它的 archive 主体。
///
/// 纯 state 操作（不碰游戏目录、不动暂存文件），几百条毫秒级，同步执行即可。
/// 幂等：没有可合并的条目时返回 `merged: 0`，重复调用无副作用。
#[tauri::command]
fn adopt_normalize(store: State<'_, Store>) -> AppResult<LibraryNormalizeReport> {
    adopt::normalize_library(store.inner())
}

/// 在资源管理器里定位一个文件/文件夹。
///
/// 打开的是外部程序，所以做了两道收口：路径必须存在，且必须落在
/// 启动器自己的目录（暂存区、数据目录）或当前游戏目录里——
/// 避免前端被诱导去打开任意系统路径。
// ── 播放集（Profile）───────────────────────────────────────────

/// 切换播放集：撤销当前部署 → 写入目标状态 → 按新集合重新部署。
/// 整个流程可能跑几十秒，必须丢进阻塞线程池。
#[tauri::command]
async fn switch_profile(app: tauri::AppHandle, profile_id: String) -> AppResult<SwitchProfileReport> {
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let store = handle.state::<Store>();
        let report = profiles::switch_profile(&store, &profile_id)?;
        // P3：播放集切换会整批改启用集合，接管开启时紧跟一次全量镜像。
        // 失败不阻断切换本身，mirror 会写 pending + last-sync，界面可见。
        if store.snapshot_data().settings.vortex_takeover {
            if let Some(dir) = vortex_sync::state_dir() {
                let sync = vortex_sync::mirror(
                    store.inner(),
                    &dir,
                    &vortex_sync::full_changes(store.inner()),
                );
                if !sync.ok {
                    eprintln!("[vortex] 播放集切换后全量同步失败：{}", sync.reason);
                }
            }
        }
        Ok(report)
    })
    .await
    .map_err(|err| CommandError::new("PROFILE_TASK", format!("切换播放集线程异常：{err}")))?
}

#[tauri::command]
fn list_profiles(store: State<'_, Store>) -> AppResult<ProfileList> {
    profiles::list_profiles(&store)
}

/// 把当前启用集合与加载顺序写回该播放集（不动部署）。
#[tauri::command]
fn save_profile_state(store: State<'_, Store>, profile_id: String) -> AppResult<ProfileList> {
    profiles::save_profile_state(&store, &profile_id)
}

#[tauri::command]
fn create_profile(store: State<'_, Store>, name: String, copy_current: bool) -> AppResult<ProfileList> {
    profiles::create_profile(&store, &name, copy_current)
}

#[tauri::command]
fn rename_profile(store: State<'_, Store>, profile_id: String, name: String) -> AppResult<ProfileList> {
    profiles::rename_profile(&store, &profile_id, &name)
}

#[tauri::command]
fn delete_profile(store: State<'_, Store>, profile_id: String) -> AppResult<ProfileList> {
    profiles::delete_profile(&store, &profile_id)
}

#[tauri::command]
fn duplicate_profile(store: State<'_, Store>, profile_id: String, name: String) -> AppResult<ProfileList> {
    profiles::duplicate_profile(&store, &profile_id, &name)
}

/// 导出播放集（modlist）为 JSON 文件，返回落盘路径。
#[tauri::command]
fn export_profile_modlist(store: State<'_, Store>, profile_id: String) -> AppResult<String> {
    profiles::export_modlist(&store, &profile_id)
}

// ── 外部工具（deepseek 任务·模块三）──────────────────────────────

fn external_tools_locked(store: &Store) -> AppResult<Vec<schema::ExternalToolEntry>> {
    Ok(store.snapshot_data().external_tools)
}

#[tauri::command]
fn external_tools_list(store: State<'_, Store>) -> AppResult<Vec<schema::ExternalToolEntry>> {
    external_tools_locked(&store)
}

#[tauri::command]
fn external_tool_add(
    store: State<'_, Store>,
    name: String,
    path: String,
    icon: Option<String>,
) -> AppResult<Vec<schema::ExternalToolEntry>> {
    let name = name.trim();
    let path = path.trim();
    if name.is_empty() {
        return Err(CommandError::new("TOOL_NAME_EMPTY", "工具名字不能为空。"));
    }
    let file = Path::new(path);
    if !file.is_file() {
        return Err(CommandError::new(
            "TOOL_PATH_INVALID",
            format!("路径不存在或不是文件：{path}"),
        ));
    }
    if !path.to_ascii_lowercase().ends_with(".exe") {
        return Err(CommandError::new(
            "TOOL_PATH_INVALID",
            "外部工具只支持 .exe 程序。",
        ));
    }
    let icon = icon
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .map(|value| value.chars().take(2).collect::<String>());
    let mut data = store.data.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    data.external_tools.push(schema::ExternalToolEntry {
        id: format!("tool-{}", uuid::Uuid::new_v4().simple()),
        name: name.to_string(),
        path: path.to_string(),
        icon,
        pinned: false,
        created_at: store::now_iso(),
    });
    store.save(&data)?;
    Ok(data.external_tools.clone())
}

#[tauri::command]
fn external_tool_update(
    store: State<'_, Store>,
    id: String,
    name: Option<String>,
    icon: Option<String>,
    pinned: Option<bool>,
) -> AppResult<Vec<schema::ExternalToolEntry>> {
    let mut data = store.data.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let entry = data
        .external_tools
        .iter_mut()
        .find(|item| item.id == id)
        .ok_or_else(|| CommandError::new("TOOL_UNKNOWN", "找不到这个外部工具。"))?;
    if let Some(name) = name.map(|value| value.trim().to_string()) {
        if !name.is_empty() {
            entry.name = name;
        }
    }
    if let Some(icon) = icon {
        let icon = icon.trim().to_string();
        entry.icon = if icon.is_empty() {
            None
        } else {
            Some(icon.chars().take(2).collect())
        };
    }
    if let Some(pinned) = pinned {
        entry.pinned = pinned;
    }
    store.save(&data)?;
    Ok(data.external_tools.clone())
}

#[tauri::command]
fn external_tool_remove(store: State<'_, Store>, id: String) -> AppResult<Vec<schema::ExternalToolEntry>> {
    let mut data = store.data.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    data.external_tools.retain(|item| item.id != id);
    store.save(&data)?;
    Ok(data.external_tools.clone())
}

/// 启动外部工具：直接 spawn（GUI 程序自己弹窗），工作目录设为 exe 所在目录
/// ——很多老程序（存档编辑器之类）依赖相对路径找自己的数据文件。
#[tauri::command]
fn external_tool_launch(store: State<'_, Store>, id: String) -> AppResult<()> {
    let tools = store.snapshot_data().external_tools;
    let tool = tools
        .iter()
        .find(|item| item.id == id)
        .ok_or_else(|| CommandError::new("TOOL_UNKNOWN", "找不到这个外部工具。"))?;
    let file = Path::new(&tool.path);
    if !file.is_file() {
        return Err(CommandError::new(
            "TOOL_PATH_INVALID",
            format!("工具文件不在了：{}。删掉重新添加一次。", tool.path),
        ));
    }
    let cwd = file.parent().unwrap_or(Path::new("."));
    std::process::Command::new(file)
        .current_dir(cwd)
        .spawn()
        .map_err(|e| CommandError::new("TOOL_LAUNCH_FAILED", format!("启动失败：{e}")))?;
    Ok(())
}


/// 从导出文件导入播放集：id 优先、名字兜底对回当前库。
#[tauri::command]
fn import_profile_modlist(
    store: State<'_, Store>,
    path: String,
    name: Option<String>,
) -> AppResult<profiles::ProfileImportReport> {
    profiles::import_modlist(&store, &path, name.as_deref())
}

/// 批量启用/禁用（看板【mod 列表及切换功能】）：逐个走与 set_mod_enabled
/// 相同的部署/撤除语义；单个失败不中断整批，进 warnings/failed。
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchEnableReport {
    pub changed: usize,
    pub failed: Vec<String>,
    pub warnings: Vec<String>,
}

#[tauri::command]
async fn set_mods_enabled(
    app: tauri::AppHandle,
    ids: Vec<String>,
    enabled: bool,
) -> AppResult<BatchEnableReport> {
    if ids.is_empty() {
        return Ok(BatchEnableReport {
            changed: 0,
            failed: Vec::new(),
            warnings: Vec::new(),
        });
    }
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let store = handle.state::<Store>();
        let vdir = vortex_guard(store.inner())?;
        let mut report = BatchEnableReport {
            changed: 0,
            failed: Vec::new(),
            warnings: Vec::new(),
        };

        // P4：Vortex 托管条目只改标记 + 双写，不进 deploy/undeploy 循环。
        let vortex_ids: Vec<String> = {
            let data = store.snapshot_data();
            ids.iter()
                .filter(|id| {
                    data.mods
                        .iter()
                        .any(|item| &item.id == *id && item.origin == "vortex")
                })
                .cloned()
                .collect()
        };
        if !vortex_ids.is_empty() {
            {
                let mut guard = store.data.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
                for entry in guard.mods.iter_mut() {
                    if vortex_ids.contains(&entry.id) {
                        entry.enabled = enabled;
                    }
                }
                store.save(&guard)?;
            }
            report.changed += vortex_ids.len();
            report.warnings.extend(vortex_apply(
                store.inner(),
                vdir.clone(),
                enabled_changes(store.inner(), &vortex_ids, enabled),
            ));
        }
        let ids: Vec<String> = ids
            .into_iter()
            .filter(|id| !vortex_ids.contains(id))
            .collect();
        if ids.is_empty() {
            let snapshot = store.snapshot_data();
            redmod::flush_into(&store, snapshot.game_dir.as_deref(), &mut report.warnings);
            return Ok(report);
        }

        if enabled {
            // 更新熔断先查一次：整批都是要动游戏目录的部署，锁着就别逐个撞。
            let data = store.snapshot_data();
            let game = match data.game_dir.as_deref().map(PathBuf::from) {
                Some(root) => match game::validate_game_dir(&root) {
                    Ok(info) => {
                        let current = game::file_version(&root.join("bin").join("x64").join("Cyberpunk2077.exe"));
                        if game::update_lock_active(data.last_game_version.as_deref(), current.as_deref()) {
                            return Err(CommandError::new(
                                "GAME_UPDATE_LOCKED",
                                format!(
                                    "游戏已更新（{} → {}），先升级前置框架再批量启用。",
                                    data.last_game_version.as_deref().unwrap_or("未知"),
                                    current.as_deref().unwrap_or("未知")
                                ),
                            ));
                        }
                        info
                    }
                    Err(err) => return Err(err),
                },
                None => {
                    return Err(CommandError::new(
                        "NO_GAME_DIR",
                        "还没有绑定游戏目录，无法批量启用。",
                    ))
                }
            };
            for id in &ids {
                match installer::deploy_mod(&store, id, &game) {
                    Ok(_) => report.changed += 1,
                    Err(err) => {
                        report.failed.push(id.clone());
                        report.warnings.push(format!("{id}：{}", err.message));
                    }
                }
            }
        } else {
            // 批量禁用：未绑定游戏目录时，部署清单为空的条目照样算干净（与单个禁用同语义）。
            let data = store.snapshot_data();
            let game_root = data.game_dir.clone().map(PathBuf::from);
            for id in &ids {
                let result = match game_root.as_deref() {
                    Some(root) => installer::undeploy_mod(&store, id, Path::new(root)).map(|_| ()),
                    None => {
                        let clean = data
                            .mods
                            .iter()
                            .find(|item| &item.id == id)
                            .map(|entry| entry.deployed_files.is_empty())
                            .unwrap_or(true);
                        if clean {
                            Ok(())
                        } else {
                            Err(CommandError::new(
                                "GAME_NOT_CONFIGURED",
                                "部署清单还在，但游戏目录没有配置，无法安全移除链接。",
                            ))
                        }
                    }
                };
                match result {
                    Ok(()) => report.changed += 1,
                    Err(err) => {
                        report.failed.push(id.clone());
                        report.warnings.push(format!("{id}：{}", err.message));
                    }
                }
            }
        }
        // 批量循环里只有打标记，这里是唯一一次真跑 redMod 的地方。
        let snapshot = store.snapshot_data();
        redmod::flush_into(&store, snapshot.game_dir.as_deref(), &mut report.warnings);
        report.warnings.extend(vortex_apply(
            store.inner(),
            vdir,
            enabled_changes(store.inner(), &ids, enabled),
        ));
        Ok(report)
    })
    .await
    .map_err(|err| CommandError::new("BATCH_TASK", format!("批量操作线程异常：{err}")))?
}
/// 环境体检：检查已部署文件的链接是否还在、有没有被替换。
#[tauri::command]
async fn diagnose_environment(app: tauri::AppHandle) -> AppResult<EnvDiagnosis> {
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let store = handle.state::<Store>();
        environment::diagnose_environment(&store)
    })
    .await
    .map_err(|err| CommandError::new("ENV_TASK", format!("体检线程异常：{err}")))?
}

/// 一键自愈：能重建的链接直接重建，修不了的原样报告。
#[tauri::command]
async fn heal_environment(app: tauri::AppHandle) -> AppResult<HealReport> {
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let store = handle.state::<Store>();
        environment::heal_environment(&store)
    })
    .await
    .map_err(|err| CommandError::new("ENV_TASK", format!("修复线程异常：{err}")))?
}
#[tauri::command]
fn open_in_explorer(store: State<'_, Store>, path: String) -> AppResult<()> {
    let target = PathBuf::from(&path);
    if !target.exists() {
        return Err(CommandError::new(
            "PATH_NOT_FOUND",
            format!("路径不存在或已被移动：{path}"),
        ));
    }
    let data = store.snapshot_data();
    let mut roots = vec![store.staging_dir(), store.data_dir.clone()];
    if let Some(root) = data.game_dir.as_deref() {
        roots.push(PathBuf::from(root));
    }
    let allowed = roots.iter().any(|root| target.starts_with(root));
    if !allowed {
        return Err(CommandError::new(
            "PATH_NOT_ALLOWED",
            "只能打开启动器的暂存区、数据目录或游戏目录内的路径。",
        ));
    }

    let mut command = Command::new("explorer.exe");
    if target.is_dir() {
        command.arg(&target);
    } else {
        command.arg(format!("/select,{}", target.display()));
    }
    // explorer 有时会以非零码退出，但只要进程起来了就算成功。
    command
        .spawn()
        .map_err(|err| CommandError::new("OPEN_FAILED", format!("打开资源管理器失败：{err}")))?;
    Ok(())
}

/// 强制修复：先撤销现有链接，再按当前清单重新部署。
///
/// 撤销阶段的错误只记录不中断——旧链接可能已经因为游戏更新而失效，
/// 反而需要 deploy 去覆盖它。
#[tauri::command]
async fn repair_mod(app: tauri::AppHandle, id: String) -> AppResult<DeployReport> {
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let store = handle.state::<Store>();
        let busy = handle.state::<BusyTasks>();
        let _guard = busy.begin("修复部署");
        repair_mod_blocking(store.inner(), &id)
    })
    .await
    .map_err(|err| CommandError::new("REPAIR_TASK", format!("修复线程异常：{err}")))?
}

fn repair_mod_blocking(store: &Store, id: &str) -> AppResult<DeployReport> {
    let data = store.snapshot_data();
    let game = current_game(&data)?;
    if let Some(root) = data.game_dir.as_deref() {
        let _ = installer::undeploy_mod(store, id, Path::new(root));
    }
    let mut report = installer::deploy_mod(store, id, &game)?;
    redmod::flush_into(store, data.game_dir.as_deref(), &mut report.warnings);
    Ok(report)
}

/// 版本分组的身份键：优先 Nexus modId，其次同名（去空白、忽略大小写）。
///
/// 为什么用这两级：
/// - 同一 mod 的不同版本在 Nexus 上是同一个 modId，这是最可靠的依据；
/// - 收编进来的散装条目可能没有 Nexus 元数据，只能退回名字比对。名字是用户
///   可见的展示名，同名的不同 mod 极少见，且切换前一定会再让用户确认。
fn version_identity(entry: &ModEntry) -> String {
    if let Some(nexus) = &entry.nexus {
        if nexus.mod_id > 0 {
            return format!("nexus:{}", nexus.mod_id);
        }
    }
    format!("name:{}", entry.name.trim().to_lowercase())
}

/// 同一 mod 的其它版本（不含自己、不含汉化子包）。
fn version_siblings(data: &crate::schema::AppStateData, target: &ModEntry) -> Vec<String> {
    let key = version_identity(target);
    data.mods
        .iter()
        .filter(|item| {
            item.id != target.id
                && item.parent_mod_id.is_none()
                && !item.is_translation
                && version_identity(item) == key
        })
        .map(|item| item.id.clone())
        .collect()
}

/// 切换同一个 mod 的生效版本。
///
/// 语义与 Vortex 的「同一 mod 只允许一个版本启用」一致：先把其它版本全部撤下来，
/// 再部署目标版本。顺序不能反 —— 不同版本的 archive 往往落在同一个目标路径，
/// 先部署会直接撞上既有硬链接（installer 会报「目标已存在」）。
#[tauri::command]
async fn switch_mod_version(app: tauri::AppHandle, id: String) -> AppResult<DeployReport> {
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let store = handle.state::<Store>();
        switch_mod_version_blocking(store.inner(), &id)
    })
    .await
    .map_err(|err| CommandError::new("DEPLOY_TASK", format!("切换版本线程异常：{err}")))?
}

fn switch_mod_version_blocking(store: &Store, target_id: &str) -> AppResult<DeployReport> {
    let data = store.snapshot_data();
    let target = data
        .mods
        .iter()
        .find(|item| item.id == target_id)
        .cloned()
        .ok_or_else(|| CommandError::new("MOD_NOT_FOUND", "找不到这个模组。"))?;
    let siblings = version_siblings(&data, &target);

    let mut warnings: Vec<String> = Vec::new();
    let mut failures: Vec<String> = Vec::new();

    // 段 1：撤掉其它版本。单个失败不中断整批 —— 撤不下来的那条会被记进
    // warnings，用户至少能看到「哪个旧版本还在游戏目录里」，而不是整次切换失败。
    for sibling in &siblings {
        let still_enabled = store
            .snapshot_data()
            .mods
            .iter()
            .any(|item| item.id == *sibling && item.enabled);
        if !still_enabled {
            continue;
        }
        match set_mod_enabled_blocking(store, sibling, false) {
            Ok(report) => warnings.extend(report.warnings),
            Err(err) => failures.push(format!("{}：{}", sibling, err.message)),
        }
    }

    // 段 2：部署目标版本。
    let already_enabled = store
        .snapshot_data()
        .mods
        .iter()
        .any(|item| item.id == target_id && item.enabled);
    let mut report = if already_enabled {
        let entry = store
            .snapshot_data()
            .mods
            .into_iter()
            .find(|item| item.id == target_id)
            .ok_or_else(|| CommandError::new("MOD_NOT_FOUND", "找不到这个模组。"))?;
        DeployReport {
            mod_entry: entry,
            deployed: 0,
            hard_links: 0,
            symlinks: 0,
            copies: 0,
            warnings: Vec::new(),
            purged: false,
        }
    } else {
        set_mod_enabled_blocking(store, target_id, true)?
    };

    report.warnings.append(&mut warnings);
    for failure in failures {
        report
            .warnings
            .push(format!("旧版本未能撤下（{failure}），请手动禁用后再切换。"));
    }
    Ok(report)
}

/// 单条启用 / 禁用。
///
/// `async` + `spawn_blocking`：部署要建链接、递归备份、跑 redMod 编译，分钟级；
/// 同步命令会把窗口事件循环卡死（2026-11-10 自检 P1-3）。锁的纪律不变（仍由
/// `installer::deploy_mod` 自己持锁），这里只把工作搬到阻塞线程池。
#[tauri::command]
async fn set_mod_enabled(app: tauri::AppHandle, id: String, enabled: bool) -> AppResult<DeployReport> {
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let store = handle.state::<Store>();
        set_mod_enabled_blocking(store.inner(), &id, enabled)
    })
    .await
    .map_err(|err| CommandError::new("DEPLOY_TASK", format!("部署线程异常：{err}")))?
}

fn set_mod_enabled_blocking(store: &Store, id: &str, enabled: bool) -> AppResult<DeployReport> {
    // 接管开启时先过守卫：Vortex 运行中 / profile 不符 → 本地状态零改动。
    let vdir = vortex_guard(store)?;
    // P4：Vortex 托管的模组物理文件由 Vortex 部署，启动器绝不去增删游戏目录里的
    // 硬链接；这里只改本地启用标记 + 镜像 Vortex 状态库。
    {
        let data = store.snapshot_data();
        if data.mods.iter().any(|item| item.id == id && item.origin == "vortex") {
            {
                let mut guard = store.data.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
                if let Some(entry) = guard.mods.iter_mut().find(|item| item.id == id) {
                    entry.enabled = enabled;
                }
                store.save(&guard)?;
            }
            let warnings = vortex_apply(
                store,
                vdir.clone(),
                enabled_changes(store, &[id.to_string()], enabled),
            );
            let entry = store
                .snapshot_data()
                .mods
                .into_iter()
                .find(|item| item.id == id)
                .ok_or_else(|| CommandError::new("MOD_NOT_FOUND", "找不到这个模组。"))?;
            return Ok(DeployReport {
                mod_entry: entry,
                deployed: 0,
                hard_links: 0,
                symlinks: 0,
                copies: 0,
                warnings,
                purged: false,
            });
        }
    }
    if enabled {
        let data = store.snapshot_data();
        let game = current_game(&data)?;
        // 游戏本体更新后，旧前置很可能全部失效：此时部署会把半坏的文件链进游戏目录。
        // 只拦「改动游戏目录」的动作，导入、查看、改配置都不受影响。
        let current_version = game.version.as_deref();
        if game::update_lock_active(data.last_game_version.as_deref(), current_version) {
            return Err(CommandError::new(
                "GAME_UPDATE_LOCKED",
                format!(
                    "游戏已更新（{} → {}），请先升级前置框架后再部署。确认无误可在顶部横幅点「我已更新前置，解除锁定」。",
                    data.last_game_version.as_deref().unwrap_or("未知"),
                    current_version.unwrap_or("未知"),
                ),
            ));
        }
        // 部署前自动快照（865759）：失败只记日志，不阻断部署。
        snapshots::auto_snapshot_pre_deploy(store, &data, Some(&game));
        let mut report = installer::deploy_mod(store, id, &game)?;
        redmod::flush_into(store, data.game_dir.as_deref(), &mut report.warnings);
        report
            .warnings
            .extend(vortex_apply(store, vdir, enabled_changes(store, &[id.to_string()], true)));
        return Ok(report);
    }

    let data = store.snapshot_data();
    let entry = data
        .mods
        .iter()
        .find(|item| item.id == id)
        .ok_or_else(|| CommandError::new("MOD_NOT_FOUND", "找不到这个模组。"))?
        .clone();
    let Some(root) = data.game_dir.as_deref() else {
        if entry.deployed_files.is_empty() {
            return Ok(DeployReport {
                mod_entry: entry,
                deployed: 0,
                hard_links: 0,
                symlinks: 0,
                copies: 0,
                warnings: Vec::new(),
                purged: false,
            });
        }
        return Err(CommandError::new(
            "GAME_NOT_CONFIGURED",
            "部署清单还在，但游戏目录没有配置，无法安全移除链接。",
        ));
    };
    let mut warnings = installer::undeploy_mod(store, id, Path::new(root))?;
    redmod::flush_into(store, data.game_dir.as_deref(), &mut warnings);
    let entry = store
        .snapshot_data()
        .mods
        .into_iter()
        .find(|item| item.id == id)
        .ok_or_else(|| CommandError::new("MOD_NOT_FOUND", "找不到这个模组。"))?;
    warnings.extend(vortex_apply(
        store,
        vdir,
        enabled_changes(store, &[id.to_string()], false),
    ));
    Ok(DeployReport {
        mod_entry: entry,
        deployed: 0,
        hard_links: 0,
        symlinks: 0,
        copies: 0,
        warnings,
        purged: false,
    })
}

/// 卸载（删暂存副本 + 撤链接 + 从库里移除）。同样是分钟级磁盘操作。
#[tauri::command]
async fn uninstall_mod(app: tauri::AppHandle, id: String) -> AppResult<()> {
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let store = handle.state::<Store>();
        let busy = handle.state::<BusyTasks>();
        let _guard = busy.begin("卸载模组");
        uninstall_mod_blocking(store.inner(), &id)
    })
    .await
    .map_err(|err| CommandError::new("UNINSTALL_TASK", format!("卸载线程异常：{err}")))?
}

fn uninstall_mod_blocking(store: &Store, id: &str) -> AppResult<()> {
    let data = store.snapshot_data();
    if data.mods.iter().any(|item| item.id == id && item.origin == "vortex") {
        return Err(CommandError::new(
            "VORTEX_MANAGED_MOD",
            "这个模组由 Vortex 安装并部署，请在 Vortex 里卸载；启动器不会删除 Vortex 的文件。",
        ));
    }
    let game_root = data.game_dir.clone().map(PathBuf::from);
    installer::uninstall_mod(store, id, game_root.as_deref())?;
    // 卸载接口不返回提示列表，同步失败只记日志并保留脏标记，下次操作会重试。
    let mut warnings = Vec::new();
    redmod::flush_into(store, data.game_dir.as_deref(), &mut warnings);
    for warning in warnings {
        eprintln!("[redmod] {warning}");
    }
    Ok(())
}

#[tauri::command]
fn update_mod(
    store: State<'_, Store>,
    id: String,
    category: Option<String>,
    name: Option<String>,
    busy: State<'_, BusyTasks>,
) -> AppResult<ModEntry> {
    let _guard = busy.begin("更新模组");
    let mut data = store.data.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let entry = data
        .mods
        .iter_mut()
        .find(|item| item.id == id)
        .ok_or_else(|| CommandError::new("MOD_NOT_FOUND", "找不到这个模组。"))?;
    if let Some(category) = category {
        let trimmed = category.trim();
        if !trimmed.is_empty() {
            entry.category = trimmed.to_string();
        }
    }
    if let Some(name) = name {
        let trimmed = name.trim();
        if !trimmed.is_empty() {
            entry.name = trimmed.to_string();
        }
    }
    let cloned = entry.clone();
    store.save(&data)?;
    Ok(cloned)
}

#[tauri::command]
fn get_load_order(store: State<'_, Store>) -> AppResult<LoadOrderView> {
    let mut data = store.data.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    data.load_order = loadorder::normalized_order(&data);
    store.save(&data)?;
    let game_root = data.game_dir.clone();
    Ok(loadorder::build_view(&data, game_root.as_deref().map(Path::new)))
}

/// 保存加载顺序。
///
/// **必须走 `spawn_blocking`**：这条链路里有 Vortex 状态库（LevelDB）的打开与
/// 读取、`modlist.txt` 落盘、整库写入（近 3 MB），任何一步都是几百毫秒到几十秒
/// 的磁盘活。从前它是同步命令，跑在 UI 线程上，用户点「应用」后窗口直接被
/// Windows 判定「未响应」——2026-11-11 报的就是这个。
#[tauri::command]
async fn save_load_order(app: tauri::AppHandle, order: Vec<String>) -> AppResult<LoadOrderView> {
    tauri::async_runtime::spawn_blocking(move || {
        let store = app.state::<Store>();
        save_load_order_blocking(store.inner(), order)
    })
    .await
    .map_err(|err| CommandError::new("SAVE_ORDER_TASK", format!("保存加载顺序线程异常：{err}")))?
}

fn save_load_order_blocking(store: &Store, order: Vec<String>) -> AppResult<LoadOrderView> {
    let clock = std::time::Instant::now();
    let vdir = vortex_guard(store)?;
    let guard_ms = clock.elapsed().as_millis();
    let mut data = store.data.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let valid: std::collections::HashSet<String> = loadorder::deployed_archives(&data)
        .into_iter()
        .map(|(path, _, _, _)| path.to_ascii_lowercase())
        .collect();
    let mut seen = std::collections::HashSet::new();
    for item in &order {
        let key = item.to_ascii_lowercase();
        if !valid.contains(&key) {
            return Err(CommandError::new(
                "LOAD_ORDER_UNKNOWN",
                format!("加载顺序里出现了未部署的 archive：{item}"),
            ));
        }
        if !seen.insert(key) {
            return Err(CommandError::new(
                "LOAD_ORDER_DUPLICATE",
                "加载顺序里有重复条目。",
            ));
        }
    }
    data.load_order = order;
    data.load_order = loadorder::normalized_order(&data);
    let warnings = if data.settings.write_modlist {
        let game_root = data.game_dir.clone().ok_or_else(|| {
            CommandError::new("GAME_NOT_CONFIGURED", "没有游戏目录，无法写入 modlist.txt。")
        })?;
        loadorder::write_modlist(&data, Path::new(&game_root))
            .err()
            .map(|err| vec![err.message])
            .unwrap_or_default()
    } else {
        Vec::new()
    };
    store.save(&data)?;
    let mut view = loadorder::build_view(&data, data.game_dir.as_deref().map(Path::new));
    // modlist.txt 写不成（被 Vortex 占着、或者不是本启动器写的）不影响顺序本身
    // 已经可靠落进状态库——降级成 warning 回传。以前这里返回 Err，用户看到
    // 「保存失败」，可重启后顺序又确实变了，这比不提示更糟。
    view.warnings = warnings;
    let synced_order = data.load_order.clone();
    drop(data);
    let _ = vortex_apply(
        store,
        vdir,
        vortex_sync::changes_for_archive_order(&synced_order),
    );
    log_startup(
        &store.data_dir,
        &format!(
            "stage=save_order rows={} guard={guard_ms}ms total={}ms",
            view.archives.len(),
            clock.elapsed().as_millis()
        ),
    );
    Ok(view)
}

/// 给出「一键整理」的建议顺序。**只返回建议，不落盘**。
///
/// 为什么要在后端算：冲突聚合、框架判定、MOD 分组用的全是 `state.mods` 的原始字段，
/// 前端只拿到已排序的 158 行，自己再算一遍必然与后端口径漂移（第一版前端推断
/// 缺前置时就踩过这个坑，后来统一改成后端出表）。
///
/// `ai = true` 时先问模型要相对约束，失败/超时/输出不合法都**降级到规则版**并把
/// 原因写进 `aiNote`——排序功能不能因为模型没配好就整个不可用。
#[tauri::command]
async fn suggest_load_order(
    app: tauri::AppHandle,
    ai: Option<bool>,
) -> AppResult<LoadOrderSuggestion> {
    let want_ai = ai.unwrap_or(false);
    let snapshot = app.state::<Store>().snapshot_data();

    let mut constraints = Vec::new();
    let mut ai_used = false;
    let mut ai_note: Option<String> = None;

    if want_ai {
        let brief = loadsort::build_ai_brief(&snapshot);
        let handle = app.clone();
        // 网络请求是阻塞的（reqwest blocking），必须离开事件循环线程。
        let outcome = tauri::async_runtime::spawn_blocking(move || {
            let store = handle.state::<Store>();
            ai::suggest_order_constraints(store.inner(), &brief)
        })
        .await
        .map_err(|err| {
            CommandError::new("LOAD_ORDER_AI_TASK", format!("AI 排序线程异常：{err}"))
        })?;

        match outcome {
            Ok(raw) => {
                let (rules, warnings) = loadsort::parse_constraints(&raw);
                ai_used = !rules.is_empty();
                if !warnings.is_empty() {
                    ai_note = Some(warnings.join("；"));
                }
                constraints = rules;
            }
            Err(err) => {
                ai_note = Some(format!("{}（已改用规则整理）", err.message));
            }
        }
    }

    Ok(loadsort::build_suggestion(
        &snapshot,
        &constraints,
        ai_used,
        ai_note,
    ))
}

/// 保存「整理时不许移动」的 MOD 清单。
///
/// 存 mod id 而非 archive 路径：一个 MOD 常带多个 archive，且文件名会随更新变化，
/// 存路径的锁会在下次更新后悄悄失效。未知 id 直接丢弃，不让脏数据进状态文件。
#[tauri::command]
fn set_load_order_pins(store: State<'_, Store>, pins: Vec<String>) -> AppResult<LoadOrderView> {
    let mut data = store
        .data
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let known: std::collections::HashSet<&str> =
        data.mods.iter().map(|entry| entry.id.as_str()).collect();
    let mut seen = std::collections::HashSet::new();
    let mut cleaned = Vec::new();
    for id in pins {
        if known.contains(id.as_str()) && seen.insert(id.clone()) {
            cleaned.push(id);
        }
    }
    data.load_order_pins = cleaned;
    store.save(&data)?;
    let view = loadorder::build_view(&data, data.game_dir.as_deref().map(Path::new));
    Ok(view)
}

/// 保存 REDmod 的加载顺序（先加载的先赢）。
///
/// 与 archive 的 `save_load_order` 是两条独立链路：archive 走 `normalized_order`
/// （元素是 archive 相对路径），REDmod 走 `redmod::normalize_order`（元素是 mod id），
/// 混在一起会把对方的条目误当成脏数据剔除。
///
/// 顺序存好之后必须重跑 redMod——`modlist.txt` 的行序就是这个顺序，不重新部署
/// 的话游戏读到的还是旧产物（redMod 察觉不到纯重排，见 `redmod::needs_rebuild`）。
#[tauri::command]
fn save_redmod_order(store: State<'_, Store>, order: Vec<String>) -> AppResult<LoadOrderView> {
    let vdir = vortex_guard(store.inner())?;
    let mut data = store.data.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let valid: std::collections::HashSet<String> = data
        .mods
        .iter()
        .filter(|entry| entry.layout == schema::InstallLayout::Redmod)
        .map(|entry| entry.id.clone())
        .collect();
    let mut seen = std::collections::HashSet::new();
    for id in &order {
        if !valid.contains(id) {
            return Err(CommandError::new(
                "REDMOD_ORDER_UNKNOWN",
                format!("REDmod 加载顺序里出现了未知模组：{id}"),
            ));
        }
        if !seen.insert(id.clone()) {
            return Err(CommandError::new(
                "REDMOD_ORDER_DUPLICATE",
                "REDmod 加载顺序里有重复条目。",
            ));
        }
    }

    // 前端只提交可见（启用）项：先按上一轮骨架把禁用项插回原位，再归一化。
    let previous = data.redmod_order.clone();
    data.redmod_order = redmod::merge_disabled_order(&valid, &order, &previous);
    let requested = data.redmod_order.clone();
    data.redmod_order = redmod::normalize_order(&data, &requested);
    redmod::mark_dirty();
    let game_dir = data.game_dir.clone();
    store.save(&data)?;
    let view = loadorder::build_view(&data, game_dir.as_deref().map(Path::new));
    drop(data);

    // 部署要在锁外跑：redMod 加载 6.5 MB 的 metadata.json，可能几十秒。
    let mut warnings = Vec::new();
    redmod::flush_into(&store, game_dir.as_deref(), &mut warnings);
    if let Some(first) = warnings.into_iter().next() {
        // 顺序已经存下来了，只是这一轮编译没成功；用错误把原因带出去，
        // 前端能看到「顺序已保存但部署失败」，而不是以为顺序丢了。
        return Err(CommandError::new("REDMOD_DEPLOY_FAILED", first));
    }

    let _ = vortex_apply(store.inner(), vdir, redmod_changes(store.inner(), &requested));
    Ok(view)
}

#[tauri::command]
fn export_modlist(store: State<'_, Store>, force: bool) -> AppResult<ModlistExport> {
    let mut data = store.data.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let game_root = data.game_dir.clone().ok_or_else(|| {
        CommandError::new("GAME_NOT_CONFIGURED", "没有游戏目录，无法写入 modlist.txt。")
    })?;
    let backup_path = if force {
        let path = loadorder::backup_unmanaged_modlist(&store, Path::new(&game_root))?;
        data.settings.write_modlist = true;
        path
    } else {
        None
    };
    let path = loadorder::write_modlist(&data, Path::new(&game_root))?;
    data.settings.write_modlist = true;
    store.save(&data)?;
    Ok(ModlistExport {
        path,
        backup_path,
    })
}

#[tauri::command]
fn remove_modlist(store: State<'_, Store>) -> AppResult<bool> {
    let mut data = store.data.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let game_root = data.game_dir.clone().ok_or_else(|| {
        CommandError::new("GAME_NOT_CONFIGURED", "没有游戏目录。")
    })?;
    let removed = loadorder::remove_modlist(Path::new(&game_root))?;
    data.settings.write_modlist = false;
    store.save(&data)?;
    Ok(removed)
}

#[tauri::command]
fn set_write_modlist(store: State<'_, Store>, enabled: bool) -> AppResult<LoadOrderView> {
    let mut data = store.data.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let game_root = data.game_dir.clone().ok_or_else(|| {
        CommandError::new("GAME_NOT_CONFIGURED", "没有游戏目录。")
    })?;
    if enabled {
        loadorder::write_modlist(&data, Path::new(&game_root))?;
    }
    data.settings.write_modlist = enabled;
    store.save(&data)?;
    Ok(loadorder::build_view(&data, Some(Path::new(&game_root))))
}

/// 迁移暂存区后返回的报告：搬了几个、哪些失败（失败项保留在原处，不会丢文件）。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct StagingMoveReport {
    from: String,
    to: String,
    moved: usize,
    failed: Vec<String>,
}

/// 工具位置探测结果：给设置页「自动查找」按钮回显用。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ToolProbe {
    tool: String,
    found: bool,
    path: Option<String>,
    message: String,
}

/// 跨盘时 rename 会失败，退回"复制后删除"。只在 rename 失败时调用。
fn move_dir_fallback(from: &Path, to: &Path) -> std::io::Result<()> {
    if from.is_dir() {
        std::fs::create_dir_all(to)?;
        for entry in std::fs::read_dir(from)? {
            let entry = entry?;
            let dest = to.join(entry.file_name());
            if entry.file_type()?.is_dir() {
                move_dir_fallback(&entry.path(), &dest)?;
            } else {
                std::fs::copy(entry.path(), &dest)?;
            }
        }
        std::fs::remove_dir_all(from)
    } else {
        std::fs::copy(from, to).map(|_| ()).and_then(|_| std::fs::remove_file(from))
    }
}

/// 暂存区建议（deepseek 任务·模块一）：枚举本地固定磁盘，按剩余空间排序。
/// 走 PowerShell CIM 查询（项目对系统信息查询的既有口径），失败返回空列表
/// ——「建议」是锦上添花，查不到就让用户手动选。
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DriveSuggestion {
    pub drive: String,
    pub free_bytes: u64,
    pub total_bytes: u64,
}

#[tauri::command]
fn suggest_staging_dir() -> AppResult<Vec<DriveSuggestion>> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const PS_QUERY: &str = "Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | Select-Object DeviceID,FreeSpace,Size | ConvertTo-Json -Compress";
    let output = std::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", PS_QUERY])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| CommandError::new("SUGGEST_FAILED", format!("无法查询磁盘信息：{e}")))?;
    if !output.status.success() {
        return Ok(Vec::new());
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let Ok(parsed) = serde_json::from_str::<serde_json::Value>(stdout.trim()) else {
        return Ok(Vec::new());
    };
    // 单盘时 ConvertTo-Json 不返回数组，统一包一层。
    let items = match parsed {
        serde_json::Value::Array(items) => items,
        item @ serde_json::Value::Object(_) => vec![item],
        _ => Vec::new(),
    };
    let mut drives: Vec<DriveSuggestion> = items
        .iter()
        .filter_map(|item| {
            let drive = item.get("DeviceID")?.as_str()?.to_string();
            let free_bytes = item.get("FreeSpace")?.as_u64()?;
            let total_bytes = item.get("Size")?.as_u64().unwrap_or(0);
            Some(DriveSuggestion { drive, free_bytes, total_bytes })
        })
        .collect();
    drives.sort_by(|a, b| b.free_bytes.cmp(&a.free_bytes));
    Ok(drives)
}

/// 更改暂存区位置：校验 → 搬迁既有文件 → 重写所有指向旧位置的路径 → 落盘。
///
/// 失败项**保留在原处**并在报告里列出，绝不静默删除（用户数据优先）。
#[tauri::command]
async fn change_staging_dir(
    app: tauri::AppHandle,
    busy: State<'_, BusyTasks>,
    new_dir: String,
) -> AppResult<StagingMoveReport> {
    let _guard = busy.begin("迁移暂存区");
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let store = handle.state::<Store>();
        // 只读快照：用来做前置校验（游戏目录 / 数据目录）。真正的修改在下面持锁做。
        let data = store.snapshot_data();
        let old = store.staging_dir();
        let trimmed = new_dir.trim().to_string();
        if trimmed.is_empty() {
            return Err(CommandError::new("STAGING_PATH", "请先选择一个目录。"));
        }
        let target = PathBuf::from(&trimmed);
        if target == old {
            return Err(CommandError::new("STAGING_PATH", "这个位置就是当前暂存区。"));
        }
        // 红线：暂存区不能落在游戏目录里（卸载逻辑按清单删文件，混在一起太危险）。
        if let Some(game) = data.game_dir.as_deref() {
            let game_path = Path::new(game);
            if target == game_path || store::is_within(game_path, &target) {
                return Err(CommandError::new(
                    "STAGING_PATH",
                    "暂存区不能放在游戏目录里，请另选一个普通文件夹。",
                ));
            }
        }
        // 也不允许塞进启动器数据目录（会和 backups / secrets / 状态文件混住）。
        if target == store.data_dir || store::is_within(&store.data_dir, &target) {
            return Err(CommandError::new(
                "STAGING_PATH",
                "暂存区不能放在启动器数据目录里，请另选一个文件夹。",
            ));
        }

        std::fs::create_dir_all(&target).map_err(|err| {
            CommandError::new("STAGING_PATH", format!("无法创建目录：{err}"))
        })?;
        let probe = target.join(".cdl-write-probe");
        std::fs::write(&probe, b"probe").map_err(|err| {
            CommandError::new("STAGING_PATH", format!("目标目录不可写：{err}"))
        })?;
        let _ = std::fs::remove_file(&probe);

        let mut moved = 0usize;
        let mut failed: Vec<String> = Vec::new();
        if let Ok(entries) = std::fs::read_dir(&old) {
            for entry in entries.flatten() {
                let name = entry.file_name();
                let dest = target.join(&name);
                if dest.exists() {
                    failed.push(format!("{}（目标已存在）", name.to_string_lossy()));
                    continue;
                }
                match std::fs::rename(entry.path(), &dest)
                    .or_else(|_| move_dir_fallback(&entry.path(), &dest))
                {
                    Ok(()) => moved += 1,
                    Err(err) => failed.push(format!("{}（{err}）", name.to_string_lossy())),
                }
            }
        }

        // 重写绝对路径：stagingPath 与（若在暂存区内的）sourceZip。
        let rebase = |path: &str| -> Option<String> {
            let value = Path::new(path);
            if !store::is_within(&old, value) {
                return None;
            }
            let rel = value.strip_prefix(&old).ok()?;
            Some(target.join(rel).to_string_lossy().to_string())
        };
        // 改内存必须持 `store.data` 的锁：`Store::save` 只落盘、不回写内存。
        // 早先这里拿的是 snapshot（一份克隆），改完只 `save` —— 本会话里 `staging_path`
        // 仍是旧路径，用户再点「启用」时 installer 按旧路径找不到目录，会把条目当成
        // 失效模组 forget 掉（数据看起来丢了），重启后又恢复正常，极难归因。
        let mut rewritten = 0usize;
        {
            let mut guard = store.data.lock().unwrap_or_else(|e| e.into_inner());
            let original = guard.clone();
            for entry in guard.mods.iter_mut() {
                if let Some(next) = rebase(&entry.staging_path) {
                    entry.staging_path = next;
                    rewritten += 1;
                }
                if let Some(zip) = entry.source_zip.clone() {
                    if let Some(next) = rebase(&zip) {
                        entry.source_zip = Some(next);
                    }
                }
            }
            guard.staging_dir = target.to_string_lossy().to_string();
            if let Err(err) = store.save(&guard) {
                // 盘没写成，内存也退回原状，避免「界面变了、重启又回去」的幽灵状态。
                *guard = original;
                return Err(CommandError::new(
                    "STAGING_SAVE_FAILED",
                    format!("暂存区已搬到新位置，但状态文件没能写入：{err}。请重启启动器让它重新扫描。"),
                ));
            }
        }
        // `staging_dir` 是另一把锁，刻意不与 `data` 嵌套持有（见 store.rs 字段注释）。
        store.set_staging_dir(target.clone());
        // 搬到新盘之后，旧 scope 覆盖不到新位置——封面会立刻全黑。
        if let Err(err) = handle.asset_protocol_scope().allow_directory(&target, true) {
            log_lifecycle(&handle, &format!("stage=asset_scope_failed err={err}"));
        }
        log_lifecycle(
            &handle,
            &format!(
                "stage=staging moved_to={} moved={moved} rewritten={rewritten} failed={}",
                target.display(),
                failed.len()
            ),
        );
        Ok(StagingMoveReport {
            from: old.to_string_lossy().to_string(),
            to: target.to_string_lossy().to_string(),
            moved,
            failed,
        })
    })
    .await
    .map_err(|err| CommandError::new("STAGING_MOVE", format!("迁移任务异常：{err}")))?
}

/// 「自动查找」：立即探测工具位置并回显，不再依赖"留空自动检测"的隐式约定。
#[tauri::command]
fn detect_tool(tool: String) -> AppResult<ToolProbe> {
    let (found, message_missing) = match tool.as_str() {
        "archive" => (installer::find_archive_tool(""), "未找到 7z.exe / UnRAR.exe。可安装 7-Zip / WinRAR，或手动指定路径。"),
        "wolvenkit" => (wolvenkit::detect_cli(), "未找到 WolvenKit.Cli.exe。可执行 dotnet tool install -g wolvenkit.cli，或手动指定路径。"),
        other => {
            return Err(CommandError::new(
                "INVALID_TOOL",
                format!("未知的工具：{other}"),
            ))
        }
    };
    Ok(match found {
        Some(path) => ToolProbe {
            tool,
            found: true,
            path: Some(path.to_string_lossy().to_string()),
            message: "已找到".to_string(),
        },
        None => ToolProbe {
            tool,
            found: false,
            path: None,
            message: message_missing.to_string(),
        },
    })
}

#[tauri::command]
fn set_settings(store: State<'_, Store>, settings: Settings) -> AppResult<Settings> {
    let mut data = store.data.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    // 启动前置命令会被系统命令行原样执行：渲染层若被攻破，改这个字段就是
    // 现成的宿主任意命令执行入口。前端有二次确认，后端仍做一道长度/控制字符
    // 校验（M1 纵深防御），不让一整段脚本或换行拼接的命令通过。
    if settings.launch_pre_command.chars().count() > 512 {
        return Err(CommandError::new(
            "INVALID_SETTING",
            "启动前置命令不能超过 512 个字符。",
        ));
    }
    if settings.launch_pre_command.chars().any(|ch| ch.is_control()) {
        return Err(CommandError::new(
            "INVALID_SETTING",
            "启动前置命令不能包含换行或控制字符，请写成单行命令或脚本路径。",
        ));
    }
    let launch = settings.launch_method.as_str();
    if !matches!(launch, "auto" | "steam" | "direct") {
        return Err(CommandError::new(
            "INVALID_SETTING",
            "启动方式必须是 auto / steam / direct。",
        ));
    }
    if !matches!(settings.close_behavior.as_str(), "tray" | "exit") {
        return Err(CommandError::new(
            "INVALID_SETTING",
            "关闭行为必须是 tray（最小化到托盘）或 exit（直接退出）。",
        ));
    }
    // 与 config_pack 导入共用同一口径（ai::validate_base_url）：协议 + 主机名都要有。
    if !settings.ai_base_url.trim().is_empty() {
        ai::validate_base_url(&settings.ai_base_url).map_err(|reason| {
            CommandError::new("INVALID_SETTING", format!("接口地址（Base URL）不可用：{reason}"))
        })?;
    }
    if settings.ai_model.trim().is_empty() {
        return Err(CommandError::new(
            "INVALID_SETTING",
            "模型名称不能为空。",
        ));
    }
    if !matches!(settings.ai_protocol.as_str(), "openai" | "anthropic") {
        return Err(CommandError::new(
            "INVALID_SETTING",
            "接口协议必须是 openai（OpenAI 兼容）或 anthropic（Anthropic 原生）。",
        ));
    }
    if !settings.archive_tool_path.trim().is_empty()
        && !Path::new(settings.archive_tool_path.trim()).is_file()
    {
        return Err(CommandError::new(
            "INVALID_SETTING",
            "指定的 7z.exe / UnRAR.exe 路径不存在。",
        ));
    }
    wolvenkit::validate_cli_setting(&settings.wolvenkit_cli_path)?;
    let mut settings = settings;
    settings.ai_base_url = settings.ai_base_url.trim().to_string();
    settings.ai_model = settings.ai_model.trim().to_string();
    settings.ai_protocol = settings.ai_protocol.trim().to_string();
    settings.archive_tool_path = settings.archive_tool_path.trim().to_string();
    settings.wolvenkit_cli_path = settings.wolvenkit_cli_path.trim().to_string();
    settings.wolvenkit_timeout_secs =
        wolvenkit::clamp_timeout_secs(settings.wolvenkit_timeout_secs);
    settings.launch_args = settings.launch_args.trim().to_string();
    // 部署方式 / 启动高级选项（deepseek 任务·模块一）：白名单校验，防手输脏值。
    if !matches!(
        settings.deploy_mode.as_str(),
        "hardlink" | "symlink" | "copy"
    ) {
        return Err(CommandError::new(
            "INVALID_SETTING",
            "部署方式必须是 hardlink / symlink / copy。",
        ));
    }
    if !matches!(
        settings.launch_gpu_pref.as_str(),
        "auto" | "dedicated" | "integrated"
    ) {
        return Err(CommandError::new(
            "INVALID_SETTING",
            "显卡偏好必须是 auto / dedicated / integrated。",
        ));
    }
    if !matches!(
        settings.launch_priority.as_str(),
        "normal" | "high" | "low"
    ) {
        return Err(CommandError::new(
            "INVALID_SETTING",
            "进程优先级必须是 normal / high / low。",
        ));
    }
    settings.launch_pre_command = settings.launch_pre_command.trim().to_string();
    // 背景图偏好（看板【皮肤 UI 优化】）：路径去空白；数值钳制，防滑块/手输越界。
    settings.background_image = settings.background_image.trim().to_string();
    settings.background_opacity = settings.background_opacity.clamp(0, 100);
    settings.background_blur = settings.background_blur.min(40);
    // 背景图焦点（背景图焦点任务）：填充模式白名单 + 焦点百分比钳制。
    // u8 已经天然 <= 255，但焦点是百分比语义，超过 100 会让 background-position
    // 出现负数补边（CSS 允许 >100% 但要靠补边填充），前端算不出预期画面，直接钳死。
    if !matches!(
        settings.background_fit.as_str(),
        "cover" | "contain" | "stretch"
    ) {
        return Err(CommandError::new(
            "INVALID_SETTING",
            "背景填充模式必须是 cover / contain / stretch。",
        ));
    }
    settings.background_pos_x = settings.background_pos_x.min(100);
    settings.background_pos_y = settings.background_pos_y.min(100);
    settings.background_dim = settings.background_dim.min(100);
    // 缩放倍率（3A-3）：1.0–3.0；NaN/Infinity 一律回到 1.0，避免污染 CSS。
    if settings.background_zoom.is_finite() {
        settings.background_zoom = settings.background_zoom.clamp(1.0, 3.0);
    } else {
        settings.background_zoom = 1.0;
    }
    // 存档管理：上限钳制；编辑器路径存在性校验（空 = 未配置，允许）。
    settings.snapshot_limit = settings.snapshot_limit.clamp(1, 100);
    settings.save_editor_path = settings.save_editor_path.trim().to_string();
    if !settings.save_editor_path.is_empty()
        && !Path::new(&settings.save_editor_path).is_file()
    {
        return Err(CommandError::new(
            "INVALID_SETTING",
            "指定的存档编辑器 .exe 路径不存在。",
        ));
    }
    data.settings = settings;
    store.save(&data)?;
    Ok(data.settings.clone())
}

/// 背景图读取结果。
///
/// 返回 data URL 而不是文件路径：CSP 只放行 `img-src data:`，而资产协议的白名单
/// 只覆盖 `$APPDATA`——便携版的数据目录在 exe 同级，走 asset:// 会读不到。
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundImageData {
    pub data_url: String,
    /// 实际交给前端的字节数（压缩后）。
    pub size: u64,
    /// 原图的字节数，用来告诉用户「省了多少」。
    pub source_size: u64,
    /// 原图被缩过或转码过。
    pub compressed: bool,
}

/// 缓存图最长边。1920 在 4K 屏上按 CSS 像素铺满也够看（还压着一层暗化遮罩和
/// 模糊），再高只是白烧显存。
const BACKGROUND_MAX_EDGE: u32 = 1920;
/// 转码质量。80 是「看不出块效应」的起点，1920 宽的街景大约 400 KB。
const BACKGROUND_JPEG_QUALITY: u8 = 80;
/// 源图硬上限。压缩是异步的，但几百 MB 的图光解码就要吃掉大块内存，
/// 与其让用户干等十几秒，不如直接说清楚。
const BACKGROUND_MAX_SOURCE: u64 = 200 * 1024 * 1024;

#[tauri::command]
async fn read_background_image(
    app: tauri::AppHandle,
    path: String,
) -> AppResult<BackgroundImageData> {
    let data_dir = app.state::<Store>().data_dir.clone();
    // 解码 + 缩放 + 转码全在阻塞线程里：一张 4K 原图要几百毫秒，放主线程会卡住窗口。
    tauri::async_runtime::spawn_blocking(move || prepare_background(&data_dir, &path))
        .await
        .map_err(|err| CommandError::new("BACKGROUND_TASK", format!("背景图处理线程异常：{err}")))?
}

/// 把任意尺寸的图片压成一张最长边 1920 的 JPEG，写进缓存目录后返回 data URL。
///
/// 以前这里是把原图直接 base64 塞给前端、超过 20 MiB 就拦下。拦下来用户没法用，
/// 不拦则会一次性把几十 MB 字符串推进 WebView——两头都不对，所以改成后端压一次、
/// 按源文件指纹缓存，换图时顺手清掉旧缓存。
fn prepare_background(data_dir: &Path, raw_path: &str) -> AppResult<BackgroundImageData> {
    let trimmed = raw_path.trim();
    if trimmed.is_empty() {
        return Err(CommandError::new(
            "BACKGROUND_EMPTY",
            "背景图路径为空，请先选择图片。",
        ));
    }
    let file = Path::new(trimmed);
    let meta = std::fs::metadata(file).map_err(|error| {
        CommandError::new(
            "BACKGROUND_NOT_FOUND",
            format!("背景图读取失败：{}（请确认文件还在原位置）", error),
        )
    })?;
    if !meta.is_file() {
        return Err(CommandError::new(
            "BACKGROUND_NOT_FOUND",
            "背景图路径指向的不是文件。",
        ));
    }
    if meta.len() > BACKGROUND_MAX_SOURCE {
        return Err(CommandError::new(
            "BACKGROUND_TOO_LARGE",
            format!(
                "背景图超过 200 MiB（当前 {:.0} MiB），这个尺寸已经不适合当壁纸了。",
                meta.len() as f64 / 1024.0 / 1024.0
            ),
        ));
    }
    let source_size = meta.len();
    let cache_dir = data_dir.join("background-cache");
    let cache_file = cache_dir.join(format!("bg-{}.jpg", fingerprint(file, &meta)));

    // 指纹没变就直接吃缓存：同一张图在每次启动时都要读一遍，没必要反复解码。
    let bytes = match std::fs::read(&cache_file) {
        Ok(bytes) => bytes,
        Err(_) => {
            let bytes = encode_background(file, source_size)?;
            std::fs::create_dir_all(&cache_dir).map_err(|error| {
                CommandError::new(
                    "BACKGROUND_CACHE",
                    format!("无法创建背景图缓存目录 {}：{error}", cache_dir.display()),
                )
            })?;
            // 先写临时文件再改名：中途失败不会在缓存目录里留半张图。
            let temp = cache_file.with_extension("jpg.tmp");
            std::fs::write(&temp, &bytes).map_err(|error| {
                CommandError::new(
                    "BACKGROUND_CACHE",
                    format!("无法写入背景图缓存 {}：{error}", temp.display()),
                )
            })?;
            if std::fs::rename(&temp, &cache_file).is_err() {
                std::fs::copy(&temp, &cache_file).map_err(|error| {
                    CommandError::new(
                        "BACKGROUND_CACHE",
                        format!("无法写入背景图缓存 {}：{error}", cache_file.display()),
                    )
                })?;
                let _ = std::fs::remove_file(&temp);
            }
            // 换图之后旧的缓存就没人引用了，顺手删掉，别让目录越滚越大。
            prune_background_cache(&cache_dir, &cache_file);
            bytes
        }
    };

    let size = bytes.len() as u64;
    Ok(BackgroundImageData {
        data_url: format!("data:image/jpeg;base64,{}", base64_encode(&bytes)),
        size,
        source_size,
        compressed: size < source_size,
    })
}

/// 解码 → 按比例缩到最长边 1920 → 编码成 JPEG。
fn encode_background(file: &Path, _source_size: u64) -> AppResult<Vec<u8>> {
    let image = image::open(file).map_err(|_| {
        CommandError::new("BACKGROUND_DECODE", "图片格式不支持或已损坏。")
    })?;
    let image = if image.width().max(image.height()) > BACKGROUND_MAX_EDGE {
        image.resize(
            BACKGROUND_MAX_EDGE,
            BACKGROUND_MAX_EDGE,
            image::imageops::FilterType::Lanczos3,
        )
    } else {
        image
    };
    let mut out = Vec::new();
    let mut encoder =
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, BACKGROUND_JPEG_QUALITY);
    encoder
        .encode_image(&image.to_rgb8())
        .map_err(|error| CommandError::new("BACKGROUND_ENCODE", format!("背景图转码失败：{error}")))?;
    Ok(out)
}

/// 缓存键：源文件路径 + 大小 + 修改时间。三者任一变化就重新压一次。
fn fingerprint(path: &Path, meta: &std::fs::Metadata) -> String {
    const OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
    const PRIME: u64 = 0x0000_0100_0000_01b3;
    let mut hash = OFFSET;
    let mut eat = |bytes: &[u8]| {
        for byte in bytes {
            hash ^= *byte as u64;
            hash = hash.wrapping_mul(PRIME);
        }
    };
    eat(path.to_string_lossy().as_bytes());
    eat(&meta.len().to_le_bytes());
    let modified = meta
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|value| value.as_secs())
        .unwrap_or(0);
    eat(&modified.to_le_bytes());
    format!("{hash:016x}")
}

/// 只保留当前在用的那张缓存图。
fn prune_background_cache(dir: &Path, keep: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path == keep {
            continue;
        }
        let name = path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or_default();
        if name.starts_with("bg-") {
            let _ = std::fs::remove_file(&path);
        }
    }
}

/// 标准 base64（RFC 4648，带 padding）。没有引入 base64 crate——依赖树里
/// 已经够重了，20 行编码器换来零新依赖值得。
fn base64_encode(data: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(TABLE[(triple >> 18) as usize & 0x3f] as char);
        out.push(TABLE[(triple >> 12) as usize & 0x3f] as char);
        out.push(if chunk.len() > 1 {
            TABLE[(triple >> 6) as usize & 0x3f] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            TABLE[triple as usize & 0x3f] as char
        } else {
            '='
        });
    }
    out
}

/// 测试 Nexus 连接：不落盘、不改已保存的 Key，失败也返回结构化结果。
#[tauri::command]
async fn nexus_test_connection(
    app: tauri::AppHandle,
    key: Option<String>,
) -> AppResult<nexus::NexusTestResult> {
    tauri::async_runtime::spawn_blocking(move || {
        let store = app.state::<Store>();
        Ok(nexus::test_connection(store.inner(), key.as_deref()))
    })
    .await
    .map_err(|e| CommandError::new("NEXUS_TEST_TASK", format!("测试连接任务异常：{e}")))?
}

#[tauri::command]
async fn nexus_status(app: tauri::AppHandle) -> NexusStatus {
    let result = tauri::async_runtime::spawn_blocking(move || {
        let store = app.state::<Store>();
        nexus::status(store.inner())
    })
    .await;
    match result {
        Ok(status) => status,
        Err(err) => NexusStatus {
            configured: false,
            connected: false,
            user: None,
            error: Some(format!("Nexus 状态检查失败：{err}")),
        },
    }
}

#[tauri::command]
async fn nexus_set_key(app: tauri::AppHandle, key: String) -> AppResult<NexusStatus> {
    tauri::async_runtime::spawn_blocking(move || {
        let store = app.state::<Store>();
        nexus::set_key(store.inner(), &key)
    })
    .await
    .map_err(|e| CommandError::new("NEXUS_TASK", format!("Nexus 任务异常：{e}")))?
}

#[tauri::command]
async fn nexus_clear_key(app: tauri::AppHandle) -> AppResult<NexusStatus> {
    tauri::async_runtime::spawn_blocking(move || {
        let store = app.state::<Store>();
        nexus::clear_key(store.inner())
    })
    .await
    .map_err(|e| CommandError::new("NEXUS_TASK", format!("Nexus 任务异常：{e}")))?
}

#[tauri::command]
async fn nexus_browse(
    app: tauri::AppHandle,
    section: String,
) -> AppResult<Vec<NexusModSummary>> {
    tauri::async_runtime::spawn_blocking(move || {
        let store = app.state::<Store>();
        nexus::browse(store.inner(), &section)
    })
    .await
    .map_err(|e| CommandError::new("NEXUS_TASK", format!("Nexus 任务异常：{e}")))?
}

#[tauri::command]
async fn nexus_detail(app: tauri::AppHandle, mod_id: u64) -> AppResult<NexusModDetail> {
    tauri::async_runtime::spawn_blocking(move || {
        let store = app.state::<Store>();
        nexus::detail(store.inner(), mod_id)
    })
    .await
    .map_err(|e| CommandError::new("NEXUS_TASK", format!("Nexus 任务异常：{e}")))?
}

#[tauri::command]
async fn nexus_download(
    app: tauri::AppHandle,
    busy: State<'_, BusyTasks>,
    mod_id: u64,
    file_id: u64,
    file_name: Option<String>,
) -> AppResult<NexusDownloadResult> {
    let _guard = busy.begin("下载文件");
    tauri::async_runtime::spawn_blocking(move || {
        let store = app.state::<Store>();
        nexus::download_and_install(&app, store.inner(), mod_id, file_id, file_name)
    })
    .await
    .map_err(|e| CommandError::new("NEXUS_TASK", format!("Nexus 下载任务异常：{e}")))?
}

// ── 下载中心队列（r13）────────────────────────────────────────────

#[tauri::command]
fn download_queue_list() -> Vec<download_queue::DownloadTask> {
    download_queue::list()
}

#[tauri::command]
fn download_queue_settings_get() -> download_queue::DownloadQueueSettings {
    download_queue::settings()
}

#[tauri::command]
fn download_queue_settings_set(
    app: tauri::AppHandle,
    concurrency: u32,
    auto_import: bool,
    dir: Option<String>,
    proxy: Option<String>,
    speed_limit_mbps: Option<u32>,
    route: Option<String>,
    segments: Option<u32>,
) -> AppResult<download_queue::DownloadQueueSettings> {
    let store = app.state::<Store>();
    let data_dir = store.data_dir.clone();
    drop(store);
    let next = download_queue::DownloadQueueSettings {
        concurrency: concurrency.clamp(1, 3),
        auto_import,
        dir: dir.map(|value| value.trim().to_string()).filter(|value| !value.is_empty()),
        proxy: proxy.map(|value| value.trim().to_string()).filter(|value| !value.is_empty()),
        speed_limit_mbps: speed_limit_mbps.unwrap_or(0),
        route: route.unwrap_or_else(|| "auto".to_string()),
        segments: segments.unwrap_or(4),
    };
    let snapshot = download_queue::set_settings(&data_dir, next);
    download_queue::pump(&app);
    Ok(snapshot)
}

#[tauri::command]
fn download_queue_add(
    app: tauri::AppHandle,
    mod_id: u64,
    file_id: u64,
    name: Option<String>,
    key: Option<String>,
    expires: Option<String>,
    auto_import: Option<bool>,
) -> AppResult<download_queue::DownloadTask> {
    let store = app.state::<Store>();
    let data_dir = store.data_dir.clone();
    drop(store);
    let task = download_queue::add(&data_dir, mod_id, file_id, name, key, expires, auto_import)?;
    download_queue::pump(&app);
    Ok(task)
}

#[tauri::command]
fn download_queue_pause(app: tauri::AppHandle, id: String) -> Option<download_queue::DownloadTask> {
    let store = app.state::<Store>();
    let data_dir = store.data_dir.clone();
    drop(store);
    download_queue::pause(&data_dir, &id)
}

#[tauri::command]
fn download_queue_resume(app: tauri::AppHandle, id: String) -> Option<download_queue::DownloadTask> {
    let store = app.state::<Store>();
    let data_dir = store.data_dir.clone();
    drop(store);
    let task = download_queue::resume(&data_dir, &id);
    download_queue::pump(&app);
    task
}

#[tauri::command]
fn download_queue_cancel(app: tauri::AppHandle, id: String) -> Option<download_queue::DownloadTask> {
    let store = app.state::<Store>();
    let data_dir = store.data_dir.clone();
    drop(store);
    download_queue::cancel(&data_dir, &id)
}

#[tauri::command]
fn download_queue_remove(app: tauri::AppHandle, id: String) -> bool {
    let store = app.state::<Store>();
    let data_dir = store.data_dir.clone();
    drop(store);
    download_queue::remove(&data_dir, &id)
}

#[tauri::command]
fn download_queue_clear_finished(app: tauri::AppHandle) -> usize {
    let store = app.state::<Store>();
    let data_dir = store.data_dir.clone();
    drop(store);
    download_queue::clear_finished(&data_dir)
}

#[tauri::command]
fn nexus_prune_downloads(store: State<'_, Store>, days: Option<u64>) -> usize {
    nexus::prune_downloads(&store, days.unwrap_or(7))
}

/// 批量把 Mod 名称翻成中文（只写 translated_name，永远不动 name）。
///
/// consent 必须为 true，否则后端直接回 AI_CONSENT_REQUIRED —— 与诊断同一条同意门。
/// only_ids 为 Some 时只翻这些 id；Some(&[]) 表示"什么都不翻"，不会退化成全库。
#[tauri::command]
async fn mods_translate(
    app: tauri::AppHandle,
    busy: State<'_, BusyTasks>,
    consent: bool,
    only_ids: Option<Vec<String>>,
    limit: Option<usize>,
) -> AppResult<TranslateReport> {
    let _guard = busy.begin("翻译名称");
    tauri::async_runtime::spawn_blocking(move || {
        let store = app.state::<Store>();
        ai::translate_mod_names(store.inner(), consent, only_ids.as_deref(), limit)
    })
    .await
    .map_err(|e| CommandError::new("AI_TASK", format!("AI 翻译任务异常：{e}")))?
}

/// AI 汉化（T5）：只读计划，不联网、不落盘。
#[tauri::command]
fn ai_loc_plan(store: State<'_, Store>, mod_id: String) -> AppResult<schema::AiLocPlan> {
    ailoc::plan(store.inner(), &mod_id)
}

/// AI 汉化（T5）：翻译 + 生成覆盖层 + 打包 + 部署。
#[tauri::command]
async fn ai_loc_apply(
    app: tauri::AppHandle,
    busy: State<'_, BusyTasks>,
    mod_id: String,
    consent: bool,
    policy_ack: bool,
) -> AppResult<schema::AiLocReport> {
    let _guard = busy.begin("生成汉化");
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let store = handle.state::<Store>();
        let game_root = store
            .snapshot_data()
            .game_dir
            .clone()
            .ok_or_else(|| CommandError::new("NO_GAME_DIR", "还没有绑定游戏目录，无法部署覆盖层。"))?;
        ailoc::apply(store.inner(), &mod_id, Path::new(&game_root), consent, policy_ack)
    })
    .await
    .map_err(|e| CommandError::new("AI_LOC_TASK", format!("汉化任务异常：{e}")))?
}

/// AI 汉化（T5）：撤销覆盖层，只删自己登记的文件。
#[tauri::command]
fn ai_loc_revert(store: State<'_, Store>, mod_id: String) -> AppResult<schema::AiLocReport> {
    ailoc::revert(store.inner(), &mod_id)
}

/// AI 补丁（T6）：生成提案（会外发脚本片段，调用方必须先拿到用户同意）。
#[tauri::command]
async fn ai_fix_propose(
    app: tauri::AppHandle,
    busy: State<'_, BusyTasks>,
    mod_id: String,
    intent: String,
) -> AppResult<schema::AiFixProposal> {
    let _guard = busy.begin("生成补丁");
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let store = handle.state::<Store>();
        aifix::propose(store.inner(), &mod_id, &intent)
    })
    .await
    .map_err(|e| CommandError::new("AI_FIX_TASK", format!("补丁任务异常：{e}")))?
}

/// AI 补丁（T6）：确认后写入独立 .reds 并登记。
#[tauri::command]
async fn ai_fix_apply(
    app: tauri::AppHandle,
    busy: State<'_, BusyTasks>,
    mod_id: String,
    code: String,
    intent: String,
    acknowledged: bool,
) -> AppResult<schema::AiFixReport> {
    let _guard = busy.begin("应用补丁");
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let store = handle.state::<Store>();
        let game_root = store
            .snapshot_data()
            .game_dir
            .clone()
            .ok_or_else(|| CommandError::new("NO_GAME_DIR", "还没有绑定游戏目录，无法写入补丁。"))?;
        aifix::apply(
            store.inner(),
            &mod_id,
            Path::new(&game_root),
            &code,
            &intent,
            acknowledged,
        )
    })
    .await
    .map_err(|e| CommandError::new("AI_FIX_TASK", format!("补丁任务异常：{e}")))?
}

/// AI 补丁（T6）：撤销单个补丁。
#[tauri::command]
fn ai_fix_revert(
    store: State<'_, Store>,
    mod_id: String,
    target: String,
) -> AppResult<schema::AiFixReport> {
    aifix::revert(store.inner(), &mod_id, &target)
}

/// 汉化词表：当前状态（条数、来源分布、共享开关）。
#[tauri::command]
fn glossary_status(store: State<'_, Store>) -> AppResult<glossary::GlossaryStatus> {
    glossary::status(store.inner())
}

/// 导出词表包到数据目录，返回落盘路径。
///
/// 刻意不用「另存为」对话框：只申请了 `dialog:allow-open` 权限，加保存对话框要动
/// capabilities。导出到固定目录 + 「打开所在文件夹」按钮，对用户更少一步。
#[tauri::command]
fn glossary_export(store: State<'_, Store>) -> AppResult<String> {
    let json = glossary::export_pack(store.inner())?;
    let dir = store.data_dir.join("exports");
    std::fs::create_dir_all(&dir)
        .map_err(|e| CommandError::new("GLOSSARY_WRITE", format!("无法创建导出目录：{e}")))?;
    let path = dir.join(format!("glossary-{}.json", store::now_stamp()));
    std::fs::write(&path, json)
        .map_err(|e| CommandError::new("GLOSSARY_WRITE", format!("无法写入词表文件：{e}")))?;
    Ok(path.to_string_lossy().to_string())
}

/// 导入词表包（本地译文优先，云端只补空缺）。
#[tauri::command]
fn glossary_import(store: State<'_, Store>, path: String) -> AppResult<glossary::GlossaryMerge> {
    let raw = std::fs::read_to_string(path.trim()).map_err(|e| {
        CommandError::new("GLOSSARY_READ", format!("无法读取词表文件：{e}"))
    })?;
    glossary::merge_pack(store.inner(), &raw)
}

/// 词表共享配置（本地文件，不进状态 schema）。
#[tauri::command]
fn glossary_config(store: State<'_, Store>) -> glossary::GlossaryConfig {
    glossary::load_config(store.inner())
}

#[tauri::command]
fn glossary_set_config(
    store: State<'_, Store>,
    enabled: bool,
    remote_url: String,
) -> AppResult<glossary::GlossaryConfig> {
    let config = glossary::GlossaryConfig {
        enabled,
        remote_url: remote_url.trim().to_string(),
    };
    glossary::save_config(store.inner(), &config)?;
    Ok(config)
}

/// 从云端拉取词表并合并。网络请求必须离开主线程。
#[tauri::command]
async fn glossary_sync(app: tauri::AppHandle) -> AppResult<glossary::GlossaryMerge> {
    tauri::async_runtime::spawn_blocking(move || {
        let store = app.state::<Store>();
        glossary::sync_remote(store.inner())
    })
    .await
    .map_err(|e| CommandError::new("GLOSSARY_TASK", format!("词表同步任务异常：{e}")))?
}

/// 导出全局配置到数据目录 exports/，返回落盘路径（不含任何密钥）。
#[tauri::command]
fn config_export(app: tauri::AppHandle, store: State<'_, Store>) -> AppResult<String> {
    let version = app.package_info().version.to_string();
    config_pack::export_to_data_dir(store.inner(), &version)
}

/// 导入全局配置。解析或版本校验失败时不写任何状态。
///
/// `apply_sensitive` 默认 false：`aiBaseUrl / wolvenkitCliPath / archiveToolPath /
/// launchArgs` 四项会先回给前端让用户确认，确认后用同一份文件再导一次、带上 true。
/// 这样「导入一份别人分享的配置」不会静默地把 API Key 指向别人的服务器。
#[tauri::command]
fn config_import(
    store: State<'_, Store>,
    path: String,
    apply_sensitive: Option<bool>,
) -> AppResult<config_pack::ImportReport> {
    config_pack::import_from(
        store.inner(),
        std::path::Path::new(path.trim()),
        apply_sensitive.unwrap_or(false),
    )
}

/// 安全模式当前状态（是否处于安全模式、快照时间、停用了多少 Mod）。
#[tauri::command]
fn safemode_state(store: State<'_, Store>) -> safemode::SafeModeState {
    safemode::state(store.inner())
}

/// 进入安全模式：只断开部署链接，不删除任何 Mod 文件。
#[tauri::command]
async fn safemode_enter(app: tauri::AppHandle) -> AppResult<safemode::SafeModeReport> {
    tauri::async_runtime::spawn_blocking(move || {
        let store = app.state::<Store>();
        safemode::enter(store.inner())
    })
    .await
    .map_err(|e| CommandError::new("SAFEMODE_TASK", format!("安全模式任务异常：{e}")))?
}

/// 恢复到禁用前：按快照恢复启用集合与顺序并重新部署。
#[tauri::command]
async fn safemode_exit(app: tauri::AppHandle) -> AppResult<safemode::SafeModeReport> {
    tauri::async_runtime::spawn_blocking(move || {
        let store = app.state::<Store>();
        safemode::exit(store.inner())
    })
    .await
    .map_err(|e| CommandError::new("SAFEMODE_TASK", format!("安全模式任务异常：{e}")))?
}

/// 兼容性体检：只查核心前置框架（RED4ext / ArchiveXL / TweakXL / Codeware），
/// 不再逐 Mod 找元数据。只读，不修改任何文件。
#[tauri::command]
async fn compat_scan(
    app: tauri::AppHandle,
    target: Option<String>,
) -> AppResult<compat::CompatReport> {
    tauri::async_runtime::spawn_blocking(move || {
        let store = app.state::<Store>();
        let data = store.snapshot_data();
        // 目标版本取「当前绑定的游戏 exe 实际版本」，取不到退回上次记录；
        // 两者都没有时传 None，报告里会标成"未知版本"，界面不下结论。
        let game = current_game(&data).ok();
        let root = game
            .as_ref()
            .map(|info| PathBuf::from(&info.root))
            .or_else(|| data.game_dir.as_deref().map(PathBuf::from));
        let resolved = target
            .filter(|value| !value.trim().is_empty())
            .or_else(|| game.as_ref().and_then(|info| info.version.clone()))
            .or_else(|| data.last_game_version.clone());
        compat::scan(root.as_deref(), resolved.as_deref())
    })
    .await
    .map_err(|e| CommandError::new("COMPAT_TASK", format!("兼容体检任务异常：{e}")))?
}

/// 执行一条 AI 诊断动作。
///
/// 前端必须先在二次确认弹窗里让用户确认；这里仍会**重新校验**动作（白名单 + 模组
/// 存在性），并在动磁盘前创建环境快照——失败即中止，不留"改了一半"的现场。
#[tauri::command]
async fn ai_apply_action(
    app: tauri::AppHandle,
    action: schema::AiFixAction,
) -> AppResult<schema::AiActionReport> {
    tauri::async_runtime::spawn_blocking(move || {
        let store = app.state::<Store>();
        aiact::apply(store.inner(), &action)
    })
    .await
    .map_err(|e| CommandError::new("AI_ACTION_TASK", format!("执行 AI 动作出错：{e}")))?
}

/// 批量给已有记录补 Nexus 官方封面。
///
/// 必须走 spawn_blocking：内部逐条串行请求 + 250ms 节流，几百个 Mod 时会跑几十秒，
/// 直接放在异步运行时里会占住主线程。
/// 封面缓存现状（文件数 / 占用 / 待补数量 / 目录）。
#[tauri::command]
fn cover_cache_stats(store: State<'_, Store>) -> AppResult<covers::CoverCacheStats> {
    Ok(covers::stats(store.inner()))
}

/// 补全封面缓存。`ids` 为 None 表示全库；给了就只补这几个模组。
///
/// 网络 IO 必须离开事件循环线程：100 多张图按 4 并发也要好几秒。
#[tauri::command]
async fn cover_cache_fill(
    app: tauri::AppHandle,
    ids: Option<Vec<String>>,
) -> AppResult<covers::CoverCacheReport> {
    tauri::async_runtime::spawn_blocking(move || {
        let store = app.state::<Store>();
        covers::fill(store.inner(), ids)
    })
    .await
    .map_err(|err| CommandError::new("COVER_CACHE_TASK", format!("封面缓存线程异常：{err}")))?
}

/// 清空封面缓存（只删 `covers/` 下本程序写出的文件）。
#[tauri::command]
fn cover_cache_clear(store: State<'_, Store>) -> AppResult<covers::CoverCacheStats> {
    covers::clear(store.inner())
}

#[tauri::command]
async fn nexus_refresh_covers(app: tauri::AppHandle) -> AppResult<NexusCoverRefresh> {
    tauri::async_runtime::spawn_blocking(move || {
        let store = app.state::<Store>();
        nexus::refresh_covers(store.inner())
    })
    .await
    .map_err(|e| CommandError::new("NEXUS_TASK", format!("Nexus 任务异常：{e}")))?
}

/// 批量补全收编模组的 Nexus 元数据（名称/作者/版本/分类/封面）。
/// 内部逐条请求 + 250ms 节流，必须 spawn_blocking。
#[tauri::command]
async fn nexus_enrich_metadata(
    app: tauri::AppHandle,
) -> AppResult<schema::NexusEnrichReport> {
    tauri::async_runtime::spawn_blocking(move || {
        let store = app.state::<Store>();
        nexus::enrich_metadata(store.inner())
    })
    .await
    .map_err(|e| CommandError::new("NEXUS_TASK", format!("Nexus 任务异常：{e}")))?
}

/// 用粘贴的 Nexus 链接补全单个模组（B 方案）。
#[tauri::command]
async fn attach_mod_from_nexus(
    app: tauri::AppHandle,
    id: String,
    url: String,
) -> AppResult<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let store = app.state::<Store>();
        nexus::attach_from_url(store.inner(), &id, &url)
    })
    .await
    .map_err(|e| CommandError::new("NEXUS_TASK", format!("Nexus 任务异常：{e}")))?
}

/// 从 Vortex 的 LevelDB 导入模组元数据（A 方案）。
#[tauri::command]
async fn vortex_import_metadata(app: tauri::AppHandle) -> AppResult<String> {
    tauri::async_runtime::spawn_blocking(move || {
        let store = app.state::<Store>();
        vortex::import(store.inner())
    })
    .await
    .map_err(|e| CommandError::new("VORTEX_TASK", format!("Vortex 导入任务异常：{e}")))?
}

/// 手动编辑模组信息（兜底）：保存后标记为 manual，自动补全不再覆盖。
#[tauri::command]
fn update_mod_metadata(
    store: State<'_, Store>,
    id: String,
    name: String,
    author: String,
    version: String,
    category: String,
) -> AppResult<()> {
    nexus::update_metadata(&store, &id, &name, &author, &version, &category)
}

/// 智能归类：把兜底的「其他 / 工具」按内容与名称重新推断。返回改动条数。
#[tauri::command]
fn reclassify_unclassified(store: State<'_, Store>) -> AppResult<usize> {
    installer::reclassify(store.inner(), false)
}

/// 重算全部分类（跳过用户手动改过的条目）。
#[tauri::command]
fn reclassify_all(store: State<'_, Store>) -> AppResult<usize> {
    installer::reclassify(store.inner(), true)
}

/// 手动指定分类。写入后该条目锁定，自动重算不再覆盖。
/// 绑定 / 解绑附属汉化包与原版 Mod。
///
/// 只改两个字段并落盘，不动任何已部署文件：父子关系纯粹是「展示与级联」的
/// 记账，真正的文件覆盖仍由各自的 planned_files 决定。这样即使用户改绑错了，
/// 也不会把游戏目录改坏。
#[tauri::command]
fn set_translation_parent(
    store: State<'_, Store>,
    id: String,
    parent_id: Option<String>,
) -> AppResult<Snapshot> {
    {
        let mut data = store.data.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let target_exists = data.mods.iter().any(|item| item.id == id);
        if !target_exists {
            return Err(CommandError::new("MOD_NOT_FOUND", "找不到这个模组。"));
        }
        if let Some(parent) = parent_id.as_deref() {
            if parent == id {
                return Err(CommandError::new(
                    "PARENT_INVALID",
                    "不能把模组绑定到自己身上。",
                ));
            }
            if !data.mods.iter().any(|item| item.id == parent) {
                return Err(CommandError::new("PARENT_NOT_FOUND", "找不到要绑定的原版模组。"));
            }
            // 防环：父级的父级链上不能再出现自己（A→B→A 会让级联禁用变成死循环）。
            let mut cursor = Some(parent.to_string());
            let mut hops = 0;
            while let Some(current) = cursor {
                if current == id {
                    return Err(CommandError::new(
                        "PARENT_CYCLE",
                        "这两个模组的父子关系会形成循环，已取消绑定。",
                    ));
                }
                hops += 1;
                if hops > 16 {
                    break;
                }
                cursor = data
                    .mods
                    .iter()
                    .find(|item| item.id == current)
                    .and_then(|item| item.parent_mod_id.clone());
            }
        }
        for entry in data.mods.iter_mut().filter(|item| item.id == id) {
            entry.parent_mod_id = parent_id.clone();
            if parent_id.is_some() {
                entry.is_translation = true;
            }
        }
        store.save(&data)?;
    }
    build_snapshot(store.inner())
}

/// 游戏主进程是否在运行（顶栏「开始游戏 / 关闭游戏」按钮靠它切换）。
#[tauri::command]
fn game_process_running() -> bool {
    game::process_running(game::GAME_EXE)
}

/// 结束游戏主进程。返回 true 表示走了强制结束。
#[tauri::command]
fn stop_game_process() -> AppResult<bool> {
    game::stop_game().map_err(|message| CommandError::new("STOP_GAME", message))
}

#[tauri::command]
fn set_mod_category(
    store: State<'_, Store>,
    id: String,
    category: String,
) -> AppResult<String> {
    installer::set_category(store.inner(), &id, &category)
}

/// P6：批量指定分类（选择模式下用）。返回实际改动条数。
#[tauri::command]
fn set_mods_category(
    store: State<'_, Store>,
    ids: Vec<String>,
    category: String,
) -> AppResult<usize> {
    installer::set_categories(store.inner(), &ids, &category)
}

/// #1 / P5 批量检查库内 Nexus 模组的更新。
#[tauri::command]
async fn nexus_check_updates(app: tauri::AppHandle) -> AppResult<NexusUpdateReport> {
    tauri::async_runtime::spawn_blocking(move || {
        let store = app.state::<Store>();
        nexus::check_updates(store.inner())
    })
    .await
    .map_err(|e| CommandError::new("NEXUS_TASK", format!("Nexus 更新检查任务异常：{e}")))?
}

/// P5-5B：更新单个模组（下载新版 → 备份旧版 → 替换 → 保持启用状态）。
#[tauri::command]
async fn nexus_apply_update(app: tauri::AppHandle, entry_id: String) -> AppResult<UpdateApplyItem> {
    tauri::async_runtime::spawn_blocking(move || {
        let store = app.state::<Store>();
        let data = store.snapshot_data();
        let game = current_game(&data).ok();
        updates::apply_update(&app, store.inner(), game.as_ref(), &entry_id)
    })
    .await
    .map_err(|e| CommandError::new("NEXUS_TASK", format!("更新任务异常：{e}")))?
}

/// 暂停 / 继续批量更新。暂停会真的把当前下载停住（字节数不再增长），
/// 恢复后从断点续传继续；只影响批量更新，不碰下载队列里用户自己排的任务。
#[tauri::command]
fn nexus_updates_pause(paused: bool) {
    updates::set_batch_paused(paused);
}

/// 取消批量更新：立即中断当前下载，剩下的不再开始；已下好的部分保留，下次可续传。
#[tauri::command]
fn nexus_updates_cancel() {
    updates::request_batch_cancel();
}

/// P5-5B：批量更新。「全部更新」按钮走这条，单个失败不连坐。
#[tauri::command]
async fn nexus_apply_updates(
    app: tauri::AppHandle,
    busy: State<'_, BusyTasks>,
    entry_ids: Vec<String>,
) -> AppResult<UpdateApplyReport> {
    let _guard = busy.begin("更新模组");
    tauri::async_runtime::spawn_blocking(move || {
        let store = app.state::<Store>();
        let data = store.snapshot_data();
        let game = current_game(&data).ok();
        updates::apply_updates(&app, store.inner(), game.as_ref(), &entry_ids)
    })
    .await
    .map_err(|e| CommandError::new("NEXUS_TASK", format!("批量更新任务异常：{e}")))?
}

/// P5-5B：回滚到更新前的版本（用最近一次留下的备份）。
#[tauri::command]
async fn nexus_rollback_update(app: tauri::AppHandle, entry_id: String) -> AppResult<UpdateApplyItem> {
    tauri::async_runtime::spawn_blocking(move || {
        let store = app.state::<Store>();
        let data = store.snapshot_data();
        let game = current_game(&data).ok();
        updates::rollback_update(store.inner(), game.as_ref(), &entry_id)
    })
    .await
    .map_err(|e| CommandError::new("NEXUS_TASK", format!("回滚任务异常：{e}")))?
}

/// P5-5B：有哪些可回滚的备份（前端在模组详情里显示「回滚到旧版本」）。
#[tauri::command]
fn nexus_list_update_backups(store: State<'_, Store>) -> Vec<updates::UpdateBackup> {
    updates::list_backups(&store)
}

#[tauri::command]
fn ai_status(store: State<'_, Store>) -> AiStatus {
    ai::status(&store)
}

/// 多套 AI 配置：列表（首次调用会把老状态迁移成一条「默认配置」）。
#[tauri::command]
fn ai_profiles(store: State<'_, Store>) -> AiProfileList {
    aiprofile::list(&store)
}

/// 保存一套配置（新增或修改）。`key` 为空表示不动已存的密钥。
#[tauri::command]
fn ai_profile_save(
    store: State<'_, Store>,
    profile: schema::AiProfile,
    key: Option<String>,
) -> AppResult<AiProfileList> {
    aiprofile::save(&store, profile, key)
}

#[tauri::command]
fn ai_profile_delete(store: State<'_, Store>, id: String) -> AppResult<AiProfileList> {
    aiprofile::delete(&store, &id)
}

/// 切换当前使用的配置（同步写回 settings.ai_* 三个老字段）。
#[tauri::command]
fn ai_profile_activate(store: State<'_, Store>, id: String) -> AppResult<AiProfileList> {
    aiprofile::activate(&store, &id)
}

/// 清掉某一套配置的密钥（配置本身保留）。
#[tauri::command]
fn ai_profile_clear_key(store: State<'_, Store>, id: String) -> AppResult<AiProfileList> {
    aiprofile::clear_key(&store, &id)
}

/// 测试连通性：不落盘、不改激活态，失败也返回结构化结果而不是抛错。
#[tauri::command]
fn ai_profile_test(
    store: State<'_, Store>,
    profile: schema::AiProfile,
    key: Option<String>,
) -> Result<schema::AiTestResult, CommandError> {
    Ok(aiprofile::test(&store, profile, key))
}

#[tauri::command]
fn ai_set_key(store: State<'_, Store>, key: String) -> AppResult<AiStatus> {
    ai::set_key(&store, &key)
}

#[tauri::command]
fn ai_clear_key(store: State<'_, Store>) -> AppResult<AiStatus> {
    ai::clear_key(&store)
}

#[tauri::command]
async fn ai_diagnose(
    app: tauri::AppHandle,
    include_logs: bool,
    consent: bool,
    focus: Option<String>,
) -> AppResult<AiDiagnosis> {
    tauri::async_runtime::spawn_blocking(move || {
        let store = app.state::<Store>();
        let snapshot = build_snapshot(store.inner())?;
        let report = diagnostics::build_report(
            store.inner(),
            &snapshot.state,
            snapshot.game.as_ref(),
        );
        ai::diagnose(
            store.inner(),
            &report,
            &snapshot.state,
            include_logs,
            consent,
            focus.as_deref(),
        )
    })
    .await
    .map_err(|e| CommandError::new("AI_TASK", format!("AI 诊断任务异常：{e}")))?
}

/// 联网拉取服务商的模型 ID 列表（OpenAI `GET /v1/models` 或 Anthropic `GET /v1/models`）。
///
/// 模型名会过时，硬编码的预置只是兜底；只要服务商在线，这个列表就是实时的。
/// Key 从本机 DPAPI 存储读取，不经过前端；没有 Key（本地 Ollama）则匿名请求。
#[tauri::command]
async fn ai_list_models(
    app: tauri::AppHandle,
    base_url: String,
    protocol: Option<String>,
) -> AppResult<Vec<String>> {
    tauri::async_runtime::spawn_blocking(move || {
        let store = app.state::<Store>();
        ai::list_models(store.inner(), &base_url, protocol.as_deref())
    })
    .await
    .map_err(|e| CommandError::new("AI_TASK", format!("模型列表任务异常：{e}")))?
}

/// 资源级深度扫描：用 WolvenKit CLI 解包冲突的 `.archive`，比对内部资源。
///
/// 全异步执行，CLI 路径未配置 / archive 缺失 / 超时 / CLI 报错都会以结构化
/// 错误返回（见 `wolvenkit::ScanError`），绝不阻塞主线程，也绝不 panic。
#[tauri::command]
async fn scan_archive_deep(
    store: State<'_, Store>,
    archive_paths: Vec<String>,
) -> AppResult<wolvenkit::DeepScanReport> {
    if archive_paths.is_empty() {
        return Ok(wolvenkit::DeepScanReport { results: Vec::new() });
    }
    let settings = store.snapshot_data().settings;
    let cli = wolvenkit::resolve_cli_path(&settings)?;
    let timeout = Duration::from_secs(wolvenkit::clamp_timeout_secs(settings.wolvenkit_timeout_secs));
    Ok(wolvenkit::scan_archives(&cli, &archive_paths, timeout).await)
}

/// 深度扫描的路径解析引用：模组 id + 冲突目标的相对路径。
///
/// `modId` 为 null 表示「游戏目录里的未受管文件」。
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeepScanRef {
    mod_id: Option<String>,
    target: String,
}

/// 把冲突引用解析成真实存在的 archive 文件路径，供 `scan_archive_deep` 使用。
///
/// 路径拼接全部走 `wolvenkit::resolve_archive_ref`（内部 safe_join），
/// 前端永远不做文件系统路径运算（React 只画状态）。
#[tauri::command]
fn resolve_deep_scan_paths(
    store: State<'_, Store>,
    refs: Vec<DeepScanRef>,
) -> AppResult<Vec<Option<String>>> {
    let data = store.snapshot_data();
    let staging_root = PathBuf::from(&data.staging_dir);
    let game_root = data.game_dir.as_deref().map(PathBuf::from);
    let mut out = Vec::with_capacity(refs.len());
    for item in refs {
        let staging_path = item
            .mod_id
            .as_deref()
            .and_then(|mod_id| data.mods.iter().find(|entry| entry.id == mod_id))
            .map(|entry| entry.staging_path.clone())
            .unwrap_or_default();
        let resolved = wolvenkit::resolve_archive_ref(
            &staging_root,
            game_root.as_deref(),
            &staging_path,
            &item.target,
        );
        out.push(resolved.map(|path| path.to_string_lossy().to_string()));
    }
    Ok(out)
}

/// 当前进程是否以管理员（高完整性）运行。
///
/// 用于决定打开外链的方式：提权进程直接 ShellExecute 会把浏览器也提权
/// （浏览器以管理员运行有安全风险，且会制造「提权浏览器实例」，
/// 导致其它普通权限程序的跳转被 UIPI 拦下弹框）。
fn is_process_elevated() -> bool {
    #[cfg(windows)]
    {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::Security::{
            GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY,
        };
        use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

        unsafe {
            let mut token = std::ptr::null_mut();
            if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
                return false;
            }
            let mut elevation = TOKEN_ELEVATION { TokenIsElevated: 0 };
            let mut returned = 0u32;
            let ok = GetTokenInformation(
                token,
                TokenElevation,
                &mut elevation as *mut _ as *mut core::ffi::c_void,
                std::mem::size_of::<TOKEN_ELEVATION>() as u32,
                &mut returned,
            );
            CloseHandle(token);
            ok != 0 && elevation.TokenIsElevated != 0
        }
    }
    #[cfg(not(windows))]
    {
        false
    }
}

/// 经 explorer.exe 转交外链：explorer 恒定运行在普通权限（medium IL），
/// 由它拉起浏览器可保证浏览器不被提权。
///
/// explorer 对 URL 的退出码不可信（成功也可能返回 1），因此只校验「进程是否成功
/// 拉起」；拉起失败再回退 ShellExecute，避免静默失败。
pub(crate) fn open_via_explorer(url: &str) -> AppResult<()> {
    #[cfg(windows)]
    {
        // 用绝对路径，避免 PATH 异常导致起错程序或找不到 DLL。
        let explorer = std::env::var("SystemRoot")
            .or_else(|_| std::env::var("windir"))
            .map(|root| PathBuf::from(root).join("explorer.exe"))
            .unwrap_or_else(|_| PathBuf::from("C:\\Windows\\explorer.exe"));
        // 注意：不加 CREATE_NO_WINDOW —— explorer 是 GUI 子系统程序，
        // 某些环境下该标志会让它初始化失败（0xc0000142）。
        let spawned = std::process::Command::new(&explorer).arg(url).spawn();
        match &spawned {
            Ok(child) => {
                // explorer 会把 URL 转交出去后自己退出，这里只记录 pid 便于排查。
                let _ = child.id();
                return Ok(());
            }
            Err(err) => {
                eprintln!(
                    "explorer 转交失败（{}）：{err}，回退 ShellExecute",
                    explorer.display()
                );
            }
        }
    }
    open::that_detached(url)
        .map_err(|e| CommandError::new("OPEN_FAILED", format!("无法打开链接：{e}")))
}

/// 用系统「已知文件夹」API 取当前进程令牌的 Roaming 目录。
///
/// 之所以不信 `%APPDATA%` 环境变量：实测同一 exe 在普通/管理员两种启动方式下，
/// 环境变量可能指向不属于当前令牌的配置目录，创建时直接 ACCESS_DENIED，
/// 于是代码走了「便携兜底」分支，同一台机器出现两套数据。
fn roaming_app_data_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        use windows_sys::Win32::System::Com::CoTaskMemFree;
        use windows_sys::Win32::UI::Shell::{SHGetKnownFolderPath, FOLDERID_RoamingAppData};

        unsafe {
            let mut raw: *mut u16 = std::ptr::null_mut();
            let hr = SHGetKnownFolderPath(
                &FOLDERID_RoamingAppData,
                0,
                std::ptr::null_mut(),
                &mut raw,
            );
            if hr < 0 || raw.is_null() {
                return None;
            }
            let mut len = 0usize;
            while *raw.add(len) != 0 {
                len += 1;
            }
            let path = String::from_utf16_lossy(std::slice::from_raw_parts(raw, len));
            CoTaskMemFree(raw as *const core::ffi::c_void);
            if path.is_empty() {
                None
            } else {
                Some(PathBuf::from(path))
            }
        }
    }
    #[cfg(not(windows))]
    {
        None
    }
}

/// 数据目录解析：**目标是两种启动方式（普通/管理员）落到同一目录**。
///
/// 判定顺序：
/// 1. exe 同级已存在 `cyberdeck-data` → 直接用它（便携目录一旦建立就固定下来，
///    它是实测在两种权限下都可写的位置）；
/// 2. 否则用 `%APPDATA%\com.arol.cyberdeck`，但必须先探明真的可写
///    （某些环境下普通权限进程写这里会被拒，只读探测会误判）；
/// 3. 都不可用 → exe 同级。
fn resolve_data_dir() -> PathBuf {
    if let Some(sibling) = exe_sibling_data_dir() {
        if sibling.is_dir() {
            return sibling;
        }
    }
    if let Some(roaming) = roaming_app_data_dir() {
        let candidate = roaming.join("com.arol.cyberdeck");
        if probe_writable(&candidate) == "ok" {
            return candidate;
        }
    }
    exe_sibling_data_dir().unwrap_or_else(|| PathBuf::from("cyberdeck-data"))
}

/// 把候选位置里缺失的状态/密钥补进目标目录，绝不覆盖已有文件。
/// 这样无论本次选了哪个目录，之前填过的 API Key 和模组清单都能跟过来。
fn migrate_other_data(target: &Path) {
    let mut sources: Vec<PathBuf> = Vec::new();
    if let Some(sibling) = exe_sibling_data_dir() {
        sources.push(sibling);
    }
    if let Some(roaming) = roaming_app_data_dir() {
        sources.push(roaming.join("com.arol.cyberdeck"));
    }
    for source in sources {
        if source == target || !source.is_dir() {
            continue;
        }
        let legacy_state = source.join("launcher-state.json");
        let target_state = target.join("launcher-state.json");
        if legacy_state.is_file() && !target_state.is_file() {
            if let Err(err) = std::fs::copy(&legacy_state, &target_state) {
                eprintln!("CyberDeck Launcher: 迁移旧状态失败：{err}");
            }
        }
        // 密钥是 DPAPI 密文、与用户绑定，复制后仍可解密，因此可以安全搬运。
        if let Ok(entries) = std::fs::read_dir(source.join("secrets")) {
            for entry in entries.flatten() {
                let from = entry.path();
                if !from.is_file() {
                    continue;
                }
                let to = target.join("secrets").join(entry.file_name());
                if to.exists() {
                    continue;
                }
                if let Some(parent) = to.parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                if let Err(err) = std::fs::copy(&from, &to) {
                    eprintln!("CyberDeck Launcher: 迁移密钥失败：{err}");
                }
            }
        }
    }
}

fn exe_sibling_data_dir() -> Option<PathBuf> {
    std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(Path::to_path_buf))
        .map(|dir| dir.join("cyberdeck-data"))
}

/// 一次性迁移历史回退目录（exe 同级 cyberdeck-data）里的数据。
/// 只在目标缺失时补齐，绝不覆盖新目录里已有的文件。
fn migrate_legacy_data(target: &Path) {
    migrate_other_data(target);
}

/// 令牌体检：完整性级别 / AppContainer / 受限 SID 数量。
///
/// 用于诊断「子进程起不来、写系统目录被拒」这类问题——完整性级别低于 medium
/// 时，Windows 会拒绝写 medium 级目录，子进程（浏览器、explorer）也会异常退出。
fn token_note() -> String {
    #[cfg(windows)]
    {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::Security::{
            GetSidSubAuthority, GetSidSubAuthorityCount, GetTokenInformation, TokenElevation,
            TokenIntegrityLevel, TokenIsAppContainer, TOKEN_ELEVATION, TOKEN_MANDATORY_LABEL,
            TOKEN_QUERY,
        };
        use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

        unsafe {
            let mut token = std::ptr::null_mut();
            if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
                return "token=open_failed".to_string();
            }
            let mut returned = 0u32;

            let mut elevation = TOKEN_ELEVATION { TokenIsElevated: 0 };
            GetTokenInformation(
                token,
                TokenElevation,
                &mut elevation as *mut _ as *mut core::ffi::c_void,
                std::mem::size_of::<TOKEN_ELEVATION>() as u32,
                &mut returned,
            );

            // 完整性级别：SID 的最后一个子授权即 RID（0x1000=Low, 0x2000=Medium, 0x3000=High）
            let mut buffer = [0u8; 128];
            let mut integrity: i64 = -1;
            if GetTokenInformation(
                token,
                TokenIntegrityLevel,
                buffer.as_mut_ptr() as *mut core::ffi::c_void,
                buffer.len() as u32,
                &mut returned,
            ) != 0
            {
                let label = &*(buffer.as_ptr() as *const TOKEN_MANDATORY_LABEL);
                let count = *GetSidSubAuthorityCount(label.Label.Sid);
                if count > 0 {
                    integrity = *GetSidSubAuthority(label.Label.Sid, u32::from(count) - 1) as i64;
                }
            }

            let mut appcontainer = 0u32;
            GetTokenInformation(
                token,
                TokenIsAppContainer,
                &mut appcontainer as *mut _ as *mut core::ffi::c_void,
                4,
                &mut returned,
            );

            CloseHandle(token);
            format!(
                "elev={} integrity=0x{:x} appcontainer={}",
                elevation.TokenIsElevated, integrity, appcontainer
            )
        }
    }
    #[cfg(not(windows))]
    {
        "token=unsupported".to_string()
    }
}

/// 探测目录是否真的可写：mkdir + 写一个临时文件再删掉。
fn probe_writable(dir: &Path) -> String {
    if let Err(err) = std::fs::create_dir_all(dir) {
        return format!("mkdir_err({err})");
    }
    let probe = dir.join(".write-probe");
    match std::fs::write(&probe, b"x") {
        Ok(()) => {
            let _ = std::fs::remove_file(&probe);
            "ok".to_string()
        }
        Err(err) => format!("write_err({err})"),
    }
}

/// 启动痕迹：记录本次的权限、目录解析依据与加载结果，便于排查
/// 「两种启动方式落到不同数据目录」这类问题。
fn log_startup(data_dir: &Path, note: &str) {
    use std::io::Write;
    let _ = std::fs::create_dir_all(data_dir);
    let line = format!(
        "{} elevated={} data_dir={} {}\n",
        store::now_iso(),
        is_process_elevated(),
        data_dir.display(),
        note
    );
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(data_dir.join("startup.log"))
    {
        let _ = file.write_all(line.as_bytes());
    }
}

/// 打开内置 Nexus 浏览窗口：独立 WebView，登录态与主窗口共享。
/// 窗口内 `nxm://` 交既有收件箱，外部站点交系统浏览器。
#[tauri::command]
fn open_nexus_browser(app: AppHandle, store: State<'_, Store>) -> AppResult<()> {
    nexus_browser::open(&app, &store.data_dir)
}

#[tauri::command]
fn open_url(store: State<'_, Store>, url: String) -> AppResult<()> {
    let trimmed = url.trim();
    if !(trimmed.starts_with("https://") || trimmed.starts_with("http://")) {
        return Err(CommandError::new(
            "INVALID_URL",
            "只允许打开 http/https 地址。",
        ));
    }
    if trimmed.chars().any(char::is_whitespace) {
        return Err(CommandError::new("INVALID_URL", "地址里不能有空白字符。"));
    }
    // 一律交给 explorer 转交：浏览器由 shell 在中等权限下拉起，
    // 既不会继承本进程可能受限的令牌，也不会被提成管理员。
    // 实测直接 ShellExecute 时浏览器会作为本进程子进程启动并卡死（无窗口、无报错）。
    let result = open_via_explorer(trimmed).or_else(|explorer_err| {
        log_startup(
            &store.data_dir,
            &format!(
                "stage=open_url explorer_failed url={trimmed} err={}",
                explorer_err.message
            ),
        );
        open::that_detached(trimmed)
            .map_err(|e| CommandError::new("OPEN_FAILED", format!("无法打开链接：{e}")))
    });
    log_startup(
        &store.data_dir,
        &format!(
            "stage=open_url url={trimmed} result={}",
            if result.is_ok() { "ok" } else { "err" }
        ),
    );
    result
}

#[tauri::command]
fn get_mod_settings(store: State<'_, Store>) -> AppResult<ModSettingsView> {
    modsettings::get(&store)
}

#[tauri::command]
fn save_mod_setting(
    store: State<'_, Store>,
    section: String,
    key: String,
    value: String,
) -> AppResult<ModSettingsView> {
    modsettings::save(&store, &section, &key, &value)
}

#[tauri::command]
fn restore_mod_settings(store: State<'_, Store>) -> AppResult<ModSettingsView> {
    modsettings::restore_backup(&store)
}

// ── 多框架 Mod 配置解析 ──────────────────────────────────────────────
// 详情抽屉只展示「这个 Mod 真正拥有的」配置项；框架级配置走全局设置页。
// 纯内容层 Mod（redscript / ArchiveXL / TweakXL / REDmod / Codeware）不生成表单。

/// 某个 Mod 的专属配置来源。空 sources 表示无需设置。
#[tauri::command]
fn get_mod_config(store: State<'_, Store>, mod_id: String) -> AppResult<ModConfigView> {
    config_resolver::mod_config(&store, &mod_id)
}

/// 改某个 Mod 配置来源里的一项。
///
/// 前端只传 source_id：真实文件路径由后端重新解析，写前备份，只 patch 目标 key，
/// 因此多个 Mod 共用同一份 user.ini 时不会互相冲掉设置。
#[tauri::command]
fn save_config_field(
    store: State<'_, Store>,
    mod_id: String,
    source_id: String,
    section: String,
    key: String,
    value: String,
) -> AppResult<ModConfigView> {
    config_resolver::save_field(&store, &mod_id, &source_id, &section, &key, &value)
}

/// 框架级全局配置（RED4ext TOML / CET JSON / AudioXL INI）。
#[tauri::command]
fn get_global_configs(store: State<'_, Store>) -> AppResult<GlobalConfigGroups> {
    config_resolver::global_configs(&store)
}

#[tauri::command]
fn list_logs(store: State<'_, Store>) -> AppResult<Vec<LogFileInfo>> {
    logs::list(&store)
}

#[tauri::command]
fn read_log_tail(
    store: State<'_, Store>,
    path: String,
    limit: Option<usize>,
) -> AppResult<LogTail> {
    logs::tail(&store, &path, limit)
}

#[tauri::command]
fn get_diagnostics(store: State<'_, Store>) -> AppResult<DiagnosticsReport> {
    let data = store.snapshot_data();
    let game = build_snapshot(&store)?.game;
    Ok(diagnostics::build_report(&store, &data, game.as_ref()))
}

#[tauri::command]
fn create_backup(store: State<'_, Store>) -> AppResult<BackupInfo> {
    let mut data = store.data.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let game = current_game(&data)?;
    let info = backup::create_backup(&store, Path::new(&game.root), &mut data)?;
    store.save(&data)?;
    Ok(info)
}

#[tauri::command]
fn restore_original(store: State<'_, Store>) -> AppResult<RestoreResult> {
    let snapshot = store.snapshot_data();
    let Some(game_root) = snapshot.game_dir.clone() else {
        return Err(CommandError::new(
            "GAME_NOT_CONFIGURED",
            "还没有配置游戏目录，无法恢复。",
        ));
    };
    let mut undeployed = 0usize;
    let mut warnings = Vec::new();
    for entry in snapshot
        .mods
        .iter()
        .filter(|entry| !entry.deployed_files.is_empty())
    {
        match installer::undeploy_mod(&store, &entry.id, Path::new(&game_root)) {
            Ok(items) => {
                undeployed += 1;
                warnings.extend(items);
            }
            Err(err) => warnings.push(format!("{}：{}", entry.name, err.message)),
        }
    }

    let mut data = store.data.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let restored_files = match backup::restore_backup(&store, Path::new(&game_root), &mut data) {
        Ok(result) => {
            warnings.extend(result.warnings);
            result.restored_files
        }
        Err(err) if err.code == "NO_BACKUP" => {
            warnings.push(err.message);
            0
        }
        Err(err) => return Err(err),
    };
    for entry in &mut data.mods {
        entry.enabled = false;
        entry.deployed_files.clear();
    }
    data.load_order.clear();
    store.save(&data)?;
    Ok(RestoreResult {
        undeployed,
        restored_files,
        warnings,
    })
}

/// 启动能力探测（只读）：平台、DRM 客户端是否在运行、能否绕过官方启动器。
#[tauri::command]
fn inspect_launch(store: State<'_, Store>) -> AppResult<game::LaunchCheck> {
    let data = store.snapshot_data();
    let game = current_game(&data)?;
    Ok(game::inspect_launch(&game))
}

#[tauri::command]
fn launch_game(store: State<'_, Store>) -> AppResult<LaunchResult> {
    // 先短锁取快照：进程探测与 spawn 都在锁外做（安全不变量：Mutex 内不做 IO）。
    let data = store.snapshot_data();
    let game = current_game(&data)?;

    // 版本校验必须早于直启：游戏本体更新后旧前置大概率已失效，
    // 此时直启只会把玩家丢进一个装满坏链接的游戏目录。
    // 判定口径与部署熔断完全一致（`update_lock_active`），解除入口也共用顶栏横幅。
    let current_version = game.version.as_deref();
    if game::update_lock_active(data.last_game_version.as_deref(), current_version) {
        return Err(CommandError::new(
            "GAME_UPDATE_LOCKED",
            format!(
                "游戏已更新（{} → {}），请先升级 RED4ext / CET 等前置再启动。确认无误可在顶部横幅点「我已更新前置，解除锁定」。",
                data.last_game_version.as_deref().unwrap_or("未知"),
                current_version.unwrap_or("未知"),
            ),
        ));
    }

    let redmod_enabled = data
        .mods
        .iter()
        .any(|entry| entry.enabled && entry.layout == schema::InstallLayout::Redmod);
    // #6 用户自定义启动参数：解析在 game::parse_launch_args（白名单校验），
    // 校验失败直接报错不启动，绝不把未校验的字符串交给进程。
    let custom_args = game::parse_launch_args(&data.settings.launch_args)?;

    // REDmod 缓存必须和当前播放集一致（2026-11-06 审计 P1-1）。
    // 旧实现只在命令收尾时顺手同步，于是「改完顺序直接点启动」会带着上一套
    // `r6/cache/modded` 进游戏：游戏不报错，玩家只觉得启用的东西不生效。
    // 这里同步失败就拦下启动——带着错缓存进游戏比启动失败更难排查。
    // 锁已在上面释放，redMod 是外部进程，不占 state 锁。
    let mut redmod_rebuilt = false;
    if redmod_enabled {
        redmod_rebuilt = redmod::sync_before_launch(&store, Path::new(&game.root)).map_err(|err| {
            CommandError::new(
                "REDMOD_SYNC_FAILED",
                format!("REDmod 缓存同步失败，已阻止启动：{}", err.message),
            )
        })?;
    }

    let mut result = game::launch_game(
        &game,
        &data.settings.launch_method,
        redmod_enabled,
        &custom_args,
        &data.settings.launch_priority,
        &data.settings.launch_gpu_pref,
        &data.settings.launch_pre_command,
    )?;
    if redmod_rebuilt {
        result
            .notes
            .push("REDmod 加载顺序有变化，已在启动前重建缓存。".to_string());
    }

    let mut data = store.data.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    data.last_launch = Some(store::now_iso());
    data.last_game_version = game.version.clone();
    store.save(&data)?;
    Ok(result)
}

#[tauri::command]
fn open_path(path: String) -> AppResult<()> {
    let target = Path::new(&path);
    if !target.exists() {
        return Err(CommandError::new(
            "PATH_NOT_FOUND",
            format!("路径不存在：{path}"),
        ));
    }
    open::that_detached(target)
        .map_err(|e| CommandError::new("OPEN_FAILED", format!("无法打开路径：{e}")))
}

// ── 存档管理（任务 865759）──────────────────────────────────────────
// 快照只写 data_dir/env-snapshots/*.json；存档扫描只读 metadata/目录属性，
// 绝不读写 .dat 二进制。应用快照的自动备份在后端强制，绕不过去。

#[tauri::command]
fn create_env_snapshot(
    store: State<'_, Store>,
    label: Option<String>,
) -> AppResult<snapshots::EnvSnapshot> {
    let data = store.snapshot_data();
    let game = game::detect_game(data.game_dir.as_deref(), data.last_game_version.as_deref());
    let snapshot = snapshots::build_snapshot(
        &data,
        game.as_ref(),
        snapshots::SnapshotTrigger::Manual,
        label,
    );
    snapshots::write_snapshot(&store.data_dir, &snapshot, data.settings.snapshot_limit)
}

#[tauri::command]
fn list_env_snapshots(store: State<'_, Store>) -> AppResult<Vec<snapshots::EnvSnapshot>> {
    Ok(snapshots::list_snapshots(&store.data_dir))
}

#[tauri::command]
fn delete_env_snapshot(store: State<'_, Store>, id: String) -> AppResult<()> {
    snapshots::delete_snapshot(&store.data_dir, &id)
}

/// 回滚到指定环境：先强制备份当前环境（PreApplySnapshot），再逐 Mod 对齐启用集合。
///
/// 逐个 deploy/undeploy 自己管锁、冲突与回滚；这里不持有 store 锁调用它们。
/// 部分失败不中断整批，失败的 Mod 汇总进返回值之外只能进 warnings——因此
/// 这里把「失败清单」折进 label 不可行，改为任一失败即报错但已完成部分不回滚
/// （当前环境备份仍在，用户可再回滚回来）。
#[tauri::command]
fn apply_env_snapshot(store: State<'_, Store>, id: String) -> AppResult<snapshots::EnvSnapshot> {
    let target = snapshots::load_snapshot(&store.data_dir, &id)?;
    let data = store.snapshot_data();
    let game = current_game(&data)?;
    let game_root = PathBuf::from(&game.root);

    // ① 护城河：先把当前环境存成 PreApplySnapshot，失败则整个操作中止。
    let backup = snapshots::build_snapshot(
        &data,
        Some(&game),
        snapshots::SnapshotTrigger::PreApplySnapshot,
        Some(format!("回滚到 {} 之前的自动备份", target.created_at)),
    );
    snapshots::write_snapshot(&store.data_dir, &backup, data.settings.snapshot_limit)?;

    // ② 对齐启用集合：该关的先关，该开的后开（减少中间态冲突）。
    let wanted: std::collections::HashSet<&str> = target
        .mods
        .iter()
        .filter(|m| m.enabled)
        .map(|m| m.id.as_str())
        .collect();
    let mut errors: Vec<String> = Vec::new();

    // 先禁用「快照里没有 / 快照里是禁用」的当前启用 Mod。
    for entry in data.mods.iter().filter(|m| m.enabled) {
        if wanted.contains(entry.id.as_str()) {
            continue;
        }
        if let Err(err) = installer::undeploy_mod(&store, &entry.id, &game_root) {
            errors.push(format!("停用 {} 失败：{err}", entry.name));
        }
    }
    // 再启用快照里启用、当前未启用的 Mod（只处理库里还在的；已卸载的列进提示）。
    let mut missing: Vec<String> = Vec::new();
    for snap_mod in target.mods.iter().filter(|m| m.enabled) {
        let Some(entry) = data.mods.iter().find(|m| m.id == snap_mod.id) else {
            missing.push(snap_mod.name.clone());
            continue;
        };
        if entry.enabled {
            continue;
        }
        if let Err(err) = installer::deploy_mod(&store, &entry.id, &game) {
            errors.push(format!("启用 {} 失败：{err}", snap_mod.name));
        }
    }

    // ③ 恢复 archive 相对路径顺序。normalized_order 会丢弃已卸载/未成功部署的
    // 路径，并把新出现的路径按既有规则补到末尾；空清单也照写，支持恢复成默认排序。
    let ordered = {
        let mut state = store.data.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        state.load_order = snapshots::restored_load_order(&state, &target.load_order);
        state.clone()
    };
    if ordered.settings.write_modlist {
        if let Err(err) = loadorder::write_modlist(&ordered, &game_root) {
            errors.push(format!("恢复加载顺序失败：{err}"));
        }
    }
    store.save(&ordered)?;

    if !missing.is_empty() {
        return Err(CommandError::new(
            "SNAPSHOT_PARTIAL",
            format!(
                "环境已按快照对齐，但以下 Mod 已不在库中，未能恢复：{}。{}",
                missing.join("、"),
                if errors.is_empty() {
                    String::new()
                } else {
                    format!("另有失败：{}", errors.join("；"))
                }
            ),
        ));
    }
    if !errors.is_empty() {
        return Err(CommandError::new(
            "SNAPSHOT_PARTIAL",
            format!("部分 Mod 未能对齐：{}（当前环境已自动备份，可再次回滚）", errors.join("；")),
        ));
    }
    Ok(target)
}

#[tauri::command]
fn scan_save_games(store: State<'_, Store>) -> AppResult<saves::SaveScanReport> {
    let data = store.snapshot_data();
    let game = game::detect_game(data.game_dir.as_deref(), data.last_game_version.as_deref());
    saves::scan_saves(&data, game.as_ref(), &store.data_dir)
}

#[tauri::command]
fn open_save_editor(store: State<'_, Store>) -> AppResult<()> {
    let data = store.snapshot_data();
    let path = data.settings.save_editor_path.trim().to_string();
    if path.is_empty() {
        return Err(CommandError::new(
            "EDITOR_NOT_CONFIGURED",
            "尚未配置外部存档编辑器路径。请到「设置 → 工具组件 → 存档与工具」选择 .exe。",
        ));
    }
    if !Path::new(&path).is_file() {
        return Err(CommandError::new(
            "EDITOR_MISSING",
            format!("编辑器路径不存在：{path}"),
        ));
    }
    open::that_detached(&path)
        .map_err(|err| CommandError::new("EDITOR_LAUNCH", format!("编辑器启动失败：{err}")))
}

#[tauri::command]
fn open_logs_folder(store: State<'_, Store>) -> AppResult<()> {
    let data = store.snapshot_data();
    let game = current_game(&data)?;
    let root = Path::new(&game.root);
    let candidates = [
        root.join("r6").join("logs"),
        root.join("red4ext").join("logs"),
        root.join("bin")
            .join("x64")
            .join("plugins")
            .join("cyber_engine_tweaks"),
    ];
    let target = candidates
        .into_iter()
        .find(|path| path.exists())
        .unwrap_or_else(|| root.to_path_buf());
    open::that_detached(target)
        .map_err(|e| CommandError::new("OPEN_FAILED", format!("无法打开日志目录：{e}")))
}

#[tauri::command]
fn reveal_mod(store: State<'_, Store>, id: String) -> AppResult<()> {
    let data = store.snapshot_data();
    let entry = data
        .mods
        .iter()
        .find(|item| item.id == id)
        .ok_or_else(|| CommandError::new("MOD_NOT_FOUND", "找不到这个模组。"))?;
    let path = Path::new(&entry.staging_path);
    if !path.exists() {
        return Err(CommandError::new(
            "STAGING_MISSING",
            "暂存目录不存在，请重新导入。",
        ));
    }
    open::that_detached(path)
        .map_err(|e| CommandError::new("OPEN_FAILED", format!("无法打开暂存目录：{e}")))
}

#[tauri::command]
fn app_data_dir(store: State<'_, Store>) -> String {
    store.data_dir.to_string_lossy().to_string()
}

#[tauri::command]
fn ping() -> &'static str {
    "pong"
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
// ── 生命周期：单实例 / 托盘 / 关闭到托盘 / 退出确认 ───────────────────────

/// 托盘与菜单项的固定 id：菜单回调与事件处理共用，避免字符串写错。
const TRAY_ID: &str = "main-tray";
const MENU_SHOW: &str = "tray-show";
const MENU_QUIT: &str = "tray-quit";

/// 进行中的长任务登记表。
///
/// 只在 `BusyGuard` 存活期间计数，靠 `Drop` 自动注销——命令 panic 或提前 return
/// 都不会漏减，这是"退出前安全检查"可信的前提。
#[derive(Clone, Default)]
struct BusyTasks {
    inner: Arc<Mutex<Vec<(u64, String)>>>,
    seq: Arc<AtomicU64>,
}

impl BusyTasks {
    fn begin(&self, label: impl Into<String>) -> BusyGuard {
        let id = self.seq.fetch_add(1, Ordering::Relaxed);
        if let Ok(mut list) = self.inner.lock() {
            list.push((id, label.into()));
        }
        BusyGuard {
            owner: self.clone(),
            id,
        }
    }

    /// 当前进行中的任务名（退出确认框直接复用这份数据）。
    fn labels(&self) -> Vec<String> {
        self.inner
            .lock()
            .map(|list| list.iter().map(|(_, label)| label.clone()).collect())
            .unwrap_or_default()
    }
}

struct BusyGuard {
    owner: BusyTasks,
    id: u64,
}

impl Drop for BusyGuard {
    fn drop(&mut self) {
        if let Ok(mut list) = self.owner.inner.lock() {
            list.retain(|(id, _)| *id != self.id);
        }
    }
}

/// 生命周期事件落日志：出问题时能直接看出"点了关闭之后走了哪条分支"。
fn log_lifecycle(app: &AppHandle, message: &str) {
    let dir = app.state::<Store>().data_dir.clone();
    log_startup(&dir, message);
}

/// 显示并置顶主窗口：恢复最小化 → 显示 → 聚焦。
/// 已收到但前端还没处理的 `nxm://` 链接。
///
/// 为什么需要「收件箱」而不是只发事件：协议直接拉起本进程时，链接参数在
/// setup 阶段就有了，而 webview 的监听器要等页面挂载完才存在——只发事件必然丢。
/// 所以先进收件箱，前端启动后主动 `nxm_pending` 拉一次，之后靠 `nxm-link` 增量。
struct NxmInbox(Mutex<Vec<schema::NxmLink>>);

impl Default for NxmInbox {
    fn default() -> Self {
        Self(Mutex::new(Vec::new()))
    }
}

impl NxmInbox {
    fn push(&self, link: schema::NxmLink) {
        if let Ok(mut list) = self.0.lock() {
            // 同一条链接可能被重复投递（协议拉起 + 单实例转交），去重避免下两遍。
            if !list.iter().any(|item| item.uri == link.uri) {
                list.push(link);
            }
        }
    }

    fn snapshot(&self) -> Vec<schema::NxmLink> {
        self.0.lock().map(|list| list.clone()).unwrap_or_default()
    }

    fn remove(&self, uri: &str) {
        if let Ok(mut list) = self.0.lock() {
            list.retain(|item| item.uri != uri);
        }
    }

    fn clear(&self) {
        if let Ok(mut list) = self.0.lock() {
            list.clear();
        }
    }
}

/// 把命令行里的 nxm 链接塞进收件箱并推给前端。两个入口共用：
/// 首次协议拉起（setup 里的 argv）与已运行时的单实例转交（第二进程的 argv）。
pub(crate) fn intake_nxm(app: &AppHandle, args: &[String]) {
    let links = nxm::links_from_args(args);
    if links.is_empty() {
        return;
    }
    // 留一条可核对的痕迹：真机验收「协议拉起是否生效」就靠这行，
    // 只记 mod/file id，不写链接里的 key（那是签名参数，没必要落盘）。
    if let Some(diag) = exe_sibling_data_dir() {
        let detail = links
            .iter()
            .map(|link| format!("mod={} file={:?}", link.mod_id, link.file_id))
            .collect::<Vec<_>>()
            .join(" ");
        log_startup(&diag, &format!("stage=nxm links={} {detail}", links.len()));
    }
    if let Some(inbox) = app.try_state::<NxmInbox>() {
        for link in &links {
            inbox.push(link.clone());
        }
    }
    for link in links {
        // 前端没挂上时 emit 会静默失败，收件箱兜住，不算错误。
        let _ = app.emit("nxm-link", link);
    }
}

#[tauri::command]
fn nxm_status(store: State<'_, Store>) -> schema::NxmStatus {
    nxm::status(&store.data_dir)
}

#[tauri::command]
fn nxm_takeover(store: State<'_, Store>) -> AppResult<schema::NxmStatus> {
    nxm::takeover(&store.data_dir)
}

#[tauri::command]
fn nxm_release(store: State<'_, Store>) -> AppResult<schema::NxmStatus> {
    nxm::release(&store.data_dir)
}

#[tauri::command]
fn nxm_pending(inbox: State<'_, NxmInbox>) -> Vec<schema::NxmLink> {
    inbox.snapshot()
}

/// 手动投递一条 nxm 链接（deepseek 任务·模块二）：下载中心拖入 .nxm 文件后，
/// 前端读出文件文本（一条 nxm:// URI）经此命令进收件箱，走与协议拉起完全相同的
/// 后续链路（收件箱去重 + nxm-link 事件）。解析失败返回错误，由前端回显。
#[tauri::command]
fn nxm_intake(app: AppHandle, inbox: State<'_, NxmInbox>, uri: String) -> AppResult<schema::NxmLink> {
    let link = nxm::parse_link(uri.trim())?;
    inbox.push(link.clone());
    // 与 intake_nxm 同口径：前端没挂上监听也没关系，收件箱兜底。
    let _ = app.emit("nxm-link", link.clone());
    Ok(link)
}

/// 从 .nxm 文件批量投递（deepseek 任务·模块二）：拖拽落下的 .nxm 本质是文本文件，
/// 每行一条 nxm:// 链接。逐行解析进收件箱；一条都没有才算失败。
#[tauri::command]
fn nxm_intake_file(
    app: AppHandle,
    inbox: State<'_, NxmInbox>,
    path: String,
) -> AppResult<Vec<schema::NxmLink>> {
    let raw = std::fs::read_to_string(&path)
        .map_err(|e| CommandError::new("NXM_FILE_READ", format!("无法读取文件：{e}")))?;
    let mut out = Vec::new();
    for line in raw.lines().map(str::trim).filter(|l| l.starts_with("nxm://")) {
        let link = nxm::parse_link(line)?;
        inbox.push(link.clone());
        let _ = app.emit("nxm-link", link.clone());
        out.push(link);
    }
    if out.is_empty() {
        return Err(CommandError::new("NXM_FILE_EMPTY", "文件里没有找到 nxm:// 链接"));
    }
    Ok(out)
}

/// `uri` 为空表示「全部忽略」。
#[tauri::command]
fn nxm_dismiss(inbox: State<'_, NxmInbox>, uri: Option<String>) {
    match uri {
        Some(value) => inbox.remove(&value),
        None => inbox.clear(),
    }
}

fn show_main_window(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        // 首个实例可能还在 setup 里（窗口尚未创建）：稍等重试，避免"点了没反应"。
        let handle = app.clone();
        std::thread::spawn(move || {
            for _ in 0..20 {
                std::thread::sleep(Duration::from_millis(150));
                if let Some(win) = handle.get_webview_window("main") {
                    let _ = win.show();
                    let _ = win.unminimize();
                    let _ = win.set_focus();
                    return;
                }
            }
        });
        return;
    };
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
}

fn hide_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
}

/// 左键单击托盘：可见且未最小化 → 隐藏；否则恢复 + 聚焦。
fn toggle_main_window(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let visible = window.is_visible().unwrap_or(false);
    let minimized = window.is_minimized().unwrap_or(false);
    if visible && !minimized {
        let _ = window.hide();
    } else {
        show_main_window(app);
    }
}

/// 读持久化的关闭偏好（快照在锁外取，遵守"Mutex 内不做 IO"的既有约束）。
fn close_behavior(app: &AppHandle) -> String {
    app.state::<Store>().snapshot_data().settings.close_behavior
}

/// 点 × 时是否先确认（与 close_behavior 分开：一个决定去哪，一个决定问不问）。
fn close_ask(app: &AppHandle) -> bool {
    app.state::<Store>().snapshot_data().settings.close_ask
}

/// 关闭弹窗选完之后调这个：`action` = hide | exit，`remember` = 以后不再问。
///
/// 前端的弹窗只负责"问"，真正的窗口动作放在 Rust：这样即使用户在网页层面
/// 关掉了弹窗，也不会出现"窗口既不退也不藏"的僵局。
#[tauri::command]
fn close_window_action(
    app: tauri::AppHandle,
    action: String,
    remember: bool,
) -> AppResult<()> {
    let store = app.state::<Store>();
    if remember {
        let mut state = store
            .data
            .lock()
            .map_err(|_| CommandError::new("STATE_LOCK", "状态被占用，稍后再试。"))?;
        if action == "exit" {
            state.settings.close_behavior = "exit".to_string();
        } else {
            // 记住"最小化"：以后点 × 直接收进托盘，不再弹窗。
            state.settings.close_ask = false;
        }
        store.save(&state)?;
    }
    if action == "exit" {
        log_lifecycle(&app, "stage=close action=exit chosen");
        request_exit(&app);
    } else {
        log_lifecycle(&app, "stage=close action=hide-to-tray chosen");
        hide_main_window(&app);
    }
    Ok(())
}

/// 真正退出的唯一入口：有进行中任务先确认，没有才退。
fn request_exit(app: &AppHandle) {
    let busy = app.state::<BusyTasks>().labels();
    if busy.is_empty() {
        log_lifecycle(app, "stage=exit action=immediate");
        app.exit(0);
        return;
    }
    log_lifecycle(app, &format!("stage=exit action=confirm busy={}", busy.join("、")));

    let mut shown: Vec<String> = busy.iter().take(3).cloned().collect();
    if busy.len() > 3 {
        shown.push(format!("等 {} 项", busy.len()));
    }
    let detail = shown.join("、");

    // 用原生对话框：主窗口此时可能已隐藏，网页里的模态弹不出来。
    // show() 是异步回调，不能在主线程 blocking_show（Windows 上会死锁）。
    let handle = app.clone();
    app.dialog()
        .message(format!(
            "当前有任务正在进行（{detail}），强制退出可能导致 Mod 文件损坏，确认退出吗？"
        ))
        .title("确认退出")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "强制退出".to_string(),
            "取消".to_string(),
        ))
        .show(move |confirmed| {
            if confirmed {
                handle.exit(0);
            }
        });
}

/// 建立系统托盘。图标直接复用窗口默认图标，不依赖任何外部资源路径。
fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let show_item = MenuItem::with_id(app, MENU_SHOW, "显示主界面", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, MENU_QUIT, "彻底退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show_item, &quit_item])?;

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("CyberDeck Launcher")
        .menu(&menu)
        // 左键留给"显示/隐藏切换"，右键才出菜单（2.x 方法名；2.0 beta 叫 menu_on_left_click）
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            MENU_SHOW => show_main_window(app),
            MENU_QUIT => request_exit(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle_main_window(tray.app_handle());
            }
        });

    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }
    builder.build(app)?;
    Ok(())
}

/// 前端用于展示"正在进行的任务"，与退出确认框同源。
#[tauri::command]
fn list_busy_tasks(busy: State<'_, BusyTasks>) -> Vec<String> {
    busy.labels()
}

/// `main.rs` 的 `--self-check` / `--nxm-takeover` / `--nxm-release` 入口：
/// 命中就返回退出码，否则 None（正常带窗口启动）。
pub fn self_check(args: &[String]) -> Option<i32> {
    selfcheck::run(args).or_else(|| selfcheck::run_nxm(args))
}

/// 启动失败时留一份可读证据并给用户一个可见提示。
///
/// `panic = "abort"` 下 `.expect()` 会让窗口一闪而过、连日志都没有；
/// 这类失败（WebView2 缺失、资源打包错、端口被占）用户完全无法自救。
#[cfg(windows)]
fn report_fatal_startup(error: &dyn std::fmt::Display) {
    let message = format!("CyberDeck Launcher 启动失败：{error}");
    let log = std::env::temp_dir().join("cyberdeck-launcher-startup-error.log");
    let _ = std::fs::write(&log, format!("{message}\n"));
    eprintln!("{message}（日志：{}）", log.display());

    use windows_sys::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK};
    let text: Vec<u16> = message.encode_utf16().chain(std::iter::once(0)).collect();
    let caption: Vec<u16> = "CyberDeck Launcher"
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    // SAFETY: 两个指针都指向以 0 结尾的 UTF-16 缓冲区，hwnd 传空表示无父窗口。
    unsafe {
        MessageBoxW(std::ptr::null_mut(), text.as_ptr(), caption.as_ptr(), MB_OK | MB_ICONERROR);
    }
}

#[cfg(not(windows))]
fn report_fatal_startup(error: &dyn std::fmt::Display) {
    eprintln!("CyberDeck Launcher 启动失败：{error}");
}

pub fn run() {
    tauri::Builder::default()
        // 单实例必须第一个注册：它要在任何窗口/插件初始化之前抢占命名互斥量，
        // 否则两个进程可能都已初始化完再互相同步，正是文件读写冲突的来源。
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            // 第二进程可能是被 nxm:// 拉起来的：先把链接收进队列，再叫窗口。
            // 顺序不能反——先唤窗再收链接，用户会看到窗口闪一下才出现下载条。
            intake_nxm(app, &argv);
            show_main_window(app);
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        // P5-5C：启动器自更新。公钥与更新端点在 tauri.conf.json 的 plugins.updater。
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            // nxm 收件箱必须先就位：后面读启动参数时要往里塞链接。
            app.manage(NxmInbox::default());
            intake_nxm(app.handle(), &std::env::args().skip(1).collect::<Vec<_>>());

            // 固定数据目录：不依赖 Tauri 的路径解析，避免提权/非提权落到不同目录。
            let appdata_env = std::env::var_os("APPDATA");
            let preferred = resolve_data_dir();
            let preferred_probe = probe_writable(&preferred);
            // 诊断一律先落到 exe 同级（实测该位置可写），首选目录写不进去时也有据可查。
            let diag_dir = exe_sibling_data_dir().unwrap_or_else(|| preferred.clone());
            log_startup(
                &diag_dir,
                &format!(
                    "stage=resolve apdata_env={} preferred={} probe={} user={} {}",
                    appdata_env
                        .as_deref()
                        .map(|v| v.to_string_lossy().to_string())
                        .unwrap_or_else(|| "<none>".into()),
                    preferred.display(),
                    preferred_probe,
                    std::env::var("USERPROFILE").unwrap_or_else(|_| "<none>".into()),
                    token_note()
                ),
            );
            migrate_legacy_data(&preferred);
            let store = match Store::load(preferred.clone()) {
                Ok(store) => {
                    log_startup(&diag_dir, &format!("stage=load ok dir={}", preferred.display()));
                    store
                }
                Err(err) => {
                    log_startup(
                        &diag_dir,
                        &format!(
                            "stage=load err code={} msg={}",
                            err.code, err.message
                        ),
                    );
                    // 兜底：固定目录不可写时退到 exe 同级，仍然只记一条启动痕迹。
                    let fallback = exe_sibling_data_dir()
                        .ok_or_else(|| std::io::Error::other("cannot resolve exe directory"))?;
                    eprintln!(
                        "CyberDeck Launcher: 数据目录不可用 [{}: {}]，改用 {}",
                        err.code,
                        err.message,
                        fallback.display()
                    );
                    let store = Store::load(fallback.clone()).map_err(
                        |fallback_err| -> Box<dyn std::error::Error> {
                            eprintln!(
                                "CyberDeck Launcher: 兜底数据目录也失败 [{}]: {}",
                                fallback_err.code, fallback_err.message
                            );
                            Box::new(std::io::Error::other(fallback_err.message))
                        },
                    )?;
                    store
                }
            };
            eprintln!("CyberDeck Launcher: data dir = {}", store.data_dir.display());
            app.manage(store);

            // 封面缓存路径是**派生数据**：每次启动按「远程地址 + 磁盘上是否真有文件」重算。
            // 用户手动清过 covers 目录、或从别处拷来的状态库，都能立刻对齐实际情况，
            // 不必信状态文件里存的旧路径。
            {
                let store = app.state::<Store>();
                let mut data = store
                    .data
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                covers::refresh_paths(&mut data, &store.data_dir);
            }

            // asset 协议默认只放行 `$APPDATA/**` 与 `$APPLOCALDATA/**`（见 tauri.conf.json），
            // 而便携版把数据目录放在 exe 同级（可能在任意盘符），暂存区还能被用户改到别的盘。
            // 不把这两处加进 scope，`convertFileSrc` 生成的地址会被一律拒绝：包内封面、
            // 本地缓存封面全都加载不出来，界面表现就是「封面一片黑」。
            {
                let store = app.state::<Store>();
                let scope = app.asset_protocol_scope();
                if let Err(err) = scope.allow_directory(&store.data_dir, true) {
                    eprintln!("CyberDeck Launcher: asset scope (data dir) = {err}");
                }
                let staging = store.staging_dir();
                if let Err(err) = scope.allow_directory(&staging, true) {
                    eprintln!("CyberDeck Launcher: asset scope (staging) = {err}");
                }
            }

            let store = app.state::<Store>();
            let webview_profile = store.data_dir.join("EBWebView");
            drop(store);
            std::fs::create_dir_all(&webview_profile)?;
            eprintln!(
                "CyberDeck Launcher: webview profile = {}",
                webview_profile.display()
            );

            // 下载队列：独立持久化文件，恢复上次未跑完的任务（Downloading 拉回 Queued）。
            {
                let store = app.state::<Store>();
                download_queue::init(&store.data_dir);
            }

            let (window_width, window_height) = match app.primary_monitor() {
                Ok(Some(monitor)) => {
                    let scale = monitor.scale_factor();
                    let logical_width = monitor.size().width as f64 / scale;
                    let logical_height = monitor.size().height as f64 / scale;
                    (
                        1440.0_f64.min((logical_width - 64.0).max(1000.0)),
                        900.0_f64.min((logical_height - 80.0).max(680.0)),
                    )
                }
                _ => (1280.0, 800.0),
            };

            let window = WebviewWindowBuilder::new(
                app,
                "main",
                WebviewUrl::App("index.html".into()),
            )
            .title("CyberDeck")
            .inner_size(window_width, window_height)
            .min_inner_size(1000.0, 660.0)
            .center()
            .resizable(true)
            .decorations(false)
            .shadow(true)
            .theme(Some(Theme::Dark))
            // WebView2 在渲染出第一帧之前的默认底色是**白色**，而窗口 build()
            // 之后立刻 show()，于是冷启动能看到约 1.2 秒白屏（实测：进程启动
            // → 建窗 1s → 前端 bootstrap 完成 2s）。这里把窗口层与 webview 层
            // 的底色都设成主题暗底 #07090c，白屏变成同色深底；剩下的首帧内容由
            // index.html 里的内联骨架补上（不依赖 JS bundle 下载与执行）。
            .background_color(tauri::window::Color(7, 9, 12, 255))
            .data_directory(webview_profile)
            .additional_browser_args("--no-sandbox")
            .build()
            .map_err(|err| {
                eprintln!("CyberDeck Launcher: webview window failed: {err}");
                err
            })?;
            window.show()?;
            eprintln!("CyberDeck Launcher: window ready");

            // 长任务登记表：必须在任何命令可能被调用之前就位。
            app.manage(BusyTasks::default());

            // 托盘要在窗口创建之后建（要用 default_window_icon）。
            let lifecycle = app.handle().clone();
            match setup_tray(&lifecycle) {
                Ok(()) => log_startup(&diag_dir, "stage=tray ok"),
                // 托盘建不起来不该拖垮整个程序：记下来继续跑，关闭拦截照常生效。
                Err(err) => log_startup(&diag_dir, &format!("stage=tray err {err}")),
            }

            // 关闭拦截：三种走向，托盘右键"彻底退出"不走这里（那边永远直接退）。
            window.on_window_event(move |event| {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    // prevent_close 必须同步调用：回调返回后再拦就晚了。
                    api.prevent_close();
                    let behavior = close_behavior(&lifecycle);
                    let ask = close_ask(&lifecycle);
                    if behavior == "exit" {
                        log_lifecycle(&lifecycle, "stage=close action=exit");
                        request_exit(&lifecycle);
                    } else if !ask {
                        // 用户勾过"以后不再询问"：直接最小化，不再打扰。
                        log_lifecycle(&lifecycle, "stage=close action=hide-to-tray silent");
                        hide_main_window(&lifecycle);
                    } else {
                        // 先把窗口显示出来：最小化状态下弹窗看不见。
                        log_lifecycle(&lifecycle, "stage=close action=ask");
                        show_main_window(&lifecycle);
                        let _ = lifecycle.emit("close-requested", ());
                    }
                }
            });

            log_startup(&diag_dir, "stage=lifecycle ok");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            bootstrap,
            sync_physical_state,
            create_env_snapshot,
            list_env_snapshots,
            delete_env_snapshot,
            apply_env_snapshot,
            scan_save_games,
            open_save_editor,
            refresh_game,
            detect_game_path,
            set_game_dir,
            clear_update_lock,
            diagnose_environment,
            heal_environment,
            adopt_scan,
            adopt_execute,
            adopt_cancel,
            adopt_normalize,
            adopt_staging_health,
            vortex_takeover_preflight,
            vortex_takeover_set_enabled,
            vortex_sync_status,
            vortex_sync_retry,
            vortex_sync_restore,
            vortex_coverage,
            vortex_mapping_rebuild,
            vortex_sync_full,
            vortex_reconcile,
            vortex_prelaunch_check,
            vortex_rebuild_preview,
            vortex_rebuild_apply,
            vortex_rebuild_backups,
            vortex_rebuild_restore,
            switch_profile,
            export_profile_modlist,
            import_profile_modlist,
            set_mods_enabled,
            suggest_staging_dir,
            nxm_intake,
            nxm_intake_file,
            external_tools_list,
            external_tool_add,
            external_tool_update,
            external_tool_remove,
            external_tool_launch,
            list_profiles,
            save_profile_state,
            create_profile,
            rename_profile,
            delete_profile,
            duplicate_profile,
            open_in_explorer,
            repair_mod,
            clear_game_dir,
            install_mods,
            nexus_backfill_propose,
            nexus_backfill_apply,
            pack_export,
            pack_preview,
            pack_install,
            pack_queue_downloads,
            pack_manual_pages,
            pack_apply,
            parse_collection_manifest,
            apply_collection_order,
            set_mod_enabled,
            switch_mod_version,
            uninstall_mod,
            update_mod,
            get_load_order,
            suggest_load_order,
            set_load_order_pins,
            save_load_order,
            save_redmod_order,
            export_modlist,
            remove_modlist,
            set_write_modlist,
            set_settings,
            read_background_image,
            change_staging_dir,
            detect_tool,
            list_busy_tasks,
            nexus_status,
            nexus_test_connection,
            nexus_set_key,
            nexus_clear_key,
            nexus_browse,
            nexus_detail,
            nxm_status,
            nxm_takeover,
            nxm_release,
            nxm_pending,
            nxm_dismiss,
            nexus_download,
            download_queue_list,
            download_queue_settings_get,
            download_queue_settings_set,
            download_queue_add,
            download_queue_pause,
            download_queue_resume,
            download_queue_cancel,
            download_queue_remove,
            download_queue_clear_finished,
            nexus_prune_downloads,
            nexus_check_updates,
            nexus_apply_update,
            nexus_apply_updates,
            nexus_updates_pause,
            nexus_updates_cancel,
            nexus_rollback_update,
            nexus_list_update_backups,
    nexus_refresh_covers,
    cover_cache_stats,
    cover_cache_fill,
    cover_cache_clear,
    nexus_enrich_metadata,
    attach_mod_from_nexus,
    vortex_import_metadata,
    update_mod_metadata,
    reclassify_unclassified,
    reclassify_all,
    set_mod_category,
    set_mods_category,
    game_process_running,
    stop_game_process,
    set_translation_parent,
    mods_translate,
    ai_loc_plan,
    ai_loc_apply,
    ai_loc_revert,
    ai_fix_propose,
    ai_fix_apply,
    ai_fix_revert,
    glossary_status,
    glossary_export,
    glossary_import,
    glossary_config,
    glossary_set_config,
    glossary_sync,
    config_export,
    config_import,
    safemode_state,
    safemode_enter,
    safemode_exit,
    compat_scan,
            ai_status,
            ai_profiles,
    ai_profile_save,
    ai_profile_delete,
    ai_profile_activate,
    ai_profile_clear_key,
    ai_profile_test,
    ai_set_key,
            ai_clear_key,
            ai_diagnose,
    ai_apply_action,
            ai_list_models,
            scan_archive_deep,
            resolve_deep_scan_paths,
            open_url,
            open_nexus_browser,
            get_mod_settings,
            save_mod_setting,
            restore_mod_settings,
    get_mod_config,
    save_config_field,
    get_global_configs,
            list_logs,
            read_log_tail,
            get_diagnostics,
            create_backup,
            restore_original,
            inspect_launch,
            launch_game,
            open_path,
            open_logs_folder,
            reveal_mod,
            app_data_dir,
            ping,
            close_window_action
        ])
        .run(tauri::generate_context!())
        .unwrap_or_else(|error| report_fatal_startup(&error));
}

#[cfg(test)]
mod adopt_tests;
#[cfg(test)]
mod pack_tests;
#[cfg(test)]
mod ai_tools_tests;
#[cfg(test)]
mod game_tests;
#[cfg(test)]
mod installer_tests;
#[cfg(test)]
mod nxm_tests;

#[cfg(test)]
mod background_tests {
    use super::{base64_encode, prepare_background, BACKGROUND_MAX_EDGE, BACKGROUND_MAX_SOURCE};

    #[test]
    fn base64_rfc4648_vectors() {
        // RFC 4648 §10 的标准向量，一字不差。
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
        assert_eq!(base64_encode(b"foob"), "Zm9vYg==");
        assert_eq!(base64_encode(b"fooba"), "Zm9vYmE=");
        assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn base64_binary_roundtrip_shape() {
        let data: Vec<u8> = (0..=255u8).cycle().take(4096).collect();
        let encoded = base64_encode(&data);
        assert_eq!(encoded.len(), data.len().div_ceil(3) * 4);
        assert!(encoded.chars().all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '/' || c == '='));
    }

    /// 上限只用来挡掉「根本不该当壁纸」的怪物文件，不再拿它拦正常 4K 原图。
    #[test]
    fn background_limits_are_sane() {
        assert_eq!(BACKGROUND_MAX_SOURCE, 200 * 1024 * 1024);
        assert_eq!(BACKGROUND_MAX_EDGE, 1920);
    }

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "cdl-bg-{tag}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// 超宽原图 → 缩到最长边 1920、转成 JPEG、写进缓存目录，第二次读命中缓存。
    #[test]
    fn oversized_image_is_downscaled_then_served_from_cache() {
        let dir = temp_dir("downscale");
        let source = dir.join("wide.png");
        let image = image::RgbImage::from_fn(3000, 100, |x, _| {
            image::Rgb([(x % 256) as u8, 40, 80])
        });
        image.save(&source).unwrap();

        let first = prepare_background(&dir, source.to_string_lossy().as_ref()).unwrap();
        assert!(first.data_url.starts_with("data:image/jpeg;base64,"));
        assert_eq!(first.source_size, std::fs::metadata(&source).unwrap().len());

        let cache = dir.join("background-cache");
        let files: Vec<_> = std::fs::read_dir(&cache)
            .unwrap()
            .flatten()
            .map(|entry| entry.path())
            .collect();
        assert_eq!(files.len(), 1, "缓存目录里只该留当前这张");
        let decoded = image::open(&files[0]).unwrap();
        assert_eq!(decoded.width(), BACKGROUND_MAX_EDGE);
        assert_eq!(decoded.height(), 64, "3000x100 等比缩到 1920x64");

        // 同一张图再读一次必须走缓存（内容一致，且不再产生新文件）。
        let second = prepare_background(&dir, source.to_string_lossy().as_ref()).unwrap();
        assert_eq!(second.data_url, first.data_url);
        assert_eq!(std::fs::read_dir(&cache).unwrap().count(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 换一张图之后，上一张的缓存必须被清掉。
    #[test]
    fn replacing_the_image_prunes_the_old_cache() {
        let dir = temp_dir("replace");
        let first = dir.join("a.png");
        image::RgbImage::from_pixel(64, 64, image::Rgb([10, 20, 30]))
            .save(&first)
            .unwrap();
        prepare_background(&dir, first.to_string_lossy().as_ref()).unwrap();

        let second = dir.join("b.png");
        image::RgbImage::from_pixel(64, 64, image::Rgb([200, 10, 10]))
            .save(&second)
            .unwrap();
        prepare_background(&dir, second.to_string_lossy().as_ref()).unwrap();

        let cache = dir.join("background-cache");
        assert_eq!(
            std::fs::read_dir(&cache).unwrap().count(),
            1,
            "旧缓存必须被清掉，否则缓存目录会越滚越大"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 坏文件 / 不支持的格式要给专门的错误码，前端据此提示「格式不支持或已损坏」。
    #[test]
    fn broken_image_reports_decode_error() {
        let dir = temp_dir("broken");
        let bad = dir.join("bad.png");
        std::fs::write(&bad, b"definitely not a png").unwrap();
        let error = prepare_background(&dir, bad.to_string_lossy().as_ref()).unwrap_err();
        assert_eq!(error.code, "BACKGROUND_DECODE");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
