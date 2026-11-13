//! 全类型汉化覆盖层（P1 归档内文本 / P2 脚本类文本）。
//!
//! 设计基线：`docs/ARCH-FULL-LOCALIZATION-2026-11-08.md` §5.1。五条硬约束：
//! 1. 覆盖只认 `deployed_files` 清单里的目标，绝不按文件名猜游戏目录路径；
//! 2. 写入前把原文件原子备份到 `data_dir/ai-loc-backups/<modId>/`；
//! 3. 独立 `full-manifest.json` 登记 target / backup / size / mtime / 指纹，不动 state schema；
//! 4. 恢复前比对 size / mtime，被外部改过就拒绝自动恢复并告警；
//! 5. 覆盖清单在计划页 warnings 里回显，由既有勾选门确认后才执行。
//!
//! staging 母本**永不修改**：所有译文产物只写游戏目录（有备份）或独立 overlay 目录。
//! CLI 参数在 WolvenKit 版本间有差异，全部走「多形态尝试 + 产物校验」，失败只记
//! warning，不阻断其它载体，也不留下半成品。

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::LazyLock;

use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use walkdir::WalkDir;

use crate::installer::file_stamp;
use crate::schema::{AppResult, DeployedFile, LinkType, ModEntry};
use crate::store::{now_iso, safe_join, Store};

const MAX_CARRIER_FILES: usize = 24;
const MAX_TEXTS: usize = 400;
const MAX_TEXT_CHARS: usize = 1200;
const MANIFEST_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CarrierKind {
    Archive,
    Lua,
    Reds,
}

#[derive(Debug, Clone)]
pub struct Carrier {
    pub rel: String,
    pub kind: CarrierKind,
}

/// 只读扫描：P1/P2 能处理的载体（`.archive` / `.lua` / `.reds`）。
pub fn collect_carriers(staging: &Path) -> Vec<Carrier> {
    let mut out = Vec::new();
    if !staging.is_dir() {
        return out;
    }
    for item in WalkDir::new(staging)
        .max_depth(8)
        .into_iter()
        .filter_map(Result::ok)
    {
        if !item.file_type().is_file() || out.len() >= MAX_CARRIER_FILES {
            continue;
        }
        let ext = item
            .path()
            .extension()
            .and_then(|ext| ext.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        let kind = match ext.as_str() {
            "archive" => CarrierKind::Archive,
            "lua" => CarrierKind::Lua,
            "reds" | "redscript" => CarrierKind::Reds,
            _ => continue,
        };
        let rel = item
            .path()
            .strip_prefix(staging)
            .unwrap_or(item.path())
            .to_string_lossy()
            .replace('\\', "/");
        out.push(Carrier { rel, kind });
    }
    out.sort_by(|a, b| a.rel.cmp(&b.rel));
    out
}

pub fn has_carriers(staging: &Path) -> bool {
    !collect_carriers(staging).is_empty()
}

/// 覆盖型目标：只认部署清单里已登记的对应文件。
fn deployed_target<'a>(entry: &'a ModEntry, carrier: &Carrier) -> Option<&'a DeployedFile> {
    let name = Path::new(&carrier.rel)
        .file_name()?
        .to_string_lossy()
        .to_ascii_lowercase();
    entry.deployed_files.iter().find(|file| {
        Path::new(&file.relative_path)
            .file_name()
            .map(|item| item.to_string_lossy().to_ascii_lowercase() == name)
            .unwrap_or(false)
    })
}

/// 计划页回显：将被覆盖的相对路径清单（只读，不写任何文件）。
pub fn planned_overlays(entry: &ModEntry, staging: &Path) -> Vec<String> {
    collect_carriers(staging)
        .into_iter()
        .filter(|carrier| carrier.kind != CarrierKind::Archive)
        .filter_map(|carrier| deployed_target(entry, &carrier).map(|file| file.relative_path.clone()))
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

// ── P1：CR2W 可读 JSON ──────────────────────────────────────────────────────

/// 抽出 onscreens / subtitles 条目里的可见文本，返回 `(JSON pointer, 原文)`。
/// `primaryKey` / `secondaryKey` / `stringId` 一律不动，改了文本就找不到归属。
pub fn cr2w_texts(value: &Value) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let Some(entries) = value
        .pointer("/Data/RootChunk/root/Data/entries")
        .and_then(|item| item.as_array())
    else {
        return out;
    };
    for (index, entry) in entries.iter().enumerate() {
        for field in ["femaleVariant", "maleVariant"] {
            if let Some(text) = entry.get(field).and_then(|item| item.as_str()) {
                if !text.trim().is_empty() {
                    out.push((
                        format!("/Data/RootChunk/root/Data/entries/{index}/{field}"),
                        text.to_string(),
                    ));
                }
            }
        }
    }
    out
}

/// 把译文写回指针位置；未翻出来的保持原文。
pub fn apply_cr2w_texts(value: &mut Value, translated: &[(String, Option<String>)]) {
    for (pointer, text) in translated {
        if let Some(text) = text {
            if let Some(slot) = value.pointer_mut(pointer) {
                *slot = Value::String(text.clone());
            }
        }
    }
}

fn run_cli(cli: &Path, args: &[String]) -> Result<(), String> {
    let out = Command::new(cli)
        .args(args)
        .output()
        .map_err(|err| err.to_string())?;
    if out.status.success() {
        return Ok(());
    }
    let tail = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    Err(format!(
        "退出码 {:?}：{}",
        out.status.code(),
        tail.chars().take(300).collect::<String>()
    ))
}

fn snapshot(dir: &Path) -> BTreeSet<PathBuf> {
    fs::read_dir(dir)
        .map(|list| {
            list.flatten()
                .map(|entry| entry.path())
                .filter(|path| path.is_file())
                .collect()
        })
        .unwrap_or_default()
}

fn newest_new_file(dir: &Path, before: &BTreeSet<PathBuf>, json_only: bool) -> Option<PathBuf> {
    let mut found: Vec<PathBuf> = fs::read_dir(dir)
        .ok()?
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.is_file() && !before.contains(path))
        .filter(|path| {
            !json_only
                || path
                    .extension()
                    .and_then(|ext| ext.to_str())
                    .map(|ext| ext.eq_ignore_ascii_case("json"))
                    .unwrap_or(false)
        })
        .collect();
    found.sort();
    found.pop()
}

/// CR2W → 可读 JSON。WolvenKit 8.x 用 `convert serialize`，旧版用 `export`。
fn serialize_cr2w(cli: &Path, file: &Path, out_dir: &Path) -> Result<(PathBuf, Value), String> {
    let before = snapshot(out_dir);
    let mut last = String::new();
    for args in [
        vec![
            "convert".to_string(),
            "serialize".to_string(),
            "-p".to_string(),
            file.to_string_lossy().to_string(),
            "-o".to_string(),
            out_dir.to_string_lossy().to_string(),
        ],
        vec![
            "export".to_string(),
            "-p".to_string(),
            file.to_string_lossy().to_string(),
            "-o".to_string(),
            out_dir.to_string_lossy().to_string(),
        ],
    ] {
        if let Err(err) = run_cli(cli, &args) {
            last = err;
            continue;
        }
        if let Some(path) = newest_new_file(out_dir, &before, true) {
            if let Ok(raw) = fs::read_to_string(&path) {
                if let Ok(value) = serde_json::from_str::<Value>(&raw) {
                    if !cr2w_texts(&value).is_empty() {
                        return Ok((path, value));
                    }
                }
            }
        }
    }
    Err(format!("无法把 CR2W 序列化成可读 JSON：{last}"))
}

/// 可读 JSON → CR2W。`convert deserialize` / `import --keep` 两种形态。
fn deserialize_cr2w(cli: &Path, file: &Path, out_dir: &Path) -> Result<PathBuf, String> {
    let before = snapshot(out_dir);
    let mut last = String::new();
    for args in [
        vec![
            "convert".to_string(),
            "deserialize".to_string(),
            "-p".to_string(),
            file.to_string_lossy().to_string(),
            "-o".to_string(),
            out_dir.to_string_lossy().to_string(),
        ],
        vec![
            "import".to_string(),
            "-p".to_string(),
            file.to_string_lossy().to_string(),
            "-o".to_string(),
            out_dir.to_string_lossy().to_string(),
            "--keep".to_string(),
        ],
    ] {
        if let Err(err) = run_cli(cli, &args) {
            last = err;
            continue;
        }
        if let Some(path) = newest_new_file(out_dir, &before, false) {
            return Ok(path);
        }
    }
    Err(format!("无法把译文转回 CR2W：{last}"))
}

fn unbundle(cli: &Path, archive: &Path, out_dir: &Path) -> Result<(), String> {
    let args = vec![
        "unbundle".to_string(),
        "-p".to_string(),
        archive.to_string_lossy().to_string(),
        "-o".to_string(),
        out_dir.to_string_lossy().to_string(),
    ];
    run_cli(cli, &args)
}

fn pack(cli: &Path, source: &Path, output: &Path) -> Result<(), String> {
    let _ = fs::remove_file(output);
    let mut last = String::new();
    for args in [
        vec![
            "pack".to_string(),
            "-p".to_string(),
            source.to_string_lossy().to_string(),
            "-o".to_string(),
            output.to_string_lossy().to_string(),
        ],
        vec![
            "pack".to_string(),
            source.to_string_lossy().to_string(),
            "-o".to_string(),
            output.to_string_lossy().to_string(),
        ],
    ] {
        if let Err(err) = run_cli(cli, &args) {
            last = err;
            continue;
        }
        if output.is_file() {
            return Ok(());
        }
    }
    Err(format!("打包未产出 .archive：{last}"))
}

// ── P2：脚本类显示文本 ─────────────────────────────────────────────────────

/// 只取「显示类赋值」的字符串，避免把用于逻辑比较的键翻成中文。
fn display_regex(kind: CarrierKind) -> &'static Regex {
    if kind == CarrierKind::Reds { &REDS_DISPLAY_RE } else { &INI_DISPLAY_RE }
}

/// 两条都是编译期常量，用 LazyLock 只编译一次，避免每次调用都 expect。
static REDS_DISPLAY_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)\blet\s+\w*(text|label|message|title|desc|name|caption)\w*\s*=\s*(?:"([^"\\]*)"|'([^'\\]*)')"#).expect("静态 reds 正则应可编译")
});
static INI_DISPLAY_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)\b(label|name|title|text|description|tooltip|hint|category|option|display|caption|button)\s*=\s*(?:"([^"\\]*)"|'([^'\\]*)')"#).expect("静态 ini 正则应可编译")
});

fn usable_text(text: &str) -> bool {
    let trimmed = text.trim();
    if trimmed.chars().count() < 3 || trimmed.chars().count() > MAX_TEXT_CHARS {
        return false;
    }
    if trimmed.contains('%')
        || trimmed.contains('{')
        || trimmed.contains('\\')
        || trimmed.contains("..")
        || trimmed.contains('/')
        || trimmed.contains('\n')
    {
        return false;
    }
    if trimmed.chars().any(|ch| matches!(ch, '\u{3400}'..='\u{9fff}')) {
        return false;
    }
    trimmed.chars().any(|ch| ch.is_alphabetic())
}

pub fn display_strings(content: &str, kind: CarrierKind) -> Vec<String> {
    let re = display_regex(kind);
    let mut out = Vec::new();
    for caps in re.captures_iter(content) {
        let text = caps
            .get(2)
            .or_else(|| caps.get(3))
            .map(|item| item.as_str())
            .unwrap_or("");
        if usable_text(text) {
            out.push(text.to_string());
        }
    }
    out.sort();
    out.dedup();
    out
}

/// 只替换匹配到的键值里的引号内容，其它位置不动。
pub fn rewrite_display_strings(
    content: &str,
    kind: CarrierKind,
    map: &BTreeMap<String, String>,
) -> (String, usize) {
    let re = display_regex(kind);
    let mut count = 0usize;
    let out = re.replace_all(content, |caps: &regex::Captures| {
        let whole = caps.get(0).map(|item| item.as_str()).unwrap_or("");
        let original = caps
            .get(2)
            .or_else(|| caps.get(3))
            .map(|item| item.as_str())
            .unwrap_or("");
        let Some(translated) = map.get(original) else {
            return whole.to_string();
        };
        let Some(start) = whole.find(original) else {
            return whole.to_string();
        };
        count += 1;
        format!(
            "{}{}{}",
            &whole[..start],
            translated,
            &whole[start + original.len()..]
        )
    });
    (out.into_owned(), count)
}

// ── 备份 / 恢复 ────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupRecord {
    pub target: String,
    pub backup: String,
    pub size: Option<u64>,
    pub modified_time: Option<u64>,
    pub fingerprint: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct BackupManifest {
    pub version: u32,
    pub mod_id: String,
    pub created_at: String,
    #[serde(default)]
    pub records: Vec<BackupRecord>,
}

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

fn overlay_root(store: &Store, mod_id: &str) -> PathBuf {
    store
        .data_dir
        .join("ai-loc")
        .join(sanitize(mod_id))
        .join("full")
}

fn manifest_path(store: &Store, mod_id: &str) -> PathBuf {
    overlay_root(store, mod_id).join("full-manifest.json")
}

fn backup_dir(store: &Store, mod_id: &str) -> PathBuf {
    store
        .data_dir
        .join("ai-loc-backups")
        .join(sanitize(mod_id))
}

fn fingerprint(text: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in text.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{hash:016x}")
}

fn read_manifest(store: &Store, mod_id: &str) -> BackupManifest {
    fs::read_to_string(manifest_path(store, mod_id))
        .ok()
        .and_then(|raw| serde_json::from_str::<BackupManifest>(&raw).ok())
        .filter(|manifest| manifest.version == MANIFEST_VERSION)
        .unwrap_or_default()
}

fn write_manifest(store: &Store, manifest: &BackupManifest) -> AppResult<()> {
    let path = manifest_path(store, &manifest.mod_id);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(&path, serde_json::to_string_pretty(manifest).unwrap_or_default())?;
    Ok(())
}

/// 先备份、再覆盖。备份失败即返回错误，绝不写半截译文。
fn backup_and_write(
    store: &Store,
    manifest: &mut BackupManifest,
    target: &Path,
    relative: &str,
    staging_rel: &str,
    content: &str,
) -> Result<DeployedFile, String> {
    let original = fs::read(target).map_err(|err| format!("读取原文件失败：{err}"))?;
    let dir = backup_dir(store, &manifest.mod_id);
    fs::create_dir_all(&dir).map_err(|err| format!("建备份目录失败：{err}"))?;
    let stamp = now_iso()
        .replace(':', "-")
        .replace('.', "-")
        .replace('T', "-")
        .replace('Z', "-");
    let file_name = Path::new(relative)
        .file_name()
        .and_then(|item| item.to_str())
        .unwrap_or("target");
    let backup = dir.join(format!("{file_name}.{stamp}.bak"));
    fs::write(&backup, &original).map_err(|err| format!("备份失败，已中止覆盖：{err}"))?;

    fs::write(target, content).map_err(|err| {
        let _ = fs::remove_file(&backup);
        format!("写译文失败，已保留原文件：{err}")
    })?;
    let (size, modified_time) = file_stamp(target);
    let record = BackupRecord {
        target: target.to_string_lossy().to_string(),
        backup: backup.to_string_lossy().to_string(),
        size,
        modified_time,
        fingerprint: fingerprint(String::from_utf8_lossy(&original).as_ref()),
    };
    manifest.records.push(record);
    Ok(DeployedFile {
        source: staging_rel.to_string(),
        target: target.to_string_lossy().to_string(),
        link_type: LinkType::Copy,
        relative_path: relative.to_string(),
        size,
        modified_time,
    })
}

/// 恢复被覆盖的原文件。返回「已恢复的 target」供撤销流程跳过删除。
/// 外部改动过（size / mtime 不符）则拒绝自动恢复并告警，备份文件保留。
pub fn restore(store: &Store, mod_id: &str) -> (BTreeSet<String>, Vec<String>) {
    let mut restored = BTreeSet::new();
    let mut warnings = Vec::new();
    let manifest = read_manifest(store, mod_id);
    if manifest.records.is_empty() {
        return (restored, warnings);
    }
    for record in &manifest.records {
        let target = PathBuf::from(&record.target);
        if !target.is_file() {
            warnings.push(format!("原文件已不在，跳过恢复：{}", record.target));
            continue;
        }
        let (size, modified_time) = file_stamp(&target);
        let changed = matches!((record.size, size), (Some(a), Some(b)) if a != b)
            || matches!((record.modified_time, modified_time), (Some(a), Some(b)) if a != b);
        if changed {
            warnings.push(format!(
                "译文文件在生成后被外部改动，拒绝自动恢复（备份仍在 {}）：{}",
                record.backup, record.target
            ));
            continue;
        }
        match fs::copy(&record.backup, &target) {
            Ok(_) => {
                restored.insert(record.target.clone());
            }
            Err(err) => warnings.push(format!("恢复失败 {}：{err}", record.target)),
        }
    }
    let _ = fs::remove_file(manifest_path(store, mod_id));
    let _ = fs::remove_dir_all(overlay_root(store, mod_id));
    (restored, warnings)
}

// ── 统一翻译 ───────────────────────────────────────────────────────────────

fn translate_all(
    store: &Store,
    mod_id: &str,
    texts: &[String],
) -> (BTreeMap<String, String>, String, Vec<String>) {
    let mut map = BTreeMap::new();
    let pairs: Vec<(String, String)> = texts
        .iter()
        .map(|text| (mod_id.to_string(), text.clone()))
        .collect();
    if let Ok(hits) = crate::glossary::lookup(store, &pairs) {
        for (text, hit) in texts.iter().zip(hits) {
            if let Some(hit) = hit {
                map.insert(text.clone(), hit);
            }
        }
    }
    let pending: Vec<String> = texts
        .iter()
        .filter(|text| !map.contains_key(*text))
        .cloned()
        .collect();
    let mut model = String::new();
    let mut errors = Vec::new();
    if !pending.is_empty() {
        match crate::ai::translate_locale_strings(store, &pending, mod_id) {
            Ok(batch) => {
                model = batch.model.clone();
                errors.extend(batch.errors.iter().cloned());
                for (text, hit) in pending.iter().zip(batch.texts.into_iter()) {
                    if let Some(hit) = hit.filter(|item| !item.trim().is_empty()) {
                        map.insert(text.clone(), hit.clone());
                        let _ = crate::glossary::record(store, mod_id, text, &hit, "ai");
                    }
                }
            }
            Err(err) => errors.push(err.message),
        }
    }
    (map, model, errors)
}

// ── 编排 ──────────────────────────────────────────────────────────────────

pub struct EmitOutcome {
    pub deployed: Vec<DeployedFile>,
    pub written: Vec<String>,
    pub translated: usize,
    pub model: String,
    pub warnings: Vec<String>,
    pub errors: Vec<String>,
}

struct ArchiveWork {
    carrier_rel: String,
    unbundle_dir: PathBuf,
    serialized: Vec<(PathBuf, PathBuf, Vec<(String, String)>)>,
}

/// 生成全部覆盖产物。只读 staging；只写 overlay 目录与「有备份的」游戏目录目标。
pub fn emit_overlays(
    store: &Store,
    entry: &ModEntry,
    game_root: &Path,
    staging: &Path,
) -> AppResult<EmitOutcome> {
    let carriers = collect_carriers(staging);
    let mut outcome = EmitOutcome {
        deployed: Vec::new(),
        written: Vec::new(),
        translated: 0,
        model: String::new(),
        warnings: Vec::new(),
        errors: Vec::new(),
    };
    if carriers.is_empty() {
        return Ok(outcome);
    }

    let root = overlay_root(store, &entry.id);
    let _ = fs::create_dir_all(&root);
    let cli = match crate::wolvenkit::resolve_cli_path(&store.snapshot_data().settings) {
        Ok(path) => Some(path),
        Err(err) => {
            outcome
                .warnings
                .push(format!("未检测到 WolvenKit CLI，P1 归档内文本跳过：{}", err.message));
            None
        }
    };

    let mut texts: Vec<String> = Vec::new();
    let mut archive_works: Vec<ArchiveWork> = Vec::new();
    let mut script_works: Vec<(Carrier, String)> = Vec::new();

    for carrier in &carriers {
        let source = staging.join(&carrier.rel);
        match carrier.kind {
            CarrierKind::Archive => {
                let Some(cli_path) = cli.as_ref() else { continue };
                let dir = root.join("unbundle").join(sanitize(&carrier.rel));
                let _ = fs::create_dir_all(&dir);
                if let Err(err) = unbundle(cli_path, &source, &dir) {
                    outcome
                        .warnings
                        .push(format!("解包失败 {}：{err}", carrier.rel));
                    continue;
                }
                let mut work = ArchiveWork {
                    carrier_rel: carrier.rel.clone(),
                    unbundle_dir: dir.clone(),
                    serialized: Vec::new(),
                };
                let mut cr2w_files: Vec<PathBuf> = WalkDir::new(&dir)
                    .into_iter()
                    .filter_map(Result::ok)
                    .filter(|item| item.file_type().is_file())
                    .filter(|item| {
                        item.path()
                            .extension()
                            .and_then(|ext| ext.to_str())
                            .map(|ext| ext.eq_ignore_ascii_case("json"))
                            .unwrap_or(false)
                    })
                    .map(|item| item.path().to_path_buf())
                    .collect();
                cr2w_files.sort();
                cr2w_files.truncate(8);
                for cr2w in cr2w_files {
                    let ser_dir = root.join("serialize").join(sanitize(&cr2w.to_string_lossy()));
                    let _ = fs::create_dir_all(&ser_dir);
                    match serialize_cr2w(cli_path, &cr2w, &ser_dir) {
                        Ok((readable, value)) => {
                            let pairs = cr2w_texts(&value);
                            for (_, text) in &pairs {
                                if usable_text(text) && !texts.contains(text) {
                                    texts.push(text.clone());
                                }
                            }
                            work.serialized.push((cr2w, readable, pairs));
                        }
                        Err(err) => outcome.warnings.push(format!(
                            "CR2W 序列化失败 {}：{err}",
                            cr2w.display()
                        )),
                    }
                }
                archive_works.push(work);
            }
            CarrierKind::Lua | CarrierKind::Reds => {
                match fs::read_to_string(&source) {
                    Ok(content) => {
                        for text in display_strings(&content, carrier.kind) {
                            if !texts.contains(&text) {
                                texts.push(text);
                            }
                        }
                        script_works.push((carrier.clone(), content));
                    }
                    Err(err) => outcome
                        .warnings
                        .push(format!("读取脚本失败 {}：{err}", carrier.rel)),
                }
            }
        }
    }

    texts.truncate(MAX_TEXTS);
    let (map, model, errors) = translate_all(store, &entry.id, &texts);
    outcome.model = model;
    outcome.errors = errors;
    outcome.translated = map.len();

    // P1：改写可读 JSON → 转回 CR2W → pack → 生成 .xl → 部署两个独立文件。
    for work in &archive_works {
        let Some(cli_path) = cli.as_ref() else { continue };
        let mut first_rel: Option<String> = None;
        for (cr2w, readable, pairs) in &work.serialized {
            let Ok(raw) = fs::read_to_string(readable) else { continue };
            let Ok(mut value) = serde_json::from_str::<Value>(&raw) else { continue };
            let translated: Vec<(String, Option<String>)> = pairs
                .iter()
                .map(|(pointer, text)| (pointer.clone(), map.get(text).cloned()))
                .collect();
            apply_cr2w_texts(&mut value, &translated);
            if fs::write(readable, serde_json::to_string_pretty(&value).unwrap_or_default()).is_err() {
                continue;
            }
            let back_dir = root.join("deserialize").join(sanitize(&readable.to_string_lossy()));
            let _ = fs::create_dir_all(&back_dir);
            match deserialize_cr2w(cli_path, readable, &back_dir) {
                Ok(converted) => {
                    // 回写失败不能算「已汉化」：以前 `let _ =` 把错误吞了，界面显示成功、
                    // 游戏里还是原文，用户只会怀疑是不是没生效（2026-11-10 自检 P1-6）。
                    if let Err(err) = fs::copy(&converted, cr2w) {
                        outcome
                            .warnings
                            .push(format!("译文回写失败 {}：{err}", cr2w.display()));
                        continue;
                    }
                    if first_rel.is_none() {
                        first_rel = cr2w
                            .strip_prefix(&work.unbundle_dir)
                            .ok()
                            .map(|path| path.to_string_lossy().replace('\\', "/"));
                    }
                }
                Err(err) => outcome.warnings.push(format!(
                    "译文转回 CR2W 失败 {}：{err}",
                    readable.display()
                )),
            }
        }
        let Some(rel) = first_rel else { continue };
        let archive_name = format!("{}-ai-loc-full.archive", sanitize(&entry.id));
        let packed = root.join(&archive_name);
        if let Err(err) = pack(cli_path, &work.unbundle_dir, &packed) {
            outcome
                .warnings
                .push(format!("归档打包失败 {}：{err}", work.carrier_rel));
            continue;
        }
        let xl_name = format!("{}.archive.xl", archive_name.trim_end_matches(".archive"));
        let xl_path = root.join(&xl_name);
        let xl = format!("localization:\n  onscreens:\n    zh-cn: {rel}\n");
        if fs::write(&xl_path, xl).is_err() {
            continue;
        }
        outcome.written.push(packed.to_string_lossy().to_string());
        outcome.written.push(xl_path.to_string_lossy().to_string());
        for (source, relative) in [
            (packed.clone(), format!("archive/pc/mod/{archive_name}")),
            (xl_path.clone(), format!("archive/pc/mod/{xl_name}")),
        ] {
            let target = safe_join(game_root, &relative)?;
            if target.exists() {
                outcome
                    .warnings
                    .push(format!("游戏目录已有同名文件，未覆盖：{relative}"));
                continue;
            }
            if let Some(parent) = target.parent() {
                let _ = fs::create_dir_all(parent);
            }
            if let Err(err) = fs::copy(&source, &target) {
                outcome
                    .warnings
                    .push(format!("部署失败 {relative}：{err}"));
                continue;
            }
            let (size, modified_time) = file_stamp(&target);
            outcome.deployed.push(DeployedFile {
                source: source.to_string_lossy().to_string(),
                target: target.to_string_lossy().to_string(),
                link_type: LinkType::Copy,
                relative_path: relative,
                size,
                modified_time,
            });
        }
    }

    // P2：覆盖型写入，先备份再写，逐条登记。
    let mut manifest = BackupManifest {
        version: MANIFEST_VERSION,
        mod_id: entry.id.clone(),
        created_at: now_iso(),
        records: Vec::new(),
    };
    for (carrier, content) in &script_works {
        let Some(deployed) = deployed_target(entry, carrier) else {
            outcome.warnings.push(format!(
                "部署清单里找不到对应文件，未覆盖：{}",
                carrier.rel
            ));
            continue;
        };
        let (rewritten, count) = rewrite_display_strings(content, carrier.kind, &map);
        if count == 0 {
            continue;
        }
        let target = safe_join(game_root, &deployed.relative_path)?;
        if !target.is_file() {
            outcome
                .warnings
                .push(format!("游戏目录目标不存在，未覆盖：{}", deployed.relative_path));
            continue;
        }
        match backup_and_write(
            store,
            &mut manifest,
            &target,
            &deployed.relative_path,
            &carrier.rel,
            &rewritten,
        ) {
            Ok(file) => {
                outcome.written.push(target.to_string_lossy().to_string());
                outcome.deployed.push(file);
            }
            Err(err) => outcome
                .warnings
                .push(format!("覆盖失败 {}：{err}", carrier.rel)),
        }
    }
    if !manifest.records.is_empty() {
        write_manifest(store, &manifest)?;
    }
    if outcome.warnings.is_empty() && outcome.deployed.is_empty() {
        outcome
            .warnings
            .push("没有生成可用覆盖物（可能缺少可译文本、CLI 或部署清单目标）。".to_string());
    }
    Ok(outcome)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cr2w_roundtrip_keeps_keys_and_replaces_only_variants() {
        let raw = r#"{"Data":{"RootChunk":{"root":{"Data":{"entries":[
            {"$type":"localizationPersistenceOnScreenEntry","primaryKey":123,
             "secondaryKey":"MyMod-Item","femaleVariant":"Samurai Mask","maleVariant":""}
        ]}}}}}"#;
        let value: Value = serde_json::from_str(raw).unwrap();
        let pairs = cr2w_texts(&value);
        assert_eq!(pairs.len(), 1);
        assert_eq!(pairs[0].1, "Samurai Mask");
        let mut value = value;
        apply_cr2w_texts(&mut value, &[(pairs[0].0.clone(), Some("武士面具".to_string()))]);
        assert_eq!(
            value.pointer("/Data/RootChunk/root/Data/entries/0/femaleVariant"),
            Some(&Value::String("武士面具".to_string()))
        );
        assert_eq!(
            value.pointer("/Data/RootChunk/root/Data/entries/0/primaryKey"),
            Some(&serde_json::json!(123))
        );
        assert_eq!(
            value.pointer("/Data/RootChunk/root/Data/entries/0/secondaryKey"),
            Some(&Value::String("MyMod-Item".to_string()))
        );
    }

    #[test]
    fn lua_rewrite_only_touches_display_assignments() {
        let content = r#"
            label = "Show Minimap"
            key = "show_minimap"
            if setting == "show_minimap" then return end
            tooltip = 'Toggle the overlay'
        "#;
        let texts = display_strings(content, CarrierKind::Lua);
        assert!(texts.contains(&"Show Minimap".to_string()));
        assert!(texts.contains(&"Toggle the overlay".to_string()));
        assert!(!texts.contains(&"show_minimap".to_string()));
        let map = BTreeMap::from([
            ("Show Minimap".to_string(), "显示小地图".to_string()),
            ("Toggle the overlay".to_string(), "切换覆盖层".to_string()),
        ]);
        let (rewritten, count) = rewrite_display_strings(content, CarrierKind::Lua, &map);
        assert_eq!(count, 2);
        assert!(rewritten.contains("label = \"显示小地图\""));
        assert!(rewritten.contains("tooltip = '切换覆盖层'"));
        assert!(rewritten.contains("if setting == \"show_minimap\" then"));
    }

    #[test]
    fn backup_then_restore_recovers_original_and_detects_external_change() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join(".test-tmp")
            .join(format!("ailoc-full-{}", uuid::Uuid::new_v4().simple()));
        let _ = fs::create_dir_all(&root);
        let store = Store::load(root.join("data")).unwrap();

        let ok_target = root.join("ok.lua");
        fs::write(&ok_target, "label = \"Hello\"\n").unwrap();
        let mut ok_manifest = BackupManifest {
            version: MANIFEST_VERSION,
            mod_id: "ok".to_string(),
            created_at: now_iso(),
            records: Vec::new(),
        };
        let file = backup_and_write(
            &store,
            &mut ok_manifest,
            &ok_target,
            "mods/ok/init.lua",
            "init.lua",
            "label = \"你好\"\n",
        )
        .unwrap();
        assert!(matches!(file.link_type, LinkType::Copy));
        assert_eq!(ok_manifest.records.len(), 1);
        assert!(PathBuf::from(&ok_manifest.records[0].backup).is_file());
        write_manifest(&store, &ok_manifest).unwrap();
        let (restored, warnings) = restore(&store, "ok");
        assert_eq!(restored.len(), 1, "{warnings:?}");
        assert_eq!(fs::read_to_string(&ok_target).unwrap(), "label = \"Hello\"\n");

        let changed_target = root.join("changed.lua");
        fs::write(&changed_target, "label = \"Hello\"\n").unwrap();
        let mut changed_manifest = BackupManifest {
            version: MANIFEST_VERSION,
            mod_id: "changed".to_string(),
            created_at: now_iso(),
            records: Vec::new(),
        };
        backup_and_write(
            &store,
            &mut changed_manifest,
            &changed_target,
            "mods/changed/init.lua",
            "init.lua",
            "label = \"你好\"\n",
        )
        .unwrap();
        write_manifest(&store, &changed_manifest).unwrap();
        fs::write(&changed_target, "label = \"someone else edited this line\"\n").unwrap();
        let (restored, warnings) = restore(&store, "changed");
        assert!(restored.is_empty());
        assert!(warnings.iter().any(|item| item.contains("拒绝自动恢复")));
        assert!(PathBuf::from(&changed_manifest.records[0].backup).is_file());
        let _ = fs::remove_dir_all(&root);
    }
}
