//! 非破坏性 AI 汉化（T5）。
//!
//! 设计基线：`docs/PROJECT_HISTORY.md#design-ai-translation`。这里的实现只覆盖能确认正确的部分，
//! 其余一律**明确阻断**而不是猜着做：
//!
//! - 输入：Mod 暂存目录里的本地化 JSON（onscreens 条目格式或扁平 key→text）。
//! - 翻译：先查词表（`glossary`），未命中再走用户在设置里配好的真实 AI 接口。
//! - 产物：`staging/ai-loc/<modId>/`，只新增文件；原 Mod 目录一个字节都不写。
//! - 部署：ArchiveXL 的 `localization.onscreens` 只能指向**归档内部**路径，
//!   所以必须先用 WolvenKit CLI 把 JSON 打成 `<modId>-ai-loc.archive`。
//!   没有 CLI 就停在「已生成、未部署」，并如实说明原因——不产出装上也无效的文件。
//! - 回滚：按登记的 `deployed_files` 撕除，只删自己放进去的文件。
//!
//! 锁纪律沿用 `adopt.rs`：不持 `store.data` 锁做磁盘 IO 和网络请求。

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::Value;
use walkdir::WalkDir;

use crate::installer::file_stamp;
use crate::schema::{
    AiLocBlocked, AiLocEntry, AiLocPlan, AiLocReport, AiLocState, AppResult, CommandError,
    DeployedFile, LinkType, ModEntry,
};
use crate::store::{is_within, now_iso, safe_join, Store};

/// 目标语言固定简体中文：源语言自动探测会把「只有 ru-ru 的 Mod」翻成中俄混排，
/// 收益远小于风险，宁可只支持最常见的一种。
const TARGET_LANG: &str = "zh-cn";
/// 单个条目上限。超长多半是整段任务文本，塞进 20 条一批的请求会挤掉其余条目。
const MAX_TEXT_CHARS: usize = 1200;
/// 一次最多处理多少条目，防止某个体量异常的 Mod 触发上百次请求。
const MAX_ENTRIES: usize = 400;
/// 扫描时单个 JSON 的上限；超过就不读，避免把几 MB 的资源表当本地化。
const MAX_JSON_BYTES: u64 = 4 * 1024 * 1024;
/// blocked 列表上限：按载体去重后仍留余量，避免计划页被刷屏。
const MAX_BLOCKED: usize = 24;

/// 把「看得到但暂时翻不了」的文本载体归类，给计划页一个明确交代。
///
/// 纯美术 / 二进制资源返回 None——它们不含可翻文本，记进 blocked 只会刷屏。
/// reason 与 `schema.rs::AiLocBlocked` 的注释对齐，P1/P2 会逐类接管。
fn classify_carrier(name: &str) -> Option<(&'static str, &'static str)> {
    let ext = Path::new(name)
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "archive" | "inkwidget" | "inktext" | "csv" | "journal" => Some((
            "RESOURCE_TEXT",
            "文本在归档 / CR2W 资源里，需 WolvenKit 解包后由 ArchiveXL 合并（P1 支持）",
        )),
        "lua" | "reds" | "redscript" => Some((
            "SCRIPT_TEXT",
            "菜单 / 通知文本在脚本里，需覆盖型汉化层并先备份原文件（P2 支持）",
        )),
        "ini" | "toml" | "xl" | "yaml" | "yml" | "cfg" => Some((
            "CONFIG_TEXT",
            "这是玩家设置值文件，不是菜单文案；改它不会改变菜单文字",
        )),
        _ => None,
    }
}

fn sanitize_folder(raw: &str) -> String {
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

fn looks_chinese(text: &str) -> bool {
    text.chars()
        .any(|ch| matches!(ch, '\u{3400}'..='\u{4dbf}' | '\u{4e00}'..='\u{9fff}'))
}

/// 作者意愿：`allowed` / `uncertain` / `denied`。
///
/// 只做「明确拒绝」的硬判定。命中否定短语时再看附近有没有许可词，
/// 避免把 "translation not allowed without permission, but you may ask"
/// 这类句子误判成拒绝。
pub fn author_policy(entry: &ModEntry, staging: &Path) -> (String, Vec<String>) {
    const DENY: &[&str] = &[
        "no translation",
        "do not translate",
        "don't translate",
        "dont translate",
        "translation not allowed",
        "no localization",
        "no localisation",
        "translation prohibited",
        "禁止翻译",
        "禁止汉化",
        "请勿翻译",
        "谢绝翻译",
        "不允许汉化",
    ];
    const PERMIT: &[&str] = &["allowed", "permitted", "welcome", "可以", "欢迎", "允许"];

    let mut corpus = String::new();
    corpus.push_str(&entry.name.to_lowercase());
    corpus.push('\n');
    corpus.push_str(&entry.description.to_lowercase());
    for name in ["info.json", "readme.txt", "readme.md", "readme"] {
        let path = staging.join(name);
        if path.is_file() {
            if let Ok(text) = fs::read_to_string(&path) {
                corpus.push('\n');
                corpus.push_str(&text.to_lowercase());
            }
        }
    }
    let mut evidence = Vec::new();
    for phrase in DENY {
        let mut from = 0usize;
        while let Some(found) = corpus[from..].find(phrase) {
            let start = from + found;
            let end = start + phrase.len();
            // 同段落（同一行）里出现许可词 → 视为不确定而不是拒绝。
            // 用行边界而不是固定 40 字符窗口：作者常写成
            // "Do not translate without asking, but translation is allowed with permission."
            // 这种一句话里先否后许的形式，固定窗口会漏掉句尾的许可词。
            let line_start = corpus[..start].rfind('\n').map(|index| index + 1).unwrap_or(0);
            let line_end = corpus[end..]
                .find('\n')
                .map(|index| end + index)
                .unwrap_or(corpus.len());
            let window = &corpus[line_start..line_end];
            if PERMIT.iter().any(|word| window.contains(word)) {
                evidence.push(format!("不确定（附近有许可词）：{phrase}"));
            } else {
                evidence.push(format!("明确拒绝：{phrase}"));
            }
            from = end.max(start + 1);
        }
    }
    if evidence.iter().any(|item| item.starts_with("明确拒绝")) {
        return ("denied".to_string(), evidence);
    }
    if !evidence.is_empty() {
        return ("uncertain".to_string(), evidence);
    }
    // 版权声明 + 翻译字样同时出现，也按不确定处理，让用户自己确认。
    if corpus.contains("all rights reserved") && corpus.contains("translat") {
        evidence.push("命中组合否定：all rights reserved + translation".to_string());
        return ("uncertain".to_string(), evidence);
    }
    ("allowed".to_string(), evidence)
}

fn string_text(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => Some(text.clone()),
        _ => None,
    }
}

/// 从一份 JSON 里抽本地化条目。支持两种真实存在的形状：
/// 1. onscreens 条目数组（`entries: [{secondaryKey, femaleVariant, ...}]`）；
/// 2. 扁平 `{"Some.Key": "文本"}`（部分 Mod 自己的查表文件）。
pub(crate) fn entries_from_json(file_label: &str, raw: &str) -> (Vec<(String, String)>, bool) {
    let Ok(value) = serde_json::from_str::<Value>(raw) else {
        return (Vec::new(), false);
    };
    let mut out: Vec<(String, String)> = Vec::new();

    // 形状 1：任何一层里出现 entries 数组。
    fn find_entries(value: &Value, out: &mut Vec<(String, String)>) -> bool {
        match value {
            Value::Object(map) => {
                if let Some(Value::Array(list)) = map.get("entries") {
                    if list.iter().any(|item| item.get("secondaryKey").is_some()) {
                        for item in list {
                            let key = item
                                .get("secondaryKey")
                                .and_then(string_text)
                                .unwrap_or_default();
                            if key.trim().is_empty() {
                                continue;
                            }
                            let female = item.get("femaleVariant").and_then(string_text);
                            let male = item.get("maleVariant").and_then(string_text);
                            let text = female
                                .filter(|text| !text.trim().is_empty())
                                .or(male)
                                .unwrap_or_default();
                            if !text.trim().is_empty() {
                                out.push((key, text));
                            }
                        }
                        return true;
                    }
                }
                map.values().any(|child| find_entries(child, out))
            }
            Value::Array(list) => list.iter().any(|child| find_entries(child, out)),
            _ => false,
        }
    }
    if find_entries(&value, &mut out) {
        return (out, true);
    }

    // 形状 2：顶层就是 key→text。
    if let Value::Object(map) = &value {
        let mut flat = Vec::new();
        let mut all_strings = !map.is_empty();
        for (key, item) in map {
            match string_text(item) {
                Some(text) if !key.trim().is_empty() && !text.trim().is_empty() => {
                    flat.push((key.clone(), text));
                }
                Some(_) => {}
                None => all_strings = false,
            }
        }
        if all_strings && !flat.is_empty() {
            return (flat, true);
        }
    }
    let _ = file_label;
    (Vec::new(), false)
}

/// 只读扫描：收集可翻译条目，并把「看得到但暂时翻不了」的载体逐类记进 blocked。
///
/// P0（2026-11-08）：此前只扫 `.json`，纯 archive / Lua / redscript 类 Mod 连一条
/// blocked 都没有，用户只看到「没有可直接翻译的本地化 JSON」。现在按载体分类回显，
/// 为 P1（归档解包）/ P2（覆盖型汉化层，需先备份原文件）留出同一套扫描入口。
pub fn scan_entries(staging: &Path) -> (Vec<AiLocEntry>, Vec<AiLocBlocked>) {
    let mut entries: Vec<AiLocEntry> = Vec::new();
    let mut blocked: Vec<AiLocBlocked> = Vec::new();
    if !staging.is_dir() {
        return (entries, blocked);
    }
    let skip_names = ["info.json", "manifest.json", "package.json"];
    let mut files: Vec<PathBuf> = WalkDir::new(staging)
        .max_depth(8)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|item| item.file_type().is_file())
        .map(|item| item.path().to_path_buf())
        .collect();
    files.sort();

    // 同一扩展名只记一次：整合包里几十个 .archive 不该刷出几十行。
    let mut seen_carriers: BTreeSet<String> = BTreeSet::new();

    for file in files {
        if entries.len() >= MAX_ENTRIES || blocked.len() >= MAX_BLOCKED {
            break;
        }
        let name = file
            .file_name()
            .and_then(|item| item.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if skip_names.contains(&name.as_str()) {
            continue;
        }
        let label = file
            .strip_prefix(staging)
            .unwrap_or(&file)
            .to_string_lossy()
            .replace('\\', "/");
        let is_json = file
            .extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| ext.eq_ignore_ascii_case("json"))
            .unwrap_or(false);

        if !is_json {
            let Some((reason, note)) = classify_carrier(&name) else {
                continue;
            };
            let ext = Path::new(&name)
                .extension()
                .and_then(|ext| ext.to_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            if !seen_carriers.insert(format!("{ext}:{reason}")) {
                continue;
            }
            blocked.push(AiLocBlocked {
                source_file: label,
                reason: reason.to_string(),
                sample: note.to_string(),
            });
            continue;
        }

        if fs::metadata(&file).map(|meta| meta.len()).unwrap_or(0) > MAX_JSON_BYTES {
            continue;
        }
        let Ok(raw) = fs::read_to_string(&file) else {
            continue;
        };
        let (found, recognised) = entries_from_json(&label, &raw);
        if !recognised || found.is_empty() {
            // 以前直接 continue：用户看不出「有 JSON，但不是本地化格式」。
            if seen_carriers.insert("json:UNSUPPORTED_FORMAT".to_string()) {
                blocked.push(AiLocBlocked {
                    source_file: label,
                    reason: "UNSUPPORTED_FORMAT".to_string(),
                    sample: "这个 JSON 不是 onscreens 条目或扁平 key→text 形状，无法作为本地化源"
                        .to_string(),
                });
            }
            continue;
        }
        for (key, text) in found {
            let chars = text.chars().count();
            if looks_chinese(&text) {
                blocked.push(AiLocBlocked {
                    source_file: label.clone(),
                    reason: "ALREADY_CHINESE".to_string(),
                    sample: text.chars().take(40).collect(),
                });
                continue;
            }
            if chars > MAX_TEXT_CHARS {
                blocked.push(AiLocBlocked {
                    source_file: label.clone(),
                    reason: "TEXT_TOO_LONG".to_string(),
                    sample: text.chars().take(40).collect(),
                });
                continue;
            }
            if entries.len() >= MAX_ENTRIES {
                blocked.push(AiLocBlocked {
                    source_file: label.clone(),
                    reason: "ENTRY_LIMIT".to_string(),
                    sample: key,
                });
                break;
            }
            entries.push(AiLocEntry {
                source_file: label.clone(),
                secondary_key: key,
                source_text: text,
                glossary_hit: None,
            });
        }
    }
    (entries, blocked)
}

/// WolvenKit 能打包的本地化 JSON。字段名取自 WolvenKit 项目里 `localization/*.json`
/// 的实际形状（`JsonResource` + `localizationPersistenceOnScreenEntries`）。
fn build_localization_json(entries: &[(String, String)]) -> String {
    let list: Vec<Value> = entries
        .iter()
        .map(|(key, text)| {
            serde_json::json!({
                "$type": "localizationPersistenceOnScreenEntry",
                "secondaryKey": key,
                "femaleVariant": text,
            })
        })
        .collect();
    let doc = serde_json::json!({
        "Header": {
            "WKitJsonVersion": "0.0.3",
            "GameVersion": 1600,
            "DataType": "CR2W"
        },
        "Data": {
            "Version": 195,
            "BuildVersion": 0,
            "RootChunk": {
                "$type": "JsonResource",
                "cookingPlatform": "PLATFORM_PC",
                "root": {
                    "HandleId": "0",
                    "Data": {
                        "$type": "localizationPersistenceOnScreenEntries",
                        "entries": list
                    }
                }
            },
            "EmbeddedFiles": []
        }
    });
    serde_json::to_string_pretty(&doc).unwrap_or_else(|_| "{}".to_string())
}

/// ArchiveXL 配置。`extend` 指向原 Mod 的 `.archive.xl`（存在时才加），
/// 这样 ArchiveXL 会在原语言表之上按键合并，而不是整表替换。
pub(crate) fn build_archive_xl(mod_id: &str, extend: Option<&str>) -> String {
    let mut text = String::new();
    text.push_str("localization:\n");
    if let Some(target) = extend {
        text.push_str(&format!("  extend: {target}\n"));
    }
    text.push_str("  onscreens:\n");
    text.push_str(&format!(
        "    {TARGET_LANG}: localization\\{TARGET_LANG}\\{mod_id}-ai-loc.json\n"
    ));
    text
}

fn find_entry(store: &Store, mod_id: &str) -> AppResult<ModEntry> {
    let data = store.data.lock().expect("state mutex poisoned");
    data.mods
        .iter()
        .find(|entry| entry.id == mod_id)
        .cloned()
        .ok_or_else(|| CommandError::new("MOD_NOT_FOUND", "找不到这个模组。"))
}

fn overlay_root(store: &Store, mod_id: &str) -> PathBuf {
    store
        .staging_dir()
        .join("ai-loc")
        .join(sanitize_folder(mod_id))
}

/// 只读计划：不联网、不写文件。前端据此渲染确认弹窗。
pub fn plan(store: &Store, mod_id: &str) -> AppResult<AiLocPlan> {
    let entry = find_entry(store, mod_id)?;
    let staging = PathBuf::from(&entry.staging_path);
    if !staging.is_dir() {
        return Err(CommandError::new(
            "STAGING_MISSING",
            "这个模组的暂存文件不见了，无法扫描本地化文本。",
        ));
    }
    let (policy, evidence) = author_policy(&entry, &staging);
    let (mut entries, blocked) = scan_entries(&staging);

    // 词表命中只做展示，真正取用仍在 apply 阶段（避免计划阶段就写状态）。
    let pairs: Vec<(String, String)> = entries
        .iter()
        .map(|item| (entry.id.clone(), item.source_text.clone()))
        .collect();
    let mut hits = 0usize;
    if let Ok(found) = crate::glossary::lookup(store, &pairs) {
        for (item, hit) in entries.iter_mut().zip(found.into_iter()) {
            if let Some(text) = hit {
                hits += 1;
                item.glossary_hit = Some(text);
            }
        }
    }

    let settings = store.snapshot_data().settings.clone();
    let packing_ready = crate::wolvenkit::resolve_cli_path(&settings).is_ok();
    let mut warnings = Vec::new();
    if !packing_ready {
        warnings.push(
            "未检测到 WolvenKit CLI：可以生成译文，但无法打包 .archive，因此不会部署进游戏。"
                .to_string(),
        );
    }
    if policy == "denied" {
        warnings.push("检测到作者明确禁止翻译，已按作者意愿停止。".to_string());
    }
    if policy == "uncertain" {
        warnings.push("作者意愿无法确定，确认时需要额外勾选一次。".to_string());
    }

    Ok(AiLocPlan {
        mod_id: entry.id.clone(),
        mod_name: entry.name.clone(),
        source_lang: "en-us".to_string(),
        target_lang: TARGET_LANG.to_string(),
        policy,
        policy_evidence: evidence,
        entries,
        blocked,
        glossary_hits: hits,
        packing_ready,
        has_overlay: entry.ai_loc.is_some(),
        warnings,
    })
}

/// 找一个可以当 `extend:` 目标的原 Mod 配置文件名（形如 `Foo.archive.xl`）。
fn find_extend_target(entry: &ModEntry) -> Option<String> {
    entry
        .deployed_files
        .iter()
        .find(|file| file.relative_path.to_ascii_lowercase().ends_with(".archive.xl"))
        .and_then(|file| {
            Path::new(&file.relative_path)
                .file_name()
                .map(|name| name.to_string_lossy().to_string())
        })
}

/// 用 WolvenKit CLI 打包。CLI 的参数形态在不同版本有过变化，
/// 这里按 `pack -p <dir> -o <out>` → `pack <dir> -o <out>` 依次尝试，
/// 只有产物真的出现才算成功。
fn pack_archive(cli: &Path, source: &Path, output: &Path) -> Result<(), String> {
    let _ = fs::remove_file(output);
    let attempts: [Vec<String>; 2] = [
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
    ];
    let mut last = String::new();
    for args in attempts {
        let result = Command::new(cli).args(&args).output();
        match result {
            Ok(out) => {
                if output.is_file() {
                    return Ok(());
                }
                let stderr = String::from_utf8_lossy(&out.stderr).to_string();
                let stdout = String::from_utf8_lossy(&out.stdout).to_string();
                last = format!(
                    "退出码 {:?}：{}{}",
                    out.status.code(),
                    stdout.chars().take(300).collect::<String>(),
                    stderr.chars().take(300).collect::<String>()
                );
            }
            Err(err) => last = err.to_string(),
        }
    }
    Err(last)
}

/// 执行汉化：翻译 → 生成覆盖层 → 打包 → 部署 → 登记。
pub fn apply(
    store: &Store,
    mod_id: &str,
    game_root: &Path,
    consent: bool,
    policy_ack: bool,
) -> AppResult<AiLocReport> {
    if !consent {
        return Err(CommandError::new(
            "AI_LOC_CONSENT_REQUIRED",
            "需要先确认「已知晓译文由 AI 生成」，才会调用 AI 服务并生成覆盖层。",
        ));
    }
    let entry = find_entry(store, mod_id)?;
    if entry.ai_loc.is_some() {
        return Err(CommandError::new(
            "AI_LOC_EXISTS",
            "这个模组已经有汉化覆盖层了，请先撤销再重新生成。",
        ));
    }
    let staging = PathBuf::from(&entry.staging_path);
    if !staging.is_dir() {
        return Err(CommandError::new(
            "STAGING_MISSING",
            "这个模组的暂存文件不见了，无法扫描本地化文本。",
        ));
    }
    let (policy, evidence) = author_policy(&entry, &staging);
    if policy == "denied" {
        return Err(CommandError::new(
            "AI_LOC_POLICY_DENIED",
            format!(
                "作者明确禁止翻译，已停止：{}",
                evidence.first().cloned().unwrap_or_default()
            ),
        ));
    }
    if policy == "uncertain" && !policy_ack {
        return Err(CommandError::new(
            "AI_LOC_POLICY_UNCERTAIN",
            "作者意愿无法确定，需要你额外确认「已确认作者未禁止翻译」。",
        ));
    }
    let (entries, blocked) = scan_entries(&staging);
    if entries.is_empty() {
        return Err(CommandError::new(
            "AI_LOC_NO_CONTENT",
            "这个模组没有可直接翻译的本地化 JSON；硬编码在脚本或归档里的文本暂不支持自动汉化。",
        ));
    }

    // 1. 词表优先，未命中再走 AI。
    let pairs: Vec<(String, String)> = entries
        .iter()
        .map(|item| (entry.id.clone(), item.source_text.clone()))
        .collect();
    let mut resolved: Vec<Option<String>> = vec![None; entries.len()];
    if let Ok(found) = crate::glossary::lookup(store, &pairs) {
        for (index, hit) in found.into_iter().enumerate() {
            if index < resolved.len() {
                resolved[index] = hit;
            }
        }
    }
    let mut pending: Vec<usize> = Vec::new();
    let mut pending_texts: Vec<String> = Vec::new();
    for (index, item) in entries.iter().enumerate() {
        if resolved[index].is_none() {
            pending.push(index);
            pending_texts.push(item.source_text.clone());
        }
    }
    let mut model = String::new();
    let mut errors: Vec<String> = Vec::new();
    if !pending_texts.is_empty() {
        let batch = crate::ai::translate_locale_strings(store, &pending_texts, &entry.name)?;
        model = batch.model.clone();
        errors.extend(batch.errors.iter().cloned());
        for (offset, text) in batch.texts.into_iter().enumerate() {
            if let Some(text) = text {
                resolved[pending[offset]] = Some(text);
            }
        }
    }

    // 2. 只保留真正翻出来的条目：没翻出来的键直接不写，游戏回落到原文。
    let mut translated_pairs: Vec<(String, String)> = Vec::new();
    let mut skipped = 0usize;
    for (index, item) in entries.iter().enumerate() {
        match resolved[index].as_ref() {
            Some(text) if text.trim() != item.source_text.trim() => {
                translated_pairs.push((item.secondary_key.clone(), text.clone()));
            }
            _ => skipped += 1,
        }
    }
    if translated_pairs.is_empty() {
        return Err(CommandError::new(
            "AI_LOC_NOTHING_TRANSLATED",
            format!(
                "没有任何条目翻出可用译文（共 {} 条）。{}",
                entries.len(),
                errors.first().cloned().unwrap_or_default()
            ),
        ));
    }

    // 3. 落盘到独立目录。原 Mod 目录只读，这里从不写回。
    let root = overlay_root(store, mod_id);
    if root.exists() {
        // 上次失败留下的半成品：整目录重建，不复用。
        if is_within(&store.staging_dir(), &root) {
            let _ = fs::remove_dir_all(&root);
        }
        if root.exists() {
            return Err(CommandError::new(
                "AI_LOC_STAGING_BUSY",
                format!("覆盖层暂存目录无法清理：{}", root.display()),
            ));
        }
    }
    let pack_dir = root.join("pack");
    let json_rel = format!("localization/{TARGET_LANG}/{mod_id}-ai-loc.json");
    let json_path = pack_dir.join(&json_rel);
    if let Some(parent) = json_path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(&json_path, build_localization_json(&translated_pairs))?;
    let xl_name = format!("{mod_id}-ai-loc.archive.xl");
    let xl_path = root.join(&xl_name);
    let extend = find_extend_target(&entry);
    fs::write(&xl_path, build_archive_xl(mod_id, extend.as_deref()))?;

    let written = vec![
        json_path.to_string_lossy().to_string(),
        xl_path.to_string_lossy().to_string(),
    ];

    // 4. 打包：ArchiveXL 只能加载归档内部资源，没有归档就不部署。
    let settings = store.snapshot_data().settings.clone();
    let cli = crate::wolvenkit::resolve_cli_path(&settings).map_err(|err| {
        CommandError::new(
            "AI_LOC_WOLVENKIT_REQUIRED",
            format!(
                "译文已生成在 {}，但缺少 WolvenKit CLI 无法打包 .archive，\
                 因此没有部署进游戏。安装后重试即可：{}",
                root.display(),
                err.message
            ),
        )
    })?;
    let archive_path = root.join(format!("{mod_id}-ai-loc.archive"));
    pack_archive(&cli, &pack_dir, &archive_path).map_err(|detail| {
        CommandError::new(
            "AI_LOC_PACK_FAILED",
            format!("WolvenKit 打包失败，未部署。译文保留在 {}。详情：{detail}", root.display()),
        )
    })?;

    // 5. 部署到游戏目录：只新增两个文件，目标已存在就拒绝。
    let mod_dir = game_root.join("archive").join("pc").join("mod");
    if !mod_dir.is_dir() {
        return Err(CommandError::new(
            "GAME_DIR_MISSING",
            format!("游戏目录缺少 archive/pc/mod：{}", mod_dir.display()),
        ));
    }
    let deploys = [
        (archive_path.clone(), format!("archive/pc/mod/{}", archive_path.file_name().unwrap().to_string_lossy())),
        (xl_path.clone(), format!("archive/pc/mod/{xl_name}")),
    ];
    let mut deployed: Vec<DeployedFile> = Vec::new();
    let mut deployed_labels: Vec<String> = Vec::new();
    for (source, relative) in deploys {
        let target = safe_join(game_root, &relative)?;
        if target.exists() {
            // 已经放进游戏目录的文件不能覆盖：可能是别的汉化包，也可能是用户手放。
            for item in &deployed {
                let _ = fs::remove_file(&item.target);
            }
            return Err(CommandError::new(
                "AI_LOC_TARGET_EXISTS",
                format!("游戏目录里已经有同名文件，未覆盖：{relative}"),
            ));
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::copy(&source, &target).map_err(|err| {
            CommandError::new("AI_LOC_DEPLOY_COPY", format!("复制失败 {}：{err}", target.display()))
        })?;
        let (size, modified_time) = file_stamp(&target);
        deployed.push(DeployedFile {
            source: source.to_string_lossy().to_string(),
            target: target.to_string_lossy().to_string(),
            relative_path: relative.clone(),
            link_type: LinkType::Copy,
            size,
            modified_time,
        });
        deployed_labels.push(relative);
    }

    // 6. 登记。状态写入是提交点：失败就把刚放进去的文件撤掉。
    let state_value = AiLocState {
        staging_dir: root.to_string_lossy().to_string(),
        deployed: deployed.clone(),
        translated: translated_pairs.len(),
        skipped,
        model: model.clone(),
        created_at: now_iso(),
    };
    {
        let mut data = store.data.lock().expect("state mutex poisoned");
        if let Some(slot) = data.mods.iter_mut().find(|item| item.id == mod_id) {
            slot.ai_loc = Some(state_value.clone());
            slot.updated_at = Some(now_iso());
        }
        if let Err(err) = store.save(&data) {
            for item in &deployed {
                let _ = fs::remove_file(&item.target);
            }
            return Err(err);
        }
    }

    let mut warnings = Vec::new();
    if !blocked.is_empty() {
        warnings.push(format!(
            "有 {} 条内容未处理（含暂不支持的文本载体，详见计划页），未写入覆盖层。",
            blocked.len()
        ));
    }
    warnings.push("覆盖层由 AI 生成，非原作者发布；如介意请在模组卡片上撤销。".to_string());
    // #6 M1 范围 ①：启动器内配置项标签一并本地化（独立覆盖层、不写游戏目录）。
    // Best-effort：失败只记 warning，不影响汉化主流程；不自动重跑 AI。
    match crate::ailabel::generate(store, mod_id) {
        Ok(count) if count > 0 => warnings.push(format!(
            "已本地化 {count} 条配置项标签，可在模组详情页查看。"
        )),
        Ok(_) => {}
        Err(err) => warnings.push(format!(
            "配置项标签本地化未完成（不影响汉化）：{}",
            err.message
        )),
    }
    Ok(AiLocReport {
        mod_id: mod_id.to_string(),
        planned: entries.len(),
        translated: translated_pairs.len(),
        skipped,
        written,
        deployed: deployed_labels,
        rolled_back: false,
        model,
        warnings,
        errors,
    })
}

/// 撤销：只删自己登记过的目标文件，然后清掉暂存与登记。
pub fn revert(store: &Store, mod_id: &str) -> AppResult<AiLocReport> {
    let entry = find_entry(store, mod_id)?;
    let Some(state_value) = entry.ai_loc.clone() else {
        return Err(CommandError::new(
            "AI_LOC_NOT_FOUND",
            "这个模组没有 AI 汉化覆盖层。",
        ));
    };
    let mut warnings = Vec::new();
    let mut removed: Vec<String> = Vec::new();
    for file in &state_value.deployed {
        let target = PathBuf::from(&file.target);
        if !target.exists() {
            warnings.push(format!("目标文件已不存在：{}", file.relative_path));
            continue;
        }
        let (size, modified) = file_stamp(&target);
        // 大小或时间任一不符 → 说明部署后有人动过这个文件，宁可留着让用户自己判断。
        let size_changed = matches!((file.size, size), (Some(before), Some(after)) if before != after);
        let time_changed =
            matches!((file.modified_time, modified), (Some(before), Some(after)) if before != after);
        if size_changed || time_changed {
            warnings.push(format!(
                "文件在部署后被外部改动，已跳过删除：{}",
                file.relative_path
            ));
            continue;
        }
        if let Err(err) = fs::remove_file(&target) {
            warnings.push(format!("删除失败 {}：{err}", target.display()));
            continue;
        }
        removed.push(file.relative_path.clone());
    }
    let root = PathBuf::from(&state_value.staging_dir);
    if is_within(&store.staging_dir(), &root) {
        let _ = fs::remove_dir_all(&root);
    }
    {
        let mut data = store.data.lock().expect("state mutex poisoned");
        if let Some(slot) = data.mods.iter_mut().find(|item| item.id == mod_id) {
            slot.ai_loc = None;
            slot.updated_at = Some(now_iso());
        }
        store.save(&data)?;
    }
    // 标签覆盖层一并撤销（独立文件，删不掉也要在 warning 里可见）。
    if let Err(err) = crate::ailabel::remove(store, mod_id) {
        warnings.push(format!("配置项标签覆盖层删除失败：{}", err.message));
    }
    Ok(AiLocReport {
        mod_id: mod_id.to_string(),
        planned: 0,
        translated: 0,
        skipped: 0,
        written: Vec::new(),
        deployed: removed,
        rolled_back: true,
        model: state_value.model,
        warnings,
        errors: Vec::new(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(dir: &Path, rel: &str, content: &str) {
        let path = dir.join(rel);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, content).unwrap();
    }

    /// P0：每种文本载体都要有明确回显，且原有 JSON 提取不能被破坏。
    #[test]
    fn scan_classifies_carriers_and_still_extracts_onscreens() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join(".test-tmp")
            .join(format!("ailoc-scan-{}", uuid::Uuid::new_v4().simple()));
        let staging = root.join("staging");
        fs::create_dir_all(&staging).unwrap();
        write(
            &staging,
            "localization/en-us.json",
            r#"{"entries":[{"secondaryKey":"MyMod-Item","femaleVariant":"Samurai Mask"}]}"#,
        );
        write(&staging, "unknown.json", r#"{"foo":1}"#);
        write(&staging, "mod.archive", "binary");
        write(&staging, "mod.archive.xl", "localization:");
        write(&staging, "mods/demo/init.lua", "print('hello')");
        write(&staging, "r6/scripts/demo.reds", "// code");
        write(&staging, "settings.ini", "[General]\na=1");
        write(&staging, "mesh/x.mesh", "binary");

        let (entries, blocked) = scan_entries(&staging);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].secondary_key, "MyMod-Item");

        let reasons: std::collections::BTreeSet<String> =
            blocked.iter().map(|item| item.reason.clone()).collect();
        assert!(reasons.contains("RESOURCE_TEXT"), "{reasons:?}");
        assert!(reasons.contains("SCRIPT_TEXT"), "{reasons:?}");
        assert!(reasons.contains("CONFIG_TEXT"), "{reasons:?}");
        assert!(reasons.contains("UNSUPPORTED_FORMAT"), "{reasons:?}");
        assert!(blocked.iter().all(|item| !item.sample.is_empty()));
        assert!(blocked.iter().all(|item| !item.source_file.contains("x.mesh")));
        // 同一扩展名去重：两个 .archive / .xl 不该刷出多行 RESOURCE_TEXT。
        assert_eq!(
            blocked
                .iter()
                .filter(|item| item.reason == "RESOURCE_TEXT")
                .count(),
            1
        );
        let _ = fs::remove_dir_all(&root);
    }
}
