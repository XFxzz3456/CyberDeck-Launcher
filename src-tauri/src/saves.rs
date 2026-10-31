//! 本地存档只读扫描 + 三规则诊断（任务 865759）。
//!
//! **红线：绝不打开/写入 `.dat` 二进制。** 存档信息只来自目录属性与
//! `metadata.json`（文本 JSON），诊断靠「快照时间线 + 依赖图 + 框架状态」推断，
//! 不做「这个存档依赖 Mod A」的字段级断言——游戏不写这个信息，谁都不该假装有。
//!
//! 规则：
//! A 时间线差异（高可信）：存档最后游玩时间 T 之前最近的快照里启用、现已禁用的 Mod。
//! B 依赖缺口（高可信）：当前启用集合里存在必需前置缺失的 Mod（复用 deps.rs）。
//! C 框架缺口（中可信）：快照记录的框架与当前不一致 / 已移除。

use crate::deps::build_report as build_dependency_report;
use crate::game::framework_statuses;
use crate::schema::{AppResult, AppStateData, GameInfo};
use crate::snapshots::{list_snapshots, EnvSnapshot};
use crate::store::now_iso;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveRisk {
    pub kind: String,        // timelineDiff | dependencyGap | frameworkGap
    pub severity: String,    // info | warning | critical
    pub mod_ids: Vec<String>,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveGameEntry {
    pub name: String,
    pub path: String,
    pub last_played: u64,
    pub size_bytes: u64,
    pub screenshot: Option<String>,
    pub risks: Vec<SaveRisk>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveScanReport {
    pub scanned_at: String,
    pub root: Option<String>,
    pub saves: Vec<SaveGameEntry>,
    pub risky_count: usize,
    pub notes: Vec<String>,
}

/// 存档根目录：`SHGetKnownFolderPath(FOLDERID_SavedGames)`，兼容「我的文档」重定向。
/// 不用 `%USERPROFILE%` 环境变量——本机用户目录全部重定向到 D 盘，
/// 且管理员/普通令牌下环境变量可能指向别人的配置目录（事故沉淀第 3 条）。
pub fn saves_root() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        use windows_sys::Win32::System::Com::CoTaskMemFree;
        use windows_sys::Win32::UI::Shell::{SHGetKnownFolderPath, FOLDERID_SavedGames};

        unsafe {
            let mut raw: *mut u16 = std::ptr::null_mut();
            let hr = SHGetKnownFolderPath(&FOLDERID_SavedGames, 0, std::ptr::null_mut(), &mut raw);
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
                return None;
            }
            Some(
                PathBuf::from(path)
                    .join("CD Projekt Red")
                    .join("Cyberpunk 2077"),
            )
        }
    }
    #[cfg(not(windows))]
    {
        None
    }
}

/// 递归扫描存档目录（CP2077 存档是子目录形式：QuickSave-0/、ManualSave-3/…）。
/// 只列目录 + 读目录属性；识别依据是目录里有 `sav.dat`。
fn collect_save_dirs(root: &Path, out: &mut Vec<PathBuf>, depth: usize) {
    if depth > 2 {
        return;
    }
    let Ok(entries) = fs::read_dir(root) else { return };
    for item in entries.flatten() {
        let path = item.path();
        if !path.is_dir() {
            continue;
        }
        if path.join("sav.dat").is_file() {
            out.push(path);
        } else {
            collect_save_dirs(&path, out, depth + 1);
        }
    }
}

fn dir_size(dir: &Path) -> u64 {
    let mut total = 0u64;
    if let Ok(entries) = fs::read_dir(dir) {
        for item in entries.flatten() {
            let path = item.path();
            if path.is_file() {
                total += item.metadata().map(|m| m.len()).unwrap_or(0);
            }
        }
    }
    total
}

fn dir_mtime(dir: &Path) -> u64 {
    fs::metadata(dir)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// 把 ISO8601 转成 epoch 秒，用于和存档 mtime 比较。
/// 只支持我们自己写出的 `YYYY-MM-DDTHH:MM:SS(.sss)?Z` 形态，不做完整 RFC3339 解析。
fn iso_to_epoch(iso: &str) -> Option<u64> {
    let bytes = iso.as_bytes();
    if bytes.len() < 19 {
        return None;
    }
    let num = |from: usize, to: usize| -> Option<i64> { iso.get(from..to)?.parse().ok() };
    let (y, mo, d, h, mi, s) = (
        num(0, 4)?,
        num(5, 7)?,
        num(8, 10)?,
        num(11, 13)?,
        num(14, 16)?,
        num(17, 19)?,
    );
    // Howard Hinnant 的 days_from_civil（无 chrono 依赖）。
    let y_adj = if mo <= 2 { y - 1 } else { y };
    let era = if y_adj >= 0 { y_adj } else { y_adj - 399 } / 400;
    let yoe = y_adj - era * 400;
    let doy = (153 * (if mo > 2 { mo - 3 } else { mo + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    Some((days * 86400 + h * 3600 + mi * 60 + s) as u64)
}

/// 取「存档时间 T 之前最近的一份快照」。
fn snapshot_before<'a>(snapshots: &'a [EnvSnapshot], epoch: u64) -> Option<&'a EnvSnapshot> {
    // snapshots 按 created_at 倒序（新→旧），第一份早于 T 的就是。
    snapshots
        .iter()
        .filter(|s| iso_to_epoch(&s.created_at).map(|t| t <= epoch).unwrap_or(false))
        .max_by_key(|s| iso_to_epoch(&s.created_at).unwrap_or(0))
}

pub fn scan_saves(
    state: &AppStateData,
    game: Option<&GameInfo>,
    data_dir: &Path,
) -> AppResult<SaveScanReport> {
    let mut notes = Vec::new();
    let root = saves_root();
    let Some(root) = root else {
        return Ok(SaveScanReport {
            scanned_at: now_iso(),
            root: None,
            saves: vec![],
            risky_count: 0,
            notes: vec!["无法定位存档目录（SHGetKnownFolderPath 失败）。".to_string()],
        });
    };
    if !root.is_dir() {
        return Ok(SaveScanReport {
            scanned_at: now_iso(),
            root: Some(root.to_string_lossy().to_string()),
            saves: vec![],
            risky_count: 0,
            notes: vec!["存档目录不存在（可能还没玩过游戏）。".to_string()],
        });
    }

    let mut save_dirs = Vec::new();
    collect_save_dirs(&root, &mut save_dirs, 0);
    save_dirs.sort();

    // 诊断所需的静态输入，整个扫描只算一次。
    let snapshots = list_snapshots(data_dir);
    if snapshots.is_empty() {
        notes.push("还没有环境快照，时间线诊断不可用（先创建一次快照）。".to_string());
    }
    let current_frameworks = game
        .map(|info| framework_statuses(Path::new(&info.root)))
        .unwrap_or_default();
    let dependency_report = build_dependency_report(&state.mods, &current_frameworks);

    let mut saves = Vec::new();
    let mut risky_count = 0usize;

    for dir in save_dirs {
        let epoch = dir_mtime(&dir);
        let name = dir
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "save".to_string());
        let screenshot = ["screenshot.png", "screenshot.jpg"]
            .iter()
            .map(|f| dir.join(f))
            .find(|p| p.is_file())
            .map(|p| p.to_string_lossy().to_string());

        let mut risks = Vec::new();

        // ── 规则 A：时间线差异 ────────────────────────────────────
        if let Some(snap) = snapshot_before(&snapshots, epoch) {
            let snap_enabled: std::collections::HashMap<&str, &str> = snap
                .mods
                .iter()
                .filter(|m| m.enabled)
                .map(|m| (m.id.as_str(), m.name.as_str()))
                .collect();
            let now_enabled: std::collections::HashSet<&str> = state
                .mods
                .iter()
                .filter(|m| m.enabled)
                .map(|m| m.id.as_str())
                .collect();
            let removed: Vec<(&str, &str)> = snap_enabled
                .iter()
                .filter(|(id, _)| !now_enabled.contains(**id))
                .map(|(id, name)| (*id, *name))
                .collect();
            if !removed.is_empty() {
                let names: Vec<&str> = removed.iter().take(4).map(|(_, n)| *n).collect();
                let suffix = if removed.len() > 4 {
                    format!(" 等 {} 个", removed.len())
                } else {
                    String::new()
                };
                risks.push(SaveRisk {
                    kind: "timelineDiff".to_string(),
                    severity: "warning".to_string(),
                    mod_ids: removed.iter().map(|(id, _)| id.to_string()).collect(),
                    message: format!(
                        "该存档游玩时启用的 Mod 现已禁用：{}{}",
                        names.join("、"),
                        suffix
                    ),
                });
            }

            // ── 规则 C：框架缺口 ─────────────────────────────────
            for fw in &snap.frameworks {
                if !fw.installed {
                    continue;
                }
                let current = current_frameworks.iter().find(|c| c.id == fw.id);
                let gone = current.map(|c| !c.installed).unwrap_or(false);
                let changed = current
                    .and_then(|c| c.version.as_deref())
                    .zip(fw.version.as_deref())
                    .map(|(a, b)| a != b)
                    .unwrap_or(false);
                if gone || changed {
                    risks.push(SaveRisk {
                        kind: "frameworkGap".to_string(),
                        severity: if gone { "critical" } else { "info" }.to_string(),
                        mod_ids: vec![],
                        message: if gone {
                            format!("该存档来自 {name} 环境，当前未安装 {name}", name = fw.name)
                        } else {
                            format!(
                                "该存档的 {name} 版本为 {old}，当前为 {new}",
                                name = fw.name,
                                old = fw.version.clone().unwrap_or_default(),
                                new = current
                                    .and_then(|c| c.version.clone())
                                    .unwrap_or_else(|| "未知".to_string())
                            )
                        },
                    });
                }
            }
        }

        // ── 规则 B：依赖缺口（当前启用集合本身的硬伤，影响所有存档）──
        for status in &dependency_report.mods {
            if status.enabled && status.status == "missing" {
                risks.push(SaveRisk {
                    kind: "dependencyGap".to_string(),
                    severity: "warning".to_string(),
                    mod_ids: vec![status.mod_id.clone()],
                    message: format!(
                        "当前启用的 {} 缺少前置：{}，读档可能失败",
                        status.mod_name,
                        status.missing.join("、")
                    ),
                });
            }
        }

        if risks.iter().any(|r| r.severity != "info") {
            risky_count += 1;
        }

        saves.push(SaveGameEntry {
            name,
            path: dir.to_string_lossy().to_string(),
            last_played: epoch,
            size_bytes: dir_size(&dir),
            screenshot,
            risks,
        });
    }

    // 最近游玩的在前。
    saves.sort_by(|a, b| b.last_played.cmp(&a.last_played));

    Ok(SaveScanReport {
        scanned_at: now_iso(),
        root: Some(root.to_string_lossy().to_string()),
        saves,
        risky_count,
        notes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_epoch_is_stable() {
        // 2026-10-30T00:00:00Z 与手工 days_from_civil 对照：只要能往返自洽即可。
        let a = iso_to_epoch("2026-10-30T00:00:00Z").unwrap();
        let b = iso_to_epoch("2026-10-30T00:00:01Z").unwrap();
        assert_eq!(b - a, 1);
        let earlier = iso_to_epoch("2026-10-29T23:59:59Z").unwrap();
        assert_eq!(a - earlier, 1);
        assert!(iso_to_epoch("not-a-date").is_none());
    }

    #[test]
    fn collect_only_directories_with_sav_dat() {
        let root = std::env::temp_dir().join(format!("cdl-saves-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("QuickSave-0")).unwrap();
        fs::create_dir_all(root.join("EmptyFolder")).unwrap();
        fs::write(root.join("QuickSave-0").join("sav.dat"), b"stub").unwrap();

        let mut out = Vec::new();
        collect_save_dirs(&root, &mut out, 0);
        assert_eq!(out.len(), 1);
        assert!(out[0].ends_with("QuickSave-0"));
        fs::remove_dir_all(&root).ok();
    }
}
