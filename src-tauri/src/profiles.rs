//! 播放集（Profile）：把「启用哪些 Mod + 加载顺序」存成可切换的档。
//!
//! 关键约束：`installer::deploy_mod` / `undeploy_mod` 内部各自锁 `store.data`
//! 并持锁做磁盘 IO。本模块绝不能在自己持锁时调用它们 —— std::sync::Mutex
//! 不可重入，会当场死锁。所以切换流程被拆成「快照 → 撤销 → 短锁写入 → 部署」四段，
//! 每段之间都不持锁。

use std::collections::HashSet;
use std::path::PathBuf;

use crate::game;
use crate::installer;
use crate::schema::{
    AppStateData, CommandError, ProfileEntry, ProfileList, SwitchProfileReport,
};
use crate::store::Store;

/// 老状态文件里没有 profiles 时，按当前现状补一个 Default。
///
/// 只在 `Store::load` 里调用一次；有内容就原样返回，不动用户数据。
pub fn ensure_default_profile(data: &mut AppStateData) -> bool {
    if !data.profiles.is_empty() {
        return false;
    }
    let mut profile = ProfileEntry::default_profile();
    profile.enabled_mod_ids = data
        .mods
        .iter()
        .filter(|entry| entry.enabled)
        .map(|entry| entry.id.clone())
        .collect();
    profile.load_order = data.load_order.clone();
    data.active_profile_id = Some(profile.id.clone());
    data.profiles.push(profile);
    true
}

/// 把当前状态（启用集合 + 加载顺序）快照成播放集内容。
fn snapshot_into(profile: &mut ProfileEntry, data: &AppStateData) {
    profile.enabled_mod_ids = data
        .mods
        .iter()
        .filter(|entry| entry.enabled)
        .map(|entry| entry.id.clone())
        .collect();
    profile.load_order = data.load_order.clone();
    profile.updated_at = crate::store::now_iso();
}

fn list_of(data: &AppStateData) -> ProfileList {
    ProfileList {
        profiles: data.profiles.clone(),
        active_profile_id: data.active_profile_id.clone(),
    }
}

fn find_index(data: &AppStateData, profile_id: &str) -> Result<usize, CommandError> {
    data.profiles
        .iter()
        .position(|item| item.id == profile_id)
        .ok_or_else(|| CommandError::new("PROFILE_UNKNOWN", "找不到这个播放集，可能已被删除。"))
}

/// 切换播放集：撤销当前部署 → 写入目标状态 → 按新集合重新部署。
pub fn switch_profile(store: &Store, profile_id: &str) -> Result<SwitchProfileReport, CommandError> {
    // ── 阶段 0：只读快照，不持锁做判断 ────────────────────────────
    let snapshot = store.snapshot_data();

    let profile = snapshot
        .profiles
        .iter()
        .find(|item| item.id == profile_id)
        .cloned()
        .ok_or_else(|| CommandError::new("PROFILE_UNKNOWN", "找不到这个播放集，可能已被删除。"))?;

    if snapshot.active_profile_id.as_deref() == Some(profile_id) {
        return Err(CommandError::new(
            "PROFILE_ALREADY_ACTIVE",
            format!("「{}」已经是当前播放集了。", profile.name),
        ));
    }

    let game_root = snapshot
        .game_dir
        .clone()
        .map(PathBuf::from)
        .ok_or_else(|| CommandError::new("NO_GAME_DIR", "还没有绑定游戏目录，无法切换播放集。"))?;
    let game_info = game::validate_game_dir(&game_root)?;

    // 熔断：游戏版本变过就先拦住，避免把旧链接塞进新版本。
    let exe = game_root.join("bin").join("x64").join("Cyberpunk2077.exe");
    let current = game::file_version(&exe);
    if game::update_lock_active(snapshot.last_game_version.as_deref(), current.as_deref()) {
        return Err(CommandError::new(
            "GAME_UPDATE_LOCKED",
            format!(
                "游戏已从 {} 更新到 {}，先升级前置框架再解除锁定。",
                snapshot.last_game_version.as_deref().unwrap_or("未知"),
                current.as_deref().unwrap_or("未知")
            ),
        ));
    }

    let mut warnings: Vec<String> = Vec::new();

    // ── 阶段 1：撤销当前全部部署（库函数自己加锁，这里全程无锁）────
    let mut undeployed = 0usize;
    for entry in snapshot
        .mods
        .iter()
        .filter(|item| !item.deployed_files.is_empty())
    {
        match installer::undeploy_mod(store, &entry.id, &game_root) {
            Ok(_) => undeployed += 1,
            Err(err) => warnings.push(format!("{} 撤销失败：{}", entry.name, err.message)),
        }
    }

    // ── 阶段 2：短暂加锁写入目标状态，块结束立刻释放 ───────────────
    {
        let mut data = store
            .data
            .lock()
            .map_err(|_| CommandError::new("STATE_LOCK", "状态被占用，稍后再试。"))?;

        let wanted: HashSet<String> = profile.enabled_mod_ids.iter().cloned().collect();
        for entry in data.mods.iter_mut() {
            entry.enabled = wanted.contains(&entry.id);
            // 撤销后清单必须清空，否则 deploy_mod 会以为已部署而直接返回。
            entry.deployed_files.clear();
        }
        data.load_order = profile.load_order.clone();
        data.active_profile_id = Some(profile.id.clone());
        store.save(&data)?;
    } // ← 锁在这里释放，阶段 3 才能重新拿到

    // ── 阶段 3：按播放集顺序重新部署 ─────────────────────────────
    let mut deployed = 0usize;
    let known: HashSet<String> = snapshot.mods.iter().map(|item| item.id.clone()).collect();

    for mod_id in &profile.enabled_mod_ids {
        if !known.contains(mod_id) {
            warnings.push(format!("播放集里的 {mod_id} 已经不存在，已跳过。"));
            continue;
        }
        match installer::deploy_mod(store, mod_id, &game_info) {
            Ok(_) => deployed += 1,
            Err(err) => warnings.push(format!("{mod_id} 部署失败：{}", err.message)),
        }
    }

    // ── 阶段 4：部署失败的临时停用，避免留下半状态 ──────────────────
    {
        let mut data = store
            .data
            .lock()
            .map_err(|_| CommandError::new("STATE_LOCK", "状态被占用，稍后再试。"))?;
        let mut changed = false;
        for entry in data.mods.iter_mut() {
            if entry.enabled && entry.deployed_files.is_empty() {
                entry.enabled = false;
                changed = true;
                warnings.push(format!("{} 没能部署成功，已临时停用。", entry.name));
            }
        }
        if changed {
            store.save(&data)?;
        }
    }

    Ok(SwitchProfileReport {
        profile,
        undeployed,
        deployed,
        warnings,
    })
}

/// 把当前状态保存进某个播放集（不改部署，只改存档）。
pub fn save_profile_state(store: &Store, profile_id: &str) -> Result<ProfileList, CommandError> {
    let mut data = store
        .data
        .lock()
        .map_err(|_| CommandError::new("STATE_LOCK", "状态被占用，稍后再试。"))?;
    let index = find_index(&data, profile_id)?;
    let mut profile = data.profiles[index].clone();
    snapshot_into(&mut profile, &data);
    data.profiles[index] = profile;
    data.active_profile_id = Some(profile_id.to_string());
    store.save(&data)?;
    Ok(list_of(&data))
}

/// 新建播放集；`copy_current` 为真时用当前状态做初始内容。
pub fn create_profile(
    store: &Store,
    name: &str,
    copy_current: bool,
) -> Result<ProfileList, CommandError> {
    let name = name.trim();
    if name.is_empty() {
        return Err(CommandError::new("PROFILE_NAME_EMPTY", "播放集名字不能为空。"));
    }
    let mut data = store
        .data
        .lock()
        .map_err(|_| CommandError::new("STATE_LOCK", "状态被占用，稍后再试。"))?;
    if data.profiles.iter().any(|item| item.name == name) {
        return Err(CommandError::new(
            "PROFILE_NAME_TAKEN",
            format!("已经有叫「{name}」的播放集了。"),
        ));
    }
    let now = crate::store::now_iso();
    let mut profile = ProfileEntry {
        id: format!("profile-{}", uuid::Uuid::new_v4().simple()),
        name: name.to_string(),
        enabled_mod_ids: Vec::new(),
        load_order: Vec::new(),
        created_at: now.clone(),
        updated_at: now,
        builtin: false,
    };
    if copy_current {
        snapshot_into(&mut profile, &data);
    }
    data.profiles.push(profile);
    store.save(&data)?;
    Ok(list_of(&data))
}

/// 重命名。内置播放集不允许改名。
pub fn rename_profile(
    store: &Store,
    profile_id: &str,
    name: &str,
) -> Result<ProfileList, CommandError> {
    let name = name.trim();
    if name.is_empty() {
        return Err(CommandError::new("PROFILE_NAME_EMPTY", "播放集名字不能为空。"));
    }
    let mut data = store
        .data
        .lock()
        .map_err(|_| CommandError::new("STATE_LOCK", "状态被占用，稍后再试。"))?;
    let index = find_index(&data, profile_id)?;
    if data.profiles[index].builtin {
        return Err(CommandError::new(
            "PROFILE_BUILTIN",
            "内置的 Default 播放集不能改名。",
        ));
    }
    if data
        .profiles
        .iter()
        .any(|item| item.id != profile_id && item.name == name)
    {
        return Err(CommandError::new(
            "PROFILE_NAME_TAKEN",
            format!("已经有叫「{name}」的播放集了。"),
        ));
    }
    data.profiles[index].name = name.to_string();
    data.profiles[index].updated_at = crate::store::now_iso();
    store.save(&data)?;
    Ok(list_of(&data))
}

/// 删除。内置与「当前激活」的播放集都拒绝删除。
pub fn delete_profile(store: &Store, profile_id: &str) -> Result<ProfileList, CommandError> {
    let mut data = store
        .data
        .lock()
        .map_err(|_| CommandError::new("STATE_LOCK", "状态被占用，稍后再试。"))?;
    let index = find_index(&data, profile_id)?;
    if data.profiles[index].builtin {
        return Err(CommandError::new(
            "PROFILE_BUILTIN",
            "内置的 Default 播放集不能删除。",
        ));
    }
    if data.active_profile_id.as_deref() == Some(profile_id) {
        return Err(CommandError::new(
            "PROFILE_ACTIVE",
            "正在使用的播放集不能删除，先切到别的播放集。",
        ));
    }
    data.profiles.remove(index);
    store.save(&data)?;
    Ok(list_of(&data))
}

/// 复制一个播放集（内容深拷贝，名字必须唯一）。
pub fn duplicate_profile(
    store: &Store,
    profile_id: &str,
    name: &str,
) -> Result<ProfileList, CommandError> {
    let name = name.trim();
    if name.is_empty() {
        return Err(CommandError::new("PROFILE_NAME_EMPTY", "播放集名字不能为空。"));
    }
    let mut data = store
        .data
        .lock()
        .map_err(|_| CommandError::new("STATE_LOCK", "状态被占用，稍后再试。"))?;
    let index = find_index(&data, profile_id)?;
    if data.profiles.iter().any(|item| item.name == name) {
        return Err(CommandError::new(
            "PROFILE_NAME_TAKEN",
            format!("已经有叫「{name}」的播放集了。"),
        ));
    }
    let source = data.profiles[index].clone();
    let now = crate::store::now_iso();
    data.profiles.push(ProfileEntry {
        id: format!("profile-{}", uuid::Uuid::new_v4().simple()),
        name: name.to_string(),
        enabled_mod_ids: source.enabled_mod_ids,
        load_order: source.load_order,
        created_at: now.clone(),
        updated_at: now,
        builtin: false,
    });
    store.save(&data)?;
    Ok(list_of(&data))
}

/// 只读：当前播放集列表。
pub fn list_profiles(store: &Store) -> Result<ProfileList, CommandError> {
    let data = store
        .data
        .lock()
        .map_err(|_| CommandError::new("STATE_LOCK", "状态被占用，稍后再试。"))?;
    Ok(list_of(&data))
}

// ── modlist 导入导出（看板【mod 列表及切换功能】）────────────────────
//
// 导出 = 把播放集连同已启用模组的元数据快照写成一个 JSON 文件（落
// `<data_dir>/exports/`，与词表导出同一落点、同一套「不用另存为对话框」
// 的权限取舍）。导入 = 按 id 优先、名字兜底把文件里的模组对回当前库，
// 对得上的进新播放集；对不上的如实报告，绝不静默丢弃。

/// 导出文件自带 kind/version 签名：导入时校验，防止拿错文件（比如把词表包
/// 当成播放集导进来）。
pub const PROFILE_EXPORT_KIND: &str = "cyberdeck-profile";
pub const PROFILE_EXPORT_VERSION: u32 = 1;

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportedMod {
    id: String,
    name: String,
    category: String,
    version: Option<String>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ProfileExportFile {
    kind: String,
    version: u32,
    exported_at: String,
    profile: ProfileExportPayload,
    mods: Vec<ExportedMod>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ProfileExportPayload {
    name: String,
    enabled_mod_ids: Vec<String>,
    load_order: Vec<String>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProfileImportFile {
    kind: String,
    version: u32,
    profile: ProfileImportPayload,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProfileImportPayload {
    name: String,
    #[serde(default)]
    enabled_mod_ids: Vec<String>,
}

/// 导入结果：对上了多少、哪些没对上。unmatched 非空不是错误——
/// 跨机器分享本来就不可能全对上，如实展示让用户自己决定。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileImportReport {
    pub profile_name: String,
    pub matched: usize,
    pub unmatched: Vec<String>,
    pub list: ProfileList,
}

/// 把播放集名转成安全的文件名片段：Windows 保留字符与控制字符换成下划线。
/// 中文、空格、全角都保留——这是给用户看的文件名，不是路径键。
fn safe_filename(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| {
            if matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|')
                || (c as u32) < 0x20
            {
                '_'
            } else {
                c
            }
        })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.').to_string();
    if trimmed.is_empty() {
        "profile".to_string()
    } else {
        trimmed
    }
}

/// 导出播放集为 JSON 文件，返回落盘绝对路径。
pub fn export_modlist(store: &Store, profile_id: &str) -> Result<String, CommandError> {
    let snapshot = store.snapshot_data();
    let profile = snapshot
        .profiles
        .iter()
        .find(|item| item.id == profile_id)
        .cloned()
        .ok_or_else(|| CommandError::new("PROFILE_UNKNOWN", "找不到这个播放集，可能已被删除。"))?;

    let by_id: std::collections::HashMap<&str, &crate::schema::ModEntry> = snapshot
        .mods
        .iter()
        .map(|entry| (entry.id.as_str(), entry))
        .collect();
    let mods: Vec<ExportedMod> = profile
        .enabled_mod_ids
        .iter()
        .filter_map(|id| by_id.get(id.as_str()))
        .map(|entry| ExportedMod {
            id: entry.id.clone(),
            name: entry.name.clone(),
            category: entry.category.clone(),
            version: entry.version.clone(),
        })
        .collect();

    let file = ProfileExportFile {
        kind: PROFILE_EXPORT_KIND.to_string(),
        version: PROFILE_EXPORT_VERSION,
        exported_at: crate::store::now_iso(),
        profile: ProfileExportPayload {
            name: profile.name.clone(),
            enabled_mod_ids: profile.enabled_mod_ids.clone(),
            load_order: profile.load_order.clone(),
        },
        mods,
    };
    let json = serde_json::to_string_pretty(&file)
        .map_err(|e| CommandError::new("PROFILE_EXPORT", format!("序列化失败：{e}")))?;

    let dir = store.data_dir.join("exports");
    std::fs::create_dir_all(&dir)
        .map_err(|e| CommandError::new("PROFILE_EXPORT", format!("无法创建导出目录：{e}")))?;
    let path = dir.join(format!(
        "播放集-{}-{}.json",
        safe_filename(&profile.name),
        crate::store::now_stamp()
    ));
    std::fs::write(&path, json)
        .map_err(|e| CommandError::new("PROFILE_EXPORT", format!("无法写入文件：{e}")))?;
    Ok(path.to_string_lossy().to_string())
}

/// 从 JSON 文件导入播放集。匹配策略：先按模组 id 精确对（同机往返），再按
/// 名字兜底（跨机器分享）；`name` 覆盖文件里的播放集名（重名时上层报错）。
pub fn import_modlist(
    store: &Store,
    path: &str,
    name: Option<&str>,
) -> Result<ProfileImportReport, CommandError> {
    let raw = std::fs::read_to_string(path.trim())
        .map_err(|e| CommandError::new("PROFILE_IMPORT", format!("无法读取文件：{e}")))?;
    let file: ProfileImportFile = serde_json::from_str(&raw).map_err(|e| {
        CommandError::new(
            "PROFILE_BAD_FILE",
            format!("不是有效的播放集导出文件：{e}"),
        )
    })?;
    if file.kind != PROFILE_EXPORT_KIND || file.version != PROFILE_EXPORT_VERSION {
        return Err(CommandError::new(
            "PROFILE_BAD_FILE",
            format!(
                "文件签名不匹配（kind={} version={}，期望 {} v{}）。",
                file.kind, file.version, PROFILE_EXPORT_KIND, PROFILE_EXPORT_VERSION
            ),
        ));
    }

    // 匹配全程只读快照，不持锁。
    let snapshot = store.snapshot_data();
    let by_id: std::collections::HashMap<&str, &crate::schema::ModEntry> = snapshot
        .mods
        .iter()
        .map(|entry| (entry.id.as_str(), entry))
        .collect();
    let by_name: std::collections::HashMap<&str, &crate::schema::ModEntry> = snapshot
        .mods
        .iter()
        .map(|entry| (entry.name.as_str(), entry))
        .collect();

    let mut matched_ids: Vec<String> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut unmatched: Vec<String> = Vec::new();
    for id in &file.profile.enabled_mod_ids {
        let hit = by_id
            .get(id.as_str())
            .or_else(|| by_name.get(id.as_str()));
        match hit {
            Some(entry) => {
                if seen.insert(entry.id.clone()) {
                    matched_ids.push(entry.id.clone());
                }
            }
            None => unmatched.push(id.clone()),
        }
    }
    if matched_ids.is_empty() {
        return Err(CommandError::new(
            "PROFILE_NO_MATCH",
            "文件里的模组一个都对不上当前模组库（先导入这些模组再来导入播放集）。",
        ));
    }

    let profile_name = name
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(file.profile.name.trim())
        .to_string();
    create_profile(store, &profile_name, false)?;

    // create_profile 返回的是全量列表，从里面按名字找回新 id（名字刚查过重，必唯一）。
    let list = list_profiles(store)?;
    let new_id = list
        .profiles
        .iter()
        .find(|item| item.name == profile_name)
        .map(|item| item.id.clone())
        .ok_or_else(|| CommandError::new("PROFILE_IMPORT", "新建播放集后找不到它了。"))?;

    let matched_count = matched_ids.len();
    {
        let mut data = store
            .data
            .lock()
            .map_err(|_| CommandError::new("STATE_LOCK", "状态被占用，稍后再试。"))?;
        if let Some(entry) = data.profiles.iter_mut().find(|item| item.id == new_id) {
            entry.enabled_mod_ids = matched_ids;
            entry.updated_at = crate::store::now_iso();
        }
        store.save(&data)?;
    }

    Ok(ProfileImportReport {
        profile_name,
        matched: matched_count,
        unmatched,
        list,
    })
}

#[cfg(test)]
mod import_export_tests {
    use super::safe_filename;

    #[test]
    fn windows_reserved_chars_replaced() {
        assert_eq!(safe_filename("a<b>:c/d"), "a_b__c_d");
        assert_eq!(safe_filename("正常名字"), "正常名字");
        assert_eq!(safe_filename("  spaced  "), "spaced");
        assert_eq!(safe_filename("..."), "profile");
        assert_eq!(safe_filename(""), "profile");
    }
}
