use crate::game::validate_game_dir;
use crate::schema::{AppResult, AppStateData, BackupInfo, CommandError, RestoreResult};
use crate::store::{is_within, now_stamp, safe_join, Store};
use std::fs;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

const BACKUP_ITEMS: [&str; 3] = [
    "archive/pc/mod/modlist.txt",
    "mods/modlist.txt",
    "r6/config",
];

pub fn ensure_backup(store: &Store, game_root: &Path, state: &mut AppStateData) -> AppResult<BackupInfo> {
    if let Some(existing) = &state.backup {
        if Path::new(&existing.game_dir) == game_root && Path::new(&existing.root).is_dir() {
            return Ok(existing.clone());
        }
    }
    create_backup(store, game_root, state)
}

pub fn create_backup(store: &Store, game_root: &Path, state: &mut AppStateData) -> AppResult<BackupInfo> {
    validate_game_dir(game_root)?;
    let stamp = now_stamp();
    let root = store.backup_root(&stamp);
    let files_root = root.join("files");
    fs::create_dir_all(&files_root)?;

    let mut copied: Vec<String> = Vec::new();
    for relative in BACKUP_ITEMS {
        let source = game_root.join(relative.replace('/', "\\"));
        if !source.exists() {
            continue;
        }
        if source.is_dir() {
            for entry in WalkDir::new(&source).into_iter().filter_map(Result::ok) {
                if !entry.file_type().is_file() {
                    continue;
                }
                let rel = entry
                    .path()
                    .strip_prefix(game_root)
                    .map_err(|_| CommandError::new("BACKUP_PATH", "备份路径越界。"))?
                    .to_string_lossy()
                    .replace('\\', "/");
                let target = files_root.join(rel.replace('/', "\\"));
                if let Some(parent) = target.parent() {
                    fs::create_dir_all(parent)?;
                }
                fs::copy(entry.path(), &target)?;
                copied.push(rel);
            }
        } else {
            let target = files_root.join(relative.replace('/', "\\"));
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::copy(&source, &target)?;
            copied.push(relative.to_string());
        }
    }

    let info = BackupInfo {
        id: format!("snapshot-{stamp}"),
        created_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        root: root.to_string_lossy().to_string(),
        game_dir: game_root.to_string_lossy().to_string(),
        files: copied,
    };
    let manifest = serde_json::to_string_pretty(&info)
        .map_err(|e| CommandError::new("BACKUP_SERIALIZE", e.to_string()))?;
    fs::write(root.join("manifest.json"), manifest)?;
    state.backup = Some(info.clone());
    Ok(info)
}

pub fn restore_backup(
    _store: &Store,
    game_root: &Path,
    state: &mut AppStateData,
) -> AppResult<RestoreResult> {
    let backup = state.backup.clone().ok_or_else(|| {
        CommandError::new(
            "NO_BACKUP",
            "还没有备份。第一次部署模组时启动器会自动创建，也可以在设置里手动创建。",
        )
    })?;
    let root = PathBuf::from(&backup.root).join("files");
    if !root.is_dir() {
        return Err(CommandError::new(
            "BACKUP_MISSING",
            "备份目录已不存在，无法恢复。",
        ));
    }
    let mut warnings = Vec::new();
    let mut restored = 0usize;
    for relative in &backup.files {
        let source = safe_join(&root, relative)?;
        let target = safe_join(game_root, relative)?;
        if !is_within(&root, &source) || !is_within(game_root, &target) {
            warnings.push(format!("跳过越界备份路径：{relative}"));
            continue;
        }
        if !source.is_file() {
            warnings.push(format!("备份中的文件已丢失：{relative}"));
            continue;
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::copy(&source, &target)
            .map_err(|e| CommandError::new("RESTORE_COPY", format!("恢复 {relative} 失败：{e}")))?;
        restored += 1;
    }

    let modlist_backed_up = backup
        .files
        .iter()
        .any(|path| path.eq_ignore_ascii_case("archive/pc/mod/modlist.txt"));
    if !modlist_backed_up {
        let managed = game_root
            .join("archive")
            .join("pc")
            .join("mod")
            .join("modlist.txt");
        if managed.is_file() {
            if let Ok(raw) = fs::read_to_string(&managed) {
                if crate::loadorder::is_managed_modlist(&raw) {
                    fs::remove_file(&managed)?;
                }
            }
        }
    }

    Ok(RestoreResult {
        undeployed: 0,
        restored_files: restored,
        warnings,
    })
}
