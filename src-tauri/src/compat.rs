//! 过期插件扫描：找出「明确声明不适配当前游戏版本」的 Mod（看板【13】B）。
//!
//! 判定原则（避免误报比多抓几个更重要）：
//! - 读到了版本声明且低于目标版本 → `stale`（红，确定过期）
//! - 没有声明 / 读不出来 / 声明格式不认识 → `warn`（黄，兼容性未知）
//! - 声明满足目标 → 不出现在报告里
//!
//! 只读操作：不修改任何 Mod 文件，也不写状态。

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use regex::Regex;
use serde::{Deserialize, Serialize};
use walkdir::WalkDir;

use crate::schema::{AppResult, CommandError};
use crate::store::Store;

/// 目标游戏版本。0.9.0 按看板定义的 2.5 线；游戏实际版本可由调用方覆盖。
pub const TARGET_GAME_VERSION: &str = "2.5";

/// 单个 Mod 目录里最多看这么多文件，避免超大 Mod 拖慢扫描。
const MAX_FILES_PER_MOD: usize = 120;
const MAX_MANIFEST_BYTES: u64 = 64 * 1024;

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CompatIssue {
    pub mod_id: String,
    pub name: String,
    /// 读到的版本声明原文（没有则 None）。
    pub declared: Option<String>,
    /// 判定依据，直接给用户看。
    pub reason: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct CompatReport {
    pub target_version: String,
    pub scanned: usize,
    pub stale: Vec<CompatIssue>,
    pub warn: Vec<CompatIssue>,
}

fn version_regexes() -> &'static Vec<Regex> {
    static REGEXES: OnceLock<Vec<Regex>> = OnceLock::new();
    REGEXES.get_or_init(|| {
        [
            // JSON：{"gameVersion": "2.21"}
            r#"(?i)"game[_-]?version"\s*:\s*"([^"]+)""#,
            r#"(?i)"game[_-]?version[_-]?min"\s*:\s*"([^"]+)""#,
            r#"(?i)"(?:target|required)[_-]?game[_-]?version"\s*:\s*"([^"]+)""#,
            // TOML / INI：game_version = "2.21" / gameVersion=2.21
            r#"(?i)game[_-]?version\s*[:=]\s*"?([0-9][^"\r\n,}\]]*)"?#,
            // CET manifest 里偶见：compatibleVersions: ["2.2","2.21"]
            r#"(?i)"compatible[_-]?versions?"\s*:\s*\[([^\]]*)\]"#,
        ]
        .iter()
        .filter_map(|pattern| Regex::new(pattern).ok())
        .collect()
    })
}

/// 解析版本号为数字段序列：`2.21` → [2, 2, 1]，`2.5` → [2, 5]，`2.3.0` → [2, 3, 0]。
///
/// 🔴 关键：赛博朋克的版本号不是"两位小数"。`2.21` 表示 2.2.1 这个补丁，比 `2.5`
/// 早，但按整数比较 21 > 5 会得出相反结论。所以这里把每一段数字拆成独立分量，
/// 用字典序比较——`[2,2,1] < [2,5]` 与 `[2,2,1] < [2,3]` 都成立。
fn parse_version(raw: &str) -> Option<Vec<u32>> {
    // 逐位取数字：`2.21` → [2, 2, 1]、`2.5` → [2, 5]、`2.3.0` → [2, 3, 0]。
    // 这样 `2.21`（= 2.2.1）与 `2.5` 的先后关系才与游戏实际一致。
    let digits: Vec<u32> = raw
        .chars()
        .filter(|ch| ch.is_ascii_digit())
        .filter_map(|ch| ch.to_digit(10))
        .collect();
    if digits.is_empty() {
        None
    } else {
        Some(digits)
    }
}

/// 逐位字典序比较（短的补 0）：`[2,2,1] < [2,5]`、`[2,3] < [2,5]`。
///
/// 🔴 关键：赛博朋克的版本号里 `2.21` 是 2.2 之后的补丁，`2.5` 比它新。
/// 若把 21 当整数比，会得出"2.21 更新"的反结论。
fn version_lt(left: &[u32], right: &[u32]) -> bool {
    let len = left.len().max(right.len());
    for index in 0..len {
        let a = *left.get(index).unwrap_or(&0);
        let b = *right.get(index).unwrap_or(&0);
        if a != b {
            return a < b;
        }
    }
    false
}

fn is_manifest_file(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.ends_with(".toml")
        || lower.ends_with(".json")
        || lower.ends_with(".ini")
        || lower == "readme.txt"
}

/// 从一个 Mod 目录里尽力读出兼容声明。
fn read_declaration(dir: &Path) -> Option<String> {
    let mut seen = 0usize;
    for entry in WalkDir::new(dir)
        .max_depth(4)
        .into_iter()
        .filter_map(Result::ok)
    {
        if !entry.file_type().is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if !is_manifest_file(&name) {
            continue;
        }
        seen += 1;
        if seen > MAX_FILES_PER_MOD {
            break;
        }
        let meta = match entry.metadata() {
            Ok(meta) => meta,
            Err(_) => continue,
        };
        if meta.len() > MAX_MANIFEST_BYTES {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(entry.path()) else {
            continue;
        };
        for pattern in version_regexes() {
            let Some(captures) = pattern.captures(&text) else {
                continue;
            };
            let raw = captures.get(1)?.as_str();
            // compatibleVersions 数组：取其中最高的一个当声明。
            if raw.contains('"') {
                let mut best: Option<Vec<u32>> = None;
                let mut best_raw = String::new();
                for quoted in raw.split('"').filter(|item| item.trim().len() >= 3) {
                    if let Some(version) = parse_version(quoted) {
                        if best
                            .as_ref()
                            .map(|current| version_lt(current, &version))
                            .unwrap_or(true)
                        {
                            best = Some(version);
                            best_raw = quoted.trim().to_string();
                        }
                    }
                }
                if !best_raw.is_empty() {
                    return Some(best_raw);
                }
                continue;
            }
            if parse_version(raw).is_some() {
                return Some(raw.trim().trim_end_matches(['"', ',']).to_string());
            }
        }
    }
    None
}

/// 扫描全库。`target` 为空时用 `TARGET_GAME_VERSION`。
pub fn scan(store: &Store, target: Option<&str>) -> AppResult<CompatReport> {
    let target_raw = target
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(TARGET_GAME_VERSION)
        .to_string();
    let target_version = parse_version(&target_raw).ok_or_else(|| {
        CommandError::new("COMPAT_TARGET", format!("目标版本无法解析：{target_raw}"))
    })?;

    let data = store.snapshot_data();
    let mut report = CompatReport {
        target_version: target_raw.clone(),
        ..CompatReport::default()
    };
    let mut seen_ids: BTreeSet<String> = BTreeSet::new();

    for entry in data.mods.iter() {
        if !seen_ids.insert(entry.id.clone()) {
            continue;
        }
        let dir = PathBuf::from(&entry.staging_path);
        if !dir.is_dir() {
            continue;
        }
        report.scanned += 1;
        match read_declaration(&dir) {
            Some(declared) => match parse_version(&declared) {
                Some(version) if version_lt(&version, &target_version) => report.stale.push(CompatIssue {
                    mod_id: entry.id.clone(),
                    name: entry.name.clone(),
                    declared: Some(declared.clone()),
                    reason: format!("声明适配 {declared}，低于 {target_raw}"),
                }),
                Some(_) => {}
                None => report.warn.push(CompatIssue {
                    mod_id: entry.id.clone(),
                    name: entry.name.clone(),
                    declared: Some(declared.clone()),
                    reason: format!("版本声明“{declared}”无法解析"),
                }),
            },
            None => report.warn.push(CompatIssue {
                mod_id: entry.id.clone(),
                name: entry.name.clone(),
                declared: None,
                reason: "没有找到兼容性声明".to_string(),
            }),
        }
    }

    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema::{AppStateData, ModEntry};
    use std::fs;

    fn temp_store(tag: &str) -> (PathBuf, Store) {
        let root = std::env::temp_dir().join(format!(
            "cdl-compat-{tag}-{}-{}",
            std::process::id(),
            crate::store::now_iso().replace(':', "-")
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let store = Store::load(root.clone()).unwrap();
        (root, store)
    }

    fn entry_at(root: &Path, id: &str, name: &str, dir_name: &str) -> ModEntry {
        let staging = root.join("staging").join(dir_name);
        fs::create_dir_all(&staging).unwrap();
        ModEntry {
            id: id.to_string(),
            name: name.to_string(),
            version: None,
            author: None,
            category: "其他".to_string(),
            category_locked: false,
            description: String::new(),
            source_zip: None,
            nexus: None,
            staging_path: staging.to_string_lossy().to_string(),
            cover_path: None,
            enabled: true,
            installed_at: crate::store::now_iso(),
            updated_at: None,
            size_bytes: 0,
            file_count: 0,
            layout: crate::schema::InstallLayout::Archive,
            mod_folder: None,
            metadata_source: "test".to_string(),
            planned_files: Vec::new(),
            warnings: Vec::new(),
            deployed_files: Vec::new(),
            has_archive: false,
            has_redmod: false,
            has_cet: false,
            translated_name: None,
            translated_at: None,
            translated_by: None,
            managed: true,
            origin: "cyberdeck".to_string(),
            modpack_id: None,
            nexus_cover_url: None,
            is_translation: false,
            parent_mod_id: None,
            ai_loc: None,
            ai_fix: Vec::new(),
        }
    }

    /// 写入 mods 后必须重新 load：`save` 只落盘，内存里的快照不会跟着变。
    fn install(root: &Path, mods: Vec<ModEntry>) -> Store {
        let store = Store::load(root.to_path_buf()).unwrap();
        let mut data: AppStateData = store.snapshot_data();
        data.mods = mods;
        store.save(&data).unwrap();
        Store::load(root.to_path_buf()).unwrap()
    }

    #[test]
    fn declared_old_version_is_stale() {
        let (root, store) = temp_store("stale");
        let entry = entry_at(&root, "mod-old", "Old Mod", "old");
        fs::write(
            root.join("staging").join("old").join("manifest.json"),
            r#"{"name":"Old Mod","gameVersion":"2.21"}"#,
        )
        .unwrap();
        let store = install(&root, vec![entry]);
        let report = scan(&store, None).unwrap();
        assert_eq!(report.scanned, 1, "应扫描到 1 个 Mod：{report:?}");
        assert_eq!(report.stale.len(), 1, "{report:?}");
        assert_eq!(report.stale[0].declared.as_deref(), Some("2.21"));
        assert!(report.warn.is_empty());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn missing_declaration_is_warn_not_stale() {
        let (root, store) = temp_store("warn");
        let entry = entry_at(&root, "mod-unknown", "Unknown Mod", "unknown");
        fs::write(
            root.join("staging").join("unknown").join("readme.txt"),
            "no version info here",
        )
        .unwrap();
        let store = install(&root, vec![entry]);
        let report = scan(&store, None).unwrap();
        assert_eq!(report.scanned, 1, "应扫描到 1 个 Mod：{report:?}");
        assert_eq!(report.stale.len(), 0, "没有声明绝不能判过期：{report:?}");
        assert_eq!(report.warn.len(), 1);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn matching_declaration_is_not_reported() {
        let (root, store) = temp_store("ok");
        let entry = entry_at(&root, "mod-ok", "Fine Mod", "ok");
        fs::write(
            root.join("staging").join("ok").join("info.json"),
            r#"{"game_version":"2.5"}"#,
        )
        .unwrap();
        let store = install(&root, vec![entry]);
        let report = scan(&store, None).unwrap();
        assert_eq!(report.stale.len(), 0);
        assert_eq!(report.warn.len(), 0);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn version_parser_handles_common_shapes() {
        assert_eq!(parse_version("2.21"), Some(vec![2, 2, 1]));
        assert_eq!(parse_version("v2.21.0"), Some(vec![2, 2, 1, 0]));
        assert_eq!(parse_version("2.5"), Some(vec![2, 5]));
        assert_eq!(parse_version("abc"), None);
        // 2.21（=2.2.1）早于 2.5，且早于 2.3
        assert!(version_lt(&[2, 2, 1], &[2, 5]));
        assert!(version_lt(&[2, 3], &[2, 5]));
        assert!(!version_lt(&[2, 5], &[2, 5, 0]));
        assert!(!version_lt(&[3, 0], &[2, 5]));
    }
}
