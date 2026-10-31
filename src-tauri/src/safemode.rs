//! Safe Mode：一键回到「没有任何用户 Mod」的纯净状态，并且可完整回退（看板【13】A）。
//!
//! 三条红线：
//! 1. **只断链接，不删文件**：撕除只按 `deployed_files` 走 `installer::undeploy_mod`，
//!    暂存区里的 Mod 本体一个字节都不动。
//! 2. **持锁不做 IO**：`Store::data` 的 Mutex 不可重入，而 `undeploy_mod` / `deploy_mod`
//!    内部会自己加锁，所以按「读快照 → 逐条撤除（不持锁）→ 短锁写状态 → 落盘」四段走。
//! 3. **回退依据是快照文件**，不靠猜测：快照丢了就明确报错，不做「尽力恢复」。

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::installer;
use crate::schema::{AppResult, CommandError};
use crate::store::{now_iso, Store};

const SNAPSHOT_FILE: &str = "safemode-snapshot.json";

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SafeModeSnapshot {
    pub created_at: String,
    pub enabled_ids: Vec<String>,
    pub load_order: Vec<String>,
    pub active_profile_id: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct SafeModeReport {
    /// 被撤除链接的文件数。
    pub undeployed_files: usize,
    /// 被停用的 Mod 数。
    pub disabled_mods: usize,
    /// 撤除失败（多为游戏目录被占用）的 Mod 数。
    pub failed_mods: usize,
    pub snapshot_path: String,
    pub errors: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SafeModeState {
    pub active: bool,
    pub snapshot_at: Option<String>,
    pub disabled_count: usize,
}

fn snapshot_path(store: &Store) -> PathBuf {
    store.data_dir.join(SNAPSHOT_FILE)
}

pub fn read_snapshot(store: &Store) -> Option<SafeModeSnapshot> {
    let raw = std::fs::read_to_string(snapshot_path(store)).ok()?;
    serde_json::from_str(&raw).ok()
}

pub fn state(store: &Store) -> SafeModeState {
    match read_snapshot(store) {
        Some(snapshot) => SafeModeState {
            active: true,
            snapshot_at: Some(snapshot.created_at),
            disabled_count: snapshot.enabled_ids.len(),
        },
        None => SafeModeState {
            active: false,
            snapshot_at: None,
            disabled_count: 0,
        },
    }
}

fn game_root(store: &Store) -> AppResult<PathBuf> {
    let data = store.snapshot_data();
    let dir = data
        .game_dir
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            CommandError::new(
                "GAME_DIR_MISSING",
                "还没有绑定游戏目录，无法断开部署链接。",
            )
        })?;
    let root = PathBuf::from(dir);
    if !root.is_dir() {
        return Err(CommandError::new(
            "GAME_DIR_MISSING",
            format!("游戏目录不存在：{root_display}", root_display = root.display()),
        ));
    }
    Ok(root)
}

/// 进入安全模式：快照 → 逐条撤除 → 短锁停用全部 → 落盘。
pub fn enter(store: &Store) -> AppResult<SafeModeReport> {
    if read_snapshot(store).is_some() {
        return Err(CommandError::new(
            "SAFEMODE_ACTIVE",
            "已经处于安全模式。如需重新开始，请先「恢复到禁用前」。",
        ));
    }
    let root = game_root(store)?;

    let snapshot_data = store.snapshot_data();
    let enabled_ids: Vec<String> = snapshot_data
        .mods
        .iter()
        .filter(|entry| entry.enabled)
        .map(|entry| entry.id.clone())
        .collect();
    let snapshot = SafeModeSnapshot {
        created_at: now_iso(),
        enabled_ids: enabled_ids.clone(),
        load_order: snapshot_data.load_order.clone(),
        active_profile_id: snapshot_data.active_profile_id.clone(),
    };
    let text = serde_json::to_string_pretty(&snapshot)
        .map_err(|e| CommandError::new("SAFEMODE_ENCODE", format!("快照序列化失败：{e}")))?;
    std::fs::write(snapshot_path(store), text)
        .map_err(|e| CommandError::new("SAFEMODE_WRITE", format!("无法写入安全模式快照：{e}")))?;

    // 逐条撤除：每一步都由 installer 自己加锁，这里绝不持锁。
    let mut report = SafeModeReport {
        snapshot_path: snapshot_path(store).to_string_lossy().to_string(),
        ..SafeModeReport::default()
    };
    for id in enabled_ids.iter() {
        match installer::undeploy_mod(store, id, &root) {
            Ok(files) => report.undeployed_files += files.len(),
            Err(err) => {
                report.failed_mods += 1;
                if report.errors.len() < 6 {
                    report.errors.push(format!("{id}: {}", err.message));
                }
            }
        }
    }

    // 短锁写状态：只改内存 + 一次落盘。
    {
        let mut data = store.data.lock().expect("state mutex poisoned");
        for entry in data.mods.iter_mut() {
            if entry.enabled {
                entry.enabled = false;
                report.disabled_mods += 1;
            }
        }
        data.load_order.clear();
        store.save(&data)?;
    }

    Ok(report)
}

/// 恢复到禁用前：读快照 → 短锁恢复启用集合 → 逐条重新部署 → 删除快照。
pub fn exit(store: &Store) -> AppResult<SafeModeReport> {
    let snapshot = read_snapshot(store).ok_or_else(|| {
        CommandError::new("SAFEMODE_IDLE", "没有可恢复的安全模式快照。")
    })?;
    let root = game_root(store)?;
    let game_info = crate::game::validate_game_dir(&root)?;

    // 先恢复启用标记与加载顺序（短锁），再部署：deploy_mod 会读 enabled 与 load_order。
    {
        let mut data = store.data.lock().expect("state mutex poisoned");
        let wanted: std::collections::HashSet<&String> = snapshot.enabled_ids.iter().collect();
        for entry in data.mods.iter_mut() {
            entry.enabled = wanted.contains(&entry.id);
        }
        // 恢复加载顺序：以快照为准，快照之后新增的条目追加在末尾（不丢新内容）。
        let mut restored = snapshot.load_order.clone();
        for item in data.load_order.iter() {
            if !restored.iter().any(|existing| existing == item) {
                restored.push(item.clone());
            }
        }
        data.load_order = restored;
        if snapshot.active_profile_id.is_some() {
            data.active_profile_id = snapshot.active_profile_id.clone();
        }
        store.save(&data)?;
    }

    let mut report = SafeModeReport {
        snapshot_path: snapshot_path(store).to_string_lossy().to_string(),
        disabled_mods: snapshot.enabled_ids.len(),
        ..SafeModeReport::default()
    };
    for id in snapshot.enabled_ids.iter() {
        match installer::deploy_mod(store, id, &game_info) {
            Ok(deploy) => report.undeployed_files += deploy.deployed,
            Err(err) => {
                report.failed_mods += 1;
                if report.errors.len() < 6 {
                    report.errors.push(format!("{id}: {}", err.message));
                }
            }
        }
    }

    // 有失败项时保留快照：用户还能再点一次恢复，不会因为一次目录占用丢掉回退能力。
    if report.failed_mods == 0 {
        let _ = std::fs::remove_file(snapshot_path(store));
    }
    Ok(report)
}

/// 只读检查：给定的每个目标文件是否仍在游戏目录里（用于验收「无残留」）。
///
/// 当前只在真机验收（docs/PROJECT_HISTORY.md#real-env-090 的 D 组（跨盘降级））里用，没有接成 Tauri 命令，
/// 所以编译期是 dead_code。**特意保留**：这是核查「安全模式真的把链接撕干净了」的唯一手段，
/// 删掉就等于放弃这一条验收能力。加 allow 是为了让 dead_code 警告保持零基线 ——
/// 那条警告是 0.9.0 抓出「命令漏注册」的唯一线索，不能被常规噪音稀释。
#[allow(dead_code)]
pub fn residual_files(store: &Store) -> Vec<String> {
    let data = store.snapshot_data();
    let Some(root) = data.game_dir.as_deref().map(Path::new) else {
        return Vec::new();
    };
    let mut leftovers = Vec::new();
    for entry in data.mods.iter() {
        for file in entry.deployed_files.iter() {
            let target = root.join(&file.relative_path);
            if target.exists() {
                leftovers.push(file.relative_path.clone());
            }
        }
    }
    leftovers
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_store(tag: &str) -> (PathBuf, Store) {
        let root = std::env::temp_dir().join(format!(
            "cdl-safemode-{tag}-{}-{}",
            std::process::id(),
            now_iso().replace(':', "-")
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let store = Store::load(root.clone()).unwrap();
        (root, store)
    }

    #[test]
    fn snapshot_round_trip_and_state() {
        let (root, store) = temp_store("roundtrip");
        assert!(!state(&store).active);
        let snapshot = SafeModeSnapshot {
            created_at: now_iso(),
            enabled_ids: vec!["mod-a".into()],
            load_order: vec!["archive/pc/mod/a.archive".into()],
            active_profile_id: Some("profile-default".into()),
        };
        fs::write(
            snapshot_path(&store),
            serde_json::to_string(&snapshot).unwrap(),
        )
        .unwrap();
        let read = read_snapshot(&store).unwrap();
        assert_eq!(read.enabled_ids, vec!["mod-a".to_string()]);
        assert!(state(&store).active);
        assert_eq!(state(&store).disabled_count, 1);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn exit_without_snapshot_reports_clear_error() {
        let (root, store) = temp_store("idle");
        let err = exit(&store).unwrap_err();
        assert_eq!(err.code, "SAFEMODE_IDLE");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn enter_requires_game_dir() {
        let (root, store) = temp_store("nogame");
        let err = enter(&store).unwrap_err();
        assert_eq!(err.code, "GAME_DIR_MISSING");
        let _ = fs::remove_dir_all(root);
    }
}
