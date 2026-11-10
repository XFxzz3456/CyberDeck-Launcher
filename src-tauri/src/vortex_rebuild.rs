//! 以 Vortex 为准重建模组库（接管方案 P4）。
//!
//! 背景：启动器库里的 84 条 `adopted` 是从游戏 `archive/pc/mod` 收编的散装
//! archive，而玩家真正在用的是 Vortex 存储根里的 225 个安装目录。两批数据的
//! 文件名交集只有 13 个，靠「配准算法」永远补不齐，只能换权威来源。
//!
//! 硬约束（用户数据，一条都不能破）：
//! - **只归档不删除**：旧条目整份移进 `AppStateData.archived_mods`，可一键还原。
//! - **写前整库备份**：执行前把 `launcher-state.json` 原字节复制到带时间戳的目录。
//! - **不动游戏目录**：Vortex 条目不登记 `deployed_files`，启动器不会去删 Vortex
//!   部署的硬链接；启用 / 禁用只改本地标记 + 镜像 Vortex 状态库。
//! - **预览先行**：`preview` 纯只读，前端必须先展示计划、用户确认后才调 `apply`。
//! - 数据来源可追溯：磁盘目录是权威清单，元数据来自 Vortex 自己的完整状态快照，
//!   启用态优先读实时 `state.v2`，读不到才降级到快照并记 warning。

use crate::schema::{
    AppResult, AppStateData, CommandError, ModEntry, NexusRef, VortexRebuildItem,
    VortexRebuildPreview, VortexRebuildReport,
};
use crate::store::Store;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

const GAME_ID: &str = "cyberpunk2077";
const ORIGIN: &str = "vortex";

fn now_iso() -> String {
    crate::store::now_iso()
}

fn stamp() -> String {
    // 精确到秒仍可能撞名（同一秒连点两次），加一段短随机串保证备份不被覆盖。
    let suffix = &uuid::Uuid::new_v4().simple().to_string()[..6];
    format!("{}-{suffix}", crate::store::now_stamp())
}

/// 稳定 id：目录名是 Vortex 的永久身份，哈希后不与既有 `adopt-xxx` 冲突。
fn fnv1a64(text: &str) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in text.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x100_0000_01b3);
    }
    hash
}

fn mod_id(dir_name: &str) -> String {
    format!("vx-{:016x}", fnv1a64(dir_name))
}

/// Vortex 的 attributes 里同一个字段可能是字符串也可能是数字（category/modId…）。
fn scalar(value: Option<&Value>) -> Option<String> {
    let text = match value? {
        Value::String(raw) => raw.trim().to_string(),
        Value::Number(num) => num.to_string(),
        Value::Bool(flag) => flag.to_string(),
        _ => return None,
    };
    (!text.is_empty() && text != "0").then_some(text)
}

fn plain(value: Option<&Value>) -> Option<String> {
    let text = value?.as_str()?.trim();
    (!text.is_empty()).then(|| text.to_string())
}

fn parse_u64(value: Option<&Value>) -> Option<u64> {
    scalar(value)?.parse::<u64>().ok()
}

/// Vortex 的 description 是 Nexus 的 HTML 摘要，直接塞进卡片会满屏 `<br />`。
fn strip_html(raw: &str) -> String {
    let mut out = String::new();
    let mut in_tag = false;
    for ch in raw.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => {
                in_tag = false;
                out.push(' ');
            }
            _ if !in_tag => out.push(ch),
            _ => {}
        }
    }
    let text = out
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&hellip;", "…");
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn truncate(text: &str, max: usize) -> String {
    let mut out: String = text.chars().take(max).collect();
    if text.chars().count() > max {
        out.push('…');
    }
    out
}

/// 从 Vortex attributes 里读出来的完整元数据（内部用，预览只暴露摘要）。
#[derive(Debug, Clone, Default)]
pub struct VortexMeta {
    pub description: String,
    pub category: String,
    pub file_type: Option<String>,
    pub nexus_mod_id: Option<u64>,
    pub nexus_file_id: Option<u64>,
    pub picture_url: Option<String>,
    pub homepage: Option<String>,
    pub install_time: Option<String>,
    pub newest_version: Option<String>,
    pub uploader: Option<String>,
    pub fields: usize,
}

fn read_meta(attrs: Option<&serde_json::Map<String, Value>>, name: &str, folder: &str, paths: &[String]) -> VortexMeta {
    let Some(attrs) = attrs else {
        return VortexMeta {
            category: crate::category::UNCATEGORIZED.to_string(),
            ..Default::default()
        };
    };
    let get = |key: &str| attrs.get(key);
    let description = plain(get("description"))
        .or_else(|| plain(get("shortDescription")))
        .map(|raw| strip_html(&raw))
        .unwrap_or_default();
    let file_type = plain(get("fileType"));
    let nexus_mod_id = parse_u64(get("modId"));
    let nexus_file_id = parse_u64(get("fileId"));
    let picture_url = plain(get("pictureUrl"));
    let homepage = plain(get("homepage")).or_else(|| {
        nexus_mod_id.map(|id| format!("https://www.nexusmods.com/cyberpunk2077/mods/{id}"))
    });
    let install_time = plain(get("installTime"));
    let newest_version = plain(get("newestVersion"));
    let uploader = plain(get("uploader"));
    let category_raw = scalar(get("category"));
    let category = category_raw
        .as_deref()
        .and_then(crate::category::from_nexus_id)
        .map(str::to_string)
        .unwrap_or_else(|| {
            let signals = crate::category::Signals {
                name,
                folder,
                layout: &crate::schema::InstallLayout::GameRoot,
                paths,
            };
            crate::category::infer_with_nexus(&signals, file_type.as_deref())
        });
    let fields = [
        description.as_str(),
        file_type.as_deref().unwrap_or(""),
        picture_url.as_deref().unwrap_or(""),
        homepage.as_deref().unwrap_or(""),
        install_time.as_deref().unwrap_or(""),
        newest_version.as_deref().unwrap_or(""),
        uploader.as_deref().unwrap_or(""),
    ]
    .iter()
    .filter(|value| !value.is_empty())
    .count()
        + usize::from(nexus_mod_id.is_some())
        + usize::from(nexus_file_id.is_some())
        + usize::from(category_raw.is_some());
    VortexMeta {
        description,
        category,
        file_type,
        nexus_mod_id,
        nexus_file_id,
        picture_url,
        homepage,
        install_time,
        newest_version,
        uploader,
        fields,
    }
}

fn backup_json_path() -> Option<PathBuf> {
    let appdata = std::env::var_os("APPDATA")?;
    let path = PathBuf::from(appdata)
        .join("Vortex")
        .join("temp")
        .join("state_backups_full")
        .join("hourly.json");
    path.is_file().then_some(path)
}

fn file_mtime(path: &Path) -> String {
    let Ok(meta) = fs::metadata(path) else {
        return "未知".to_string();
    };
    let Ok(time) = meta.modified() else {
        return "未知".to_string();
    };
    let secs = time
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    chrono::DateTime::from_timestamp(secs, 0)
        .map(|dt| dt.format("%Y-%m-%d %H:%M UTC").to_string())
        .unwrap_or_else(|| "未知".to_string())
}

/// 目录内全部文件的游戏相对路径（POSIX 分隔符），已排序。
fn rel_files(dir: &Path) -> Vec<String> {
    let mut out = Vec::new();
    let Ok(entries) = walk(dir) else { return out };
    for path in entries {
        if let Ok(rel) = path.strip_prefix(dir) {
            let text = rel
                .components()
                .map(|part| part.as_os_str().to_string_lossy().to_string())
                .collect::<Vec<_>>()
                .join("/");
            if !text.is_empty() {
                out.push(text);
            }
        }
    }
    out.sort();
    out
}

/// 不引入 walkdir：Vortex 目录层级浅但有上千文件，手写遍历只跟目录，够用且好测。
fn walk(dir: &Path) -> std::io::Result<Vec<PathBuf>> {
    let mut out = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(current) = stack.pop() {
        for entry in fs::read_dir(&current)? {
            let path = entry?.path();
            if path.is_dir() {
                stack.push(path);
            } else {
                out.push(path);
            }
        }
    }
    Ok(out)
}

fn is_archive(rel: &str) -> bool {
    rel.to_ascii_lowercase().starts_with("archive/pc/mod/")
        && rel.to_ascii_lowercase().ends_with(".archive")
}

fn total_size(paths: &[(PathBuf, String)]) -> u64 {
    paths
        .iter()
        .filter_map(|(abs, _)| fs::metadata(abs).ok())
        .map(|meta| meta.len())
        .sum()
}

/// 完整目录信息（内部用；`VortexRebuildItem` 只暴露摘要给前端）。
#[derive(Debug, Clone)]
pub struct CatalogEntry {
    pub item: VortexRebuildItem,
    pub dir: PathBuf,
    pub paths: Vec<String>,
    pub meta: VortexMeta,
}

#[derive(Debug, Default, Clone)]
pub struct Catalog {
    pub root: PathBuf,
    pub entries: Vec<CatalogEntry>,
    pub archive_names: HashSet<String>,
    pub sources: Vec<String>,
    pub warnings: Vec<String>,
    pub uncovered_archives: Vec<String>,
}

/// 从 hourly.json 里取活动 profile 的 modState 与 mods 元数据。
fn snapshot_parts(meta: &Value) -> (String, HashMap<String, bool>, HashMap<String, Value>) {
    let pid = meta
        .get("settings")
        .and_then(|v| v.get("profiles"))
        .and_then(|v| v.get("activeProfileId"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let mut states = HashMap::new();
    if !pid.is_empty() {
        if let Some(map) = meta
            .get("persistent")
            .and_then(|v| v.get("profiles"))
            .and_then(|v| v.get(&pid))
            .and_then(|v| v.get("modState"))
            .and_then(Value::as_object)
        {
            for (key, value) in map {
                let enabled = value
                    .get("enabled")
                    .and_then(Value::as_bool)
                    .unwrap_or(true);
                states.insert(key.clone(), enabled);
            }
        }
    }
    let mods = meta
        .get("persistent")
        .and_then(|v| v.get("mods"))
        .and_then(|v| v.get(GAME_ID))
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .collect::<HashMap<_, _>>();
    (pid, states, mods)
}

/// 实时 state.v2 的启用态（优先级高于快照）。Vortex 运行时 DB 锁住 → 返回 None。
fn live_states(pairs: Option<&[(String, String)]>) -> Option<(String, HashMap<String, bool>)> {
    let pairs = pairs?;
    let parsed = crate::vortex_mirror::parse_pairs(pairs);
    let pid = parsed.active_profile_id.clone();
    if pid.is_empty() {
        return None;
    }
    let states = parsed.mod_states.get(&pid).cloned().unwrap_or_default();
    Some((pid, states))
}

/// 纯函数：三份只读来源合成权威目录清单。单测直接传临时目录与构造的 JSON。
pub fn build_catalog(
    root: &Path,
    meta_path: Option<&Path>,
    pairs: Option<&[(String, String)]>,
    game_root: Option<&Path>,
) -> Catalog {
    let mut catalog = Catalog {
        root: root.to_path_buf(),
        ..Default::default()
    };
    if !root.is_dir() {
        catalog
            .warnings
            .push(format!("Vortex mod 存储根不存在：{}", root.display()));
        return catalog;
    }

    let meta: Option<Value> = meta_path
        .and_then(|path| fs::read_to_string(path).ok())
        .and_then(|raw| serde_json::from_str(&raw).ok());
    let (snapshot_pid, snapshot_states, meta_mods) =
        meta.as_ref().map(snapshot_parts).unwrap_or_default();

    let live = live_states(pairs);
    let (pid, states, state_source) = match live {
        Some((pid, states)) if !states.is_empty() => (
            pid,
            states,
            "state.v2 实时读取（Vortex 已退出）".to_string(),
        ),
        _ => (
            snapshot_pid.clone(),
            snapshot_states.clone(),
            "hourly.json 状态快照（state.v2 不可读或正在被 Vortex 占用）".to_string(),
        ),
    };
    if pid.is_empty() {
        catalog
            .warnings
            .push("拿不到 Vortex 活动 profile，启用状态全部按「启用」处理。".to_string());
    }

    catalog.sources.push(format!(
        "权威清单：{} 的磁盘安装目录",
        root.display()
    ));
    if let Some(path) = meta_path {
        catalog.sources.push(format!(
            "元数据：{}（快照时间 {}）{}",
            path.display(),
            file_mtime(path),
            if meta_mods.is_empty() {
                "〔解析失败，降级用目录名〕"
            } else {
                ""
            }
        ));
    } else {
        catalog
            .warnings
            .push("没找到 Vortex 的完整状态快照，名称/版本/作者降级为目录名。".to_string());
    }
    catalog.sources.push(format!("启用态：{state_source}（profile {pid}）"));

    let mut dirs = Vec::new();
    if let Ok(read) = fs::read_dir(root) {
        for entry in read.flatten() {
            if entry.path().is_dir() && !entry.file_name().to_string_lossy().starts_with('.') {
                dirs.push((
                    entry.file_name().to_string_lossy().to_string(),
                    entry.path(),
                ));
            }
        }
    }
    dirs.sort_by(|a, b| a.0.cmp(&b.0));

    let mut missing_state = 0usize;
    for (dir_name, dir) in dirs {
        let paths = rel_files(&dir);
        let abs = paths
            .iter()
            .map(|rel| (dir.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR)), rel.clone()))
            .collect::<Vec<_>>();
        let size = total_size(&abs);
        for rel in &paths {
            if is_archive(rel) {
                if let Some(name) = rel.rsplit('/').next() {
                    catalog.archive_names.insert(name.to_ascii_lowercase());
                }
            }
        }

        let attrs = meta_mods
            .get(&dir_name)
            .and_then(|v| v.get("attributes"))
            .and_then(Value::as_object);
        let name = attrs
            .and_then(|a| plain(a.get("customFileName")))
            .or_else(|| attrs.and_then(|a| plain(a.get("modName"))))
            .or_else(|| attrs.and_then(|a| plain(a.get("logicalFileName"))))
            .or_else(|| attrs.and_then(|a| plain(a.get("name"))))
            .unwrap_or_else(|| dir_name.clone());
        let version = attrs
            .and_then(|a| plain(a.get("version")))
            .or_else(|| attrs.and_then(|a| plain(a.get("modVersion"))));
        let author = attrs
            .and_then(|a| plain(a.get("author")))
            .or_else(|| attrs.and_then(|a| plain(a.get("uploader"))));
        let metadata_source = if attrs.is_some() {
            "vortexJson"
        } else {
            "directory"
        };
        let vortex_meta = read_meta(attrs, &name, &dir_name, &paths);

        let enabled = match states.get(&dir_name) {
            Some(value) => *value,
            None => {
                missing_state += 1;
                true
            }
        };

        catalog.entries.push(CatalogEntry {
            item: VortexRebuildItem {
                dir_name: dir_name.clone(),
                name,
                version,
                author,
                description: truncate(&vortex_meta.description, 240),
                category: vortex_meta.category.clone(),
                file_type: vortex_meta.file_type.clone(),
                nexus_mod_id: vortex_meta.nexus_mod_id,
                nexus_file_id: vortex_meta.nexus_file_id,
                picture_url: vortex_meta.picture_url.clone(),
                homepage: vortex_meta.homepage.clone(),
                install_time: vortex_meta.install_time.clone(),
                newest_version: vortex_meta.newest_version.clone(),
                metadata_fields: vortex_meta.fields,
                enabled,
                file_count: paths.len(),
                size_bytes: size,
                metadata_source: metadata_source.to_string(),
                sample_paths: paths.iter().take(3).cloned().collect(),
            },
            dir,
            paths,
            meta: vortex_meta,
        });
    }

    if missing_state > 0 {
        catalog.warnings.push(format!(
            "{missing_state} 个目录在 Vortex 状态库里没有启用记录，按「启用」处理；可在 Vortex 里核对后再对账。"
        ));
    }
    if catalog.entries.is_empty() {
        catalog
            .warnings
            .push("Vortex 存储根里一个安装目录都没有，拒绝重建。".to_string());
    }

    // 游戏目录里有、Vortex 根里没有的 archive：重建后不会被接管，但也不会被删。
    if let Some(game) = game_root {
        let mod_dir = game.join("archive").join("pc").join("mod");
        if mod_dir.is_dir() {
            let mut found = Vec::new();
            if let Ok(read) = fs::read_dir(&mod_dir) {
                for entry in read.flatten() {
                    let path = entry.path();
                    if !path.is_file() {
                        continue;
                    }
                    let name = entry.file_name().to_string_lossy().to_string();
                    if name.to_ascii_lowercase().ends_with(".archive")
                        && !catalog.archive_names.contains(&name.to_ascii_lowercase())
                    {
                        found.push(name);
                    }
                }
            }
            found.sort();
            catalog.uncovered_archives = found;
        }
    }
    catalog
}

/// 纯函数：把目录清单变成界面能看的计划（只读，不碰 state）。
pub fn plan_from_catalog(store: &Store, catalog: &Catalog) -> VortexRebuildPreview {
    let data = store.snapshot_data();
    let existing: HashSet<String> = data.mods.iter().map(|m| m.id.clone()).collect();
    let will_add = catalog
        .entries
        .iter()
        .filter(|entry| !existing.contains(&mod_id(&entry.item.dir_name)))
        .count();
    let same_origin = data.mods.iter().filter(|m| m.origin == ORIGIN).count();
    let to_archive = data.mods.len() - same_origin;
    let mut preview = VortexRebuildPreview {
        available: !catalog.entries.is_empty(),
        reason: if catalog.entries.is_empty() {
            "Vortex 存储根里没有可重建的安装目录。".to_string()
        } else {
            String::new()
        },
        data_dir: store.data_dir.to_string_lossy().to_string(),
        vortex_root: catalog.root.to_string_lossy().to_string(),
        vortex_dirs: catalog.entries.len(),
        current_mods: data.mods.len(),
        already_archived: data.archived_mods.len(),
        to_add: catalog.entries.len(),
        to_archive,
        enabled_count: catalog.entries.iter().filter(|e| e.item.enabled).count(),
        disabled_count: catalog.entries.iter().filter(|e| !e.item.enabled).count(),
        with_description: catalog
            .entries
            .iter()
            .filter(|e| !e.meta.description.is_empty())
            .count(),
        with_picture: catalog
            .entries
            .iter()
            .filter(|e| e.meta.picture_url.is_some())
            .count(),
        with_nexus: catalog
            .entries
            .iter()
            .filter(|e| e.meta.nexus_mod_id.is_some())
            .count(),
        metadata_complete: catalog
            .entries
            .iter()
            .filter(|e| e.meta.fields >= 8)
            .count(),
        mapping_coverage: format!("{0}/{0}", catalog.entries.len()),
        uncovered_archives: catalog.uncovered_archives.clone(),
        data_sources: catalog.sources.clone(),
        items: catalog.entries.iter().map(|e| e.item.clone()).collect(),
        warnings: catalog.warnings.clone(),
    };
    if will_add == 0 && !data.mods.is_empty() {
        preview
            .warnings
            .push("这些 Vortex 目录看起来已经重建过；再次执行会先归档再重建，结果相同。".to_string());
    }
    if to_archive > 0 {
        preview.warnings.push(format!(
            "现有 {to_archive} 条非 Vortex 模组会移入归档（不删除、可还原），主列表改为 Vortex 的 {} 条。",
            catalog.entries.len()
        ));
    }
    if !preview.uncovered_archives.is_empty() {
        preview.warnings.push(format!(
            "游戏目录里有 {} 个 archive 不在 Vortex 存储根中，重建后不会被接管；文件不会被删除，需要的话请重新收编。",
            preview.uncovered_archives.len()
        ));
    }
    preview.warnings.push(
        "物理部署仍由 Vortex 负责：启动器只镜像启用状态与加载顺序，不会增删游戏目录里的文件。"
            .to_string(),
    );
    preview.warnings.push(
        "执行前会整库备份 launcher-state.json，设置页可一键还原到重建前。".to_string(),
    );
    preview
}

/// 真实环境组装：定位 Vortex 根 → 读状态快照 → 读实时 state.v2（失败可降级）。
pub fn preview(store: &Store) -> AppResult<VortexRebuildPreview> {
    let root = crate::vortex_source::find_mods_root(GAME_ID).ok_or_else(|| {
        CommandError::new(
            "VORTEX_NOT_FOUND",
            "找不到 Vortex 的 mod 存储根，请先在 Vortex 里确认模组安装位置。",
        )
    })?;
    let meta = backup_json_path();
    let pairs = crate::vortex_mirror::read_pairs().ok();
    let game_root = store
        .snapshot_data()
        .game_dir
        .as_ref()
        .map(PathBuf::from);
    let catalog = build_catalog(
        &root,
        meta.as_deref(),
        pairs.as_deref(),
        game_root.as_deref(),
    );
    Ok(plan_from_catalog(store, &catalog))
}

/// 由目录清单生成 ModEntry。**不填 deployed_files**：Vortex 部署的硬链接不该由
/// 启动器去 undeploy，留空可保证任何误操作都删不掉游戏目录里的文件。
fn to_entry(catalog: &CatalogEntry, game_root: Option<&Path>) -> ModEntry {
    let item = &catalog.item;
    let lower = catalog
        .paths
        .iter()
        .map(|p| p.to_ascii_lowercase())
        .collect::<Vec<_>>();
    let has_archive = lower.iter().any(|p| is_archive(p));
    let has_cet = lower
        .iter()
        .any(|p| p.contains("cyber_engine_tweaks/mods/"));
    let has_redmod = lower.iter().any(|p| p.contains("/mods/") && p.ends_with("info.json"));
    let planned = lower
        .iter()
        .filter(|p| {
            p.starts_with("archive/")
                || p.starts_with("bin/")
                || p.starts_with("r6/")
                || p.starts_with("red4ext/")
                || p.starts_with("engine/")
                || p.starts_with("mods/")
        })
        .cloned()
        .collect::<Vec<_>>();
    let _ = game_root; // 目标路径暂不登记：物理部署由 Vortex 负责。
    let meta = &catalog.meta;
    let nexus = meta.nexus_mod_id.map(|mod_id| NexusRef {
        mod_id,
        file_id: meta.nexus_file_id,
        url: meta
            .homepage
            .clone()
            .unwrap_or_else(|| format!("https://www.nexusmods.com/cyberpunk2077/mods/{mod_id}")),
        version: item.version.clone(),
        picture_url: meta.picture_url.clone(),
        latest_version: meta.newest_version.clone(),
        last_check: None,
    });
    ModEntry {
        id: mod_id(&item.dir_name),
        name: item.name.clone(),
        raw_name: Some(item.dir_name.clone()),
        version: item.version.clone(),
        author: item.author.clone().or_else(|| meta.uploader.clone()),
        category: meta.category.clone(),
        category_locked: false,
        description: truncate(&meta.description, 4000),
        source_zip: None,
        nexus,
        staging_path: catalog.dir.to_string_lossy().to_string(),
        cover_path: None,
        cover_cache_path: None,
        enabled: item.enabled,
        installed_at: meta.install_time.clone().unwrap_or_else(now_iso),
        updated_at: meta.install_time.clone(),
        size_bytes: item.size_bytes,
        file_count: item.file_count,
        layout: crate::schema::InstallLayout::GameRoot,
        mod_folder: None,
        metadata_source: "vortex".to_string(),
        planned_files: planned,
        warnings: vec!["由 Vortex 安装并部署；启动器只镜像启用状态与加载顺序。".to_string()],
        deployed_files: Vec::new(),
        has_archive,
        has_redmod,
        has_cet,
        translated_name: None,
        translated_at: None,
        translated_by: None,
        managed: false,
        origin: ORIGIN.to_string(),
        modpack_id: None,
        nexus_cover_url: meta.picture_url.clone(),
        is_translation: false,
        parent_mod_id: None,
        ai_loc: None,
        ai_fix: Vec::new(),
    }
}

fn rebuild_dir(store: &Store) -> PathBuf {
    store.backups_dir.join("vortex-rebuild")
}

fn backup_state(store: &Store, name: &str) -> AppResult<PathBuf> {
    let dir = rebuild_dir(store).join(name);
    fs::create_dir_all(&dir).map_err(|err| {
        CommandError::new(
            "VORTEX_REBUILD_BACKUP_FAILED",
            format!("创建备份目录失败：{err}"),
        )
    })?;
    let target = dir.join("launcher-state.before.json");
    fs::copy(&store.state_file, &target).map_err(|err| {
        CommandError::new(
            "VORTEX_REBUILD_BACKUP_FAILED",
            format!("写前备份失败（{err}）。为安全起见已中止重建，state 未被改动。"),
        )
    })?;
    Ok(target)
}

/// 执行重建。调用方必须已经展示过 `preview` 并拿到用户确认。
pub fn apply_with_catalog(store: &Store, catalog: &Catalog) -> AppResult<VortexRebuildReport> {
    let plan = plan_from_catalog(store, catalog);
    if !plan.available {
        return Ok(VortexRebuildReport {
            ok: false,
            reason: plan.reason,
            ..Default::default()
        });
    }
    let name = stamp();
    let backup = backup_state(store, &name)?;

    // Store::save 只落盘、不回写内存；必须直接改内存快照并持锁写盘，
    // 否则重建后界面仍显示旧库，直到重启才变。
    let mut guard = store.data.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let original = guard.clone();
    let game_root = guard.game_dir.as_ref().map(PathBuf::from);
    let entries = catalog
        .entries
        .iter()
        .map(|entry| to_entry(entry, game_root.as_deref()))
        .collect::<Vec<_>>();

    // 旧条目整份归档：追加而不是覆盖，重复执行也不会丢历史。
    let archived = guard.mods.len();
    let old_mods = std::mem::take(&mut guard.mods);
    guard.archived_mods.extend(old_mods);
    guard.mods = entries;
    guard.vortex_mod_ids = guard
        .mods
        .iter()
        .zip(catalog.entries.iter())
        .map(|(entry, source)| (entry.id.clone(), source.item.dir_name.clone()))
        .collect();

    let added = guard.mods.len();
    let mapping = guard.vortex_mod_ids.len();
    if let Err(err) = store.save(&guard) {
        // 盘没写成，内存也退回原状，避免「界面变了、重启又回去」的幽灵状态。
        *guard = original;
        return Err(CommandError::new(
            "VORTEX_REBUILD_SAVE_FAILED",
            format!(
                "写入新库失败（{}）。整库备份在 {}，可在设置页一键还原。",
                err.message,
                backup.display()
            ),
        ));
    }
    drop(guard);

    let dir = rebuild_dir(store).join(&name);
    let report_path = dir.join("migration-report.json");
    let report = VortexRebuildReport {
        ok: true,
        reason: String::new(),
        backup_name: name.clone(),
        backup_path: backup.to_string_lossy().to_string(),
        report_path: report_path.to_string_lossy().to_string(),
        added,
        archived,
        mapping,
        warnings: plan.warnings.clone(),
    };
    if let Ok(raw) = serde_json::to_string_pretty(&serde_json::json!({
        "at": now_iso(),
        "plan": plan,
        "result": report,
    })) {
        let _ = fs::write(&report_path, raw);
    }
    Ok(report)
}

pub fn apply(store: &Store) -> AppResult<VortexRebuildReport> {
    let root = crate::vortex_source::find_mods_root(GAME_ID).ok_or_else(|| {
        CommandError::new("VORTEX_NOT_FOUND", "找不到 Vortex 的 mod 存储根。")
    })?;
    let meta = backup_json_path();
    let pairs = crate::vortex_mirror::read_pairs().ok();
    let game_root = store
        .snapshot_data()
        .game_dir
        .as_ref()
        .map(PathBuf::from);
    let catalog = build_catalog(
        &root,
        meta.as_deref(),
        pairs.as_deref(),
        game_root.as_deref(),
    );
    apply_with_catalog(store, &catalog)
}

/// 列出可还原的备份名（按时间倒序）。
pub fn list_backups(store: &Store) -> Vec<String> {
    let dir = rebuild_dir(store);
    let mut out = Vec::new();
    if let Ok(read) = fs::read_dir(&dir) {
        for entry in read.flatten() {
            if entry.path().join("launcher-state.before.json").is_file() {
                out.push(entry.file_name().to_string_lossy().to_string());
            }
        }
    }
    out.sort();
    out.reverse();
    out
}

/// 一键还原到某次重建之前。只覆盖 `launcher-state.json`，不删任何文件。
pub fn restore(store: &Store, name: &str) -> AppResult<VortexRebuildReport> {
    if name.contains("..") || name.contains('/') || name.contains('\\') {
        return Err(CommandError::new(
            "VORTEX_REBUILD_BAD_NAME",
            "备份名不合法。",
        ));
    }
    let file = rebuild_dir(store)
        .join(name)
        .join("launcher-state.before.json");
    let raw = fs::read_to_string(&file).map_err(|err| {
        CommandError::new(
            "VORTEX_REBUILD_RESTORE_FAILED",
            format!("读不到备份（{err}）：{}", file.display()),
        )
    })?;
    let data: AppStateData = serde_json::from_str(&raw).map_err(|err| {
        CommandError::new(
            "VORTEX_REBUILD_RESTORE_FAILED",
            format!("备份内容无法解析（{err}），未改动当前状态。"),
        )
    })?;
    let archived = data.mods.len();
    // 与 apply 同理：save 只落盘，必须同步内存，否则还原后界面还是重建后的库。
    let mut guard = store.data.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    *guard = data.clone();
    if let Err(err) = store.save(&guard) {
        return Err(CommandError::new(
            "VORTEX_REBUILD_RESTORE_FAILED",
            format!("还原写入失败（{}），当前状态未被改动。", err.message),
        ));
    }
    drop(guard);
    Ok(VortexRebuildReport {
        ok: true,
        reason: String::new(),
        backup_name: name.to_string(),
        backup_path: file.to_string_lossy().to_string(),
        added: archived,
        ..Default::default()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn tmp(tag: &str) -> PathBuf {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join(".test-tmp")
            .join(format!("rebuild-{}-{}", tag, uuid::Uuid::new_v4().simple()));
        let _ = fs::create_dir_all(&root);
        root
    }

    fn fixture(root: &Path) -> (PathBuf, PathBuf) {
        let vortex = root.join("vortex-mods");
        let a = vortex.join("Alpha Mod-1-2-3");
        let b = vortex.join("Beta Mod-4-5-6");
        fs::create_dir_all(a.join("archive/pc/mod")).unwrap();
        fs::create_dir_all(b.join("bin/x64/plugins/cyber_engine_tweaks/mods/beta")).unwrap();
        fs::write(a.join("archive/pc/mod/alpha.archive"), b"aaa").unwrap();
        fs::write(b.join("bin/x64/plugins/cyber_engine_tweaks/mods/beta/init.lua"), b"bbb").unwrap();
        let meta = root.join("hourly.json");
        serde_json::to_writer(
            fs::File::create(&meta).unwrap(),
            &serde_json::json!({
                "settings": {"profiles": {"activeProfileId": "P1"}},
                "persistent": {
                    "profiles": {"P1": {"modState": {
                        "Alpha Mod-1-2-3": {"enabled": true},
                        "Beta Mod-4-5-6": {"enabled": false}
                    }}},
                    "mods": {"cyberpunk2077": {
                        "Alpha Mod-1-2-3": {"attributes": {
                            "customFileName": "阿尔法模组", "version": "1.0", "author": "tester",
                            "description": "Line one<br />Line two &amp; more",
                            "category": "13", "modId": "1424", "fileId": "174931",
                            "pictureUrl": "https://example.test/pic.jpg",
                            "homepage": "https://www.nexusmods.com/cyberpunk2077/mods/1424/",
                            "installTime": "2026-11-07T14:32:10.327Z", "newestVersion": "1.0.1",
                            "fileType": "Appearance", "uploader": "tester"
                        }},
                        "Beta Mod-4-5-6": {"attributes": {"modName": "Beta", "version": "2.0"}}
                    }}
                }
            }),
        )
        .unwrap();
        (vortex, meta)
    }

    #[test]
    fn catalog_uses_disk_as_authority_and_snapshot_for_metadata() {
        let root = tmp("catalog");
        let (vortex, meta) = fixture(&root);
        let catalog = build_catalog(&vortex, Some(&meta), None, None);
        assert_eq!(catalog.entries.len(), 2);
        assert_eq!(catalog.entries[0].item.name, "阿尔法模组");
        assert!(catalog.entries[0].item.enabled);
        assert!(!catalog.entries[1].item.enabled);
        assert_eq!(catalog.entries[0].item.file_count, 1);
        assert_eq!(catalog.entries[0].item.size_bytes, 3);
        assert_eq!(catalog.archive_names.len(), 1);
        assert!(catalog
            .sources
            .iter()
            .any(|s| s.contains("hourly.json 状态快照")));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn vortex_metadata_is_carried_into_mod_entries() {
        let root = tmp("metadata");
        let (vortex, meta) = fixture(&root);
        let catalog = build_catalog(&vortex, Some(&meta), None, None);
        let store = Store::load(root.join("data")).unwrap();
        let plan = plan_from_catalog(&store, &catalog);
        assert_eq!(plan.with_description, 1);
        assert_eq!(plan.with_picture, 1);
        assert_eq!(plan.with_nexus, 1);
        assert_eq!(plan.metadata_complete, 1);

        let entry = to_entry(&catalog.entries[0], None);
        assert_eq!(entry.description, "Line one Line two & more");
        assert_eq!(entry.category, "服装"); // Vortex category id 13
        assert_eq!(entry.installed_at, "2026-11-07T14:32:10.327Z");
        assert_eq!(
            entry.nexus_cover_url.as_deref(),
            Some("https://example.test/pic.jpg")
        );
        let nexus = entry.nexus.expect("应带上 Nexus 引用");
        assert_eq!(nexus.mod_id, 1424);
        assert_eq!(nexus.file_id, Some(174931));
        assert_eq!(nexus.latest_version.as_deref(), Some("1.0.1"));
        assert_eq!(entry.metadata_source, "vortex");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn live_state_v2_overrides_snapshot() {
        let root = tmp("live");
        let (vortex, meta) = fixture(&root);
        let pairs = vec![
            (
                "settings###profiles###activeProfileId".to_string(),
                "\"P1\"".to_string(),
            ),
            (
                "persistent###profiles###P1###gameId".to_string(),
                "\"cyberpunk2077\"".to_string(),
            ),
            (
                "persistent###profiles###P1###modState###Beta Mod-4-5-6###enabled".to_string(),
                "true".to_string(),
            ),
        ];
        let catalog = build_catalog(&vortex, Some(&meta), Some(&pairs), None);
        assert!(catalog.entries[1].item.enabled);
        assert!(catalog
            .sources
            .iter()
            .any(|s| s.contains("state.v2 实时读取")));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn apply_archives_old_mods_maps_all_and_restore_is_exact() {
        let root = tmp("apply");
        let (vortex, meta) = fixture(&root);
        let store = Store::load(root.join("data")).unwrap();
        let mut data = store.snapshot_data();
        let mut old: ModEntry =
            serde_json::from_value(serde_json::json!({"id":"adopt-old","name":"旧模组","category":"其他","stagingPath":"x","enabled":true,"installedAt":"2026-01-01","sizeBytes":1,"fileCount":1,"layout":"archive"})).unwrap();
        old.origin = "adopted".to_string();
        data.mods.push(old);
        // 写前备份复制的是磁盘上的 state 文件，所以夹具必须先落盘；
        // Store::save 不回写内存，再手动同步内存快照。
        store.save(&data).unwrap();
        *store.data.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = data;

        let catalog = build_catalog(&vortex, Some(&meta), None, None);
        let plan = plan_from_catalog(&store, &catalog);
        assert_eq!(plan.to_add, 2);
        assert_eq!(plan.to_archive, 1);
        assert_eq!(plan.mapping_coverage, "2/2");
        assert!(plan.warnings.iter().any(|w| w.contains("归档")));

        let report = apply_with_catalog(&store, &catalog).unwrap();
        assert!(report.ok);
        assert_eq!(report.added, 2);
        assert_eq!(report.archived, 1);
        assert_eq!(report.mapping, 2);
        let after = store.snapshot_data();
        assert_eq!(after.mods.len(), 2);
        assert_eq!(after.archived_mods.len(), 1);
        assert_eq!(after.archived_mods[0].id, "adopt-old");
        assert!(after.mods.iter().all(|m| m.origin == "vortex"));
        assert!(after.mods.iter().all(|m| m.deployed_files.is_empty()));
        assert_eq!(after.vortex_mod_ids.len(), 2);
        assert!(std::path::Path::new(&report.backup_path).is_file());

        let restored = restore(&store, &report.backup_name).unwrap();
        assert!(restored.ok);
        let back = store.snapshot_data();
        assert_eq!(back.mods.len(), 1);
        assert_eq!(back.mods[0].id, "adopt-old");
        assert!(back.archived_mods.is_empty());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn empty_vortex_root_refuses_rebuild() {
        let root = tmp("empty");
        let vortex = root.join("vortex-mods");
        fs::create_dir_all(&vortex).unwrap();
        let store = Store::load(root.join("data")).unwrap();
        let catalog = build_catalog(&vortex, None, None, None);
        let plan = plan_from_catalog(&store, &catalog);
        assert!(!plan.available);
        let report = apply_with_catalog(&store, &catalog).unwrap();
        assert!(!report.ok);
        assert_eq!(store.snapshot_data().mods.len(), 0);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn uncovered_archives_are_reported_not_touched() {
        let root = tmp("uncovered");
        let (vortex, meta) = fixture(&root);
        let game = root.join("game");
        fs::create_dir_all(game.join("archive/pc/mod")).unwrap();
        fs::write(game.join("archive/pc/mod/alpha.archive"), b"same").unwrap();
        fs::write(game.join("archive/pc/mod/stray.archive"), b"stray").unwrap();
        let catalog = build_catalog(&vortex, Some(&meta), None, Some(&game));
        assert_eq!(catalog.uncovered_archives, vec!["stray.archive"]);
        assert!(game.join("archive/pc/mod/stray.archive").is_file());
        let _ = fs::remove_dir_all(root);
    }
}
