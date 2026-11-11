//! 整合包（Modpack）导出 / 导入。
//!
//! 两种形态，对应两种真实场景：
//! 1. **轻量清单 `.cdlist`**：纯 JSON，几十 KB。只带「哪个 Mod 的哪个文件」+ 加载顺序
//!    + 每个 Mod 的配置值，本体由对方从 Nexus 自己下。分享成本最低。
//! 2. **完整包 `.cdpack`**：zip64，内含 `pack.json` + 每个 Mod 一个独立 zip
//!    （`mods/<序号>-<名字>.zip`）。每个 Mod 独立打包是有意的——导入时逐个走既有的
//!    `installer::install_zip`，布局识别 / 剥壳 / info.json / 分类推断 / 封面全部复用，
//!    而且能进度可见、坏一个不影响其余、支持只装其中几个。
//!
//! 关键约束（都踩过或明确评估过）：
//! - **密钥永不入包**：只取 Mod 级别的配置值，不碰 AI Key / Nexus Key / 外部工具路径。
//! - **不猜编号**：清单里 `modId` 为 0 的条目单独列进 `unresolved`，导入端显示成
//!   「需对方自备」，不会静默消失，也不会被错认成别的 Mod。
//! - **apply 不持锁做磁盘 IO**：`deploy_mod` / `undeploy_mod` 内部各自锁 state，
//!   本模块每一步之间都重新取快照，绝不嵌套持锁（std::sync::Mutex 不可重入）。
//! - 导入端的「已装 / 缺失 / 版本不符」每次从实时库现算，所以安装会话天然可断点续传：
//!   关掉软件再打开，重新预览一次就是最新进度，不需要额外落盘会话。

use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

use crate::schema::{AppResult, CommandError, GameInfo, ModEntry};
use crate::store::{now_iso, now_stamp, Store};

/// 清单里的固定标识，「这文件是给本启动器的」。
pub const PACK_KIND: &str = "cyberdeck-pack";
/// 清单格式版本。只接受 <= 当前版本。
pub const PACK_VERSION: u32 = 1;
pub const LIST_EXTENSION: &str = "cdlist";
pub const FULL_EXTENSION: &str = "cdpack";

/// 清单大小上限。几千个 Mod 的清单也就几百 KB，16 MB 已经是异常了。
const MAX_MANIFEST_BYTES: u64 = 16 * 1024 * 1024;
/// 单个包里允许的内嵌 zip 数。
const MAX_INNER_ZIPS: usize = 4000;
/// 配置项总数上限。一个 Mod 常见 5–30 项，4000 足够覆盖几百个 Mod。
const MAX_CONFIG_ITEMS: usize = 4000;
/// 内嵌 zip 命名的最大长度（Windows 路径上限 + 中文名）。
const MAX_INNER_NAME_CHARS: usize = 60;

// ── 清单结构 ───────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PackKind {
    /// 只有清单，本体让对方去 Nexus 下。
    List,
    /// 清单 + 每个 Mod 的内嵌 zip。
    Full,
}

impl PackKind {
    pub fn extension(self) -> &'static str {
        match self {
            PackKind::List => LIST_EXTENSION,
            PackKind::Full => FULL_EXTENSION,
        }
    }
    fn as_str(self) -> &'static str {
        match self {
            PackKind::List => "list",
            PackKind::Full => "full",
        }
    }
}

/// 清单里的一个 Mod。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackMod {
    /// 包内唯一键：`nxm:<modId>` 或 `local:<归一化名字>`。
    pub key: String,
    #[serde(default)]
    pub mod_id: Option<u64>,
    #[serde(default)]
    pub file_id: Option<u64>,
    pub name: String,
    #[serde(default)]
    pub version: Option<String>,
    #[serde(default)]
    pub category: String,
    /// 导出时是否启用。导入端照这个值恢复。
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub optional: bool,
    #[serde(default)]
    pub size_bytes: u64,
    /// 完整包里指向 `mods/<...>.zip`；轻量包恒为 None。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inner: Option<String>,
}

/// 一条 Mod 配置值。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackConfig {
    /// 指回 `PackMod.key`。
    pub key: String,
    /// 配置来源 id（`mod_settings` / `red4ext_toml` / `mod_json` …）。
    pub source: String,
    #[serde(default)]
    pub section: String,
    #[serde(default)]
    pub field: String,
    #[serde(default)]
    pub value: String,
}

/// 没有 Nexus 编号、无法自动获取的条目。仅作告知，不进下载队列。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackUnresolved {
    pub key: String,
    pub name: String,
    #[serde(default)]
    pub version: Option<String>,
    #[serde(default)]
    pub size_bytes: u64,
    /// 内嵌文件名（完整包里才有）。
    #[serde(default)]
    pub inner: Option<String>,
}

/// 一份整合包清单。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackManifest {
    pub kind: String,
    pub schema_version: u32,
    /// `list` / `full`
    pub mode: String,
    pub name: String,
    #[serde(default)]
    pub author: String,
    #[serde(default)]
    pub description: String,
    pub created_at: String,
    #[serde(default)]
    pub app_version: String,
    #[serde(default)]
    pub game_version: Option<String>,
    #[serde(default)]
    pub profile: Option<String>,
    #[serde(default)]
    pub mods: Vec<PackMod>,
    /// 加载顺序对应的 key 序列（先者优先）。
    #[serde(default)]
    pub order: Vec<String>,
    #[serde(default)]
    pub configs: Vec<PackConfig>,
    #[serde(default)]
    pub unresolved: Vec<PackUnresolved>,
    #[serde(default)]
    pub warnings: Vec<String>,
}

// ── 报告结构 ───────────────────────────────────────────────────────────

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackExportReport {
    pub path: String,
    pub size_bytes: u64,
    pub mods: usize,
    pub enabled: usize,
    pub configs: usize,
    pub unresolved: usize,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackPreviewItem {
    pub key: String,
    pub name: String,
    #[serde(default)]
    pub version: Option<String>,
    #[serde(default)]
    pub mod_id: Option<u64>,
    #[serde(default)]
    pub file_id: Option<u64>,
    pub enabled: bool,
    /// `installed` / `version_mismatch` / `missing` / `local_only`
    pub status: String,
    #[serde(default)]
    pub matched_entry_id: Option<String>,
    #[serde(default)]
    pub matched_version: Option<String>,
    pub size_bytes: u64,
    /// 包里带了这个 Mod 的本体。
    pub has_files: bool,
    #[serde(default)]
    pub page_url: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackPreview {
    pub path: String,
    pub name: String,
    pub author: String,
    pub mode: String,
    pub created_at: String,
    pub app_version: String,
    #[serde(default)]
    pub game_version: Option<String>,
    pub total: usize,
    pub installed: usize,
    pub missing: usize,
    pub version_mismatch: usize,
    pub local_only: usize,
    pub enabled: usize,
    pub configs: usize,
    pub total_size: u64,
    pub items: Vec<PackPreviewItem>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackInstallReport {
    pub installed: usize,
    pub failed: usize,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackManualItem {
    pub mod_id: u64,
    #[serde(default)]
    pub file_id: Option<u64>,
    pub name: String,
    pub url: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackQueueReport {
    pub queued: usize,
    pub skipped: usize,
    pub manual: Vec<PackManualItem>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackApplyReport {
    pub deployed: usize,
    pub undeployed: usize,
    pub missing: usize,
    pub configs_written: usize,
    pub configs_failed: usize,
    pub order_applied: usize,
    pub warnings: Vec<String>,
}

// ── 小工具 ─────────────────────────────────────────────────────────────

/// 名字归一化：小写、去括号段、非字母数字当分隔。与 backfill 口径一致。
fn norm(text: &str) -> String {
    let lowered = text.to_lowercase();
    let mut out = String::with_capacity(lowered.len());
    let mut depth = 0i32;
    let mut pending = false;
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
            if pending && !out.is_empty() {
                out.push(' ');
            }
            pending = false;
            out.push(ch);
        } else {
            pending = true;
        }
    }
    out.trim().to_string()
}

/// 版本比较：忽略前导 v、忽略大小写、忽略空格。
fn same_version(expected: &str, actual: &str) -> bool {
    fn tidy(value: &str) -> String {
        value
            .trim()
            .trim_start_matches(['v', 'V'])
            .replace(' ', "")
            .to_ascii_lowercase()
    }
    let left = tidy(expected);
    let right = tidy(actual);
    !left.is_empty() && left == right
}

fn key_of(entry: &ModEntry) -> String {
    match entry.nexus.as_ref().map(|nexus| nexus.mod_id) {
        Some(id) if id > 0 => format!("nxm:{id}"),
        _ => format!("local:{}", norm(&entry.name)),
    }
}

fn page_url(mod_id: u64, file_id: Option<u64>) -> String {
    match file_id {
        Some(file) if file > 0 => format!(
            "https://www.nexusmods.com/cyberpunk2077/mods/{mod_id}?tab=files&file_id={file}"
        ),
        _ => format!("https://www.nexusmods.com/cyberpunk2077/mods/{mod_id}"),
    }
}

/// 内嵌 zip 的文件名：`mods/<序号>-<安全名字>.zip`。
fn inner_name(index: usize, entry: &ModEntry) -> String {
    let safe: String = entry
        .name
        .chars()
        .map(|ch| {
            if ch.is_alphanumeric() || matches!(ch, '-' | '_' | ' ') {
                ch
            } else {
                '_'
            }
        })
        .collect();
    let trimmed: String = safe.trim().chars().take(MAX_INNER_NAME_CHARS).collect();
    let label = if trimmed.is_empty() {
        format!("mod-{}", entry.id.get(..8).unwrap_or("item"))
    } else {
        trimmed
    };
    format!("mods/{index:04}-{label}.zip")
}

// ── 导出 ───────────────────────────────────────────────────────────────

/// 采集一个 Mod 的可写配置值。
///
/// 只收 `editable` 的来源：Native Interactions 的 JSON 是交互点定义，改错会把
/// Mod 弄坏，导出它毫无意义且容易在导入端造成伤害。
fn collect_configs(store: &Store, entries: &[&ModEntry], warnings: &mut Vec<String>) -> Vec<PackConfig> {
    let mut out: Vec<PackConfig> = Vec::new();
    let mut truncated = false;
    for entry in entries {
        if out.len() >= MAX_CONFIG_ITEMS {
            truncated = true;
            break;
        }
        let view = match crate::config_resolver::mod_config(store, &entry.id) {
            Ok(view) => view,
            // 没有游戏目录 / 文件读不到都算正常情况，不刷警告。
            Err(_) => continue,
        };
        for source in view.sources {
            if !source.editable {
                continue;
            }
            for field in source.fields {
                if out.len() >= MAX_CONFIG_ITEMS {
                    truncated = true;
                    break;
                }
                out.push(PackConfig {
                    key: key_of(entry),
                    source: source.id.clone(),
                    section: field.section,
                    field: field.key,
                    value: field.value,
                });
            }
        }
    }
    if truncated {
        warnings.push(format!(
            "配置项超过 {MAX_CONFIG_ITEMS} 条，只导出了前 {MAX_CONFIG_ITEMS} 条。"
        ));
    }
    out
}

/// 组装清单（不写盘）。
///
/// `include_unlisted` 为 true 时把「没有 Nexus 编号」的条目也收进来（完整包必须收，
/// 否则对方根本拿不到这些 Mod；轻量包收进来只是让对方知道缺什么）。
pub fn build_manifest(
    store: &Store,
    kind: PackKind,
    name: &str,
    author: &str,
    app_version: &str,
    include_unlisted: bool,
) -> AppResult<PackManifest> {
    let snapshot = store.snapshot_data();
    if snapshot.mods.is_empty() {
        return Err(CommandError::new("PACK_EMPTY", "模组库是空的，没有可导出的内容。"));
    }

    let mut warnings: Vec<String> = Vec::new();
    // 同一个 Nexus 编号可能有多个版本同时装在库里（多版本共存是允许的）。
    // 只导出**启用的那个**；没有启用的就取第一个，并在警告里说明。
    let mut chosen: HashMap<String, &ModEntry> = HashMap::new();
    let mut order_keys: Vec<String> = Vec::new();
    for entry in snapshot.mods.iter() {
        let key = key_of(entry);
        if !include_unlisted && key.starts_with("local:") {
            continue;
        }
        match chosen.get(&key) {
            None => {
                chosen.insert(key.clone(), entry);
                order_keys.push(key);
            }
            Some(previous) => {
                if entry.enabled && !previous.enabled {
                    chosen.insert(key.clone(), entry);
                }
            }
        }
    }
    if chosen.is_empty() {
        return Err(CommandError::new(
            "PACK_EMPTY",
            "库里没有带 Nexus 编号的模组，先点「补全 Nexus 信息」再来导出。",
        ));
    }

    let entries: Vec<&ModEntry> = order_keys
        .iter()
        .filter_map(|key| chosen.get(key).copied())
        .collect();

    let mut mods: Vec<PackMod> = Vec::new();
    let mut unresolved: Vec<PackUnresolved> = Vec::new();
    let mut full_index = 0usize;
    for entry in &entries {
        let key = key_of(entry);
        let local = key.starts_with("local:");
        let inner = if kind == PackKind::Full {
            full_index += 1;
            let staging = Path::new(&entry.staging_path);
            if !staging.is_dir() {
                warnings.push(format!("「{}」的暂存目录不存在，只能靠对方自己提供文件。", entry.name));
                None
            } else {
                Some(inner_name(full_index, entry))
            }
        } else {
            None
        };
        if local {
            unresolved.push(PackUnresolved {
                key: key.clone(),
                name: entry.name.clone(),
                version: entry.version.clone(),
                size_bytes: entry.size_bytes,
                inner: inner.clone(),
            });
        }
        mods.push(PackMod {
            key,
            mod_id: entry.nexus.as_ref().map(|nexus| nexus.mod_id).filter(|id| *id > 0),
            file_id: entry
                .nexus
                .as_ref()
                .and_then(|nexus| nexus.file_id)
                .filter(|id| *id > 0),
            name: entry.name.clone(),
            version: entry.version.clone(),
            category: entry.category.clone(),
            enabled: entry.enabled,
            optional: false,
            size_bytes: entry.size_bytes,
            inner,
        });
    }

    // 加载顺序：按库里 `load_order`（archive 相对路径）的先后，映射回 Mod 的先后。
    // 同一个 Mod 的多个 archive 连续出现时只记一次。
    let mut order: Vec<String> = Vec::new();
    for archive in snapshot.load_order.iter() {
        let lower = archive.to_ascii_lowercase();
        for entry in &entries {
            if entry
                .deployed_files
                .iter()
                .any(|file| file.relative_path.eq_ignore_ascii_case(&lower))
            {
                let key = key_of(entry);
                if !order.iter().any(|item| item == &key) {
                    order.push(key);
                }
                break;
            }
        }
    }
    // 没有任何 archive 的 Mod（纯 CET / redscript）也保留一个位置，导入端用它决定
    // 部署先后；否则它们的相对顺序在对方机器上会变成随机的。
    for entry in &entries {
        let key = key_of(entry);
        if !order.iter().any(|item| item == &key) {
            order.push(key);
        }
    }

    let configs = collect_configs(store, &entries, &mut warnings);
    let profile = snapshot
        .profiles
        .iter()
        .find(|item| Some(&item.id) == snapshot.active_profile_id.as_ref())
        .map(|item| item.name.clone());

    Ok(PackManifest {
        kind: PACK_KIND.to_string(),
        schema_version: PACK_VERSION,
        mode: kind.as_str().to_string(),
        name: name.trim().to_string(),
        author: author.trim().to_string(),
        description: String::new(),
        created_at: now_iso(),
        app_version: app_version.to_string(),
        game_version: snapshot.last_game_version.clone(),
        profile,
        mods,
        order,
        configs,
        unresolved,
        warnings,
    })
}

/// 默认导出路径：数据目录下的 `exports/`。
fn default_out_path(store: &Store, kind: PackKind, name: &str) -> PathBuf {
    let dir = store.data_dir.join("exports");
    let _ = fs::create_dir_all(&dir);
    let safe: String = name
        .chars()
        .map(|ch| {
            if ch.is_alphanumeric() || matches!(ch, '-' | '_' | ' ') {
                ch
            } else {
                '_'
            }
        })
        .collect();
    let label = if safe.trim().is_empty() {
        "整合包".to_string()
    } else {
        safe.trim().to_string()
    };
    dir.join(format!("{label}-{}.{}", now_stamp(), kind.extension()))
}

/// 轻量清单导出（只写 JSON）。
pub fn export_list(store: &Store, mut manifest: PackManifest, out: Option<&Path>) -> AppResult<PackExportReport> {
    let path = match out {
        Some(path) => path.to_path_buf(),
        None => default_out_path(store, PackKind::List, &manifest.name),
    };
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| {
            CommandError::new("PACK_EXPORT", format!("无法创建导出目录：{err}"))
        })?;
    }
    let json = serde_json::to_string_pretty(&manifest)
        .map_err(|err| CommandError::new("PACK_EXPORT", format!("清单序列化失败：{err}")))?;
    fs::write(&path, json.as_bytes())
        .map_err(|err| CommandError::new("PACK_EXPORT", format!("写入清单失败：{err}")))?;
    manifest.warnings.shrink_to_fit();
    Ok(PackExportReport {
        path: path.to_string_lossy().to_string(),
        size_bytes: json.len() as u64,
        mods: manifest.mods.len(),
        enabled: manifest.mods.iter().filter(|item| item.enabled).count(),
        configs: manifest.configs.len(),
        unresolved: manifest.unresolved.len(),
        warnings: manifest.warnings,
    })
}

/// 完整包导出。
///
/// 外层 zip 用 `Stored`（内层已经压缩过，再 deflate 只烧 CPU），内层 zip 同样
/// `Stored`：`.archive` / `.zip` / 图片这类内容重复压缩收益接近 0，而 3.5 GB
/// 走一遍 deflate 要好几分钟。文本类（json/ini/lua）体积小，无所谓。
pub fn export_full(
    store: &Store,
    mut manifest: PackManifest,
    out: Option<&Path>,
    progress: &mut dyn FnMut(usize, usize, &str),
) -> AppResult<PackExportReport> {
    let path = match out {
        Some(path) => path.to_path_buf(),
        None => default_out_path(store, PackKind::Full, &manifest.name),
    };
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| {
            CommandError::new("PACK_EXPORT", format!("无法创建导出目录：{err}"))
        })?;
    }

    let snapshot = store.snapshot_data();
    let by_key: HashMap<String, &ModEntry> = snapshot
        .mods
        .iter()
        .map(|entry| (key_of(entry), entry))
        .collect();

    let temp_dir = store.data_dir.join("pack-tmp");
    let _ = fs::remove_dir_all(&temp_dir);
    fs::create_dir_all(&temp_dir)
        .map_err(|err| CommandError::new("PACK_EXPORT", format!("无法创建临时目录：{err}")))?;

    let total = manifest.mods.len();
    progress(0, total, "准备打包");

    let file = File::create(&path)
        .map_err(|err| CommandError::new("PACK_EXPORT", format!("无法创建整合包：{err}")))?;
    let mut writer = ZipWriter::new(file);
    let outer_opts = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);

    let mut written_zips = 0usize;
    let mut cleanup: Vec<PathBuf> = Vec::new();
    let mut failures: Vec<String> = Vec::new();

    for (index, item) in manifest.mods.iter_mut().enumerate() {
        let Some(inner) = item.inner.clone() else {
            progress(index + 1, total, &item.name);
            continue;
        };
        if written_zips >= MAX_INNER_ZIPS {
            item.inner = None;
            manifest.warnings.push(format!("内嵌包数量超过 {MAX_INNER_ZIPS}，其余 Mod 未打包。"));
            break;
        }
        let Some(entry) = by_key.get(&item.key).copied() else {
            item.inner = None;
            continue;
        };
        let staging = Path::new(&entry.staging_path);
        if !staging.is_dir() {
            item.inner = None;
            continue;
        }
        let temp_zip = temp_dir.join(format!("{index:04}.zip"));
        match zip_folder(staging, &temp_zip) {
            Ok(()) => match append_file(&mut writer, &inner, &temp_zip, outer_opts) {
                Ok(()) => {
                    written_zips += 1;
                    cleanup.push(temp_zip);
                }
                Err(err) => {
                    item.inner = None;
                    failures.push(format!("{}：{}", entry.name, err.message));
                }
            },
            Err(err) => {
                item.inner = None;
                failures.push(format!("{}：{}", entry.name, err.message));
            }
        }
        progress(index + 1, total, &item.name);
    }

    // 清单最后写，这样读取端可以先看到包体再解析清单（也让「有没有装完」可判断）。
    let json = serde_json::to_vec_pretty(&manifest)
        .map_err(|err| CommandError::new("PACK_EXPORT", format!("清单序列化失败：{err}")))?;
    writer
        .start_file("pack.json", outer_opts)
        .map_err(|err| CommandError::new("PACK_EXPORT", format!("写入清单失败：{err}")))?;
    writer
        .write_all(&json)
        .map_err(|err| CommandError::new("PACK_EXPORT", format!("写入清单失败：{err}")))?;
    writer
        .finish()
        .map_err(|err| CommandError::new("PACK_EXPORT", format!("收尾失败：{err}")))?;

    for path in cleanup {
        let _ = fs::remove_file(path);
    }
    let _ = fs::remove_dir_all(&temp_dir);

    manifest.warnings.extend(failures);
    let size = fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0);
    progress(total, total, "完成");
    Ok(PackExportReport {
        path: path.to_string_lossy().to_string(),
        size_bytes: size,
        mods: manifest.mods.len(),
        enabled: manifest.mods.iter().filter(|item| item.enabled).count(),
        configs: manifest.configs.len(),
        unresolved: manifest.unresolved.len(),
        warnings: manifest.warnings,
    })
}

/// 把一个目录打成 zip（`Stored`，不重复压缩）。
fn zip_folder(root: &Path, out: &Path) -> AppResult<()> {
    let file = File::create(out)
        .map_err(|err| CommandError::new("PACK_EXPORT", format!("无法创建临时包：{err}")))?;
    let mut writer = ZipWriter::new(file);
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
    let walker = walkdir::WalkDir::new(root).follow_links(false);
    let mut buffer = vec![0u8; 256 * 1024];
    for item in walker.into_iter().filter_map(Result::ok) {
        if !item.file_type().is_file() {
            continue;
        }
        let relative = match item.path().strip_prefix(root) {
            Ok(value) => value,
            Err(_) => continue,
        };
        let name = relative.to_string_lossy().replace('\\', "/");
        if name.is_empty() {
            continue;
        }
        writer
            .start_file(name.clone(), options)
            .map_err(|err| CommandError::new("PACK_EXPORT", format!("写入 {name} 失败：{err}")))?;
        let mut source = File::open(item.path())
            .map_err(|err| CommandError::new("PACK_EXPORT", format!("读取 {name} 失败：{err}")))?;
        loop {
            let read = source
                .read(&mut buffer)
                .map_err(|err| CommandError::new("PACK_EXPORT", format!("读取 {name} 失败：{err}")))?;
            if read == 0 {
                break;
            }
            writer
                .write_all(&buffer[..read])
                .map_err(|err| CommandError::new("PACK_EXPORT", format!("写入 {name} 失败：{err}")))?;
        }
    }
    writer
        .finish()
        .map_err(|err| CommandError::new("PACK_EXPORT", format!("收尾失败：{err}")))?;
    Ok(())
}

fn append_file(
    writer: &mut ZipWriter<File>,
    name: &str,
    source: &Path,
    options: SimpleFileOptions,
) -> AppResult<()> {
    writer
        .start_file(name.to_string(), options)
        .map_err(|err| CommandError::new("PACK_EXPORT", format!("写入 {name} 失败：{err}")))?;
    let mut file = File::open(source)
        .map_err(|err| CommandError::new("PACK_EXPORT", format!("读取 {name} 失败：{err}")))?;
    io::copy(&mut file, writer)
        .map_err(|err| CommandError::new("PACK_EXPORT", format!("写入 {name} 失败：{err}")))?;
    Ok(())
}

// ── 读取 ───────────────────────────────────────────────────────────────

fn ensure_kind(raw: &[u8]) -> AppResult<PackManifest> {
    if raw.len() as u64 > MAX_MANIFEST_BYTES {
        return Err(CommandError::new("PACK_INVALID", "清单文件过大，不是整合包清单。"));
    }
    let manifest: PackManifest = serde_json::from_slice(raw)
        .map_err(|err| CommandError::new("PACK_INVALID", format!("清单解析失败：{err}")))?;
    if manifest.kind != PACK_KIND {
        return Err(CommandError::new(
            "PACK_INVALID",
            "这不是 CyberDeck Launcher 的整合包（kind 不匹配）。",
        ));
    }
    if manifest.schema_version > PACK_VERSION {
        return Err(CommandError::new(
            "PACK_VERSION",
            format!(
                "这个整合包由更新的启动器导出（清单 v{}，本机只认到 v{PACK_VERSION}）。",
                manifest.schema_version
            ),
        ));
    }
    Ok(manifest)
}

/// 读清单：`.cdlist` 直接读 JSON，`.cdpack` 从 zip 里取 `pack.json`。
pub fn read_manifest(path: &Path) -> AppResult<PackManifest> {
    let lower = path.to_string_lossy().to_ascii_lowercase();
    if lower.ends_with(&format!(".{FULL_EXTENSION}")) {
        let file = File::open(path)
            .map_err(|err| CommandError::new("PACK_READ", format!("打不开整合包：{err}")))?;
        let mut archive = ZipArchive::new(file)
            .map_err(|err| CommandError::new("PACK_INVALID", format!("不是有效的 zip：{err}")))?;
        let mut entry = archive
            .by_name("pack.json")
            .map_err(|_| CommandError::new("PACK_INVALID", "整合包里没有 pack.json。"))?;
        let mut raw = Vec::new();
        entry
            .read_to_end(&mut raw)
            .map_err(|err| CommandError::new("PACK_READ", format!("读取清单失败：{err}")))?;
        return ensure_kind(&raw);
    }
    let meta = fs::metadata(path)
        .map_err(|err| CommandError::new("PACK_READ", format!("打不开整合包：{err}")))?;
    if meta.len() > MAX_MANIFEST_BYTES {
        return Err(CommandError::new("PACK_INVALID", "清单文件过大，不是整合包清单。"));
    }
    let raw = fs::read(path)
        .map_err(|err| CommandError::new("PACK_READ", format!("读取清单失败：{err}")))?;
    ensure_kind(&raw)
}

/// 在库里找清单条目对应的本地条目。
///
/// `nxm:` 键优先按 Nexus 编号找（多个版本共存时取启用的那个），`local:` 键退回
/// 归一化名字匹配。找不到返回 None——调用方据此判「缺失」。
fn resolve_entry<'a>(mods: &'a [ModEntry], item: &PackMod) -> Option<&'a ModEntry> {
    if let Some(mod_id) = item.mod_id.filter(|id| *id > 0) {
        let matches: Vec<&ModEntry> = mods
            .iter()
            .filter(|entry| {
                entry
                    .nexus
                    .as_ref()
                    .map(|nexus| nexus.mod_id == mod_id)
                    .unwrap_or(false)
            })
            .collect();
        if let Some(enabled) = matches.iter().find(|entry| entry.enabled) {
            return Some(enabled);
        }
        if let Some(first) = matches.first() {
            return Some(first);
        }
    }
    let probe = norm(&item.name);
    mods.iter()
        .find(|entry| norm(&entry.name) == probe)
        .or_else(|| {
            mods.iter().find(|entry| {
                entry
                    .raw_name
                    .as_deref()
                    .map(|raw| norm(raw) == probe)
                    .unwrap_or(false)
            })
        })
}

fn status_of(item: &PackMod, entry: Option<&ModEntry>) -> String {
    match entry {
        None => {
            if item.mod_id.unwrap_or(0) == 0 {
                "local_only".to_string()
            } else {
                "missing".to_string()
            }
        }
        Some(found) => match (&item.version, &found.version) {
            (Some(want), Some(have)) if !same_version(want, have) => "version_mismatch".to_string(),
            _ => "installed".to_string(),
        },
    }
}

/// 预览：把清单和本地库对一遍，算出装了什么、缺什么。
pub fn preview(store: &Store, path: &Path) -> AppResult<PackPreview> {
    let manifest = read_manifest(path)?;
    let snapshot = store.snapshot_data();
    let mut items: Vec<PackPreviewItem> = Vec::with_capacity(manifest.mods.len());
    let mut installed = 0usize;
    let mut missing = 0usize;
    let mut mismatch = 0usize;
    let mut local_only = 0usize;
    let mut total_size = 0u64;

    for item in &manifest.mods {
        let found = resolve_entry(&snapshot.mods, item);
        let status = status_of(item, found);
        match status.as_str() {
            "installed" => installed += 1,
            "version_mismatch" => mismatch += 1,
            "local_only" => local_only += 1,
            _ => missing += 1,
        }
        total_size = total_size.saturating_add(item.size_bytes);
        items.push(PackPreviewItem {
            key: item.key.clone(),
            name: item.name.clone(),
            version: item.version.clone(),
            mod_id: item.mod_id,
            file_id: item.file_id,
            enabled: item.enabled,
            status,
            matched_entry_id: found.map(|entry| entry.id.clone()),
            matched_version: found.and_then(|entry| entry.version.clone()),
            size_bytes: item.size_bytes,
            has_files: item.inner.is_some(),
            page_url: item
                .mod_id
                .filter(|id| *id > 0)
                .map(|id| page_url(id, item.file_id)),
        });
    }

    Ok(PackPreview {
        path: path.to_string_lossy().to_string(),
        name: manifest.name,
        author: manifest.author,
        mode: manifest.mode,
        created_at: manifest.created_at,
        app_version: manifest.app_version,
        game_version: manifest.game_version,
        total: items.len(),
        installed,
        missing,
        version_mismatch: mismatch,
        local_only,
        enabled: manifest.mods.iter().filter(|item| item.enabled).count(),
        configs: manifest.configs.len(),
        total_size,
        items,
        warnings: manifest.warnings,
    })
}

// ── 完整包安装 ─────────────────────────────────────────────────────────

/// 把完整包里的内嵌 zip 装进库。只装「缺的」和「版本不符的」。
///
/// 逐个解到临时目录再交给 `install_zip`：那条路径已经处理了嵌套目录、多余外壳、
/// 7z/rar 识别、info.json、分类推断，重写一份只会引入新的判定差异。
pub fn install_missing(
    store: &Store,
    path: &Path,
    only: Option<&[String]>,
    progress: &mut dyn FnMut(usize, usize, &str),
) -> AppResult<PackInstallReport> {
    let manifest = read_manifest(path)?;
    if manifest.mode != "full" {
        return Err(CommandError::new(
            "PACK_NOT_FULL",
            "这个清单里没有 Mod 本体，无法直接安装。",
        ));
    }
    let snapshot = store.snapshot_data();
    let mut targets: Vec<&PackMod> = Vec::new();
    for item in &manifest.mods {
        if let Some(filter) = only {
            if !filter.iter().any(|key| key == &item.key) {
                continue;
            }
        }
        if item.inner.is_none() {
            continue;
        }
        if status_of(item, resolve_entry(&snapshot.mods, item)) == "installed" {
            continue;
        }
        targets.push(item);
    }
    if targets.is_empty() {
        return Ok(PackInstallReport::default());
    }

    let temp_dir = store.data_dir.join("pack-import");
    let _ = fs::remove_dir_all(&temp_dir);
    fs::create_dir_all(&temp_dir)
        .map_err(|err| CommandError::new("PACK_IMPORT", format!("无法创建临时目录：{err}")))?;

    let file = File::open(path)
        .map_err(|err| CommandError::new("PACK_READ", format!("打不开整合包：{err}")))?;
    let mut archive = ZipArchive::new(file)
        .map_err(|err| CommandError::new("PACK_INVALID", format!("不是有效的 zip：{err}")))?;

    let total = targets.len();
    let mut report = PackInstallReport::default();
    for (index, item) in targets.iter().enumerate() {
        progress(index, total, &item.name);
        let Some(inner) = item.inner.as_deref() else { continue };
        let temp_zip = temp_dir.join(format!("{index:04}.zip"));
        let extracted = (|| -> AppResult<()> {
            let mut entry = archive
                .by_name(inner)
                .map_err(|_| CommandError::new("PACK_INVALID", format!("包里没有 {}", inner)))?;
            let mut out = File::create(&temp_zip)
                .map_err(|err| CommandError::new("PACK_IMPORT", format!("写入临时文件失败：{err}")))?;
            io::copy(&mut entry, &mut out)
                .map_err(|err| CommandError::new("PACK_IMPORT", format!("解出内嵌包失败：{err}")))?;
            Ok(())
        })();
        if let Err(err) = extracted {
            report.failed += 1;
            report.warnings.push(format!("{}：{}", item.name, err.message));
            continue;
        }
        // 带上清单里的 Nexus 编号：装完就认得自己从哪来，检查更新 / 切版本 /
        // 二次导出都用得上。`install_archive` 只负责落盘，登记条目是调用方的事
        // （`install_mods_blocking` 也是这么做的）。
        let nexus = item.mod_id.filter(|id| *id > 0).map(|mod_id| crate::schema::NexusRef {
            mod_id,
            file_id: item.file_id.filter(|id| *id > 0),
            url: format!("https://www.nexusmods.com/cyberpunk2077/mods/{mod_id}"),
            version: item.version.clone(),
            picture_url: None,
            latest_version: None,
            last_check: None,
        });
        match crate::installer::install_archive(store, &temp_zip.to_string_lossy(), nexus) {
            Ok(entry) => {
                let mut data = store.data.lock().unwrap_or_else(|err| err.into_inner());
                if !data.mods.iter().any(|item| item.id == entry.id) {
                    data.mods.push(entry);
                }
                store.save(&data)?;
                report.installed += 1;
            }
            Err(err) => {
                report.failed += 1;
                report.warnings.push(format!("{}：{}", item.name, err.message));
            }
        }
        let _ = fs::remove_file(&temp_zip);
    }
    let _ = fs::remove_dir_all(&temp_dir);
    progress(total, total, "完成");
    Ok(report)
}

// ── 下载 ───────────────────────────────────────────────────────────────

/// 把缺失项压进下载队列。
///
/// `premium` 为 false 时一个都不入队——Nexus 不给免费账号签 API 直链，硬排只会
/// 让每个任务都以 403 失败。此时返回「需要手动点」的页面列表，前端做成引导队列。
pub fn queue_downloads(store: &Store, path: &Path, premium: bool) -> AppResult<PackQueueReport> {
    let manifest = read_manifest(path)?;
    let snapshot = store.snapshot_data();
    let mut report = PackQueueReport::default();
    for item in &manifest.mods {
        let Some(mod_id) = item.mod_id.filter(|id| *id > 0) else {
            continue;
        };
        let status = status_of(item, resolve_entry(&snapshot.mods, item));
        if status == "installed" {
            continue;
        }
        let Some(file_id) = item.file_id.filter(|id| *id > 0) else {
            // 只知道 Mod 不知道具体文件：让玩家去页面自己挑版本，别替他猜。
            report.manual.push(PackManualItem {
                mod_id,
                file_id: None,
                name: item.name.clone(),
                url: page_url(mod_id, None),
            });
            continue;
        };
        if !premium {
            report.manual.push(PackManualItem {
                mod_id,
                file_id: Some(file_id),
                name: item.name.clone(),
                url: page_url(mod_id, Some(file_id)),
            });
            continue;
        }
        match crate::download_queue::add(
            &store.data_dir,
            mod_id,
            file_id,
            Some(item.name.clone()),
            None,
            None,
            Some(true),
        ) {
            Ok(_) => report.queued += 1,
            Err(err) if err.code == "DOWNLOAD_QUEUE_DUPLICATE" => report.skipped += 1,
            Err(err) => report.warnings.push(format!("{}：{}", item.name, err.message)),
        }
    }
    Ok(report)
}

/// 只取「需要手动打开页面」的列表（免费号引导队列用）。
pub fn manual_pages(store: &Store, path: &Path) -> AppResult<Vec<PackManualItem>> {
    Ok(queue_downloads_probe(store, path)?.manual)
}

fn queue_downloads_probe(store: &Store, path: &Path) -> AppResult<PackQueueReport> {
    let manifest = read_manifest(path)?;
    let snapshot = store.snapshot_data();
    let mut report = PackQueueReport::default();
    for item in &manifest.mods {
        let Some(mod_id) = item.mod_id.filter(|id| *id > 0) else {
            continue;
        };
        if status_of(item, resolve_entry(&snapshot.mods, item)) == "installed" {
            continue;
        }
        report.manual.push(PackManualItem {
            mod_id,
            file_id: item.file_id.filter(|id| *id > 0),
            name: item.name.clone(),
            url: page_url(mod_id, item.file_id.filter(|id| *id > 0)),
        });
    }
    Ok(report)
}

// ── 应用 ───────────────────────────────────────────────────────────────

/// 把清单落到本地库：启停状态、加载顺序、每个 Mod 的配置值。
///
/// 顺序有意设计成「先全部就位，再统一应用」——中途缺 Mod 时不会留下
/// 「加载顺序改了但文件没装」的半截状态。
pub fn apply(store: &Store, path: &Path) -> AppResult<PackApplyReport> {
    let manifest = read_manifest(path)?;
    let mut report = PackApplyReport::default();

    // 1) 启停：清单说启用的装上，说禁用的撤下。
    for item in &manifest.mods {
        let snapshot = store.snapshot_data();
        let Some(entry) = resolve_entry(&snapshot.mods, item) else {
            report.missing += 1;
            continue;
        };
        if item.enabled {
            if entry.enabled {
                continue;
            }
            let Some(game) = game_info(store) else {
                report
                    .warnings
                    .push("游戏目录还没配置，只恢复了启用标记，没有部署。".to_string());
                set_enabled_flag(store, &entry.id, true)?;
                continue;
            };
            match crate::installer::deploy_mod(store, &entry.id, &game) {
                Ok(deploy) => {
                    report.deployed += 1;
                    report.warnings.extend(deploy.warnings);
                }
                Err(err) => report.warnings.push(format!("{}：{}", item.name, err.message)),
            }
        } else if entry.enabled {
            let Some(root) = snapshot.game_dir.clone() else {
                set_enabled_flag(store, &entry.id, false)?;
                continue;
            };
            match crate::installer::undeploy_mod(store, &entry.id, Path::new(&root)) {
                Ok(warnings) => {
                    report.undeployed += 1;
                    report.warnings.extend(warnings);
                }
                Err(err) => report.warnings.push(format!("{}：{}", item.name, err.message)),
            }
            set_enabled_flag(store, &entry.id, false)?;
        }
    }

    // 2) 加载顺序：按清单重排，未列出的保持原相对次序排在后面。
    {
        let snapshot = store.snapshot_data();
        let mut desired: Vec<String> = Vec::new();
        for key in &manifest.order {
            let Some(item) = manifest.mods.iter().find(|mod_item| &mod_item.key == key) else {
                continue;
            };
            let Some(entry) = resolve_entry(&snapshot.mods, item) else {
                continue;
            };
            let mut archives: Vec<String> = entry
                .deployed_files
                .iter()
                .filter(|file| file.relative_path.to_ascii_lowercase().ends_with(".archive"))
                .map(|file| file.relative_path.clone())
                .collect();
            archives.sort();
            for archive in archives {
                if !desired.iter().any(|item| item.eq_ignore_ascii_case(&archive)) {
                    desired.push(archive);
                }
            }
        }
        let mut next_order = desired.clone();
        for archive in snapshot.load_order.iter() {
            if !next_order.iter().any(|item| item.eq_ignore_ascii_case(archive)) {
                next_order.push(archive.clone());
            }
        }
        report.order_applied = desired.len();
        if next_order != snapshot.load_order {
            let mut data = store.data.lock().unwrap_or_else(|err| err.into_inner());
            data.load_order = next_order;
            store.save(&data)?;
        }
    }

    // 3) 配置：逐字段写，失败只记不中断。
    for config in &manifest.configs {
        let snapshot = store.snapshot_data();
        let Some(item) = manifest.mods.iter().find(|mod_item| mod_item.key == config.key) else {
            report.configs_failed += 1;
            continue;
        };
        let Some(entry) = resolve_entry(&snapshot.mods, item) else {
            report.configs_failed += 1;
            continue;
        };
        match crate::config_resolver::save_field(
            store,
            &entry.id,
            &config.source,
            &config.section,
            &config.field,
            &config.value,
        ) {
            Ok(_) => report.configs_written += 1,
            Err(_) => report.configs_failed += 1,
        }
    }

    Ok(report)
}

/// 只改启用标记，不做部署（游戏目录没配置时的降级路径）。
fn set_enabled_flag(store: &Store, id: &str, enabled: bool) -> AppResult<()> {
    let mut data = store.data.lock().unwrap_or_else(|err| err.into_inner());
    if let Some(entry) = data.mods.iter_mut().find(|item| item.id == id) {
        entry.enabled = enabled;
        entry.updated_at = Some(now_iso());
    }
    store.save(&data)?;
    Ok(())
}

/// 从 state 里的游戏根目录重新校验出 GameInfo（不信任缓存里的旧路径）。
fn game_info(store: &Store) -> Option<GameInfo> {
    let root = store.snapshot_data().game_dir?;
    crate::game::validate_game_dir(Path::new(&root)).ok()
}
