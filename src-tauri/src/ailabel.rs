//! 启动器内配置项标签的本地化覆盖层（#6 范围 ①，M1）。
//!
//! 设计约束见 `docs/` 下的架构评审结论：
//! - 只覆盖启动器自己渲染的 `SettingField.label`，**不写游戏目录、不改玩家设置值**；
//!   CET `user.ini` / RED4ext TOML 存的是值，菜单文案在 Lua/inkwidget，不属于本模块范围。
//! - 产物是 `data_dir/ai-labels/<modId>.json` 独立文件，不动 `launcher-state.json` 的 schema。
//! - 指纹基于「来源 + section + key + 标签文本」，玩家改设置值不会让译文失效。
//! - 模组更新导致结构变化时译文自动失效，只提示重做，**绝不自动重跑 AI**（不烧额度、
//!   不覆盖本地自定义译文）。
//! - 撤销 = 删独立文件；没有任何文件写进游戏目录。

use std::collections::{BTreeSet, HashMap};
use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::config_resolver::ConfigSource;
use crate::schema::{AppResult, CommandError};
use crate::store::{now_iso, Store};

const OVERLAY_VERSION: u32 = 1;
/// 单模组最多翻译多少条标签，防止异常配置撑爆一次请求。
const MAX_LABELS: usize = 400;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Overlay {
    version: u32,
    generated_at: String,
    fingerprint: String,
    entries: HashMap<String, String>,
}

/// mod_id 会进文件名：只留 ASCII 字母数字与 `-` / `_`，挡住路径穿越。
fn sanitize(raw: &str) -> String {
    let cleaned: String = raw
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '-'
            }
        })
        .collect();
    let trimmed = cleaned.trim_matches('-').to_string();
    if trimmed.is_empty() {
        "mod".to_string()
    } else {
        trimmed.chars().take(64).collect()
    }
}

fn path_for(store: &Store, mod_id: &str) -> PathBuf {
    store
        .data_dir
        .join("ai-labels")
        .join(format!("{}.json", sanitize(mod_id)))
}

/// FNV-1a 64：与词表主键同一套算法，稳定、无需引依赖。
fn fnv1a64(text: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in text.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{hash:016x}")
}

/// 指纹只吃「结构 + 标签」，不吃 `value`：玩家改个开关不该让整份译文失效。
fn fingerprint(sources: &[ConfigSource]) -> String {
    let mut parts: Vec<String> = sources
        .iter()
        .flat_map(|source| {
            source.fields.iter().map(move |field| {
                format!(
                    "{}|{}|{}|{}|{}",
                    source.id, source.path, field.section, field.key, field.label
                )
            })
        })
        .collect();
    parts.sort();
    fnv1a64(&parts.join("\n"))
}

fn load(store: &Store, mod_id: &str) -> Option<Overlay> {
    let raw = fs::read_to_string(path_for(store, mod_id)).ok()?;
    let parsed: Overlay = serde_json::from_str(&raw).ok()?;
    (parsed.version == OVERLAY_VERSION).then_some(parsed)
}

/// 生成覆盖层：词表优先 → 未命中走 AI → 原子写独立 JSON。
/// 返回实际写入的译文条数。调用方必须已经拿到用户的显式同意。
pub fn generate(store: &Store, mod_id: &str) -> AppResult<usize> {
    let sources = crate::config_resolver::raw_mod_sources(store, mod_id)?;
    let labels: Vec<String> = sources
        .iter()
        .flat_map(|source| source.fields.iter().map(|field| field.label.clone()))
        .filter(|text| !text.trim().is_empty())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .take(MAX_LABELS)
        .collect();
    if labels.is_empty() {
        return Ok(0);
    }

    let pairs: Vec<(String, String)> = labels
        .iter()
        .map(|label| (mod_id.to_string(), label.clone()))
        .collect();
    let mut resolved: Vec<Option<String>> = crate::glossary::lookup(store, &pairs)
        .unwrap_or_else(|_| vec![None; labels.len()]);

    let pending_idx: Vec<usize> = resolved
        .iter()
        .enumerate()
        .filter(|(_, hit)| hit.is_none())
        .map(|(index, _)| index)
        .collect();
    if !pending_idx.is_empty() {
        let pending: Vec<String> = pending_idx
            .iter()
            .map(|&index| labels[index].clone())
            .collect();
        let batch = crate::ai::translate_locale_strings(store, &pending, mod_id)?;
        for (offset, text) in batch.texts.into_iter().enumerate() {
            let Some(text) = text.filter(|value| !value.trim().is_empty()) else {
                continue;
            };
            let index = pending_idx[offset];
            resolved[index] = Some(text.clone());
            // 词表主键含原文指纹，Mod 更新后天然失效；user 条目永不被覆盖。
            let _ = crate::glossary::record(store, mod_id, &labels[index], &text, "ai");
        }
    }

    let entries: HashMap<String, String> = labels
        .iter()
        .zip(resolved.iter())
        .filter_map(|(label, hit)| hit.as_ref().map(|text| (label.clone(), text.clone())))
        .collect();
    if entries.is_empty() {
        return Err(CommandError::new(
            "AI_LABEL_NOTHING_TRANSLATED",
            "没有翻出可用的配置项标签译文。",
        ));
    }
    let count = entries.len();
    let overlay = Overlay {
        version: OVERLAY_VERSION,
        generated_at: now_iso(),
        fingerprint: fingerprint(&sources),
        entries,
    };
    let path = path_for(store, mod_id);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension(format!("json.{}.tmp", std::process::id()));
    fs::write(&tmp, serde_json::to_string_pretty(&overlay).unwrap_or_default())?;
    // Windows 的 rename 不允许覆盖已存在目标；这是可重生成的独立文件，先删旧的。
    let _ = fs::remove_file(&path);
    fs::rename(&tmp, &path).map_err(|err| {
        CommandError::new("AI_LABEL_WRITE", format!("写入覆盖层失败：{err}"))
    })?;
    Ok(count)
}

/// 把译文套到启动器渲染的标签上。指纹不符只提示、不删文件、不自动重跑 AI。
pub fn apply_overlay(store: &Store, mod_id: &str, sources: &mut [ConfigSource]) -> Option<String> {
    let overlay = load(store, mod_id)?;
    if overlay.fingerprint != fingerprint(sources) {
        return Some(
            "配置项标签译文已过期（模组配置结构变了）。当前显示原文，重新执行 AI 汉化即可重做。"
                .to_string(),
        );
    }
    for source in sources.iter_mut() {
        for field in source.fields.iter_mut() {
            if let Some(text) = overlay.entries.get(&field.label) {
                field.label = text.clone();
            }
        }
    }
    None
}

/// 撤销：只删自己放进去的独立文件。
pub fn remove(store: &Store, mod_id: &str) -> AppResult<()> {
    let path = path_for(store, mod_id);
    if path.exists() {
        fs::remove_file(&path).map_err(|err| {
            CommandError::new("AI_LABEL_REMOVE", format!("删除覆盖层失败：{err}"))
        })?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config_resolver::SettingField;

    fn source(label: &str, value: &str) -> ConfigSource {
        ConfigSource {
            id: "mod_settings".to_string(),
            label: "Mod Settings".to_string(),
            path: "bin/x64/plugins/cyber_engine_tweaks/mods/ModSettings/user.ini".to_string(),
            format: "ini".to_string(),
            editable: true,
            fields: vec![SettingField {
                section: "Demo".to_string(),
                key: "show_minimap".to_string(),
                value: value.to_string(),
                kind: "bool".to_string(),
                label: label.to_string(),
            }],
            raw: None,
            note: None,
        }
    }

    fn write_overlay(store: &Store, mod_id: &str, sources: &[ConfigSource]) {
        let path = path_for(store, mod_id);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let overlay = Overlay {
            version: OVERLAY_VERSION,
            generated_at: now_iso(),
            fingerprint: fingerprint(sources),
            entries: HashMap::from([("show minimap".to_string(), "显示小地图".to_string())]),
        };
        fs::write(path, serde_json::to_string(&overlay).unwrap()).unwrap();
    }

    #[test]
    fn sanitize_blocks_path_traversal() {
        assert_eq!(sanitize("../../evil"), "evil");
        assert_eq!(sanitize(""), "mod");
        assert!(!sanitize("a/b\\c").contains('/'));
        assert!(!sanitize("a/b\\c").contains('\\'));
    }

    #[test]
    fn fingerprint_ignores_values_but_detects_label_changes() {
        let before = vec![source("show minimap", "true")];
        let value_changed = vec![source("show minimap", "false")];
        let label_changed = vec![source("show mini map", "true")];
        assert_eq!(fingerprint(&before), fingerprint(&value_changed));
        assert_ne!(fingerprint(&before), fingerprint(&label_changed));
    }

    #[test]
    fn overlay_applies_only_when_fingerprint_matches_and_revert_removes_it() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join(".test-tmp")
            .join(format!("ailabel-{}", uuid::Uuid::new_v4().simple()));
        let store = Store::load(root.join("data")).unwrap();
        let mod_id = "demo-mod";
        let original = vec![source("show minimap", "true")];
        write_overlay(&store, mod_id, &original);

        let mut current = vec![source("show minimap", "false")];
        assert!(apply_overlay(&store, mod_id, &mut current).is_none());
        assert_eq!(current[0].fields[0].label, "显示小地图");

        // 结构变化 → 只提示，不套用、不删文件、不自动重跑 AI。
        let mut stale = vec![source("show minimap v2", "true")];
        let warning = apply_overlay(&store, mod_id, &mut stale).expect("应给出过期提示");
        assert!(warning.contains("过期"));
        assert_eq!(stale[0].fields[0].label, "show minimap v2");
        assert!(path_for(&store, mod_id).exists());

        remove(&store, mod_id).unwrap();
        assert!(!path_for(&store, mod_id).exists());
        let _ = std::fs::remove_dir_all(&root);
    }
}
