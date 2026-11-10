//! AI 汉化词表：本地入库 + 可选云端共享（名称级，对应看板【7】）。
//!
//! 三条硬规则：
//! 1. **本地优先**——云端词表只能填补本地缺失的条目，绝不能覆盖本地译文
//!    （本地含用户手工改过的、以及本机 AI 已译过的）。
//! 2. **版本隔离**——主键是 `mod_id + 原文哈希`，Mod 更新后原文一变就不再命中，
//!    自然失效，不需要任何迁移逻辑。
//! 3. **不碰状态文件**——词表与共享配置各自独立存盘，不动 `AppStateData` 的 schema，
//!    避免再次踩到「解析失败即清库」那类事故。

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::schema::{AppResult, CommandError};
use crate::store::{now_iso, write_atomic, Store};

const GLOSSARY_FILE: &str = "glossary.json";
const CONFIG_FILE: &str = "glossary-config.json";
/// 词表包格式版本。小于等于当前版本的包才会被接收。
const PACK_VERSION: u32 = 1;
/// 云端同步超时。词表是「锦上添花」，绝不能拖住启动或翻译。
const SYNC_TIMEOUT_SECS: u64 = 5;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct GlossaryEntry {
    /// 原文（Mod 名 / 待译文本）。
    pub source: String,
    /// 译文。
    pub target: String,
    /// 来源：`ai`（本机 AI 译）、`user`（人工改过）、`cloud`（云端词表）。
    /// `ai` 与 `user` 都算「本地」，云端永远不能覆盖。
    pub by: String,
    pub updated_at: String,
}

#[derive(Serialize, Deserialize, Default, Clone, Debug)]
pub struct Glossary {
    #[serde(default)]
    pub version: u32,
    /// key = `mod_id@hash(source)`
    #[serde(default)]
    pub entries: BTreeMap<String, GlossaryEntry>,
}

#[derive(Serialize, Deserialize, Default, Clone, Debug)]
pub struct GlossaryConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub remote_url: String,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct PackEntry {
    pub mod_id: String,
    pub source: String,
    pub target: String,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct GlossaryPack {
    pub version: u32,
    #[serde(default)]
    pub exported_at: String,
    #[serde(default)]
    pub entries: Vec<PackEntry>,
}

#[derive(Serialize, Deserialize, Default, Debug)]
pub struct GlossaryMerge {
    pub added: usize,
    pub skipped: usize,
    pub conflicts: usize,
    pub total: usize,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct GlossaryStatus {
    pub entries: usize,
    pub local: usize,
    pub cloud: usize,
    pub enabled: bool,
    pub remote_url: String,
}

/// 词表主键：mod_id + 原文哈希（FNV-1a 64，稳定且无需引依赖）。
pub fn key(mod_id: &str, source: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in source.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{mod_id}@{hash:016x}")
}

fn glossary_path(store: &Store) -> PathBuf {
    store.data_dir.join(GLOSSARY_FILE)
}

fn config_path(store: &Store) -> PathBuf {
    store.data_dir.join(CONFIG_FILE)
}

/// 读词表。文件不存在 → 空表；文件损坏 → 报错而不是静默清空
/// （词表是花钱买来的资产，静默重置等于让用户重复付费）。
pub fn load(store: &Store) -> AppResult<Glossary> {
    let path = glossary_path(store);
    if !path.exists() {
        return Ok(Glossary::default());
    }
    let raw = std::fs::read_to_string(&path).map_err(|e| {
        CommandError::new("GLOSSARY_READ", format!("无法读取汉化词表：{e}"))
    })?;
    serde_json::from_str(&raw).map_err(|e| {
        CommandError::new(
            "GLOSSARY_PARSE",
            format!("汉化词表文件无法解析（{}）。文件保留原样，未做任何修改。", e),
        )
    })
}

fn save(store: &Store, glossary: &Glossary) -> AppResult<()> {
    let path = glossary_path(store);
    let text = serde_json::to_string_pretty(glossary)
        .map_err(|e| CommandError::new("GLOSSARY_ENCODE", format!("词表序列化失败：{e}")))?;
    write_atomic(&path, text.as_bytes())
        .map_err(|e| CommandError::new("GLOSSARY_WRITE", format!("无法写入汉化词表：{e}")))
}

pub fn load_config(store: &Store) -> GlossaryConfig {
    let path = config_path(store);
    std::fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

pub fn save_config(store: &Store, config: &GlossaryConfig) -> AppResult<()> {
    let path = config_path(store);
    let text = serde_json::to_string_pretty(config)
        .map_err(|e| CommandError::new("GLOSSARY_ENCODE", format!("配置序列化失败：{e}")))?;
    write_atomic(&path, text.as_bytes())
        .map_err(|e| CommandError::new("GLOSSARY_WRITE", format!("无法写入词表配置：{e}")))
}

pub fn status(store: &Store) -> AppResult<GlossaryStatus> {
    let glossary = load(store)?;
    let config = load_config(store);
    let cloud = glossary
        .entries
        .values()
        .filter(|entry| entry.by == "cloud")
        .count();
    Ok(GlossaryStatus {
        entries: glossary.entries.len(),
        local: glossary.entries.len().saturating_sub(cloud),
        cloud,
        enabled: config.enabled,
        remote_url: config.remote_url,
    })
}

/// 批量查词。返回与入参一一对应的译文（未命中为 None）。
pub fn lookup(store: &Store, items: &[(String, String)]) -> AppResult<Vec<Option<String>>> {
    let glossary = load(store)?;
    Ok(items
        .iter()
        .map(|(mod_id, source)| {
            glossary
                .entries
                .get(&key(mod_id, source))
                .map(|entry| entry.target.clone())
        })
        .collect())
}

/// 记一条本机译文（`by` 取 `ai` 或 `user`）。
///
/// 已存在且来源为 `user` 的条目永不被覆盖；`ai` 条目可被同来源刷新。
pub fn record(
    store: &Store,
    mod_id: &str,
    source: &str,
    target: &str,
    by: &str,
) -> AppResult<()> {
    let mut glossary = load(store)?;
    let id = key(mod_id, source);
    if let Some(existing) = glossary.entries.get(&id) {
        if existing.by == "user" && by != "user" {
            return Ok(());
        }
    }
    glossary.version = PACK_VERSION;
    glossary.entries.insert(
        id,
        GlossaryEntry {
            source: source.to_string(),
            target: target.to_string(),
            by: by.to_string(),
            updated_at: now_iso(),
        },
    );
    save(store, &glossary)
}

/// 合并外部词表包。规则：本地（`ai`/`user`）优先，cloud 只填空缺。
pub fn merge_pack(store: &Store, raw: &str) -> AppResult<GlossaryMerge> {
    let pack: GlossaryPack = serde_json::from_str(raw).map_err(|e| {
        CommandError::new(
            "GLOSSARY_PACK_INVALID",
            format!("词表文件无法解析，未做任何修改：{e}"),
        )
    })?;
    if pack.version > PACK_VERSION {
        return Err(CommandError::new(
            "GLOSSARY_PACK_VERSION",
            "词表文件来自更高版本的启动器，请先升级后再导入。",
        ));
    }

    let mut glossary = load(store)?;
    let mut report = GlossaryMerge::default();
    for item in pack.entries.iter() {
        if item.mod_id.trim().is_empty()
            || item.source.trim().is_empty()
            || item.target.trim().is_empty()
        {
            report.skipped += 1;
            continue;
        }
        let id = key(&item.mod_id, &item.source);
        match glossary.entries.get(&id) {
            Some(existing) if existing.target == item.target => {
                report.skipped += 1;
            }
            Some(_) => {
                // 本地已有不同译文：保留本地，记一次冲突。
                report.conflicts += 1;
            }
            None => {
                glossary.entries.insert(
                    id,
                    GlossaryEntry {
                        source: item.source.clone(),
                        target: item.target.clone(),
                        by: "cloud".to_string(),
                        updated_at: now_iso(),
                    },
                );
                report.added += 1;
            }
        }
    }
    glossary.version = PACK_VERSION;
    report.total = glossary.entries.len();
    if report.added > 0 {
        save(store, &glossary)?;
    }
    Ok(report)
}

/// 导出可分享的词表包（只含非空条目）。
pub fn export_pack(store: &Store) -> AppResult<String> {
    let glossary = load(store)?;
    let mut entries = Vec::new();
    for (id, entry) in glossary.entries.iter() {
        if entry.target.trim().is_empty() {
            continue;
        }
        // 主键形如 `mod_id@hash`；按最后一个 `@` 切开，mod_id 里允许出现 `@`。
        let mod_id = id.rsplit_once('@').map(|(left, _)| left).unwrap_or(id);
        entries.push(PackEntry {
            mod_id: mod_id.to_string(),
            source: entry.source.clone(),
            target: entry.target.clone(),
        });
    }
    let pack = GlossaryPack {
        version: PACK_VERSION,
        exported_at: now_iso(),
        entries,
    };
    serde_json::to_string_pretty(&pack)
        .map_err(|e| CommandError::new("GLOSSARY_ENCODE", format!("词表导出失败：{e}")))
}

/// 从云端拉取词表并合并。未启用或地址为空时直接返回空结果（不是错误）。
pub fn sync_remote(store: &Store) -> AppResult<GlossaryMerge> {
    let config = load_config(store);
    if !config.enabled || config.remote_url.trim().is_empty() {
        return Ok(GlossaryMerge::default());
    }
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(SYNC_TIMEOUT_SECS))
        .user_agent("CyberDeck-Launcher/glossary")
        .build()
        .map_err(|e| CommandError::new("GLOSSARY_NETWORK", format!("无法创建网络客户端：{e}")))?;
    let response = client
        .get(config.remote_url.trim())
        .send()
        .map_err(|e| CommandError::new("GLOSSARY_NETWORK", format!("连接词表服务失败：{e}")))?;
    if !response.status().is_success() {
        return Err(CommandError::new(
            "GLOSSARY_HTTP",
            format!("词表服务返回 HTTP {}。", response.status().as_u16()),
        ));
    }
    let text = response
        .text()
        .map_err(|e| CommandError::new("GLOSSARY_NETWORK", format!("读取词表响应失败：{e}")))?;
    merge_pack(store, &text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_store(tag: &str) -> (PathBuf, Store) {
        let root = std::env::temp_dir().join(format!(
            "cdl-glossary-{tag}-{}-{}",
            std::process::id(),
            now_iso().replace(':', "-")
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let store = Store::load(root.clone()).unwrap();
        (root, store)
    }

    #[test]
    fn local_entries_win_over_cloud_pack() {
        let (root, store) = temp_store("local-win");
        record(&store, "mod-a", "Cyberware Expansion", "义体扩展", "user").unwrap();

        let pack = GlossaryPack {
            version: PACK_VERSION,
            exported_at: now_iso(),
            entries: vec![
                PackEntry {
                    mod_id: "mod-a".into(),
                    source: "Cyberware Expansion".into(),
                    target: "云端乱翻的义体".into(),
                },
                PackEntry {
                    mod_id: "mod-b".into(),
                    source: "Vehicle Pack".into(),
                    target: "载具包".into(),
                },
            ],
        };
        let merged = merge_pack(&store, &serde_json::to_string(&pack).unwrap()).unwrap();
        assert_eq!(merged.added, 1, "只应补一条缺失条目");
        assert_eq!(merged.conflicts, 1, "冲突要计数，但不覆盖本地");

        let hits = lookup(
            &store,
            &[
                ("mod-a".to_string(), "Cyberware Expansion".to_string()),
                ("mod-b".to_string(), "Vehicle Pack".to_string()),
            ],
        )
        .unwrap();
        assert_eq!(hits[0].as_deref(), Some("义体扩展"), "本地译文不能被云端盖掉");
        assert_eq!(hits[1].as_deref(), Some("载具包"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn key_changes_when_source_text_changes() {
        let first = key("mod-a", "Old Name");
        let second = key("mod-a", "New Name");
        assert_ne!(first, second, "Mod 更新导致原文变化后必须失配");
    }

    #[test]
    fn export_skips_empty_targets_and_round_trips() {
        let (root, store) = temp_store("export");
        record(&store, "mod-a", "A", "甲", "ai").unwrap();
        let json = export_pack(&store).unwrap();
        let pack: GlossaryPack = serde_json::from_str(&json).unwrap();
        assert_eq!(pack.entries.len(), 1);
        assert_eq!(pack.entries[0].target, "甲");

        let (root2, store2) = temp_store("export-2");
        let merged = merge_pack(&store2, &json).unwrap();
        assert_eq!(merged.added, 1);
        let _ = fs::remove_dir_all(root);
        let _ = fs::remove_dir_all(root2);
    }

    #[test]
    fn broken_pack_is_rejected_without_touching_local_file() {
        let (root, store) = temp_store("broken");
        record(&store, "mod-a", "A", "甲", "ai").unwrap();
        let before = fs::read_to_string(glossary_path(&store)).unwrap();
        let err = merge_pack(&store, "{ not json").unwrap_err();
        assert_eq!(err.code, "GLOSSARY_PACK_INVALID");
        let after = fs::read_to_string(glossary_path(&store)).unwrap();
        assert_eq!(before, after, "坏包不能改动本地词表");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn future_pack_version_is_rejected() {
        let (root, store) = temp_store("future");
        let pack = GlossaryPack {
            version: PACK_VERSION + 1,
            exported_at: now_iso(),
            entries: Vec::new(),
        };
        let err = merge_pack(&store, &serde_json::to_string(&pack).unwrap()).unwrap_err();
        assert_eq!(err.code, "GLOSSARY_PACK_VERSION");
        let _ = fs::remove_dir_all(root);
    }
}
