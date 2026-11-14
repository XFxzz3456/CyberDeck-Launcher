//! Mod 更新落地（P5-5B）：下载新版 → 备份旧版 → 替换 → 可回滚。
//!
//! 三条硬约束（来自 P5 文档的避坑段）：
//! 1. **替换前必须备份旧版本**：把旧暂存目录打成 `old.zip`，与清单一起放在
//!    `data/update-backups/<entryId>/<时间戳>/`，回滚就靠它。
//! 2. **保住 entry id**：播放集（profiles）与加载顺序都按 id 引用，换 id 会让
//!    用户的启用状态和排序凭空消失。安装完新版本后把 id 改回旧的。
//! 3. **先装后卸**：新版本装失败时旧版本还在，不会出现「卸了旧的、新的没装上」
//!    的空窗。代价是短暂多占一份暂存空间，值得。

use crate::deps;
use crate::installer;
use crate::nexus;
use crate::schema::{AppResult, CommandError, GameInfo, NexusRef};
use crate::store::Store;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

/// 单个模组的更新结果。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateApplyItem {
    pub entry_id: String,
    pub name: String,
    pub ok: bool,
    pub from_version: Option<String>,
    pub to_version: Option<String>,
    /// 备份标识；回滚时用它定位。失败时为 None。
    pub backup_id: Option<String>,
    pub error: Option<String>,
    /// 更新成功但后续动作（重新部署）出问题时的提示。
    pub warning: Option<String>,
}

/// 批量更新的汇总。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateApplyReport {
    pub applied: usize,
    pub failed: usize,
    pub items: Vec<UpdateApplyItem>,
    pub message: String,
}

/// 一份旧版本备份（磁盘上的 manifest.json 镜像）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateBackup {
    pub entry_id: String,
    pub name: String,
    pub mod_id: u64,
    pub from_version: Option<String>,
    pub to_version: Option<String>,
    pub created_at: String,
    pub enabled: bool,
    /// 备份 zip 的绝对路径（旧暂存目录的全部内容）。
    pub archive: String,
}

fn backups_root(store: &Store) -> PathBuf {
    store.data_dir.join("update-backups")
}

/// 目录 id 里可能有路径分隔符之类的东西，落盘前先洗一遍（备份目录名）。
fn safe_component(raw: &str) -> String {
    let cleaned: String = raw
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.') {
                ch
            } else {
                '_'
            }
        })
        .collect();
    if cleaned.trim_matches(['.', '_']).is_empty() {
        "mod".to_string()
    } else {
        cleaned
    }
}

fn now_stamp() -> String {
    crate::store::now_iso().replace([':', '.'], "-")
}

/// 把目录递归打成 zip（相对路径保存，回滚时能原样还原目录结构）。
fn zip_dir(src: &Path, dest: &Path) -> AppResult<()> {
    use zip::write::SimpleFileOptions;
    use zip::{CompressionMethod, ZipWriter};

    let file = fs::File::create(dest)
        .map_err(|e| CommandError::new("UPDATE_BACKUP", format!("无法创建备份文件：{e}")))?;
    let mut writer = ZipWriter::new(file);
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);

    fn walk(
        writer: &mut zip::ZipWriter<fs::File>,
        root: &Path,
        dir: &Path,
        options: zip::write::SimpleFileOptions,
    ) -> AppResult<()> {
        let entries = fs::read_dir(dir)
            .map_err(|e| CommandError::new("UPDATE_BACKUP", format!("读取暂存目录失败：{e}")))?;
        for entry in entries.flatten() {
            let path = entry.path();
            let relative = path
                .strip_prefix(root)
                .map_err(|_| CommandError::new("UPDATE_BACKUP", "备路径相对化失败"))?;
            let name = relative.to_string_lossy().replace('\\', "/");
            if path.is_dir() {
                writer
                    .add_directory(format!("{name}/"), options)
                    .map_err(|e| CommandError::new("UPDATE_BACKUP", format!("写入备份失败：{e}")))?;
                walk(writer, root, &path, options)?;
            } else if path.is_file() {
                writer
                    .start_file(name, options)
                    .map_err(|e| CommandError::new("UPDATE_BACKUP", format!("写入备份失败：{e}")))?;
                let mut input = fs::File::open(&path).map_err(|e| {
                    CommandError::new("UPDATE_BACKUP", format!("读取暂存文件失败：{e}"))
                })?;
                std::io::copy(&mut input, writer).map_err(|e| {
                    CommandError::new("UPDATE_BACKUP", format!("写入备份失败：{e}"))
                })?;
            }
        }
        Ok(())
    }

    if src.is_dir() {
        walk(&mut writer, src, src, options)?;
    }
    writer
        .finish()
        .map_err(|e| CommandError::new("UPDATE_BACKUP", format!("收尾备份失败：{e}")))?;
    Ok(())
}

/// 备份一个模组的旧暂存目录，返回可回滚的备份记录。
pub fn backup_entry(
    store: &Store,
    entry_id: &str,
    name: &str,
    mod_id: u64,
    from_version: Option<String>,
    to_version: Option<String>,
    enabled: bool,
    staging_path: &str,
) -> AppResult<UpdateBackup> {
    let root = backups_root(store).join(safe_component(entry_id)).join(now_stamp());
    fs::create_dir_all(&root)
        .map_err(|e| CommandError::new("UPDATE_BACKUP", format!("无法创建备份目录：{e}")))?;
    let archive = root.join("old.zip");
    zip_dir(Path::new(staging_path), &archive)?;

    let backup = UpdateBackup {
        entry_id: entry_id.to_string(),
        name: name.to_string(),
        mod_id,
        from_version,
        to_version,
        created_at: crate::store::now_iso(),
        enabled,
        archive: archive.to_string_lossy().to_string(),
    };
    let manifest = serde_json::to_string_pretty(&backup)
        .map_err(|e| CommandError::new("UPDATE_BACKUP", format!("备份清单生成失败：{e}")))?;
    let mut file = fs::File::create(root.join("manifest.json"))
        .map_err(|e| CommandError::new("UPDATE_BACKUP", format!("无法写入备份清单：{e}")))?;
    file.write_all(manifest.as_bytes())
        .map_err(|e| CommandError::new("UPDATE_BACKUP", format!("无法写入备份清单：{e}")))?;
    Ok(backup)
}

/// 列出所有备份，按时间从新到旧。
pub fn list_backups(store: &Store) -> Vec<UpdateBackup> {
    let root = backups_root(store);
    let mut out: Vec<UpdateBackup> = Vec::new();
    let Ok(mods) = fs::read_dir(&root) else {
        return out;
    };
    for mod_dir in mods.flatten() {
        let Ok(stamps) = fs::read_dir(mod_dir.path()) else {
            continue;
        };
        for stamp in stamps.flatten() {
            let manifest = stamp.path().join("manifest.json");
            let Ok(raw) = fs::read_to_string(&manifest) else {
                continue;
            };
            if let Ok(parsed) = serde_json::from_str::<UpdateBackup>(&raw) {
                if Path::new(&parsed.archive).is_file() {
                    out.push(parsed);
                }
            }
        }
    }
    out.sort_by(|left, right| right.created_at.cmp(&left.created_at));
    out
}

/// 把旧版本重新装上，并把 id 还原成原来那个。
fn reinstall_from_backup(
    store: &Store,
    backup: &UpdateBackup,
    game: Option<&GameInfo>,
) -> AppResult<()> {
    // 当前版本如果还部署着，必须先卸干净，否则会和新装的抢同一批文件。
    if game.is_none() {
        let deployed = {
            let data = store.data.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            data.mods
                .iter()
                .find(|item| item.id == backup.entry_id)
                .map(|item| !item.deployed_files.is_empty())
                .unwrap_or(false)
        };
        if deployed {
            return Err(CommandError::new(
                "GAME_REQUIRED",
                "这个模组还在部署中，回滚前请先定位游戏目录。",
            ));
        }
    }
    installer::uninstall_mod(store, &backup.entry_id, game.map(|g| Path::new(&g.root)))?;

    let nexus = NexusRef {
        mod_id: backup.mod_id,
        file_id: None,
        url: format!("https://www.nexusmods.com/cyberpunk2077/mods/{}", backup.mod_id),
        version: backup.from_version.clone(),
        picture_url: None,
        latest_version: backup.to_version.clone(),
        last_check: Some(crate::store::now_iso()),
    };
    let mut restored = installer::install_archive(store, &backup.archive, Some(nexus))?;
    restored.id = backup.entry_id.clone();
    restored.enabled = backup.enabled;
    {
        let mut data = store.data.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        data.mods.push(restored.clone());
        store.save(&data)?;
    }
    if backup.enabled {
        if let Some(game) = game {
            installer::deploy_mod(store, &restored.id, game)?;
        }
    }
    Ok(())
}

/// 旧版部署过、新版清单里却没有的框架核心文件。
/// 纯函数：把「完整性护栏」的判据单独拎出来跑单测，避免又要搭一整套安装夹具。
fn lost_core_files(old_paths: &[String], new_paths: &[String]) -> Vec<String> {
    // Windows 上同一条路径可能写成 `\` 也可能写成 `/`，大小写也不稳定；
    // 先归一化再比，否则「只是写法变了」会被误判成文件丢失。
    let normalize = |path: &str| path.replace('\\', "/").to_ascii_lowercase();
    let fresh: Vec<String> = new_paths.iter().map(|path| normalize(path)).collect();
    old_paths
        .iter()
        .filter(|path| deps::is_core_framework_file(path))
        .filter(|path| !fresh.contains(&normalize(path)))
        .cloned()
        .collect()
}

#[cfg(test)]
mod update_guard_tests {
    use super::lost_core_files;

    fn strings(items: &[&str]) -> Vec<String> {
        items.iter().map(|value| value.to_string()).collect()
    }

    #[test]
    fn rejects_update_that_drops_the_framework_dll() {
        let old = strings(&[
            "red4ext/plugins/ArchiveXL/ArchiveXL.dll",
            "archive/pc/mod/ArchiveXL.archive",
        ]);
        // 复现 #11②：安装根被判成 Bundle 后，新清单只剩拍平的 .xl。
        let new = strings(&[
            "archive/pc/mod/ArchiveXL.archive",
            "archive/pc/mod/Migration.xl",
        ]);
        let lost = lost_core_files(&old, &new);
        assert_eq!(lost, strings(&["red4ext/plugins/ArchiveXL/ArchiveXL.dll"]));
    }

    #[test]
    fn accepts_update_that_keeps_the_framework_dll() {
        let old = strings(&["red4ext/plugins/ArchiveXL/ArchiveXL.dll"]);
        let new = strings(&[
            "red4ext/plugins/ArchiveXL/ArchiveXL.dll",
            "red4ext/plugins/ArchiveXL/Bundle/Migration.xl",
            "r6/config/redsUserHints/ArchiveXL.toml",
        ]);
        assert!(lost_core_files(&old, &new).is_empty());
    }

    #[test]
    fn ignores_ordinary_mod_files() {
        let old = strings(&["archive/pc/mod/MyOutfit.archive", "archive/pc/mod/MyOutfit.archive.xl"]);
        let new = strings(&["archive/pc/mod/MyOutfit.archive"]);
        assert!(lost_core_files(&old, &new).is_empty());
    }

    #[test]
    fn comparison_is_case_and_separator_insensitive() {
        let old = strings(&["red4ext\\plugins\\ArchiveXL\\ARCHIVEXL.DLL"]);
        let new = strings(&["red4ext/plugins/ArchiveXL/ArchiveXL.dll"]);
        assert!(lost_core_files(&old, &new).is_empty());
        assert_eq!(lost_core_files(&old, &[]).len(), 1);
    }
}

/// 更新单个模组。
pub fn apply_update(
    app: &AppHandle,
    store: &Store,
    game: Option<&GameInfo>,
    entry_id: &str,
) -> AppResult<UpdateApplyItem> {
    let entry = {
        let data = store.data.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        data.mods
            .iter()
            .find(|item| item.id == entry_id)
            .cloned()
            .ok_or_else(|| CommandError::new("MOD_NOT_FOUND", "这个模组已经不在库里了。"))?
    };
    let Some(reference) = entry.nexus.clone() else {
        return Err(CommandError::new(
            "NOT_NEXUS_MOD",
            "这个模组不是从 Nexus 安装的，无法自动更新。请手动下载新版再导入。",
        ));
    };
    if !entry.deployed_files.is_empty() && game.is_none() {
        return Err(CommandError::new(
            "GAME_REQUIRED",
            "更新前请先定位游戏目录：这个模组仍在部署中，需要先卸下旧文件。",
        ));
    }

    // 1) 下载最新主文件（失败就到此为止，什么都不会改）。
    let downloaded = nexus::download_latest(app, store, reference.mod_id)?;
    let to_version = downloaded.version.clone();

    // 2) 备份旧暂存目录。
    let backup = backup_entry(
        store,
        &entry.id,
        &entry.name,
        reference.mod_id,
        reference.version.clone(),
        to_version.clone(),
        entry.enabled,
        &entry.staging_path,
    )?;

    // 3) 先把新版本装进暂存区：这一步失败时旧版本完好无损。
    let new_nexus = NexusRef {
        mod_id: reference.mod_id,
        file_id: Some(downloaded.file_id),
        url: reference.url.clone(),
        version: to_version.clone(),
        picture_url: downloaded
            .picture_url
            .clone()
            .or_else(|| reference.picture_url.clone()),
        latest_version: to_version.clone(),
        last_check: Some(crate::store::now_iso()),
    };
    let mut fresh =
        installer::install_archive(store, &downloaded.path.to_string_lossy(), Some(new_nexus))?;

    // 3.5) 完整性护栏：新版清单必须保住旧版部署过的框架核心文件。
    //
    // 2026-11-14 #11②：ArchiveXL 更新到 1.28.8 时，安装器把 Bundle/ 误判成
    // 安装根，新清单里一条 ArchiveXL.dll 都没有；下一步 uninstall_mod 又会把
    // 旧 DLL 从游戏目录撤掉，于是前置框架静默消失、几十个模组一起报缺前置。
    // 这里在「卸旧」之前拦下这种不完整更新，并把刚建好的临时暂存目录清掉，
    // 保证失败时旧版本原封不动。
    let old_paths: Vec<String> = entry
        .deployed_files
        .iter()
        .map(|file| file.relative_path.clone())
        .collect();
    let lost_core = lost_core_files(&old_paths, &fresh.planned_files);
    if !lost_core.is_empty() {
        // fresh 还没写进 state，只需删掉它自己的 staging 容器。
        let _ = fs::remove_dir_all(store.staging_dir().join(&fresh.id));
        return Err(CommandError::new(
            "UPDATE_INCOMPLETE",
            format!(
                "新版 {} 缺少旧版本已有的框架核心文件（{}），已取消更新，旧版本保持原样。\
                 请重新下载该模组的主文件，或改用手动导入。",
                entry.name,
                lost_core.join("、")
            ),
        ));
    }

    // 4) 卸掉旧版本（会清理它部署出去的文件）。
    installer::uninstall_mod(store, &entry.id, game.map(|g| Path::new(&g.root)))?;

    // 5) 新条目接管旧 id：播放集/加载顺序的引用保持有效。
    fresh.id = entry.id.clone();
    fresh.enabled = entry.enabled;
    fresh.category = entry.category.clone();
    fresh.category_locked = entry.category_locked;
    if fresh.raw_name.is_none() {
        fresh.raw_name = entry.raw_name.clone();
    }
    {
        let mut data = store.data.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        data.mods.push(fresh.clone());
        store.save(&data)?;
    }

    // 6) 原来启用着就重新部署回去。
    let mut warning = None;
    if entry.enabled {
        if let Some(game) = game {
            if let Err(err) = installer::deploy_mod(store, &fresh.id, game) {
                warning = Some(format!("已更新，但重新部署失败：{}", err.message));
            }
        }
    }

    Ok(UpdateApplyItem {
        entry_id: fresh.id,
        name: fresh.name,
        ok: true,
        from_version: reference.version,
        to_version,
        backup_id: Some(backup.archive),
        error: None,
        warning,
    })
}

/// 批量更新的运行控制（暂停 / 取消）。
///
/// 只对「批量更新」这条链路生效：`active` 为真时下载循环才理会暂停/取消，
/// 否则会误伤下载队列里用户手动排的任务。
struct BatchControl {
    active: AtomicBool,
    paused: AtomicBool,
    cancel: AtomicBool,
}

fn control() -> &'static BatchControl {
    static CELL: OnceLock<BatchControl> = OnceLock::new();
    CELL.get_or_init(|| BatchControl {
        active: AtomicBool::new(false),
        paused: AtomicBool::new(false),
        cancel: AtomicBool::new(false),
    })
}

pub fn set_batch_paused(paused: bool) {
    control().paused.store(paused, Ordering::Relaxed);
}

pub fn request_batch_cancel() {
    control().cancel.store(true, Ordering::Relaxed);
    // 取消时顺手解除暂停，否则循环会卡在暂停等待里。
    control().paused.store(false, Ordering::Relaxed);
}

/// 下载循环里调用：返回 true 表示应当立即中止（取消）；暂停则原地等。
///
/// 暂停是「真的停住」而不是「下完当前文件再说」——字节进度会停在同一处，
/// 恢复后从断点续传继续，和用户按暂停的直觉一致。
pub fn download_gate() -> bool {
    if !control().active.load(Ordering::Relaxed) {
        return false;
    }
    loop {
        if control().cancel.load(Ordering::Relaxed) {
            return true;
        }
        if !control().paused.load(Ordering::Relaxed) {
            return false;
        }
        std::thread::sleep(Duration::from_millis(80));
    }
}

/// 批量更新的完整清单：前端据此画出「12 个任务」的列表，而不是只有一条进度条。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateApplyPlan {
    pub total: usize,
    pub items: Vec<UpdateApplyPlanItem>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateApplyPlanItem {
    pub entry_id: String,
    pub name: String,
    pub mod_id: Option<u64>,
}

/// 批量更新：逐个来，单个失败不影响后面的。
/// 批量更新时逐个上报进度。
///
/// 为什么必须有：`apply_updates` 是串行阻塞的，19 个模组在慢速链路上要几十分钟，
/// 前端过去只能拿到一个 `applyingUpdates=true`，界面上就是一粒永久转圈——
/// 用户无法区分「在下第 4 个」和「卡死」。事件里带 index/total 与 modId，
/// 前端把 index/total 显示在按钮上，字节进度继续复用 `nexus-download-progress`。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateApplyProgress {
    /// 1-based，直接给「4/19」这种文案用。
    pub index: usize,
    pub total: usize,
    pub entry_id: String,
    pub name: String,
    /// 让前端把 `nexus-download-progress` 里同一 mod 的字节数对到当前这一项。
    pub mod_id: Option<u64>,
    /// `start` / `done` / `failed`。
    pub phase: &'static str,
}

pub fn apply_updates(
    app: &AppHandle,
    store: &Store,
    game: Option<&GameInfo>,
    entry_ids: &[String],
) -> AppResult<UpdateApplyReport> {
    let mut items: Vec<UpdateApplyItem> = Vec::new();
    let total = entry_ids.len();
    // 上一轮的残留状态（比如上次被取消）必须先清掉，否则新一轮一开跑就被打断。
    control().cancel.store(false, Ordering::Relaxed);
    control().paused.store(false, Ordering::Relaxed);
    control().active.store(true, Ordering::Relaxed);
    // 名字与 modId 先拍一次快照：循环里每轮再读 state 会跟 apply_update 的写锁抢。
    let labels: Vec<(String, Option<u64>)> = {
        let data = store.snapshot_data();
        entry_ids
            .iter()
            .map(|id| {
                data.mods
                    .iter()
                    .find(|item| &item.id == id)
                    .map(|item| {
                        (
                            item.name.clone(),
                            item.nexus.as_ref().map(|reference| reference.mod_id),
                        )
                    })
                    .unwrap_or_else(|| (id.clone(), None))
            })
            .collect()
    };

    // 清单先发一次：前端据此渲染完整列表（含「还没轮到的」），
    // 只靠逐项 start 的话，用户永远看不到后面还有几个。
    let _ = app.emit(
        "update-apply-plan",
        UpdateApplyPlan {
            total,
            items: entry_ids
                .iter()
                .zip(labels.iter())
                .map(|(id, (name, mod_id))| UpdateApplyPlanItem {
                    entry_id: id.clone(),
                    name: name.clone(),
                    mod_id: *mod_id,
                })
                .collect(),
        },
    );

    let mut cancelled = false;
    for (offset, entry_id) in entry_ids.iter().enumerate() {
        // 取消优先于暂停：用户点取消时不该再等暂停循环。
        if control().cancel.load(Ordering::Relaxed) {
            cancelled = true;
            break;
        }
        while control().paused.load(Ordering::Relaxed) && !control().cancel.load(Ordering::Relaxed) {
            std::thread::sleep(Duration::from_millis(80));
        }
        if control().cancel.load(Ordering::Relaxed) {
            cancelled = true;
            break;
        }
        let (name, mod_id) = &labels[offset];
        let _ = app.emit(
            "update-apply-progress",
            UpdateApplyProgress {
                index: offset + 1,
                total,
                entry_id: entry_id.clone(),
                name: name.clone(),
                mod_id: *mod_id,
                phase: "start",
            },
        );
        let item = match apply_update(app, store, game, entry_id) {
            Ok(item) => item,
            Err(err) => UpdateApplyItem {
                entry_id: entry_id.clone(),
                name: name.clone(),
                ok: false,
                from_version: None,
                to_version: None,
                backup_id: None,
                error: Some(err.message),
                warning: None,
            },
        };
        let _ = app.emit(
            "update-apply-progress",
            UpdateApplyProgress {
                index: offset + 1,
                total,
                entry_id: entry_id.clone(),
                name: name.clone(),
                mod_id: *mod_id,
                phase: if item.ok { "done" } else { "failed" },
            },
        );
        items.push(item);
    }
    control().active.store(false, Ordering::Relaxed);
    control().paused.store(false, Ordering::Relaxed);
    let applied = items.iter().filter(|item| item.ok).count();
    let failed = items.len() - applied;
    let message = if cancelled {
        format!(
            "已取消：完成 {applied} 个，其余 {} 个没开始（已下好的部分会续传）。",
            total.saturating_sub(items.len())
        )
    } else if failed == 0 {
        format!("{applied} 个模组已更新，旧版本都留了备份。")
    } else {
        format!("{applied} 个更新成功，{failed} 个失败（失败的没动过原文件）。")
    };
    Ok(UpdateApplyReport {
        applied,
        failed,
        items,
        message,
    })
}

/// 回滚到最近一次更新前的版本。
pub fn rollback_update(
    store: &Store,
    game: Option<&GameInfo>,
    entry_id: &str,
) -> AppResult<UpdateApplyItem> {
    let backup = list_backups(store)
        .into_iter()
        .find(|item| item.entry_id == entry_id)
        .ok_or_else(|| {
            CommandError::new(
                "NO_BACKUP",
                "这个模组没有可回滚的备份（更新时留下的备份已被清理）。",
            )
        })?;
    reinstall_from_backup(store, &backup, game)?;
    Ok(UpdateApplyItem {
        entry_id: entry_id.to_string(),
        name: backup.name.clone(),
        ok: true,
        from_version: backup.to_version.clone(),
        to_version: backup.from_version.clone(),
        backup_id: Some(backup.archive.clone()),
        error: None,
        warning: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_components_are_sanitised() {
        assert_eq!(safe_component("a/b\\c d"), "a_b_c_d");
        assert_eq!(safe_component(".."), "mod");
        assert_eq!(safe_component("ok-id_1"), "ok-id_1");
    }

    #[test]
    fn zip_dir_roundtrip_keeps_nested_files() {
        let root = std::env::temp_dir().join(format!("cdl-zip-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let src = root.join("payload");
        fs::create_dir_all(src.join("archive/pc/mod")).unwrap();
        fs::write(src.join("archive/pc/mod/a.archive"), b"AAA").unwrap();
        fs::write(src.join("readme.txt"), b"hello").unwrap();

        let zip = root.join("old.zip");
        zip_dir(&src, &zip).unwrap();
        assert!(zip.is_file());

        // 解压校验：条目名用正斜杠、内容一致。
        let file = fs::File::open(&zip).unwrap();
        let mut archive = zip::ZipArchive::new(file).unwrap();
        let names: Vec<String> = (0..archive.len())
            .map(|index| archive.by_index(index).unwrap().name().to_string())
            .collect();
        assert!(names.iter().any(|name| name == "archive/pc/mod/a.archive"));
        assert!(names.iter().any(|name| name == "readme.txt"));
        let _ = fs::remove_dir_all(&root);
    }
}
