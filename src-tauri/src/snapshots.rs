//! 环境快照（任务 865759「存档管理」核心页）。
//!
//! 快照是**纯 JSON**，存在 `data_dir/env-snapshots/<id>.json`，不碰游戏目录。
//! 用途有三条：
//! 1. 用户手动记录当前 Mod 环境；
//! 2. 每次部署前自动记录（`PreDeploy`，设置项可关）；
//! 3. 回滚前的自动备份（`PreApplySnapshot`，不可关——这是任务书的强制护城河）。
//!
//! 上限策略：保留 `settings.snapshot_limit` 份，超出删最旧。`PreApplySnapshot`
//! 永远优先保留（它是唯一的「回滚的回滚」证据），满了先删普通快照。

use crate::game::framework_statuses;
use crate::schema::{AppResult, AppStateData, CommandError, GameInfo};
use crate::store::{now_iso, write_atomic, Store};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

/// 快照来源。serde 存成 camelCase 字符串，前端按这个值显示徽标。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SnapshotTrigger {
    Manual,
    PreDeploy,
    PreApplySnapshot,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotModEntry {
    pub id: String,
    pub name: String,
    pub version: Option<String>,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotFramework {
    pub id: String,
    pub name: String,
    pub version: Option<String>,
    pub installed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvSnapshot {
    pub id: String,
    pub created_at: String,
    pub trigger: SnapshotTrigger,
    pub label: Option<String>,
    pub mod_count: usize,
    pub enabled_count: usize,
    pub frameworks: Vec<SnapshotFramework>,
    pub mods: Vec<SnapshotModEntry>,
    /// modlist 位次（id 列表，与写入游戏 modlist 的顺序一致）。
    /// 回滚时先恢复启用集合，再按它恢复加载顺序。
    #[serde(default)]
    pub load_order: Vec<String>,
}

pub fn snapshots_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("env-snapshots")
}

fn snapshot_path(data_dir: &Path, id: &str) -> PathBuf {
    snapshots_dir(data_dir).join(format!("{id}.json"))
}

/// id 只由时间戳 + 进程内序号组成，天然可排序、不含路径分隔符。
fn next_id() -> String {
    use std::sync::atomic::{AtomicU32, Ordering};
    static SEQ: AtomicU32 = AtomicU32::new(0);
    let seq = SEQ.fetch_add(1, Ordering::SeqCst);
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format!("snap-{millis}-{seq:04}")
}

/// 从当前状态构建一份快照（不写盘）。
pub fn build_snapshot(
    state: &AppStateData,
    game: Option<&GameInfo>,
    trigger: SnapshotTrigger,
    label: Option<String>,
) -> EnvSnapshot {
    let frameworks = game
        .map(|info| framework_statuses(Path::new(&info.root)))
        .unwrap_or_default()
        .into_iter()
        .map(|fw| SnapshotFramework {
            id: fw.id,
            name: fw.name,
            version: fw.version,
            installed: fw.installed,
        })
        .collect();

    let mods: Vec<SnapshotModEntry> = state
        .mods
        .iter()
        .map(|entry| SnapshotModEntry {
            id: entry.id.clone(),
            name: entry.name.clone(),
            version: entry.version.clone(),
            enabled: entry.enabled,
        })
        .collect();
    let enabled_count = mods.iter().filter(|m| m.enabled).count();

    EnvSnapshot {
        id: next_id(),
        created_at: now_iso(),
        trigger,
        label,
        mod_count: mods.len(),
        enabled_count,
        frameworks,
        mods,
        load_order: state.load_order.clone(),
    }
}

/// 写盘 + 按上限清理。返回落盘的快照。
pub fn write_snapshot(
    data_dir: &Path,
    snapshot: &EnvSnapshot,
    limit: usize,
) -> AppResult<EnvSnapshot> {
    let dir = snapshots_dir(data_dir);
    fs::create_dir_all(&dir)
        .map_err(|err| CommandError::new("SNAPSHOT_WRITE", format!("无法创建快照目录：{err}")))?;
    let text = serde_json::to_string_pretty(snapshot)
        .map_err(|err| CommandError::new("SNAPSHOT_WRITE", format!("快照序列化失败：{err}")))?;
    let path = snapshot_path(data_dir, &snapshot.id);
    write_atomic(&path, text.as_bytes())
        .map_err(|err| CommandError::new("SNAPSHOT_WRITE", format!("快照写入失败：{err}")))?;
    prune(data_dir, limit);
    Ok(snapshot.clone())
}

/// 读全部快照，按时间倒序（最新在前）。损坏的单个文件跳过并留注释，不让列表整体失败。
pub fn list_snapshots(data_dir: &Path) -> Vec<EnvSnapshot> {
    let dir = snapshots_dir(data_dir);
    let mut out = Vec::new();
    let entries = match fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(_) => return out,
    };
    for item in entries.flatten() {
        let path = item.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Ok(text) = fs::read_to_string(&path) else { continue };
        match serde_json::from_str::<EnvSnapshot>(&text) {
            Ok(snapshot) => out.push(snapshot),
            Err(err) => {
                // 单个坏文件不该让快照页空白；保留文件供人工排查。
                eprintln!("snapshot skipped ({}): {err}", path.display());
            }
        }
    }
    out.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    out
}

/// 上限清理：先删普通快照里最旧的，`PreApplySnapshot` 永远最后动。
fn prune(data_dir: &Path, limit: usize) {
    if limit == 0 {
        return;
    }
    let mut all = list_snapshots(data_dir); // 新→旧
    if all.len() <= limit {
        return;
    }
    // 从旧到新挑要删的：优先 Manual / PreDeploy。
    let mut to_delete = Vec::new();
    let mut remaining = all.len();
    // all 是倒序，rev() 即最旧在前。
    for snapshot in all.iter().rev() {
        if remaining <= limit {
            break;
        }
        if snapshot.trigger == SnapshotTrigger::PreApplySnapshot {
            continue;
        }
        to_delete.push(snapshot.id.clone());
        remaining -= 1;
    }
    // 全是 PreApplySnapshot 的极端情况：只能连备份也删（保留最新 N 份）。
    if remaining > limit {
        for snapshot in all.iter().rev() {
            if remaining <= limit {
                break;
            }
            if to_delete.contains(&snapshot.id) {
                continue;
            }
            to_delete.push(snapshot.id.clone());
            remaining -= 1;
        }
    }
    for id in to_delete {
        let _ = fs::remove_file(snapshot_path(data_dir, &id));
    }
    all.clear();
}

pub fn load_snapshot(data_dir: &Path, id: &str) -> AppResult<EnvSnapshot> {
    // 防路径穿越：id 只能来自我们生成的格式。
    if !id.starts_with("snap-") || id.contains(['/', '\\', '.']) {
        return Err(CommandError::new("SNAPSHOT_INVALID", "快照 ID 不合法。"));
    }
    let path = snapshot_path(data_dir, id);
    let text = fs::read_to_string(&path).map_err(|_| {
        CommandError::new("SNAPSHOT_NOT_FOUND", "找不到该快照（可能已被上限清理）。")
    })?;
    serde_json::from_str(&text)
        .map_err(|err| CommandError::new("SNAPSHOT_CORRUPT", format!("快照文件损坏：{err}")))
}

pub fn delete_snapshot(data_dir: &Path, id: &str) -> AppResult<()> {
    if !id.starts_with("snap-") || id.contains(['/', '\\', '.']) {
        return Err(CommandError::new("SNAPSHOT_INVALID", "快照 ID 不合法。"));
    }
    let path = snapshot_path(data_dir, id);
    if path.is_file() {
        fs::remove_file(&path)
            .map_err(|err| CommandError::new("SNAPSHOT_DELETE", format!("删除失败：{err}")))?;
    }
    Ok(())
}

/// 部署前自动快照（设置项 `auto_snapshot` 打开时）。
/// 失败**不阻断部署**：快照是保险，不该让主流程走不下去；错误只进 startup 日志。
pub fn auto_snapshot_pre_deploy(store: &Store, state: &AppStateData, game: Option<&GameInfo>) {
    if !state.settings.auto_snapshot {
        return;
    }
    let snapshot = build_snapshot(state, game, SnapshotTrigger::PreDeploy, None);
    if let Err(err) = write_snapshot(&store.data_dir, &snapshot, state.settings.snapshot_limit) {
        eprintln!("pre-deploy snapshot failed: {err}");
    }
}

/// 快照保存的是 archive 相对路径，不是 Mod ID。恢复时以部署后的状态为准，
/// 剔除已卸载/部署失败的路径，新增 archive 仍按 loadorder 的统一规则补到末尾。
pub fn restored_load_order(state: &AppStateData, saved: &[String]) -> Vec<String> {
    let mut restored = state.clone();
    restored.load_order = saved.to_vec();
    crate::loadorder::normalized_order(&restored)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fake_snapshot(seq: usize, trigger: SnapshotTrigger) -> EnvSnapshot {
        EnvSnapshot {
            id: format!("snap-test-{seq:04}"),
            created_at: format!("2026-10-30T00:{seq:02}:00Z"),
            trigger,
            label: None,
            mod_count: 3,
            enabled_count: 2,
            frameworks: vec![],
            mods: vec![],
            load_order: vec![],
        }
    }

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("cdl-snap-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn list_is_sorted_newest_first_and_skips_corrupt() {
        let dir = temp_dir("list");
        write_snapshot(&dir, &fake_snapshot(1, SnapshotTrigger::Manual), 10).unwrap();
        write_snapshot(&dir, &fake_snapshot(2, SnapshotTrigger::Manual), 10).unwrap();
        fs::write(snapshots_dir(&dir).join("snap-broken.json"), "{not json").unwrap();

        let list = list_snapshots(&dir);
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].id, "snap-test-0002");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn prune_keeps_pre_apply_snapshots() {
        let dir = temp_dir("prune");
        write_snapshot(&dir, &fake_snapshot(1, SnapshotTrigger::Manual), 10).unwrap();
        write_snapshot(&dir, &fake_snapshot(2, SnapshotTrigger::PreApplySnapshot), 10).unwrap();
        write_snapshot(&dir, &fake_snapshot(3, SnapshotTrigger::PreDeploy), 10).unwrap();

        prune(&dir, 2);
        let list = list_snapshots(&dir);
        assert_eq!(list.len(), 2);
        // 最旧的那个手动快照被删，回滚备份与最新部署快照保留。
        assert!(list.iter().any(|s| s.id == "snap-test-0002"));
        assert!(list.iter().any(|s| s.id == "snap-test-0003"));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn restore_filters_missing_paths_and_appends_new_archives() {
        let root = std::env::temp_dir().join(format!("cdl-snap-order-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let store = Store::load(root.clone()).unwrap();
        let entry: crate::schema::ModEntry = serde_json::from_value(serde_json::json!({
            "id": "mod-a",
            "name": "A",
            "category": "其它",
            "stagingPath": root.display().to_string(),
            "enabled": true,
            "installedAt": "2026-10-30T00:00:00Z",
            "sizeBytes": 1,
            "fileCount": 1,
            "layout": "archive",
            "deployedFiles": [{
                "source": root.join("a.archive").display().to_string(),
                "target": root.join("a.archive").display().to_string(),
                "linkType": "copy",
                "relativePath": "archive/pc/mod/a.archive"
            }]
        }))
        .unwrap();
        {
            let mut state = store.data.lock().unwrap();
            state.mods.push(entry);
        }
        let state = store.snapshot_data();
        let restored = restored_load_order(
            &state,
            &[
                "archive/pc/mod/missing.archive".to_string(),
                "ARCHIVE/PC/MOD/A.ARCHIVE".to_string(),
            ],
        );
        assert_eq!(restored, vec!["archive/pc/mod/a.archive"]);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn rejects_path_traversal_ids() {
        let dir = temp_dir("guard");
        assert!(load_snapshot(&dir, "../etc/passwd").is_err());
        assert!(delete_snapshot(&dir, "snap-../../x").is_err());
        fs::remove_dir_all(&dir).ok();
    }
}
