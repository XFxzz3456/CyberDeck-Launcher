//! 从 Vortex 的本地数据库导入模组元数据（A 方案）。
//!
//! Vortex 把每个模组存在 LevelDB（`%APPDATA%\Vortex\state.v2`）里，键形如
//! `persistent###mods###cyberpunk2077###<模组名-编号-...>###attributes###modId`，
//! 值里带着 Nexus 的 modId / 作者 / 版本 / 封面。
//!
//! 收编进来的模组名字是被部署后的文件名（`! hotscenes_add_on`），我们已经丢了
//! Nexus 编号，所以这里用「名称归一化后互相包含」来配对。命中率天然有限——
//! 认不出的部分交给粘贴链接（B 方案）或手动编辑（C 方案）。
//!
//! Vortex 运行时会对数据库加文件锁，此时读取会失败，需要先关掉 Vortex。

use crate::schema::{AppResult, CommandError, ModEntry};
use crate::store::Store;
use rusty_leveldb::{DB, LdbIterator, Options};
use std::path::PathBuf;

const PREFIX: &str = "persistent###mods###cyberpunk2077###";

fn vortex_state_dir() -> Option<PathBuf> {
    let roaming = std::env::var_os("APPDATA")?;
    let dir = PathBuf::from(roaming).join("Vortex").join("state.v2");
    dir.is_dir().then_some(dir)
}

/// 归一化：小写、去括号内容、符号转空格，只留字母数字和中文。
fn normalize(text: &str) -> String {
    let lowered = text.to_lowercase();
    let mut out = String::with_capacity(lowered.len());
    let mut depth = 0i32;
    let mut pending_space = false;
    for ch in lowered.chars() {
        match ch {
            '(' | '[' => {
                depth += 1;
                continue;
            }
            ')' | ']' => {
                depth = (depth - 1).max(0);
                continue;
            }
            _ => {}
        }
        if depth > 0 {
            continue;
        }
        if ch.is_alphanumeric() {
            if pending_space && !out.is_empty() {
                out.push(' ');
            }
            pending_space = false;
            out.push(ch);
        } else {
            pending_space = true;
        }
    }
    out.trim().to_string()
}

struct VortexMod {
    mod_id: u64,
    file_id: Option<u64>,
    name: String,
    author: String,
    version: String,
    picture_url: Option<String>,
    /// 可用于配对的候选名（原始名 / 逻辑文件名 / 自定义名）
    candidates: Vec<String>,
}

pub fn import(store: &Store) -> AppResult<String> {
    let dir = vortex_state_dir().ok_or_else(|| {
        CommandError::new(
            "VORTEX_NOT_FOUND",
            "没找到 Vortex 的数据目录（%APPDATA%\\Vortex\\state.v2）。",
        )
    })?;

    let mut options = Options::default();
    options.create_if_missing = false;
    let mut db = DB::open(&dir, options).map_err(|err| {
        CommandError::new(
            "VORTEX_DB_LOCKED",
            format!("读取 Vortex 数据库失败（{err}）。请先完全退出 Vortex 再试。"),
        )
    })?;

    // 收集：同一模组的多个字段合成一条记录
    let mut mods: Vec<VortexMod> = Vec::new();
    let mut index: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    let mut iter = db.new_iter().map_err(|err| {
        CommandError::new("VORTEX_DB_READ", format!("遍历 Vortex 数据库失败：{err}"))
    })?;
    iter.seek_to_first();
    while let Some((key, value)) = iter.next() {
        let Ok(key_text) = String::from_utf8(key) else {
            continue;
        };
        let Some(rest) = key_text.strip_prefix(PREFIX) else {
            continue;
        };
        let Some((mod_key, field)) = rest.split_once("###") else {
            continue;
        };
        let Ok(value_text) = String::from_utf8(value) else {
            continue;
        };
        let value_text = value_text.trim_matches('"').to_string();

        let slot = *index.entry(mod_key.to_string()).or_insert_with(|| {
            mods.push(VortexMod {
                mod_id: 0,
                file_id: None,
                name: String::new(),
                author: String::new(),
                version: String::new(),
                picture_url: None,
                candidates: Vec::new(),
            });
            mods.len() - 1
        });
        let item = &mut mods[slot];
        match field {
            "attributes###modId" => item.mod_id = value_text.parse().unwrap_or(0),
            "attributes###fileId" => item.file_id = value_text.parse().ok(),
            "attributes###modName" | "attributes###originalName" => {
                if item.name.is_empty() {
                    item.name = value_text.clone();
                }
                item.candidates.push(value_text);
            }
            "attributes###logicalFileName" | "attributes###customFileName"
            | "attributes###name" => item.candidates.push(value_text),
            "attributes###author" => item.author = value_text,
            "attributes###version" | "attributes###newestVersion" => {
                if item.version.is_empty() {
                    item.version = value_text;
                }
            }
            "attributes###pictureUrl" => item.picture_url = Some(value_text),
            _ => {}
        }
    }
    drop(iter);

    let candidates: Vec<(String, usize)> = mods
        .iter()
        .enumerate()
        .filter(|(_, m)| m.mod_id > 0)
        .flat_map(|(idx, m)| {
            m.candidates
                .iter()
                .map(move |c| (normalize(c), idx))
                .filter(|(c, _)| c.len() >= 4)
        })
        .collect();

    let mut data = store.data.lock().expect("state mutex poisoned");
    let mut applied = 0usize;
    for entry in data.mods.iter_mut() {
        if entry.nexus.is_some() || entry.metadata_source == "manual" {
            continue;
        }
        let target = normalize(&entry.name);
        if target.len() < 4 {
            continue;
        }
        let hit = candidates
            .iter()
            .find(|(candidate, _)| *candidate == target)
            .or_else(|| {
                candidates.iter().find(|(candidate, _)| {
                    (candidate.contains(&target) || target.contains(candidate))
                        && candidate.len().min(target.len()) >= 6
                })
            });
        let Some((_, idx)) = hit else { continue };
        let source = &mods[*idx];
        apply(entry, source);
        applied += 1;
    }
    store.save(&data)?;

    Ok(format!(
        "从 Vortex 读到 {} 个模组记录，匹配并补全了 {applied} 个；其余 {} 个建议用「粘贴 Nexus 链接」补。",
        mods.len(),
        data.mods.len().saturating_sub(applied)
    ))
}

fn apply(entry: &mut ModEntry, source: &VortexMod) {
    if !source.name.trim().is_empty() {
        entry.name = source.name.clone();
    }
    if !source.author.trim().is_empty() {
        entry.author = Some(source.author.clone());
    }
    if !source.version.trim().is_empty() {
        entry.version = Some(source.version.clone());
    }
    entry.nexus = Some(crate::schema::NexusRef {
        mod_id: source.mod_id,
        file_id: source.file_id,
        url: format!(
            "https://www.nexusmods.com/cyberpunk2077/mods/{}",
            source.mod_id
        ),
        version: entry.version.clone(),
        picture_url: source.picture_url.clone(),
    });
    if entry
        .nexus_cover_url
        .as_deref()
        .is_none_or(|value| value.trim().is_empty())
    {
        entry.nexus_cover_url = source.picture_url.clone();
    }
    entry.metadata_source = "vortex".to_string();
    entry.updated_at = Some(crate::store::now_iso());
}
